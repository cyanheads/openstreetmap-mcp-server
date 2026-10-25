/**
 * @fileoverview Security tests: input injection, env/secret leakage, oversized inputs.
 * @module tests/security/security.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapLookupObjects } from '@/mcp-server/tools/definitions/openstreetmap-lookup-objects.tool.js';
import { openstreetmapQueryBbox } from '@/mcp-server/tools/definitions/openstreetmap-query-bbox.tool.js';
import { openstreetmapQueryNearby } from '@/mcp-server/tools/definitions/openstreetmap-query-nearby.tool.js';
import { openstreetmapQueryRaw } from '@/mcp-server/tools/definitions/openstreetmap-query-raw.tool.js';
import { openstreetmapReverseGeocode } from '@/mcp-server/tools/definitions/openstreetmap-reverse-geocode.tool.js';
import { openstreetmapSearchPlaces } from '@/mcp-server/tools/definitions/openstreetmap-search-places.tool.js';
import type { NominatimPlace } from '@/services/nominatim/types.js';
import type { OverpassElement, OverpassPoi, OverpassResponse } from '@/services/overpass/types.js';
import { commonmark, markdownText } from '../helpers/markdown.js';

// --- service mocks -------------------------------------------------------

const mockNominatimSearch = vi.fn<() => Promise<NominatimPlace[]>>();
const mockNominatimReverse = vi.fn<() => Promise<NominatimPlace>>();
const mockNominatimLookup = vi.fn<() => Promise<NominatimPlace[]>>();

vi.mock('@/services/nominatim/nominatim-service.js', () => ({
  getNominatimService: () => ({
    search: mockNominatimSearch,
    reverse: mockNominatimReverse,
    lookup: mockNominatimLookup,
  }),
}));

const mockOverpassQuery = vi.fn<(ql: string, ctx: unknown) => Promise<OverpassResponse>>();
const mockBuildAroundQuery = vi.fn<() => string>(() => '[out:json]');
const mockBuildBboxQuery = vi.fn<() => string>(() => '[out:json]');
const mockNormalizeElements = vi.fn<(els: OverpassElement[]) => OverpassPoi[]>(() => []);

vi.mock('@/services/overpass/overpass-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/overpass/overpass-service.js')>();
  return {
    ...actual,
    getOverpassService: () => ({
      buildAroundQuery: mockBuildAroundQuery,
      buildAroundCenterQuery: mockBuildAroundQuery,
      buildBboxQuery: mockBuildBboxQuery,
      query: mockOverpassQuery,
      normalizeElements: mockNormalizeElements,
    }),
  };
});

// --- fixtures ------------------------------------------------------------

const minimalPlace: NominatimPlace = {
  place_id: 1,
  lat: 47.6,
  lon: -122.3,
  display_name: 'Seattle, WA',
};

const minimalOverpassResponse: OverpassResponse = {
  version: 0.6,
  osm3s: { timestamp_osm_base: '2025-01-01T00:00:00Z' },
  elements: [],
};

// -------------------------------------------------------------------------

describe('secret / env leakage', () => {
  beforeEach(() => {
    mockNominatimSearch.mockReset().mockResolvedValue([minimalPlace]);
    mockNominatimReverse.mockReset().mockResolvedValue(minimalPlace);
    mockNominatimLookup.mockReset().mockResolvedValue([minimalPlace]);
    mockOverpassQuery.mockReset().mockResolvedValue(minimalOverpassResponse);
    mockNormalizeElements.mockReset().mockReturnValue([]);
  });

  it('geocode output does not contain env var names or values', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
    const input = openstreetmapSearchPlaces.input.parse({ query: 'Seattle' });
    const result = await openstreetmapSearchPlaces.handler(input, ctx);
    // Enrichment is merged into structuredContent and mirrored into content[], so the
    // tag-selection caveat is part of the response surface, not a side channel. This tool
    // writes it on every success; the reverse and lookup checks below request extratags,
    // which is what triggers it there.
    const text = JSON.stringify({ ...result, ...getEnrichment(ctx) });
    expect(text).not.toMatch(/API_KEY/i);
    expect(text).not.toMatch(/OSM_NOMINATIM/i);
    expect(text).not.toMatch(/OSM_OVERPASS/i);
  });

  it('reverse geocode output does not contain env var names', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapReverseGeocode.errors });
    const input = openstreetmapReverseGeocode.input.parse({
      lat: 47.6,
      lon: -122.3,
      extratags: true,
    });
    const result = await openstreetmapReverseGeocode.handler(input, ctx);
    const text = JSON.stringify({ ...result, ...getEnrichment(ctx) });
    expect(text).not.toMatch(/API_KEY/i);
    expect(text).not.toMatch(/OSM_NOMINATIM/i);
  });

  it('lookup output does not contain env var names', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapLookupObjects.errors });
    const input = openstreetmapLookupObjects.input.parse({
      osm_ids: ['N240109189'],
      extratags: true,
    });
    const result = await openstreetmapLookupObjects.handler(input, ctx);
    const text = JSON.stringify({ ...result, ...getEnrichment(ctx) });
    expect(text).not.toMatch(/API_KEY/i);
    expect(text).not.toMatch(/OSM_NOMINATIM/i);
  });

  it('query_nearby output does not contain env var names', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
    const input = openstreetmapQueryNearby.input.parse({ lat: 47.6, lon: -122.3, amenity: 'cafe' });
    const result = await openstreetmapQueryNearby.handler(input, ctx);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/API_KEY/i);
    expect(text).not.toMatch(/OSM_OVERPASS/i);
  });

  it('query_bbox output does not contain env var names', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
    const input = openstreetmapQueryBbox.input.parse({
      south: 47.5,
      west: -122.5,
      north: 47.7,
      east: -122.2,
      amenity: 'cafe',
    });
    const result = await openstreetmapQueryBbox.handler(input, ctx);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/API_KEY/i);
    expect(text).not.toMatch(/OSM_OVERPASS/i);
  });
});

describe('injection attempts — query_raw', () => {
  beforeEach(() => {
    mockOverpassQuery.mockReset().mockResolvedValue(minimalOverpassResponse);
  });

  it('missing [out:json] throws query_error before hitting the service', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
    const input = openstreetmapQueryRaw.input.parse({
      query: 'node["natural"="peak"](47.5,-122.5,47.7,-122.2);out body;',
    });
    await expect(openstreetmapQueryRaw.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'query_error' },
    });
    // Service should never be called
    expect(mockOverpassQuery).not.toHaveBeenCalled();
  });

  it('passes query with [out:json] to the service unchanged (no double-encoding)', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
    const input = openstreetmapQueryRaw.input.parse({
      query: '[out:json][timeout:10];node["natural"="peak"](47.5,-122.5,47.7,-122.2);out body;',
    });
    await openstreetmapQueryRaw.handler(input, ctx);
    const calledArg = mockOverpassQuery.mock.calls[0]?.[0] as string;
    expect(calledArg).toContain('[out:json]');
    expect(calledArg).toContain('"natural"="peak"');
  });

  /**
   * #68 widened the preflight to the spacings Overpass accepts. Everything past
   * the settings block must still reach the service byte for byte — a tolerant
   * directive match is not a licence to rewrite anything else in the query. The
   * query used to arrive whole; since #106 the one addition is the declared
   * `[maxsize:N]` at the head of the query.
   */
  it('passes a whitespace-spaced [out: json] query through with its body untouched', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
    const body = '[timeout:10];node["natural"="peak"](47.5,-122.5,47.7,-122.2);out body;';
    const input = openstreetmapQueryRaw.input.parse({ query: `[out: json]${body}` });
    await openstreetmapQueryRaw.handler(input, ctx);
    expect(mockOverpassQuery.mock.calls[0]?.[0]).toBe(`[maxsize:268435456][out: json]${body}`);
  });
});

describe('injection attempts — geocode query parameter', () => {
  beforeEach(() => {
    mockNominatimSearch.mockReset().mockResolvedValue([minimalPlace]);
  });

  it('passes through SQL-like injection string as a plain query', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
    // The tool passes this to the service unchanged — the service handles escaping.
    // We assert no exception and no secret leak, not that the string is blocked.
    const input = openstreetmapSearchPlaces.input.parse({ query: "Seattle' OR '1'='1" });
    const result = await openstreetmapSearchPlaces.handler(input, ctx);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/API_KEY/i);
  });

  it('passes through script-tag-like injection string as a plain query', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
    const input = openstreetmapSearchPlaces.input.parse({ query: '<script>alert(1)</script>' });
    const result = await openstreetmapSearchPlaces.handler(input, ctx);
    // Output should echo back what the service returned, not the injected input
    expect(result.results[0]!.display_name).toBe('Seattle, WA');
  });
});

describe('injection attempts — tag values', () => {
  beforeEach(() => {
    mockOverpassQuery.mockReset().mockResolvedValue(minimalOverpassResponse);
    mockBuildAroundQuery.mockReset().mockReturnValue('[out:json]');
    mockBuildBboxQuery.mockReset().mockReturnValue('[out:json]');
  });

  for (const definition of [openstreetmapQueryNearby, openstreetmapQueryBbox]) {
    const geo =
      definition === openstreetmapQueryNearby
        ? { lat: 47.6, lon: -122.3 }
        : { south: 47.5, west: -122.5, north: 47.7, east: -122.2 };

    it.each(['"', '\\', '[', ']', ';', '(', ')'])(
      `${definition.name} rejects a later filter's key and value containing %j`,
      async (character) => {
        for (const entry of [
          { key: ` x${character}y ` },
          { key: 'website', value: ` x${character}y ` },
        ]) {
          const result = await runToolContract(definition, {
            ...geo,
            tag_key: 'shop',
            filters: [{ key: 'name' }, entry],
          });
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: {
              data: {
                reason: 'invalid_tag',
                recovery: { hint: expect.stringContaining('metacharacters') },
              },
            },
          });
          const text = result.content
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('\n');
          expect(text).toContain('metacharacters');
          expect(text).toContain('openstreetmap_query_raw');
          expect(mockBuildAroundQuery).not.toHaveBeenCalled();
          expect(mockBuildBboxQuery).not.toHaveBeenCalled();
          expect(mockOverpassQuery).not.toHaveBeenCalled();
        }
      },
    );

    /**
     * #83: a list-item value is escaped into a regex, so the structural rejection has to
     * run before that escaping in list-item mode too — the escaper never sees a character
     * that could close the quoted string or the regex group.
     */
    it.each(['"', '\\', '[', ']', ';', '(', ')'])(
      `${definition.name} rejects a list-item value containing %j, primary and filter alike`,
      async (character) => {
        for (const tag of [
          { tag_key: 'cuisine', tag_value: ` pi${character}za `, tag_value_match: 'list_item' },
          {
            amenity: 'restaurant',
            filters: [{ key: 'cuisine', value: ` pi${character}za `, match: 'list_item' }],
          },
        ]) {
          const result = await runToolContract(definition, { ...geo, ...tag } as never);
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: {
              message: expect.stringContaining('metacharacters'),
              data: { reason: 'invalid_tag' },
            },
          });
          expect(mockBuildAroundQuery).not.toHaveBeenCalled();
          expect(mockBuildBboxQuery).not.toHaveBeenCalled();
          expect(mockOverpassQuery).not.toHaveBeenCalled();
        }
      },
    );

    it(`${definition.name} rejects a match mode outside the enum at the contract boundary`, async () => {
      const cases: { tag: Record<string, unknown>; path: (string | number)[] }[] = [
        {
          tag: { tag_key: 'cuisine', tag_value: 'pizza', tag_value_match: 'regex' },
          path: ['tag_value_match'],
        },
        {
          tag: {
            amenity: 'restaurant',
            filters: [{ key: 'cuisine', value: 'pizza', match: 'regex' }],
          },
          path: ['filters', 0, 'match'],
        },
      ];
      for (const { tag, path } of cases) {
        const result = await runToolContract(definition, { ...geo, ...tag } as never);
        expect(result.isError).toBe(true);
        // The enum itself must reject the value — an unknown-key rejection would also be -32602.
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.InvalidParams,
            data: { issues: [{ code: 'invalid_value', values: ['exact', 'list_item'], path }] },
          },
        });
      }
      expect(mockOverpassQuery).not.toHaveBeenCalled();
    });

    it(`${definition.name} rejects six filters at the contract input boundary`, async () => {
      const result = await runToolContract(definition, {
        ...geo,
        amenity: 'cafe',
        filters: Array.from({ length: 6 }, (_, i) => ({ key: `key${i}` })),
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining('filters'),
        },
      });
      expect(mockBuildAroundQuery).not.toHaveBeenCalled();
      expect(mockBuildBboxQuery).not.toHaveBeenCalled();
      expect(mockOverpassQuery).not.toHaveBeenCalled();
    });
  }

  it('query_nearby rejects tag injection metacharacters with invalid_tag (no service call)', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
    const input = openstreetmapQueryNearby.input.parse({
      lat: 47.6,
      lon: -122.3,
      tag_key: 'amenity',
      tag_value: 'cafe"]["admin_level"="2',
    });
    // #14: convenience tools reject Overpass QL metacharacters instead of interpolating them,
    // so the crafted value never reaches the query builder or the service.
    await expect(openstreetmapQueryNearby.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_tag' },
    });
    expect(mockBuildAroundQuery).not.toHaveBeenCalled();
    expect(mockOverpassQuery).not.toHaveBeenCalled();
  });

  it('query_bbox rejects tag injection metacharacters with invalid_tag (no service call)', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
    const input = openstreetmapQueryBbox.input.parse({
      south: 47.5,
      west: -122.5,
      north: 47.7,
      east: -122.2,
      tag_key: 'natural',
      tag_value: 'peak\r\n[timeout:1]',
    });
    await expect(openstreetmapQueryBbox.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_tag' },
    });
    expect(mockBuildBboxQuery).not.toHaveBeenCalled();
    expect(mockOverpassQuery).not.toHaveBeenCalled();
  });
});

describe('oversized inputs — schema validation', () => {
  /**
   * #105: an over-cap limit used to be rejected here (41 on search, 501 on the Overpass
   * tools). It is clamped by the handler now, so the schema admits it and rejects only
   * past the 10,000 absurd-input ceiling.
   */
  it('geocode admits limit 41 for the handler to clamp, and rejects 10001', () => {
    expect(() =>
      openstreetmapSearchPlaces.input.parse({ query: 'Seattle', limit: 41 }),
    ).not.toThrow();
    expect(() =>
      openstreetmapSearchPlaces.input.parse({ query: 'Seattle', limit: 10_001 }),
    ).toThrow();
  });

  it('geocode accepts limit at the schema ceiling (10000)', () => {
    expect(() =>
      openstreetmapSearchPlaces.input.parse({ query: 'Seattle', limit: 10_000 }),
    ).not.toThrow();
  });

  it('query_nearby rejects radius above 50000m at schema level', () => {
    expect(() =>
      openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
        radius_meters: 50001,
      }),
    ).toThrow();
  });

  it('query_nearby accepts radius at max boundary (50000)', () => {
    expect(() =>
      openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
        radius_meters: 50000,
      }),
    ).not.toThrow();
  });

  it('query_nearby admits limit 501 for the handler to clamp, and rejects 10001', () => {
    const call = (limit: number) => ({ lat: 47.6, lon: -122.3, amenity: 'cafe', limit });
    expect(() => openstreetmapQueryNearby.input.parse(call(501))).not.toThrow();
    expect(() => openstreetmapQueryNearby.input.parse(call(10_001))).toThrow();
  });

  it('query_bbox admits limit 501 for the handler to clamp, and rejects 10001', () => {
    const call = (limit: number) => ({
      south: 47.5,
      west: -122.5,
      north: 47.7,
      east: -122.2,
      amenity: 'cafe',
      limit,
    });
    expect(() => openstreetmapQueryBbox.input.parse(call(501))).not.toThrow();
    expect(() => openstreetmapQueryBbox.input.parse(call(10_001))).toThrow();
  });

  it('query_raw admits limit 501 for the handler to clamp, and rejects 10001', () => {
    const call = (limit: number) => ({ query: '[out:json];node(1);out;', limit });
    expect(() => openstreetmapQueryRaw.input.parse(call(501))).not.toThrow();
    expect(() => openstreetmapQueryRaw.input.parse(call(10_001))).toThrow();
  });

  it('query_raw accepts limit at the schema ceiling (10000)', () => {
    expect(() =>
      openstreetmapQueryRaw.input.parse({ query: '[out:json];node(1);out;', limit: 10_000 }),
    ).not.toThrow();
  });

  it('serves a clamped Overpass page at 500 elements, never more', async () => {
    mockOverpassQuery.mockReset().mockResolvedValue({
      ...minimalOverpassResponse,
      elements: Array.from({ length: 10_000 }, (_, i) => ({
        type: 'node' as const,
        id: i + 1,
        lat: 47.6,
        lon: -122.3,
      })),
    });
    const result = await runToolContract(openstreetmapQueryRaw, {
      query: '[out:json];node(1);out;',
      limit: 10_000,
    });
    expect((result.structuredContent as { elements: unknown[] }).elements).toHaveLength(500);
  });

  // #60: the per-element byte budget is a second size lever on the same tool, so
  // it carries the same schema-level boundary coverage `limit` already has.
  it('query_raw rejects max_element_bytes below 1000 at schema level', () => {
    expect(() =>
      openstreetmapQueryRaw.input.parse({
        query: '[out:json];node(1);out;',
        max_element_bytes: 999,
      }),
    ).toThrow();
  });

  // #105: an output byte budget has no ceiling; the 10,000,000 one only stranded the
  // elements above it with no retrieval recipe.
  it('query_raw accepts max_element_bytes above the former 10000000 ceiling', () => {
    expect(() =>
      openstreetmapQueryRaw.input.parse({
        query: '[out:json];node(1);out;',
        max_element_bytes: 20_000_000,
      }),
    ).not.toThrow();
  });

  it('query_raw accepts max_element_bytes at its floor and at the former ceiling', () => {
    for (const max_element_bytes of [1_000, 10_000_000]) {
      expect(() =>
        openstreetmapQueryRaw.input.parse({ query: '[out:json];node(1);out;', max_element_bytes }),
      ).not.toThrow();
    }
  });

  /**
   * The rejection has to reach the caller as a dual-surface error envelope naming
   * the offending field, with the handler never invoked.
   *
   * On the wire that envelope carries `InvalidParams` (-32602) — since mcp-ts-core
   * 0.13.2, `runToolContract` rejects out-of-schema arguments through the same
   * `parseToolArguments` path the production SDK uses, so the helper and a real
   * client now agree on both code and message.
   */
  it('rejects an out-of-range max_element_bytes before the handler runs', async () => {
    mockOverpassQuery.mockReset();
    const result = await runToolContract(openstreetmapQueryRaw, {
      query: '[out:json];node(1);out;',
      max_element_bytes: 10,
    } as never);

    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { code: number; message: string } }).error;
    expect(error.message).toContain('max_element_bytes');
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(mockOverpassQuery).not.toHaveBeenCalled();
  });

  it('reverse rejects zoom above 18 at schema level', () => {
    expect(() =>
      openstreetmapReverseGeocode.input.parse({ lat: 47.6, lon: -122.3, zoom: 19 }),
    ).toThrow();
  });

  it('reverse rejects zoom below 3 at schema level', () => {
    expect(() =>
      openstreetmapReverseGeocode.input.parse({ lat: 47.6, lon: -122.3, zoom: 2 }),
    ).toThrow();
  });

  // Regression for #54: an empty element_types passed validation and produced a
  // degenerate Overpass union that could only match nothing.
  it('query_nearby rejects an empty element_types at schema level', () => {
    expect(() =>
      openstreetmapQueryNearby.input.parse({
        lat: 47.6205,
        lon: -122.3493,
        amenity: 'cafe',
        element_types: [],
      }),
    ).toThrow();
  });

  it('query_nearby accepts a single element type (min boundary)', () => {
    expect(() =>
      openstreetmapQueryNearby.input.parse({
        lat: 47.6205,
        lon: -122.3493,
        amenity: 'cafe',
        element_types: ['node'],
      }),
    ).not.toThrow();
  });

  it('query_bbox rejects an empty element_types at schema level', () => {
    expect(() =>
      openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'cafe',
        element_types: [],
      }),
    ).toThrow();
  });

  it('query_bbox accepts a single element type (min boundary)', () => {
    expect(() =>
      openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'cafe',
        element_types: ['way'],
      }),
    ).not.toThrow();
  });

  // #105: 51 IDs used to be rejected here; past 50 unique IDs the rest are deferred now,
  // and the schema rejects only past 500 entries.
  it('lookup admits 51 osm_ids for the handler to defer, and rejects 501', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `N${i + 1}`);
    expect(() => openstreetmapLookupObjects.input.parse({ osm_ids: ids(51) })).not.toThrow();
    expect(() => openstreetmapLookupObjects.input.parse({ osm_ids: ids(501) })).toThrow();
  });

  it('lookup accepts exactly 500 osm_ids (max boundary) and sends at most 50 upstream', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => `N${i + 1}`);
    mockNominatimLookup.mockReset().mockResolvedValue([]);
    const result = await runToolContract(openstreetmapLookupObjects, { osm_ids: ids });
    expect(mockNominatimLookup).toHaveBeenCalledOnce();
    expect(
      (mockNominatimLookup.mock.calls[0] as unknown as [{ osm_ids: string[] }])[0].osm_ids,
    ).toHaveLength(50);
    expect((result.structuredContent as { deferred_ids: string[] }).deferred_ids).toHaveLength(450);
  });
});

/**
 * #105 loosened only output-size bounds. These bound upstream work or the domain, so a
 * clamp would answer a different query; each still rejects at the schema.
 */
describe('bounds that still reject (#105)', () => {
  const NEARBY = { lat: 47.6, lon: -122.3, amenity: 'cafe' };
  const BOX = { south: 47.5, west: -122.5, north: 47.7, east: -122.2, amenity: 'cafe' };
  const RAW = { query: '[out:json];node(1);out;' };
  const sixFilters = Array.from({ length: 6 }, (_, i) => ({ key: `key${i}` }));

  const cases = [
    [openstreetmapQueryNearby, { ...NEARBY, radius_meters: 50_001 }, 'radius_meters', 'too_big'],
    [openstreetmapQueryNearby, { ...NEARBY, timeout_seconds: 61 }, 'timeout_seconds', 'too_big'],
    [openstreetmapQueryBbox, { ...BOX, timeout_seconds: 61 }, 'timeout_seconds', 'too_big'],
    [openstreetmapQueryRaw, { ...RAW, timeout_seconds: 181 }, 'timeout_seconds', 'too_big'],
    [openstreetmapQueryNearby, { ...NEARBY, filters: sixFilters }, 'filters', 'too_big'],
    [openstreetmapQueryBbox, { ...BOX, filters: sixFilters }, 'filters', 'too_big'],
    [openstreetmapQueryNearby, { ...NEARBY, lat: 91 }, 'lat', 'too_big'],
    [openstreetmapQueryNearby, { ...NEARBY, lon: 181 }, 'lon', 'too_big'],
    [openstreetmapQueryBbox, { ...BOX, north: 91 }, 'north', 'too_big'],
    [openstreetmapQueryBbox, { ...BOX, east: 181 }, 'east', 'too_big'],
    [openstreetmapReverseGeocode, { lat: 91, lon: 0 }, 'lat', 'too_big'],
    [openstreetmapReverseGeocode, { lat: 47.6, lon: -122.3, zoom: 19 }, 'zoom', 'too_big'],
    [openstreetmapReverseGeocode, { lat: 47.6, lon: -122.3, zoom: 2 }, 'zoom', 'too_small'],
    [openstreetmapQueryRaw, { ...RAW, max_element_bytes: 999 }, 'max_element_bytes', 'too_small'],
  ] as const;

  for (const [definition, args, field, code] of cases) {
    it(`${definition.name} rejects ${field} as ${code}`, () => {
      const parsed = (
        definition.input as {
          safeParse(value: unknown): {
            success: boolean;
            error?: { issues: { path: PropertyKey[]; code: string }[] };
          };
        }
      ).safeParse(args);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => [issue.path[0], issue.code])).toEqual([
        [field, code],
      ]);
    });
  }
});

describe('coordinate boundary validation', () => {
  it('reverse rejects lat above 90', () => {
    expect(() => openstreetmapReverseGeocode.input.parse({ lat: 91, lon: 0 })).toThrow();
  });

  it('reverse rejects lat below -90', () => {
    expect(() => openstreetmapReverseGeocode.input.parse({ lat: -91, lon: 0 })).toThrow();
  });

  it('reverse rejects lon above 180', () => {
    expect(() => openstreetmapReverseGeocode.input.parse({ lat: 0, lon: 181 })).toThrow();
  });

  it('reverse rejects lon below -180', () => {
    expect(() => openstreetmapReverseGeocode.input.parse({ lat: 0, lon: -181 })).toThrow();
  });

  it('query_nearby rejects lat above 90', () => {
    expect(() =>
      openstreetmapQueryNearby.input.parse({ lat: 91, lon: 0, amenity: 'cafe' }),
    ).toThrow();
  });

  it('query_bbox rejects south > north (valid schema but coordinates are inverted)', () => {
    // Schema allows values individually — inverted bbox passes schema validation.
    // This documents the current behavior (handler delegates to service without reordering).
    expect(() =>
      openstreetmapQueryBbox.input.parse({
        south: 47.7,
        west: -122.5,
        north: 47.5,
        east: -122.2,
        amenity: 'cafe',
      }),
    ).not.toThrow(); // schema does not enforce south < north — just documents this
  });
});

/**
 * #61: every one of the six tools interpolates community-edited OSM text straight
 * into its Markdown `content[]`. These drive `format()` directly — the surface the
 * issue reproduces against — with one fixture per tool family, so a site missed on
 * one tool cannot hide behind another tool's coverage.
 */
describe('markdown injection — content[] rendering (#61)', () => {
  /** Every rendered `content[]` text this server can produce, keyed by tool. */
  function renderAll(value: string): { tool: string; text: string }[] {
    const place = {
      place_id: 1,
      osm_type: 'node' as const,
      osm_id: 240109189,
      lat: 47.6,
      lon: -122.3,
      display_name: value,
      name: value,
      category: value,
      type: value,
      address: { road: value },
      boundingbox: [47.6, 47.7, -122.4, -122.3] as [number, number, number, number],
      extratags: { [value]: value },
    };
    const poi = {
      osm_type: 'node' as const,
      osm_id: 1,
      lat: 47.6,
      lon: -122.3,
      name: value,
      tags: { [value]: value },
    };
    const attribution = 'Data © OpenStreetMap contributors, ODbL 1.0';
    const textOf = (blocks: unknown[]) => (blocks[0] as { text: string }).text;

    return [
      {
        tool: 'openstreetmap_search_places',
        text: textOf(
          openstreetmapSearchPlaces.format!({ results: [place], total: 1, attribution }),
        ),
      },
      {
        tool: 'openstreetmap_lookup_objects',
        text: textOf(
          openstreetmapLookupObjects.format!({
            results: [place],
            not_found: [],
            total: 1,
            attribution,
          }),
        ),
      },
      {
        tool: 'openstreetmap_reverse_geocode',
        text: textOf(openstreetmapReverseGeocode.format!({ result: place, attribution })),
      },
      {
        tool: 'openstreetmap_query_nearby',
        text: textOf(
          openstreetmapQueryNearby.format!({
            elements: [{ ...poi, distance_meters: 12 }],
            attribution,
          }),
        ),
      },
      {
        tool: 'openstreetmap_query_bbox',
        text: textOf(openstreetmapQueryBbox.format!({ elements: [poi], attribution })),
      },
      {
        tool: 'openstreetmap_query_raw',
        text: textOf(
          openstreetmapQueryRaw.format!({
            elements: [
              {
                type: 'relation',
                id: 148838,
                tags: { name: value, [value]: value },
                // Nested free text reached only through the generic remaining-key
                // fallback, which serializes with JSON.stringify.
                members: [{ type: 'way', ref: 1, role: value }],
              },
            ],
            total_elements: 1,
            attribution,
          }),
        ),
      },
    ];
  }

  /**
   * Negative case: ordinary OSM text carries none of the escaped metacharacters,
   * so it must reach `content[]` byte-for-byte. This is what fails first if the
   * escape set is widened until real addresses grow backslashes.
   */
  describe('ordinary text renders unchanged', () => {
    const BENIGN = 'Pike Place Market';

    for (const { tool, text } of renderAll(BENIGN)) {
      it(`${tool} renders a plain name without escapes`, () => {
        expect(text).toContain(BENIGN);
        expect(markdownText(text)).toContain(BENIGN);
      });
    }

    it('leaves hyphenated codes, underscores and URLs untouched', () => {
      const code = 'US-WA country_code https://spaceneedle.com +1-206-555-1234';
      for (const { tool, text } of renderAll(code)) {
        expect(text, tool).toContain(code);
      }
    });
  });

  /**
   * Positive case: one fixture carrying every construct the issue names — an ATX
   * heading marker, emphasis, a link, a code span, an HTML tag, and an embedded
   * newline — driven through all six formatters. Each marker is uniquely spelled
   * so an assertion cannot pass on a formatter's own literal markup.
   */
  describe('hostile OSM text renders inert', () => {
    const HOSTILE =
      '# HeadingMark *emphMark* [linkMark](https://evil.example) `codeMark` <script>alert(1)</script> _underMark_\nSecondLineMark';

    for (const { tool, text } of renderAll(HOSTILE)) {
      describe(tool, () => {
        it('escapes the heading marker, emphasis and code span', () => {
          expect(text).toContain('\\# HeadingMark');
          expect(text).toContain('\\*emphMark\\*');
          expect(text).toContain('\\`codeMark\\`');
        });

        it('cannot form a link out of upstream brackets and parens', () => {
          // Both scalars and serialized JSON disarm links by escaping their brackets.
          expect(text).toContain('linkMark');
          expect(text).not.toMatch(/(?<!\\)\]\(/);
        });

        it('renders angle-bracket HTML inert', () => {
          expect(markdownText(text)).toContain('<script>alert(1)</script>');
          expect(commonmark.render(text)).not.toContain('<script>');
        });

        it('preserves an embedded newline without opening new Markdown structure', () => {
          expect(markdownText(text)).toContain('_underMark_\nSecondLineMark');
          const blocks = commonmark.parse(text, {});
          expect(blocks.filter((token) => token.type === 'heading_open')).toHaveLength(0);
          expect(
            blocks
              .flatMap((token) => token.children ?? [])
              .some((token) => token.type === 'hardbreak'),
          ).toBe(true);
        });

        it('escapes a word-boundary underscore while leaving intraword ones alone', () => {
          // #61: `_` is escaped only where CommonMark can read it as emphasis —
          // at a word boundary. Intraword occurrences carry no emphasis meaning
          // and are pervasive in OSM keys, so they stay clean.
          expect(text).toContain('\\_underMark\\_');
          expect(text).not.toMatch(/(?<![\\A-Za-z0-9])_underMark/);
        });
      });
    }
  });

  /**
   * #61 is a render-boundary fix: `structuredContent` must keep the upstream bytes
   * exactly, on every tool. A pass that escaped in the handler instead would show
   * up here as a backslash in the raw value.
   */
  describe('structuredContent keeps the raw upstream bytes', () => {
    const HOSTILE = '# h *e* [l](u) `c` <script>x</script>\nline2';

    const hostilePlace: NominatimPlace = {
      ...minimalPlace,
      display_name: HOSTILE,
      name: HOSTILE,
      address: { road: HOSTILE },
      extratags: { [HOSTILE]: HOSTILE },
    };
    const hostilePoi: OverpassPoi = {
      osm_type: 'node',
      osm_id: 1,
      lat: 47.6,
      lon: -122.3,
      name: HOSTILE,
      tags: { name: HOSTILE, [HOSTILE]: HOSTILE },
    };

    beforeEach(() => {
      mockNominatimSearch.mockReset().mockResolvedValue([hostilePlace]);
      mockNominatimReverse.mockReset().mockResolvedValue(hostilePlace);
      mockNominatimLookup.mockReset().mockResolvedValue([hostilePlace]);
      mockOverpassQuery.mockReset().mockResolvedValue({
        ...minimalOverpassResponse,
        elements: [{ type: 'node', id: 1, tags: { name: HOSTILE } }],
      });
      mockNormalizeElements.mockReset().mockReturnValue([hostilePoi]);
      mockBuildAroundQuery.mockReset().mockReturnValue('[out:json]');
      mockBuildBboxQuery.mockReset().mockReturnValue('[out:json]');
    });

    it('openstreetmap_search_places', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const result = await openstreetmapSearchPlaces.handler(
        openstreetmapSearchPlaces.input.parse({ query: 'x', extratags: true }),
        ctx,
      );
      expect(result.results[0]!.display_name).toBe(HOSTILE);
      expect(result.results[0]!.name).toBe(HOSTILE);
      expect(result.results[0]!.address).toEqual({ road: HOSTILE });
      expect(result.results[0]!.extratags).toEqual({ [HOSTILE]: HOSTILE });
    });

    it('openstreetmap_reverse_geocode', async () => {
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const result = await openstreetmapReverseGeocode.handler(
        openstreetmapReverseGeocode.input.parse({ lat: 47.6, lon: -122.3, extratags: true }),
        ctx,
      );
      expect(result.result.display_name).toBe(HOSTILE);
      expect(result.result.extratags).toEqual({ [HOSTILE]: HOSTILE });
    });

    it('openstreetmap_lookup_objects', async () => {
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const result = await openstreetmapLookupObjects.handler(
        openstreetmapLookupObjects.input.parse({ osm_ids: ['N1'], extratags: true }),
        ctx,
      );
      expect(result.results[0]!.display_name).toBe(HOSTILE);
    });

    it('openstreetmap_query_nearby', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const result = await openstreetmapQueryNearby.handler(
        openstreetmapQueryNearby.input.parse({ lat: 47.6, lon: -122.3, amenity: 'cafe' }),
        ctx,
      );
      expect(result.elements[0]!.name).toBe(HOSTILE);
      expect(result.elements[0]!.tags).toEqual({ name: HOSTILE, [HOSTILE]: HOSTILE });
    });

    it('openstreetmap_query_bbox', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
      const result = await openstreetmapQueryBbox.handler(
        openstreetmapQueryBbox.input.parse({
          south: 47.5,
          west: -122.5,
          north: 47.7,
          east: -122.2,
          amenity: 'cafe',
        }),
        ctx,
      );
      expect(result.elements[0]!.name).toBe(HOSTILE);
      expect(result.elements[0]!.tags).toEqual({ name: HOSTILE, [HOSTILE]: HOSTILE });
    });

    it('openstreetmap_query_raw', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const result = await openstreetmapQueryRaw.handler(
        openstreetmapQueryRaw.input.parse({ query: '[out:json];node(1);out;' }),
        ctx,
      );
      expect(result.elements[0]).toEqual({ type: 'node', id: 1, tags: { name: HOSTILE } });
    });
  });
});

describe('unicode and encoding edge cases', () => {
  beforeEach(() => {
    mockNominatimSearch.mockReset().mockResolvedValue([minimalPlace]);
  });

  it('geocode accepts unicode query strings', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
    const input = openstreetmapSearchPlaces.input.parse({ query: '東京都千代田区' });
    const result = await openstreetmapSearchPlaces.handler(input, ctx);
    expect(result.total).toBe(1);
  });

  it('geocode accepts CJK characters in city field', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
    const input = openstreetmapSearchPlaces.input.parse({ city: '東京' });
    const result = await openstreetmapSearchPlaces.handler(input, ctx);
    expect(result.total).toBe(1);
  });

  it('geocode accepts null-byte-free unicode in query', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
    const input = openstreetmapSearchPlaces.input.parse({ query: 'Café de Flore, Paris' });
    const result = await openstreetmapSearchPlaces.handler(input, ctx);
    expect(result.total).toBe(1);
  });
});
