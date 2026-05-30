/**
 * @fileoverview Edge case and validation tests spanning all six tools.
 * @module tests/tools/openstreetmap-edge-cases.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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

// --- mocks ---------------------------------------------------------------

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

describe('openstreetmapGeocode — schema edge cases', () => {
  beforeEach(() => {
    mockNominatimSearch.mockReset().mockResolvedValue([minimalPlace]);
  });

  it('rejects limit=0 (below min)', () => {
    expect(() => openstreetmapGeocode.input.parse({ query: 'Seattle', limit: 0 })).toThrow();
  });

  it('accepts limit=1 (min boundary)', () => {
    const input = openstreetmapGeocode.input.parse({ query: 'Seattle', limit: 1 });
    expect(input.limit).toBe(1);
  });

  it('accepts featureType enum values', () => {
    for (const ft of ['country', 'state', 'city', 'settlement'] as const) {
      const input = openstreetmapGeocode.input.parse({ query: 'test', featureType: ft });
      expect(input.featureType).toBe(ft);
    }
  });

  it('rejects invalid featureType values', () => {
    expect(() =>
      openstreetmapGeocode.input.parse({ query: 'test', featureType: 'district' }),
    ).toThrow();
  });

  it('handles empty string query (treated as missing — triggers invalid_input)', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
    const input = openstreetmapGeocode.input.parse({ query: '   ' }); // whitespace only
    await expect(openstreetmapGeocode.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_input' },
    });
  });

  it('accepts a query with postalcode as a structured field', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
    const input = openstreetmapGeocode.input.parse({ postalcode: '98101' });
    const result = await openstreetmapGeocode.handler(input, ctx);
    expect(result.total).toBe(1);
  });

  it('accepts a query with all structured fields simultaneously', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
    const input = openstreetmapGeocode.input.parse({
      street: '400 Broad Street',
      city: 'Seattle',
      state: 'Washington',
      country: 'US',
      postalcode: '98109',
    });
    const result = await openstreetmapGeocode.handler(input, ctx);
    expect(result.total).toBe(1);
  });
});

describe('openstreetmapGeocode — format edge cases', () => {
  it('renders singular "result" for exactly one result', () => {
    const output = {
      results: [{ place_id: 1, lat: '47.0', lon: '-122.0', display_name: 'Place' }],
      total: 1,
      attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
    };
    const blocks = openstreetmapGeocode.format!(output);
    expect((blocks[0] as { text: string }).text).toContain('1 result found');
  });

  it('renders address details skipping country_code key', () => {
    const output = {
      results: [
        {
          place_id: 1,
          lat: '47.0',
          lon: '-122.0',
          display_name: 'Place',
          address: { city: 'Seattle', country_code: 'us' },
        },
      ],
      total: 1,
      attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
    };
    const blocks = openstreetmapGeocode.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('city: Seattle');
    expect(text).not.toContain('country_code');
  });
});

describe('openstreetmapReverse — edge cases', () => {
  beforeEach(() => {
    mockNominatimReverse.mockReset();
  });

  it('accepts zoom at min boundary (3)', () => {
    expect(() =>
      openstreetmapReverse.input.parse({ lat: 47.6, lon: -122.3, zoom: 3 }),
    ).not.toThrow();
  });

  it('accepts zoom at max boundary (18)', () => {
    expect(() =>
      openstreetmapReverse.input.parse({ lat: 47.6, lon: -122.3, zoom: 18 }),
    ).not.toThrow();
  });

  it('accepts boundary coordinates lat=90, lon=180', () => {
    expect(() => openstreetmapReverse.input.parse({ lat: 90, lon: 180 })).not.toThrow();
  });

  it('accepts boundary coordinates lat=-90, lon=-180', () => {
    expect(() => openstreetmapReverse.input.parse({ lat: -90, lon: -180 })).not.toThrow();
  });

  it('format renders without name heading when name is absent', () => {
    const output = {
      result: {
        place_id: 1,
        lat: '47.6',
        lon: '-122.3',
        display_name: 'Some Road, Seattle, WA',
      },
      attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
    };
    const blocks = openstreetmapReverse.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // Should not start with a heading if name is absent
    expect(text).not.toMatch(/^##/);
    expect(text).toContain('47.6');
  });
});

describe('openstreetmapLookup — edge cases', () => {
  beforeEach(() => {
    mockNominatimLookup.mockReset();
  });

  it('accepts a relation ID (R prefix)', async () => {
    mockNominatimLookup.mockResolvedValue([
      { ...minimalPlace, osm_type: 'relation', osm_id: 146656 },
    ]);
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapLookup.errors });
    const input = openstreetmapLookup.input.parse({ osm_ids: 'R146656' });
    const result = await openstreetmapLookup.handler(input, ctx);
    expect(result.results[0]?.osm_type).toBe('relation');
  });

  it('throws invalid_id_format for numeric-only ID', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapLookup.errors });
    const input = openstreetmapLookup.input.parse({ osm_ids: '12345' });
    await expect(openstreetmapLookup.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id_format' },
    });
  });

  it('throws invalid_id_format for empty-string ID in array', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapLookup.errors });
    const input = openstreetmapLookup.input.parse({ osm_ids: ['N123', ''] });
    await expect(openstreetmapLookup.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id_format' },
    });
  });

  it('throws invalid_id_format for P-prefixed ID', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapLookup.errors });
    const input = openstreetmapLookup.input.parse({ osm_ids: 'P12345' });
    await expect(openstreetmapLookup.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id_format' },
    });
  });

  it('format renders empty result set with zero count', () => {
    const output = {
      results: [],
      not_found: ['N99999'],
      total: 0,
      attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
    };
    const blocks = openstreetmapLookup.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0 results found');
    expect(text).toContain('Not found');
    expect(text).toContain('N99999');
  });

  it('format renders singular "result" for one result', () => {
    const output = {
      results: [{ place_id: 1, lat: '47.0', lon: '-122.0', display_name: 'A Place' }],
      not_found: [],
      total: 1,
      attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
    };
    const blocks = openstreetmapLookup.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('1 result found');
  });
});

describe('openstreetmapQueryRaw — missing [out:json] preflight', () => {
  beforeEach(() => {
    mockOverpassQuery.mockReset().mockResolvedValue(minimalOverpassResponse);
  });

  it('throws query_error when [out:json] is absent from query', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
    const input = openstreetmapQueryRaw.input.parse({
      query: '[timeout:30];node["natural"="peak"](47.5,-122.5,47.7,-122.2);out body;',
    });
    await expect(openstreetmapQueryRaw.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'query_error' },
    });
    expect(mockOverpassQuery).not.toHaveBeenCalled();
  });

  it('accepts query with [out:json] at start', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
    const input = openstreetmapQueryRaw.input.parse({
      query: '[out:json][timeout:10];node(1234567);out;',
    });
    const result = await openstreetmapQueryRaw.handler(input, ctx);
    expect(result.total_elements).toBe(0);
  });

  it('accepts query with [out:json] prefixed by whitespace', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
    const input = openstreetmapQueryRaw.input.parse({
      query: '  [out:json];node(1);out;',
    });
    // trim() is applied in the handler
    const result = await openstreetmapQueryRaw.handler(input, ctx);
    expect(result.total_elements).toBe(0);
  });

  it('format handles empty elements array', () => {
    const output = {
      elements: [],
      total_elements: 0,
      attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
    };
    const blocks = openstreetmapQueryRaw.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0 elements returned');
  });
});

describe('openstreetmapQueryBbox — rate_limited via statusCode path', () => {
  beforeEach(() => {
    mockBuildBboxQuery.mockReset().mockReturnValue('[out:json]');
    mockNormalizeElements.mockReset().mockReturnValue([]);
  });

  it('remaps HTTP 429 with no reason field to rate_limited', async () => {
    mockOverpassQuery.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Too Many Requests', {
        statusCode: 429,
        errorSource: 'FetchHttpError',
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
    expect(err.data.reason).toBe('rate_limited');
    expect(err.data.recovery?.hint).toBeDefined();
  });
});

describe('openstreetmapQueryNearby — rate_limited via statusCode path', () => {
  beforeEach(() => {
    mockBuildAroundQuery.mockReset().mockReturnValue('[out:json]');
    mockNormalizeElements.mockReset().mockReturnValue([]);
  });

  it('remaps HTTP 429 with no reason field to rate_limited', async () => {
    mockOverpassQuery.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Too Many Requests', {
        statusCode: 429,
        errorSource: 'FetchHttpError',
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
    expect(err.data.reason).toBe('rate_limited');
    expect(err.data.recovery?.hint).toBeDefined();
  });
});

describe('openstreetmapQueryRaw — rate_limited via statusCode 429 path', () => {
  it('remaps HTTP 429 with no reason field to rate_limited', async () => {
    mockOverpassQuery.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Too Many Requests', { statusCode: 429 }),
    );
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
    const input = openstreetmapQueryRaw.input.parse({
      query: '[out:json];node(1);out;',
    });
    const err = await openstreetmapQueryRaw.handler(input, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.data.reason).toBe('rate_limited');
    expect(err.data.recovery?.hint).toBeDefined();
  });

  it('remaps HTTP 400 with no reason field to query_error', async () => {
    mockOverpassQuery.mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'Bad Request', { statusCode: 400 }),
    );
    const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
    const input = openstreetmapQueryRaw.input.parse({
      query: '[out:json];node(1);out;',
    });
    const err = await openstreetmapQueryRaw.handler(input, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.data.reason).toBe('query_error');
    expect(err.data.recovery?.hint).toBeDefined();
  });
});

describe('openstreetmapQueryBbox — format edge cases', () => {
  it('renders singular "feature" for one element', () => {
    const output = {
      elements: [{ osm_type: 'node' as const, osm_id: 1, tags: { amenity: 'cafe' } }],
      data_timestamp: '2025-01-01T00:00:00Z',
      attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
    };
    const blocks = openstreetmapQueryBbox.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('1 feature returned');
  });

  it('renders "Unnamed" for elements without a name', () => {
    const output = {
      elements: [{ osm_type: 'way' as const, osm_id: 999, tags: { building: 'yes' } }],
      data_timestamp: '2025-01-01T00:00:00Z',
      attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
    };
    const blocks = openstreetmapQueryBbox.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Unnamed');
  });

  it('omits coordinates line when lat/lon are absent', () => {
    const output = {
      elements: [{ osm_type: 'way' as const, osm_id: 888, tags: { building: 'yes' } }],
      data_timestamp: '2025-01-01T00:00:00Z',
      attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
    };
    const blocks = openstreetmapQueryBbox.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('**Coordinates:**');
  });
});

describe('openstreetmapQueryNearby — schema edge cases', () => {
  it('rejects timeout_seconds below 5', () => {
    expect(() =>
      openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
        timeout_seconds: 4,
      }),
    ).toThrow();
  });

  it('rejects timeout_seconds above 60', () => {
    expect(() =>
      openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
        timeout_seconds: 61,
      }),
    ).toThrow();
  });

  it('accepts timeout_seconds at boundaries (5 and 60)', () => {
    expect(() =>
      openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
        timeout_seconds: 5,
      }),
    ).not.toThrow();
    expect(() =>
      openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'cafe',
        timeout_seconds: 60,
      }),
    ).not.toThrow();
  });
});

describe('openstreetmapQueryRaw — schema edge cases', () => {
  it('rejects timeout_seconds above 180', () => {
    expect(() =>
      openstreetmapQueryRaw.input.parse({
        query: '[out:json];node(1);out;',
        timeout_seconds: 181,
      }),
    ).toThrow();
  });

  it('accepts timeout_seconds at max boundary (180)', () => {
    expect(() =>
      openstreetmapQueryRaw.input.parse({
        query: '[out:json];node(1);out;',
        timeout_seconds: 180,
      }),
    ).not.toThrow();
  });

  it('accepts timeout_seconds at min boundary (5)', () => {
    expect(() =>
      openstreetmapQueryRaw.input.parse({
        query: '[out:json];node(1);out;',
        timeout_seconds: 5,
      }),
    ).not.toThrow();
  });
});
