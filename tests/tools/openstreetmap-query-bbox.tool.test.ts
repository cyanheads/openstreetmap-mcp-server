/**
 * @fileoverview Tests for the openstreetmap-query-bbox tool.
 * @module tests/tools/openstreetmap-query-bbox.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapQueryBbox } from '@/mcp-server/tools/definitions/openstreetmap-query-bbox.tool.js';
import type { OverpassElement, OverpassPoi, OverpassResponse } from '@/services/overpass/types.js';

// --- service mock --------------------------------------------------------

const mockBuildBboxQuery = vi.fn<() => string>(
  () =>
    '[out:json][timeout:25];(node["amenity"="pharmacy"](47.5,-122.5,47.7,-122.2););out center tags;',
);
const mockQuery = vi.fn<() => Promise<OverpassResponse>>();
const mockNormalizeElements = vi.fn<(els: OverpassElement[]) => OverpassPoi[]>();

vi.mock('@/services/overpass/overpass-service.js', () => ({
  getOverpassService: () => ({
    buildBboxQuery: mockBuildBboxQuery,
    query: mockQuery,
    normalizeElements: mockNormalizeElements,
  }),
}));

// --- fixtures ------------------------------------------------------------

const mockElement: OverpassElement = {
  type: 'way',
  id: 444555666,
  center: { lat: 47.62, lon: -122.35 },
  tags: { amenity: 'pharmacy', name: 'Green Pharmacy' },
};

const mockPoi: OverpassPoi = {
  osm_type: 'way',
  osm_id: 444555666,
  lat: 47.62,
  lon: -122.35,
  name: 'Green Pharmacy',
  tags: { amenity: 'pharmacy', name: 'Green Pharmacy' },
};

const mockResponse: OverpassResponse = {
  version: 0.6,
  osm3s: { timestamp_osm_base: '2025-02-01T00:00:00Z' },
  elements: [mockElement],
};

// -------------------------------------------------------------------------

describe('openstreetmapQueryBbox', () => {
  beforeEach(() => {
    mockBuildBboxQuery.mockReset().mockReturnValue('[out:json]');
    mockQuery.mockReset().mockResolvedValue(mockResponse);
    mockNormalizeElements.mockReset().mockReturnValue([mockPoi]);
  });

  describe('happy path — amenity shortcut', () => {
    it('returns features within the bounding box', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'pharmacy',
      });
      const result = await openstreetmapQueryBbox.handler(input, ctx);

      expect(result.elements).toHaveLength(1);
      expect(result.elements[0]).toMatchObject({
        osm_type: 'way',
        osm_id: 444555666,
        name: 'Green Pharmacy',
      });
      expect(result.data_timestamp).toBe('2025-02-01T00:00:00Z');
      expect(result.attribution).toContain('OpenStreetMap');

      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalFound).toBe(1);
      expect(enrichment.truncated).toBe(false);
    });

    it('passes correct bbox parameters to buildBboxQuery', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'cafe',
        element_types: ['node'],
        timeout_seconds: 40,
      });
      await openstreetmapQueryBbox.handler(input, ctx);
      expect(mockBuildBboxQuery).toHaveBeenCalledWith({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        tagKey: 'amenity',
        tagValue: 'cafe',
        elementTypes: ['node'],
        timeoutSeconds: 40,
      });
    });
  });

  describe('happy path — tag_key/tag_value', () => {
    it('uses tag_key and tag_value when amenity is absent', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        tag_key: 'natural',
        tag_value: 'peak',
      });
      await openstreetmapQueryBbox.handler(input, ctx);
      expect(mockBuildBboxQuery).toHaveBeenCalledWith(
        expect.objectContaining({ tagKey: 'natural', tagValue: 'peak' }),
      );
    });
  });

  describe('truncation', () => {
    it('marks result as truncated when more features exist than the limit', async () => {
      const pois: OverpassPoi[] = Array.from({ length: 30 }, (_, i) => ({
        osm_type: 'node' as const,
        osm_id: i + 1,
        tags: { amenity: 'cafe' },
      }));
      mockNormalizeElements.mockReturnValue(pois);

      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'cafe',
        limit: 20,
      });
      const result = await openstreetmapQueryBbox.handler(input, ctx);
      expect(result.elements).toHaveLength(20);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalFound).toBe(30);
      expect(enrichment.truncated).toBe(true);
    });
  });

  describe('enrichment', () => {
    it('echoes effective tag via enrichment for amenity shortcut', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'pharmacy',
      });
      await openstreetmapQueryBbox.handler(input, ctx);
      expect(getEnrichment(ctx).effectiveTag).toBe('amenity=pharmacy');
    });

    it('sets notice when no results are returned', async () => {
      mockNormalizeElements.mockReturnValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        tag_key: 'natural',
        tag_value: 'volcano',
      });
      await openstreetmapQueryBbox.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveTag).toBe('natural=volcano');
      expect(enrichment.notice).toContain('No natural=volcano features found');
    });
  });

  describe('missing timestamp fallback', () => {
    it('uses current ISO timestamp when osm3s is absent', async () => {
      mockQuery.mockResolvedValue({ version: 0.6, elements: [mockElement] });
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'cafe',
      });
      const result = await openstreetmapQueryBbox.handler(input, ctx);
      expect(result.data_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('error paths', () => {
    it('throws invalid_tag when amenity and tag_key are combined', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'cafe',
        tag_key: 'leisure',
        tag_value: 'park',
      });
      await expect(openstreetmapQueryBbox.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_tag' },
      });
    });

    it('throws invalid_tag when tag_key is provided without tag_value', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        tag_key: 'leisure',
      });
      await expect(openstreetmapQueryBbox.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_tag' },
      });
    });

    it('throws invalid_tag when neither amenity nor tag_key is provided', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
      });
      await expect(openstreetmapQueryBbox.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_tag' },
      });
    });

    it('propagates service errors', async () => {
      mockQuery.mockRejectedValue(new Error('Overpass 503'));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'cafe',
      });
      await expect(openstreetmapQueryBbox.handler(input, ctx)).rejects.toThrow('Overpass 503');
    });

    it('remaps query_timeout service error to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(JsonRpcErrorCode.Timeout, 'Overpass query timed out: runtime error', {
          reason: 'query_timeout',
        }),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'cafe',
      });
      const err = await openstreetmapQueryBbox.handler(input, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('query_timeout');
      expect(err.data.recovery?.hint).toBeDefined();
      expect(typeof err.data.recovery.hint).toBe('string');
    });

    it('remaps result_too_large service error to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass ran out of memory: runtime error',
          { reason: 'result_too_large' },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'cafe',
      });
      const err = await openstreetmapQueryBbox.handler(input, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('result_too_large');
      expect(err.data.recovery?.hint).toBeDefined();
    });

    it('remaps rate_limited service error to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass returned an HTML page instead of JSON — likely rate-limited.',
          { reason: 'rate_limited' },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'cafe',
      });
      const err = await openstreetmapQueryBbox.handler(input, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('rate_limited');
      expect(err.data.recovery?.hint).toBeDefined();
    });

    it('remaps upstream_error service error to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass reported an error: runtime error: Dispatcher_Client::request_read_and_idx::timeout',
          { reason: 'upstream_error' },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'cafe',
      });
      const err = await openstreetmapQueryBbox.handler(input, ctx).catch((e) => e);
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
    const run = async (status: number, code: JsonRpcErrorCode) => {
      mockQuery.mockRejectedValue(
        new McpError(code, `Overpass returned HTTP ${status}.`, { status, statusText: 'Error' }),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'cafe',
      });
      return (await openstreetmapQueryBbox.handler(input, ctx).catch((e) => e)) as McpError;
    };

    it('maps 504 to overpass_gateway_timeout, keeping the Timeout code', async () => {
      const err = await run(504, JsonRpcErrorCode.Timeout);
      expect(err.data?.reason).toBe('overpass_gateway_timeout');
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
      expect(hint).toContain('reduce the bounding box area');
      expect(hint).toContain('timeout_seconds');
    });

    it('maps 502 to overpass_unavailable, keeping the ServiceUnavailable code', async () => {
      const err = await run(502, JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data?.reason).toBe('overpass_unavailable');
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
      expect(hint).toContain('OSM_OVERPASS_BASE_URL');
      expect(hint).toContain('retry unchanged');
    });

    it('maps 503 to overpass_unavailable', async () => {
      expect((await run(503, JsonRpcErrorCode.ServiceUnavailable)).data?.reason).toBe(
        'overpass_unavailable',
      );
    });

    // 500/501 classify as InternalError upstream; the reason must still land, and
    // the code must not be rewritten to the contract's ServiceUnavailable.
    it('maps 500 to overpass_unavailable without collapsing its InternalError code', async () => {
      const err = await run(500, JsonRpcErrorCode.InternalError);
      expect(err.data?.reason).toBe('overpass_unavailable');
      expect(err.code).toBe(JsonRpcErrorCode.InternalError);
    });

    // A 4xx other than 429 is not an availability problem — it must not be
    // relabelled as one.
    it('leaves a non-5xx status the contract does not cover untouched', async () => {
      const err = await run(403, JsonRpcErrorCode.Forbidden);
      expect(err.data?.reason).toBeUndefined();
      expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    });
  });

  describe('metacharacter rejection (#14)', () => {
    const INJECTION = 'cafe"]["name"="Cafe Bee';
    const bbox = { south: 47.5, west: -122.5, north: 47.7, east: -122.2 };

    it('rejects metacharacters supplied via tag_value with invalid_tag', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        ...bbox,
        tag_key: 'amenity',
        tag_value: INJECTION,
      });
      await expect(openstreetmapQueryBbox.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_tag' },
      });
      // The injection never reaches the Overpass service.
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects metacharacters supplied via tag_key with invalid_tag', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        ...bbox,
        tag_key: 'amenity"]["name',
        tag_value: 'cafe',
      });
      await expect(openstreetmapQueryBbox.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_tag' },
      });
    });

    it('rejects metacharacters supplied via the amenity shortcut with invalid_tag', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({ ...bbox, amenity: INJECTION });
      await expect(openstreetmapQueryBbox.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_tag' },
      });
    });
  });

  describe('invalid bbox geometry (#22)', () => {
    it('throws invalid_bbox when south exceeds north, before touching Overpass', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        south: 47.615,
        west: -122.335,
        north: 47.609,
        east: -122.325,
        amenity: 'cafe',
        limit: 3,
      });
      const err = await openstreetmapQueryBbox.handler(input, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('invalid_bbox');
      expect(err.data.recovery?.hint).toBeDefined();
      expect(typeof err.data.recovery.hint).toBe('string');
      // Invalid geometry is rejected before building or sending the query.
      expect(mockBuildBboxQuery).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('passes an antimeridian box (west > east) through the guard to buildBboxQuery', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      // Bering Strait crossing: south < north is valid, but west (170) > east (-170).
      const input = openstreetmapQueryBbox.input.parse({
        south: 65,
        west: 170,
        north: 66,
        east: -170,
        tag_key: 'natural',
        tag_value: 'peak',
      });
      await openstreetmapQueryBbox.handler(input, ctx);
      expect(mockBuildBboxQuery).toHaveBeenCalledWith(
        expect.objectContaining({ south: 65, west: 170, north: 66, east: -170 }),
      );
    });
  });

  describe('offset paging (#24)', () => {
    const bbox = { south: 47.5, west: -122.5, north: 47.7, east: -122.2 };
    const makePois = (n: number): OverpassPoi[] =>
      Array.from({ length: n }, (_, i) => ({
        osm_type: 'node' as const,
        osm_id: i + 1,
        tags: { amenity: 'cafe' },
      }));

    it('re-slices at the offset and recomputes truncated + nextOffset', async () => {
      mockNormalizeElements.mockReturnValue(makePois(30));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        ...bbox,
        amenity: 'cafe',
        limit: 10,
        offset: 10,
      });
      const result = await openstreetmapQueryBbox.handler(input, ctx);

      // Page 2 = element IDs 11..20 (offset 10, limit 10), NOT the offset-0 page.
      expect(result.elements.map((e) => e.osm_id)).toEqual([
        11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalFound).toBe(30);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.nextOffset).toBe(20);
    });

    it('clears truncated and omits nextOffset on the final page', async () => {
      mockNormalizeElements.mockReturnValue(makePois(15));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        ...bbox,
        amenity: 'cafe',
        limit: 10,
        offset: 10,
      });
      const result = await openstreetmapQueryBbox.handler(input, ctx);

      // Only IDs 11..15 remain past offset 10.
      expect(result.elements.map((e) => e.osm_id)).toEqual([11, 12, 13, 14, 15]);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(false);
      expect(enrichment.nextOffset).toBeUndefined();
    });

    it('offset=0 (default) reproduces the pre-offset slice and truncation', async () => {
      mockNormalizeElements.mockReturnValue(makePois(30));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({ ...bbox, amenity: 'cafe', limit: 20 });
      const result = await openstreetmapQueryBbox.handler(input, ctx);

      expect(result.elements.map((e) => e.osm_id)[0]).toBe(1);
      expect(result.elements).toHaveLength(20);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.nextOffset).toBe(20);
    });
  });

  describe('exhausted offset (#27)', () => {
    const exhaustedBbox = { south: 47.618, west: -122.352, north: 47.623, east: -122.346 };
    const makePois = (n: number): OverpassPoi[] =>
      Array.from({ length: n }, (_, i) => ({
        osm_type: 'node' as const,
        osm_id: i + 1,
        tags: { amenity: 'cafe' },
      }));

    it('reports the offset as past the end instead of blaming the bounding box', async () => {
      mockNormalizeElements.mockReturnValue(makePois(7));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const input = openstreetmapQueryBbox.input.parse({
        ...exhaustedBbox,
        amenity: 'cafe',
        limit: 2,
        offset: 999,
      });
      const result = await openstreetmapQueryBbox.handler(input, ctx);

      expect(result.elements).toEqual([]);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalFound).toBe(7);
      expect(enrichment.truncated).toBe(false);
      // Reports the real match count and a valid retry offset (7 matches, limit 2 → 5).
      expect(enrichment.notice).toContain('Offset 999 is past the end');
      expect(enrichment.notice).toContain('7 amenity=cafe features matched');
      expect(enrichment.notice).toContain('offset 5');
      expect(enrichment.notice).not.toContain('Try a larger bbox');
    });

    it('emits notice text distinct from the genuine zero-match case', async () => {
      const noticeFor = async (pois: OverpassPoi[], offset: number) => {
        mockNormalizeElements.mockReturnValue(pois);
        const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
        const input = openstreetmapQueryBbox.input.parse({
          ...exhaustedBbox,
          amenity: 'cafe',
          limit: 2,
          offset,
        });
        await openstreetmapQueryBbox.handler(input, ctx);
        return getEnrichment(ctx).notice as string;
      };

      const exhausted = await noticeFor(makePois(7), 999);
      const zeroMatch = await noticeFor([], 0);

      expect(zeroMatch).toContain('No amenity=cafe features found');
      expect(exhausted).not.toBe(zeroMatch);
    });
  });

  describe('format', () => {
    it('renders element with all key fields', () => {
      const output = {
        elements: [
          {
            osm_type: 'way' as const,
            osm_id: 444555666,
            lat: 47.62,
            lon: -122.35,
            name: 'Green Pharmacy',
            tags: { amenity: 'pharmacy', name: 'Green Pharmacy' },
          },
        ],
        data_timestamp: '2025-02-01T00:00:00Z',
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryBbox.format!(output);
      expect(blocks[0]!.type).toBe('text');
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Green Pharmacy');
      expect(text).toContain('W444555666');
      expect(text).toContain('47.62');
      expect(text).toContain('-122.35');
      expect(text).toContain('amenity=pharmacy');
      expect(text).toContain('OpenStreetMap');
    });

    it('renders the returned count in the header', () => {
      const output = {
        elements: [{ osm_type: 'node' as const, osm_id: 1, tags: { amenity: 'cafe' } }],
        data_timestamp: '2025-02-01T00:00:00Z',
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryBbox.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('1 feature returned');
    });
  });
});
