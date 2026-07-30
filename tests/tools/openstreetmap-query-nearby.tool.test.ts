/**
 * @fileoverview Tests for the openstreetmap-query-nearby tool.
 * @module tests/tools/openstreetmap-query-nearby.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapQueryNearby } from '@/mcp-server/tools/definitions/openstreetmap-query-nearby.tool.js';
import type { OverpassElement, OverpassPoi, OverpassResponse } from '@/services/overpass/types.js';

// --- service mock --------------------------------------------------------

const mockBuildAroundQuery = vi.fn<() => string>(
  () =>
    '[out:json][timeout:25];(node["amenity"="cafe"](around:1000,47.6,-122.3););out center tags;',
);
const mockQuery = vi.fn<() => Promise<OverpassResponse>>();
const mockNormalizeElements = vi.fn<(els: OverpassElement[]) => OverpassPoi[]>();

// Mock only getOverpassService; keep the real haversineMeters so distance ranking is exercised.
vi.mock('@/services/overpass/overpass-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/overpass/overpass-service.js')>();
  return {
    ...actual,
    getOverpassService: () => ({
      buildAroundQuery: mockBuildAroundQuery,
      query: mockQuery,
      normalizeElements: mockNormalizeElements,
    }),
  };
});

// --- fixtures ------------------------------------------------------------

const mockElement: OverpassElement = {
  type: 'node',
  id: 111222333,
  lat: 47.6105,
  lon: -122.3442,
  tags: { amenity: 'cafe', name: 'Coffee House' },
};

const mockPoi: OverpassPoi = {
  osm_type: 'node',
  osm_id: 111222333,
  lat: 47.6105,
  lon: -122.3442,
  name: 'Coffee House',
  tags: { amenity: 'cafe', name: 'Coffee House' },
};

const mockResponse: OverpassResponse = {
  version: 0.6,
  osm3s: { timestamp_osm_base: '2025-01-01T00:00:00Z' },
  elements: [mockElement],
};

/** Overpass states the cause of a 5xx in the same `Error:` shape as a 400. */
const OVERPASS_504_BODY = [
  '<p>The data included in this document is from www.openstreetmap.org.</p>',
  '<p><strong style="color:#FF0000">Error</strong>: runtime error: Dispatcher_Client::request_read_and_idx::timeout. Probably the server is overloaded. </p>',
].join('\n');

/** A 5xx from a proxy in front of Overpass — no error line to extract. */
const NON_OVERPASS_5XX_BODY =
  '<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>';

// -------------------------------------------------------------------------

describe('openstreetmapQueryNearby', () => {
  beforeEach(() => {
    mockBuildAroundQuery.mockReset().mockReturnValue('[out:json]');
    mockQuery.mockReset().mockResolvedValue(mockResponse);
    mockNormalizeElements.mockReset().mockReturnValue([mockPoi]);
  });

  describe('happy path — amenity shortcut', () => {
    it('returns nearby features for amenity query', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
      });
      const result = await openstreetmapQueryNearby.handler(input, ctx);

      expect(result.elements).toHaveLength(1);
      expect(result.elements[0]).toMatchObject({
        osm_type: 'node',
        osm_id: 111222333,
        lat: 47.6105,
        lon: -122.3442,
        name: 'Coffee House',
      });
      expect(result.data_timestamp).toBe('2025-01-01T00:00:00Z');
      expect(result.attribution).toContain('OpenStreetMap');
      expect(result.elements[0]!.distance_meters).toBeGreaterThan(0);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveTag).toBe('amenity=cafe');
      expect(enrichment.totalFound).toBe(1);
      expect(enrichment.truncated).toBe(false);
      expect(enrichment.notice).toBeUndefined();
    });

    it('passes correct parameters to buildAroundQuery', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'hospital',
        radius_meters: 2000,
        element_types: ['node', 'way', 'relation'],
        timeout_seconds: 30,
      });
      await openstreetmapQueryNearby.handler(input, ctx);
      expect(mockBuildAroundQuery).toHaveBeenCalledWith({
        lat: 47.6,
        lon: -122.3,
        radiusMeters: 2000,
        tagKey: 'amenity',
        tagValue: 'hospital',
        elementTypes: ['node', 'way', 'relation'],
        timeoutSeconds: 30,
      });
    });
  });

  describe('happy path — tag_key/tag_value', () => {
    it('uses tag_key and tag_value when amenity is absent', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        tag_key: 'leisure',
        tag_value: 'park',
      });
      await openstreetmapQueryNearby.handler(input, ctx);
      expect(mockBuildAroundQuery).toHaveBeenCalledWith(
        expect.objectContaining({ tagKey: 'leisure', tagValue: 'park' }),
      );
    });
  });

  describe('truncation', () => {
    it('marks result as truncated when Overpass returns more than the limit', async () => {
      const pois: OverpassPoi[] = Array.from({ length: 25 }, (_, i) => ({
        osm_type: 'node',
        osm_id: i + 1,
        tags: { amenity: 'cafe' },
      }));
      mockNormalizeElements.mockReturnValue(pois);

      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
        limit: 20,
      });
      const result = await openstreetmapQueryNearby.handler(input, ctx);

      expect(result.elements).toHaveLength(20);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalFound).toBe(25);
      expect(enrichment.truncated).toBe(true);
    });
  });

  describe('distance ranking', () => {
    const center = { lat: 47.6094, lon: -122.3414 };

    it('sorts results nearest-first by distance from the center', async () => {
      const far: OverpassPoi = {
        osm_type: 'node',
        osm_id: 1,
        lat: 47.6116,
        lon: -122.3413,
        name: 'Far',
        tags: { amenity: 'cafe' },
      };
      const near: OverpassPoi = {
        osm_type: 'node',
        osm_id: 2,
        lat: 47.60941,
        lon: -122.34142,
        name: 'Near',
        tags: { amenity: 'cafe' },
      };
      const mid: OverpassPoi = {
        osm_type: 'node',
        osm_id: 3,
        lat: 47.6099,
        lon: -122.3414,
        name: 'Mid',
        tags: { amenity: 'cafe' },
      };
      // Supplied in element-ID order (far, near, mid) — i.e. NOT distance order.
      mockNormalizeElements.mockReturnValue([far, near, mid]);

      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({ ...center, amenity: 'cafe' });
      const result = await openstreetmapQueryNearby.handler(input, ctx);

      expect(result.elements.map((e) => e.name)).toEqual(['Near', 'Mid', 'Far']);
      expect(result.elements[0]!.distance_meters!).toBeLessThan(
        result.elements[1]!.distance_meters!,
      );
      expect(result.elements[1]!.distance_meters!).toBeLessThan(
        result.elements[2]!.distance_meters!,
      );
    });

    it('truncates AFTER sorting, so limit keeps the nearest N (not the lowest element IDs)', async () => {
      // The nearest cafe has the HIGHEST element ID — worst case for id-order truncation.
      const pois: OverpassPoi[] = [
        {
          osm_type: 'node',
          osm_id: 10,
          lat: 47.614,
          lon: -122.3414,
          name: 'Furthest',
          tags: { amenity: 'cafe' },
        },
        {
          osm_type: 'node',
          osm_id: 20,
          lat: 47.613,
          lon: -122.3414,
          name: 'B',
          tags: { amenity: 'cafe' },
        },
        {
          osm_type: 'node',
          osm_id: 30,
          lat: 47.612,
          lon: -122.3414,
          name: 'C',
          tags: { amenity: 'cafe' },
        },
        {
          osm_type: 'node',
          osm_id: 40,
          lat: 47.611,
          lon: -122.3414,
          name: 'D',
          tags: { amenity: 'cafe' },
        },
        {
          osm_type: 'node',
          osm_id: 50,
          lat: 47.60941,
          lon: -122.3414,
          name: 'Nearest',
          tags: { amenity: 'cafe' },
        },
      ];
      mockNormalizeElements.mockReturnValue(pois);

      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({ ...center, amenity: 'cafe', limit: 2 });
      const result = await openstreetmapQueryNearby.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalFound).toBe(5);
      expect(enrichment.truncated).toBe(true);
      expect(result.elements.map((e) => e.name)).toEqual(['Nearest', 'D']);
    });

    it('places coordinate-less elements last with no distance_meters', async () => {
      const withCoord: OverpassPoi = {
        osm_type: 'node',
        osm_id: 1,
        lat: 47.6099,
        lon: -122.3414,
        name: 'HasCoord',
        tags: { amenity: 'cafe' },
      };
      const noCoord: OverpassPoi = {
        osm_type: 'relation',
        osm_id: 2,
        name: 'NoCoord',
        tags: { amenity: 'cafe' },
      };
      mockNormalizeElements.mockReturnValue([noCoord, withCoord]);

      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({ ...center, amenity: 'cafe' });
      const result = await openstreetmapQueryNearby.handler(input, ctx);

      expect(result.elements[0]!.name).toBe('HasCoord');
      expect(result.elements[0]!.distance_meters).toBeGreaterThan(0);
      expect(result.elements[1]!.name).toBe('NoCoord');
      expect(result.elements[1]!.distance_meters).toBeUndefined();
    });
  });

  describe('enrichment', () => {
    it('echoes effective tag via enrichment', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        tag_key: 'leisure',
        tag_value: 'park',
      });
      await openstreetmapQueryNearby.handler(input, ctx);
      expect(getEnrichment(ctx).effectiveTag).toBe('leisure=park');
    });

    it('sets notice when no results are returned', async () => {
      mockNormalizeElements.mockReturnValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'atm',
      });
      await openstreetmapQueryNearby.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveTag).toBe('amenity=atm');
      expect(enrichment.notice).toContain('No amenity=atm features found');
    });
  });

  /**
   * Regression for #43: the handler substituted `new Date().toISOString()` when the
   * response carried no `osm3s`, presenting the moment of the call as the age of the
   * OSM extract — the most optimistic answer available, produced precisely when the
   * endpoint reported no freshness metadata at all.
   */
  describe('absent freshness metadata (#43)', () => {
    const center = { lat: 47.6, lon: -122.3, amenity: 'pharmacy' };

    it('omits data_timestamp when the response carries no osm3s block', async () => {
      mockQuery.mockResolvedValue({ version: 0.6, elements: [mockElement] });
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse(center);
      const result = await openstreetmapQueryNearby.handler(input, ctx);
      expect(result.data_timestamp).toBeUndefined();
      expect('data_timestamp' in result).toBe(false);
    });

    /**
     * The service caches the raw response and the tool derives the timestamp per
     * call, so a fabricated value differed on every read of one cached entry — two
     * calls over identical data reporting two different freshness times.
     */
    it('stays absent across repeated calls over the same cached response', async () => {
      mockQuery.mockResolvedValue({ version: 0.6, elements: [mockElement] });
      const input = openstreetmapQueryNearby.input.parse(center);
      const first = await openstreetmapQueryNearby.handler(
        input,
        createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors }),
      );
      const second = await openstreetmapQueryNearby.handler(
        input,
        createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors }),
      );
      expect(first.data_timestamp).toBeUndefined();
      expect(second.data_timestamp).toBe(first.data_timestamp);
    });
  });

  describe('error paths', () => {
    it('throws invalid_tag when amenity and tag_key are combined', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
        tag_key: 'leisure',
        tag_value: 'park',
      });
      await expect(openstreetmapQueryNearby.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_tag' },
      });
    });

    it('throws invalid_tag when neither amenity nor tag_key is provided', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({ lat: 47.6, lon: -122.3 });
      await expect(openstreetmapQueryNearby.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_tag' },
      });
    });

    it('throws invalid_tag when tag_key is provided without tag_value', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        tag_key: 'leisure',
      });
      await expect(openstreetmapQueryNearby.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_tag' },
      });
    });

    it('propagates service errors', async () => {
      mockQuery.mockRejectedValue(new Error('Overpass unavailable'));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
      });
      await expect(openstreetmapQueryNearby.handler(input, ctx)).rejects.toThrow(
        'Overpass unavailable',
      );
    });

    it('remaps query_timeout service error to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(JsonRpcErrorCode.Timeout, 'Overpass query timed out: runtime error', {
          reason: 'query_timeout',
        }),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
      });
      const err = await openstreetmapQueryNearby.handler(input, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('query_timeout');
      expect(err.data.recovery?.hint).toBeDefined();
      expect(typeof err.data.recovery.hint).toBe('string');
    });

    it('remaps rate_limited service error to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass API returned HTTP 429 — all query slots occupied.',
          { reason: 'rate_limited' },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
      });
      const err = await openstreetmapQueryNearby.handler(input, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('rate_limited');
      expect(err.data.recovery?.hint).toBeDefined();
    });

    it('remaps result_too_large service error to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass ran out of memory: runtime error',
          { reason: 'result_too_large' },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
      });
      const err = await openstreetmapQueryNearby.handler(input, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('result_too_large');
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
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
      });
      const err = await openstreetmapQueryNearby.handler(input, ctx).catch((e) => e);
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
    const run = async (status: number, code: JsonRpcErrorCode, body?: string) => {
      mockQuery.mockRejectedValue(
        new McpError(code, `Overpass returned HTTP ${status}.`, {
          status,
          statusText: 'Error',
          ...(body === undefined ? {} : { body, responseBody: body }),
        }),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
      });
      return (await openstreetmapQueryNearby.handler(input, ctx).catch((e) => e)) as McpError;
    };

    it('maps 504 to overpass_gateway_timeout, keeping the Timeout code', async () => {
      const err = await run(504, JsonRpcErrorCode.Timeout);
      expect(err.data?.reason).toBe('overpass_gateway_timeout');
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      const hint = (err.data as { recovery: { hint: string } }).recovery.hint;
      expect(hint).toContain('reduce radius_meters');
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

    /**
     * Regression for #46: the cause Overpass states in the 5xx body reached the
     * agent only as unparsed XHTML under `error.data.body`, duplicated under the
     * legacy `responseBody` alias, while the raw-query tool put the same line in its
     * message.
     */
    it('appends the runtime-error cause Overpass states in the 5xx body', async () => {
      const err = await run(504, JsonRpcErrorCode.Timeout, OVERPASS_504_BODY);
      expect(err.message).toContain('Probably the server is overloaded.');
      expect(err.message).toContain('Dispatcher_Client');
      expect(err.message).not.toContain('<');
    });

    it('drops the captured body from the error data once the cause is in the message', async () => {
      const err = await run(504, JsonRpcErrorCode.Timeout, OVERPASS_504_BODY);
      const data = err.data as Record<string, unknown>;
      expect(data.body).toBeUndefined();
      expect(data.responseBody).toBeUndefined();
      // The status fields the agent classifies on are unaffected.
      expect(data.status).toBe(504);
      expect(data.statusText).toBe('Error');
    });

    it('keeps the bare status message when the 5xx body carries no error line', async () => {
      const err = await run(502, JsonRpcErrorCode.ServiceUnavailable, NON_OVERPASS_5XX_BODY);
      expect(err.message).toBe('Overpass returned HTTP 502.');
      expect((err.data as Record<string, unknown>).body).toBeUndefined();
    });
  });

  describe('metacharacter rejection (#14)', () => {
    const INJECTION = 'cafe"]["name"="Cafe Bee';

    it('rejects metacharacters supplied via tag_value with invalid_tag', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6205,
        lon: -122.3493,
        tag_key: 'amenity',
        tag_value: INJECTION,
      });
      await expect(openstreetmapQueryNearby.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_tag' },
      });
      // The injection never reaches the Overpass service.
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects metacharacters supplied via tag_key with invalid_tag', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6205,
        lon: -122.3493,
        tag_key: 'amenity"]["name',
        tag_value: 'cafe',
      });
      await expect(openstreetmapQueryNearby.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_tag' },
      });
    });

    it('rejects metacharacters supplied via the amenity shortcut with invalid_tag', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6205,
        lon: -122.3493,
        amenity: INJECTION,
      });
      await expect(openstreetmapQueryNearby.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_tag' },
      });
    });
  });

  describe('offset paging (#24)', () => {
    const center = { lat: 47.6, lon: -122.3 };
    // Cafes at strictly increasing distance: id N sits N*0.001° north of center,
    // so the distance sort yields ascending id order deterministically.
    const makePois = (n: number): OverpassPoi[] =>
      Array.from({ length: n }, (_, i) => ({
        osm_type: 'node' as const,
        osm_id: i + 1,
        lat: center.lat + (i + 1) * 0.001,
        lon: center.lon,
        tags: { amenity: 'cafe' },
      }));

    it('re-slices the distance-sorted set at the offset and sets nextOffset', async () => {
      mockNormalizeElements.mockReturnValue(makePois(30));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        ...center,
        amenity: 'cafe',
        limit: 5,
        offset: 5,
      });
      const result = await openstreetmapQueryNearby.handler(input, ctx);

      // Nearest 5 (ids 1..5) skipped; page 2 = ids 6..10 by distance.
      expect(result.elements.map((e) => e.osm_id)).toEqual([6, 7, 8, 9, 10]);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalFound).toBe(30);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.nextOffset).toBe(10);
    });

    it('clears truncated and omits nextOffset when the offset page is the last', async () => {
      mockNormalizeElements.mockReturnValue(makePois(8));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        ...center,
        amenity: 'cafe',
        limit: 5,
        offset: 5,
      });
      const result = await openstreetmapQueryNearby.handler(input, ctx);

      // Only ids 6..8 remain past offset 5.
      expect(result.elements.map((e) => e.osm_id)).toEqual([6, 7, 8]);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(false);
      expect(enrichment.nextOffset).toBeUndefined();
    });
  });

  describe('exhausted offset (#27)', () => {
    const center = { lat: 47.6, lon: -122.3 };
    const makePois = (n: number): OverpassPoi[] =>
      Array.from({ length: n }, (_, i) => ({
        osm_type: 'node' as const,
        osm_id: i + 1,
        lat: center.lat + (i + 1) * 0.001,
        lon: center.lon,
        tags: { amenity: 'cafe' },
      }));

    it('reports the offset as past the end instead of blaming the query', async () => {
      mockNormalizeElements.mockReturnValue(makePois(7));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        ...center,
        amenity: 'cafe',
        radius_meters: 300,
        limit: 2,
        offset: 999,
      });
      const result = await openstreetmapQueryNearby.handler(input, ctx);

      expect(result.elements).toEqual([]);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalFound).toBe(7);
      expect(enrichment.truncated).toBe(false);
      // Reports the real match count and a valid retry offset (7 matches, limit 2 → 5).
      expect(enrichment.notice).toContain('Offset 999 is past the end');
      expect(enrichment.notice).toContain('7 amenity=cafe features matched');
      expect(enrichment.notice).toContain('offset 5');
      expect(enrichment.notice).not.toContain('Try a larger radius_meters');
    });

    it('emits notice text distinct from the genuine zero-match case', async () => {
      const noticeFor = async (pois: OverpassPoi[], offset: number) => {
        mockNormalizeElements.mockReturnValue(pois);
        const ctx = createMockContext({
          tenantId: 'test',
          errors: openstreetmapQueryNearby.errors,
        });
        const input = openstreetmapQueryNearby.input.parse({
          ...center,
          amenity: 'cafe',
          limit: 2,
          offset,
        });
        await openstreetmapQueryNearby.handler(input, ctx);
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
            osm_type: 'node' as const,
            osm_id: 111222333,
            lat: 47.6105,
            lon: -122.3442,
            name: 'Coffee House',
            tags: { amenity: 'cafe', name: 'Coffee House' },
          },
        ],
        data_timestamp: '2025-01-01T00:00:00Z',
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryNearby.format!(output);
      expect(blocks[0]!.type).toBe('text');
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Coffee House');
      expect(text).toContain('N111222333');
      expect(text).toContain('47.6105');
      expect(text).toContain('-122.3442');
      expect(text).toContain('amenity=cafe');
      expect(text).toContain('OpenStreetMap');
    });

    it('renders the returned count in the header', () => {
      const output = {
        elements: [
          {
            osm_type: 'node' as const,
            osm_id: 1,
            tags: { amenity: 'cafe' },
          },
        ],
        data_timestamp: '2025-01-01T00:00:00Z',
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryNearby.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('1 feature returned');
    });

    it('renders the distance line when distance_meters is present', () => {
      const output = {
        elements: [
          {
            osm_type: 'node' as const,
            osm_id: 5,
            lat: 47.61,
            lon: -122.34,
            name: 'Nearby Cafe',
            distance_meters: 42.5,
            tags: { amenity: 'cafe' },
          },
        ],
        data_timestamp: '2025-01-01T00:00:00Z',
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryNearby.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Distance');
      expect(text).toContain('42.5');
    });

    it('renders "Unnamed" for elements without a name', () => {
      const output = {
        elements: [
          {
            osm_type: 'node' as const,
            osm_id: 999,
            tags: { amenity: 'bench' },
          },
        ],
        data_timestamp: '2025-01-01T00:00:00Z',
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryNearby.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Unnamed');
    });

    // #43: the fabricated timestamp reached content[] as well, so the guard has to
    // live in format() too.
    it('omits the "Data as of" line when no timestamp was reported', () => {
      const blocks = openstreetmapQueryNearby.format!({
        elements: [{ osm_type: 'node' as const, osm_id: 1, tags: { amenity: 'cafe' } }],
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      });
      const text = (blocks[0] as { text: string }).text;
      expect(text).not.toContain('Data as of:');
      expect(text).toContain('1 feature returned');
    });
  });
});
