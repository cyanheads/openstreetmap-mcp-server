/**
 * @fileoverview Unit tests for OverpassService.normalizeElements and query builders.
 * @module tests/services/overpass/normalize-elements.test
 */

import { describe, expect, it } from 'vitest';
import { OverpassService } from '@/services/overpass/overpass-service.js';
import type { OverpassElement } from '@/services/overpass/types.js';

/** Minimal stub config / storage accepted by the constructor. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const service = new OverpassService({} as any, {} as any);

describe('OverpassService.normalizeElements', () => {
  it('normalizes a node element with lat/lon', () => {
    const el: OverpassElement = {
      type: 'node',
      id: 111222333,
      lat: 47.6105,
      lon: -122.3442,
      tags: { amenity: 'cafe', name: 'Coffee House' },
    };
    const result = service.normalizeElements([el]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      osm_type: 'node',
      osm_id: 111222333,
      lat: 47.6105,
      lon: -122.3442,
      name: 'Coffee House',
      tags: { amenity: 'cafe', name: 'Coffee House' },
    });
  });

  it('normalizes a way element using its center coordinates', () => {
    const el: OverpassElement = {
      type: 'way',
      id: 50637691,
      center: { lat: 47.62, lon: -122.35 },
      tags: { name: 'Pike Place Market' },
    };
    const result = service.normalizeElements([el]);
    expect(result[0]).toMatchObject({
      osm_type: 'way',
      osm_id: 50637691,
      lat: 47.62,
      lon: -122.35,
      name: 'Pike Place Market',
    });
  });

  it('normalizes a relation element with center', () => {
    const el: OverpassElement = {
      type: 'relation',
      id: 146656,
      center: { lat: 47.5, lon: -122.3 },
      tags: { name: 'King County' },
    };
    const result = service.normalizeElements([el]);
    expect(result[0]).toMatchObject({
      osm_type: 'relation',
      osm_id: 146656,
      lat: 47.5,
      lon: -122.3,
    });
  });

  it('omits lat/lon for a way without center data', () => {
    const el: OverpassElement = {
      type: 'way',
      id: 99999,
      tags: { building: 'yes' },
    };
    const result = service.normalizeElements([el]);
    expect(result[0]).not.toHaveProperty('lat');
    expect(result[0]).not.toHaveProperty('lon');
  });

  it('omits name when tags.name is absent', () => {
    const el: OverpassElement = {
      type: 'node',
      id: 42,
      lat: 47.6,
      lon: -122.3,
      tags: { amenity: 'bench' },
    };
    const result = service.normalizeElements([el]);
    expect(result[0]).not.toHaveProperty('name');
  });

  it('defaults tags to empty object when tags field is missing', () => {
    const el: OverpassElement = { type: 'node', id: 1 };
    const result = service.normalizeElements([el]);
    expect(result[0]!.tags).toEqual({});
  });

  it('normalizes multiple elements in order', () => {
    const elements: OverpassElement[] = [
      { type: 'node', id: 1, lat: 47.0, lon: -122.0, tags: { name: 'A' } },
      { type: 'node', id: 2, lat: 48.0, lon: -123.0, tags: { name: 'B' } },
    ];
    const result = service.normalizeElements(elements);
    expect(result).toHaveLength(2);
    expect(result[0]!.osm_id).toBe(1);
    expect(result[1]!.osm_id).toBe(2);
  });

  it('returns empty array for empty input', () => {
    expect(service.normalizeElements([])).toEqual([]);
  });
});

describe('OverpassService.buildAroundQuery', () => {
  it('produces a query with the correct around filter', () => {
    const ql = service.buildAroundQuery({
      lat: 47.6,
      lon: -122.3,
      radiusMeters: 1000,
      tagKey: 'amenity',
      tagValue: 'cafe',
      elementTypes: ['node', 'way'],
      timeoutSeconds: 25,
    });
    expect(ql).toContain('[out:json][timeout:25]');
    expect(ql).toContain('"amenity"="cafe"');
    expect(ql).toContain('(around:1000,47.6,-122.3)');
    expect(ql).toContain('node');
    expect(ql).toContain('way');
    expect(ql).toContain('out center tags');
  });

  it('includes relation when requested', () => {
    const ql = service.buildAroundQuery({
      lat: 0,
      lon: 0,
      radiusMeters: 500,
      tagKey: 'leisure',
      tagValue: 'park',
      elementTypes: ['node', 'way', 'relation'],
      timeoutSeconds: 30,
    });
    expect(ql).toContain('relation');
  });

  it('uses the provided timeout value', () => {
    const ql = service.buildAroundQuery({
      lat: 0,
      lon: 0,
      radiusMeters: 100,
      tagKey: 'natural',
      tagValue: 'peak',
      elementTypes: ['node'],
      timeoutSeconds: 60,
    });
    expect(ql).toContain('[timeout:60]');
  });
});

describe('OverpassService.buildBboxQuery', () => {
  it('produces a query with the correct bbox filter in south,west,north,east order', () => {
    const ql = service.buildBboxQuery({
      south: 47.5,
      west: -122.5,
      north: 47.7,
      east: -122.2,
      tagKey: 'amenity',
      tagValue: 'pharmacy',
      elementTypes: ['node', 'way'],
      timeoutSeconds: 25,
    });
    expect(ql).toContain('[out:json][timeout:25]');
    expect(ql).toContain('"amenity"="pharmacy"');
    // Overpass bbox order: south,west,north,east
    expect(ql).toContain('(47.5,-122.5,47.7,-122.2)');
    expect(ql).toContain('out center tags');
  });

  it('includes only the requested element types', () => {
    const ql = service.buildBboxQuery({
      south: 0,
      west: 0,
      north: 1,
      east: 1,
      tagKey: 'natural',
      tagValue: 'water',
      elementTypes: ['way'],
      timeoutSeconds: 20,
    });
    expect(ql).toContain('way');
    expect(ql).not.toMatch(/\bnode\b/);
  });
});

/**
 * #71: the boundary scope. Every fixture below is a body the live endpoint produced —
 * `overpass-api.de`, Overpass API 0.7.62.11 — because the two non-feature element types
 * are exactly where an invented fixture would agree with a wrong implementation.
 */
describe('OverpassService boundary area scope', () => {
  describe('buildAreaQuery', () => {
    it('maps a relation ref with map_to_area and asks for the count sentinel', () => {
      const ql = service.buildAreaQuery({
        areaRef: { kind: 'relation', osmId: 237385 },
        tagKey: 'amenity',
        tagValue: 'university',
        elementTypes: ['node', 'way'],
        timeoutSeconds: 25,
      });
      expect(ql).toBe(
        [
          '[out:json][timeout:25];',
          'rel(237385);map_to_area->.a;',
          '.a out count;',
          '(',
          '  node["amenity"="university"](area.a);',
          '  way["amenity"="university"](area.a);',
          ');',
          'out center tags;',
        ].join('\n'),
      );
    });

    it('maps a way ref with no id arithmetic, the 2400000000 offset being dead since 0.7.57', () => {
      const ql = service.buildAreaQuery({
        areaRef: { kind: 'way', osmId: 13800188 },
        tagKey: 'leisure',
        filters: [{ tagKey: 'name', tagValue: 'Amphitheater' }],
        elementTypes: ['relation'],
        timeoutSeconds: 40,
      });
      expect(ql).toBe(
        [
          '[out:json][timeout:40];',
          'way(13800188);map_to_area->.a;',
          '.a out count;',
          '(',
          '  relation["leisure"]["name"="Amphitheater"](area.a);',
          ');',
          'out center tags;',
        ].join('\n'),
      );
      expect(ql).not.toContain('2413800188');
    });
  });

  describe('readAreaScope', () => {
    /** `rel(237385);map_to_area->.a;.a out count;` — a relation-derived area resolves. */
    const RELATION_SENTINEL: OverpassElement = {
      type: 'count',
      id: 0,
      tags: { nodes: '0', ways: '0', relations: '0', areas: '1', total: '1' },
    };
    /** The same line for a closed way: one area, filed under `ways` rather than `areas`. */
    const WAY_SENTINEL: OverpassElement = {
      type: 'count',
      id: 0,
      tags: { nodes: '0', ways: '1', relations: '0', areas: '0', total: '1' },
    };
    /** A ref that reached no area at all. */
    const EMPTY_SENTINEL: OverpassElement = {
      type: 'count',
      id: 0,
      tags: { nodes: '0', ways: '0', relations: '0', areas: '0', total: '0' },
    };

    const match: OverpassElement = {
      type: 'node',
      id: 2312065990,
      lat: 47.6227393,
      lon: -122.3374244,
      tags: { amenity: 'university', name: 'Northeastern University - Seattle 401' },
    };

    it.each([
      { label: 'relation-derived area', sentinel: RELATION_SENTINEL },
      { label: 'way-derived area', sentinel: WAY_SENTINEL },
    ])('reads total across the type breakdown for a $label', ({ sentinel }) => {
      const scope = service.readAreaScope([sentinel, match]);
      expect(scope.resolved).toBe(true);
      expect(scope.elements).toEqual([match]);
      expect(service.normalizeElements(scope.elements)).toEqual([
        {
          osm_type: 'node',
          osm_id: 2312065990,
          lat: 47.6227393,
          lon: -122.3374244,
          name: 'Northeastern University - Seattle 401',
          tags: match.tags,
        },
      ]);
    });

    it('reports an unresolved boundary, which Overpass otherwise renders as a plain empty list', () => {
      const scope = service.readAreaScope([EMPTY_SENTINEL]);
      expect(scope.resolved).toBe(false);
      expect(scope.elements).toEqual([]);
    });

    it('treats a body with no sentinel at all as unresolved rather than silently resolved', () => {
      expect(service.readAreaScope([]).resolved).toBe(false);
    });
  });

  describe('normalizeElements drops non-feature element types', () => {
    /**
     * `area(3600237385);out ids;` — how a relation-derived area prints. A way-derived one
     * prints as `type: 'way'` carrying the way's own id instead, which is why the boundary
     * sentinel is a count rather than this.
     */
    it('drops an area element, which carries no osm_type the tools advertise', () => {
      const area: OverpassElement = { type: 'area', id: 3600237385 };
      const node: OverpassElement = { type: 'node', id: 7, lat: 47.6, lon: -122.3 };
      expect(service.normalizeElements([area, node]).map((poi) => poi.osm_id)).toEqual([7]);
    });

    it('drops a count element left in an otherwise unscoped result', () => {
      const count: OverpassElement = { type: 'count', id: 0, tags: { total: '1' } };
      expect(service.normalizeElements([count])).toEqual([]);
    });
  });
});
