/**
 * @fileoverview Tests for the openstreetmap-reverse-geocode tool.
 * @module tests/tools/openstreetmap-reverse-geocode.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapReverseGeocode } from '@/mcp-server/tools/definitions/openstreetmap-reverse-geocode.tool.js';
import type { NominatimPlace } from '@/services/nominatim/types.js';

// --- service mock --------------------------------------------------------

const mockReverse = vi.fn<() => Promise<NominatimPlace>>();

vi.mock('@/services/nominatim/nominatim-service.js', () => ({
  getNominatimService: () => ({ reverse: mockReverse }),
}));

// --- fixtures ------------------------------------------------------------

const validPlace: NominatimPlace = {
  place_id: 5678,
  osm_type: 'way',
  osm_id: 50637691,
  lat: '47.6062',
  lon: '-122.3321',
  display_name: '400 Broad Street, Seattle, Washington, 98109, United States',
  name: 'Space Needle',
  category: 'man_made',
  type: 'tower',
  address: {
    house_number: '400',
    road: 'Broad Street',
    city: 'Seattle',
    state: 'Washington',
    postcode: '98109',
    country: 'United States',
    country_code: 'us',
  },
  boundingbox: ['47.619', '47.622', '-122.352', '-122.347'],
};

const noDataPlace: NominatimPlace = {
  place_id: 0,
  lat: '0',
  lon: '0',
  display_name: '',
  error: 'Unable to geocode',
};

const sparsePlace: NominatimPlace = {
  place_id: 1111,
  lat: '47.6',
  lon: '-122.3',
  display_name: 'Some unnamed road, Seattle, WA',
};

// -------------------------------------------------------------------------

describe('openstreetmapReverseGeocode', () => {
  beforeEach(() => {
    mockReverse.mockReset();
  });

  describe('happy path', () => {
    it('returns the closest OSM object for valid coordinates', async () => {
      mockReverse.mockResolvedValue(validPlace);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({ lat: 47.6205, lon: -122.3493 });
      const result = await openstreetmapReverseGeocode.handler(input, ctx);

      expect(result.result).toMatchObject({
        place_id: 5678,
        osm_type: 'way',
        osm_id: 50637691,
        lat: '47.6062',
        lon: '-122.3321',
        display_name: expect.stringContaining('Broad Street'),
        name: 'Space Needle',
        category: 'man_made',
        type: 'tower',
      });
      expect(result.attribution).toContain('OpenStreetMap');
    });

    it('accepts optional parameters (zoom, layer, extratags, language)', async () => {
      mockReverse.mockResolvedValue(validPlace);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({
        lat: 47.6062,
        lon: -122.3321,
        zoom: 16,
        extratags: true,
        language: 'en',
      });
      const result = await openstreetmapReverseGeocode.handler(input, ctx);
      expect(result.result.place_id).toBe(5678);
      expect(mockReverse).toHaveBeenCalledOnce();
    });
  });

  describe('sparse upstream payload', () => {
    it('handles a result missing all optional fields', async () => {
      mockReverse.mockResolvedValue(sparsePlace);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({ lat: 47.6, lon: -122.3 });
      const result = await openstreetmapReverseGeocode.handler(input, ctx);

      expect(result.result.place_id).toBe(1111);
      expect(result.result.name).toBeUndefined();
      expect(result.result.category).toBeUndefined();
      expect(result.result.address).toBeUndefined();
    });
  });

  describe('error paths', () => {
    it('throws no_coverage when Nominatim returns an error field', async () => {
      mockReverse.mockResolvedValue(noDataPlace);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({ lat: 0, lon: 0 });
      await expect(openstreetmapReverseGeocode.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_coverage' },
      });
    });

    it('propagates service errors', async () => {
      mockReverse.mockRejectedValue(new Error('ServiceUnavailable'));
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({ lat: 47.6, lon: -122.3 });
      await expect(openstreetmapReverseGeocode.handler(input, ctx)).rejects.toThrow(
        'ServiceUnavailable',
      );
    });
  });

  describe('format', () => {
    it('renders all key fields', () => {
      const output = {
        result: {
          place_id: 5678,
          osm_type: 'way' as const,
          osm_id: 50637691,
          lat: '47.6062',
          lon: '-122.3321',
          display_name: '400 Broad Street, Seattle, WA',
          name: 'Space Needle',
          category: 'man_made',
          type: 'tower',
          address: { road: 'Broad Street', city: 'Seattle' },
          boundingbox: ['47.619', '47.622', '-122.352', '-122.347'] as [
            string,
            string,
            string,
            string,
          ],
        },
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapReverseGeocode.format!(output);
      expect(blocks[0]!.type).toBe('text');
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Space Needle');
      expect(text).toContain('47.6062');
      expect(text).toContain('-122.3321');
      expect(text).toContain('5678');
      expect(text).toContain('W50637691');
      expect(text).toContain('man_made');
      expect(text).toContain('OpenStreetMap');
    });

    it('renders without optional fields when absent', () => {
      const output = {
        result: {
          place_id: 1111,
          lat: '47.6',
          lon: '-122.3',
          display_name: 'Some road, Seattle, WA',
        },
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapReverseGeocode.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('1111');
      expect(text).toContain('47.6');
    });
  });
});
