/**
 * @fileoverview Tests for the openstreetmap-query-nearby tool.
 * @module tests/tools/openstreetmap-query-nearby.tool.test
 */

import { readFileSync } from 'node:fs';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapQueryNearby } from '@/mcp-server/tools/definitions/openstreetmap-query-nearby.tool.js';
import { initOverpassService } from '@/services/overpass/overpass-service.js';
import type {
  OverpassElement,
  OverpassPoi,
  OverpassResponse,
  OverpassResult,
} from '@/services/overpass/types.js';
import { pacerShed, wireError } from '../helpers/handler-error.js';

// --- service mock --------------------------------------------------------

const mockBuildAroundQuery = vi.fn<() => string>(
  () =>
    '[out:json][timeout:25];(node["amenity"="cafe"](around:1000,47.6,-122.3););out center tags;',
);
const mockBuildAroundCenterQuery = vi.fn<(params: unknown) => string>(
  () => '[out:json];center-only',
);
const mockQuery =
  vi.fn<(ql: string, ctx: unknown, rankFrom?: unknown) => Promise<OverpassResult>>();
const mockNormalizeElements = vi.fn<(els: OverpassElement[]) => OverpassPoi[]>();

/** Set by the block that runs the real service end to end (#103); every other block stubs it. */
const serviceMode = vi.hoisted(() => ({ real: false }));

vi.mock('@/services/overpass/overpass-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/overpass/overpass-service.js')>();
  return {
    ...actual,
    getOverpassService: () =>
      serviceMode.real
        ? actual.getOverpassService()
        : {
            buildAroundQuery: mockBuildAroundQuery,
            buildAroundCenterQuery: mockBuildAroundCenterQuery,
            query: mockQuery,
            normalizeElements: mockNormalizeElements,
          },
  };
});

/** The one endpoint the real service is pinned to; the stubbed blocks never reach it. */
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    overpassBaseUrl: 'https://overpass.example/api/interpreter',
    overpassMaxConcurrency: 2,
    nominatimUserAgent: 'openstreetmap-mcp-server/test',
  }),
}));

// --- fixtures ------------------------------------------------------------

const mockElement: OverpassElement = {
  type: 'node',
  id: 111222333,
  lat: 47.6105,
  lon: -122.3442,
  tags: { amenity: 'cafe', name: 'Coffee House' },
};

/** As the service normalizes a ranked element: its measured distance, unrounded. */
const mockPoi: OverpassPoi = {
  osm_type: 'node',
  osm_id: 111222333,
  lat: 47.6105,
  lon: -122.3442,
  distance_meters: 1214.6849,
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

/** A valid around query the error-path cases send, so only the service mock varies. */
const CAFE_NEARBY = { lat: 47.6, lon: -122.3, amenity: 'cafe' };

/** The notice a result ranked by bounding-box center carries (#103 with #107). */
const CENTER_RANKED =
  "Distances for ways and relations were measured to their bounding-box center because the geometry response passed the server's 64 MiB read ceiling.";

/** The `content[]` text a client reads. */
const textOf = (content: unknown) =>
  (content as { type: string; text?: string }[]).map((block) => block.text ?? '').join('\n');

// -------------------------------------------------------------------------

describe('openstreetmapQueryNearby', () => {
  beforeEach(() => {
    mockBuildAroundQuery.mockReset().mockReturnValue('[out:json]');
    mockBuildAroundCenterQuery.mockReset().mockReturnValue('[out:json];center-only');
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
      // The service's measurement, rounded to one decimal.
      expect(result.elements[0]!.distance_meters).toBe(1214.7);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveTag).toBe('amenity=cafe');
      expect(enrichment.totalFound).toBe(1);
      expect(enrichment.truncated).toBe(false);
      expect(enrichment.notice).toBeUndefined();
    });

    /**
     * #37: a failover means the answer may not have come from the primary, so the
     * serving endpoint has to reach the agent. The service names it by origin alone
     * before it gets here (#91) — a provider's key must not ride along into
     * enrichment.
     */
    it('surfaces the serving endpoint reported by the service', async () => {
      mockQuery.mockResolvedValue({
        ...mockResponse,
        servedBy: 'https://overpass.mirror.example',
      });
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
      });
      await openstreetmapQueryNearby.handler(input, ctx);

      expect(getEnrichment(ctx).servingEndpoint).toBe('https://overpass.mirror.example');
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

    it('asks the service to rank from the query point, with the center-only fallback (#103)', async () => {
      mockBuildAroundQuery.mockReturnValue('[out:json];around-ql');
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
      });
      await openstreetmapQueryNearby.handler(input, ctx);
      // Both builders get the same parameters, so the fallback runs the same match.
      expect(mockBuildAroundCenterQuery.mock.calls).toEqual(mockBuildAroundQuery.mock.calls);
      expect(mockBuildAroundCenterQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith('[out:json];around-ql', ctx, {
        lat: 47.6,
        lon: -122.3,
        centerQuery: '[out:json];center-only',
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

  /**
   * The service measures each feature to its nearest point (#103) — a park containing the
   * point at 0 while its bounding-box center sits a kilometre away — so the tool ranks by that
   * measurement and never by `lat`/`lon`, which stay the center.
   */
  describe('distance ranking', () => {
    const center = { lat: 47.6588, lon: -122.4056 };
    const poi = (
      osm_id: number,
      name: string,
      lat: number,
      distance_meters?: number,
    ): OverpassPoi => ({
      osm_type: osm_id > 100 ? 'relation' : 'node',
      osm_id,
      lat,
      lon: -122.4056,
      ...(distance_meters !== undefined && { distance_meters }),
      name,
      tags: { leisure: 'park' },
    });

    it('sorts nearest-first by the measured distance, not by the coordinates it returns', async () => {
      const far = poi(1, 'Far', 47.6591, 245.04);
      const near = poi(2, 'Near', 47.65882, 1.62);
      // Its center lies 1.1 km away; the point is inside it.
      const park = poi(4874562, 'Discovery Park', 47.6688, 0);
      mockNormalizeElements.mockReturnValue([far, near, park]);

      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({ ...center, tag_key: 'leisure' });
      const result = await openstreetmapQueryNearby.handler(input, ctx);

      expect(result.elements.map((e) => [e.name, e.lat, e.distance_meters])).toEqual([
        ['Discovery Park', 47.6688, 0],
        ['Near', 47.65882, 1.6],
        ['Far', 47.6591, 245],
      ]);
    });

    it('truncates AFTER sorting, so limit keeps the nearest N (not the lowest element IDs)', async () => {
      // The nearest feature has the HIGHEST element ID — worst case for id-order truncation.
      mockNormalizeElements.mockReturnValue([
        poi(10, 'Furthest', 47.664, 520),
        poi(20, 'B', 47.663, 410),
        poi(30, 'C', 47.662, 300),
        poi(40, 'D', 47.661, 190),
        poi(50, 'Nearest', 47.659, 20),
      ]);

      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        ...center,
        tag_key: 'leisure',
        limit: 2,
      });
      const result = await openstreetmapQueryNearby.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalFound).toBe(5);
      expect(enrichment.truncated).toBe(true);
      expect(result.elements.map((e) => e.name)).toEqual(['Nearest', 'D']);
    });

    it('places a feature the service could not measure last, with no distance from its center', async () => {
      // A relation that arrived without geometry: a center, but no measurement.
      const unmeasured = poi(200, 'Unmeasured', 47.6588);
      const measured = poi(1, 'Measured', 47.6599, 122.4);
      mockNormalizeElements.mockReturnValue([unmeasured, measured]);

      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({ ...center, tag_key: 'leisure' });
      const result = await openstreetmapQueryNearby.handler(input, ctx);

      expect(result.elements.map((e) => [e.name, e.distance_meters])).toEqual([
        ['Measured', 122.4],
        ['Unmeasured', undefined],
      ]);
      expect(result.elements[1]).toMatchObject({ lat: 47.6588, lon: -122.4056 });
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

    /**
     * A result the service ranked by center, because the geometry response passed the read
     * ceiling, says so in the one notice the page carries, after whatever else it says. The
     * notice alone on a page of matches is pinned end to end, in the read-ceiling block below.
     */
    describe('center-ranked result', () => {
      beforeEach(() => {
        mockQuery.mockResolvedValue({ ...mockResponse, rankedByCenter: true });
      });

      it.each([
        {
          after: 'the stray-amenity hint, without replacing it',
          input: { amenity: 'museum' },
          pois: [mockPoi],
          before:
            'In OpenStreetMap this category is tagged tourism=museum, not amenity=museum; retry with tag_key "tourism" and tag_value "museum".',
        },
        {
          after: 'the past-end paging notice',
          input: { tag_key: 'highway', offset: 5 },
          pois: [mockPoi],
          before:
            'Offset 5 is past the end of the result set: 1 highway feature matched within 1000m, which fit in one page of 20. Retry with offset 0.',
        },
        {
          after: 'the empty-result notice',
          input: { tag_key: 'highway' },
          pois: [],
          before:
            'No highway features found within 1000m. Try a larger radius_meters, a different tag, or verify the coordinates.',
        },
      ])('follows $after', async ({ input, pois, before }) => {
        mockNormalizeElements.mockReturnValue(pois);
        const result = await runToolContract(openstreetmapQueryNearby, {
          lat: 47.6,
          lon: -122.3,
          ...input,
        });
        expect((result.structuredContent as { notice?: string }).notice).toBe(
          `${before} ${CENTER_RANKED}`,
        );
      });

      it('adds nothing to a result ranked by nearest point', async () => {
        mockQuery.mockResolvedValue(mockResponse);
        const result = await runToolContract(openstreetmapQueryNearby, {
          lat: 47.6,
          lon: -122.3,
          tag_key: 'highway',
        });
        expect(result.structuredContent).not.toHaveProperty('notice');
      });
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

    it('throws invalid_tag when tag_value is explicitly blank', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        tag_key: 'leisure',
        tag_value: '',
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
      const err = await wireError(openstreetmapQueryNearby, CAFE_NEARBY, { tenantId: 'test' });
      expect(err.data.reason).toBe('query_timeout');
      expect(err.data.recovery?.hint).toBeDefined();
      expect(typeof err.data.recovery?.hint).toBe('string');
    });

    it('remaps rate_limited service error to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass API returned HTTP 429 — all query slots occupied.',
          { reason: 'rate_limited' },
        ),
      );
      const err = await wireError(openstreetmapQueryNearby, CAFE_NEARBY, { tenantId: 'test' });
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
      const err = await wireError(openstreetmapQueryNearby, CAFE_NEARBY, { tenantId: 'test' });
      expect(err.data.reason).toBe('result_too_large');
      expect(err.data.recovery?.hint).toBeDefined();
    });

    /**
     * #67: a call every endpoint refused used to reach the client as a bare
     * ServiceUnavailable or Timeout — no reason, no hint, outside the tool's
     * declared contract — because the service had nothing to attach and this
     * chain fell through to `throw err`.
     */
    it('remaps endpoints_unavailable to ctx.fail with the declared code and recovery.hint', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'No Overpass endpoint could serve this query — https://overpass-api.de: HTTP 429; https://overpass.mirror.example: connection refused.',
          { reason: 'endpoints_unavailable', errorSource: 'OverpassEndpointsUnavailable' },
        ),
      );
      const err = await wireError(openstreetmapQueryNearby, CAFE_NEARBY, { tenantId: 'test' });

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data.reason).toBe('endpoints_unavailable');
      expect(err.message).toContain('connection refused');
      expect(err.data.recovery?.hint).toBe(
        openstreetmapQueryNearby.errors?.find((e) => e.reason === 'endpoints_unavailable')
          ?.recovery,
      );
    });

    /**
     * #87: a call every endpoint refused by HTTP status used to reach the caller as
     * the bare last status — no reason, no hint, and a `client`-category code for an
     * endpoint misconfiguration. The service now composes it; the tool declares it.
     */
    it('passes endpoints_rejected through with its declared hint, not retryable, no body', async () => {
      // A body on the service error, so the no-body assertions below can fail: the
      // framework fills the declared hint on a raw rethrow too, and forwards its data.
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Every configured Overpass endpoint refused this query — https://overpass-api.de: HTTP 404; https://overpass.mirror.example: HTTP 403.',
          {
            reason: 'endpoints_rejected',
            retryable: false,
            errorSource: 'OverpassEndpointsRejected',
            body: '<html>403 Forbidden</html>',
            responseBody: '<html>403 Forbidden</html>',
          },
        ),
      );
      const declared = openstreetmapQueryNearby.errors?.find(
        (e) => e.reason === 'endpoints_rejected',
      )?.recovery;
      expect(declared).toBeDefined();
      const err = await wireError(openstreetmapQueryNearby, CAFE_NEARBY, { tenantId: 'test' });

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({ reason: 'endpoints_rejected', retryable: false });
      expect(err.data.recovery?.hint).toBe(declared);
      expect(err.message).toContain('https://overpass-api.de: HTTP 404');
      expect(err.message).toContain('https://overpass.mirror.example: HTTP 403');
      expect(err.text).toContain(`Recovery: ${declared}`);
      expect(err.text).toContain('(reason endpoints_rejected · not retryable');
      expect(err.data).not.toHaveProperty('body');
      expect(err.data).not.toHaveProperty('responseBody');
      // The catch arm restates the error through ctx.fail, which keeps only the reason and
      // the contract's retryable; a raw rethrow would carry the service's errorSource.
      expect(err.data).not.toHaveProperty('errorSource');
    });

    /**
     * #90: a call whose wait for an Overpass slot ran out never left this server. The
     * framework's shed passes through untouched — `RateLimited` with `shedKind` and
     * `retryAfter` intact — and the declared hint reaches both surfaces.
     */
    it('passes a pacer_shed through as RateLimited with retryAfter and its declared hint', async () => {
      const shed = await pacerShed();
      mockQuery.mockRejectedValue(shed);
      const declared = openstreetmapQueryNearby.errors?.find(
        (e) => e.reason === 'pacer_shed',
      )?.recovery;
      expect(declared).toBeDefined();
      const err = await wireError(openstreetmapQueryNearby, CAFE_NEARBY, { tenantId: 'test' });

      expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(err.data).toMatchObject({
        reason: 'pacer_shed',
        shedKind: 'wait_elapsed',
        retryAfter: shed.data?.retryAfter,
      });
      expect(err.data.recovery?.hint).toBe(declared);
      expect(err.text).toContain(`Recovery: ${declared}`);
      expect(err.text).toContain('(reason pacer_shed');
    });

    it('remaps upstream_error service error to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass reported an error: runtime error: Dispatcher_Client::request_read_and_idx::timeout',
          { reason: 'upstream_error' },
        ),
      );
      const err = await wireError(openstreetmapQueryNearby, CAFE_NEARBY, { tenantId: 'test' });
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
      return wireError(openstreetmapQueryNearby, CAFE_NEARBY, { tenantId: 'test' });
    };

    it('maps 504 to overpass_gateway_timeout, keeping the Timeout code', async () => {
      const err = await run(504, JsonRpcErrorCode.Timeout);
      expect(err.data.reason).toBe('overpass_gateway_timeout');
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      const hint = err.data.recovery?.hint;
      expect(hint).toContain('reduce radius_meters');
      expect(hint).toContain('timeout_seconds');
    });

    it('maps 502 to overpass_unavailable, keeping the ServiceUnavailable code', async () => {
      const err = await run(502, JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data.reason).toBe('overpass_unavailable');
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      const hint = err.data.recovery?.hint;
      expect(hint).toContain('OSM_OVERPASS_BASE_URL');
      expect(hint).toContain('retry unchanged');
    });

    it('maps 503 to overpass_unavailable', async () => {
      expect((await run(503, JsonRpcErrorCode.ServiceUnavailable)).data?.reason).toBe(
        'overpass_unavailable',
      );
    });

    it('maps 500 to overpass_unavailable, keeping the ServiceUnavailable code', async () => {
      const err = await run(500, JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data?.reason).toBe('overpass_unavailable');
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    /**
     * #95: a 408 is the endpoint's own clock running out, as a 504 is; a 425 the endpoint
     * not taking the query yet, as a 503 is. Each ends on its counterpart's reason, hint,
     * and code, with the captured body stripped.
     */
    it.each([
      [408, JsonRpcErrorCode.Timeout, 'overpass_gateway_timeout'],
      [425, JsonRpcErrorCode.ServiceUnavailable, 'overpass_unavailable'],
    ] as const)(
      'maps HTTP %i (code %i) to %s on both surfaces, dropping the captured body',
      async (status, code, reason) => {
        const declared = openstreetmapQueryNearby.errors?.find(
          (e) => e.reason === reason,
        )?.recovery;
        expect(declared).toBeDefined();
        const err = await run(status, code, 'upstream says later');

        expect(err.code).toBe(code);
        expect(err.data).toMatchObject({ reason, retryable: true, status });
        expect(err.data.recovery?.hint).toBe(declared);
        expect(err.text).toContain(`Recovery: ${declared}`);
        expect(err.text).toContain(`(reason ${reason} · retryable`);
        expect(err.data).not.toHaveProperty('body');
        expect(err.data).not.toHaveProperty('responseBody');
      },
    );

    // The service composes a call every endpoint refused by status into
    // endpoints_rejected (#87). A reason-less status below 500 reaching the tool any
    // other way is not an availability problem, and is not relabelled as one.
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
        distance_meters: (i + 1) * 111.19,
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
        distance_meters: (i + 1) * 111.19,
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

    /**
     * #70: `total - limit` floors to 0 once the whole match set fits in one page,
     * so the notice offered the same offset twice as if the two were alternatives.
     * `total === limit` degenerates identically, one element short of the
     * two-offset regime the case above covers.
     */
    it.each([
      {
        label: 'total below the limit',
        total: 3,
        limit: 5,
        expected:
          'Offset 40 is past the end of the result set: 3 amenity=cafe features matched within 300m, which fit in one page of 5. Retry with offset 0.',
      },
      {
        label: 'total equal to the limit',
        total: 5,
        limit: 5,
        expected:
          'Offset 40 is past the end of the result set: 5 amenity=cafe features matched within 300m, which fit in one page of 5. Retry with offset 0.',
      },
    ])(
      'names one retry offset when the match set fits in one page ($label)',
      async ({ total, limit, expected }) => {
        mockNormalizeElements.mockReturnValue(makePois(total));
        const ctx = createMockContext({
          tenantId: 'test',
          errors: openstreetmapQueryNearby.errors,
        });
        const input = openstreetmapQueryNearby.input.parse({
          ...center,
          amenity: 'cafe',
          radius_meters: 300,
          limit,
          offset: 40,
        });
        const result = await openstreetmapQueryNearby.handler(input, ctx);

        expect(result.elements).toEqual([]);
        const enrichment = getEnrichment(ctx);
        expect(enrichment.totalFound).toBe(total);
        expect(enrichment.notice).toBe(expected);
        expect(enrichment.notice).not.toContain('Try a larger radius_meters');
        expect(enrichment.notice).not.toContain('for the nearest matches');
      },
    );
  });

  /**
   * #105: a limit above 500 lost the whole call to a schema error, and a numeric string
   * above it was refused as the wrong type. It is now clamped to 500, with limitNotice
   * saying so, and every value derived from limit uses the applied 500.
   */
  describe('limit clamp (#105)', () => {
    const center = { lat: 47.6, lon: -122.3 };
    const makePois = (n: number): OverpassPoi[] =>
      Array.from({ length: n }, (_, i) => ({
        osm_type: 'node' as const,
        osm_id: i + 1,
        lat: center.lat + (i + 1) * 0.0001,
        lon: center.lon,
        distance_meters: (i + 1) * 11.119,
        tags: { amenity: 'cafe' },
      }));
    const CLAMP = "Requested limit 600 exceeds this tool's maximum of 500, so 500 was applied.";
    const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    it('serves 500 of 700 and continues on the next page where the first stopped', async () => {
      mockNormalizeElements.mockReturnValue(makePois(700));
      const first = await runToolContract(openstreetmapQueryNearby, {
        ...center,
        amenity: 'cafe',
        limit: 600,
      });
      const page1 = first.structuredContent as {
        elements: { osm_id: number }[];
        limitNotice?: string;
        truncated: boolean;
        nextOffset?: number;
        totalFound: number;
      };
      expect(page1.elements.map((e) => e.osm_id)).toEqual(
        Array.from({ length: 500 }, (_, i) => i + 1),
      );
      expect(page1).toMatchObject({
        totalFound: 700,
        truncated: true,
        nextOffset: 500,
        limitNotice: CLAMP,
      });
      expect(textOf(first.content)).toContain(`**Limit Clamped:** ${CLAMP}`);

      const second = await runToolContract(openstreetmapQueryNearby, {
        ...center,
        amenity: 'cafe',
        limit: 600,
        offset: page1.nextOffset,
      });
      const page2 = second.structuredContent as {
        elements: { osm_id: number }[];
        truncated: boolean;
        nextOffset?: number;
      };
      expect(page2.elements.map((e) => e.osm_id)).toEqual(
        Array.from({ length: 200 }, (_, i) => i + 501),
      );
      expect(page2.truncated).toBe(false);
      expect(page2).not.toHaveProperty('nextOffset');
    });

    it('computes the past-end retry offset from the applied limit, beside its own notice', async () => {
      mockNormalizeElements.mockReturnValue(makePois(700));
      const result = await runToolContract(openstreetmapQueryNearby, {
        ...center,
        amenity: 'cafe',
        limit: 600,
        offset: 900,
      });
      const notice =
        'Offset 900 is past the end of the result set: 700 amenity=cafe features matched within 1000m. Retry with offset 200 for the last page, or offset 0 for the nearest matches.';
      expect(result.structuredContent).toMatchObject({ notice, limitNotice: CLAMP });
      const text = textOf(result.content);
      expect(occurrences(text, notice)).toBe(1);
      expect(occurrences(text, CLAMP)).toBe(1);
      expect(text).toContain(`> ${notice}`);
    });

    it('names one page of the applied limit when the match set fits in it', async () => {
      mockNormalizeElements.mockReturnValue(makePois(400));
      const result = await runToolContract(openstreetmapQueryNearby, {
        ...center,
        amenity: 'cafe',
        limit: 600,
        offset: 900,
      });
      expect((result.structuredContent as { notice: string }).notice).toBe(
        'Offset 900 is past the end of the result set: 400 amenity=cafe features matched within 1000m, which fit in one page of 500. Retry with offset 0.',
      );
    });

    it('keeps the stray-amenity notice and the clamp on separate keys', async () => {
      mockNormalizeElements.mockReturnValue(makePois(3));
      const result = await runToolContract(openstreetmapQueryNearby, {
        ...center,
        amenity: 'museum',
        limit: 600,
      });
      const structured = result.structuredContent as { notice: string; limitNotice: string };
      expect(structured.notice).toContain('tourism=museum');
      expect(structured.notice).not.toContain('Requested limit');
      expect(structured.limitNotice).toBe(CLAMP);
    });

    it('accepts limit as the numeric string "600" and clamps it', async () => {
      mockNormalizeElements.mockReturnValue(makePois(700));
      const result = await runToolContract(openstreetmapQueryNearby, {
        ...center,
        amenity: 'cafe',
        limit: '600',
      } as never);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ limitNotice: CLAMP, nextOffset: 500 });
    });

    it('writes no limitNotice at or below 500', async () => {
      mockNormalizeElements.mockReturnValue(makePois(700));
      const result = await runToolContract(openstreetmapQueryNearby, {
        ...center,
        amenity: 'cafe',
        limit: 500,
      });
      expect(result.structuredContent).not.toHaveProperty('limitNotice');
      expect(textOf(result.content)).not.toContain('Limit Clamped');
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

/**
 * #103 end to end: the real service builds the around query, one request answers it, and the
 * ranking reaches both output surfaces. The response is overpass-api.de's answer to exactly
 * the query pinned below (Overpass API 0.7.62.11, data as of 2026-10-14T18:16:31Z): the
 * records, the circle-clipped ways and Discovery Park's member ways, and the strip print,
 * which holds only the one outer segment its northward ray crosses.
 */
describe('openstreetmapQueryNearby nearest-point distance (#103)', () => {
  const LIVE_BODY = readFileSync(
    new URL('../services/overpass/fixtures/discovery-park-nearby-live.json', import.meta.url),
    'utf8',
  );
  const REPRO = {
    lat: 47.6588,
    lon: -122.4056,
    radius_meters: 800,
    tag_key: 'leisure',
    tag_value: 'park',
    element_types: ['way' as const, 'relation' as const],
  };

  let http: ReturnType<typeof createFetchMock>;

  beforeEach(() => {
    serviceMode.real = true;
    initOverpassService({} as AppConfig, {} as StorageService);
    http = createFetchMock([
      {
        method: 'POST',
        match: (request) => new URL(request.url).origin === 'https://overpass.example',
        respond: () => new Response(LIVE_BODY, { status: 200 }),
      },
    ]);
    http.install();
  });

  afterEach(() => {
    http.restore();
    serviceMode.real = false;
  });

  it('ranks the park containing the point first at 0, every distance inside the radius', async () => {
    const result = await runToolContract(openstreetmapQueryNearby, REPRO);
    expect(result.isError).not.toBe(true);
    const elements = (result.structuredContent as { elements: Record<string, unknown>[] }).elements;
    expect(
      elements.map((el) => [`${el.osm_type}/${el.osm_id}`, el.name, el.distance_meters]),
    ).toEqual([
      ['relation/4874562', 'Discovery Park', 0],
      ['way/56178745', 'Kiwanis Ravine Overlook', 214.1],
      ['way/56178742', 'Kiwanis Memorial Preserve Park', 262.3],
      ['way/51475862', 'Commodore Park', 793.8],
    ]);
    // lat/lon stay the bounding-box center `out center` printed.
    expect(elements[0]).toMatchObject({ lat: 47.6617956, lon: -122.4197769 });
    for (const el of elements) {
      expect(Object.keys(el).sort()).toEqual([
        'distance_meters',
        'lat',
        'lon',
        'name',
        'osm_id',
        'osm_type',
        'tags',
      ]);
    }

    const text = textOf(result.content);
    expect(text).toContain(
      '## Discovery Park\n**OSM:** R4874562\n**Coordinates:** 47.6617956, -122.4197769\n**Distance:** 0 m',
    );
    expect(text).toContain(
      '## Commodore Park\n**OSM:** W51475862\n**Coordinates:** 47.6653357, -122.400074\n**Distance:** 793.8 m',
    );
    expect(text).not.toContain('geometry');
    expect(text).not.toContain('nearby_');
  });

  it('sends one request carrying the record print and both geometry prints', async () => {
    await runToolContract(openstreetmapQueryNearby, REPRO);
    expect(http.calls).toHaveLength(1);
    const ql = new URLSearchParams(await http.calls[0]!.request.text()).get('data');
    expect(ql).toBe(
      [
        '[out:json][timeout:25][maxsize:268435456];',
        '(',
        '  way["leisure"="park"](around:800,47.6588,-122.4056);',
        '  relation["leisure"="park"](around:800,47.6588,-122.4056);',
        ');',
        'out center tags;',
        '(._;)->.matched;',
        'make nearby_nearest;',
        'out;',
        'way.matched;',
        'out ids geom(47.6515280,-122.4163981,47.6660720,-122.3948019);',
        'rel.matched->.rels;',
        'foreach.rels->.r(.r out ids;way(r.r)(47.6515280,-122.4163981,47.6660720,-122.3948019);out ids geom(47.6515280,-122.4163981,47.6660720,-122.3948019);node(r.r)(47.6515280,-122.4163981,47.6660720,-122.3948019);out skel;);',
        'make nearby_strip;',
        'out;',
        'way.matched(if:is_closed())["area"!="no"](47.6587999,-122.4056001,90.0000000,-122.4055999);',
        'out ids geom(47.6587999,-122.4056001,90.0000000,-122.4055999);',
        'rel.matched["type"~"^(multipolygon|boundary)$"](47.6587999,-122.4056001,90.0000000,-122.4055999)->.areas;',
        'foreach.areas->.r(.r out ids;way(r.r)(47.6587999,-122.4056001,90.0000000,-122.4055999);out ids geom(47.6587999,-122.4056001,90.0000000,-122.4055999););',
      ].join('\n'),
    );
  });
});

/**
 * #103 with #107: a way-heavy survey whose geometry response passes the 64 MiB read ceiling
 * was served by 0.6.0's center-only print. It is served that way again — ranked by center,
 * with a notice saying so — rather than ending as `result_too_large`.
 */
describe('openstreetmapQueryNearby past the read ceiling', () => {
  const SURVEY = {
    lat: 47.6062,
    lon: -122.3321,
    radius_meters: 7500,
    tag_key: 'highway',
    element_types: ['way' as const],
    timeout_seconds: 60,
  };
  const CENTER_QL = [
    '[out:json][timeout:60][maxsize:268435456];',
    '(',
    '  way["highway"](around:7500,47.6062,-122.3321);',
    ');',
    'out center tags;',
  ].join('\n');
  const CENTER_BODY = JSON.stringify({
    version: 0.6,
    osm3s: { timestamp_osm_base: '2026-10-14T18:00:00Z' },
    elements: [
      {
        type: 'way',
        id: 3,
        center: { lat: 47.6162, lon: -122.3321 },
        tags: { highway: 'primary', name: 'Far' },
      },
      {
        type: 'way',
        id: 1,
        center: { lat: 47.6072, lon: -122.3321 },
        tags: { highway: 'residential', name: 'Near' },
      },
      {
        type: 'way',
        id: 2,
        center: { lat: 47.6062, lon: -122.3221 },
        tags: { highway: 'service' },
      },
    ],
  });
  const isOverpass = (request: Request) =>
    new URL(request.url).origin === 'https://overpass.example';
  const pastCeiling = () =>
    new Response('{"version":0.6,"elements":[]}', {
      status: 200,
      headers: { 'content-length': String(64 * 1024 * 1024 + 1) },
    });

  let http: ReturnType<typeof createFetchMock>;

  /** Answers the call's submissions in order, one route each. */
  function install(...responders: Array<() => Response>): void {
    http = createFetchMock(
      responders.map((respond) => ({ method: 'POST', match: isOverpass, once: true, respond })),
    );
    http.install();
  }

  async function submittedQl(): Promise<(string | null)[]> {
    return Promise.all(
      http.calls.map(async (call) => new URLSearchParams(await call.request.text()).get('data')),
    );
  }

  beforeEach(() => {
    serviceMode.real = true;
    initOverpassService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    http.restore();
    serviceMode.real = false;
  });

  it('serves the survey ranked by center, with a notice, after one center-only request', async () => {
    install(pastCeiling, () => new Response(CENTER_BODY, { status: 200 }));

    const result = await runToolContract(openstreetmapQueryNearby, SURVEY);

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      elements: Record<string, unknown>[];
      notice?: string;
      totalFound: number;
    };
    expect(structured.elements.map((el) => [el.osm_id, el.name, el.distance_meters])).toEqual([
      [1, 'Near', 111.2],
      [2, undefined, 749.7],
      [3, 'Far', 1111.9],
    ]);
    expect(structured.elements[0]).toMatchObject({ lat: 47.6072, lon: -122.3321 });
    expect(structured.totalFound).toBe(3);
    expect(structured.notice).toBe(CENTER_RANKED);
    const text = textOf(result.content);
    expect(text).toContain(`> ${CENTER_RANKED}`);
    expect(text).toContain(
      '## Near\n**OSM:** W1\n**Coordinates:** 47.6072, -122.3321\n**Distance:** 111.2 m',
    );

    expect(http.calls).toHaveLength(2);
    const [geometry, center] = await submittedQl();
    expect(geometry).toContain('make nearby_nearest;');
    expect(center).toBe(CENTER_QL);
  });

  it('ends result_too_large when the center-only response passes the ceiling too', async () => {
    install(pastCeiling, pastCeiling);

    const result = await runToolContract(openstreetmapQueryNearby, SURVEY);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'result_too_large',
          recovery: {
            hint: 'Narrow the query: reduce radius_meters, add more specific tag filters, or limit element_types.',
          },
        },
      },
    });
    expect(http.calls).toHaveLength(2);
  });
});
