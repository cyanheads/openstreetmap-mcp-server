/**
 * @fileoverview Tests for overpass-service retry classification, remark
 * classification, HTTP error-body capture, and the endpoint slot gate.
 * @module tests/services/overpass/overpass-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTransientOverpassError, OverpassService } from '@/services/overpass/overpass-service.js';

/**
 * Mutable slot budget and endpoint so a test can pin the concurrency cap and
 * point the service at a credential-bearing mirror URL independently of the env.
 */
const configState = vi.hoisted(() => ({
  overpassMaxConcurrency: 2,
  overpassBaseUrl: 'https://overpass-api.de/api/interpreter',
}));
const DEFAULT_ENDPOINT = configState.overpassBaseUrl;

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    nominatimBaseUrl: 'https://nominatim.openstreetmap.org',
    overpassBaseUrl: configState.overpassBaseUrl,
    overpassMaxConcurrency: configState.overpassMaxConcurrency,
    nominatimUserAgent: 'openstreetmap-mcp-server/test',
  }),
}));

/**
 * The service owns its Overpass POST (so it can raise the captured error-body
 * limit), so the seam under test is global `fetch`. Stubbing it rather than a
 * framework helper keeps the real status classification and the real withRetry in
 * the path — attempt counts and error codes stay meaningful — and guarantees no
 * test in this file reaches the live endpoint.
 */
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

    it('returns true for ValidationError with query_error reason (service-layer path)', () => {
      // If a ValidationError with reason 'query_error' reaches withRetry, withRetry's
      // own code check (ValidationError is not in TRANSIENT_CODES) stops the retry.
      // isTransientOverpassError doesn't need to exclude it.
      const err = new McpError(JsonRpcErrorCode.ValidationError, 'Malformed query', {
        reason: 'query_error',
      });
      expect(isTransientOverpassError(err)).toBe(true);
    });

    it('returns true for non-McpError values', () => {
      expect(isTransientOverpassError('string error')).toBe(true);
      expect(isTransientOverpassError(null)).toBe(true);
      expect(isTransientOverpassError(undefined)).toBe(true);
      expect(isTransientOverpassError(42)).toBe(true);
    });
  });
});

describe('OverpassService query builders', () => {
  // The builders trust already-validated input — resolveTagInput rejects Overpass QL
  // metacharacters upstream (see openstreetmap-tag-input) — so these assert the QL shape
  // for a normal tag rather than any in-builder sanitization. Constructor deps are unused.
  const service = new OverpassService({} as AppConfig, {} as StorageService);

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

  // A private mirror can carry a key in its query string, so the endpoint reaches
  // error data as origin + path only — the redaction fetchWithTimeout applied.
  it('keeps the endpoint query string out of error data', async () => {
    const err = await statusError(() => new Response('nope', { status: 503 }));
    expect(err.data?.url).toBe(DEFAULT_ENDPOINT);
  });

  /**
   * The endpoint is operator-configured, so a private mirror's credentials and
   * `?key=` ride on it. Drives an endpoint that actually carries both — the
   * default public URL has neither, so asserting against it cannot tell redaction
   * from passing the raw string through.
   */
  it('strips credentials and the query string from a private mirror endpoint', async () => {
    configState.overpassBaseUrl =
      'https://mirroruser:mirrorpass@overpass.internal.example/api/interpreter?key=SUPERSECRET';
    const err = await statusError(() => new Response('nope', { status: 503 }));

    expect(err.data?.url).toBe('https://overpass.internal.example/api/interpreter');
    // Nothing secret anywhere on the wire — message and every data field.
    const serialized = `${err.message} ${JSON.stringify(err.data)}`;
    expect(serialized).not.toContain('SUPERSECRET');
    expect(serialized).not.toContain('mirrorpass');
    expect(serialized).not.toContain('mirroruser');
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
    service = new OverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('aborts a request that outruns the client deadline and reports it as a timeout', async () => {
    abortableFetch();
    const ctx = createMockContext({ tenantId: 'test' });
    const pending = service.query('[out:json];node(1);out;', ctx).catch((e: unknown) => e);
    // Long enough for all four attempts to burn their own 90s deadline plus backoff.
    await vi.advanceTimersByTimeAsync(600_000);
    const err = (await pending) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ errorSource: 'OverpassClientTimeout' });
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
    expect(err.data).toMatchObject({ errorSource: 'OverpassAborted' });
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

    // Cancel one of the parked callers, so the splice path runs rather than the
    // already-aborted pre-check.
    controllers[4]?.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    const settled = await Promise.all(results);

    const aborted = settled[4];
    expect(aborted).toBeInstanceOf(McpError);
    expect((aborted as McpError).code).toBe(JsonRpcErrorCode.InternalError);
    expect((aborted as McpError).data).toMatchObject({ errorSource: 'OverpassSlotAborted' });

    // Every other caller still completes — the spliced waiter did not swallow a
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
    expect((err as McpError).data).toMatchObject({ errorSource: 'OverpassSlotAborted' });

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(live);
    // Only the two live callers submitted, and the aborted one never took a slot
    // from them — both ran concurrently at the cap.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(peak()).toBe(2);
  });

  it('drops its abort listener once a slot is granted, so a reused signal does not accumulate them', async () => {
    configState.overpassMaxConcurrency = 1;
    slowFetch();
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const ctx = createMockContext({ tenantId: 'test', signal: controller.signal });

    const inFlight = Promise.all(
      Array.from({ length: 3 }, (_, i) => service.query(`[out:json];node(${i});out;`, ctx)),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await inFlight;

    // One caller took the slot outright; the other two queued, so two listeners
    // were registered — and both were removed when their slot arrived.
    expect(added).toHaveBeenCalledTimes(2);
    expect(removed).toHaveBeenCalledTimes(2);
  });
});
