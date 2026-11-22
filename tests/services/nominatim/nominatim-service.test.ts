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
  toNominatimLanguage,
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

/**
 * One well-formed record in Nominatim's own wire shape: coordinates as decimal strings
 * padded to seven places. /search and /lookup wrap it in an array, /reverse serves it
 * bare — and the service parses either before returning, so a fixture that answers the
 * wrong shape for the endpoint fails the parse rather than the assertion.
 */
const PLACE_JSON = `{"place_id":84433023,"osm_type":"relation","osm_id":343014,"lat":"42.1669782","lon":"0.8950137","display_name":"Tremp, Lleida","boundingbox":["42.1099808","42.3758816","0.6953014","0.9717633"]}`;

/** The body the endpoint in `url` would return: an object for /reverse, an array otherwise. */
function defaultBody(url: string | URL): string {
  return new URL(url).pathname.endsWith('reverse') ? PLACE_JSON : '[]';
}

// Mock only fetchWithTimeout so we can inspect the outgoing request URL; the real
// withRetry still wraps the call. The tests below assert on the request, not the body.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: vi.fn(
      async (url: string | URL) => new Response(defaultBody(url), { status: 200 }),
    ),
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
    mockFetch
      .mockReset()
      .mockImplementation(
        async (url: string | URL) => new Response(defaultBody(url), { status: 200 }),
      );
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

  /**
   * #134: Nominatim reads an `accept-language` part only when it is letters, `_`, and `-`, and
   * looks the tag up as `name:<tag>` case-sensitively, so `EN` and `es-419` came back in the
   * local language. Each endpoint sends the rewritten value; the rewrite's own table is below.
   */
  describe('accept-language spelling (#134)', () => {
    const sent = async (endpoint: 'search' | 'reverse' | 'lookup', language: string) => {
      const ctx = createMockContext({ tenantId: 'test' });
      if (endpoint === 'search') await service.search({ q: '東京タワー', language, limit: 1 }, ctx);
      if (endpoint === 'reverse')
        await service.reverse({ lat: 35.6586, lon: 139.7454, language }, ctx);
      if (endpoint === 'lookup') await service.lookup({ osm_ids: ['W27637213'], language }, ctx);
      return firstRequestUrl().searchParams.get('accept-language');
    };

    it.each([
      ['EN', 'en'],
      ['EN-US', 'en-US'],
      ['es-419', 'es'],
      ['en-001;q=0.8', 'en;q=0.8'],
      ['de-CH-1996', 'de-CH'],
    ])('sends %j to /search as %j', async (language, expected) => {
      expect(await sent('search', language)).toBe(expected);
    });

    it.each(['zh-Hant', 'ja_rm', 'en-US,en;q=0.9,*;q=0.5', 'ja , en', 'en,,de'])(
      'sends %j to /search byte for byte',
      async (language) => {
        expect(await sent('search', language)).toBe(language);
      },
    );

    it.each(['reverse', 'lookup'] as const)(
      'rewrites on /%s and leaves a readable tag alone',
      async (endpoint) => {
        expect(await sent(endpoint, 'EN')).toBe('en');
        mockFetch.mockClear();
        expect(await sent(endpoint, 'zh-Hant')).toBe('zh-Hant');
      },
    );
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
      mockFetch.mockImplementation(async (url: string | URL) => {
        firedAt.push(Date.now());
        return new Response(defaultBody(url), { status: 200 });
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
      mockFetch.mockImplementation(async (url: string | URL) => {
        firedAt.push(Date.now());
        return new Response(defaultBody(url), { status: 200 });
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

  /**
   * #77: jsonv2 writes every coordinate as a decimal string, and the Overpass tools
   * that consume a coordinate declare `number`. The service is the one place the
   * conversion happens, so this asserts on what `search`/`reverse`/`lookup` return
   * rather than on any tool's output schema.
   */
  describe('coordinate parsing at the response boundary (#77)', () => {
    it('parses lat, lon and boundingbox off a search body', async () => {
      mockFetch.mockImplementation(async () => new Response(`[${PLACE_JSON}]`, { status: 200 }));
      const ctx = createMockContext({ tenantId: 'test' });
      const [place] = await service.search({ q: 'Tremp', limit: 1 }, ctx);

      expect(JSON.stringify(place)).toContain('"lat":42.1669782');
      expect(JSON.stringify(place?.boundingbox)).toBe(
        '[42.1099808,42.3758816,0.6953014,0.9717633]',
      );
    });

    it('parses a reverse body, which arrives bare rather than in an array', async () => {
      mockFetch.mockImplementation(async () => new Response(PLACE_JSON, { status: 200 }));
      const ctx = createMockContext({ tenantId: 'test' });
      const place = await service.reverse({ lat: 42.1, lon: 0.9 }, ctx);

      expect(JSON.stringify(place)).toContain('"lon":0.8950137');
    });

    it('parses a lookup body', async () => {
      mockFetch.mockImplementation(async () => new Response(`[${PLACE_JSON}]`, { status: 200 }));
      const ctx = createMockContext({ tenantId: 'test' });
      const [place] = await service.lookup({ osm_ids: ['R343014'] }, ctx);

      expect(JSON.stringify(place)).toContain('"lat":42.1669782');
    });

    // Nominatim pads to seven decimals, so a whole-degree bound arrives zero-padded.
    it('reads a zero-padded whole-degree bound as the number it spells', async () => {
      mockFetch.mockImplementation(
        async () =>
          new Response(
            `[{"place_id":1,"lat":"-72.8438691","lon":"0.0000000","display_name":"Antarctica","boundingbox":["-85.0511289","-59.9999999","-180.0000000","180.0000000"]}]`,
            { status: 200 },
          ),
      );
      const ctx = createMockContext({ tenantId: 'test' });
      const [place] = await service.search({ q: 'Antarctica', limit: 1 }, ctx);

      expect(place?.lon).toBe(0);
      expect(place?.boundingbox).toEqual([-85.0511289, -59.9999999, -180, 180]);
    });

    // A NaN carried into structuredContent would fail the output schema far from the
    // cause; the classified error names the field and the value instead.
    it.each([
      ['a non-numeric lat', `[{"place_id":1,"lat":"north","lon":"0.8","display_name":"x"}]`],
      ['a blank lon', `[{"place_id":1,"lat":"42.1","lon":"  ","display_name":"x"}]`],
      [
        'a blank boundingbox entry',
        `[{"place_id":1,"lat":"42.1","lon":"0.8","display_name":"x","boundingbox":["42.1","","0.6","0.9"]}]`,
      ],
    ])('classifies %s as upstream_error', async (_label, body) => {
      mockFetch.mockImplementation(async () => new Response(body, { status: 200 }));
      const ctx = createMockContext({ tenantId: 'test' });
      const err = await service.search({ q: 'x', limit: 1 }, ctx).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).data).toMatchObject({ reason: 'upstream_error' });
    });

    it('passes the /reverse error body through unparsed for the tool to classify', async () => {
      mockFetch.mockImplementation(
        async () => new Response('{"error":"Unable to geocode"}', { status: 200 }),
      );
      const ctx = createMockContext({ tenantId: 'test' });
      const body = await service.reverse({ lat: 0, lon: -40 }, ctx);

      expect(body).toEqual({ error: 'Unable to geocode' });
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

/**
 * The rewrite at its own seam: rule 2 lowercases a primary subtag, rule 3 cuts a tag before its
 * first subtag carrying a digit, and nothing else in an accepted value moves.
 */
describe('toNominatimLanguage (#134)', () => {
  it.each([
    // Rule 2: the primary subtag, in any case, is sent lowercase …
    ['EN', 'en'],
    ['Yue', 'yue'],
    ['JA_rm', 'ja_rm'],
    // … and a region or variant keeps the case it was given.
    ['EN-US', 'en-US'],
    ['En-us', 'en-us'],
    ['ZH-Hant-TW', 'zh-Hant-TW'],
    // An ISO 15924 script right after the primary is sent as OSM keys spell it …
    ['sr-latn', 'sr-Latn'],
    ['SR-LATN', 'sr-Latn'],
    ['zh-hant-TW', 'zh-Hant-TW'],
    ['ZH-HANT', 'zh-Hant'],
    ['ja-latn;q=0.5,ja', 'ja-Latn;q=0.5,ja'],
    ['uz-cyrl', 'uz-Cyrl'],
    // … and four letters that are no script keep their case: name:roa-tara is a key in use.
    ['ROA-tara', 'roa-tara'],
    ['roa-TARA', 'roa-TARA'],
    ['en-abcd-US', 'en-abcd-US'],
    // Rule 3: a digit-bearing subtag and everything after it in the tag are cut …
    ['es-419', 'es'],
    ['de-CH-1996', 'de-CH'],
    ['sl-rozaj-biske-1994', 'sl-rozaj-biske'],
    ['en-a1b-US', 'en'],
    ['en-001;q=0.8', 'en;q=0.8'],
    // … wherever in the subtag the digit sits: Nominatim reads no part that holds one.
    ['en-US_4', 'en'],
    ['en-x_y-9', 'en-x_y'],
    ['sr-latn_RM-1', 'sr-Latn_RM'],
    // … together with rule 2, part by part, leaving weights and spacing as given.
    ['ES-419', 'es'],
    ['EN-US,es-419;q=0.9,*;q=0.5', 'en-US,es;q=0.9,*;q=0.5'],
    [' Fr-CA;q = 0.7 , DE ', ' fr-CA;q = 0.7 , de '],
  ])('rewrites %j as %j', (value, expected) => {
    expect(toNominatimLanguage(value)).toBe(expected);
  });

  /** ISO 15924 codes across the alphabet: a code missing from the set would go out lowercase. */
  it.each(
    'Adlm Arab Armn Beng Cyrl Deva Ethi Geor Grek Hang Hani Hans Hant Hebr Hira Jpan Kana Khmr Knda Kore Laoo Latn Mlym Mong Mymr Olck Orya Sinh Syrc Taml Telu Tfng Thaa Thai Tibt Yiii Zyyy'.split(
      ' ',
    ),
  )('title-cases the script %s after a primary subtag', (script) => {
    expect(toNominatimLanguage(`xx-${script.toLowerCase()}`)).toBe(`xx-${script}`);
    expect(toNominatimLanguage(`xx-${script.toUpperCase()}-YY`)).toBe(`xx-${script}-YY`);
  });

  it.each([
    'en',
    'en-us',
    'zh-Hant',
    'zh-Hant-TW',
    'sr-Latn',
    'be-tarask',
    'roa-tara',
    'sgn-ase',
    'en-US-x-priv',
    'en-',
    'en--us',
    'en-_',
    'en-US_X',
    'zh-Hant_',
    'ja_rm',
    'zh_pinyin',
    'yue',
    '*',
    '*;q=0.5',
    'en-US,en;q=0.9,*;q=0.5',
    'ja , en',
    '  en  ,  de  ',
    'en,,de',
    ',en',
    'en,',
    'en;q=0',
    'en;Q=1.000',
    'en; q=0.5',
    '',
    '   ',
  ])('leaves %j byte for byte', (value) => {
    expect(toNominatimLanguage(value)).toBe(value);
  });
});

/**
 * `language` carries no length limit, so the rewrite sees caller-sized text and its cost is held
 * linear. Measured in this thread's CPU time, never wall clock: each size is timed beside a fresh
 * baseline, a batch of calls per measurement, and the least growth across the pairs is held under
 * 4× linear — 256 across the 64× span — with each call at the largest size under 100 ms. The
 * input doubles, checked at each size before the next runs.
 */
describe('toNominatimLanguage cost (#134)', () => {
  const BASE_CHARS = 5_000;
  const MAX_CHARS = 320_000;
  /** Text one measurement spends, so a small input is timed over a batch of calls. */
  const BATCH_CHARS = 160_000;
  const PAIRS = 5;
  const repeated = (unit: string, chars: number) => unit.repeat(Math.round(chars / unit.length));

  function cpuMicrosPerCall(value: string): number {
    const calls = Math.max(1, Math.round(BATCH_CHARS / value.length));
    const start = process.threadCpuUsage();
    for (let call = 0; call < calls; call++) toNominatimLanguage(value);
    const spent = process.threadCpuUsage(start);
    return (spent.user + spent.system) / calls;
  }

  it.each([
    { shape: 'many comma parts', make: (n: number) => repeated('EN-us,', n) },
    {
      shape: 'many weighted parts ending unreadable',
      make: (n: number) => `${repeated('en-US;q=0.5,', n)}!`,
    },
    { shape: 'a long run of -x subtags', make: (n: number) => `EN${repeated('-x', n)}` },
    { shape: 'a long digit subtag', make: (n: number) => `en-${repeated('1', n)}` },
    { shape: 'a long run of _x in one subtag', make: (n: number) => `EN-${repeated('_x', n)}` },
    { shape: 'spaced empty parts', make: (n: number) => `${repeated(' ,', n)}!` },
    { shape: "'§1 x' runs ending '\\ny'", make: (n: number) => `${repeated('§1 x', n)}\ny` },
    { shape: "'  \\r\\n' runs", make: (n: number) => repeated('  \r\n', n) },
  ])(
    'stays linear over $shape',
    ({ make }) => {
      const base = make(BASE_CHARS);
      cpuMicrosPerCall(base);
      let largest = Number.POSITIVE_INFINITY;
      for (let chars = BASE_CHARS * 2; chars <= MAX_CHARS; chars *= 2) {
        const input = make(chars);
        let growth = Number.POSITIVE_INFINITY;
        for (let pair = 0; pair < PAIRS; pair++) {
          const baseline = cpuMicrosPerCall(base);
          const measured = cpuMicrosPerCall(input);
          growth = Math.min(growth, measured / baseline);
          if (chars === MAX_CHARS) largest = Math.min(largest, measured);
        }
        expect(growth, `${chars} characters`).toBeLessThan(4 * (chars / BASE_CHARS));
      }
      expect(largest, `µs per call at ${MAX_CHARS} characters`).toBeLessThan(100_000);
    },
    0,
  );
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

  /**
   * Verdicts the framework's `defaultIsTransient` reaches once none of the predicate's own
   * branches has decided — its retryable code set, the `retryable: false` opt-out, a pacer
   * shed, and the #86 statuses. The predicate's own branches are pinned case by case above.
   */
  describe('framework-default verdicts', () => {
    const statusError = (code: JsonRpcErrorCode, status: number, extra = {}) =>
      new McpError(code, `Fetch failed. Status: ${status}`, {
        status,
        errorSource: 'FetchHttpError',
        ...extra,
      });

    it.each([
      ['504', statusError(JsonRpcErrorCode.Timeout, 504), true],
      // The framework's in-band opt-out, which the predicate composes off.
      [
        'data.retryable: false (HTTP 501)',
        statusError(JsonRpcErrorCode.ServiceUnavailable, 501, { retryable: false }),
        false,
      ],
      // The framework default declines a shed: its retryAfter is the caller's to honor.
      [
        'a pacer shed',
        new McpError(JsonRpcErrorCode.RateLimited, 'No slot.', {
          reason: 'pacer_shed',
          retryAfter: 2,
          queueDepth: 4,
        }),
        false,
      ],
      ['a non-Error value', 'socket hang up', true],
    ])('%s → %s', (_label, error, expected) => {
      expect(isTransientNominatimError(error)).toBe(expected);
    });

    // #86: a deterministic 4xx is answered identically on every re-submission.
    it.each([
      ['404', statusError(JsonRpcErrorCode.NotFound, 404)],
      ['403', statusError(JsonRpcErrorCode.Forbidden, 403)],
      ['401', statusError(JsonRpcErrorCode.Unauthorized, 401)],
    ])('%s → false (#86)', (_label, error) => {
      expect(isTransientNominatimError(error)).toBe(false);
    });
  });
});
