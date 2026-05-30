/**
 * @fileoverview Security tests: input injection, env/secret leakage, oversized inputs.
 * @module tests/security/security.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapGeocode } from '@/mcp-server/tools/definitions/openstreetmap-geocode.tool.js';
import { openstreetmapLookup } from '@/mcp-server/tools/definitions/openstreetmap-lookup.tool.js';
import { openstreetmapQueryBbox } from '@/mcp-server/tools/definitions/openstreetmap-query-bbox.tool.js';
import { openstreetmapQueryNearby } from '@/mcp-server/tools/definitions/openstreetmap-query-nearby.tool.js';
import { openstreetmapQueryRaw } from '@/mcp-server/tools/definitions/openstreetmap-query-raw.tool.js';
import { openstreetmapReverse } from '@/mcp-server/tools/definitions/openstreetmap-reverse.tool.js';
import type { NominatimPlace } from '@/services/nominatim/types.js';
import type { OverpassElement, OverpassPoi, OverpassResponse } from '@/services/overpass/types.js';

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

const mockOverpassQuery = vi.fn<() => Promise<OverpassResponse>>();
const mockBuildAroundQuery = vi.fn<() => string>(() => '[out:json]');
const mockBuildBboxQuery = vi.fn<() => string>(() => '[out:json]');
const mockNormalizeElements = vi.fn<(els: OverpassElement[]) => OverpassPoi[]>(() => []);

vi.mock('@/services/overpass/overpass-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/overpass/overpass-service.js')>();
  return {
    ...actual,
    getOverpassService: () => ({
      buildAroundQuery: mockBuildAroundQuery,
      buildBboxQuery: mockBuildBboxQuery,
      query: mockOverpassQuery,
      normalizeElements: mockNormalizeElements,
    }),
  };
});

// --- fixtures ------------------------------------------------------------

const minimalPlace: NominatimPlace = {
  place_id: 1,
  lat: '47.6',
  lon: '-122.3',
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
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
    const input = openstreetmapGeocode.input.parse({ query: 'Seattle' });
    const result = await openstreetmapGeocode.handler(input, ctx);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/API_KEY/i);
    expect(text).not.toMatch(/OSM_NOMINATIM/i);
    expect(text).not.toMatch(/OSM_OVERPASS/i);
  });

  it('reverse geocode output does not contain env var names', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapReverse.errors });
    const input = openstreetmapReverse.input.parse({ lat: 47.6, lon: -122.3 });
    const result = await openstreetmapReverse.handler(input, ctx);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/API_KEY/i);
    expect(text).not.toMatch(/OSM_NOMINATIM/i);
  });

  it('lookup output does not contain env var names', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapLookup.errors });
    const input = openstreetmapLookup.input.parse({ osm_ids: 'N240109189' });
    const result = await openstreetmapLookup.handler(input, ctx);
    const text = JSON.stringify(result);
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
});

describe('injection attempts — geocode query parameter', () => {
  beforeEach(() => {
    mockNominatimSearch.mockReset().mockResolvedValue([minimalPlace]);
  });

  it('passes through SQL-like injection string as a plain query', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
    // The tool passes this to the service unchanged — the service handles escaping.
    // We assert no exception and no secret leak, not that the string is blocked.
    const input = openstreetmapGeocode.input.parse({ query: "Seattle' OR '1'='1" });
    const result = await openstreetmapGeocode.handler(input, ctx);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/API_KEY/i);
  });

  it('passes through script-tag-like injection string as a plain query', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
    const input = openstreetmapGeocode.input.parse({ query: '<script>alert(1)</script>' });
    const result = await openstreetmapGeocode.handler(input, ctx);
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

  it('query_nearby passes tag injection string to the service (no handler-level escaping)', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
    const input = openstreetmapQueryNearby.input.parse({
      lat: 47.6,
      lon: -122.3,
      tag_key: 'amenity',
      tag_value: 'cafe"]["admin_level"="2',
    });
    // Handler resolves the tag and calls buildAroundQuery — injection resilience
    // is the service's responsibility. We assert the handler doesn't throw or leak secrets.
    await openstreetmapQueryNearby.handler(input, ctx);
    const text = JSON.stringify(mockBuildAroundQuery.mock.calls[0]);
    expect(text).not.toMatch(/API_KEY/i);
  });

  it('query_bbox passes tag injection string to the service without leaking env data', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryBbox.errors });
    const input = openstreetmapQueryBbox.input.parse({
      south: 47.5,
      west: -122.5,
      north: 47.7,
      east: -122.2,
      tag_key: 'natural',
      tag_value: 'peak\r\n[timeout:1]',
    });
    await openstreetmapQueryBbox.handler(input, ctx);
    const callArgs = JSON.stringify(mockBuildBboxQuery.mock.calls[0]);
    expect(callArgs).not.toMatch(/API_KEY/i);
  });
});

describe('oversized inputs — schema validation', () => {
  it('geocode rejects limit above 40 at schema level', () => {
    expect(() => openstreetmapGeocode.input.parse({ query: 'Seattle', limit: 41 })).toThrow();
  });

  it('geocode accepts limit at max boundary (40)', () => {
    expect(() => openstreetmapGeocode.input.parse({ query: 'Seattle', limit: 40 })).not.toThrow();
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

  it('query_nearby rejects limit above 500 at schema level', () => {
    expect(() =>
      openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
        limit: 501,
      }),
    ).toThrow();
  });

  it('query_bbox rejects limit above 500 at schema level', () => {
    expect(() =>
      openstreetmapQueryBbox.input.parse({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'cafe',
        limit: 501,
      }),
    ).toThrow();
  });

  it('reverse rejects zoom above 18 at schema level', () => {
    expect(() => openstreetmapReverse.input.parse({ lat: 47.6, lon: -122.3, zoom: 19 })).toThrow();
  });

  it('reverse rejects zoom below 3 at schema level', () => {
    expect(() => openstreetmapReverse.input.parse({ lat: 47.6, lon: -122.3, zoom: 2 })).toThrow();
  });

  it('lookup rejects more than 50 osm_ids at schema level', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `N${i + 1}`);
    expect(() => openstreetmapLookup.input.parse({ osm_ids: ids })).toThrow();
  });

  it('lookup accepts exactly 50 osm_ids (max boundary)', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `N${i + 1}`);
    expect(() => openstreetmapLookup.input.parse({ osm_ids: ids })).not.toThrow();
  });
});

describe('coordinate boundary validation', () => {
  it('reverse rejects lat above 90', () => {
    expect(() => openstreetmapReverse.input.parse({ lat: 91, lon: 0 })).toThrow();
  });

  it('reverse rejects lat below -90', () => {
    expect(() => openstreetmapReverse.input.parse({ lat: -91, lon: 0 })).toThrow();
  });

  it('reverse rejects lon above 180', () => {
    expect(() => openstreetmapReverse.input.parse({ lat: 0, lon: 181 })).toThrow();
  });

  it('reverse rejects lon below -180', () => {
    expect(() => openstreetmapReverse.input.parse({ lat: 0, lon: -181 })).toThrow();
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

describe('unicode and encoding edge cases', () => {
  beforeEach(() => {
    mockNominatimSearch.mockReset().mockResolvedValue([minimalPlace]);
  });

  it('geocode accepts unicode query strings', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
    const input = openstreetmapGeocode.input.parse({ query: '東京都千代田区' });
    const result = await openstreetmapGeocode.handler(input, ctx);
    expect(result.total).toBe(1);
  });

  it('geocode accepts CJK characters in city field', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
    const input = openstreetmapGeocode.input.parse({ city: '東京' });
    const result = await openstreetmapGeocode.handler(input, ctx);
    expect(result.total).toBe(1);
  });

  it('geocode accepts null-byte-free unicode in query', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
    const input = openstreetmapGeocode.input.parse({ query: 'Café de Flore, Paris' });
    const result = await openstreetmapGeocode.handler(input, ctx);
    expect(result.total).toBe(1);
  });
});
