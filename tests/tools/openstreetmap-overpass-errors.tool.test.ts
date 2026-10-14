/**
 * @fileoverview The three Overpass tools' error envelopes end to end — the real service,
 * its retry and status mapping, and the tool's catch arm — over a stubbed `fetch`: a keyed
 * endpoint quoting its own request path (#94), HTTP 408 and 425 (#95), a 504 or 408 an
 * instance refused (#104), a throttled endpoint (#102), and a body past the read ceiling
 * (#107).
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

      it('names a 400 cause in the message and keeps the captured document out of the data', async () => {
        const err = await failWith(
          () =>
            new Response('<p><strong>Error</strong>: line 1: parse error: unknown key</p>', {
              status: 400,
            }),
        );

        expect(err.message).toContain('parse error: unknown key');
        expect(err.data).not.toHaveProperty('body');
        expect(err.data).not.toHaveProperty('responseBody');
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
     * #104: OSM3S sends a 504 only when its dispatcher could not admit the query or is
     * turned off. The query never ran, so the shrink-the-query hint was wrong and four
     * submissions only added load; a 504 with no OSM3S `Error:` line is a proxy's, and keeps
     * its gateway-timeout contract. One wiring case per reason: the status-and-line table is
     * `overpassStatusReason`'s (overpass-error.test.ts), the one-submission table the
     * service's.
     */
    describe('a 504 or 408 the instance refused (#104)', () => {
      const BUSY_LINE =
        'runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::timeout. The server is probably too busy to handle your request.';

      it('ends HTTP 504 with a too-busy line on overpass_unavailable after one submission', async () => {
        const err = await failWith(
          () =>
            new Response(
              `<?xml version="1.0" encoding="UTF-8"?>\n<html><body>\n<p>The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.</p>\n<p><strong style="color:#FF0000">Error</strong>: ${BUSY_LINE} </p>\n</body></html>\n`,
              { status: 504, statusText: 'Gateway Timeout' },
            ),
        );

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(err.message).toBe(
          `Overpass returned HTTP 504 Gateway Timeout. Overpass reported: ${BUSY_LINE}`,
        );
        expect(err.data).toMatchObject({
          reason: 'overpass_unavailable',
          retryable: true,
          status: 504,
        });
        expect(err.data).not.toHaveProperty('retryAttempts');
        expect(err.data.recovery?.hint).toBe(declared('overpass_unavailable'));
        expect(err.text).toContain(`Recovery: ${declared('overpass_unavailable')}`);
        expect(err.text).toContain('(reason overpass_unavailable · retryable');
        expect(err.data).not.toHaveProperty('body');
      });

      it('keeps a 504 carrying a proxy gateway page on overpass_gateway_timeout, retried', async () => {
        const err = await failWith(
          () =>
            new Response(
              '<html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center><hr><center>nginx</center></body></html>',
              { status: 504, statusText: 'Gateway Timeout' },
            ),
        );

        expect(mockFetch).toHaveBeenCalledTimes(4);
        expect(err.code).toBe(JsonRpcErrorCode.Timeout);
        expect(err.data).toMatchObject({
          reason: 'overpass_gateway_timeout',
          status: 504,
          retryAttempts: 4,
        });
        expect(err.data.recovery?.hint).toBe(declared('overpass_gateway_timeout'));
      });
    });

    /**
     * Characterization for #106: declaring 256 MiB makes the out-of-memory remark the way an
     * oversized convenience call ends, so it must keep ending on result_too_large after one
     * submission. The `when` text, which named only the memory remark, also names the read
     * ceiling since #107.
     */
    it('ends an out-of-memory remark on result_too_large after one submission', async () => {
      const err = await failWith(() =>
        Response.json({
          version: 0.6,
          elements: [],
          remark:
            'runtime error: Query ran out of memory in "query" at line 5. It would need at least 274 MB of RAM to continue.',
        }),
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data.reason).toBe('result_too_large');
      expect(err.data.recovery?.hint).toBe(declared('result_too_large'));
      expect(definition.errors?.find((e) => e.reason === 'result_too_large')?.when).toBe(
        "Overpass ran out of memory on this query, or its response passed the server's 64 MiB read ceiling.",
      );
    });

    /**
     * #107: a body past the 64 MiB read ceiling ends on the same reason and declared recovery
     * as the memory remark, and the message names the ceiling on both surfaces. Raw and bbox
     * end after one submission. openstreetmap_query_nearby, searching ways here, first asks
     * once more without its geometry prints; that center-only answer passing the ceiling too
     * is what ends it, after two.
     */
    it('ends a Content-Length past 64 MiB on result_too_large', async () => {
      const err = await failWith(
        () =>
          new Response('{"version":0.6,"elements":[]}', {
            headers: { 'content-length': String(64 * 1024 * 1024 + 1) },
          }),
      );
      const message =
        'The Overpass response is 67108865 bytes, over the 67108864-byte (64 MiB) ceiling this server reads for one query, so it was not read.';

      expect(mockFetch).toHaveBeenCalledTimes(definition === openstreetmapQueryNearby ? 2 : 1);
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data.reason).toBe('result_too_large');
      expect(err.message).toBe(message);
      expect(err.data.recovery?.hint).toBe(declared('result_too_large'));
      expect(err.text).toContain(message);
      expect(err.text).toContain(`Recovery: ${declared('result_too_large')}`);
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

    /**
     * #102: the public instance asks a throttled client to wait at least 30 seconds, and
     * allows one query in flight per user, so the hint no longer points at a slot budget or
     * at a mirror for concurrency. A 429 carrying Retry-After past `withRetry`'s 30-second
     * ceiling fails fast too, and its window now rides on the error the hint points at.
     */
    describe('throttled (#102)', () => {
      const THROTTLE_LINE =
        'runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::rate_limited. Please check /api/status for the quota of your IP address.';
      const RATE_LIMITED_RECOVERY =
        'Every configured Overpass endpoint refused this query as throttled. Wait at least 30 seconds before retrying, longer when the error carries a retryAfter asking for more, and make fewer Overpass calls at once. For sustained load, pin a private Overpass instance via OSM_OVERPASS_BASE_URL.';

      it('declares the wait-30-seconds hint', () => {
        expect(declared('rate_limited')).toBe(RATE_LIMITED_RECOVERY);
      });

      it.each([
        [
          'a bare HTTP 429',
          () => new Response('Too Many Requests', { status: 429 }),
          { message: 'Overpass returned HTTP 429.', status: 429 },
        ],
        [
          'a throttle document',
          () =>
            new Response(
              `<html><body>\n<p><strong style="color:#FF0000">Error</strong>: ${THROTTLE_LINE} </p>\n</body></html>\n`,
              { status: 200 },
            ),
          { message: `Overpass refused the query as throttled: ${THROTTLE_LINE}` },
        ],
      ])(
        'ends %s on rate_limited after one submission, hint on both surfaces, no body',
        async (_case, response, { message, ...data }) => {
          const err = await failWith(response);

          expect(mockFetch).toHaveBeenCalledTimes(1);
          expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
          expect(err.message).toBe(message);
          expect(err.data).toMatchObject({ reason: 'rate_limited', retryable: true, ...data });
          expect(err.data).not.toHaveProperty('retryAfter');
          expect(err.data).not.toHaveProperty('body');
          expect(err.data).not.toHaveProperty('responseBody');
          expect(err.data.recovery?.hint).toBe(declared('rate_limited'));
          expect(err.text).toContain(`Recovery: ${declared('rate_limited')}`);
          expect(err.text).toContain('(reason rate_limited · retryable');
        },
      );

      it.each([
        ['past', '120', 1, {}],
        ['inside', '5', 4, { retryAttempts: 4 }],
      ] as const)(
        'carries a Retry-After %s the 30-second retry ceiling (%s s) after %i submission(s)',
        async (_where, retryAfter, submissions, extra) => {
          const err = await failWith(
            () =>
              new Response('slow down', { status: 429, headers: { 'Retry-After': retryAfter } }),
          );

          expect(mockFetch).toHaveBeenCalledTimes(submissions);
          expect(err.data).toMatchObject({
            reason: 'rate_limited',
            status: 429,
            retryAfter,
            ...extra,
          });
          expect(err.data.recovery?.hint).toBe(declared('rate_limited'));
        },
      );
    });
  });
}
