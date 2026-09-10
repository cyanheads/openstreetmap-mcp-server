/**
 * @fileoverview Tests for the Nominatim service HTTP client — request construction,
 * throttle spacing, and retry classification.
 * @module tests/services/nominatim/nominatim-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isTransientNominatimError,
  MIN_REQUEST_INTERVAL_MS,
  NominatimService,
} from '@/services/nominatim/nominatim-service.js';

const DEFAULT_BASE_URL = 'https://nominatim.openstreetmap.org';

// Mutable server config so a test can point the service at a subpath-hosted mirror.
const configState = vi.hoisted(() => ({ nominatimBaseUrl: 'https://nominatim.openstreetmap.org' }));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    nominatimBaseUrl: configState.nominatimBaseUrl,
    overpassBaseUrl: 'https://overpass-api.de/api/interpreter',
    nominatimUserAgent: 'openstreetmap-mcp-server/test',
  }),
}));

// Mock only fetchWithTimeout so we can inspect the outgoing request URL; the real
// withRetry still wraps the call. Every endpoint returns a JSON array — the tests
// assert on the request, not the response body.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: vi.fn(async () => new Response('[]', { status: 200 })),
  };
});

const mockFetch = vi.mocked(fetchWithTimeout);

/** URL of the single request the mocked fetch captured for this test. */
function firstRequestUrl(): URL {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  return new URL(mockFetch.mock.calls[0]![0] as string);
}

describe('NominatimService', () => {
  let service: NominatimService;

  beforeEach(() => {
    mockFetch.mockReset().mockImplementation(async () => new Response('[]', { status: 200 }));
    configState.nominatimBaseUrl = DEFAULT_BASE_URL;
    // The service ignores its storage dependency (caching goes through ctx.state),
    // so a typed stub is sufficient — the tests only inspect the outgoing request.
    service = new NominatimService({} as unknown as AppConfig, {} as unknown as StorageService);
  });

  // Regression for #19 and #31: Nominatim drops unknown query params, so a
  // renamed or mis-cased parameter silently disables the feature it controls.
  describe('query parameter name casing (#19, #31)', () => {
    it('sends accept-language (not accept_language) for search', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'München', language: 'en', limit: 5 }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.get('accept-language')).toBe('en');
      expect(url.searchParams.has('accept_language')).toBe(false);
    });

    it('sends accept-language (not accept_language) for reverse', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.reverse({ lat: 48.1371079, lon: 11.5753822, language: 'fr' }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.get('accept-language')).toBe('fr');
      expect(url.searchParams.has('accept_language')).toBe(false);
    });

    it('sends accept-language (not accept_language) for lookup', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.lookup({ osm_ids: ['N240109189'], language: 'de' }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.get('accept-language')).toBe('de');
      expect(url.searchParams.has('accept_language')).toBe(false);
    });

    it('omits accept-language entirely when no language is requested', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'Seattle', limit: 5 }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.has('accept-language')).toBe(false);
      expect(url.searchParams.has('accept_language')).toBe(false);
    });

    it('sends featureType (not featuretype) for search', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'Washington', featureType: 'city', limit: 5 }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.get('featureType')).toBe('city');
      expect(url.searchParams.has('featuretype')).toBe(false);
    });

    it('omits featureType entirely when no feature type is requested', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'Washington', limit: 5 }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.has('featureType')).toBe(false);
      expect(url.searchParams.has('featuretype')).toBe(false);
    });

    it('sends layer lowercase — Nominatim reads that one lowercase', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'Washington', layer: 'address', limit: 5 }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.get('layer')).toBe('address');
    });
  });

  describe('exclude_place_ids query parameter (#24)', () => {
    it('forwards excludePlaceIds as a comma-joined exclude_place_ids param', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'coffee', excludePlaceIds: ['111', '222', '333'], limit: 5 }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.get('exclude_place_ids')).toBe('111,222,333');
    });

    it('omits exclude_place_ids when the list is empty', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'coffee', excludePlaceIds: [], limit: 5 }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.has('exclude_place_ids')).toBe(false);
    });
  });

  // #62: viewbox biases ranking; bounded=1 turns it into a hard filter. The two are
  // separate Nominatim parameters, so a bias-only call must send no `bounded` at all.
  describe('viewbox and bounded query parameters (#62)', () => {
    it('forwards the viewbox string verbatim', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'Cambridge', viewbox: '-71.2,42.45,-70.9,42.3', limit: 5 }, ctx);
      expect(firstRequestUrl().searchParams.get('viewbox')).toBe('-71.2,42.45,-70.9,42.3');
    });

    it('sends bounded=1 only when bounded is true', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search(
        { q: 'Cambridge', viewbox: '-71.2,42.45,-70.9,42.3', bounded: true, limit: 5 },
        ctx,
      );
      expect(firstRequestUrl().searchParams.get('bounded')).toBe('1');
    });

    it('omits bounded entirely when it is false or absent', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search(
        { q: 'Cambridge', viewbox: '-71.2,42.45,-70.9,42.3', bounded: false, limit: 5 },
        ctx,
      );
      expect(firstRequestUrl().searchParams.has('bounded')).toBe(false);

      mockFetch.mockClear();
      await service.search({ q: 'Oxford', viewbox: '-71.2,42.45,-70.9,42.3', limit: 5 }, ctx);
      expect(firstRequestUrl().searchParams.has('bounded')).toBe(false);
    });

    it('omits viewbox entirely when none was supplied', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'Cambridge', limit: 5 }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.has('viewbox')).toBe(false);
      expect(url.searchParams.has('bounded')).toBe(false);
    });
  });

  // Regression for #34: `new URL('/search', base)` treats the leading slash as an
  // absolute path and discards any prefix in OSM_NOMINATIM_BASE_URL.
  describe('base URL path prefix (#34)', () => {
    it('keeps the endpoint at the root for a bare-host base', async () => {
      configState.nominatimBaseUrl = DEFAULT_BASE_URL;
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'Seattle', limit: 2 }, ctx);
      expect(firstRequestUrl().pathname).toBe('/search');
    });

    it('preserves a subpath base without a trailing slash', async () => {
      configState.nominatimBaseUrl = 'https://maps.example.com/nominatim';
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'Seattle', limit: 2 }, ctx);
      const url = firstRequestUrl();
      expect(url.host).toBe('maps.example.com');
      expect(url.pathname).toBe('/nominatim/search');
    });

    it('preserves a subpath base with a trailing slash', async () => {
      configState.nominatimBaseUrl = 'https://maps.example.com/nominatim/';
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'Seattle', limit: 2 }, ctx);
      expect(firstRequestUrl().pathname).toBe('/nominatim/search');
    });

    it('preserves a subpath base for reverse and lookup', async () => {
      configState.nominatimBaseUrl = 'https://maps.example.com/nominatim';
      const ctx = createMockContext({ tenantId: 'test' });
      await service.reverse({ lat: 47.6, lon: -122.3 }, ctx);
      expect(firstRequestUrl().pathname).toBe('/nominatim/reverse');

      mockFetch.mockClear();
      await service.lookup({ osm_ids: ['N240109189'] }, ctx);
      expect(firstRequestUrl().pathname).toBe('/nominatim/lookup');
    });
  });

  // Regression for #26: every waiter used to compute its delay from the same
  // pre-update lastRequestTime, so a queue of concurrent callers was released
  // together. Fake timers keep the assertion exact and the run instant.
  describe('throttle spacing across concurrent callers (#26)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('spaces three concurrent uncached searches by the minimum interval', async () => {
      const firedAt: number[] = [];
      mockFetch.mockImplementation(async () => {
        firedAt.push(Date.now());
        return new Response('[]', { status: 200 });
      });

      const ctx = createMockContext({ tenantId: 'test' });
      const inFlight = Promise.all([
        service.search({ q: 'Seattle', limit: 1 }, ctx),
        service.search({ q: 'Portland', limit: 1 }, ctx),
        service.search({ q: 'Tacoma', limit: 1 }, ctx),
      ]);

      await vi.advanceTimersByTimeAsync(10_000);
      await inFlight;

      expect(firedAt).toHaveLength(3);
      expect(firedAt[1]! - firedAt[0]!).toBeGreaterThanOrEqual(MIN_REQUEST_INTERVAL_MS);
      expect(firedAt[2]! - firedAt[1]!).toBeGreaterThanOrEqual(MIN_REQUEST_INTERVAL_MS);
    });

    it('spaces concurrent calls across the three endpoints', async () => {
      const firedAt: number[] = [];
      mockFetch.mockImplementation(async () => {
        firedAt.push(Date.now());
        return new Response('[]', { status: 200 });
      });

      const ctx = createMockContext({ tenantId: 'test' });
      const inFlight = Promise.all([
        service.search({ q: 'Seattle', limit: 1 }, ctx),
        service.reverse({ lat: 47.6, lon: -122.3 }, ctx),
        service.lookup({ osm_ids: ['N240109189'] }, ctx),
      ]);

      await vi.advanceTimersByTimeAsync(10_000);
      await inFlight;

      expect(firedAt).toHaveLength(3);
      for (let i = 1; i < firedAt.length; i++) {
        expect(firedAt[i]! - firedAt[i - 1]!).toBeGreaterThanOrEqual(MIN_REQUEST_INTERVAL_MS);
      }
    });

    it('does not delay a single request against an idle service', async () => {
      const start = Date.now();
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'Seattle', limit: 1 }, ctx);
      expect(Date.now() - start).toBe(0);
    });
  });

  // Regression for #32: an HTML throttle page served with HTTP 200 must carry a
  // reason the tool layer can remap, and must not be re-submitted.
  describe('HTML error page detection (#32)', () => {
    it('throws rate_limited when Nominatim serves an HTML page with HTTP 200', async () => {
      mockFetch.mockImplementation(
        async () =>
          new Response('<html><body>Too many requests</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      );
      const ctx = createMockContext({ tenantId: 'test' });
      const err = await service.search({ q: 'Seattle', limit: 1 }, ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'rate_limited' });
    });

    it('does not retry the HTML throttle page', async () => {
      mockFetch.mockImplementation(
        async () =>
          new Response('<!DOCTYPE html><html><body>Blocked</body></html>', { status: 200 }),
      );
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'Seattle', limit: 1 }, ctx).catch(() => undefined);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // Regression for #53: the leading-tag guard only matched a body opening on its
  // doctype or <html> tag. Every other non-JSON shape reached JSON.parse, threw a
  // bare SyntaxError that withRetry read as transient, and cost four submissions
  // before surfacing with no reason and no recovery hint.
  describe('non-JSON 2xx body classification (#53)', () => {
    const bodies = [
      {
        label: 'markup behind an XML declaration',
        body: '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html><body><p>Access blocked</p></body></html>',
        reason: 'rate_limited',
      },
      {
        label: 'plain-text throttle message with no markup',
        body: 'Bandwidth limit exceeded. Please reduce your request rate.',
        reason: 'rate_limited',
      },
      {
        label: 'markup carrying no throttle signature',
        body: '<?xml version="1.0"?><html><head><title>502 Bad Gateway</title></head></html>',
        reason: 'upstream_error',
      },
      {
        label: 'unrecognized non-JSON body',
        body: 'openstreetmap-mcp-server placeholder page',
        reason: 'upstream_error',
      },
    ] as const;

    for (const { label, body, reason } of bodies) {
      it(`classifies ${label} as ${reason} on a single submission`, async () => {
        mockFetch.mockImplementation(async () => new Response(body, { status: 200 }));
        const ctx = createMockContext({ tenantId: 'test' });
        const err = await service.search({ q: 'Seattle', limit: 1 }, ctx).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).data).toMatchObject({ reason });
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    }

    it('classifies the plain-text throttle body on the reverse endpoint too', async () => {
      mockFetch.mockImplementation(
        async () => new Response('Too many requests from your IP.', { status: 200 }),
      );
      const ctx = createMockContext({ tenantId: 'test' });
      const err = await service.reverse({ lat: 47.6, lon: -122.3 }, ctx).catch((e: unknown) => e);
      expect((err as McpError).data).toMatchObject({ reason: 'rate_limited' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('classifies the plain-text throttle body on the lookup endpoint too', async () => {
      mockFetch.mockImplementation(
        async () => new Response('Too many requests from your IP.', { status: 200 }),
      );
      const ctx = createMockContext({ tenantId: 'test' });
      const err = await service.lookup({ osm_ids: ['N240109189'] }, ctx).catch((e: unknown) => e);
      expect((err as McpError).data).toMatchObject({ reason: 'rate_limited' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('quotes a bounded excerpt of a body that leads with its own message', async () => {
      mockFetch.mockImplementation(async () => new Response('z'.repeat(500), { status: 200 }));
      const ctx = createMockContext({ tenantId: 'test' });
      const err = await service.search({ q: 'Seattle', limit: 1 }, ctx).catch((e: unknown) => e);
      const message = (err as McpError).message;
      expect(message).toContain('z'.repeat(200));
      expect(message).not.toContain('z'.repeat(201));
    });

    it('names a markup body by shape instead of quoting its boilerplate', async () => {
      mockFetch.mockImplementation(
        async () =>
          new Response('<?xml version="1.0"?><html><head><title>Nope</title></head></html>', {
            status: 200,
          }),
      );
      const ctx = createMockContext({ tenantId: 'test' });
      const err = await service.search({ q: 'Seattle', limit: 1 }, ctx).catch((e: unknown) => e);
      const message = (err as McpError).message;
      expect(message).toContain('a markup document');
      expect(message).not.toContain('<');
    });
  });

  /**
   * Regression for #59: a status-400 error carries no `reason`, so it fell through
   * `isTransientNominatimError`'s default and `withRetry` spent the whole attempt
   * budget re-sending a request Nominatim had already refused.
   */
  describe('HTTP 400 fails fast (#59)', () => {
    const badRequest = () =>
      new McpError(JsonRpcErrorCode.InvalidParams, 'Nominatim returned HTTP 400 Bad Request.', {
        status: 400,
        statusText: 'Bad Request',
        body: '{"error":{"code":400,"message":"Invalid exclude ID: garbage"}}',
        errorSource: 'FetchHttpError',
      });

    it('submits a rejected search exactly once', async () => {
      mockFetch.mockRejectedValue(badRequest());
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'Seattle', limit: 1 }, ctx).catch(() => undefined);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('submits a rejected reverse exactly once', async () => {
      mockFetch.mockRejectedValue(badRequest());
      const ctx = createMockContext({ tenantId: 'test' });
      await service.reverse({ lat: 47.6, lon: -122.3 }, ctx).catch(() => undefined);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('submits a rejected lookup exactly once', async () => {
      mockFetch.mockRejectedValue(badRequest());
      const ctx = createMockContext({ tenantId: 'test' });
      await service.lookup({ osm_ids: ['N240109189'] }, ctx).catch(() => undefined);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('surfaces the status-400 error unchanged, body intact for the tool layer', async () => {
      mockFetch.mockRejectedValue(badRequest());
      const ctx = createMockContext({ tenantId: 'test' });
      const err = await service.search({ q: 'Seattle', limit: 1 }, ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ status: 400 });
      expect((err as McpError).data?.reason).toBeUndefined();
    });
  });
});

// Retry classification for the Nominatim path (#32). Nominatim's 429 is a quota
// block rather than a momentary blip, so re-submitting inside the retry window
// only adds load — unless the response told us how long to wait.
describe('isTransientNominatimError', () => {
  describe('non-transient — fail fast (returns false)', () => {
    it('returns false for HTTP 429 without a Retry-After hint', () => {
      const err = new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', {
        status: 429,
        errorSource: 'FetchHttpError',
      });
      expect(isTransientNominatimError(err)).toBe(false);
    });

    it('returns false for the rate_limited reason (HTML throttle page)', () => {
      const err = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'HTML error page', {
        reason: 'rate_limited',
      });
      expect(isTransientNominatimError(err)).toBe(false);
    });

    // Without this branch the #53 classification would still cost four submissions.
    it('returns false for the upstream_error reason (non-JSON 2xx body)', () => {
      const err = new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Nominatim answered with a markup document instead of JSON.',
        { reason: 'upstream_error' },
      );
      expect(isTransientNominatimError(err)).toBe(false);
    });

    /**
     * Regression for #59: a parameter Nominatim rejects is rejected identically on
     * every re-submission, so the full attempt budget bought four guaranteed 400s.
     * Mirrors `isTransientOverpassError`'s own status-400 branch.
     */
    it('returns false for HTTP 400 — the rejected request cannot succeed unchanged (#59)', () => {
      const err = new McpError(JsonRpcErrorCode.InvalidParams, 'Fetch failed. Status: 400', {
        status: 400,
        errorSource: 'FetchHttpError',
      });
      expect(isTransientNominatimError(err)).toBe(false);
    });
  });

  describe('transient — retry (returns true)', () => {
    it('returns true for HTTP 429 carrying a Retry-After hint, so withRetry honors the wait', () => {
      const err = new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', {
        status: 429,
        retryAfter: '5',
        errorSource: 'FetchHttpError',
      });
      expect(isTransientNominatimError(err)).toBe(true);
    });

    it('returns true for a 503 from the upstream', () => {
      const err = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 503', {
        status: 503,
        errorSource: 'FetchHttpError',
      });
      expect(isTransientNominatimError(err)).toBe(true);
    });

    it('returns true for a plain Error (network failure, DNS failure)', () => {
      expect(isTransientNominatimError(new Error('ECONNREFUSED'))).toBe(true);
    });
  });
});
