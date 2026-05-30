/**
 * @fileoverview Unit tests for openstreetmap-format shared formatting helpers.
 * @module tests/tools/openstreetmap-format.test
 */

import { describe, expect, it } from 'vitest';
import { appendPlaceLines } from '@/mcp-server/tools/definitions/openstreetmap-format.js';

describe('appendPlaceLines', () => {
  describe('OSM ref line', () => {
    it('appends OSM ref when osm_type and osm_id are present', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { osm_type: 'node', osm_id: 240109189 });
      expect(lines).toContain('**OSM:** N240109189');
    });

    it('uses W prefix for way type', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { osm_type: 'way', osm_id: 50637691 });
      expect(lines).toContain('**OSM:** W50637691');
    });

    it('uses R prefix for relation type', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { osm_type: 'relation', osm_id: 146656 });
      expect(lines).toContain('**OSM:** R146656');
    });

    it('omits OSM ref when osm_type is absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { osm_id: 12345 });
      expect(lines.some((l) => l.includes('**OSM:**'))).toBe(false);
    });

    it('omits OSM ref when osm_id is absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { osm_type: 'node' });
      expect(lines.some((l) => l.includes('**OSM:**'))).toBe(false);
    });

    it('includes osm_id=0 (falsy but valid)', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { osm_type: 'node', osm_id: 0 });
      expect(lines).toContain('**OSM:** N0');
    });
  });

  describe('category/type line', () => {
    it('appends category with type when both present', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { category: 'man_made', type: 'tower' });
      expect(lines).toContain('**Category:** man_made / tower');
    });

    it('appends category without slash when type is absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { category: 'amenity' });
      expect(lines).toContain('**Category:** amenity');
    });

    it('omits category line when category is absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { type: 'tower' });
      expect(lines.some((l) => l.includes('**Category:**'))).toBe(false);
    });
  });

  describe('address details line', () => {
    it('appends address details excluding technical keys', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {
        address: {
          road: 'Broad Street',
          city: 'Seattle',
          country_code: 'us',
          'ISO3166-2-lvl4': 'US-WA',
        },
      });
      const addrLine = lines.find((l) => l.startsWith('**Address details:**'));
      expect(addrLine).toBeDefined();
      expect(addrLine).toContain('road: Broad Street');
      expect(addrLine).toContain('city: Seattle');
      expect(addrLine).not.toContain('country_code');
      expect(addrLine).not.toContain('ISO3166-2-lvl4');
    });

    it('omits address line when address is absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {});
      expect(lines.some((l) => l.includes('**Address details:**'))).toBe(false);
    });

    it('omits address line when all address keys are filtered out', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {
        address: { country_code: 'us', 'ISO3166-2-lvl4': 'US-WA' },
      });
      expect(lines.some((l) => l.includes('**Address details:**'))).toBe(false);
    });

    it('formats multiple address entries as key: value pairs joined by comma', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { address: { road: 'Main St', city: 'Portland' } });
      const addrLine = lines.find((l) => l.startsWith('**Address details:**'))!;
      expect(addrLine).toContain('road: Main St, city: Portland');
    });
  });

  describe('bounding box line', () => {
    it('appends bounding box with all four compass points', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {
        boundingbox: ['47.619', '47.622', '-122.352', '-122.347'],
      });
      expect(lines).toContain('**Bounding box:** S:47.619 N:47.622 W:-122.352 E:-122.347');
    });

    it('omits bounding box line when absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {});
      expect(lines.some((l) => l.includes('**Bounding box:**'))).toBe(false);
    });
  });

  describe('extratags line', () => {
    it('appends extratags when present and non-empty', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {
        extratags: { wikidata: 'Q178640', website: 'https://spaceneedle.com' },
      });
      const extraLine = lines.find((l) => l.startsWith('**Extra tags:**'));
      expect(extraLine).toBeDefined();
      expect(extraLine).toContain('wikidata: Q178640');
      expect(extraLine).toContain('website: https://spaceneedle.com');
    });

    it('omits extratags line when extratags is absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {});
      expect(lines.some((l) => l.includes('**Extra tags:**'))).toBe(false);
    });

    it('omits extratags line when extratags is an empty object', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { extratags: {} });
      expect(lines.some((l) => l.includes('**Extra tags:**'))).toBe(false);
    });
  });

  describe('full combination', () => {
    it('produces all lines in order when all fields are present', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {
        osm_type: 'node',
        osm_id: 123,
        category: 'amenity',
        type: 'cafe',
        address: { road: 'Main St' },
        boundingbox: ['47.6', '47.7', '-122.4', '-122.3'],
        extratags: { phone: '+1-206-555-1234' },
      });
      expect(lines[0]).toContain('**OSM:** N123');
      expect(lines[1]).toContain('**Category:** amenity / cafe');
      expect(lines[2]).toContain('**Address details:**');
      expect(lines[3]).toContain('**Bounding box:**');
      expect(lines[4]).toContain('**Extra tags:**');
    });

    it('produces empty array when all fields are absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {});
      expect(lines).toHaveLength(0);
    });
  });
});
