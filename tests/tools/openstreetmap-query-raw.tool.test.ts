/**
 * @fileoverview Tests for the openstreetmap-query-raw tool.
 * @module tests/tools/openstreetmap-query-raw.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_ELEMENT_BYTES,
  openstreetmapQueryRaw,
} from '@/mcp-server/tools/definitions/openstreetmap-query-raw.tool.js';
import { CACHE_MAX_ELEMENTS } from '@/services/overpass/overpass-service.js';
import type { OverpassElement, OverpassResponse } from '@/services/overpass/types.js';
import { type ContractError, captureThrown } from '../helpers/handler-error.js';

// --- service mock --------------------------------------------------------

const mockQuery = vi.fn<(ql: string, ctx: unknown) => Promise<OverpassResponse>>();

// Only the service accessor is stubbed; the module's real constants stay intact,
// so a test can assert the tool's prose against the value it actually describes.
vi.mock('@/services/overpass/overpass-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/overpass/overpass-service.js')>();
  return { ...actual, getOverpassService: () => ({ query: mockQuery }) };
});

// --- fixtures ------------------------------------------------------------

const peakElement: OverpassElement = {
  type: 'node',
  id: 987654321,
  lat: 47.62,
  lon: -122.35,
  tags: { natural: 'peak', name: 'Mt Rainier', ele: '4392' },
};

const responseWithTimestamp: OverpassResponse = {
  version: 0.6,
  osm3s: { timestamp_osm_base: '2025-03-01T12:00:00Z' },
  elements: [peakElement],
};

const responseWithoutTimestamp: OverpassResponse = {
  version: 0.6,
  elements: [peakElement],
};

/**
 * The public endpoint's verbatim HTTP 400 document for a malformed query: 977
 * bytes whose `<strong>Error</strong>` lines name each syntax fault and its line
 * number. The service captures it in full (#45), so this is the body the handler
 * now receives rather than a 500-byte prefix that stopped short of the first
 * `Error` at byte 502.
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
 * A 400 from something that is not Overpass — a reverse proxy or a misconfigured
 * mirror. There is no error line to extract at any body limit, so the handler has
 * to keep the bare status message rather than appending page boilerplate.
 */
const NON_OVERPASS_400_BODY =
  '<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>nginx</center></body></html>';

/** Overpass states the cause of a 5xx in the same `Error:` shape as a 400. */
const OVERPASS_504_BODY = [
  '<p>The data included in this document is from www.openstreetmap.org.</p>',
  '<p><strong style="color:#FF0000">Error</strong>: runtime error: Dispatcher_Client::request_read_and_idx::timeout. Probably the server is overloaded. </p>',
].join('\n');

const VALID_QUERY =
  '[out:json][timeout:15];node["natural"="peak"](47.5,-122.5,47.7,-122.2);out body;';
const QUERY_WITHOUT_TIMEOUT =
  '[out:json];node["natural"="peak"](47.5,-122.5,47.7,-122.2);out body;';

// -------------------------------------------------------------------------

describe('openstreetmapQueryRaw', () => {
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue(responseWithTimestamp);
  });

  describe('happy path', () => {
    it('returns raw elements from a valid query', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const result = await openstreetmapQueryRaw.handler(input, ctx);

      expect(result.total_elements).toBe(1);
      expect(result.elements).toHaveLength(1);
      expect(result.elements[0]).toMatchObject({ type: 'node', id: 987654321 });
      expect(result.data_timestamp).toBe('2025-03-01T12:00:00Z');
      expect(result.attribution).toContain('OpenStreetMap');

      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveQuery).toContain('[out:json]');
      expect(enrichment.notice).toBeUndefined();
    });

    it('injects [timeout:N] when query lacks a timeout directive', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({
        query: QUERY_WITHOUT_TIMEOUT,
        timeout_seconds: 45,
      });
      await openstreetmapQueryRaw.handler(input, ctx);

      const calledQuery = mockQuery.mock.calls[0]?.[0] as string;
      expect(calledQuery).toContain('[timeout:45]');
    });

    it('does not inject timeout when query already includes [timeout:]', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      await openstreetmapQueryRaw.handler(input, ctx);

      const calledQuery = mockQuery.mock.calls[0]?.[0] as string;
      // Should preserve the original timeout, not add a second one
      expect(calledQuery.match(/\[timeout:/g)).toHaveLength(1);
    });

    it('handles multiple elements', async () => {
      const elements: OverpassElement[] = Array.from({ length: 5 }, (_, i) => ({
        type: 'node' as const,
        id: i + 1,
        lat: 47.6 + i * 0.01,
        lon: -122.3,
        tags: { natural: 'peak' },
      }));
      mockQuery.mockResolvedValue({ ...responseWithTimestamp, elements });
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const result = await openstreetmapQueryRaw.handler(input, ctx);
      expect(result.total_elements).toBe(5);
      expect(result.elements).toHaveLength(5);
    });
  });

  describe('enrichment', () => {
    it('echoes the effective query (with injected timeout)', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({
        query: QUERY_WITHOUT_TIMEOUT,
        timeout_seconds: 45,
      });
      await openstreetmapQueryRaw.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveQuery).toContain('[timeout:45]');
    });

    it('sets notice when no elements are returned', async () => {
      mockQuery.mockResolvedValue({ ...responseWithTimestamp, elements: [] });
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      await openstreetmapQueryRaw.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('No elements returned');
    });
  });

  describe('missing timestamp', () => {
    it('omits data_timestamp when osm3s is absent', async () => {
      mockQuery.mockResolvedValue(responseWithoutTimestamp);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const result = await openstreetmapQueryRaw.handler(input, ctx);
      expect(result.data_timestamp).toBeUndefined();
    });
  });

  describe('error paths', () => {
    it('preflight: missing [out:json] carries the query_error recovery hint (#16)', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      // No [out:json] — hits the LOCAL preflight branch, not the service catch handler
      // (mockQuery is never reached).
      const input = openstreetmapQueryRaw.input.parse({
        query: 'node["amenity"="cafe"](around:100,47.6205,-122.3493);out body;',
      });
      const err = (await captureThrown(openstreetmapQueryRaw.handler(input, ctx))) as ContractError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('query_error');
      // The declared recovery hint is present on structuredContent's surface; the framework's
      // buildToolErrorResult mirrors it into content[] as the "Recovery:" line for format()-only
      // clients (a framework guarantee downstream of the hint being set here).
      expect(err.data.recovery?.hint).toBeDefined();
      expect(typeof err.data.recovery?.hint).toBe('string');
      const contractHint = openstreetmapQueryRaw.errors?.find(
        (entry) => entry.reason === 'query_error',
      )?.recovery;
      expect(err.data.recovery?.hint).toBe(contractHint);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('propagates plain service errors without remapping', async () => {
      mockQuery.mockRejectedValue(new Error('Overpass query timed out'));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      await expect(openstreetmapQueryRaw.handler(input, ctx)).rejects.toThrow(
        'Overpass query timed out',
      );
    });

    it('remaps query_error McpError to ctx.fail with ValidationError code and recovery.hint', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass API returned HTTP 400 — malformed query syntax.',
          { reason: 'query_error' },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const err = (await captureThrown(openstreetmapQueryRaw.handler(input, ctx))) as ContractError;
      expect(err).toBeInstanceOf(McpError);
      // After remapping via ctx.fail, code should match the contract (ValidationError)
      expect(err.data.reason).toBe('query_error');
      expect(err.data.recovery?.hint).toBeDefined();
    });

    it('surfaces the Overpass parse error from an HTTP 400 response body (#33)', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ValidationError,
          'Fetch failed for https://overpass-api.de/api/interpreter. Status: 400',
          { status: 400, statusText: 'Bad Request', body: OVERPASS_400_XHTML_BODY },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const err = (await captureThrown(openstreetmapQueryRaw.handler(input, ctx))) as ContractError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('query_error');
      expect(err.message).toContain("line 1: parse error: ')' expected - ';' found.");
      expect(err.message).toContain('Unexpected end of input.');
      // Markup never reaches the agent-facing message.
      expect(err.message).not.toContain('<');
      expect(err.data.recovery?.hint).toBeDefined();
    });

    it('surfaces a plain-text Overpass error body (#33)', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ValidationError,
          'Fetch failed for https://overpass.example.com/api/interpreter. Status: 400',
          { status: 400, body: "Error: line 3: parse error: ')' expected - ';' found." },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const err = (await captureThrown(openstreetmapQueryRaw.handler(input, ctx))) as ContractError;
      expect(err.message).toContain("line 3: parse error: ')' expected - ';' found.");
    });

    it('caps the extracted upstream detail (#33)', async () => {
      const longDetail = `Error: ${'x'.repeat(1000)}`;
      mockQuery.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ValidationError, 'Status: 400', {
          status: 400,
          body: longDetail,
        }),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const err = (await captureThrown(openstreetmapQueryRaw.handler(input, ctx))) as ContractError;
      expect(err.message).toContain('…');
      expect(err.message.length).toBeLessThan(500);
    });

    it('keeps the bare status message when the 400 body carries no error text (#33)', async () => {
      // A non-Overpass 400 (proxy, misconfigured mirror) has no error line to
      // extract, so the message must not degrade into page boilerplate.
      mockQuery.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ValidationError, 'Overpass returned HTTP 400 Bad Request.', {
          status: 400,
          body: NON_OVERPASS_400_BODY,
        }),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const err = (await captureThrown(openstreetmapQueryRaw.handler(input, ctx))) as ContractError;
      expect(err.data.reason).toBe('query_error');
      expect(err.message).toBe('Overpass returned HTTP 400 Bad Request.');
      expect(err.data.recovery?.hint).toBeDefined();
    });

    it('remaps query_timeout McpError to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(JsonRpcErrorCode.Timeout, 'Overpass query timed out: runtime error', {
          reason: 'query_timeout',
        }),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const err = (await captureThrown(openstreetmapQueryRaw.handler(input, ctx))) as ContractError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('query_timeout');
      expect(err.data.recovery?.hint).toBeDefined();
    });

    it('remaps result_too_large McpError to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass ran out of memory: runtime error',
          { reason: 'result_too_large' },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const err = (await captureThrown(openstreetmapQueryRaw.handler(input, ctx))) as ContractError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('result_too_large');
      expect(err.data.recovery?.hint).toBeDefined();
    });

    it('remaps rate_limited McpError to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass API returned HTTP 429 — all query slots occupied.',
          { reason: 'rate_limited' },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const err = (await captureThrown(openstreetmapQueryRaw.handler(input, ctx))) as ContractError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('rate_limited');
      expect(err.data.recovery?.hint).toBeDefined();
    });

    it('remaps upstream_error McpError to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass reported an error: runtime error: Dispatcher_Client::request_read_and_idx::timeout',
          { reason: 'upstream_error' },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const err = (await captureThrown(openstreetmapQueryRaw.handler(input, ctx))) as ContractError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('upstream_error');
      expect(err.data.recovery?.hint).toBeDefined();
    });
  });

  /**
   * Regression for #38: a 5xx arrives with a bare status and no reason, so it fell
   * through the catch block untouched — the agent got a fetch-failure string with
   * no declared reason and no recovery hint. 504 is the endpoint's common failure.
   */
  describe('Overpass 5xx contract (#38)', () => {
    // `httpErrorFromResponse` writes the captured body under both the canonical
    // `body` key and the legacy `responseBody` alias, so both have to be seeded.
    const statusError = (status: number, code: JsonRpcErrorCode, body?: string) =>
      new McpError(code, `Overpass returned HTTP ${status}.`, {
        status,
        statusText: 'Gateway Timeout',
        ...(body === undefined ? {} : { body, responseBody: body }),
      });

    const run = async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      return (await captureThrown(openstreetmapQueryRaw.handler(input, ctx))) as ContractError;
    };

    it('maps 504 to overpass_gateway_timeout, keeping the Timeout code', async () => {
      mockQuery.mockRejectedValue(statusError(504, JsonRpcErrorCode.Timeout));
      const err = await run();
      expect(err.data?.reason).toBe('overpass_gateway_timeout');
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
      expect(hint).toContain('[timeout:N]');
      expect(hint).toContain('narrow the bbox');
    });

    it('appends the runtime-error cause Overpass states in the 5xx body', async () => {
      mockQuery.mockRejectedValue(statusError(504, JsonRpcErrorCode.Timeout, OVERPASS_504_BODY));
      const err = await run();
      expect(err.message).toContain('Probably the server is overloaded.');
      expect(err.message).toContain('Dispatcher_Client');
      expect(err.message).not.toContain('<');
    });

    // #46: the captured body is a working buffer for extraction. Forwarding it put
    // the same document on the wire twice, under `body` and the `responseBody` alias.
    it('drops the captured body from the error data once the cause is in the message', async () => {
      mockQuery.mockRejectedValue(statusError(504, JsonRpcErrorCode.Timeout, OVERPASS_504_BODY));
      const err = await run();
      const data = err.data as Record<string, unknown>;
      expect(data.body).toBeUndefined();
      expect(data.responseBody).toBeUndefined();
      expect(data.status).toBe(504);
      expect(data.statusText).toBe('Gateway Timeout');
    });

    it('maps 502 to overpass_unavailable, keeping the ServiceUnavailable code', async () => {
      mockQuery.mockRejectedValue(statusError(502, JsonRpcErrorCode.ServiceUnavailable));
      const err = await run();
      expect(err.data?.reason).toBe('overpass_unavailable');
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
      expect(hint).toContain('OSM_OVERPASS_BASE_URL');
      expect(hint).toContain('retry unchanged');
    });

    it('maps 503 to overpass_unavailable', async () => {
      mockQuery.mockRejectedValue(statusError(503, JsonRpcErrorCode.ServiceUnavailable));
      expect((await run()).data?.reason).toBe('overpass_unavailable');
    });

    it('maps 500 to overpass_unavailable, keeping the ServiceUnavailable code', async () => {
      mockQuery.mockRejectedValue(statusError(500, JsonRpcErrorCode.ServiceUnavailable));
      const err = await run();
      expect(err.data?.reason).toBe('overpass_unavailable');
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    // A 4xx other than 400/429 is not an availability problem — it must not be
    // relabelled as one.
    it('leaves a non-5xx status the contract does not cover untouched', async () => {
      mockQuery.mockRejectedValue(statusError(403, JsonRpcErrorCode.Forbidden));
      const err = await run();
      expect(err.data?.reason).toBeUndefined();
      expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    });
  });

  /**
   * Regression for #50: the tool applied no cap, returning every element Overpass
   * produced and rendering each one again in `content[]` — one call turned a
   * 109-byte input into a 213 MB response reported as a success, with no input
   * that could have bounded it and nothing in the response flagging the size.
   * The shape mirrors `query_nearby` / `query_bbox`, which have paged all along.
   */
  describe('result paging (#50)', () => {
    /** Distinguishable elements, so a page is identified by which ones it holds. */
    function elements(count: number, from = 1): OverpassElement[] {
      return Array.from({ length: count }, (_, i) => ({
        type: 'node' as const,
        id: from + i,
        lat: 47.6,
        lon: -122.3,
      }));
    }

    function idsOf(result: { elements: Record<string, unknown>[] }): unknown[] {
      return result.elements.map((el) => el.id);
    }

    async function run(input: Record<string, unknown>) {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const parsed = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY, ...input });
      const result = await openstreetmapQueryRaw.handler(parsed, ctx);
      return { result, enrichment: getEnrichment(ctx) };
    }

    /**
     * The defect itself. Asserting which elements came back — not just how many —
     * is what separates a real slice from a count that happens to match.
     */
    it('caps the returned elements at the limit and discloses the full match count', async () => {
      mockQuery.mockResolvedValue({ ...responseWithTimestamp, elements: elements(25) });
      const { result, enrichment } = await run({});

      expect(idsOf(result)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(result.total_elements).toBe(20);
      expect(enrichment.totalFound).toBe(25);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.nextOffset).toBe(20);
    });

    /** The disclosure must stay silent when nothing was cut, or it means nothing. */
    it('reports no truncation and no nextOffset when the whole match set fits', async () => {
      mockQuery.mockResolvedValue({ ...responseWithTimestamp, elements: elements(5) });
      const { result, enrichment } = await run({});

      expect(result.total_elements).toBe(5);
      expect(enrichment.totalFound).toBe(5);
      expect(enrichment.truncated).toBe(false);
      expect(enrichment.nextOffset).toBeUndefined();
    });

    /**
     * Paging is only useful if consecutive pages are contiguous and disjoint, so
     * this walks two of them and compares element identity rather than counts.
     */
    it('walks contiguous pages, following nextOffset from one to the next', async () => {
      mockQuery.mockResolvedValue({ ...responseWithTimestamp, elements: elements(25) });

      const first = await run({ limit: 10 });
      expect(idsOf(first.result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(first.enrichment.nextOffset).toBe(10);

      const second = await run({ limit: 10, offset: first.enrichment.nextOffset });
      expect(idsOf(second.result)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
      expect(second.enrichment.nextOffset).toBe(20);

      const last = await run({ limit: 10, offset: second.enrichment.nextOffset });
      expect(idsOf(last.result)).toEqual([21, 22, 23, 24, 25]);
      expect(last.enrichment.truncated).toBe(false);
      expect(last.enrichment.nextOffset).toBeUndefined();
    });

    /**
     * An empty page with matches upstream is a paging mistake, not a bad query —
     * sending the caller to check their syntax would point them at a query that
     * already worked.
     */
    it('tells a caller past the end of the result set to page back, not to fix the query', async () => {
      mockQuery.mockResolvedValue({ ...responseWithTimestamp, elements: elements(25) });
      const { result, enrichment } = await run({ limit: 10, offset: 90 });

      expect(result.elements).toHaveLength(0);
      expect(enrichment.totalFound).toBe(25);
      expect(enrichment.notice).toContain('past the end');
      expect(enrichment.notice).toContain('25 elements');
      expect(enrichment.notice).not.toContain('Verify query syntax');
    });

    it('keeps the empty-result guidance when the query genuinely matched nothing', async () => {
      mockQuery.mockResolvedValue({ ...responseWithTimestamp, elements: [] });
      const { enrichment } = await run({ offset: 40 });

      expect(enrichment.notice).toContain('Verify query syntax');
      expect(enrichment.totalFound).toBe(0);
    });

    it('renders only the returned page in content[], not the full match set', async () => {
      mockQuery.mockResolvedValue({ ...responseWithTimestamp, elements: elements(25) });
      const { result } = await run({ limit: 3 });
      const text = (openstreetmapQueryRaw.format!(result)[0] as { text: string }).text;

      expect(text).toContain('3 elements returned');
      expect(text).toContain('**node** 3');
      expect(text).not.toContain('**node** 4');
    });
  });

  /**
   * Regression for #60: `limit`/`offset` (#50) bound how many top-level elements
   * come back, but one relation's `members` or one way's `geometry` could still
   * scale a single element past a client context window on both surfaces. A
   * per-element byte budget withholds those arrays whole and discloses the gap.
   */
  describe('per-element response bound (#60)', () => {
    /** A relation whose `members` array dominates its serialized size. */
    function heavyRelation(memberCount: number, id = 148838): Record<string, unknown> {
      return {
        type: 'relation',
        id,
        members: Array.from({ length: memberCount }, (_, i) => ({
          type: 'way',
          ref: 1000 + i,
          role: i % 2 === 0 ? 'outer' : 'inner',
        })),
        tags: { name: 'United States', boundary: 'administrative' },
      };
    }

    /** A way carrying both heavy keys `out geom;` produces. */
    function heavyWay(vertexCount: number, id = 12903132): Record<string, unknown> {
      return {
        type: 'way',
        id,
        nodes: Array.from({ length: vertexCount }, (_, i) => 825308606 + i),
        geometry: Array.from({ length: vertexCount }, (_, i) => ({
          lat: 47.6 + i * 0.0001,
          lon: -122.3,
        })),
        tags: { name: 'Space Needle', building: 'tower' },
      };
    }

    async function run(input: Record<string, unknown>) {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const parsed = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY, ...input });
      const result = await openstreetmapQueryRaw.handler(parsed, ctx);
      return { result, enrichment: getEnrichment(ctx) };
    }

    /** Two small elements carrying every heavy key, all of them well under budget. */
    const UNDER_BUDGET_ELEMENTS: Record<string, unknown>[] = [
      {
        type: 'relation',
        id: 148838,
        members: [
          { type: 'way', ref: 1, role: 'outer' },
          { type: 'way', ref: 2, role: '' },
        ],
        tags: { name: 'United States', boundary: 'administrative' },
      },
      {
        type: 'way',
        id: 12903132,
        nodes: [1, 2, 3],
        geometry: [{ lat: 47.6, lon: -122.3 }],
        tags: { name: 'Space Needle' },
      },
    ];

    /**
     * Captured from the formatter before the bound existed. Pinned as a literal
     * rather than recomputed, so a bound that quietly reshapes an under-budget
     * page — a stray disclosure line, a reordered key — fails here.
     */
    const UNDER_BUDGET_TEXT = [
      '**2 elements returned**',
      '**Data as of:** 2025-03-01T12:00:00Z',
      '',
      '**relation** 148838 — United States',
      '  Tags: name=United States, boundary=administrative',
      '  members: [{"type":"way","ref":1,"role":"outer"},{"type":"way","ref":2,"role":""}]',
      '**way** 12903132 — Space Needle',
      '  Tags: name=Space Needle',
      '  nodes: [1,2,3]',
      '  geometry: [{"lat":47.6,"lon":-122.3}]',
      '',
      '*Data © OpenStreetMap contributors, ODbL 1.0*',
    ].join('\n');

    it('renders an all-under-budget page byte-for-byte as before the bound', async () => {
      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: UNDER_BUDGET_ELEMENTS as unknown as OverpassElement[],
      });
      const { result, enrichment } = await run({});

      // structuredContent: the elements pass through untouched, no disclosure key.
      expect(result.elements).toEqual(UNDER_BUDGET_ELEMENTS);
      expect(enrichment.withheldElements).toBeUndefined();
      expect(enrichment.withheldNotice).toBeUndefined();

      // content[]: identical to the pre-change rendering, byte for byte.
      const text = (openstreetmapQueryRaw.format!(result)[0] as { text: string }).text;
      expect(text).toBe(UNDER_BUDGET_TEXT);
    });

    it('withholds a relation members array whole, never truncated to a prefix', async () => {
      const relation = heavyRelation(500);
      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: [relation] as unknown as OverpassElement[],
      });
      const { result, enrichment } = await run({ max_element_bytes: 2_000 });

      const el = result.elements[0]!;
      expect(el.members).toBeUndefined();
      // Everything else survives — withholding is per key, not per element.
      expect(el.type).toBe('relation');
      expect(el.id).toBe(148838);
      expect(el.tags).toEqual({ name: 'United States', boundary: 'administrative' });
      expect(el.withheld_keys).toEqual([
        {
          key: 'members',
          item_count: 500,
          serialized_bytes: JSON.stringify(relation.members).length,
        },
      ]);

      expect(enrichment.withheldElements).toEqual([
        {
          type: 'relation',
          id: 148838,
          keys: ['members'],
          offset: 0,
          maxElementBytes: JSON.stringify(relation).length,
        },
      ]);
      expect(enrichment.withheldNotice).toContain('relation 148838: offset 0');
    });

    it('withholds only the heavy keys it takes to fit, largest first', async () => {
      // `out geom;` gives a way both `nodes` and `geometry`; `geometry` is the
      // larger of the two, so dropping it alone must be enough here.
      const way = heavyWay(400);
      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: [way] as unknown as OverpassElement[],
      });
      const { result } = await run({ max_element_bytes: JSON.stringify(way.nodes).length + 500 });

      const el = result.elements[0]!;
      expect(el.geometry).toBeUndefined();
      expect(el.nodes).toEqual(way.nodes);
      expect((el.withheld_keys as { key: string }[]).map((w) => w.key)).toEqual(['geometry']);
    });

    it('withholds every heavy key when dropping the largest is not enough', async () => {
      const way = heavyWay(400);
      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: [way] as unknown as OverpassElement[],
      });
      const { result } = await run({ max_element_bytes: 1_000 });

      const el = result.elements[0]!;
      expect(el.geometry).toBeUndefined();
      expect(el.nodes).toBeUndefined();
      expect((el.withheld_keys as { key: string }[]).map((w) => w.key)).toEqual([
        'geometry',
        'nodes',
      ]);
      expect(el.tags).toEqual({ name: 'Space Needle', building: 'tower' });
    });

    it('returns an element serialized exactly at the budget whole', async () => {
      const relation = heavyRelation(50);
      const exact = JSON.stringify(relation).length;
      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: [relation] as unknown as OverpassElement[],
      });
      const { result, enrichment } = await run({ max_element_bytes: exact });

      expect(result.elements[0]).toEqual(relation);
      expect(result.elements[0]!.withheld_keys).toBeUndefined();
      expect(enrichment.withheldElements).toBeUndefined();
    });

    it('withholds an element one byte over the budget', async () => {
      const relation = heavyRelation(50);
      const exact = JSON.stringify(relation).length;
      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: [relation] as unknown as OverpassElement[],
      });
      const { result, enrichment } = await run({ max_element_bytes: exact - 1 });

      expect(result.elements[0]!.members).toBeUndefined();
      expect(enrichment.withheldElements).toHaveLength(1);
    });

    it('bounds only the over-budget elements on a mixed page, keeping absolute offsets', async () => {
      const small = { type: 'node', id: 7, lat: 47.6, lon: -122.3, tags: { amenity: 'cafe' } };
      const page = [small, heavyRelation(500), small, heavyWay(400, 999)];
      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: page as unknown as OverpassElement[],
      });
      // Page 2 of a 4-element match set, so the disclosed offsets must be absolute.
      const { result, enrichment } = await run({ limit: 3, offset: 1, max_element_bytes: 2_000 });

      expect(result.elements).toHaveLength(3);
      expect(result.elements[0]!.members).toBeUndefined();
      expect(result.elements[1]).toEqual(small);
      expect(result.elements[1]!.withheld_keys).toBeUndefined();
      expect(result.elements[2]!.geometry).toBeUndefined();

      expect(
        (enrichment.withheldElements as { id: number; offset: number }[]).map((w) => [
          w.id,
          w.offset,
        ]),
      ).toEqual([
        [148838, 1],
        [999, 3],
      ]);
      // #50 paging is unaffected by the bound.
      expect(enrichment.totalFound).toBe(4);
      expect(enrichment.truncated).toBe(false);
    });

    it('retrieves a withheld element whole by executing its own emitted guidance', async () => {
      const small = { type: 'node', id: 7, lat: 47.6, lon: -122.3 };
      const relation = heavyRelation(500);
      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: [small, relation, small] as unknown as OverpassElement[],
      });

      const first = await run({ limit: 3, max_element_bytes: 2_000 });
      const notice = first.enrichment.withheldNotice as string;
      // Parse the tool's own guidance rather than hand-building the follow-up.
      const recipe = /(\w+) (\d+): offset (\d+), max_element_bytes (\d+)/.exec(notice);
      expect(recipe).not.toBeNull();
      const [, type, id, offset, budget] = recipe as RegExpExecArray;
      expect(type).toBe('relation');
      expect(Number(id)).toBe(148838);
      expect(notice).toContain('limit: 1');

      const second = await run({
        limit: 1,
        offset: Number(offset),
        max_element_bytes: Number(budget),
      });
      expect(second.result.elements).toHaveLength(1);
      expect(second.result.elements[0]).toEqual(relation);
      expect(second.result.elements[0]!.withheld_keys).toBeUndefined();
      expect(second.enrichment.withheldNotice).toBeUndefined();
    });

    it('renders the withheld disclosure in content[] alongside the surviving keys', async () => {
      const relation = heavyRelation(500);
      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: [relation] as unknown as OverpassElement[],
      });
      const { result } = await run({ max_element_bytes: 2_000 });
      const text = (openstreetmapQueryRaw.format!(result)[0] as { text: string }).text;

      expect(text).toContain(
        `  Withheld over max_element_bytes: members (500 items, ${JSON.stringify(relation.members).length} bytes)`,
      );
      expect(text).toContain('Tags: name=United States');
      // The withheld array itself must not reach content[] through the generic
      // remaining-key fallback, and the disclosure must not render as a JSON blob.
      expect(text).not.toContain('"ref":1000');
      expect(text).not.toContain('withheld_keys:');
    });

    /**
     * Parity per #20, one level deeper: the withheld state has to reach a
     * `content[]`-only client with the same facts `structuredContent` carries. The
     * element line comes from `format()`, the index and recipe from the enrichment
     * trailer, so this drives the real rendering path rather than either half.
     */
    it('mirrors the withheld disclosure onto both surfaces through the tool contract', async () => {
      const relation = heavyRelation(500);
      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: [relation] as unknown as OverpassElement[],
      });
      const result = await runToolContract(openstreetmapQueryRaw, {
        query: VALID_QUERY,
        max_element_bytes: 2_000,
      });

      const bytes = JSON.stringify(relation).length;
      const text = (result.content as { text: string }[]).map((block) => block.text).join('\n');
      expect(text).toContain('Withheld over max_element_bytes: members (500 items,');
      expect(text).toContain(
        `**Withheld Elements:** relation 148838 (members) — offset 0, max_element_bytes ${bytes}`,
      );
      expect(text).toContain('limit: 1');
      expect(text).not.toContain('"ref":1000');
      // The notice reaches content[] under a human label, not its schema key.
      expect(text).toContain('**Retrieving Withheld Data:** 1 element on this page exceeded');
      expect(text).not.toContain('**withheldNotice:**');

      /**
       * #63: `effectiveQuery` was the one trailer entry on this tool with no label, so
       * it rendered under its raw key while every sibling showed a heading. The rest of
       * the block is unchanged by that fix — asserted here as the regression check.
       */
      expect(text).toContain('**Effective Query:**');
      expect(text).not.toContain('**effectiveQuery:**');
      expect(text).toContain('**Total Found:**');
      expect(text).toContain('**Results Truncated:**');

      const structured = result.structuredContent as Record<string, unknown>;
      const elements = structured.elements as Record<string, unknown>[];
      expect(elements[0]!.members).toBeUndefined();
      expect(elements[0]!.withheld_keys).toHaveLength(1);
      expect(structured.withheldElements).toHaveLength(1);
      expect(structured.withheldNotice).toContain(`max_element_bytes ${bytes}`);
    });

    /**
     * The budget is a byte budget, so a multi-byte value must be measured as the
     * bytes it costs on the wire. Every figure here is pinned against
     * `TextEncoder`, and the fixture is sized so a code-unit count would leave the
     * element under budget and return it whole.
     */
    it('measures the budget in UTF-8 bytes, not UTF-16 code units', async () => {
      const relation = {
        type: 'relation',
        id: 4242,
        members: Array.from({ length: 100 }, (_, i) => ({
          type: 'way',
          ref: 1000 + i,
          role: '東京都千代田区',
        })),
        tags: { name: 'Москва', boundary: 'administrative' },
      };
      const codeUnits = JSON.stringify(relation).length;
      const bytes = new TextEncoder().encode(JSON.stringify(relation)).byteLength;
      expect(bytes).toBeGreaterThan(codeUnits);

      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: [relation] as unknown as OverpassElement[],
      });
      // Exactly the code-unit count: whole under a `.length` measurement, over
      // budget under a byte measurement.
      const { result, enrichment } = await run({ max_element_bytes: codeUnits });

      const el = result.elements[0]!;
      expect(el.members).toBeUndefined();
      expect(el.withheld_keys).toEqual([
        {
          key: 'members',
          item_count: 100,
          serialized_bytes: new TextEncoder().encode(JSON.stringify(relation.members)).byteLength,
        },
      ]);
      expect(
        (el.withheld_keys as { serialized_bytes: number }[])[0]!.serialized_bytes,
      ).toBeGreaterThan(JSON.stringify(relation.members).length);
      expect(enrichment.withheldElements).toEqual([
        { type: 'relation', id: 4242, keys: ['members'], offset: 0, maxElementBytes: bytes },
      ]);

      // content[] carries the same byte figure the structured surface does.
      const text = (openstreetmapQueryRaw.format!(result)[0] as { text: string }).text;
      expect(text).toContain(
        `Withheld over max_element_bytes: members (100 items, ${new TextEncoder().encode(JSON.stringify(relation.members)).byteLength} bytes)`,
      );
    });

    /**
     * An element larger than the tool's own `max_element_bytes` ceiling cannot be
     * retrieved by raising the budget, so the notice must not hand the caller a
     * recipe that would fail. It names the ceiling and points at a narrower query.
     */
    it('states the ceiling instead of a recipe for an element no budget can return', async () => {
      const huge = {
        type: 'relation',
        id: 777,
        members: [{ type: 'way', ref: 1, role: 'x'.repeat(10_000_100) }],
        tags: { name: 'Oversized' },
      };
      const bytes = new TextEncoder().encode(JSON.stringify(huge)).byteLength;
      expect(bytes).toBeGreaterThan(10_000_000);

      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: [huge] as unknown as OverpassElement[],
      });
      const { result, enrichment } = await run({ max_element_bytes: 10_000_000 });

      expect(result.elements[0]!.members).toBeUndefined();
      // The true size is reported, not clamped to the ceiling.
      expect(enrichment.withheldElements).toEqual([
        { type: 'relation', id: 777, keys: ['members'], offset: 0, maxElementBytes: bytes },
      ]);

      const notice = enrichment.withheldNotice as string;
      expect(notice).toContain('relation 777');
      expect(notice).toContain('10000000');
      expect(notice).toContain('out ids;');
      expect(notice).toContain('out tags;');
      // No executable recipe: raising the budget to this element's size is refused
      // by the schema, so the notice must not print one.
      expect(notice).not.toMatch(/offset \d+, max_element_bytes \d+/);
      expect(notice).not.toContain('limit: 1');
    });

    it('speaks of a single withheld element in the singular', async () => {
      const relation = heavyRelation(500);
      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: [relation] as unknown as OverpassElement[],
      });
      const { enrichment } = await run({ max_element_bytes: 2_000 });

      const notice = enrichment.withheldNotice as string;
      expect(notice).toContain('1 element on this page exceeded');
      expect(notice).toContain('Its members, nodes and geometry arrays');
      expect(notice).not.toContain('Their');
    });

    /**
     * The bound addresses the nested-array dimension only. An over-budget element
     * carrying none of the heavy keys has nothing that can be withheld without
     * losing data the caller asked for by name, so it comes back untouched and
     * discloses nothing.
     */
    it('returns an over-budget element carrying no heavy key untouched', async () => {
      const fat = {
        type: 'node',
        id: 31,
        lat: 47.6,
        lon: -122.3,
        tags: { description: 'y'.repeat(2_000) },
      };
      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: [fat] as unknown as OverpassElement[],
      });
      const { result, enrichment } = await run({ max_element_bytes: 1_000 });

      expect(result.elements[0]).toEqual(fat);
      expect(result.elements[0]!.withheld_keys).toBeUndefined();
      expect(enrichment.withheldElements).toBeUndefined();
      expect(enrichment.withheldNotice).toBeUndefined();

      const text = (openstreetmapQueryRaw.format!(result)[0] as { text: string }).text;
      expect(text).not.toContain('Withheld over max_element_bytes');
    });

    it('applies a default budget when max_element_bytes is omitted', async () => {
      const relation = heavyRelation(4_000);
      expect(JSON.stringify(relation).length).toBeGreaterThan(DEFAULT_MAX_ELEMENT_BYTES);
      mockQuery.mockResolvedValue({
        ...responseWithTimestamp,
        elements: [relation] as unknown as OverpassElement[],
      });
      const { result } = await run({});
      expect(result.elements[0]!.members).toBeUndefined();
    });
  });

  /**
   * Regression for #51: a `[timeout:N]` written into the query string bypasses
   * the `timeout_seconds` field entirely — the handler only injects one when the
   * query lacks it — so the schema cannot reach it and it must survive to the
   * service, which is what derives the client deadline from it.
   */
  describe('in-QL timeout directive (#51)', () => {
    it('passes a hand-written [timeout:180] through untouched', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({
        query: '[out:json][timeout:180];node["natural"="peak"](47.5,-122.5,47.7,-122.2);out body;',
        timeout_seconds: 30,
      });
      await openstreetmapQueryRaw.handler(input, ctx);

      const submitted = mockQuery.mock.calls[0]?.[0] as string;
      expect(submitted).toContain('[timeout:180]');
      expect(submitted).not.toContain('[timeout:30]');
      expect(getEnrichment(ctx).effectiveQuery).toContain('[timeout:180]');
    });

    it('accepts timeout_seconds at the advertised 180s ceiling', () => {
      expect(() =>
        openstreetmapQueryRaw.input.parse({ query: VALID_QUERY, timeout_seconds: 180 }),
      ).not.toThrow();
    });
  });

  /**
   * The `offset` description tells callers the element count past which paging
   * re-queries instead of reading cache. That number is the service's cache
   * ceiling, so the two drift apart silently unless something holds them together.
   */
  it('quotes the service cache ceiling verbatim in the offset description', () => {
    const offsetField = openstreetmapQueryRaw.input.shape.offset;
    expect(offsetField.description).toContain(String(CACHE_MAX_ELEMENTS));
  });

  describe('format', () => {
    it('renders elements with type, id, and tags', () => {
      const output = {
        elements: [
          {
            type: 'node',
            id: 987654321,
            lat: 47.62,
            lon: -122.35,
            tags: { natural: 'peak', name: 'Mt Rainier' },
          },
        ],
        total_elements: 1,
        data_timestamp: '2025-03-01T12:00:00Z',
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      expect(blocks[0]!.type).toBe('text');
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('1 element returned');
      expect(text).toContain('node');
      expect(text).toContain('987654321');
      expect(text).toContain('Mt Rainier');
      expect(text).toContain('natural=peak');
      expect(text).toContain('Coordinates: 47.62, -122.35');
      expect(text).toContain('2025-03-01');
      expect(text).toContain('OpenStreetMap');
    });

    it('renders "elements returned" in singular for one element', () => {
      const output = {
        elements: [{ type: 'node', id: 1 }],
        total_elements: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('1 element returned');
    });

    it('renders all elements without truncating at 50 (#20)', () => {
      const elements = Array.from({ length: 75 }, (_, i) => ({
        type: 'node',
        id: i + 1,
        lat: 47.6,
        lon: -122.3,
      }));
      const output = {
        elements,
        total_elements: 75,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('**node** 75');
      expect(text).not.toContain('more elements');
    });

    it('omits the coordinates line for elements without lat/lon (#20)', () => {
      const output = {
        elements: [{ type: 'way', id: 5, tags: { highway: 'residential' } }],
        total_elements: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).not.toContain('Coordinates:');
      expect(text).toContain('highway=residential');
    });

    it('omits data_timestamp line when absent', () => {
      const output = {
        elements: [{ type: 'node', id: 1 }],
        total_elements: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).not.toContain('Data as of:');
    });

    it('renders a way element nodes array in content[] (#20)', () => {
      const output = {
        elements: [
          {
            type: 'way',
            id: 12903132,
            nodes: [825308606, 118329594, 825308607],
            tags: { name: 'Space Needle', building: 'tower' },
          },
        ],
        total_elements: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Space Needle');
      // The full nodes array must reach content[], not just structuredContent.
      expect(text).toContain('nodes:');
      expect(text).toContain('825308606');
      expect(text).toContain('118329594');
      expect(text).toContain('825308607');
    });

    it('renders out-meta fields (timestamp/version/changeset/user/uid) in content[] (#20)', () => {
      const output = {
        elements: [
          {
            type: 'node',
            id: 663911505,
            lat: 47.599091,
            lon: -122.331856,
            timestamp: '2024-01-15T12:00:00Z',
            version: 7,
            changeset: 145678901,
            user: 'osm_mapper',
            uid: 42,
            tags: { amenity: 'cafe' },
          },
        ],
        total_elements: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      const text = (blocks[0] as { text: string }).text;
      // Existing readable lines still render.
      expect(text).toContain('Coordinates: 47.599091, -122.331856');
      expect(text).toContain('amenity=cafe');
      // Every out-meta field also reaches content[].
      expect(text).toContain('timestamp: 2024-01-15T12:00:00Z');
      expect(text).toContain('version: 7');
      expect(text).toContain('changeset: 145678901');
      expect(text).toContain('user: osm_mapper');
      expect(text).toContain('uid: 42');
    });
  });
});
