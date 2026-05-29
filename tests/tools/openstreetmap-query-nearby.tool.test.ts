/**
 * @fileoverview Tests for the openstreetmap-query-nearby tool.
 * @module tests/tools/openstreetmap-query-nearby.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

      expect(result.total_found).toBe(1);
      expect(result.elements).toHaveLength(1);
      expect(result.elements[0]).toMatchObject({
        osm_type: 'node',
        osm_id: 111222333,
        lat: 47.6105,
        lon: -122.3442,
        name: 'Coffee House',
      });
      expect(result.truncated).toBe(false);
      expect(result.data_timestamp).toBe('2025-01-01T00:00:00Z');
      expect(result.attribution).toContain('OpenStreetMap');
      expect(result.elements[0]!.distance_meters).toBeGreaterThan(0);
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

      expect(result.total_found).toBe(25);
      expect(result.elements).toHaveLength(20);
      expect(result.truncated).toBe(true);
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

      expect(result.total_found).toBe(5);
      expect(result.truncated).toBe(true);
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

  describe('missing timestamp fallback', () => {
    it('uses current ISO timestamp when osm3s is absent', async () => {
      mockQuery.mockResolvedValue({ version: 0.6, elements: [mockElement] });
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryNearby.errors });
      const input = openstreetmapQueryNearby.input.parse({
        lat: 47.6,
        lon: -122.3,
        amenity: 'pharmacy',
      });
      const result = await openstreetmapQueryNearby.handler(input, ctx);
      expect(result.data_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
        total_found: 1,
        truncated: false,
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

    it('renders truncation notice when truncated', () => {
      const output = {
        elements: [
          {
            osm_type: 'node' as const,
            osm_id: 1,
            tags: { amenity: 'cafe' },
          },
        ],
        total_found: 100,
        truncated: true,
        data_timestamp: '2025-01-01T00:00:00Z',
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryNearby.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('100 features found');
      expect(text).toContain('results truncated');
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
        total_found: 1,
        truncated: false,
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
        total_found: 1,
        truncated: false,
        data_timestamp: '2025-01-01T00:00:00Z',
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryNearby.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Unnamed');
    });
  });
});
