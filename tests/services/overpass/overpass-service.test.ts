/**
 * @fileoverview Tests for overpass-service retry classification, remark
 * classification, HTTP error-body capture, and the endpoint slot gate.
 * @module tests/services/overpass/overpass-service.test
 */

import { getEventListeners } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_MAX_ELEMENTS,
  deriveQueryBudget,
  endpointLabel,
  endpointScrubber,
  isTransientOverpassError,
  OverpassService,
} from '@/services/overpass/overpass-service.js';

const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';
/** How every client-facing surface names `DEFAULT_ENDPOINT` (#91). */
const DEFAULT_ORIGIN = 'https://overpass-api.de';

/**
 * Mutable slot budget and endpoints so a test can pin the concurrency cap, point
 * the service at a credential-bearing mirror URL, and choose between a pinned
 * endpoint and a failover list — all independently of the env.
 *
 * `overpassBaseUrl` holds the default endpoint here, which is the *pinned* case:
 * every block except the failover one runs with rotation off, so those tests keep
 * asserting single-endpoint behavior exactly as before.
 */
const configState = vi.hoisted(() => ({
  overpassMaxConcurrency: 2,
  overpassBaseUrl: 'https://overpass-api.de/api/interpreter' as string | undefined,
  overpassEndpoints: ['https://overpass-api.de/api/interpreter'] as Array<
    string | { url: string; maxConcurrent: number }
  >,
}));

/**
 * A bare string in `configState.overpassEndpoints` is an unsuffixed entry; an object is
 * one sized with `|N` (#92) — the parsed shape the config schema produces either way.
 */
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    nominatimBaseUrl: 'https://nominatim.openstreetmap.org',
    overpassBaseUrl: configState.overpassBaseUrl,
    overpassEndpoints: configState.overpassEndpoints.map((entry) =>
      typeof entry === 'string' ? { url: entry } : entry,
    ),
    overpassMaxConcurrency: configState.overpassMaxConcurrency,
    nominatimUserAgent: 'openstreetmap-mcp-server/test',
  }),
}));

/**
 * The `http.client.request.duration` series the service records per submission.
 * Only the histogram factory is replaced — retry, pacing, and status mapping stay
 * the framework's own — so a test can read the attributes a submission carried.
 */
const recordDuration = vi.hoisted(() => vi.fn());
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createHistogram: () => ({ record: recordDuration }),
}));

/**
 * The service owns its Overpass POST (so it can raise the captured error-body
 * limit), so the seam under test is global `fetch`. Stubbing it rather than a
 * framework helper keeps the real status classification and the real withRetry in
 * the path — attempt counts and error codes stay meaningful — and guarantees no
 * test in this file reaches the live endpoint.
 *
 * The runtime's own `fetch` is kept for the redirect cases (#93), whose behavior lives
 * in the runtime's redirect handling: those route through the stub to a loopback
 * server only.
 */
const runtimeFetch = globalThis.fetch;
const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

/** An Overpass 200 response carrying a runtime-error remark and no elements. */
function remarkResponse(remark: string): Response {
  return new Response(JSON.stringify({ version: 0.6, elements: [], remark }), { status: 200 });
}

/**
 * The public endpoint's verbatim HTTP 400 document for a malformed query: 977
 * bytes whose first 501 are boilerplate, putting the first `Error` at byte 502.
 * The first case in the #45 block below pins those numbers — the whole point of
 * the fixture is that it straddles the framework's 500-byte default body cap.
 */
const OVERPASS_400_XHTML_BODY = `${[
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"',
  '    "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">',
  '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">',
  '<head>',
  '  <meta http-equiv="content-type" content="text/html; charset=utf-8" lang="en"/>',
  '  <title>OSM3S Response</title>',
  '</head>',
  '<body>',
  '',
  '<p>The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.</p>',
  '<p><strong style="color:#FF0000">Error</strong>: line 1: parse error: Left ( not closed. </p>',
  `<p><strong style="color:#FF0000">Error</strong>: line 1: parse error: ')' expected - ';' found. </p>`,
  '<p><strong style="color:#FF0000">Error</strong>: line 1: parse error: Unexpected end of input. </p>',
  '<p><strong style="color:#FF0000">Error</strong>: line 1: parse error: Unknown query clause </p>',
  '<p><strong style="color:#FF0000">Error</strong>: line 1: parse error: Unexpected end of input. </p>',
  '',
  '</body>',
  '</html>',
].join('\n')}\n`;

/**
 * #91: every keyed public Overpass provider puts its API key in the URL path, so
 * naming an endpoint by origin plus path put the key on every client-facing
 * surface. The label is the origin alone, disambiguated by list position only when
 * two configured entries would otherwise read the same.
 */
describe('endpointLabel (#91)', () => {
  const KEYED =
    'https://user:pw@overpass.nextgis.com/sk-FAKEKEY123/api/interpreter?key=QSECRET#frag';

  it('names an endpoint by origin alone — no path, query, fragment, or userinfo', () => {
    expect(endpointLabel(KEYED, [KEYED])).toBe('https://overpass.nextgis.com');
  });

  it('names the default endpoint as its bare origin', () => {
    expect(endpointLabel(DEFAULT_ENDPOINT, [DEFAULT_ENDPOINT])).toBe(DEFAULT_ORIGIN);
  });

  it('keeps a non-default port, which is part of the origin', () => {
    const local = 'http://127.0.0.1:8123/sk-FAKEKEY123/api/interpreter';
    expect(endpointLabel(local, [local])).toBe('http://127.0.0.1:8123');
  });

  it('leaves entries on distinct origins undecorated', () => {
    const list = [DEFAULT_ENDPOINT, KEYED];
    expect(list.map((e) => endpointLabel(e, list))).toEqual([
      DEFAULT_ORIGIN,
      'https://overpass.nextgis.com',
    ]);
  });

  it('adds the 1-based list position to entries that share an origin, and only to them', () => {
    const first = 'https://overpass.example.com/key-one/api/interpreter';
    const third = 'https://overpass.example.com/key-two/api/interpreter';
    const list = [first, DEFAULT_ENDPOINT, third];
    expect(list.map((e) => endpointLabel(e, list))).toEqual([
      'https://overpass.example.com (entry 1)',
      DEFAULT_ORIGIN,
      'https://overpass.example.com (entry 3)',
    ]);
  });

  it('separates two entries that differ only in their query string', () => {
    const a = 'https://overpass.example.com/api/interpreter?key=AAA';
    const b = 'https://overpass.example.com/api/interpreter?key=BBB';
    const labels = [a, b].map((e) => endpointLabel(e, [a, b]));
    expect(labels).toEqual([
      'https://overpass.example.com (entry 1)',
      'https://overpass.example.com (entry 2)',
    ]);
    expect(labels.join(' ')).not.toMatch(/AAA|BBB/);
  });
});

/**
 * #94: `endpointLabel` keeps the path, query, and userinfo out of every name the server
 * writes, but text the upstream wrote — an error body, the status line, a remark — was
 * quoted as it came. A keyed endpoint quoting its own request path put the key on the
 * client and in the log. Each occurrence now reads `…`; the rest is kept as it is.
 */
describe('endpointScrubber (#94)', () => {
  const KEYED =
    'https://keyuser:keypass@overpass.keyed.example/sk-FAKEKEY123/api/interpreter?key=QSECRET';

  it('replaces the path, the query, and the userinfo, keeping the rest of the text', () => {
    const scrub = endpointScrubber([KEYED]);
    expect(
      scrub('invalid key for /sk-FAKEKEY123/api/interpreter?key=QSECRET (account keyuser)'),
    ).toBe('invalid key for …?… (account …)');
    expect(scrub('https://keyuser:keypass@overpass.keyed.example')).toBe(
      'https://…:…@overpass.keyed.example',
    );
  });

  it('replaces a whole path before a shorter fragment inside it', () => {
    const scrub = endpointScrubber(['https://sk-KEY:pw@overpass.example/sk-KEY/api/interpreter']);
    expect(scrub('denied: /sk-KEY/api/interpreter')).toBe('denied: …');
  });

  it('scrubs every configured endpoint, not only the one that answered', () => {
    const scrub = endpointScrubber([
      DEFAULT_ENDPOINT,
      'https://overpass.keyed.example/sk-FAKEKEY123/api/interpreter',
    ]);
    expect(scrub('proxied /sk-FAKEKEY123/api/interpreter via /api/interpreter')).toBe(
      'proxied … via …',
    );
  });

  it('leaves text alone for an endpoint with a bare path, no query, and no userinfo', () => {
    const scrub = endpointScrubber(['https://overpass.example/']);
    expect(scrub('runtime error: a/b/c failed')).toBe('runtime error: a/b/c failed');
  });

  /**
   * A captured body cut at its byte limit ends in `…`, and the cut can fall inside a
   * quoted key: the opening characters of a key are as much the key as the rest.
   */
  it('drops a fragment stub that runs into a truncation mark', () => {
    const scrub = endpointScrubber([KEYED]);
    expect(scrub(`${'x'.repeat(20)}/sk-FAKE…`)).toBe(`${'x'.repeat(20)}…`);
    expect(scrub(`${'x'.repeat(20)}key=QS…`)).toBe(`${'x'.repeat(20)}…`);
    // Only at a cut: the same characters mid-text quote no key.
    expect(scrub('/sk-FAKE and more')).toBe('/sk-FAKE and more');
  });
});

describe('isTransientOverpassError', () => {
  describe('deterministic failures — should NOT retry (returns false)', () => {
    it('returns false for query_timeout reason', () => {
      const err = new McpError(JsonRpcErrorCode.Timeout, 'Overpass query timed out', {
        reason: 'query_timeout',
      });
      expect(isTransientOverpassError(err)).toBe(false);
    });

    it('returns false for result_too_large reason', () => {
      const err = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Overpass ran out of memory', {
        reason: 'result_too_large',
      });
      expect(isTransientOverpassError(err)).toBe(false);
    });

    // #41/#44: a throttled endpoint must not be re-submitted to — the reason is
    // attached by the service for the HTML throttle page, the status by the HTTP classifier.
    it('returns false for rate_limited reason (HTML throttle page)', () => {
      const err = new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Overpass returned an HTML page instead of JSON — likely rate-limited.',
        { reason: 'rate_limited' },
      );
      expect(isTransientOverpassError(err)).toBe(false);
    });

    it('returns false for HTTP 429 without a Retry-After hint', () => {
      const err = new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', {
        status: 429,
        errorSource: 'FetchHttpError',
      });
      expect(isTransientOverpassError(err)).toBe(false);
    });

    // #42: an unclassified runtime remark fails identically on re-submission.
    it('returns false for upstream_error reason (unclassified runtime remark)', () => {
      const err = new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Overpass reported an error: runtime error: Dispatcher_Client::request_read_and_idx::timeout',
        { reason: 'upstream_error' },
      );
      expect(isTransientOverpassError(err)).toBe(false);
    });

    it('returns false for HTTP 400 (status-classified InvalidParams — malformed query)', () => {
      // An HTTP status error carries status in data and no reason field
      const err = new McpError(JsonRpcErrorCode.InvalidParams, 'Fetch failed. Status: 400', {
        status: 400,
        errorSource: 'FetchHttpError',
      });
      expect(isTransientOverpassError(err)).toBe(false);
    });
  });

  describe('transient failures — should retry (returns true)', () => {
    it('returns true for HTTP 429 carrying a Retry-After hint, so withRetry honors the wait', () => {
      const err = new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', {
        status: 429,
        retryAfter: '5',
        errorSource: 'FetchHttpError',
      });
      expect(isTransientOverpassError(err)).toBe(true);
    });

    it('returns true for ServiceUnavailable without a reason (generic 5xx)', () => {
      const err = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Overpass unavailable');
      expect(isTransientOverpassError(err)).toBe(true);
    });

    it('returns true for plain Error (network error, DNS failure, etc.)', () => {
      expect(isTransientOverpassError(new Error('ECONNREFUSED'))).toBe(true);
    });

    it('returns true for non-McpError values', () => {
      expect(isTransientOverpassError('string error')).toBe(true);
      expect(isTransientOverpassError(null)).toBe(true);
      expect(isTransientOverpassError(undefined)).toBe(true);
      expect(isTransientOverpassError(42)).toBe(true);
    });
  });

  /**
   * Verdicts the framework's `defaultIsTransient` reaches once none of the predicate's own
   * branches has decided — its retryable code set, the `retryable: false` opt-out, a pacer
   * shed, and the #86 statuses. The predicate's own branches are pinned case by case above.
   */
  describe('framework-default verdicts', () => {
    const statusError = (code: JsonRpcErrorCode, status: number, extra = {}) =>
      new McpError(code, `Overpass returned HTTP ${status}.`, {
        status,
        errorSource: 'OverpassHttpError',
        ...extra,
      });

    it.each([
      ['503', statusError(JsonRpcErrorCode.ServiceUnavailable, 503), true],
      ['504', statusError(JsonRpcErrorCode.Timeout, 504), true],
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
      // Outside the framework's retryable code set, whatever the reason.
      [
        'a ValidationError',
        new McpError(JsonRpcErrorCode.ValidationError, 'Malformed query', {
          reason: 'query_error',
        }),
        false,
      ],
    ])('%s → %s', (_label, error, expected) => {
      expect(isTransientOverpassError(error)).toBe(expected);
    });

    // #86: a deterministic 4xx is answered identically on every re-submission.
    it.each([
      ['404', statusError(JsonRpcErrorCode.NotFound, 404)],
      ['403', statusError(JsonRpcErrorCode.Forbidden, 403)],
      ['401', statusError(JsonRpcErrorCode.Unauthorized, 401)],
    ])('%s → false (#86)', (_label, error) => {
      expect(isTransientOverpassError(error)).toBe(false);
    });
  });
});

describe('OverpassService query builders', () => {
  // The builders trust already-validated input — resolveTagInput rejects Overpass QL
  // metacharacters upstream (see openstreetmap-tag-input) — so these assert the QL shape
  // for a normal tag rather than any in-builder sanitization. Constructor deps are unused.
  const service = new OverpassService({} as AppConfig, {} as StorageService);

  it.each([
    { tagKey: 'shop', filters: [], chain: '["shop"]' },
    {
      tagKey: 'shop',
      filters: [{ tagKey: 'name', tagValue: 'Café House' }, { tagKey: 'website' }],
      chain: '["shop"]["name"="Café House"]["website"]',
    },
    {
      tagKey: 'amenity',
      tagValue: 'restaurant',
      filters: [{ tagKey: 'cuisine', tagValue: 'italian' }, { tagKey: 'name' }],
      chain: '["amenity"="restaurant"]["cuisine"="italian"]["name"]',
    },
  ])('builds exact equality/existence conjunctions: $chain', ({ chain, ...tags }) => {
    const common = {
      ...tags,
      elementTypes: ['relation', 'way', 'node'] as ('node' | 'way' | 'relation')[],
      timeoutSeconds: 30,
    };
    const around = service.buildAroundQuery({
      ...common,
      lat: 47.6,
      lon: -122.3,
      radiusMeters: 200,
    });
    const bbox = service.buildBboxQuery({ ...common, south: 65, west: 170, north: 66, east: -170 });
    for (const [query, spatial] of [
      [around, '(around:200,47.6,-122.3)'],
      [bbox, '(65,170,66,-170)'],
    ]) {
      expect(query).toBe(
        [
          '[out:json][timeout:30];',
          '(',
          `  relation${chain}${spatial};`,
          `  way${chain}${spatial};`,
          `  node${chain}${spatial};`,
          ');',
          'out center tags;',
        ].join('\n'),
      );
    }
  });

  describe('buildAroundQuery', () => {
    it('builds around-filter QL for a normal tag across element types', () => {
      const ql = service.buildAroundQuery({
        lat: 47.6,
        lon: -122.3,
        radiusMeters: 1000,
        tagKey: 'amenity',
        tagValue: 'cafe',
        elementTypes: ['node', 'way'],
        timeoutSeconds: 25,
      });
      expect(ql).toBe(
        [
          '[out:json][timeout:25];',
          '(',
          '  node["amenity"="cafe"](around:1000,47.6,-122.3);',
          '  way["amenity"="cafe"](around:1000,47.6,-122.3);',
          ');',
          'out center tags;',
        ].join('\n'),
      );
    });
  });

  describe('buildBboxQuery', () => {
    it('builds bbox-filter QL in south,west,north,east order for a normal tag', () => {
      const ql = service.buildBboxQuery({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        tagKey: 'leisure',
        tagValue: 'park',
        elementTypes: ['node', 'way'],
        timeoutSeconds: 30,
      });
      expect(ql).toBe(
        [
          '[out:json][timeout:30];',
          '(',
          '  node["leisure"="park"](47.5,-122.5,47.7,-122.2);',
          '  way["leisure"="park"](47.5,-122.5,47.7,-122.2);',
          ');',
          'out center tags;',
        ].join('\n'),
      );
    });
  });
});

// Regression for #42 and #44: every Overpass runtime remark opens with
// `runtime error:`, so a timeout pattern matching that prefix claimed the
// out-of-memory remark first and served it the raise-the-timeout hint. These
// drive real remark strings from the live endpoint through executeQuery.
describe('OverpassService remark classification', () => {
  let service: OverpassService;

  beforeEach(() => {
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  const OOM_REMARK =
    'runtime error: Query ran out of memory in "query" at line 1. It would need at least 0 MB of RAM to continue.';
  const TIMEOUT_REMARK = 'runtime error: Query timed out in "recurse" at line 3 after 25 seconds.';
  const DISPATCHER_REMARK =
    'runtime error: open64: 2 No such file or directory /osm3s_v0.7.62_osm_base Dispatcher_Client::request_read_and_idx::timeout';

  async function queryError(remark: string): Promise<McpError> {
    mockFetch.mockImplementation(async () => remarkResponse(remark));
    const ctx = createMockContext({ tenantId: 'test' });
    const err = await service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }

  it('classifies the out-of-memory remark as result_too_large, not query_timeout', async () => {
    const err = await queryError(OOM_REMARK);
    expect(err.data).toMatchObject({ reason: 'result_too_large' });
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toContain('ran out of memory');
  });

  // Pins the no-resubmit property to the *classified* failure: pre-fix the count
  // was also 1, but for the wrong reason (OOM read as query_timeout, likewise
  // non-transient), so the count alone does not discriminate. Asserting the pair
  // does.
  it('surfaces the out-of-memory remark on its first submission and does not re-submit', async () => {
    const err = await queryError(OOM_REMARK);
    expect(err.data).toMatchObject({ reason: 'result_too_large' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // Control: the path this fix narrows must still classify a real timeout as one.
  it('still classifies a genuine timeout remark as query_timeout', async () => {
    const err = await queryError(TIMEOUT_REMARK);
    expect(err.data).toMatchObject({ reason: 'query_timeout' });
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // A remark matching neither pattern used to fall through as a success carrying
  // an empty element list, hiding the failure behind "no results".
  it('surfaces an unclassified runtime remark as upstream_error instead of empty results', async () => {
    const err = await queryError(DISPATCHER_REMARK);
    expect(err.data).toMatchObject({ reason: 'upstream_error' });
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toContain('Dispatcher_Client');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns the response untouched when no remark is present', async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ version: 0.6, elements: [{ type: 'node', id: 1 }] }), {
          status: 200,
        }),
    );
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await service.query('[out:json];node(1);out;', ctx);
    expect(result.elements).toHaveLength(1);
  });
});

// Regression for #44: the HTML throttle page arrives with HTTP 200, so status
// classification passes it through as a success. Without a reason the tool layer
// had nothing to remap and withRetry re-submitted to a throttled endpoint.
describe('OverpassService HTML throttle page', () => {
  let service: OverpassService;

  beforeEach(() => {
    mockFetch.mockReset().mockImplementation(
      async () =>
        new Response('<!DOCTYPE html><html><body>Throttled</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    configState.overpassMaxConcurrency = 2;
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  it('throws rate_limited so the tool layer can remap it', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const err = await service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).data).toMatchObject({ reason: 'rate_limited' });
  });

  it('submits once instead of re-submitting to a throttled endpoint', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    await service.query('[out:json];node(1);out;', ctx).catch(() => undefined);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * Regression for #45: the framework's fetch helper truncates a non-2xx body at
 * 500 bytes, and the endpoint's error document puts its first `Error` line at
 * byte 502 — so every malformed query reached the caller with the parse error cut
 * off and only the boilerplate left. The service now captures the body itself.
 */
describe('OverpassService HTTP error body capture (#45)', () => {
  let service: OverpassService;

  beforeEach(() => {
    // A 5xx or a Retry-After 429 is transient, so withRetry sleeps between
    // attempts — drive the backoff on fake timers instead of waiting it out.
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
  });

  async function statusError(response: () => Response): Promise<McpError> {
    mockFetch.mockImplementation(async () => response());
    const ctx = createMockContext({ tenantId: 'test' });
    const pending = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await pending;
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }

  // Pins the fixture to the live shape the fix is calibrated against: if Overpass
  // ever shortens its boilerplate below the framework cap, this test says so
  // rather than letting the body-capture assertions below pass for a new reason.
  it('uses a fixture whose first Error line sits past the framework 500-byte cap', () => {
    expect(new TextEncoder().encode(OVERPASS_400_XHTML_BODY)).toHaveLength(977);
    expect(OVERPASS_400_XHTML_BODY.indexOf('Error')).toBe(502);
  });

  it('captures the whole 400 document, so every parse-error line reaches the caller', async () => {
    const err = await statusError(
      () => new Response(OVERPASS_400_XHTML_BODY, { status: 400, statusText: 'Bad Request' }),
    );

    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    const body = err.data?.body as string;
    expect(body).toContain('line 1: parse error: Left ( not closed.');
    expect(body).toContain("line 1: parse error: ')' expected - ';' found.");
    expect(body).toContain('line 1: parse error: Unknown query clause');
    expect(body.length).toBeGreaterThan(500);
  });

  // The tool handlers, isTransientOverpassError, and withRetry's Retry-After
  // parsing all read these fields; owning the request must not drop any of them.
  it('preserves the status/statusText/body/retryAfter data contract', async () => {
    const err = await statusError(
      () =>
        new Response('slow down', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Retry-After': '7' },
        }),
    );

    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({
      status: 429,
      statusText: 'Too Many Requests',
      body: 'slow down',
      retryAfter: '7',
      statusCode: 429,
      responseBody: 'slow down',
      operation: 'overpass.query',
    });
  });

  // #91: a keyed provider puts its key in the path, so the endpoint reaches error
  // data as its origin alone.
  it('names the endpoint in error data by origin alone', async () => {
    const err = await statusError(() => new Response('nope', { status: 503 }));
    expect(err.data?.url).toBe(DEFAULT_ORIGIN);
  });

  /**
   * The endpoint is operator-configured, so a provider's key — in the path, as
   * every keyed public instance takes it, or as `?key=` — and a private mirror's
   * credentials ride on it. Drives an endpoint that carries all three: the default
   * public URL has none, so asserting against it cannot tell redaction from
   * passing the raw string through.
   */
  it('strips a path key, credentials, and the query string from a private mirror endpoint', async () => {
    const keyed =
      'https://mirroruser:mirrorpass@overpass.internal.example/sk-FAKEKEY123/api/interpreter?key=SUPERSECRET';
    configState.overpassBaseUrl = keyed;
    const err = await statusError(() => new Response('nope', { status: 503 }));

    expect(err.data?.url).toBe('https://overpass.internal.example');
    // Nothing secret anywhere on the wire — message and every data field.
    const serialized = `${err.message} ${JSON.stringify(err.data)}`;
    expect(serialized).not.toContain('FAKEKEY');
    expect(serialized).not.toContain('SUPERSECRET');
    expect(serialized).not.toContain('mirrorpass');
    expect(serialized).not.toContain('mirroruser');
    // The request itself still goes to the full configured URL.
    expect(mockFetch.mock.calls.every(([input]) => String(input) === keyed)).toBe(true);
  });

  /**
   * The duration series is attributed by host alone — never the path a key rides
   * in, and never the origin label's port or list position, which would split one
   * host's latency across series.
   */
  it('attributes request duration to the bare host of a keyed endpoint', async () => {
    configState.overpassBaseUrl =
      'https://overpass.internal.example:8443/sk-FAKEKEY123/api/interpreter?key=SUPERSECRET';
    recordDuration.mockClear();
    mockFetch.mockImplementation(
      async () => new Response(JSON.stringify({ version: 0.6, elements: [] }), { status: 200 }),
    );
    await service.query('[out:json];node(1);out;', createMockContext({ tenantId: 'test' }));

    expect(recordDuration).toHaveBeenCalledTimes(1);
    expect(recordDuration.mock.calls[0]?.[1]).toEqual({
      'http.request.method': 'POST',
      'http.response.status_code': 200,
      'server.address': 'overpass.internal.example',
    });
  });

  it('names a keyed endpoint that cannot be reached by origin alone', async () => {
    configState.overpassBaseUrl = 'https://overpass.internal.example/sk-FAKEKEY123/api/interpreter';
    mockFetch.mockImplementation(async () => {
      throw Object.assign(new TypeError('Unable to connect.'), { code: 'ConnectionRefused' });
    });
    const pending = service
      .query('[out:json];node(1);out;', createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    const err = (await pending) as McpError;

    expect(err.message).toContain('https://overpass.internal.example: connection refused');
    const cause = err.cause as McpError;
    expect(cause.data?.url).toBe('https://overpass.internal.example');
    expect(
      `${err.message} ${JSON.stringify(err.data)} ${JSON.stringify(cause.data)}`,
    ).not.toContain('FAKEKEY');
  });

  /**
   * The fail-fast depends on `retryAfter` being absent from the new producer's
   * error data for a bare 429, exactly as it was absent from the old one's —
   * `isTransientOverpassError` reads that field to decide. Asserting the submission
   * count is what proves it end to end; the classifier unit test above only proves
   * the predicate, not that the producer still feeds it the same shape.
   */
  it('surfaces a bare 429 on its first submission instead of re-submitting', async () => {
    const err = await statusError(() => new Response('slow down', { status: 429 }));

    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data?.retryAfter).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('classifies 504 as Timeout and 502/503 as ServiceUnavailable, unchanged', async () => {
    expect((await statusError(() => new Response('gw', { status: 504 }))).code).toBe(
      JsonRpcErrorCode.Timeout,
    );
    expect((await statusError(() => new Response('bad gw', { status: 502 }))).code).toBe(
      JsonRpcErrorCode.ServiceUnavailable,
    );
  });
});

/**
 * The per-attempt client deadline was `fetchWithTimeout`'s job; owning the
 * request means owning the deadline, the composition with `ctx.signal`, and the
 * timer's cleanup. A deadline that never fires hangs the tool call for as long as
 * the endpoint holds the socket, and the two abort sources have to stay
 * distinguishable — a caller hanging up is not an upstream timeout.
 */
describe('OverpassService client deadline and cancellation', () => {
  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
  });

  /** A fetch that never settles on its own — it rejects with the abort reason, as the real one does. */
  function abortableFetch(): void {
    mockFetch.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
  }

  /**
   * An endpoint that goes unanswered inside a full attempt window has stated
   * something about itself, so the call ends there rather than re-asking it with
   * whatever the budget has left (#67). One configured endpoint therefore costs
   * one attempt window, and `endpoints_exhausted` now means "every endpoint tried
   * was still unanswered" rather than "the total budget ran out".
   */
  it('reports every endpoint unanswered when the attempt window runs out', async () => {
    abortableFetch();
    const ctx = createMockContext({ tenantId: 'test' });
    const pending = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);
    // Long enough for four 90s attempts plus backoff, had the fault not stopped it.
    await vi.advanceTimersByTimeAsync(600_000);
    const err = (await pending) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({
      errorSource: 'OverpassEndpointsUnanswered',
      reason: 'endpoints_exhausted',
    });
    // The window the host was given is named, so the caller can tell a 90s flat
    // deadline from a budget the query's own [timeout:N] widened.
    expect(err.message).toContain('90000ms attempt window');
    // One submission: the fault ends the call, and the clamped re-ask the budget
    // used to allow is dropped.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    /**
     * The fault ends the call inside withRetry's non-transient branch, which
     * rethrows the raw error, so no exhaustion enrichment is added — it would
     * claim four attempts against one real submission.
     */
    expect(err.data).not.toHaveProperty('retryAttempts');
    expect(err.message).not.toContain('failed after');
  });

  /**
   * The per-attempt abort still fires, which is what keeps a hung endpoint from
   * holding the call open for as long as it keeps the socket. What changed is
   * what follows it: the deadline is the endpoint's own fault now, so the call
   * settles at that window instead of re-asking the same host.
   */
  it('aborts a hanging attempt at its own deadline instead of holding the call open', async () => {
    abortableFetch();
    const ctx = createMockContext({ tenantId: 'test' });
    let settled = false;
    const pending = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => {
      settled = true;
      return e;
    });

    await vi.advanceTimersByTimeAsync(89_000);
    expect(settled).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(true);
    expect(((await pending) as McpError).data).toMatchObject({ reason: 'endpoints_exhausted' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  /**
   * A 5xx is the endpoint shedding load rather than refusing the call, so it is
   * still re-tried — three of them leave the budget with room for a full 90s
   * attempt, and the deadline that ends it is the endpoint's fault. The composed
   * error names it, and the submission count shows the load-shedding attempts
   * that preceded it were not written off.
   */
  it('re-tries a load-shedding endpoint and ends on the deadline that follows', async () => {
    let call = 0;
    mockFetch.mockImplementation((_input, init) => {
      call++;
      if (call < 4) return Promise.resolve(new Response('overloaded', { status: 503 }));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const ctx = createMockContext({ tenantId: 'test' });
    const pending = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200_000);
    const err = (await pending) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({
      errorSource: 'OverpassEndpointsUnanswered',
      reason: 'endpoints_exhausted',
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('classifies a caller abort as an abort rather than as the client deadline', async () => {
    abortableFetch();
    const controller = new AbortController();
    const ctx = createMockContext({ tenantId: 'test', signal: controller.signal });
    const pending = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);

    // Abort while the request is in flight, so the composed signal — not the slot
    // queue's pre-check — is what cancels it.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const err = (await pending) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(err.data).toMatchObject({ errorSource: 'OverpassAborted' });
    expect(err.message).toBe('Overpass query was aborted by the caller.');
  });

  /**
   * A caller that went away is not a query to try somewhere else. `withRetry`
   * checks the signal before its transient test, so the cancellation error is
   * rethrown raw — no second submission, no backoff timer left armed, and no
   * exhaustion suffix claiming attempts that were never made.
   */
  it('neither re-submits nor rotates after a caller abort', async () => {
    configState.overpassBaseUrl = undefined;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, 'https://overpass.example/api/interpreter'];
    abortableFetch();
    const controller = new AbortController();
    const ctx = createMockContext({ tenantId: 'test', signal: controller.signal });
    const pending = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    // Far past the 2s base backoff a retry would have waited out.
    await vi.advanceTimersByTimeAsync(60_000);
    const err = (await pending) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(err.message).not.toContain('failed after');
    expect(err.data).not.toHaveProperty('retryAttempts');
    // The attempt deadline is cleared on the way out, and no backoff timer is armed.
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * #96: `withRetry` rejects a caller abort that lands in its backoff with the signal's
   * own reason — a bare `AbortError` naming neither this service nor the query. A cancel
   * ends as `RequestCancelled` wherever it lands: in a slot wait, mid-request, and here,
   * between attempts.
   */
  describe('a cancel during the retry backoff (#96)', () => {
    /** One 503 per submission, then the caller leaves inside the backoff that follows. */
    async function cancelInBackoff(reason?: unknown): Promise<unknown> {
      mockFetch.mockImplementation(async () => new Response('overloaded', { status: 503 }));
      const controller = new AbortController();
      const ctx = createMockContext({ tenantId: 'test', signal: controller.signal });
      const pending = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(0);
      // The backoff is armed and the call is sleeping in it, not in a slot or a request.
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(0);
      return pending;
    }

    it('ends as RequestCancelled, not the raw abort reason', async () => {
      const err = await cancelInBackoff();

      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect((err as McpError).data).toMatchObject({ errorSource: 'OverpassAborted' });
      expect((err as McpError).message).toBe(
        'Overpass query was aborted by the caller during the retry backoff.',
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // No second submission, and the backoff timer did not outlive the call.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps it a cancellation when the caller aborts with a TimeoutError of its own', async () => {
      const err = (await cancelInBackoff(
        new DOMException('caller gave up', 'TimeoutError'),
      )) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(err.data).not.toHaveProperty('reason');
    });

    it('ends a cancel in the backoff before a failover return the same way', async () => {
      configState.overpassBaseUrl = undefined;
      configState.overpassEndpoints = [
        DEFAULT_ENDPOINT,
        'https://overpass.example/api/interpreter',
      ];
      service = new OverpassService({} as AppConfig, {} as StorageService);
      const err = (await cancelInBackoff()) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
      // Both entries were asked once — the walk to an untried entry takes no backoff —
      // and the cancel landed in the backoff before the return to the first.
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * The deadline is identified by the held DOMException instance, not by its
   * `TimeoutError` name — a caller aborting with a `TimeoutError` of its own is
   * still a caller going away, and must not be reported as this service's own
   * deadline firing.
   */
  it('classifies a caller abort carrying a TimeoutError reason as cancellation, not a deadline', async () => {
    abortableFetch();
    const controller = new AbortController();
    const ctx = createMockContext({ tenantId: 'test', signal: controller.signal });
    const pending = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new DOMException('caller gave up', 'TimeoutError'));
    await vi.advanceTimersByTimeAsync(0);
    const err = (await pending) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(err.data).toMatchObject({ errorSource: 'OverpassAborted' });
    expect(err.code).not.toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).not.toHaveProperty('attemptTimeoutMs');
  });

  /**
   * The counterpart: the service's own deadline stays a Timeout, so raising
   * cancellation to its own code does not reclassify a hung endpoint.
   */
  it('keeps the service deadline classified as Timeout', async () => {
    abortableFetch();
    const ctx = createMockContext({ tenantId: 'test' });
    const pending = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(600_000);
    const err = (await pending) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.code).not.toBe(JsonRpcErrorCode.RequestCancelled);
  });

  it('clears the deadline timer when the request completes normally', async () => {
    mockFetch.mockImplementation(
      async () => new Response(JSON.stringify({ version: 0.6, elements: [] }), { status: 200 }),
    );
    const ctx = createMockContext({ tenantId: 'test' });
    await service.query('[out:json];node(1);out;', ctx);

    // An uncleared 90s timer per request is a leak that only shows under load.
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Regression for #41: Overpass advertises 2 concurrent slots at /api/status and
// answers 429 past them. Nothing capped in-flight submissions, so N concurrent
// tool calls became N concurrent submissions.
describe('OverpassService endpoint slot gate (#41)', () => {
  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Peak concurrent submissions observed while running `count` distinct queries. */
  async function peakConcurrency(count: number): Promise<number> {
    let active = 0;
    let peak = 0;
    mockFetch.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      // A single Overpass query can hold its slot for the whole [timeout:N].
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      active--;
      return new Response(JSON.stringify({ version: 0.6, elements: [] }), { status: 200 });
    });

    const ctx = createMockContext({ tenantId: 'test' });
    const inFlight = Promise.all(
      Array.from({ length: count }, (_, i) => service.query(`[out:json];node(${i});out;`, ctx)),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await inFlight;
    expect(mockFetch).toHaveBeenCalledTimes(count);
    return peak;
  }

  it('holds concurrent submissions to the configured slot budget', async () => {
    expect(await peakConcurrency(6)).toBe(2);
  });

  it('honors a raised budget for a mirror with more slots', async () => {
    configState.overpassMaxConcurrency = 4;
    expect(await peakConcurrency(9)).toBe(4);
  });

  // Callers within the budget must run together rather than being serialized —
  // observed concurrency, not a clock read, is what distinguishes "took its slot
  // immediately" from "queued behind the one ahead of it" (a gate that parked
  // every caller would peak at 1 here).
  it('runs callers inside the budget concurrently instead of queueing them', async () => {
    expect(await peakConcurrency(2)).toBe(2);
  });
});

// The queue wait has to observe ctx.signal: withRetry awaits the operation and
// only checks the signal once the operation settles, so a parked caller that
// ignored cancellation would stay parked until a slot reached it.
describe('OverpassService slot gate cancellation', () => {
  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Holds each submission long enough that later callers must queue for a slot. */
  function slowFetch(): { peak: () => number } {
    let active = 0;
    let peak = 0;
    mockFetch.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      active--;
      return new Response(JSON.stringify({ version: 0.6, elements: [] }), { status: 200 });
    });
    return { peak: () => peak };
  }

  it('releases a queued caller on abort without stranding the rest or breaching the cap', async () => {
    const { peak } = slowFetch();
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const results = controllers.map((controller, i) =>
      service
        .query(
          `[out:json];node(${i});out;`,
          createMockContext({ tenantId: 'test', signal: controller.signal }),
        )
        .then(
          () => 'resolved' as const,
          (e: unknown) => e,
        ),
    );

    // Steady state: two submissions hold the budget, three are parked in the queue.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Cancel one of the parked callers, so it leaves the line mid-wait rather than
    // meeting the already-aborted pre-check.
    controllers[4]?.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    const settled = await Promise.all(results);

    const aborted = settled[4];
    expect(aborted).toBeInstanceOf(McpError);
    expect((aborted as McpError).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect((aborted as McpError).data).toMatchObject({ errorSource: 'OverpassSlotAborted' });
    expect((aborted as McpError).message).toBe(
      'Overpass query was aborted while waiting for an endpoint slot.',
    );

    // Every other caller still completes — the waiter that left did not swallow a
    // handoff — and the cancelled one never reached the endpoint.
    expect(settled.slice(0, 4)).toEqual(['resolved', 'resolved', 'resolved', 'resolved']);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(peak()).toBe(2);
  });

  it('does not spend a slot on a caller whose signal is already aborted', async () => {
    const { peak } = slowFetch();
    const live = Array.from({ length: 2 }, (_, i) =>
      service.query(`[out:json];node(${i});out;`, createMockContext({ tenantId: 'test' })),
    );
    const err = await service
      .query(
        '[out:json];node(99);out;',
        createMockContext({ tenantId: 'test', signal: AbortSignal.abort() }),
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect((err as McpError).data).toMatchObject({ errorSource: 'OverpassSlotAborted' });
    expect((err as McpError).message).toBe('Overpass query was aborted before it was submitted.');

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(live);
    // Only the two live callers submitted, and the aborted one never took a slot
    // from them — both ran concurrently at the cap.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(peak()).toBe(2);
  });
});

/**
 * Regression for #37: every attempt went to one endpoint, so a degraded endpoint
 * turned every Overpass-backed tool call into a hard failure while other instances
 * served the same query. Rotation rides withRetry's attempt loop, which is also
 * what keeps a deterministic failure on a single endpoint.
 */
describe('OverpassService endpoint failover (#37)', () => {
  const MIRROR = 'https://overpass.mirror.example/api/interpreter';
  const MIRROR_ORIGIN = 'https://overpass.mirror.example';
  const CREDENTIALED_MIRROR =
    'https://mirroruser:mirrorpass@overpass.internal.example/sk-FAKEKEY123/api/interpreter?key=SUPERSECRET';
  const QL = '[out:json];node(1);out;';

  let service: OverpassService;

  beforeEach(() => {
    // A transient failure means withRetry sleeps before rotating — drive the
    // backoff on fake timers instead of waiting it out.
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = undefined;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
  });

  /** Endpoint URLs the stubbed fetch was called with, in submission order. */
  function submittedTo(): string[] {
    return mockFetch.mock.calls.map(([input]) => String(input));
  }

  function okResponse(): Response {
    return new Response(JSON.stringify({ version: 0.6, elements: [] }), { status: 200 });
  }

  /** Answers 503 for the primary and 200 for anything else. */
  function primaryDegraded(): void {
    mockFetch.mockImplementation(async (input) =>
      String(input) === DEFAULT_ENDPOINT
        ? new Response('overloaded', { status: 503 })
        : okResponse(),
    );
  }

  /** Runs one query to completion, driving retry backoff on the fake clock. */
  async function runQuery(ql = QL, ctx = createMockContext({ tenantId: 'test' })) {
    const pending = service.query(ql, ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    return pending;
  }

  /** Same, for a query expected to fail — the handler is attached before the clock moves. */
  async function runQueryError(ql = QL): Promise<McpError> {
    const pending = service
      .query(ql, createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await pending;
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }

  it('advances to the next endpoint after a transient failure', async () => {
    primaryDegraded();
    const result = await runQuery();

    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    expect(result.servedBy).toBe(MIRROR_ORIGIN);
  });

  it('reports the serving endpoint by origin when the first endpoint answers', async () => {
    mockFetch.mockImplementation(async () => okResponse());
    const result = await runQuery();

    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT]);
    expect(result.servedBy).toBe(DEFAULT_ORIGIN);
  });

  /**
   * #91: the retry line goes to the client as `notifications/message` as well as to
   * the server log, so it names the endpoint the way every other surface does.
   */
  it('names the endpoint on the retry log line by origin alone', async () => {
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, CREDENTIALED_MIRROR];
    primaryDegraded();
    const ctx = createMockContext({ tenantId: 'test' });
    await runQuery(QL, ctx);

    const retries = (ctx.log as MockContextLogger).calls.filter(
      (c) => c.msg === 'Overpass retry submitting to endpoint',
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]?.data).toMatchObject({
      attempt: 2,
      endpoint: 'https://overpass.internal.example',
    });
    const logged = JSON.stringify((ctx.log as MockContextLogger).calls);
    expect(logged).not.toContain('FAKEKEY');
    expect(logged).not.toContain('SUPERSECRET');
    expect(logged).not.toContain('mirrorpass');
  });

  /**
   * A malformed query is rejected identically by every instance, so rotating
   * spends a second endpoint's slot on a request that cannot succeed. Asserting
   * which endpoints were reached — not just the error code, which is the same
   * either way — is what pins that.
   */
  it('does not rotate on an HTTP 400, leaving the mirror untouched', async () => {
    mockFetch.mockImplementation(async () => new Response('bad query', { status: 400 }));
    const err = await runQueryError();

    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT]);
  });

  it('does not rotate on an out-of-memory remark, leaving the mirror untouched', async () => {
    mockFetch.mockImplementation(async () =>
      remarkResponse('runtime error: Query ran out of memory in "query" at line 1.'),
    );
    const err = await runQueryError();

    expect(err.data).toMatchObject({ reason: 'result_too_large' });
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT]);
  });

  /**
   * An operator who named one endpoint did not ask for their queries to be sent
   * anywhere else — a private instance is not interchangeable with a public
   * mirror. The pin therefore disables rotation outright, even with a list set.
   */
  it('pins every attempt to OSM_OVERPASS_BASE_URL and ignores the endpoint list', async () => {
    const pinned = 'https://overpass.private.example/api/interpreter';
    configState.overpassBaseUrl = pinned;
    mockFetch.mockImplementation(async () => new Response('overloaded', { status: 503 }));

    await runQueryError();

    expect(submittedTo()).toEqual([pinned, pinned, pinned, pinned]);
  });

  /**
   * The endpoint travels to the client in enrichment, and an operator-configured
   * mirror can carry credentials, a `?key=`, and — as every keyed public provider
   * takes it — a key in the path. The report is the origin alone; the request
   * itself still uses the full URL.
   */
  it('reports a keyed, credentialed endpoint by origin alone', async () => {
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, CREDENTIALED_MIRROR];
    primaryDegraded();
    const result = await runQuery();

    expect(result.servedBy).toBe('https://overpass.internal.example');
    expect(submittedTo()[1]).toBe(CREDENTIALED_MIRROR);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('FAKEKEY');
    expect(serialized).not.toContain('SUPERSECRET');
    expect(serialized).not.toContain('mirrorpass');
    expect(serialized).not.toContain('mirroruser');
  });

  /**
   * The cache key is the query, so a mirror's response is served for the whole TTL
   * after the primary recovers. Attribution is cached with the payload rather than
   * recomputed per call, so a cache hit names the endpoint that produced the data
   * instead of the one this call would have tried first — and what is cached is
   * already the origin label, so storage never holds the key either.
   */
  it('keeps the serving endpoint on a cache hit', async () => {
    primaryDegraded();
    const ctx = createMockContext({ tenantId: 'test' });
    const first = await runQuery(QL, ctx);
    expect(first.servedBy).toBe(MIRROR_ORIGIN);

    const cached = await service.query(QL, ctx);

    expect(cached.servedBy).toBe(MIRROR_ORIGIN);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  /**
   * The slot gate is one budget across every endpoint, and rotation happens
   * between attempts — each attempt takes and releases its own slot — so a rotating
   * caller never carries the previous endpoint's slot with it. At a cap of 1 a
   * leaked or double-held slot deadlocks the queue outright.
   */
  it('never holds more than the slot budget while rotating, at a cap of one', async () => {
    configState.overpassMaxConcurrency = 1;
    let active = 0;
    let peak = 0;
    mockFetch.mockImplementation(async (input) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      active--;
      return String(input) === DEFAULT_ENDPOINT
        ? new Response('overloaded', { status: 503 })
        : okResponse();
    });

    const ctx = createMockContext({ tenantId: 'test' });
    const inFlight = Promise.all(
      Array.from({ length: 3 }, (_, i) => service.query(`[out:json];node(${i});out;`, ctx)),
    );
    await vi.advanceTimersByTimeAsync(120_000);
    const results = await inFlight;

    expect(peak).toBe(1);
    expect(results.map((r) => r.servedBy)).toEqual([MIRROR_ORIGIN, MIRROR_ORIGIN, MIRROR_ORIGIN]);
    // Each caller failed over exactly once: primary then mirror, three times.
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  /**
   * Rotation gives each attempt a fresh host to hang on, so the per-attempt
   * deadline would otherwise multiply across the attempt budget. Each attempt
   * draws from one call-wide budget instead, and since #67 each host also gets
   * exactly one attempt window: two endpoints, one submission each, and the call
   * settles on the second window rather than re-asking either with the remainder.
   */
  it('bounds total elapsed time across endpoints instead of stacking per-attempt deadlines', async () => {
    mockFetch.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    let settled = false;
    const pending = service.query(QL, createMockContext({ tenantId: 'test' })).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );

    // Two unclamped 90s attempts plus backoff would still be running here.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(settled).toBe(true);

    const err = (await pending) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({
      reason: 'endpoints_exhausted',
      errorSource: 'OverpassEndpointsUnanswered',
    });
    // Both endpoints named, each with the window it was actually given — the
    // second clamped to what the budget had left.
    expect(err.message).toContain(`${DEFAULT_ORIGIN}: no answer inside its 90000ms`);
    expect(err.message).toContain(`${MIRROR_ORIGIN}: no answer`);
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
  });
});

/**
 * Tracks what each endpoint is serving at once while every submission is held for
 * `ms`, then answers 200. Counts are read at the stub, so they show where submissions
 * actually went and how many overlapped, not what the service meant to do.
 */
function holdPerEndpoint(ms: number): {
  active: (url: string) => number;
  peak: (url: string) => number;
  peakTotal: () => number;
} {
  const active = new Map<string, number>();
  const peak = new Map<string, number>();
  let total = 0;
  let peakTotal = 0;
  mockFetch.mockImplementation(async (input) => {
    const url = String(input);
    const now = (active.get(url) ?? 0) + 1;
    active.set(url, now);
    peak.set(url, Math.max(peak.get(url) ?? 0, now));
    total++;
    peakTotal = Math.max(peakTotal, total);
    await new Promise((resolve) => setTimeout(resolve, ms));
    active.set(url, (active.get(url) ?? 1) - 1);
    total--;
    return emptyResponse();
  });
  return {
    active: (url) => active.get(url) ?? 0,
    peak: (url) => peak.get(url) ?? 0,
    peakTotal: () => peakTotal,
  };
}

/** A connection refusal as Bun raises it: a plain `TypeError` carrying a `code`. */
function connectionRefused(): TypeError {
  return Object.assign(
    new TypeError('Unable to connect. Is the computer able to access the url?'),
    { code: 'ConnectionRefused' },
  );
}

/**
 * #92: every submission shared one slot line and every call started at the first entry,
 * so a listed mirror added failover but never capacity. An entry now adds capacity only
 * when the operator sizes it with `|N`: each entry has its own slots, the server-wide line
 * admits the first entry's slots plus every later `|N` entry's, and a new call takes the
 * first admitting entry with a free slot.
 */
describe('OverpassService per-entry slot budgets (#92)', () => {
  const MIRROR = 'https://overpass.mirror.example/api/interpreter';

  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = undefined;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
  });

  function submittedTo(): string[] {
    return mockFetch.mock.calls.map(([input]) => String(input));
  }

  function startQueries(ids: number[]): Promise<unknown[]> {
    const ctx = createMockContext({ tenantId: 'test' });
    return Promise.all(ids.map((i) => service.query(`[out:json];node(${i});out;`, ctx)));
  }

  /**
   * An unsuffixed later entry stays failover-only, so an existing list keeps today's load
   * and data provenance: a healthy first entry serves everything, and the line still
   * holds both entries together to the one cap.
   */
  it('sends an unsuffixed second entry nothing while the first is healthy', async () => {
    const stub = holdPerEndpoint(5_000);
    const done = startQueries([0, 1, 2, 3, 4, 5]);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;

    expect(submittedTo().filter((url) => url === MIRROR)).toHaveLength(0);
    expect(stub.peak(DEFAULT_ENDPOINT)).toBe(2);
    expect(stub.peakTotal()).toBe(2);
  });

  it('runs six concurrent calls two on A and four on B|4, and holds a seventh in the line', async () => {
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, { url: MIRROR, maxConcurrent: 4 }];
    const stub = holdPerEndpoint(5_000);
    const done = startQueries([0, 1, 2, 3, 4, 5, 6]);

    await vi.advanceTimersByTimeAsync(0);
    expect(stub.active(DEFAULT_ENDPOINT)).toBe(2);
    expect(stub.active(MIRROR)).toBe(4);
    expect(mockFetch).toHaveBeenCalledTimes(6);

    // The seventh starts only when a call ahead of it settles, on the first entry with a
    // free slot — the first entry, back in list order.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockFetch).toHaveBeenCalledTimes(7);
    expect(submittedNodeIds()[6]).toBe(6);
    expect(submittedTo()[6]).toBe(DEFAULT_ENDPOINT);
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(stub.peakTotal()).toBe(6);
  });

  it('passes over a full first entry to a free B|4 and returns to A once A has a free slot', async () => {
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, { url: MIRROR, maxConcurrent: 4 }];
    mockFetch.mockImplementation(async (_input, init) => {
      const node = Number(/node\((\d+)\)/.exec(decodeURIComponent(String(init?.body)))?.[1]);
      await new Promise((resolve) => setTimeout(resolve, node < 2 ? 10_000 : 1_000));
      return emptyResponse();
    });

    const first = startQueries([0, 1, 2]);
    await vi.advanceTimersByTimeAsync(11_000);
    await first;
    // B still has every slot free, but A is first in the list and free again.
    const later = startQueries([3]);
    await vi.advanceTimersByTimeAsync(2_000);
    await later;

    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, DEFAULT_ENDPOINT, MIRROR, DEFAULT_ENDPOINT]);
  });

  it('sizes the first entry by its own |N rather than OSM_OVERPASS_MAX_CONCURRENCY', async () => {
    configState.overpassEndpoints = [{ url: DEFAULT_ENDPOINT, maxConcurrent: 3 }];
    const stub = holdPerEndpoint(5_000);
    const done = startQueries([0, 1, 2, 3, 4, 5]);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;

    expect(stub.peak(DEFAULT_ENDPOINT)).toBe(3);
  });

  /**
   * Each entry's slot line is named for `mcp.pacer.name` and for the shed message, which
   * reaches the caller — so it carries the origin label, never a key in the path or query.
   */
  it("names an entry's slot line by its origin, never the path or query key", async () => {
    const KEYED = 'https://overpass.keyed.example/sk-FAKEKEY123/api/interpreter?key=SUPERSECRET';
    configState.overpassMaxConcurrency = 1;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, { url: KEYED, maxConcurrent: 1 }];
    mockFetch.mockImplementation((input, init) =>
      String(input) === DEFAULT_ENDPOINT
        ? Promise.reject(connectionRefused())
        : hangUntilAborted(init),
    );
    const ctx = createMockContext({ tenantId: 'test' });
    // The first call is refused by A and walks to the keyed mirror, where it hangs; the
    // second, started once the first is there, follows it and waits for the mirror's
    // only slot.
    const holder = service.query('[out:json];node(0);out;', ctx).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    const waiter = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = (await waiter) as McpError;
    await vi.advanceTimersByTimeAsync(600_000);
    await holder;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({ reason: 'pacer_shed' });
    expect(err.message).toContain('https://overpass.keyed.example');
    expect(`${err.message} ${JSON.stringify(err.data)}`).not.toMatch(/FAKEKEY|SUPERSECRET/);
  });

  it('pins OSM_OVERPASS_BASE_URL at OSM_OVERPASS_MAX_CONCURRENCY whatever the list says', async () => {
    const pinned = 'https://overpass.private.example/api/interpreter';
    configState.overpassBaseUrl = pinned;
    configState.overpassEndpoints = [
      { url: DEFAULT_ENDPOINT, maxConcurrent: 5 },
      { url: MIRROR, maxConcurrent: 4 },
    ];
    const stub = holdPerEndpoint(5_000);
    const done = startQueries([0, 1, 2, 3, 4, 5]);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;

    expect(new Set(submittedTo())).toEqual(new Set([pinned]));
    expect(stub.peakTotal()).toBe(2);
  });

  /** Shutdown reaches a caller waiting at an entry's slot as well as one in the line. */
  it('rejects a caller waiting at an entry slot and one waiting in the line on dispose', async () => {
    configState.overpassMaxConcurrency = 1;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, { url: MIRROR, maxConcurrent: 1 }];
    mockFetch.mockImplementation((input, init) =>
      String(input) === DEFAULT_ENDPOINT
        ? Promise.reject(connectionRefused())
        : hangUntilAborted(init),
    );
    const ctx = createMockContext({ tenantId: 'test' });
    // Started one at a time, so each finds the state the one before it left: the holder
    // on the mirror, the next waiting at the mirror's slot, the last in the line.
    const holder = service.query('[out:json];node(0);out;', ctx).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    const atEntry = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    const inLine = service.query('[out:json];node(2);out;', ctx).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);

    service.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    const [entryErr, lineErr] = (await Promise.all([atEntry, inLine])) as McpError[];
    await vi.advanceTimersByTimeAsync(600_000);
    await holder;

    expect(entryErr?.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(lineErr?.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(submittedNodeIds().filter((id) => id === 2)).toHaveLength(0);
    expect(submittedTo().filter((url) => url === MIRROR)).toHaveLength(1);
  });
});

/**
 * #90: the slot line had no wait bound, and each retry rejoined the back of it after a
 * backoff even when the retry went to an endpoint the call had not tried. A call now
 * joins the line once and keeps its place for its whole life; a move to an untried entry
 * submits at once, a return to a tried one keeps `withRetry`'s backoff; and every slot
 * wait in a call draws on one 30 s allowance that sheds as the framework's `pacer_shed`.
 */
describe('OverpassService one place in the line per call (#90)', () => {
  const MIRROR = 'https://overpass.mirror.example/api/interpreter';
  const MIRROR_ORIGIN = 'https://overpass.mirror.example';

  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = undefined;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
  });

  function nodeOf(init: RequestInit | undefined): number {
    return Number(/node\((\d+)\)/.exec(decodeURIComponent(String(init?.body)))?.[1]);
  }

  /** Every submission as the stub saw it: which node, where, and at what virtual time. */
  function recordSubmissions(): Array<{ node: number; url: string; at: number }> {
    const log: Array<{ node: number; url: string; at: number }> = [];
    const original = mockFetch.getMockImplementation();
    mockFetch.mockImplementation((input, init) => {
      log.push({ node: nodeOf(init), url: String(input), at: Date.now() });
      if (!original) throw new Error('recordSubmissions wraps an existing stub');
      return original(input, init);
    });
    return log;
  }

  it('sheds a caller still in the line after 30 s as pacer_shed, retryAfter ≥ 30, never RequestCancelled', async () => {
    configState.overpassMaxConcurrency = 1;
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    mockFetch.mockImplementation((_input, init) => hangUntilAborted(init));
    const ctx = createMockContext({ tenantId: 'test' });
    const startedAt = Date.now();
    let settledAt = 0;

    const holder = service.query('[out:json];node(0);out;', ctx).catch((e: unknown) => e);
    const waiter = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => {
      settledAt = Date.now() - startedAt;
      return e;
    });
    await vi.advanceTimersByTimeAsync(31_000);
    const err = (await waiter) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.code).not.toBe(JsonRpcErrorCode.RequestCancelled);
    expect(err.data).toMatchObject({ reason: 'pacer_shed', shedKind: 'wait_elapsed' });
    expect(err.data?.retryAfter).toBeGreaterThanOrEqual(30);
    // A client reading only content[] gets the message and the hint, never error data.
    expect(err.message).toContain(`Retry after ${String(err.data?.retryAfter)} seconds.`);
    expect(settledAt).toBeGreaterThanOrEqual(30_000);
    expect(settledAt).toBeLessThan(31_000);
    // The shed query never left this server.
    expect(submittedNodeIds()).toEqual([0]);

    await vi.advanceTimersByTimeAsync(600_000);
    await holder;
  });

  it('walks a refused call to the mirror at once and finishes eight concurrent calls in arrival order', async () => {
    mockFetch.mockImplementation(async (input) => {
      if (String(input) === DEFAULT_ENDPOINT) throw connectionRefused();
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return emptyResponse();
    });
    const log = recordSubmissions();
    const ctx = createMockContext({ tenantId: 'test' });
    const finished: number[] = [];
    const calls = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      service.query(`[out:json];node(${i});out;`, ctx).then((result) => {
        finished.push(i);
        return result;
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const results = await Promise.all(calls);

    expect(finished).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(results.every((r) => r.servedBy === MIRROR_ORIGIN)).toBe(true);
    // The two calls the line admitted first meet the refusal: one each, then the mirror in
    // the same instant — no backoff sleep between. The refusal is remembered (#81), so
    // every later call goes straight to the mirror.
    for (const node of [0, 1]) {
      const mine = log.filter((s) => s.node === node);
      expect(mine.map((s) => s.url)).toEqual([DEFAULT_ENDPOINT, MIRROR]);
      expect((mine[1]?.at ?? 0) - (mine[0]?.at ?? 0)).toBe(0);
    }
    for (let node = 2; node < 8; node++) {
      expect(log.filter((s) => s.node === node).map((s) => s.url)).toEqual([MIRROR]);
    }
  });

  it('keeps its place through a backoff: at cap 1 a queued call starts only after the first settles', async () => {
    configState.overpassMaxConcurrency = 1;
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    let firstCallAttempts = 0;
    mockFetch.mockImplementation(async (_input, init) => {
      if (nodeOf(init) === 0 && ++firstCallAttempts === 1) {
        return new Response('overloaded', { status: 503 });
      }
      return emptyResponse();
    });
    const ctx = createMockContext({ tenantId: 'test' });
    const calls = [0, 1].map((i) => service.query(`[out:json];node(${i});out;`, ctx));
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(calls);

    expect(submittedNodeIds()).toEqual([0, 0, 1]);
  });

  /**
   * The walk to an untried entry skips the backoff; a return to an entry the call
   * already asked keeps it, and the call still makes the four submissions `withRetry`'s
   * default allows, reported in its exhaustion shape.
   */
  it("sleeps withRetry's backoff before returning to an entry already tried", async () => {
    mockFetch.mockImplementation(async () => new Response('overloaded', { status: 503 }));
    const log = recordSubmissions();
    const pending = service
      .query('[out:json];node(1);out;', createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = (await pending) as McpError;

    expect(log.map((s) => s.url)).toEqual([DEFAULT_ENDPOINT, MIRROR, DEFAULT_ENDPOINT, MIRROR]);
    // A 5xx walks to the untried mirror in the same instant, like a refusal does.
    expect((log[1]?.at ?? 0) - (log[0]?.at ?? 0)).toBe(0);
    // 2 s base backoff with ±25% jitter: never under 1.5 s before a return.
    expect((log[2]?.at ?? 0) - (log[1]?.at ?? 0)).toBeGreaterThanOrEqual(1_500);
    expect((log[3]?.at ?? 0) - (log[2]?.at ?? 0)).toBeGreaterThanOrEqual(1_500);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toContain('(failed after 4 attempts)');
    expect(err.data).toMatchObject({ retryAttempts: 4, status: 503 });
  });

  /** A 504 is the endpoint's own time budget, not the query's fault: still retried. */
  it('still retries an HTTP 504 as Timeout', async () => {
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    let call = 0;
    mockFetch.mockImplementation(async () =>
      ++call === 1 ? new Response('gateway timeout', { status: 504 }) : emptyResponse(),
    );
    const pending = service.query('[out:json];node(1);out;', createMockContext({ tenantId: 't' }));
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(result.servedBy).toBe(DEFAULT_ORIGIN);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  /**
   * One allowance per call, not one per wait: 20 s in the line leaves 10 s for the wait
   * at the mirror's slot, so the call sheds 30 s after it arrived rather than 50.
   */
  it('charges an entry-slot wait to the same 30 s allowance as the line', async () => {
    configState.overpassMaxConcurrency = 1;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, { url: MIRROR, maxConcurrent: 1 }];
    mockFetch.mockImplementation(async (input, init) => {
      const node = nodeOf(init);
      if (String(input) === DEFAULT_ENDPOINT && node === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        return emptyResponse();
      }
      // A throttle turns a call away for that call alone; a refusal would cool A (#81).
      if (String(input) === DEFAULT_ENDPOINT) return new Response('slow down', { status: 429 });
      return hangUntilAborted(init);
    });
    const ctx = createMockContext({ tenantId: 'test' });

    // Node 0 is throttled by A and holds the mirror; node 1, started once node 0 is there,
    // holds A for 20 s. Both take the line's two places, so node 2 waits in the line,
    // then is throttled by A and waits at the mirror's slot.
    const holder = service
      .query('[out:json][timeout:180];node(0);out;', ctx)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    const second = service.query('[out:json];node(1);out;', ctx);
    await vi.advanceTimersByTimeAsync(0);
    const startedAt = Date.now();
    let settledAt = 0;
    const late = service.query('[out:json];node(2);out;', ctx).catch((e: unknown) => {
      settledAt = Date.now() - startedAt;
      return e;
    });
    await vi.advanceTimersByTimeAsync(31_000);
    const err = (await late) as McpError;
    await second;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({ reason: 'pacer_shed', shedKind: 'wait_elapsed' });
    expect(err.message).toContain(MIRROR_ORIGIN);
    // The mirror's own queue saw a 10 s wait; the call waited 30 s for a slot it could take.
    expect(err.data?.retryAfter).toBeGreaterThanOrEqual(30);
    expect(err.message).toContain(`Retry after ${String(err.data?.retryAfter)} seconds.`);
    expect(settledAt).toBeGreaterThanOrEqual(30_000);
    expect(settledAt).toBeLessThan(31_000);

    await vi.advanceTimersByTimeAsync(600_000);
    await holder;
  });

  it('ends a caller cancelled while waiting at an entry slot as OverpassSlotAborted', async () => {
    configState.overpassMaxConcurrency = 1;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, { url: MIRROR, maxConcurrent: 1 }];
    mockFetch.mockImplementation((input, init) =>
      String(input) === DEFAULT_ENDPOINT
        ? Promise.reject(connectionRefused())
        : hangUntilAborted(init),
    );
    const controller = new AbortController();
    const holder = service
      .query('[out:json];node(0);out;', createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    // Once the holder is on the mirror, the waiter finds A cooling from that refusal (#81)
    // and queues behind it.
    await vi.advanceTimersByTimeAsync(0);
    const waiter = service
      .query(
        '[out:json];node(1);out;',
        createMockContext({ tenantId: 'test', signal: controller.signal }),
      )
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const err = (await waiter) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(err.data).toMatchObject({ errorSource: 'OverpassSlotAborted' });
    expect(err.message).toBe('Overpass query was aborted while waiting for an endpoint slot.');
    expect(mockFetch.mock.calls.filter(([input]) => String(input) === MIRROR)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(600_000);
    await holder;
  });

  /**
   * The line wait counts against the budget: 20 s in the line, a 90 s window on A, and
   * the mirror gets only the 10 s left — the call settles 120 s after it arrived.
   */
  it('charges the wait in the line against the call budget', async () => {
    configState.overpassMaxConcurrency = 1;
    mockFetch.mockImplementation(async (_input, init) => {
      if (nodeOf(init) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        return emptyResponse();
      }
      return hangUntilAborted(init);
    });
    const ctx = createMockContext({ tenantId: 'test' });
    const startedAt = Date.now();
    let settledAt = 0;
    const holder = service.query('[out:json];node(0);out;', ctx);
    const late = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => {
      settledAt = Date.now() - startedAt;
      return e;
    });
    await vi.advanceTimersByTimeAsync(600_000);
    await holder;
    const err = (await late) as McpError;

    expect(err.data).toMatchObject({ reason: 'endpoints_exhausted' });
    expect(err.message).toContain(`${DEFAULT_ORIGIN}: no answer inside its 90000ms attempt window`);
    expect(err.message).toContain(`${MIRROR_ORIGIN}: no answer inside its 10000ms attempt window`);
    expect(settledAt).toBe(120_000);
  });
});

/**
 * Regression for #51: `openstreetmap_query_raw` advertises `timeout_seconds` up
 * to 180, but both client-side deadlines were flat constants that ignored it, so
 * anything past 90s was aborted client-side and the call ended on the 120s budget.
 * The budget now derives from the `[timeout:N]` the query actually carries —
 * which is also the only surface that sees a directive a caller wrote into the QL
 * themselves, bypassing the input schema entirely.
 */
describe('OverpassService derived query budget (#51)', () => {
  const FLAT_ATTEMPT_MS = 90_000;
  const FLAT_TOTAL_MS = 120_000;

  describe('deriveQueryBudget', () => {
    it('falls back to the flat budget for a query carrying no timeout directive', () => {
      expect(deriveQueryBudget('[out:json];node(1);out;')).toEqual({
        attemptMs: FLAT_ATTEMPT_MS,
        totalMs: FLAT_TOTAL_MS,
      });
    });

    /**
     * The no-regression property, asserted at the two values the convenience
     * tools can actually produce: `query_nearby` and `query_bbox` cap
     * `timeout_seconds` at 60, so every query they build must still receive the
     * flat budget it receives today. A derived deadline that came out *below* the
     * flat one would fail queries that succeed now.
     */
    it.each([5, 25, 30, 60])(
      'keeps the full flat budget for a %ds query, never a tighter one',
      (seconds) => {
        expect(deriveQueryBudget(`[out:json][timeout:${seconds}];node(1);out;`)).toEqual({
          attemptMs: FLAT_ATTEMPT_MS,
          totalMs: FLAT_TOTAL_MS,
        });
      },
    );

    it('widens both layers once the requested timeout outgrows the flat budget', () => {
      expect(deriveQueryBudget('[out:json][timeout:90];node(1);out;')).toEqual({
        attemptMs: 120_000,
        totalMs: 150_000,
      });
      expect(deriveQueryBudget('[out:json][timeout:180];node(1);out;')).toEqual({
        attemptMs: 210_000,
        totalMs: 240_000,
      });
    });

    it('reads a directive written into the QL by hand, spacing and all', () => {
      expect(deriveQueryBudget('[out:json][timeout: 180 ];node(1);out;').attemptMs).toBe(210_000);
    });

    /**
     * #68: the budget pattern stopped at a space after the value, so a spelling
     * Overpass accepts — space after `[`, or around the colon — silently fell
     * back to the flat 90s and the call died on a client deadline the endpoint
     * would have answered. The tool's presence check now reads the same pattern,
     * so both decisions move together.
     */
    it.each([
      '[out:json][ timeout : 170 ];node(1);out;',
      '[out:json][timeout : 170];node(1);out;',
      '[out:json][ timeout:170 ];node(1);out;',
    ])('reads %s as 170 seconds, the same as the unspaced spelling', (ql) => {
      expect(deriveQueryBudget(ql)).toEqual(
        deriveQueryBudget('[out:json][timeout:170];node(1);out;'),
      );
      expect(deriveQueryBudget(ql).attemptMs).toBe(200_000);
    });

    it('falls back to the flat budget for a directive it cannot parse', () => {
      expect(deriveQueryBudget('[out:json][timeout:abc];node(1);out;').attemptMs).toBe(
        FLAT_ATTEMPT_MS,
      );
    });

    /**
     * A directive past the honored ceiling is recognized — the raw tool must not
     * inject a second one beside it — but not waited for: a window that long
     * would overflow the attempt timer into an immediate abort.
     */
    it('falls back to the flat budget for a timeout past the honored ceiling', () => {
      expect(deriveQueryBudget('[out:json][timeout:99999];node(1);out;').attemptMs).toBe(
        99_999_000 + 30_000,
      );
      expect(deriveQueryBudget('[out:json][timeout:100000];node(1);out;').attemptMs).toBe(
        FLAT_ATTEMPT_MS,
      );
      expect(deriveQueryBudget('[out:json][timeout:99999999999];node(1);out;').attemptMs).toBe(
        FLAT_ATTEMPT_MS,
      );
    });
  });

  describe('end to end', () => {
    let service: OverpassService;

    beforeEach(() => {
      vi.useFakeTimers();
      mockFetch.mockReset();
      configState.overpassMaxConcurrency = 2;
      configState.overpassBaseUrl = DEFAULT_ENDPOINT;
      service = new OverpassService({} as AppConfig, {} as StorageService);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** A fetch that never settles on its own — it rejects with the abort reason. */
    function hangingFetch(): void {
      mockFetch.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
    }

    /**
     * The behavior #51 reports as unreachable. A `[timeout:180]` query is still on
     * its first attempt at 200s — under the flat budget that attempt was aborted
     * at 90s and the whole call was over at 120s, so the 91–180s range the schema
     * advertised could never be used. Asserting the in-flight attempt count at a
     * specific clock reading is what distinguishes "waited longer" from "failed
     * later".
     */
    it('waits out a 180s query instead of aborting it at the flat 90s deadline', async () => {
      hangingFetch();
      const ctx = createMockContext({ tenantId: 'test' });
      const pending = service
        .query('[out:json][timeout:180];node(1);out;', ctx)
        .catch((e: unknown) => e);

      // Past both flat deadlines, and still the first attempt.
      await vi.advanceTimersByTimeAsync(200_000);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      const err = (await pending) as McpError;
      expect(err.data).toMatchObject({ reason: 'endpoints_exhausted' });
      // The derived window, not the flat constant, is what the caller is told:
      // 180s of Overpass runtime plus the 30s transfer margin.
      expect(err.message).toContain('210000ms attempt window');
    });

    /**
     * Control for the case above: a query that asks for no more than the flat
     * budget must keep the flat window verbatim, including the number reported
     * when it runs out.
     */
    it('reports the flat window for a query that does not ask for more', async () => {
      hangingFetch();
      const ctx = createMockContext({ tenantId: 'test' });
      const pending = service
        .query('[out:json][timeout:25];node(1);out;', ctx)
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(600_000);
      const err = (await pending) as McpError;

      expect(err.message).toContain('90000ms attempt window');
      // One submission since #67 — the unanswered window faults the endpoint, so
      // the clamped re-ask the budget used to allow never happens.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Regression for #49: making a throttle non-transient (#41) and rotating on the
 * attempt index (#37) were each right alone, but together a throttled endpoint
 * ended the call while every other endpoint sat idle. The predicate answers "is
 * another attempt worth making" with no idea whether that attempt would reach a
 * different host.
 */
describe('OverpassService throttle failover (#49)', () => {
  const MIRROR = 'https://overpass.mirror.example/api/interpreter';
  const MIRROR_ORIGIN = 'https://overpass.mirror.example';
  const QL = '[out:json];node(1);out;';

  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = undefined;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
  });

  function submittedTo(): string[] {
    return mockFetch.mock.calls.map(([input]) => String(input));
  }

  function okResponse(): Response {
    return new Response(JSON.stringify({ version: 0.6, elements: [] }), { status: 200 });
  }

  async function run(ql = QL) {
    const pending = service.query(ql, createMockContext({ tenantId: 'test' }));
    await vi.advanceTimersByTimeAsync(120_000);
    return pending;
  }

  async function runError(ql = QL): Promise<McpError> {
    const pending = service
      .query(ql, createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await pending;
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }

  /**
   * The reported defect: the second endpoint is idle and serving the identical
   * query. Asserting the endpoint that answered — not just that the call
   * succeeded — is what pins the rotation rather than the classification.
   */
  it('advances a throttled endpoint to the next one, which answers', async () => {
    mockFetch.mockImplementation(async (input) =>
      String(input) === DEFAULT_ENDPOINT
        ? new Response('slow down', { status: 429 })
        : okResponse(),
    );
    const result = await run();

    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    expect(result.servedBy).toBe(MIRROR_ORIGIN);
  });

  it('rotates on an HTML throttle document served with HTTP 200', async () => {
    mockFetch.mockImplementation(async (input) =>
      String(input) === DEFAULT_ENDPOINT
        ? new Response('<!DOCTYPE html><html><body>Throttled</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
        : okResponse(),
    );
    const result = await run();

    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    expect(result.servedBy).toBe(MIRROR_ORIGIN);
  });

  /** The call ends only once every endpoint has refused it — and each was asked once. */
  it('surfaces the throttle once every endpoint has been tried, submitting to each once', async () => {
    mockFetch.mockImplementation(async () => new Response('slow down', { status: 429 }));
    const err = await runError();

    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
  });

  /**
   * #41's rule, kept intact: a 429 is never re-submitted to the host that issued
   * it. A mixed failure sequence is where an attempt-index rotation would break
   * it — after the throttle and a transient 5xx, the round-robin wraps back onto
   * the throttled endpoint. Counting that endpoint's submissions is the assertion;
   * the call's outcome is identical either way.
   */
  it('never returns to a throttled endpoint, even when a later failure wraps rotation onto it', async () => {
    mockFetch.mockImplementation(async (input) =>
      String(input) === DEFAULT_ENDPOINT
        ? new Response('slow down', { status: 429 })
        : new Response('overloaded', { status: 503 }),
    );
    await runError();

    const submissions = submittedTo();
    expect(submissions.filter((url) => url === DEFAULT_ENDPOINT)).toHaveLength(1);
    expect(submissions.filter((url) => url === MIRROR).length).toBeGreaterThan(1);
  });

  /**
   * A single endpoint has nowhere to rotate to, so the fail-fast #41 established
   * must be exactly what it was: one submission, no re-send to a throttled host.
   */
  it('still fails fast on a throttle when one endpoint is configured', async () => {
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
    mockFetch.mockImplementation(async () => new Response('slow down', { status: 429 }));
    const err = await runError();

    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT]);
  });

  it('honors a Retry-After 429 as a wait rather than writing the endpoint off', async () => {
    let call = 0;
    mockFetch.mockImplementation(async (input) => {
      call++;
      if (call === 1) {
        return new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } });
      }
      expect(String(input)).toBe(MIRROR);
      return okResponse();
    });
    const result = await run();
    expect(result.servedBy).toBe(MIRROR_ORIGIN);
  });

  /**
   * A dispatcher or database fault is the instance's own state, so another
   * endpoint may serve the query fine — the same shape as a throttle, and
   * distinguished from the rest of the remark bucket by the signature OSM3S puts
   * in the text.
   */
  it('rotates on a dispatcher remark, which names a fault of the instance', async () => {
    mockFetch.mockImplementation(async (input) =>
      String(input) === DEFAULT_ENDPOINT
        ? remarkResponse(
            'runtime error: open64: 2 No such file or directory /osm3s_v0.7.62_osm_base Dispatcher_Client::request_read_and_idx::timeout. The server is probably too busy to handle your request.',
          )
        : okResponse(),
    );
    const result = await run();

    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    expect(result.servedBy).toBe(MIRROR_ORIGIN);
  });

  /**
   * The narrowing that keeps #13's rule: a remark describing the query is
   * rejected identically by every instance, so rotating spends a second
   * endpoint's slot on a request that cannot succeed. Asserting the mirror was
   * never reached is the whole point — the error code is the same either way.
   */
  it('does not rotate on a remark that describes the query rather than the instance', async () => {
    mockFetch.mockImplementation(async () =>
      remarkResponse('runtime error: Unknown type "noded" in the query at line 1.'),
    );
    const err = await runError();

    expect(err.data).toMatchObject({ reason: 'upstream_error' });
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT]);
  });
});

/**
 * Regression for #49: OSM3S error documents lead with an XML declaration before
 * the doctype, which the anchored HTML pattern did not match — so such a body
 * reached `JSON.parse` and escaped as a raw `SyntaxError`: no reason, no
 * recovery, no status, and read as transient by withRetry because it is not an
 * `McpError`.
 */
describe('OverpassService non-JSON 2xx body classification (#49)', () => {
  let service: OverpassService;

  /** The OSM3S document shape, verbatim down to the leading XML declaration. */
  function osm3sDocument(errorLine: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"',
      '    "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">',
      '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">',
      '<head>',
      '  <title>OSM3S Response</title>',
      '</head>',
      '<body>',
      '<p>The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.</p>',
      `<p><strong style="color:#FF0000">Error</strong>: ${errorLine} </p>`,
      '</body>',
      '</html>',
    ].join('\n');
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function bodyError(body: string): Promise<McpError> {
    mockFetch.mockImplementation(async () => new Response(body, { status: 200 }));
    const pending = service
      .query('[out:json];node(1);out;', createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    return (await pending) as McpError;
  }

  /**
   * OSM3S renders a rate-limit refusal with this exact origin and advice. The
   * pre-fix outcome for the same body was an unclassified `SyntaxError`, so
   * asserting the reason and the quoted upstream text — not the failure itself —
   * is what discriminates.
   */
  it('classifies an XML-declaration-led throttle document as rate_limited', async () => {
    const err = await bodyError(
      osm3sDocument(
        'runtime error: open64: 0 Success /osm3s_v0.7.62_osm_base Dispatcher_Client::request_read_and_idx::rate_limited. Please check https://overpass-api.de/api/status for the quota of your IP address.',
      ),
    );

    expect(err).toBeInstanceOf(McpError);
    expect(err.data).toMatchObject({ reason: 'rate_limited' });
    expect(err.message).toContain('quota of your IP address');
    // Markup never reaches the agent-facing message.
    expect(err.message).not.toContain('<');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('classifies an XML-declaration-led dispatcher document as upstream_error', async () => {
    const err = await bodyError(
      osm3sDocument(
        'runtime error: open64: 2 No such file or directory /osm3s_v0.7.62_osm_base Dispatcher_Client::1. The dispatcher (i.e. the database management system) is turned off.',
      ),
    );

    expect(err.data).toMatchObject({ reason: 'upstream_error' });
    expect(err.message).toContain('the database management system) is turned off');
    expect(err.message).not.toContain('<');
  });

  /**
   * The escape the anchored pattern left open: a body that is neither JSON nor a
   * recognizable page used to surface as a bare `SyntaxError` and, being a
   * non-`McpError`, was read as transient and re-submitted for the full attempt
   * budget. Both halves are asserted — the classification and the single
   * submission — because either alone passes for the wrong reason.
   */
  it('classifies a non-JSON, non-markup body instead of throwing a bare SyntaxError', async () => {
    const err = await bodyError('upstream connect error or disconnect/reset before headers');

    expect(err).toBeInstanceOf(McpError);
    expect(err.data).toMatchObject({ reason: 'upstream_error' });
    expect(err.message).toContain('upstream connect error');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('bounds how much of an unrecognized body it quotes back', async () => {
    const err = await bodyError('x'.repeat(5_000));
    expect(err.message.length).toBeLessThan(400);
  });
});

/**
 * Regression for #50's retention half: `executeQuery` cached the full parsed
 * result for 10 minutes regardless of size, and the default storage provider is
 * in-memory — so a multi-million-element extract stayed charged against the same
 * budget as the live response long after it was served.
 */
describe('OverpassService result cache ceiling (#50)', () => {
  let service: OverpassService;

  beforeEach(() => {
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  function respondWith(count: number): void {
    const elements = Array.from({ length: count }, (_, i) => ({ type: 'node', id: i + 1 }));
    const body = JSON.stringify({ version: 0.6, elements });
    mockFetch.mockImplementation(async () => new Response(body, { status: 200 }));
  }

  /** Submissions taken by two identical queries — 1 means the second was served from cache. */
  async function submissionsForRepeatedQuery(count: number): Promise<number> {
    respondWith(count);
    const ctx = createMockContext({ tenantId: 'test' });
    const ql = '[out:json];node(1);out;';
    await service.query(ql, ctx);
    await service.query(ql, ctx);
    return mockFetch.mock.calls.length;
  }

  it('caches a result at the ceiling, so re-paging costs no upstream request', async () => {
    expect(await submissionsForRepeatedQuery(CACHE_MAX_ELEMENTS)).toBe(1);
  });

  it('serves but does not cache a result past the ceiling', async () => {
    expect(await submissionsForRepeatedQuery(CACHE_MAX_ELEMENTS + 1)).toBe(2);
  });

  it('still returns every element it declined to cache', async () => {
    respondWith(CACHE_MAX_ELEMENTS + 1);
    const result = await service.query(
      '[out:json];node(1);out;',
      createMockContext({ tenantId: 'test' }),
    );
    expect(result.elements).toHaveLength(CACHE_MAX_ELEMENTS + 1);
  });
});

/**
 * #89: the service checked its cache and then submitted, so an identical query arriving
 * while the first copy ran took a slot of its own, and a copy queued behind it never
 * re-checked the cache. Identical in-flight queries from one tenant now share one
 * submission, which runs on its own signal under the budget its query text derives. Each
 * caller can leave without failing the others; the last one out takes the submission with it.
 */
describe('OverpassService shared in-flight submissions (#89)', () => {
  const QL = '[out:json];node(1);out;';

  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassMaxConcurrency = 2;
  });

  /** Answers every submission after `ms` with one element, aborting as the real `fetch` does. */
  function answerAfter(ms: number): void {
    mockFetch.mockImplementation(
      (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({ version: 0.6, elements: [{ type: 'node', id: 1 }] }),
                  {
                    status: 200,
                  },
                ),
              ),
            ms,
          );
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
  }

  /**
   * One caller of a tenant. A tenant's callers share its storage in production, while each
   * mock context gets a store of its own, so these share `store` — still checking the
   * caller's own signal before every operation, as `ctx.state` does.
   */
  function caller(
    store: Map<string, unknown>,
    options: { signal?: AbortSignal; tenantId?: string } = {},
  ): Context {
    const ctx = createMockContext({
      tenantId: options.tenantId ?? 'test',
      ...(options.signal && { signal: options.signal }),
    });
    const scoped = (key: string) => `${ctx.tenantId}/${key}`;
    const state = {
      ...ctx.state,
      get: async (key: string) => {
        ctx.signal.throwIfAborted();
        return store.get(scoped(key)) ?? null;
      },
      set: async (key: string, value: unknown) => {
        ctx.signal.throwIfAborted();
        store.set(scoped(key), value);
      },
    } as Context['state'];
    return { ...ctx, state };
  }

  it('makes one submission for five identical concurrent calls, and serves a sixth from cache', async () => {
    answerAfter(3_000);
    const store = new Map<string, unknown>();
    const calls = Array.from({ length: 5 }, () => service.query(QL, caller(store)));
    // Long enough for five separate submissions at the cap of two to finish, too.
    await vi.advanceTimersByTimeAsync(10_000);
    const results = await Promise.all(calls);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(results[0]?.elements).toHaveLength(1);
    for (const result of results) expect(result).toBe(results[0]);

    await service.query(QL, caller(store));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("detaches one caller's cancellation without failing the callers still attached", async () => {
    answerAfter(5_000);
    const store = new Map<string, unknown>();
    const leaving = new AbortController();
    let leftAt: number | undefined;
    const initiator = service
      .query(QL, caller(store, { signal: leaving.signal }))
      .catch((e: unknown) => {
        leftAt = Date.now();
        return e;
      });
    const staying = [0, 1].map(() => service.query(QL, caller(store)));
    await vi.advanceTimersByTimeAsync(1_000);

    leaving.abort();
    await vi.advanceTimersByTimeAsync(0);
    const err = (await initiator) as McpError;

    // It ends at once, as a cancellation, while the submission it started runs on.
    expect(leftAt).toBe(Date.now());
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(err.data).toMatchObject({ errorSource: 'OverpassAborted' });
    expect(mockFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(4_000);
    const results = await Promise.all(staying);
    expect(results.map((result) => result.elements.length)).toEqual([1, 1]);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Cached through a caller still attached, though the one that started it had left.
    await service.query(QL, caller(store));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('aborts the shared submission when its last caller leaves, and the next identical call submits fresh', async () => {
    answerAfter(5_000);
    const store = new Map<string, unknown>();
    const controllers = [new AbortController(), new AbortController()];
    const pending = controllers.map((controller) =>
      service.query(QL, caller(store, { signal: controller.signal })).catch((e: unknown) => e),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const upstream = mockFetch.mock.calls[0]?.[1]?.signal;

    controllers[0]?.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(upstream?.aborted).toBe(false);
    controllers[1]?.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(upstream?.aborted).toBe(true);

    const errs = (await Promise.all(pending)) as McpError[];
    expect(errs.map((err) => err.code)).toEqual([
      JsonRpcErrorCode.RequestCancelled,
      JsonRpcErrorCode.RequestCancelled,
    ]);
    // The last one out ends exactly as a lone caller cancelled mid-request always has.
    expect(errs[1]?.data).toMatchObject({ errorSource: 'OverpassAborted' });
    expect(errs[1]?.message).toBe('Overpass query was aborted by the caller.');

    const fresh = service.query(QL, caller(store));
    await vi.advanceTimersByTimeAsync(5_000);
    await fresh;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  /** The aborted upstream takes 2 s to let go; a call arriving inside that never joins it. */
  it('starts a fresh submission for a call arriving while the abandoned one is still unwinding', async () => {
    mockFetch.mockImplementation(
      (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({ version: 0.6, elements: [{ type: 'node', id: 1 }] }),
                  { status: 200 },
                ),
              ),
            5_000,
          );
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              setTimeout(() => reject(init.signal?.reason), 2_000);
            },
            { once: true },
          );
        }),
    );
    const store = new Map<string, unknown>();
    const leaving = new AbortController();
    const abandoned = service
      .query(QL, caller(store, { signal: leaving.signal }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);

    leaving.abort();
    const arriving = service.query(QL, caller(store));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(((await abandoned) as McpError).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect((await arriving).elements).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
  });

  it.each([
    [
      'an HTTP 400',
      () => new Response('bad query', { status: 400 }),
      JsonRpcErrorCode.InvalidParams,
    ],
    [
      'a query_timeout remark',
      () => remarkResponse('runtime error: Query timed out in "query" at line 1 after 25 seconds.'),
      JsonRpcErrorCode.Timeout,
    ],
  ])(
    'settles every caller on %s from one submission, and caches nothing',
    async (_name, answer, code) => {
      mockFetch.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return answer();
      });
      const store = new Map<string, unknown>();
      const pending = [0, 1, 2].map(() =>
        service.query(QL, caller(store)).catch((e: unknown) => e),
      );
      await vi.advanceTimersByTimeAsync(3_000);
      const errs = (await Promise.all(pending)) as McpError[];

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(errs[0]?.code).toBe(code);
      expect(errs[1]).toBe(errs[0]);
      expect(errs[2]).toBe(errs[0]);

      const again = service.query(QL, caller(store)).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      await again;
      expect(mockFetch).toHaveBeenCalledTimes(2);
    },
  );

  it('settles every caller on a pacer_shed of the shared submission, retryAfter included', async () => {
    configState.overpassMaxConcurrency = 1;
    mockFetch.mockImplementation((_input, init) => hangUntilAborted(init));
    const store = new Map<string, unknown>();
    const holder = service.query('[out:json];node(0);out;', caller(store)).catch((e: unknown) => e);
    const pending = [0, 1, 2].map(() => service.query(QL, caller(store)).catch((e: unknown) => e));
    await vi.advanceTimersByTimeAsync(31_000);
    const errs = (await Promise.all(pending)) as McpError[];

    expect(errs[0]?.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(errs[0]?.data).toMatchObject({ reason: 'pacer_shed', shedKind: 'wait_elapsed' });
    expect(errs[0]?.data?.retryAfter).toBeGreaterThanOrEqual(30);
    expect(errs[1]).toBe(errs[0]);
    expect(errs[2]).toBe(errs[0]);
    expect(submittedNodeIds()).toEqual([0]);

    await vi.advanceTimersByTimeAsync(600_000);
    await holder;
  });

  /** The late caller's own budget would run to 180 s; the shared one ends at 90 s. */
  it('ends a caller that joins late with the shared submission, inside its own budget', async () => {
    mockFetch.mockImplementation((_input, init) => hangUntilAborted(init));
    const store = new Map<string, unknown>();
    const first = service.query(QL, caller(store)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const joinedAt = Date.now();
    let lateSettledAfter: number | undefined;
    const late = service.query(QL, caller(store)).catch((e: unknown) => {
      lateSettledAfter = Date.now() - joinedAt;
      return e;
    });
    await vi.advanceTimersByTimeAsync(600_000);
    const [firstErr, lateErr] = (await Promise.all([first, late])) as McpError[];

    expect(lateErr).toBe(firstErr);
    expect(lateErr?.data).toMatchObject({ reason: 'endpoints_exhausted' });
    expect(lateSettledAfter).toBe(30_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the same query from two tenants on two submissions', async () => {
    answerAfter(1_000);
    const store = new Map<string, unknown>();
    const calls = ['tenant-a', 'tenant-b'].map((tenantId) =>
      service.query(QL, caller(store, { tenantId })),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(calls);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps distinct queries on separate submissions', async () => {
    answerAfter(1_000);
    const store = new Map<string, unknown>();
    const calls = [1, 2].map((id) => service.query(`[out:json];node(${id});out;`, caller(store)));
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(calls);

    expect(submittedNodeIds()).toEqual([1, 2]);
  });

  /**
   * What one in-flight entry holds while it runs: each attached caller's link to the
   * submission lives on a signal derived from the caller's, so a signal an agent session
   * reuses across many calls carries no listener for any of them — and once the
   * submission settles, its entry is gone and the next identical call starts afresh.
   */
  it('holds no listener on a reused caller signal, and drops its entry once settled', async () => {
    mockFetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return new Response('bad query', { status: 400 });
    });
    const store = new Map<string, unknown>();
    const session = new AbortController();
    const pending = [0, 1, 2].map(() =>
      service.query(QL, caller(store, { signal: session.signal })).catch((e: unknown) => e),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(getEventListeners(session.signal, 'abort')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all(pending);
    expect(getEventListeners(session.signal, 'abort')).toHaveLength(0);

    const again = service.query(QL, caller(store, { signal: session.signal })).catch(() => 0);
    await vi.advanceTimersByTimeAsync(1_000);
    await again;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  /** A caller whose `ctx.state` operations are replaced, its own signal still honored. */
  function withState(ctx: Context, state: Partial<Context['state']>): Context {
    return { ...ctx, state: { ...ctx.state, ...state } as Context['state'] };
  }

  /**
   * A cancel landing while the cache read is in flight: the read still resolves a miss,
   * and everything from the line to `fetch` runs synchronously behind it, so a check made
   * only once the caller is attached comes after the request has gone out.
   */
  it('starts no submission for a caller cancelled during its cache read', async () => {
    answerAfter(1_000);
    const controller = new AbortController();
    const ctx = withState(caller(new Map(), { signal: controller.signal }), {
      get: async () => {
        controller.abort();
        return null;
      },
    });
    const err = await service.query(QL, ctx).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect((err as McpError).data).toMatchObject({ errorSource: 'OverpassSlotAborted' });
    expect((err as McpError).message).toBe('Overpass query was aborted before it was submitted.');
  });

  /** The callers hold a result; a store that cannot keep it costs only the cache. */
  it('serves every waiter when the cache write fails, warning through the writer', async () => {
    answerAfter(1_000);
    const store = new Map<string, unknown>();
    const writer = withState(caller(store), {
      set: async () => {
        throw new Error('storage unavailable');
      },
    });
    const pending = [service.query(QL, writer), service.query(QL, caller(store))];
    await vi.advanceTimersByTimeAsync(1_000);
    const results = await Promise.all(pending);

    expect(results.map((result) => result.elements.length)).toEqual([1, 1]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const warnings = (writer.log as MockContextLogger).calls.filter((c) => c.level === 'warning');
    expect(warnings).toEqual([
      {
        level: 'warning',
        msg: 'Overpass result served but not cached: the cache write failed',
        data: { error: 'storage unavailable' },
      },
    ]);

    // Nothing was cached, so the next identical call submits afresh.
    const again = service.query(QL, caller(store));
    await vi.advanceTimersByTimeAsync(1_000);
    await again;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  /**
   * Characterization: a lone caller that leaves during the write has nobody to hand the
   * result to, and is not handed it as a success either.
   */
  it('still fails a lone caller cancelled during the cache write', async () => {
    answerAfter(1_000);
    const controller = new AbortController();
    const ctx = withState(caller(new Map(), { signal: controller.signal }), {
      set: async () => {
        controller.abort();
        controller.signal.throwIfAborted();
      },
    });
    const pending = service.query(QL, ctx).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toBe(controller.signal.reason);
  });
});

/**
 * Regression for #67: a connection-level failure carried no reason and no status,
 * so it faulted nothing — rotation came straight back to a host that had already
 * refused, on every remaining attempt, until the whole budget was gone. The
 * per-attempt deadline had the same gap: Bun's `fetch` cannot tell a handshake
 * that never completed from a query accepted and held, and both reach the caller
 * without a declared reason.
 *
 * These drive the three shapes the runtime actually produces. A refusal and a DNS
 * failure reject as a plain `TypeError` carrying a `code`; a socket that accepts
 * and never answers rejects only when the deadline aborts it.
 */
describe('OverpassService endpoint faults (#67)', () => {
  const MIRROR = 'https://overpass.mirror.example/api/interpreter';
  const MIRROR_ORIGIN = 'https://overpass.mirror.example';
  const THIRD = 'https://overpass.third.example/api/interpreter';
  const THIRD_ORIGIN = 'https://overpass.third.example';
  const QL = '[out:json];node(1);out;';

  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = undefined;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
  });

  function submittedTo(): string[] {
    return mockFetch.mock.calls.map(([input]) => String(input));
  }

  function okResponse(): Response {
    return new Response(JSON.stringify({ version: 0.6, elements: [] }), { status: 200 });
  }

  /**
   * Bun rejects every connection-level failure with a plain `TypeError` carrying
   * a `code` — `ConnectionRefused` for a refusal (and for a SYN blackhole the OS
   * gives up on), `ENOTFOUND` for an NXDOMAIN.
   */
  function connectionFailure(code: string): TypeError {
    return Object.assign(
      new TypeError('Unable to connect. Is the computer able to access the url?'),
      { code },
    );
  }

  /** What each endpoint does to a submission, keyed by URL. `ok` is the default. */
  type Behavior = 'ok' | 'refused' | 'dns' | 'blackhole' | 'throttled' | 'shedding';

  function serveWith(behaviors: Record<string, Behavior>): void {
    mockFetch.mockImplementation((input, init) => {
      switch (behaviors[String(input)] ?? 'ok') {
        case 'refused':
          return Promise.reject(connectionFailure('ConnectionRefused'));
        case 'dns':
          return Promise.reject(connectionFailure('ENOTFOUND'));
        case 'blackhole':
          // Accepts and never answers — only the client deadline ends it.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          });
        case 'throttled':
          return Promise.resolve(new Response('slow down', { status: 429 }));
        case 'shedding':
          return Promise.resolve(new Response('overloaded', { status: 503 }));
        default:
          return Promise.resolve(okResponse());
      }
    });
  }

  /** Runs a query expected to fail, driving backoff and deadlines on the fake clock. */
  async function runError(advanceMs = 600_000): Promise<McpError> {
    const pending = service
      .query(QL, createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(advanceMs);
    const err = await pending;
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }

  describe('a connection-level failure faults the endpoint', () => {
    /**
     * The reported defect, at its cheapest: the primary is throttled and written
     * off, the mirror refuses the connection, and rotation used to come back to
     * the mirror for every remaining attempt. One submission each is the fix.
     */
    it('does not return to a host that refused the connection', async () => {
      serveWith({ [DEFAULT_ENDPOINT]: 'throttled', [MIRROR]: 'refused' });
      await runError();

      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    });

    it('does not return to a host whose DNS lookup failed', async () => {
      serveWith({ [DEFAULT_ENDPOINT]: 'throttled', [MIRROR]: 'dns' });
      await runError();

      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    });

    /**
     * The path the `errorSource: 'OverpassNetworkError'` discriminator alone
     * misses: where the OS connect timeout outlives the per-attempt deadline, the
     * same blackhole surfaces as a client timeout and never reaches the network
     * branch at all. Both must fault, or the fix is a no-op on that platform.
     */
    it('does not return to a host that accepted the query and never answered', async () => {
      serveWith({ [DEFAULT_ENDPOINT]: 'throttled', [MIRROR]: 'blackhole' });
      await runError();

      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    });

    /**
     * The clamped re-ask this drops: the dead host used to absorb a second
     * submission bounded by whatever the budget had left — at most 30s under the
     * shipped derivation, which cannot succeed where a full 90s window did not.
     */
    it('costs a hung host one attempt window and no clamped re-ask', async () => {
      serveWith({ [DEFAULT_ENDPOINT]: 'blackhole', [MIRROR]: 'blackhole' });
      await runError();

      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    });

    /** A single endpoint has nowhere to rotate to, so its refusal ends the call. */
    it('submits once to a single configured endpoint that refuses', async () => {
      configState.overpassEndpoints = [DEFAULT_ENDPOINT];
      serveWith({ [DEFAULT_ENDPOINT]: 'refused' });
      const err = await runError();

      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT]);
      expect(err.data).toMatchObject({ reason: 'endpoints_unavailable' });
    });

    /**
     * An operator who pinned one endpoint did not ask for their queries to be
     * sent anywhere else, so the pin still disables rotation — and a pinned host
     * that refuses is written off exactly like a single listed one.
     */
    it('keeps OSM_OVERPASS_BASE_URL pinned to its one endpoint when that host refuses', async () => {
      const pinned = 'https://overpass.private.example/api/interpreter';
      configState.overpassBaseUrl = pinned;
      serveWith({ [pinned]: 'refused' });
      await runError();

      expect(submittedTo()).toEqual([pinned]);
    });

    /**
     * The narrowing that keeps #49's rule intact: a 5xx is the endpoint shedding
     * load, not refusing the call, so it must stay re-tryable. Faulting it would
     * end a call after two submissions that an existing retry answers.
     */
    it('keeps an HTTP 5xx a load-shed rather than a fault', async () => {
      serveWith({ [DEFAULT_ENDPOINT]: 'shedding', [MIRROR]: 'shedding' });
      const err = await runError();

      expect(submittedTo().length).toBeGreaterThan(2);
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).not.toHaveProperty('reason');
    });

    /** The call stops rather than spending its remaining budget on written-off hosts. */
    it('stops submitting once every endpoint has faulted, without waiting out the budget', async () => {
      configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR, THIRD];
      serveWith({ [DEFAULT_ENDPOINT]: 'refused', [MIRROR]: 'refused', [THIRD]: 'refused' });

      let settled = false;
      const pending = service
        .query(QL, createMockContext({ tenantId: 'test' }))
        .catch((e: unknown) => {
          settled = true;
          return e;
        });

      // Three instant refusals plus two backoffs — well inside the 120s budget.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(true);
      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR, THIRD]);
      await pending;
    });
  });

  describe('the terminal error is composed from the faults the call recorded', () => {
    /**
     * The surfaced error used to be whichever attempt happened to fail last —
     * `withRetry` rethrows the raw error when the predicate turns it down — so a
     * call throttled on one host and refused by another reported only the
     * refusal, or ran on until the budget guard blamed the query's size.
     */
    it('names every endpoint and what it did when the faults are mixed', async () => {
      serveWith({ [DEFAULT_ENDPOINT]: 'throttled', [MIRROR]: 'refused' });
      const err = await runError();

      expect(err.data).toMatchObject({ reason: 'endpoints_unavailable' });
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toContain(`${DEFAULT_ORIGIN}: HTTP 429`);
      expect(err.message).toContain(`${MIRROR_ORIGIN}: connection refused`);
      // #91: endpoints are named by origin alone, never by path.
      expect(err.message).not.toContain('/api/interpreter');
      // No hint at the throw site: a hint set here would win over the calling tool's
      // declared one, which the framework fills from this reason at the handler boundary.
      expect(err.data?.recovery).toBeUndefined();
    });

    it('names the DNS failure distinctly from a refusal', async () => {
      serveWith({ [DEFAULT_ENDPOINT]: 'dns', [MIRROR]: 'refused' });
      const err = await runError();

      expect(err.data).toMatchObject({ reason: 'endpoints_unavailable' });
      expect(err.message).toContain(`${DEFAULT_ORIGIN}: DNS lookup failed`);
      expect(err.message).toContain(`${MIRROR_ORIGIN}: connection refused`);
    });

    /**
     * #91: two keyed entries on one provider share an origin, so origin alone would
     * name them identically. The list position tells them apart without the key, and
     * a third entry on its own origin stays undecorated. The submissions still carry
     * each full configured URL.
     */
    it('tells two keyed entries on one origin apart by list position', async () => {
      const keyedA = 'https://overpass.keyed.example/sk-FAKEKEY-A/api/interpreter';
      const keyedB = 'https://overpass.keyed.example/sk-FAKEKEY-B/api/interpreter';
      configState.overpassEndpoints = [keyedA, keyedB, THIRD];
      serveWith({ [keyedA]: 'throttled', [keyedB]: 'dns', [THIRD]: 'refused' });
      const err = await runError();

      expect(err.data).toMatchObject({ reason: 'endpoints_unavailable' });
      expect(err.message).toBe(
        `No Overpass endpoint could serve this query — https://overpass.keyed.example (entry 1): HTTP 429; https://overpass.keyed.example (entry 2): DNS lookup failed; ${THIRD_ORIGIN}: connection refused.`,
      );
      expect(JSON.stringify(err.data)).not.toContain('FAKEKEY');
      expect(submittedTo()).toEqual([keyedA, keyedB, THIRD]);
    });

    /**
     * `endpoints_exhausted`'s meaning is re-decided here from "the total budget
     * ran out" to "every endpoint tried was still unanswered" — the case its
     * shrink-the-query hint was always right for, now reached by the faults
     * themselves rather than only by the budget guard.
     */
    it('surfaces endpoints_exhausted when every endpoint went unanswered', async () => {
      serveWith({ [DEFAULT_ENDPOINT]: 'blackhole', [MIRROR]: 'blackhole' });
      const err = await runError();

      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data).toMatchObject({
        reason: 'endpoints_exhausted',
        errorSource: 'OverpassEndpointsUnanswered',
      });
      expect(err.message).toContain(`${DEFAULT_ORIGIN}: no answer`);
      expect(err.message).toContain(`${MIRROR_ORIGIN}: no answer`);
      expect(err.data?.recovery).toBeUndefined();
    });

    /**
     * The throttle contract #41 and #49 established, unchanged: a call refused by
     * every endpoint still surfaces the throttle itself, not a composed error
     * under a different reason.
     */
    it('leaves an all-throttled call surfacing the throttle exactly as before', async () => {
      serveWith({ [DEFAULT_ENDPOINT]: 'throttled', [MIRROR]: 'throttled' });
      const err = await runError();

      expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(err.data).not.toMatchObject({ reason: 'endpoints_unavailable' });
      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    });

    const DISPATCHER_OFF =
      'runtime error: open64: 2 No such file or directory /osm3s_v0.7.62_osm_base Dispatcher_Client::1. The dispatcher (i.e. the database management system) is turned off.';

    /**
     * A dispatcher fault already ends a call on a true reason whose hint tells
     * the caller to read the remark, so composition leaves it alone — replacing
     * it with a per-endpoint summary would drop the one line naming the fault.
     * Composition exists for the shapes that arrive with no reason at all.
     */
    it('leaves a dispatcher fault on every endpoint surfacing its verbatim remark', async () => {
      mockFetch.mockImplementation(async () => remarkResponse(DISPATCHER_OFF));
      const err = await runError();

      expect(err.data).toMatchObject({ reason: 'upstream_error' });
      expect(err.message).toContain('the database management system) is turned off');
      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    });

    /**
     * Mixed with a host that could not be reached at all, the call is no longer
     * about one instance's remark — it is about no endpoint being able to serve,
     * which is what the composed reason says and the summary itemizes.
     */
    it('composes a dispatcher fault mixed with a refusal as unavailable', async () => {
      mockFetch.mockImplementation(async (input) => {
        if (String(input) === MIRROR) throw connectionFailure('ConnectionRefused');
        return remarkResponse(DISPATCHER_OFF);
      });
      const err = await runError();

      expect(err.data).toMatchObject({ reason: 'endpoints_unavailable' });
      expect(err.message).toContain(`${DEFAULT_ORIGIN}: instance fault`);
      expect(err.message).toContain(`${MIRROR_ORIGIN}: connection refused`);
    });

    /**
     * The budget guard keeps its own job: a call with more endpoints than the
     * budget can visit still ends on it, since the faulted set never fills.
     */
    it('still ends on the total-budget guard when the budget runs out first', async () => {
      configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR, THIRD];
      serveWith({ [DEFAULT_ENDPOINT]: 'blackhole', [MIRROR]: 'blackhole', [THIRD]: 'blackhole' });
      const err = await runError();

      // Two attempt windows fill the 120s budget, so the third endpoint is never
      // submitted to.
      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
      expect(err.data).toMatchObject({
        reason: 'endpoints_exhausted',
        errorSource: 'OverpassTotalTimeout',
      });
    });
  });

  describe('rotation past the first level', () => {
    /** A throttle, then a refusal, then a host that answers. */
    it('reaches a third endpoint after a throttle and a refusal', async () => {
      configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR, THIRD];
      serveWith({ [DEFAULT_ENDPOINT]: 'throttled', [MIRROR]: 'refused', [THIRD]: 'ok' });

      const pending = service.query(QL, createMockContext({ tenantId: 'test' }));
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;

      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR, THIRD]);
      expect(result.servedBy).toBe(THIRD_ORIGIN);
    });

    /** A deadline, then a refusal, then a host that answers. */
    it('reaches a third endpoint after an unanswered attempt and a refusal', async () => {
      configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR, THIRD];
      serveWith({ [DEFAULT_ENDPOINT]: 'blackhole', [MIRROR]: 'refused', [THIRD]: 'ok' });

      const pending = service.query(QL, createMockContext({ tenantId: 'test' }));
      await vi.advanceTimersByTimeAsync(119_000);
      const result = await pending;

      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR, THIRD]);
      expect(result.servedBy).toBe(THIRD_ORIGIN);
    });

    /**
     * A refusal, a load-shed, then success: the shedding host is not written off,
     * so rotation is free to come back to it — and does, because the refusing one
     * is skipped.
     */
    it('re-tries a load-shedding host after a refusal but never the refusing one', async () => {
      let mirrorCalls = 0;
      mockFetch.mockImplementation(async (input) => {
        if (String(input) === DEFAULT_ENDPOINT) throw connectionFailure('ConnectionRefused');
        mirrorCalls++;
        return mirrorCalls === 1 ? new Response('overloaded', { status: 503 }) : okResponse();
      });

      const pending = service.query(QL, createMockContext({ tenantId: 'test' }));
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;

      const submissions = submittedTo();
      expect(submissions.filter((url) => url === DEFAULT_ENDPOINT)).toHaveLength(1);
      expect(result.servedBy).toBe(MIRROR_ORIGIN);
    });

    /**
     * A deterministic failure still stops on the endpoint that produced it, even
     * once a host has been written off — rotating a malformed query spends a
     * second endpoint's slot on a request no instance can answer.
     */
    it('does not rotate an HTTP 400 onto a live endpoint after a refusal', async () => {
      configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR, THIRD];
      mockFetch.mockImplementation(async (input) => {
        if (String(input) === DEFAULT_ENDPOINT) throw connectionFailure('ConnectionRefused');
        return new Response('bad query', { status: 400 });
      });
      const err = await runError();

      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    });

    /** No backoff timer is left parked once the call settles on a full fault set. */
    it('leaves no backoff parked after the faulted set fills', async () => {
      serveWith({ [DEFAULT_ENDPOINT]: 'refused', [MIRROR]: 'refused' });
      await runError();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

/**
 * #81: endpoint faults lived in a map scoped to one call, so a mirror that never completed
 * a connection cost every call that reached it a full connect timeout or attempt window. A
 * connection-level fault, or silence through a full attempt window the budget did not clamp,
 * is now remembered per configured entry across calls: the entry cools down for 30 s,
 * doubling per consecutive remembered fault up to 10 min, and any HTTP response clears it.
 * Throttles, 5xx, status refusals, and instance faults stay call-scoped.
 */
describe('OverpassService cross-call host memory (#81)', () => {
  const MIRROR = 'https://overpass.mirror.example/api/interpreter';
  const MIRROR_ORIGIN = 'https://overpass.mirror.example';
  const THIRD = 'https://overpass.third.example/api/interpreter';
  const THIRD_ORIGIN = 'https://overpass.third.example';

  /**
   * OSM3S refusing a query text it already holds three unexpired copies of — a fact about
   * the query's recent traffic on that instance, not about the host.
   */
  const DUPLICATE_QUERY_DOCUMENT = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<html><body>',
    '<p><strong style="color:#FF0000">Error</strong>: runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::duplicate_query </p>',
    '</body></html>',
  ].join('\n');

  /** What a host does to a submission right now; `ok` unless a test says otherwise. */
  type Behavior =
    | 'ok'
    | 'refused'
    | 'dns'
    | 'silent'
    | 'throttled'
    | 'shedding'
    | 'gateway'
    | 'unauthorized'
    | 'forbidden'
    | 'missing'
    | 'duplicate';

  const hosts = new Map<string, Behavior>();
  let service: OverpassService;
  let queries = 0;

  function respond(behavior: Behavior, init: RequestInit | undefined): Promise<Response> {
    const status = (code: number) => Promise.resolve(new Response('refused', { status: code }));
    switch (behavior) {
      case 'refused':
        return Promise.reject(connectionRefused());
      case 'dns':
        return Promise.reject(
          Object.assign(new TypeError('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
        );
      case 'silent':
        return hangUntilAborted(init);
      case 'throttled':
        return status(429);
      case 'shedding':
        return status(503);
      case 'gateway':
        return status(504);
      case 'unauthorized':
        return status(401);
      case 'forbidden':
        return status(403);
      case 'missing':
        return status(404);
      case 'duplicate':
        return Promise.resolve(new Response(DUPLICATE_QUERY_DOCUMENT, { status: 200 }));
      default:
        return Promise.resolve(emptyResponse());
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    hosts.clear();
    mockFetch.mockReset();
    mockFetch.mockImplementation((input, init) => respond(hosts.get(String(input)) ?? 'ok', init));
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = undefined;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
  });

  function submittedTo(): string[] {
    return mockFetch.mock.calls.map(([input]) => String(input));
  }

  /** Starts one call on a fresh query text, so no call is served from a cache another filled. */
  function start(): Promise<unknown> {
    queries++;
    return service
      .query(`[out:json];node(${queries});out;`, createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
  }

  /**
   * Runs the fake clock exactly as far as `pending` needs and no further, so a cooldown a
   * call leaves behind is still running when the next call starts.
   */
  async function settle<T>(pending: Promise<T>): Promise<T> {
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    while (!done) {
      if (vi.getTimerCount() === 0) throw new Error('the call is waiting on no timer');
      await vi.advanceTimersToNextTimerAsync();
    }
    return pending;
  }

  /** One call run to completion: what it settled with, and the hosts it submitted to. */
  async function call(): Promise<{ asked: string[]; outcome: unknown }> {
    const before = mockFetch.mock.calls.length;
    const outcome = await settle(start());
    return { asked: submittedTo().slice(before), outcome };
  }

  it('skips a host silent through a full window on the next call, naming it (cooling down)', async () => {
    hosts.set(DEFAULT_ENDPOINT, 'throttled');
    hosts.set(MIRROR, 'silent');
    const first = await call();
    expect(first.asked).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    expect((first.outcome as McpError).message).toContain(
      `${MIRROR_ORIGIN}: no answer inside its 90000ms attempt window.`,
    );

    const startedAt = Date.now();
    const second = await call();
    const err = second.outcome as McpError;

    expect(second.asked).toEqual([DEFAULT_ENDPOINT]);
    expect(Date.now() - startedAt).toBe(0);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'endpoints_unavailable' });
    expect(err.message).toBe(
      `No Overpass endpoint could serve this query — ${DEFAULT_ORIGIN}: HTTP 429; ${MIRROR_ORIGIN}: no answer inside its 90000ms attempt window (cooling down).`,
    );
  });

  it.each(['refused', 'dns'] as const)(
    'skips a host whose connection failed (%s) on the next call',
    async (failure) => {
      hosts.set(DEFAULT_ENDPOINT, 'throttled');
      hosts.set(MIRROR, failure);
      expect((await call()).asked).toEqual([DEFAULT_ENDPOINT, MIRROR]);

      const second = await call();
      expect(second.asked).toEqual([DEFAULT_ENDPOINT]);
      expect((second.outcome as McpError).message).toContain(`${MIRROR_ORIGIN}: `);
      expect((second.outcome as McpError).message).toContain('(cooling down).');
    },
  );

  /** The first entry is the costliest place for a dead host: every call starts there. */
  it('sends the next call straight to the mirror while a refusing first entry cools', async () => {
    hosts.set(DEFAULT_ENDPOINT, 'refused');
    expect((await call()).asked).toEqual([DEFAULT_ENDPOINT, MIRROR]);

    const second = await call();
    expect(second.asked).toEqual([MIRROR]);
    expect((second.outcome as { servedBy: string }).servedBy).toBe(MIRROR_ORIGIN);
  });

  it('counts a cooling host as already faulted inside a call', async () => {
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR, THIRD];
    hosts.set(DEFAULT_ENDPOINT, 'throttled');
    hosts.set(MIRROR, 'refused');
    expect((await call()).asked).toEqual([DEFAULT_ENDPOINT, MIRROR, THIRD]);

    hosts.set(THIRD, 'refused');
    const startedAt = Date.now();
    const second = await call();

    // Every entry is faulted or cooling, so the call ends — no backoff, no return to any.
    expect(second.asked).toEqual([DEFAULT_ENDPOINT, THIRD]);
    expect(Date.now() - startedAt).toBe(0);
    expect((second.outcome as McpError).message).toBe(
      `No Overpass endpoint could serve this query — ${DEFAULT_ORIGIN}: HTTP 429; ${MIRROR_ORIGIN}: connection refused (cooling down); ${THIRD_ORIGIN}: connection refused.`,
    );
  });

  it('makes exactly one submission, to the least-recently-faulted entry, when every entry is cooling', async () => {
    hosts.set(DEFAULT_ENDPOINT, 'throttled');
    hosts.set(MIRROR, 'refused');
    await call();
    await vi.advanceTimersByTimeAsync(5_000);
    hosts.set(DEFAULT_ENDPOINT, 'refused');
    // The mirror cooled first; the first entry cools now.
    expect((await call()).asked).toEqual([DEFAULT_ENDPOINT]);
    await vi.advanceTimersByTimeAsync(5_000);

    const third = await call();
    const err = third.outcome as McpError;

    expect(third.asked).toEqual([MIRROR]);
    expect(err.data).toMatchObject({ reason: 'endpoints_unavailable' });
    expect(err.message).toBe(
      `No Overpass endpoint could serve this query — ${DEFAULT_ORIGIN}: connection refused (cooling down); ${MIRROR_ORIGIN}: connection refused.`,
    );
  });

  /**
   * 90 s of silence on the first entry leaves the mirror only the 30 s the budget has
   * left. That window says little about the mirror, so only the first entry is remembered.
   * The first entry is on its second remembered fault, so its 60 s cooldown outlasts the
   * mirror's 30 s and the next call shows which of the two is cooling.
   */
  it('does not remember an unanswered window the call budget clamped', async () => {
    hosts.set(DEFAULT_ENDPOINT, 'refused');
    await call();
    await vi.advanceTimersByTimeAsync(30_000);
    hosts.set(DEFAULT_ENDPOINT, 'silent');
    hosts.set(MIRROR, 'silent');
    const first = await call();
    expect(first.asked).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    expect((first.outcome as McpError).message).toContain(
      `${MIRROR_ORIGIN}: no answer inside its 30000ms attempt window`,
    );

    hosts.set(MIRROR, 'ok');
    expect((await call()).asked).toEqual([MIRROR]);
  });

  it.each([
    ['200', 'ok'],
    ['429', 'throttled'],
    ['504', 'gateway'],
  ] as const)(
    'forgets a remembered host the moment it answers HTTP %s',
    async (_status, answer) => {
      hosts.set(DEFAULT_ENDPOINT, 'refused');
      await call();
      expect((await call()).asked).toEqual([MIRROR]);

      await vi.advanceTimersByTimeAsync(30_000);
      hosts.set(DEFAULT_ENDPOINT, answer);
      expect((await call()).asked[0]).toBe(DEFAULT_ENDPOINT);

      // Forgotten outright rather than lapsed: two calls arriving together both go to it,
      // where a lapsed host would let only one of them probe.
      hosts.set(DEFAULT_ENDPOINT, 'ok');
      mockFetch.mockClear();
      await settle(Promise.all([start(), start()]));
      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, DEFAULT_ENDPOINT]);
    },
  );

  it.each(['throttled', 'shedding', 'unauthorized', 'forbidden', 'missing', 'duplicate'] as const)(
    'never remembers a host that answered (%s)',
    async (answer) => {
      hosts.set(DEFAULT_ENDPOINT, answer);
      expect((await call()).asked[0]).toBe(DEFAULT_ENDPOINT);

      hosts.set(DEFAULT_ENDPOINT, 'ok');
      expect((await call()).asked).toEqual([DEFAULT_ENDPOINT]);
    },
  );

  it('lets one call probe a lapsed host while calls arriving with it skip it', async () => {
    hosts.set(DEFAULT_ENDPOINT, 'refused');
    await call();
    await vi.advanceTimersByTimeAsync(30_000);
    hosts.set(DEFAULT_ENDPOINT, 'silent');
    mockFetch.mockClear();

    const together = Promise.all([start(), start()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);

    // The probe goes unanswered, is remembered again, and walks on to the mirror.
    await settle(together);
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR, MIRROR]);
  });

  /**
   * The mirror is remembered 5 s before the first entry, so it lapses first while the first
   * entry still cools. The call arriving with the probe finds every entry cooling, and its one
   * submission goes to the entry cooling longest that no probe holds.
   */
  it('keeps a lapsed host to its one probe when every other entry is cooling', async () => {
    hosts.set(DEFAULT_ENDPOINT, 'throttled');
    hosts.set(MIRROR, 'refused');
    await call();
    await vi.advanceTimersByTimeAsync(5_000);
    hosts.set(DEFAULT_ENDPOINT, 'refused');
    await call();
    await vi.advanceTimersByTimeAsync(25_000);
    hosts.set(MIRROR, 'silent');
    mockFetch.mockClear();

    const together = Promise.all([start(), start()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(submittedTo()).toEqual([MIRROR, DEFAULT_ENDPOINT]);
    await settle(together);
  });

  it('lets a probe go free when its call is cancelled, so the next call probes the host', async () => {
    hosts.set(DEFAULT_ENDPOINT, 'refused');
    await call();
    await vi.advanceTimersByTimeAsync(30_000);
    hosts.set(DEFAULT_ENDPOINT, 'silent');
    const leaving = new AbortController();
    queries++;
    const probe = service
      .query(
        `[out:json];node(${queries});out;`,
        createMockContext({ tenantId: 'test', signal: leaving.signal }),
      )
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    leaving.abort();
    expect(((await probe) as McpError).code).toBe(JsonRpcErrorCode.RequestCancelled);

    hosts.set(DEFAULT_ENDPOINT, 'ok');
    expect((await call()).asked).toEqual([DEFAULT_ENDPOINT]);
  });

  /** A pinned endpoint is its own fallback, so calls arriving with its probe submit too. */
  it('keeps every call to a pinned endpoint submitting while its probe is in flight', async () => {
    const pinned = 'https://overpass.private.example/api/interpreter';
    configState.overpassBaseUrl = pinned;
    hosts.set(pinned, 'refused');
    await call();
    await vi.advanceTimersByTimeAsync(30_000);
    hosts.set(pinned, 'silent');
    mockFetch.mockClear();

    const together = Promise.all([start(), start()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(submittedTo()).toEqual([pinned, pinned]);
    await settle(together);
  });

  it('doubles the cooldown per consecutive remembered fault up to 10 min, and resets once the host answers', async () => {
    hosts.set(DEFAULT_ENDPOINT, 'refused');
    await call();
    for (const cooldownMs of [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
      await vi.advanceTimersByTimeAsync(cooldownMs - 1);
      expect((await call()).asked).toEqual([MIRROR]);
      await vi.advanceTimersByTimeAsync(1);
      expect((await call()).asked).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    }

    await vi.advanceTimersByTimeAsync(600_000);
    hosts.set(DEFAULT_ENDPOINT, 'ok');
    expect((await call()).asked).toEqual([DEFAULT_ENDPOINT]);
    hosts.set(DEFAULT_ENDPOINT, 'refused');
    expect((await call()).asked).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect((await call()).asked).toEqual([MIRROR]);
    await vi.advanceTimersByTimeAsync(1);
    expect((await call()).asked).toEqual([DEFAULT_ENDPOINT, MIRROR]);
  });

  /** One endpoint is always its own fallback, so a pinned host's calls are unchanged. */
  it('keeps a pinned endpoint submitting once per call, its error unchanged', async () => {
    const pinned = 'https://overpass.private.example/api/interpreter';
    configState.overpassBaseUrl = pinned;
    hosts.set(pinned, 'refused');
    const first = await call();
    const second = await call();

    expect(first.asked).toEqual([pinned]);
    expect(second.asked).toEqual([pinned]);
    expect((second.outcome as McpError).data).toMatchObject({ reason: 'endpoints_unavailable' });
    expect((second.outcome as McpError).message).toBe((first.outcome as McpError).message);
  });

  /**
   * Bun rejects an instant refusal and an OS connect timeout alike as `ConnectionRefused`;
   * only the time it took tells them apart. Node puts the system code one `cause` deeper
   * than Bun does.
   */
  describe('connection-failure labels', () => {
    beforeEach(() => {
      configState.overpassEndpoints = [MIRROR];
    });

    /** The label a single endpoint's composed error gives a failure arriving after `afterMs`. */
    async function labelFor(failure: () => unknown, afterMs: number): Promise<string> {
      mockFetch.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, afterMs));
        throw failure();
      });
      const err = (await settle(start())) as McpError;
      const prefix = `No Overpass endpoint could serve this query — ${MIRROR_ORIGIN}: `;
      expect(err.message.startsWith(prefix)).toBe(true);
      return err.message.slice(prefix.length, -1);
    }

    /** A Node fetch failure: `TypeError('fetch failed')` carrying the system error as its cause. */
    function nodeFailure(code: string): TypeError {
      return new TypeError('fetch failed', {
        cause: Object.assign(new Error(`connect ${code}`), { code }),
      });
    }

    it('reads a refusal inside 10 s as connection refused', async () => {
      expect(await labelFor(connectionRefused, 0)).toBe('connection refused');
      expect(await labelFor(connectionRefused, 9_999)).toBe('connection refused');
    });

    it('reads a ConnectionRefused at 10 s or more as no connection within the time it took', async () => {
      expect(await labelFor(connectionRefused, 10_000)).toBe('no connection within 10000ms');
      expect(await labelFor(connectionRefused, 75_000)).toBe('no connection within 75000ms');
    });

    it("reads Node's system code one cause deeper, with the labels Bun gets", async () => {
      expect(await labelFor(() => nodeFailure('ECONNREFUSED'), 0)).toBe('connection refused');
      expect(await labelFor(() => nodeFailure('ENOTFOUND'), 0)).toBe('DNS lookup failed');
      expect(await labelFor(() => nodeFailure('UND_ERR_CONNECT_TIMEOUT'), 10_000)).toBe(
        'no connection within 10000ms',
      );
    });

    /** `cause` is whatever the runtime put there; the walk ends even when the chain loops back. */
    it('reads a cause chain that loops back on itself as unreachable', async () => {
      const looped = () => {
        const outer = new TypeError('fetch failed');
        outer.cause = new Error('socket closed', { cause: outer });
        return outer;
      };
      expect(await labelFor(looped, 0)).toBe('unreachable');
    });
  });
});

/** An Overpass 200 response with an empty element list. */
function emptyResponse(): Response {
  return new Response(JSON.stringify({ version: 0.6, elements: [] }), { status: 200 });
}

/** A fetch that never settles on its own — it rejects with the abort reason, as the real one does. */
function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
}

/** The node id each submission's QL asked for, in submission order. */
function submittedNodeIds(): number[] {
  return mockFetch.mock.calls.map(([, init]) =>
    Number(/node\((\d+)\)/.exec(decodeURIComponent(String(init?.body)))?.[1]),
  );
}

/**
 * The slot gate's ordering and handoff: FIFO among waiters, and a slot freed while a
 * waiter cancels reaches a live waiter rather than the one that left.
 */
describe('OverpassService slot gate order and handoff', () => {
  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 1;
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassMaxConcurrency = 2;
  });

  /** Holds each submission for `ms`, tracking peak concurrency. */
  function holdEach(ms: number): { peak: () => number } {
    let active = 0;
    let peak = 0;
    mockFetch.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, ms));
      active--;
      return emptyResponse();
    });
    return { peak: () => peak };
  }

  it('grants queued callers their slots in arrival order', async () => {
    const { peak } = holdEach(1_000);
    const ctx = createMockContext({ tenantId: 'test' });
    const calls = [0, 1, 2, 3, 4].map((i) => service.query(`[out:json];node(${i});out;`, ctx));

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(calls);

    expect(submittedNodeIds()).toEqual([0, 1, 2, 3, 4]);
    expect(peak()).toBe(1);
  });

  /**
   * The waiter next in line is the one a release would hand the slot to, so cancelling
   * it is where a leaked slot would show: the release must skip to the caller behind it.
   */
  it('hands the slot past a cancelled head-of-line waiter to the live one behind it', async () => {
    const { peak } = holdEach(1_000);
    const headOfLine = new AbortController();
    const holder = service.query('[out:json];node(0);out;', createMockContext({ tenantId: 't' }));
    const cancelled = service
      .query(
        '[out:json];node(1);out;',
        createMockContext({ tenantId: 't', signal: headOfLine.signal }),
      )
      .catch((e: unknown) => e);
    const behind = service.query('[out:json];node(2);out;', createMockContext({ tenantId: 't' }));

    await vi.advanceTimersByTimeAsync(500);
    headOfLine.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([holder, behind]);

    const err = (await cancelled) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(err.data).toMatchObject({ errorSource: 'OverpassSlotAborted' });
    expect(err.message).toBe('Overpass query was aborted while waiting for an endpoint slot.');
    expect(submittedNodeIds()).toEqual([0, 2]);
    expect(peak()).toBe(1);
  });

  /**
   * A caller signal can outlive one query — an agent session reuses it — so queueing on
   * it must not leave a listener behind per query it waited in. The slot line waits on
   * withRetry's per-call signal, which `AbortSignal.any` links to the caller's without an
   * event listener, so the caller's signal carries none even while queries are parked.
   */
  it('leaves no abort listener on a reused caller signal once its queued queries settle', async () => {
    holdEach(1_000);
    const controller = new AbortController();
    const ctx = createMockContext({ tenantId: 'test', signal: controller.signal });

    const inFlight = Promise.all(
      [0, 1, 2].map((i) => service.query(`[out:json];node(${i});out;`, ctx)),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await inFlight;

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  /** Shutdown: a caller still waiting for a slot is rejected, never submitted. */
  it('rejects callers still waiting for a slot on dispose, leaving the holder to finish', async () => {
    holdEach(1_000);
    const ctx = createMockContext({ tenantId: 'test' });
    const holder = service.query('[out:json];node(0);out;', ctx);
    const waiting = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(0);
    service.dispose();
    const err = (await waiting) as McpError;
    await vi.advanceTimersByTimeAsync(1_000);
    await holder;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(submittedNodeIds()).toEqual([0]);
  });
});

/**
 * The whole-call budget's caller-visible shape when it runs out before the fault set
 * fills: a `Timeout` with reason `endpoints_exhausted`, `retryable: false`, and a
 * message naming the budget — the tools forward all three.
 */
describe('OverpassService call budget exhaustion', () => {
  const MIRROR = 'https://overpass.mirror.example/api/interpreter';
  const THIRD = 'https://overpass.third.example/api/interpreter';

  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = undefined;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR, THIRD];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
  });

  function submittedTo(): string[] {
    return mockFetch.mock.calls.map(([input]) => String(input));
  }

  async function runError(ql: string, advanceMs = 600_000): Promise<McpError> {
    const pending = service
      .query(ql, createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(advanceMs);
    const err = await pending;
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }

  function expectBudgetSpent(err: McpError, totalMs: number): void {
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toEqual({
      reason: 'endpoints_exhausted',
      retryable: false,
      errorSource: 'OverpassTotalTimeout',
    });
    expect(err.message).toBe(
      `Overpass did not answer within the ${totalMs}ms budget for this call.`,
    );
  }

  it('reports the spent flat budget with its exact code, data, and message', async () => {
    mockFetch.mockImplementation((_input, init) => hangUntilAborted(init));
    const err = await runError('[out:json];node(1);out;');

    expectBudgetSpent(err, 120_000);
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
  });

  it('reports a budget widened by [timeout:N] in the same shape', async () => {
    mockFetch.mockImplementation((_input, init) => hangUntilAborted(init));
    const err = await runError('[out:json][timeout:180];node(1);out;');

    expectBudgetSpent(err, 240_000);
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
  });

  /**
   * Past the first level of the ladder: a host that never answers, one that sheds load,
   * then a third given only what the budget has left — the budget runs out on that third
   * attempt with two of three hosts faulted.
   */
  it('runs out mid-ladder after an unanswered host and a load-shed', async () => {
    mockFetch.mockImplementation((input, init) => {
      if (String(input) === MIRROR) return Promise.resolve(new Response('busy', { status: 503 }));
      return hangUntilAborted(init);
    });
    const err = await runError('[out:json];node(1);out;');

    expectBudgetSpent(err, 120_000);
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR, THIRD]);
  });

  /**
   * A slot wait counts against the budget as well as the 30 s wait allowance, and the
   * budget can run out first once the call has spent it on submissions. Here A and the
   * mirror each shed load (100 s of the 120 s), the backoff returns the call to A, A is
   * held by a long query, and the call ends on its budget at the 120 s mark — never
   * submitted to A a second time.
   */
  it('ends a caller still waiting for a slot when its budget runs out, without submitting it', async () => {
    configState.overpassMaxConcurrency = 1;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, { url: MIRROR, maxConcurrent: 1 }];
    mockFetch.mockImplementation(async (input, init) => {
      if (decodeURIComponent(String(init?.body)).includes('node(0)')) {
        return hangUntilAborted(init);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, String(input) === DEFAULT_ENDPOINT ? 60_000 : 40_000),
      );
      return new Response('busy', { status: 503 });
    });

    const startedAt = Date.now();
    let settledAt = 0;
    const pending = service
      .query('[out:json];node(1);out;', createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => {
        settledAt = Date.now() - startedAt;
        return e;
      });
    // Once the call has moved on from A to the mirror, a long query takes A's slot.
    await vi.advanceTimersByTimeAsync(61_000);
    const holder = service
      .query('[out:json][timeout:180];node(0);out;', createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(300_000);
    const err = (await pending) as McpError;
    await holder;

    expectBudgetSpent(err, 120_000);
    expect(settledAt).toBe(120_000);
    expect(submittedTo().slice(0, 3)).toEqual([DEFAULT_ENDPOINT, MIRROR, DEFAULT_ENDPOINT]);
    expect(submittedNodeIds().slice(0, 3)).toEqual([1, 1, 0]);
    expect(submittedNodeIds().filter((id) => id === 1)).toHaveLength(2);
  });

  /**
   * A load-shed near the end of the budget, with no untried entry left to walk to,
   * leaves a backoff before the return longer than what is left; sleeping it out could
   * only end on the budget anyway, so the call settles at once. (With an untried entry
   * left, the walk would submit there with the remainder instead — no backoff.)
   */
  it('settles inside the budget when the backoff after a load-shed would outlast it', async () => {
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR];
    mockFetch.mockImplementation(async (input, init) => {
      if (String(input) !== MIRROR) return hangUntilAborted(init);
      await new Promise((resolve) => setTimeout(resolve, 29_000));
      return new Response('busy', { status: 503 });
    });
    let settledAt: number | undefined;
    const startedAt = Date.now();
    const pending = service
      .query('[out:json];node(1);out;', createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => {
        settledAt = Date.now() - startedAt;
        return e;
      });
    await vi.advanceTimersByTimeAsync(600_000);
    const err = (await pending) as McpError;

    expectBudgetSpent(err, 120_000);
    expect(settledAt).toBeLessThan(120_000);
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
  });

  /**
   * A mirror naming a wait longer than the budget has left, with no untried entry to
   * walk to: sleeping it out would end the call on the budget with the throttle hidden,
   * so the throttle surfaces itself — `retryAfter` intact — the same exit a wait past
   * the backoff cap takes. The mirror answers 5 s into the 30 s the budget left it.
   */
  it('surfaces a Retry-After 429 whose wait outlasts the remaining budget as the throttle', async () => {
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR];
    mockFetch.mockImplementation(async (input, init) => {
      if (String(input) !== MIRROR) return hangUntilAborted(init);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return new Response('slow down', { status: 429, headers: { 'Retry-After': '29' } });
    });
    const err = await runError('[out:json];node(1);out;');

    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({ status: 429, retryAfter: '29' });
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
  });
});

/**
 * Regression for #86: a 401, 403, or 404 carries no reason and a code outside the
 * retryable set, but the predicate retried every `McpError` it did not name — so a wrong
 * endpoint URL or a blocked client spent four submissions, re-asking the same host with
 * backoff, before the caller saw the status the first attempt already had.
 *
 * The status belongs to the host rather than the query: a mirror at the wrong path, or
 * one blocking this client, answers the same way however often it is asked, and another
 * host may not. So it faults the endpoint — never re-asked, rotated past when a mirror is
 * listed.
 *
 * #87: a call refused that way by every host used to keep the last status error — no
 * reason, no hint, a `client`-category code, and only the last refusal named. It now
 * ends on `endpoints_rejected`, composed from every host's status like
 * `endpoints_unavailable`, and not retryable: the next call gets the same answers.
 */
describe('OverpassService deterministic 4xx (#86, #87)', () => {
  const MIRROR = 'https://overpass.mirror.example/api/interpreter';
  const MIRROR_ORIGIN = 'https://overpass.mirror.example';
  const THIRD = 'https://overpass.third.example/api/interpreter';
  const THIRD_ORIGIN = 'https://overpass.third.example';
  const QL = '[out:json];node(1);out;';

  /** The composed all-refused shape, asserted whole so no field can drift unseen. */
  function expectRejected(err: McpError, summary: string): void {
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe(`Every configured Overpass endpoint refused this query — ${summary}.`);
    expect(err.data).toEqual({
      errorSource: 'OverpassEndpointsRejected',
      reason: 'endpoints_rejected',
      retryable: false,
    });
  }

  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = undefined;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
  });

  function submittedTo(): string[] {
    return mockFetch.mock.calls.map(([input]) => String(input));
  }

  /** Answers `status` from every host named in `refusing`, 200 from the rest. */
  function refuseFrom(status: number, ...refusing: string[]): void {
    mockFetch.mockImplementation(async (input) =>
      refusing.includes(String(input)) ? new Response('nope', { status }) : emptyResponse(),
    );
  }

  async function runError(): Promise<McpError> {
    const pending = service
      .query(QL, createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await pending;
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }

  describe('with one endpoint configured', () => {
    it.each([404, 403, 401])(
      'ends an HTTP %d on endpoints_rejected after one submission',
      async (status) => {
        refuseFrom(status, DEFAULT_ENDPOINT);
        const err = await runError();

        expectRejected(err, `${DEFAULT_ORIGIN}: HTTP ${status}`);
        // The captured response body is a working buffer; it never rides the composed error.
        expect(err.data).not.toHaveProperty('body');
        expect(err.data).not.toHaveProperty('responseBody');
        expect(submittedTo()).toEqual([DEFAULT_ENDPOINT]);
      },
    );

    it('submits once to a pinned OSM_OVERPASS_BASE_URL that answers 404', async () => {
      const pinned = 'https://overpass.private.example/sk-FAKEKEY123/api/interpreter';
      configState.overpassBaseUrl = pinned;
      refuseFrom(404, pinned);
      const err = await runError();

      expectRejected(err, 'https://overpass.private.example: HTTP 404');
      expect(submittedTo()).toEqual([pinned]);
    });
  });

  describe('with a mirror listed', () => {
    beforeEach(() => {
      configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR];
    });

    it('rotates a 404 to the mirror, which answers', async () => {
      refuseFrom(404, DEFAULT_ENDPOINT);
      const pending = service.query(QL, createMockContext({ tenantId: 'test' }));
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;

      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
      expect(result.servedBy).toBe(MIRROR_ORIGIN);
    });

    /**
     * The mirror shedding load keeps the call retrying, and the round-robin wraps back
     * onto the first entry — which must be skipped, since its 403 has not changed.
     */
    it('never re-asks a host that answered 403, even when rotation wraps onto it', async () => {
      mockFetch.mockImplementation(async (input) =>
        String(input) === DEFAULT_ENDPOINT
          ? new Response('blocked', { status: 403 })
          : new Response('busy', { status: 503 }),
      );
      const err = await runError();

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      const submissions = submittedTo();
      expect(submissions.filter((url) => url === DEFAULT_ENDPOINT)).toHaveLength(1);
      expect(submissions.filter((url) => url === MIRROR)).toHaveLength(3);
    });

    it('asks each host once and names each status when every host refuses', async () => {
      mockFetch.mockImplementation(async (input) =>
        String(input) === DEFAULT_ENDPOINT
          ? new Response('nope', { status: 404 })
          : new Response('blocked', { status: 403 }),
      );
      const err = await runError();

      expectRejected(err, `${DEFAULT_ORIGIN}: HTTP 404; ${MIRROR_ORIGIN}: HTTP 403`);
      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    });

    it('rotates through a third refusing host before composing', async () => {
      configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR, THIRD];
      mockFetch.mockImplementation(async (input) => {
        const status = { [DEFAULT_ENDPOINT]: 404, [MIRROR]: 401 }[String(input)] ?? 403;
        return new Response('nope', { status });
      });
      const err = await runError();

      expectRejected(
        err,
        `${DEFAULT_ORIGIN}: HTTP 404; ${MIRROR_ORIGIN}: HTTP 401; ${THIRD_ORIGIN}: HTTP 403`,
      );
      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR, THIRD]);
    });

    /**
     * `withRetry` allows four attempts by default, so a list longer than that used to
     * end on the fourth host's bare status with the rest never asked, and each refusal
     * slept a backoff first. The walk asks every untried entry at once, so a ten-entry
     * list is asked once per entry and named in full before any timer runs.
     */
    it('asks every entry of a list longer than the default attempt cap, without waiting', async () => {
      const list = Array.from(
        { length: 10 },
        (_, i) => `https://overpass-${i + 1}.example/api/interpreter`,
      );
      configState.overpassEndpoints = list;
      refuseFrom(404, ...list);
      const pending = service
        .query(QL, createMockContext({ tenantId: 'test' }))
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      const err = (await pending) as McpError;

      expectRejected(
        err,
        list.map((_, i) => `https://overpass-${i + 1}.example: HTTP 404`).join('; '),
      );
      expect(submittedTo()).toEqual(list);
    });

    /** Lists within the default cap keep it: a load-shedding pair still gets four attempts. */
    it('keeps the default attempt cap for a two-entry list', async () => {
      refuseFrom(503, DEFAULT_ENDPOINT, MIRROR);
      await runError();

      expect(submittedTo()).toHaveLength(4);
    });

    /**
     * A load-shed walks to an untried entry at once too: each host sheds or answers on
     * its own, so a 5xx from one says nothing about the next. A list past the default
     * cap is asked once per entry and no host twice, and the call ends there.
     */
    it('asks each host of a shedding five-entry list once, at once, and stops', async () => {
      const list = Array.from(
        { length: 5 },
        (_, i) => `https://overpass-${i + 1}.example/api/interpreter`,
      );
      configState.overpassEndpoints = list;
      refuseFrom(503, ...list);
      const pending = service
        .query(QL, createMockContext({ tenantId: 'test' }))
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      const err = (await pending) as McpError;

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toContain('(failed after 5 attempts)');
      expect(err.data).toMatchObject({ status: 503, retryAttempts: 5 });
      expect(submittedTo()).toEqual(list);
    });

    it('composes a 404 mixed with a refused connection as endpoints_unavailable', async () => {
      mockFetch.mockImplementation(async (input) => {
        if (String(input) === MIRROR) {
          throw Object.assign(new TypeError('Unable to connect.'), { code: 'ConnectionRefused' });
        }
        return new Response('nope', { status: 404 });
      });
      const err = await runError();

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({ reason: 'endpoints_unavailable' });
      expect(err.message).toContain(`${DEFAULT_ORIGIN}: HTTP 404`);
      expect(err.message).toContain(`${MIRROR_ORIGIN}: connection refused`);
      expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
    });
  });
});

/**
 * #95: an HTTP 408 is the endpoint's own clock running out on the request, as a 504 is;
 * a 425 is the endpoint declining to take the query yet, as a 503 does. Each moves
 * through the walk and the retry exactly as its counterpart, and carries its
 * counterpart's code, so the tools map it onto the same declared reason.
 */
describe('OverpassService HTTP 408 and 425 (#95)', () => {
  const MIRROR = 'https://overpass.mirror.example/api/interpreter';
  const MIRROR_ORIGIN = 'https://overpass.mirror.example';
  const QL = '[out:json];node(1);out;';

  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
  });

  async function runError(): Promise<McpError> {
    const pending = service
      .query(QL, createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200_000);
    const err = await pending;
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }

  it.each([
    [408, 504, JsonRpcErrorCode.Timeout],
    [425, 503, JsonRpcErrorCode.ServiceUnavailable],
  ])(
    're-submits a pinned endpoint answering %i as it does a %i, under the same code',
    async (status, counterpart, code) => {
      const outcome = async (answer: number) => {
        mockFetch.mockReset();
        mockFetch.mockImplementation(async () => new Response('slow down', { status: answer }));
        const err = await runError();
        return { code: err.code, submissions: mockFetch.mock.calls.length, data: err.data };
      };
      const theirs = await outcome(counterpart);
      service = new OverpassService({} as AppConfig, {} as StorageService);
      const ours = await outcome(status);

      expect(ours.code).toBe(code);
      expect(ours.code).toBe(theirs.code);
      expect(ours.submissions).toBe(4);
      expect(ours.submissions).toBe(theirs.submissions);
      // No reason of the service's own: the tools map the bare status onto theirs, and strip
      // the captured body as they do.
      expect(ours.data).toMatchObject({ status, retryAttempts: 4, body: 'slow down' });
      expect(ours.data).not.toHaveProperty('reason');
    },
  );

  it.each([408, 425])(
    'walks straight to a mirror after a %i, as after a 5xx — no backoff, no fault',
    async (status) => {
      configState.overpassBaseUrl = undefined;
      configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR];
      service = new OverpassService({} as AppConfig, {} as StorageService);
      mockFetch.mockImplementation(async (input) =>
        String(input) === DEFAULT_ENDPOINT ? new Response('later', { status }) : emptyResponse(),
      );

      const pending = service.query(QL, createMockContext({ tenantId: 'test' }));
      // Settles with no time passing, so the move to the mirror waited out no backoff.
      await vi.advanceTimersByTimeAsync(0);
      const result = await pending;

      expect(result.servedBy).toBe(MIRROR_ORIGIN);
      expect(mockFetch.mock.calls.map(([input]) => String(input))).toEqual([
        DEFAULT_ENDPOINT,
        MIRROR,
      ]);
    },
  );

  it.each([408, 425])(
    'returns to an endpoint that answered %i after the backoff, as it does a 5xx',
    async (status) => {
      configState.overpassBaseUrl = undefined;
      configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR];
      service = new OverpassService({} as AppConfig, {} as StorageService);
      let first = true;
      mockFetch.mockImplementation(async (input) => {
        if (String(input) === DEFAULT_ENDPOINT && first) {
          first = false;
          return new Response('later', { status });
        }
        return String(input) === DEFAULT_ENDPOINT
          ? emptyResponse()
          : new Response('down', { status: 503 });
      });

      const pending = service.query(QL, createMockContext({ tenantId: 'test' }));
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      // Not written off for the call: the first entry is asked again and serves it.
      expect(result.servedBy).toBe(DEFAULT_ORIGIN);
      expect(mockFetch.mock.calls.map(([input]) => String(input))).toEqual([
        DEFAULT_ENDPOINT,
        MIRROR,
        DEFAULT_ENDPOINT,
      ]);
    },
  );
});

/**
 * #94: what a keyed endpoint quotes back of its own request — in an error body, a status
 * line, a non-JSON 200, a remark — reaches no surface: not the message, not the error
 * data, and not any error behind it, which is what the `Error in tool:` record and
 * `withRetry`'s retry line are built from.
 */
describe('OverpassService upstream text quoting a keyed endpoint (#94)', () => {
  const KEYED =
    'https://keyuser:keypass@overpass.keyed.example/sk-FAKEKEY123/api/interpreter?key=QSECRET';
  const KEYED_ORIGIN = 'https://overpass.keyed.example';
  const QUOTED_PATH = '/sk-FAKEKEY123/api/interpreter?key=QSECRET';
  const SECRET = /sk-F|QSECRET|keyuser|keypass/;

  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = KEYED;
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
  });

  /** The message, data, and stack of the error and of every cause behind it. */
  function everythingQuoted(error: unknown): string {
    const parts: string[] = [];
    for (let current = error; current instanceof Error; current = current.cause) {
      parts.push(current.message, current.stack ?? '');
      if (current instanceof McpError) parts.push(JSON.stringify(current.data ?? {}));
    }
    return parts.join('\n');
  }

  async function queryError(): Promise<McpError> {
    const pending = service
      .query('[out:json];node(1);out;', createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200_000);
    const err = await pending;
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }

  it('scrubs a non-JSON 200 body quoting the request path, as reported', async () => {
    mockFetch.mockImplementation(
      async () => new Response(`invalid key for ${QUOTED_PATH}`, { status: 200 }),
    );
    const err = await queryError();

    expect(err.data).toMatchObject({ reason: 'upstream_error' });
    expect(err.message).toBe('Overpass returned a body that is not JSON: invalid key for …?…');
    expect(everythingQuoted(err)).not.toMatch(SECRET);
  });

  it('scrubs the Error lines it reads out of a non-JSON 200 document', async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response(
          `<p><strong>Error</strong>: runtime error: no access to ${QUOTED_PATH} for this client</p>`,
          { status: 200 },
        ),
    );
    const err = await queryError();

    expect(err.message).toBe(
      'Overpass reported an error: runtime error: no access to …?… for this client',
    );
    expect(everythingQuoted(err)).not.toMatch(SECRET);
  });

  it('scrubs a remark quoting the request path', async () => {
    mockFetch.mockImplementation(async () =>
      remarkResponse('runtime error: key at /sk-FAKEKEY123/api/interpreter has expired'),
    );
    const err = await queryError();

    expect(err.data).toMatchObject({ reason: 'upstream_error' });
    expect(err.message).toBe('Overpass reported an error: runtime error: key at … has expired');
    expect(everythingQuoted(err)).not.toMatch(SECRET);
  });

  it('scrubs the status line and body of a non-2xx, and every error built on them', async () => {
    const retryLines = vi.spyOn(logger, 'debug');
    mockFetch.mockImplementation(
      async () =>
        new Response(`<p><strong>Error</strong>: runtime error: overloaded at ${QUOTED_PATH}</p>`, {
          status: 503,
          statusText: 'Busy /sk-FAKEKEY123/api/interpreter',
          headers: { 'retry-after': '1' },
        }),
    );
    const err = await queryError();

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe('Overpass returned HTTP 503 Busy …. (failed after 4 attempts)');
    expect(err.data).toMatchObject({
      status: 503,
      statusText: 'Busy …',
      body: '<p><strong>Error</strong>: runtime error: overloaded at …?…</p>',
      responseBody: '<p><strong>Error</strong>: runtime error: overloaded at …?…</p>',
      retryAfter: '1',
      url: KEYED_ORIGIN,
      retryAttempts: 4,
    });
    expect(everythingQuoted(err)).not.toMatch(SECRET);
    // `withRetry` logs each attempt's message before its backoff.
    const logged = retryLines.mock.calls.map((call) => JSON.stringify(call));
    expect(logged.some((line) => line.includes('Busy …'))).toBe(true);
    expect(logged.join('\n')).not.toMatch(SECRET);
  });

  it('scrubs the refusal an all-rejected call is composed from', async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response(`Cannot POST ${QUOTED_PATH}`, {
          status: 404,
          statusText: 'Not Found /sk-FAKEKEY123/api/interpreter',
        }),
    );
    const err = await queryError();

    expect(err.data).toMatchObject({ reason: 'endpoints_rejected' });
    expect(err.message).toBe(
      `Every configured Overpass endpoint refused this query — ${KEYED_ORIGIN}: HTTP 404.`,
    );
    expect((err.cause as McpError).data).toMatchObject({ body: 'Cannot POST …?…' });
    expect(everythingQuoted(err)).not.toMatch(SECRET);
  });

  it('leaves no stub of a key that a long body has cut at the capture limit', async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response(`${'x'.repeat(3_990)}${QUOTED_PATH}${'y'.repeat(100)}`, { status: 503 }),
    );
    const err = await queryError();

    expect(err.data?.body).toBe(`${'x'.repeat(3_990)}…`);
    expect(everythingQuoted(err)).not.toMatch(/\/sk|QSECRET/);
  });

  /** Node's `fetch` refuses a URL that carries credentials, quoting the whole URL. */
  it('scrubs a connection failure whose own message quotes the configured URL', async () => {
    mockFetch.mockImplementation(async () => {
      throw new TypeError(
        `Request cannot be constructed from a URL that includes credentials: ${KEYED}`,
      );
    });
    const err = await queryError();

    expect(err.data).toMatchObject({ reason: 'endpoints_unavailable' });
    expect((err.cause as McpError).message).toBe(
      'Network error contacting Overpass: Request cannot be constructed from a URL that includes credentials: https://…:…@overpass.keyed.example…?…',
    );
    expect(everythingQuoted(err)).not.toMatch(SECRET);
  });

  /** Characterization: the rest of the upstream text, and a quote of no endpoint, are kept. */
  it('leaves upstream text that quotes no configured endpoint as it was', async () => {
    mockFetch.mockImplementation(async () =>
      remarkResponse('runtime error: Query failed with the exception: /other/path?x=1'),
    );
    const err = await queryError();
    expect(err.message).toBe(
      'Overpass reported an error: runtime error: Query failed with the exception: /other/path?x=1',
    );
  });
});

/**
 * Regression for #93: the POST followed redirects. A keyed provider answering a missing
 * or wrong key with a 301 to its docs page turned the POST into a GET, the page came back
 * as HTML with HTTP 200, and the markup was read as a throttle — the host faulted as busy
 * rather than refusing. A 307 or 308 would re-POST the query to whatever host `Location`
 * names. A redirect is the host refusing the request as sent, so it is never followed.
 *
 * The first two cases run the runtime's own `fetch` against loopback servers, since what
 * they pin is the runtime's redirect handling, which a stubbed `fetch` cannot exercise.
 */
describe('OverpassService redirects (#93)', () => {
  const QL = '[out:json];node(1);out;';

  type Handler = (req: IncomingMessage, res: ServerResponse) => void;
  const servers: ReturnType<typeof createServer>[] = [];

  /** A loopback server recording every request line it receives; resolves to its origin. */
  async function listen(handler: Handler): Promise<{ origin: string; seen: string[] }> {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      handler(req, res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }

  let service: OverpassService;

  beforeEach(() => {
    vi.useRealTimers();
    mockFetch.mockReset();
    // Loopback only: anything else is an unmocked call and fails the test.
    mockFetch.mockImplementation((input, init) => {
      if (!String(input).startsWith('http://127.0.0.1:')) {
        return Promise.reject(new Error(`unmocked fetch to ${String(input)}`));
      }
      return runtimeFetch(input, init);
    });
    configState.overpassMaxConcurrency = 2;
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
  });

  async function runError(): Promise<McpError> {
    const err = await service
      .query(QL, createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }

  it('does not follow a 301 to a docs page, and ends on endpoints_rejected naming it', async () => {
    const stub = await listen((req, res) => {
      if (req.url?.startsWith('/docs')) {
        res
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end('<html><body>API docs</body></html>');
        return;
      }
      res.writeHead(301, { Location: '/docs/overpass' }).end();
    });
    configState.overpassBaseUrl = `${stub.origin}/redirect/api/interpreter`;
    const err = await runError();

    expect(stub.seen).toEqual(['POST /redirect/api/interpreter']);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'endpoints_rejected', retryable: false });
    expect(err.message).toBe(
      `Every configured Overpass endpoint refused this query — ${stub.origin}: HTTP 301.`,
    );
  });

  it('never re-POSTs the query to the host a 307 names', async () => {
    const elsewhere = await listen((_req, res) => {
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ version: 0.6, elements: [] }));
    });
    const stub = await listen((_req, res) => {
      res.writeHead(307, { Location: `${elsewhere.origin}/api/interpreter` }).end();
    });
    configState.overpassBaseUrl = `${stub.origin}/api/interpreter`;
    const err = await runError();

    expect(elsewhere.seen).toEqual([]);
    expect(stub.seen).toEqual(['POST /api/interpreter']);
    expect(err.data).toMatchObject({ reason: 'endpoints_rejected' });
    expect(err.message).toContain(`${stub.origin}: HTTP 307`);
  });

  /** A redirecting host is written off like any other refusal, and rotation moves on. */
  it('faults a redirecting entry and names each redirect once every entry has refused', async () => {
    vi.useFakeTimers();
    const MIRROR = 'https://overpass.mirror.example/api/interpreter';
    configState.overpassBaseUrl = undefined;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR];
    mockFetch.mockImplementation(async (input) =>
      String(input) === DEFAULT_ENDPOINT
        ? new Response(null, { status: 301, headers: { Location: 'https://docs.example/' } })
        : new Response(null, { status: 308, headers: { Location: 'https://elsewhere.example/' } }),
    );
    const pending = service
      .query(QL, createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = (await pending) as McpError;

    expect(err.data).toMatchObject({ reason: 'endpoints_rejected', retryable: false });
    expect(err.message).toContain(
      `${DEFAULT_ORIGIN}: HTTP 301; https://overpass.mirror.example: HTTP 308`,
    );
    expect(mockFetch.mock.calls.map(([input]) => String(input))).toEqual([
      DEFAULT_ENDPOINT,
      MIRROR,
    ]);
    expect(mockFetch.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
  });
});

/**
 * The submission cap ending a call on a fault one endpoint caused. A list of four or more
 * walks every entry inside the first attempt, so the cap can land on the last entry's
 * refusal while the entries that shed load stay eligible. The call ends on what the
 * retried entries said — the load shedding — rather than the one host that refused: that
 * fault carries no reason of the service's own, and the tools would forward it bare.
 */
describe('OverpassService submission cap ending on an endpoint fault', () => {
  const QL = '[out:json];node(1);out;';
  const LIST = Array.from(
    { length: 4 },
    (_, i) => `https://overpass-${i + 1}.example/api/interpreter`,
  );

  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = undefined;
    configState.overpassEndpoints = LIST;
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
  });

  /** Each entry answers with its own `answer`, in list order. */
  function answerEach(
    answers: ReadonlyArray<(init: RequestInit | undefined) => Promise<Response>>,
  ) {
    mockFetch.mockImplementation(async (input, init) => {
      const answer = answers[LIST.indexOf(String(input))];
      if (!answer) throw new Error(`unmocked fetch: ${String(input)}`);
      return answer(init);
    });
  }

  const shed = async () => new Response('busy', { status: 503 });

  async function runError(): Promise<McpError> {
    const pending = service
      .query(QL, createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await pending;
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }

  /** The exhaustion shape of a call whose retried entries all shed load. */
  function expectShedExhaustion(err: McpError): void {
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toContain('(failed after 4 attempts)');
    expect(err.data).toMatchObject({ status: 503, retryAttempts: 4, operation: 'overpass.query' });
    expect(err.data).not.toHaveProperty('reason');
    expect(mockFetch.mock.calls.map(([input]) => String(input))).toEqual(LIST);
  }

  it.each([
    ['an HTTP 404', async () => new Response('nope', { status: 404 })],
    ['an HTTP 429 with no Retry-After', async () => new Response('slow down', { status: 429 })],
    [
      'a refused connection',
      async () => {
        throw Object.assign(new TypeError('Unable to connect.'), { code: 'ConnectionRefused' });
      },
    ],
    ['no answer inside the attempt window', hangUntilAborted],
  ] as const)(
    'ends [503, 503, 503, %s] on the load shedding the cap retried',
    async (_name, last) => {
      answerEach([shed, shed, shed, last]);
      expectShedExhaustion(await runError());
    },
  );

  /** Characterization: the cap landing on a retried failure already reports it. */
  it('ends [404, 503, 503, 503] on the load shedding too', async () => {
    answerEach([async () => new Response('nope', { status: 404 }), shed, shed, shed]);
    expectShedExhaustion(await runError());
  });

  /**
   * Characterization: one endpoint is not ended by the cap. Its own 404 leaves no entry to
   * retry, so the call composes `endpoints_rejected` before the cap is reached.
   */
  it('ends a single endpoint answering 503, 503, 503, then 404 on endpoints_rejected', async () => {
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    service = new OverpassService({} as AppConfig, {} as StorageService);
    const statuses = [503, 503, 503, 404];
    mockFetch.mockImplementation(
      async () => new Response('x', { status: statuses.shift() ?? 500 }),
    );
    const err = await runError();

    expect(err.data).toMatchObject({ reason: 'endpoints_rejected' });
    expect(err.message).toContain(`${DEFAULT_ORIGIN}: HTTP 404`);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});

/**
 * HTTP 501: the host does not implement what was asked of it, on its own account — a
 * retry gets the same answer, so the framework marks it `retryable: false`. It is filed
 * as a refusal like a 401, 403, or 404: the call walks on to a listed mirror, never asks
 * the host again, and a list that every entry refuses so ends on `endpoints_rejected`.
 */
describe('OverpassService HTTP 501', () => {
  const MIRROR = 'https://overpass.mirror.example/api/interpreter';
  const MIRROR_ORIGIN = 'https://overpass.mirror.example';
  const QL = '[out:json];node(1);out;';

  let service: OverpassService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    configState.overpassMaxConcurrency = 2;
    configState.overpassBaseUrl = undefined;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT, MIRROR];
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    configState.overpassEndpoints = [DEFAULT_ENDPOINT];
  });

  function submittedTo(): string[] {
    return mockFetch.mock.calls.map(([input]) => String(input));
  }

  async function settle<T>(pending: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(120_000);
    return pending;
  }

  it('walks a 501 on to the mirror, which answers', async () => {
    mockFetch.mockImplementation(async (input) =>
      String(input) === DEFAULT_ENDPOINT
        ? new Response('Not Implemented', { status: 501 })
        : emptyResponse(),
    );
    const result = await settle(service.query(QL, createMockContext({ tenantId: 'test' })));

    expect(result.servedBy).toBe(MIRROR_ORIGIN);
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
  });

  /** The mirror shedding load keeps the call retrying; rotation wrapping skips the 501 host. */
  it('never re-asks a host that answered 501', async () => {
    mockFetch.mockImplementation(async (input) =>
      String(input) === DEFAULT_ENDPOINT
        ? new Response('Not Implemented', { status: 501 })
        : new Response('busy', { status: 503 }),
    );
    const err = (await settle(
      service.query(QL, createMockContext({ tenantId: 'test' })).catch((e: unknown) => e),
    )) as McpError;

    expect(err.data).toMatchObject({ status: 503, retryAttempts: 4 });
    expect(submittedTo().filter((url) => url === DEFAULT_ENDPOINT)).toHaveLength(1);
    expect(submittedTo().filter((url) => url === MIRROR)).toHaveLength(3);
  });

  it('ends a list every entry answers 501 on endpoints_rejected, naming each', async () => {
    mockFetch.mockImplementation(async () => new Response('Not Implemented', { status: 501 }));
    const err = (await settle(
      service.query(QL, createMockContext({ tenantId: 'test' })).catch((e: unknown) => e),
    )) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe(
      `Every configured Overpass endpoint refused this query — ${DEFAULT_ORIGIN}: HTTP 501; ${MIRROR_ORIGIN}: HTTP 501.`,
    );
    expect(err.data).toEqual({
      errorSource: 'OverpassEndpointsRejected',
      reason: 'endpoints_rejected',
      retryable: false,
    });
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT, MIRROR]);
  });

  it('ends a pinned endpoint answering 501 on endpoints_rejected after one submission', async () => {
    configState.overpassBaseUrl = DEFAULT_ENDPOINT;
    service = new OverpassService({} as AppConfig, {} as StorageService);
    mockFetch.mockImplementation(async () => new Response('Not Implemented', { status: 501 }));
    const err = (await settle(
      service.query(QL, createMockContext({ tenantId: 'test' })).catch((e: unknown) => e),
    )) as McpError;

    expect(err.data).toMatchObject({ reason: 'endpoints_rejected', retryable: false });
    expect(err.message).toContain(`${DEFAULT_ORIGIN}: HTTP 501`);
    expect(submittedTo()).toEqual([DEFAULT_ENDPOINT]);
  });
});
