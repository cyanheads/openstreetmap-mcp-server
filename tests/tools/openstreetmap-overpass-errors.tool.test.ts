/**
 * @fileoverview The three Overpass tools' error envelopes end to end — the real service,
 * its retry and status mapping, and the tool's catch arm — over a stubbed `fetch`: a keyed
 * endpoint quoting its own request path (#94), and HTTP 408 and 425 (#95).
 * @module tests/tools/openstreetmap-overpass-errors.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { openstreetmapQueryBbox } from '@/mcp-server/tools/definitions/openstreetmap-query-bbox.tool.js';
import { openstreetmapQueryNearby } from '@/mcp-server/tools/definitions/openstreetmap-query-nearby.tool.js';
import { openstreetmapQueryRaw } from '@/mcp-server/tools/definitions/openstreetmap-query-raw.tool.js';
import { initOverpassService } from '@/services/overpass/overpass-service.js';
import { type WireError, wireError } from '../helpers/handler-error.js';

/** A provider that takes its key in the path and the query, pinned. */
const KEYED = 'https://overpass.keyed.example/sk-FAKEKEY123/api/interpreter?key=QSECRET';
const KEYED_ORIGIN = 'https://overpass.keyed.example';
const QUOTED_PATH = '/sk-FAKEKEY123/api/interpreter?key=QSECRET';
const SECRET = /sk-F|QSECRET/;

/** A failover list replaces the keyed pin while set. */
const configState = vi.hoisted(() => ({ endpoints: undefined as string[] | undefined }));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    overpassBaseUrl: configState.endpoints ? undefined : KEYED,
    overpassEndpoints: (configState.endpoints ?? []).map((url) => ({ url })),
    overpassMaxConcurrency: 2,
    nominatimUserAgent: 'openstreetmap-mcp-server/test',
  }),
}));

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

const tools = [
  { definition: openstreetmapQueryRaw, input: { query: '[out:json];node(1);out;' } },
  { definition: openstreetmapQueryNearby, input: { lat: 47.6, lon: -122.3, amenity: 'cafe' } },
  {
    definition: openstreetmapQueryBbox,
    input: { south: 47.5, west: -122.5, north: 47.7, east: -122.2, amenity: 'cafe' },
  },
] as const;

/** Every surface a caller reads: the message, the error data, and the `content[]` text. */
function everySurface(err: WireError): string {
  return [err.message, JSON.stringify(err.data), err.text].join('\n');
}

for (const { definition, input } of tools) {
  describe(`${definition.name} error envelopes`, () => {
    beforeEach(() => {
      vi.useFakeTimers();
      mockFetch.mockReset();
      mockFetch.mockImplementation(async (url) => {
        throw new Error(`unmocked fetch: ${String(url)}`);
      });
      initOverpassService({} as AppConfig, {} as StorageService);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Answers every submission with `response()`, runs the tool, and settles every retry. */
    async function failWith(response: () => Response): Promise<WireError> {
      mockFetch.mockImplementation(async () => response());
      const pending = wireError(definition, input as never, { tenantId: 'test' });
      await vi.advanceTimersByTimeAsync(200_000);
      return pending;
    }

    const declared = (reason: string) =>
      definition.errors?.find((entry) => entry.reason === reason)?.recovery;

    describe('a keyed endpoint quoting its own request path (#94)', () => {
      it('scrubs the cause a 503 body states, which the message carries', async () => {
        const err = await failWith(
          () =>
            new Response(
              `<p><strong>Error</strong>: runtime error: overloaded at ${QUOTED_PATH}</p>`,
              {
                status: 503,
                statusText: 'Busy /sk-FAKEKEY123/api/interpreter',
              },
            ),
        );

        expect(err.data.reason).toBe('overpass_unavailable');
        expect(err.message).toBe(
          'Overpass returned HTTP 503 Busy …. (failed after 4 attempts) Overpass reported: runtime error: overloaded at …?…',
        );
        expect(err.data).toMatchObject({ statusText: 'Busy …', url: KEYED_ORIGIN });
        expect(everySurface(err)).not.toMatch(SECRET);
      });

      it('scrubs a non-JSON 200 body quoting the path', async () => {
        const err = await failWith(
          () => new Response(`invalid key for ${QUOTED_PATH}`, { status: 200 }),
        );

        expect(err.data.reason).toBe('upstream_error');
        expect(err.message).toBe('Overpass returned a body that is not JSON: invalid key for …?…');
        expect(err.text).toContain('invalid key for …?…');
        expect(everySurface(err)).not.toMatch(SECRET);
      });

      it('scrubs a remark quoting the path', async () => {
        const err = await failWith(() =>
          Response.json({ version: 0.6, elements: [], remark: `runtime error: ${QUOTED_PATH}` }),
        );

        expect(err.data.reason).toBe('upstream_error');
        expect(err.message).toBe('Overpass reported an error: runtime error: …?…');
        expect(everySurface(err)).not.toMatch(SECRET);
      });

      it('scrubs a 400 document, whose cause or body the tool forwards', async () => {
        const err = await failWith(
          () =>
            new Response(
              `<p><strong>Error</strong>: line 1: parse error: unknown key in ${QUOTED_PATH}</p>`,
              { status: 400 },
            ),
        );

        expect(everySurface(err)).toContain('parse error: unknown key in …?…');
        expect(everySurface(err)).not.toMatch(SECRET);
      });

      /**
       * Characterization: the catch arm restates an all-rejected call through ctx.fail,
       * which already kept the refusals behind it off the wire; the service tests pin
       * the cause chain the log record is built from.
       */
      it('names a refusing endpoint by origin, quoting nothing of its path', async () => {
        const err = await failWith(
          () =>
            new Response(`Cannot POST ${QUOTED_PATH}`, {
              status: 404,
              statusText: 'Not Found /sk-FAKEKEY123/api/interpreter',
            }),
        );

        expect(err.data.reason).toBe('endpoints_rejected');
        expect(err.message).toContain(`${KEYED_ORIGIN}: HTTP 404`);
        expect(everySurface(err)).not.toMatch(SECRET);
      });
    });

    describe('HTTP 408 and 425 (#95)', () => {
      it.each([
        [408, 'overpass_gateway_timeout', JsonRpcErrorCode.Timeout],
        [425, 'overpass_unavailable', JsonRpcErrorCode.ServiceUnavailable],
      ] as const)(
        'ends HTTP %i on %s with its hint on both surfaces and no body, after four submissions',
        async (status, reason, code) => {
          const err = await failWith(
            () => new Response('<html>request timed out</html>', { status }),
          );

          expect(mockFetch).toHaveBeenCalledTimes(4);
          expect(err.code).toBe(code);
          expect(err.data).toMatchObject({ reason, retryable: true, status, retryAttempts: 4 });
          expect(declared(reason)).toBeDefined();
          expect(err.data.recovery?.hint).toBe(declared(reason));
          expect(err.text).toContain(`Recovery: ${declared(reason)}`);
          expect(err.text).toContain(`(reason ${reason} · retryable`);
          expect(err.data).not.toHaveProperty('body');
          expect(err.data).not.toHaveProperty('responseBody');
        },
      );
    });

    /**
     * Four entries are walked in the first attempt, so the cap lands on the fourth one's
     * refusal while the three that shed load stay eligible.
     */
    describe('the submission cap ending on an endpoint fault', () => {
      const LIST = Array.from(
        { length: 4 },
        (_, i) => `https://overpass-${i + 1}.example/api/interpreter`,
      );

      beforeEach(() => {
        configState.endpoints = LIST;
        initOverpassService({} as AppConfig, {} as StorageService);
      });

      afterEach(() => {
        configState.endpoints = undefined;
      });

      it('ends [503, 503, 503, 404] on overpass_unavailable, hint on both surfaces, no body', async () => {
        mockFetch.mockImplementation(async (url) =>
          String(url) === LIST[3]
            ? new Response('Cannot POST /api/interpreter', { status: 404 })
            : new Response('busy', { status: 503 }),
        );
        const pending = wireError(definition, input as never, { tenantId: 'test' });
        await vi.advanceTimersByTimeAsync(200_000);
        const err = await pending;

        expect(mockFetch.mock.calls.map(([url]) => String(url))).toEqual(LIST);
        expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(err.data).toMatchObject({
          reason: 'overpass_unavailable',
          retryable: true,
          status: 503,
          retryAttempts: 4,
        });
        expect(err.data.recovery?.hint).toBe(declared('overpass_unavailable'));
        expect(err.text).toContain(`Recovery: ${declared('overpass_unavailable')}`);
        expect(err.data).not.toHaveProperty('body');
        expect(err.data).not.toHaveProperty('responseBody');
      });
    });

    /**
     * Characterization: the service marks a spent budget `retryable: false` — no attempt is
     * left in that call — and the tool restates it through the contract, so a caller sees
     * the declared `retryable: true`.
     */
    it('reports a spent call budget as endpoints_exhausted, retryable, on both surfaces', async () => {
      // Two slow load-shedders: the budget runs out on a return to the first, with the
      // second never faulted, so no fault set completes and the budget ends the call.
      configState.endpoints = [
        'https://overpass-1.example/api/interpreter',
        'https://overpass-2.example/api/interpreter',
      ];
      initOverpassService({} as AppConfig, {} as StorageService);
      onTestFinished(() => {
        configState.endpoints = undefined;
      });
      mockFetch.mockImplementation(
        (_url, init) =>
          new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => resolve(new Response('busy', { status: 503 })), 50_000);
            init?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(init.signal?.reason);
              },
              { once: true },
            );
          }),
      );
      const pending = wireError(definition, input as never, { tenantId: 'test' });
      await vi.advanceTimersByTimeAsync(200_000);
      const err = await pending;

      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.message).toMatch(
        /^Overpass did not answer within the \d+ms budget for this call\.$/,
      );
      expect(err.data).toMatchObject({ reason: 'endpoints_exhausted', retryable: true });
      expect(err.text).toContain('(reason endpoints_exhausted · retryable');
      expect(err.text).toContain(`Recovery: ${declared('endpoints_exhausted')}`);
    });

    describe('HTTP 501', () => {
      it('ends a pinned endpoint answering 501 on endpoints_rejected after one submission', async () => {
        const err = await failWith(() => new Response('Not Implemented', { status: 501 }));

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(err.data).toMatchObject({ reason: 'endpoints_rejected', retryable: false });
        expect(err.message).toContain(`${KEYED_ORIGIN}: HTTP 501`);
        expect(err.data.recovery?.hint).toBe(declared('endpoints_rejected'));
        expect(err.text).toContain(`Recovery: ${declared('endpoints_rejected')}`);
        expect(err.text).toContain('(reason endpoints_rejected · not retryable');
      });
    });
  });
}
