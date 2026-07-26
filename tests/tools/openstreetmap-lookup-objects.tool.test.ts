/**
 * @fileoverview Tests for the openstreetmap-lookup-objects tool.
 * @module tests/tools/openstreetmap-lookup-objects.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapLookupObjects } from '@/mcp-server/tools/definitions/openstreetmap-lookup-objects.tool.js';
import type { NominatimPlace } from '@/services/nominatim/types.js';

// --- service mock --------------------------------------------------------

const mockLookup = vi.fn<() => Promise<NominatimPlace[]>>();

vi.mock('@/services/nominatim/nominatim-service.js', () => ({
  getNominatimService: () => ({ lookup: mockLookup }),
}));

// --- fixtures ------------------------------------------------------------

const nodePlace: NominatimPlace = {
  place_id: 1001,
  osm_type: 'node',
  osm_id: 240109189,
  lat: '47.6205',
  lon: '-122.3493',
  display_name: 'Space Needle, 400 Broad Street, Seattle, WA',
  name: 'Space Needle',
  category: 'man_made',
  type: 'tower',
};

const wayPlace: NominatimPlace = {
  place_id: 2002,
  osm_type: 'way',
  osm_id: 50637691,
  lat: '47.6062',
  lon: '-122.3321',
  display_name: '1600 Pennsylvania Ave, Washington, DC',
};

// -------------------------------------------------------------------------

describe('openstreetmapLookupObjects', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  describe('happy path', () => {
    it('returns results for a single-element ID array', async () => {
      mockLookup.mockResolvedValue([nodePlace]);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['N240109189'] });
      const result = await openstreetmapLookupObjects.handler(input, ctx);

      expect(result.total).toBe(1);
      expect(result.results[0]).toMatchObject({
        place_id: 1001,
        osm_type: 'node',
        osm_id: 240109189,
        name: 'Space Needle',
      });
      expect(result.not_found).toHaveLength(0);
      expect(result.attribution).toContain('OpenStreetMap');
    });

    it('returns results for multiple OSM IDs', async () => {
      mockLookup.mockResolvedValue([nodePlace, wayPlace]);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({
        osm_ids: ['N240109189', 'W50637691'],
      });
      const result = await openstreetmapLookupObjects.handler(input, ctx);

      expect(result.total).toBe(2);
      expect(result.not_found).toHaveLength(0);
    });

    it('reports not_found IDs when service returns fewer results', async () => {
      mockLookup.mockResolvedValue([nodePlace]); // only one result for two requested IDs
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({
        osm_ids: ['N240109189', 'W99999999'],
      });
      const result = await openstreetmapLookupObjects.handler(input, ctx);

      expect(result.total).toBe(1);
      expect(result.not_found).toContain('W99999999');
    });

    it('normalizes IDs to uppercase before lookup', async () => {
      mockLookup.mockResolvedValue([nodePlace]);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['n240109189'] });
      await openstreetmapLookupObjects.handler(input, ctx);
      expect(mockLookup).toHaveBeenCalledWith(
        expect.objectContaining({ osm_ids: ['N240109189'] }),
        expect.anything(),
      );
    });

    it('passes extratags and language to the service', async () => {
      mockLookup.mockResolvedValue([nodePlace]);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({
        osm_ids: ['N240109189'],
        extratags: true,
        language: 'de',
      });
      await openstreetmapLookupObjects.handler(input, ctx);
      expect(mockLookup).toHaveBeenCalledOnce();
    });
  });

  describe('schema boundary', () => {
    it('rejects a bare ID string — osm_ids is array-only', () => {
      expect(() => openstreetmapLookupObjects.input.parse({ osm_ids: 'N240109189' })).toThrow(
        /expected array/i,
      );
    });

    it('rejects a JSON-stringified array rather than treating it as one malformed ID', () => {
      expect(() =>
        openstreetmapLookupObjects.input.parse({ osm_ids: '["W50637691", "R146656"]' }),
      ).toThrow(/expected array/i);
    });

    it('rejects an empty array', () => {
      expect(() => openstreetmapLookupObjects.input.parse({ osm_ids: [] })).toThrow();
    });
  });

  describe('error paths', () => {
    it('throws invalid_id_format for an ID without N/W/R prefix', async () => {
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['240109189'] }); // missing prefix
      await expect(openstreetmapLookupObjects.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_id_format' },
      });
    });

    it('throws invalid_id_format for a malformed ID in an array', async () => {
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['N240109189', 'bad_id'] });
      await expect(openstreetmapLookupObjects.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_id_format' },
      });
    });

    it('propagates service errors', async () => {
      mockLookup.mockRejectedValue(new Error('Nominatim unavailable'));
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['N240109189'] });
      await expect(openstreetmapLookupObjects.handler(input, ctx)).rejects.toThrow(
        'Nominatim unavailable',
      );
    });
  });

  describe('sparse upstream payload', () => {
    it('handles results with minimal fields', async () => {
      const sparsePlace: NominatimPlace = {
        place_id: 777,
        lat: '47.0',
        lon: '-122.0',
        display_name: 'Unnamed place',
      };
      mockLookup.mockResolvedValue([sparsePlace]);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['R777'] });
      const result = await openstreetmapLookupObjects.handler(input, ctx);

      // Sparse place has no osm_type/osm_id so it won't match the requested ID
      expect(result.total).toBe(1);
      expect(result.results[0]?.name).toBeUndefined();
      expect(result.results[0]?.category).toBeUndefined();
    });
  });

  describe('format', () => {
    it('renders results with key fields', () => {
      const output = {
        results: [
          {
            place_id: 1001,
            osm_type: 'node' as const,
            osm_id: 240109189,
            lat: '47.6205',
            lon: '-122.3493',
            display_name: 'Space Needle, Seattle, WA',
            name: 'Space Needle',
            category: 'man_made',
            type: 'tower',
          },
        ],
        not_found: [],
        total: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapLookupObjects.format!(output);
      expect(blocks[0]!.type).toBe('text');
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Space Needle');
      expect(text).toContain('47.6205');
      expect(text).toContain('-122.3493');
      expect(text).toContain('N240109189');
      expect(text).toContain('man_made');
      expect(text).toContain('OpenStreetMap');
    });

    it('renders not_found IDs when present', () => {
      const output = {
        results: [],
        not_found: ['W99999999'],
        total: 0,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapLookupObjects.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Not found');
      expect(text).toContain('W99999999');
    });
  });
});
