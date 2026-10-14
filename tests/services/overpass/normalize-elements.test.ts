/**
 * @fileoverview Unit tests for OverpassService.normalizeElements, the query builders, and
 * the nearest-point ranking the around query's geometry prints feed.
 * @module tests/services/overpass/normalize-elements.test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  haversineMeters,
  OverpassService,
  rankByCenter,
  rankByNearestPoint,
} from '@/services/overpass/overpass-service.js';
import type { OverpassElement, OverpassLatLon, OverpassResult } from '@/services/overpass/types.js';

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
    expect(ql).toContain('[out:json][timeout:25][maxsize:268435456];\n');
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
    expect(ql).toContain('[out:json][timeout:25][maxsize:268435456];\n');
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
 * #83: the tag chain every builder shares. The legacy strings are literal bytes written
 * against the builder before list-item matching existed — never regenerated from the
 * current code — so an exact or existence filter that drifts by one byte fails here.
 */
describe('OverpassService tag chain emission', () => {
  const chain = {
    tagKey: 'amenity',
    tagValue: 'restaurant',
    filters: [
      { tagKey: 'cuisine', tagValue: 'italian' },
      { tagKey: 'name' },
      { tagKey: 'addr:street', tagValue: 'Pike St.' },
    ],
    elementTypes: ['node' as const, 'way' as const],
    timeoutSeconds: 25,
  };

  /**
   * The legacy around query ended at `out center tags;`. #103 appends the geometry prints the
   * distance ranking reads, so the legacy bytes are now the query's head and the record print
   * is unchanged.
   */
  it('emits the legacy around query byte for byte as the head, then the geometry prints', () => {
    expect(service.buildAroundQuery({ ...chain, lat: 47.6, lon: -122.3, radiusMeters: 1000 })).toBe(
      '[out:json][timeout:25][maxsize:268435456];\n(\n  node["amenity"="restaurant"]["cuisine"="italian"]["name"]["addr:street"="Pike St."](around:1000,47.6,-122.3);\n  way["amenity"="restaurant"]["cuisine"="italian"]["name"]["addr:street"="Pike St."](around:1000,47.6,-122.3);\n);\nout center tags;' +
        '\n(._;)->.matched;\nmake nearby_nearest;\nout;\nway.matched;\nout ids geom(47.5909100,-122.3134829,47.6090900,-122.2865171);\nmake nearby_strip;\nout;\nway.matched(if:is_closed())["area"!="no"](47.5999999,-122.3000001,90.0000000,-122.2999999);\nout ids geom(47.5999999,-122.3000001,90.0000000,-122.2999999);',
    );
  });

  it('emits the legacy bbox query byte for byte', () => {
    expect(
      service.buildBboxQuery({ ...chain, south: 47.5, west: -122.5, north: 47.7, east: -122.2 }),
    ).toBe(
      '[out:json][timeout:25][maxsize:268435456];\n(\n  node["amenity"="restaurant"]["cuisine"="italian"]["name"]["addr:street"="Pike St."](47.5,-122.5,47.7,-122.2);\n  way["amenity"="restaurant"]["cuisine"="italian"]["name"]["addr:street"="Pike St."](47.5,-122.5,47.7,-122.2);\n);\nout center tags;',
    );
  });

  it('emits a list-item filter as an anchored regex on every element-type line', () => {
    const ql = service.buildBboxQuery({
      tagKey: 'amenity',
      tagValue: 'restaurant',
      filters: [{ tagKey: 'cuisine', tagValue: 'pizza', match: 'list_item' }],
      elementTypes: ['node', 'way', 'relation'],
      timeoutSeconds: 25,
      south: 47.5,
      west: -122.5,
      north: 47.7,
      east: -122.2,
    });
    const filter = '["amenity"="restaurant"]["cuisine"~"(^|;) *pizza *(;|$)"]';
    expect(ql).toBe(
      [
        '[out:json][timeout:25][maxsize:268435456];',
        '(',
        `  node${filter}(47.5,-122.5,47.7,-122.2);`,
        `  way${filter}(47.5,-122.5,47.7,-122.2);`,
        `  relation${filter}(47.5,-122.5,47.7,-122.2);`,
        ');',
        'out center tags;',
      ].join('\n'),
    );
  });

  it('emits a list-item primary tag through the around and area builders', () => {
    const primary = {
      tagKey: 'sport',
      tagValue: 'soccer',
      match: 'list_item' as const,
      elementTypes: ['way' as const],
      timeoutSeconds: 25,
    };
    const regex = '["sport"~"(^|;) *soccer *(;|$)"]';
    expect(service.buildAroundQuery({ ...primary, lat: 1, lon: 2, radiusMeters: 50 })).toContain(
      `  way${regex}(around:50,1,2);`,
    );
    expect(
      service.buildAreaQuery({ ...primary, areaRef: { kind: 'relation', osmId: 237385 } }),
    ).toContain(`  way${regex}(area.a);`);
  });

  /**
   * Overpass QL reads one backslash as a string escape before the POSIX ERE compiles, so
   * each special arrives as `\\` plus the character and compiles to a literal. `}` closes
   * nothing once every `{` is escaped, so it stays as written.
   */
  it.each([
    ['a.b*', String.raw`a\\.b\\*`],
    ['.*', String.raw`\\.\\*`],
    ['^x$', String.raw`\\^x\\$`],
    ['a+b?', String.raw`a\\+b\\?`],
    ['x{2}', String.raw`x\\{2}`],
    ['pizza|kebab', String.raw`pizza\\|kebab`],
    ['café 3.5', String.raw`café 3\\.5`],
  ])('escapes the ERE specials in list-item value %j', (value, escaped) => {
    const ql = service.buildBboxQuery({
      tagKey: 'k',
      tagValue: value,
      match: 'list_item',
      elementTypes: ['node'],
      timeoutSeconds: 25,
      south: 0,
      west: 0,
      north: 1,
      east: 1,
    });
    expect(ql).toContain(`  node["k"~"(^|;) *${escaped} *(;|$)"](0,0,1,1);`);
  });

  it('leaves an exact value carrying the same specials unescaped', () => {
    const ql = service.buildBboxQuery({
      tagKey: 'k',
      tagValue: 'a.b*',
      elementTypes: ['node'],
      timeoutSeconds: 25,
      south: 0,
      west: 0,
      north: 1,
      east: 1,
    });
    expect(ql).toContain('  node["k"="a.b*"](0,0,1,1);');
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
          '[out:json][timeout:25][maxsize:268435456];',
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
          '[out:json][timeout:40][maxsize:268435456];',
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

/**
 * #103: `distance_meters` measured to `out center`, the midpoint of a feature's bounding box,
 * so a park containing the point ranked last. The around query now also prints each matched
 * way and relation clipped to the circle's bounding box (nearest point) and, for area
 * elements, clipped to the strip north of the point (ray-parity containment).
 */
describe('OverpassService.buildAroundQuery geometry prints (#103)', () => {
  const cafe = { tagKey: 'amenity', tagValue: 'cafe', timeoutSeconds: 25 };
  const head = (types: string[], spatial: string) => [
    '[out:json][timeout:25][maxsize:268435456];',
    '(',
    ...types.map((t) => `  ${t}["amenity"="cafe"]${spatial};`),
    ');',
    'out center tags;',
  ];

  it('adds nothing for a nodes-only query, whose distance needs no geometry', () => {
    expect(
      service.buildAroundQuery({
        ...cafe,
        elementTypes: ['node'],
        lat: 47.6,
        lon: -122.3,
        radiusMeters: 200,
      }),
    ).toBe(head(['node'], '(around:200,47.6,-122.3)').join('\n'));
  });

  /**
   * A relation's own `out geom(box)` keeps a member vertex only when it or a neighbour lies in
   * the box, so a segment crossing the box with both ends outside — every segment of the
   * strip — prints as `null`. Each relation therefore prints as a header followed by its
   * member ways through the way print, which keeps every segment touching the box.
   */
  it('prints each relation as a header and its member ways, the strip only for areas', () => {
    expect(
      service.buildAroundQuery({
        ...cafe,
        elementTypes: ['relation'],
        lat: 47.6,
        lon: -122.3,
        radiusMeters: 200,
      }),
    ).toBe(
      [
        ...head(['relation'], '(around:200,47.6,-122.3)'),
        '(._;)->.matched;',
        'make nearby_nearest;',
        'out;',
        'rel.matched->.rels;',
        'foreach.rels->.r(.r out ids;way(r.r)(47.5981820,-122.3026962,47.6018180,-122.2973038);out ids geom(47.5981820,-122.3026962,47.6018180,-122.2973038);node(r.r)(47.5981820,-122.3026962,47.6018180,-122.2973038);out skel;);',
        'make nearby_strip;',
        'out;',
        'rel.matched["type"~"^(multipolygon|boundary)$"](47.5999999,-122.3000001,90.0000000,-122.2999999)->.areas;',
        'foreach.areas->.r(.r out ids;way(r.r)(47.5999999,-122.3000001,90.0000000,-122.2999999);out ids geom(47.5999999,-122.3000001,90.0000000,-122.2999999););',
      ].join('\n'),
    );
  });

  it('prints ways and relations in one request when both are searched', () => {
    const ql = service.buildAroundQuery({
      ...cafe,
      elementTypes: ['node', 'way', 'relation'],
      lat: 47.6588,
      lon: -122.4056,
      radiusMeters: 800,
    });
    expect(ql).toBe(
      [
        ...head(['node', 'way', 'relation'], '(around:800,47.6588,-122.4056)'),
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

  it.each([
    {
      at: 'a circle crossing the antimeridian, written west > east as Overpass reads it',
      lat: 0,
      lon: 179.999,
      circle: '(-0.0454500,179.9535500,0.0454500,-179.9555500)',
      strip: '(-0.0000001,179.9989999,90.0000000,179.9990001)',
    },
    {
      at: 'a circle reaching the pole, which spans every longitude',
      lat: 89.99,
      lon: 10,
      circle: '(89.9445500,-180.0000000,90.0000000,180.0000000)',
      strip: '(89.9899999,9.9999999,90.0000000,10.0000001)',
    },
    {
      at: 'a strip on the antimeridian, kept inside the range Overpass accepts',
      lat: 0,
      lon: 180,
      circle: '(-0.0454500,179.9545500,0.0454500,-179.9545500)',
      strip: '(-0.0000001,179.9999999,90.0000000,180.0000000)',
    },
    {
      at: 'a strip on the other side of it',
      lat: 0,
      lon: -180,
      circle: '(-0.0454500,179.9545500,0.0454500,-179.9545500)',
      strip: '(-0.0000001,-180.0000000,90.0000000,-179.9999999)',
    },
  ])('bounds $at', ({ lat, lon, circle, strip }) => {
    const ql = service.buildAroundQuery({
      ...cafe,
      elementTypes: ['way'],
      lat,
      lon,
      radiusMeters: 5000,
    });
    expect(ql).toContain(`\nout ids geom${circle};\n`);
    expect(ql.endsWith(`["area"!="no"]${strip};\nout ids geom${strip};`)).toBe(true);
  });
});

/** The body Overpass sends for the around query's prints, as it arrives off the wire. */
function aroundResponse(
  records: object[],
  nearest: object[],
  strip: object[] = [],
): OverpassResult {
  return JSON.parse(
    JSON.stringify({
      version: 0.6,
      osm3s: { timestamp_osm_base: '2026-10-14T16:46:13Z' },
      elements: [
        ...records,
        { type: 'nearby_nearest', id: 1 },
        ...nearest,
        { type: 'nearby_strip', id: 2 },
        ...strip,
      ],
    }),
  );
}

const at = (lat: number, lon: number): OverpassLatLon => ({ lat, lon });
/** A closed ring through the given corners and back to the first. */
const ring = (...corners: [number, number][]) =>
  [...corners, corners[0]!].map(([lat, lon]) => at(lat, lon));
/** What the tools print: one decimal. */
const round1 = (meters: number | undefined) =>
  meters === undefined ? undefined : Math.round(meters * 10) / 10;

/** A square ring of half-width `d` degrees around the origin. */
const square = (d: number) => ring([d, -d], [d, d], [-d, d], [-d, -d]);
/** The same ring as a strip print at the origin keeps it: only the north edge crosses the ray. */
const squareStrip = (d: number) => [at(d, -d), at(d, d), null, null, null];
/** `0.01°` and `0.001°` along a meridian or the equator, the edge distances below. */
const EDGE_100 = round1(haversineMeters(0, 0, 0.01, 0));
const EDGE_10 = round1(haversineMeters(0, 0, 0.001, 0));

describe('rankByNearestPoint (#103)', () => {
  const ORIGIN = at(0, 0);
  const distances = (result: OverpassResult) =>
    result.elements.map((el) => [el.type, el.id, round1(el.distanceMeters)]);

  it('measures a way to its nearest segment even when its center lies far outside', () => {
    const result = rankByNearestPoint(
      aroundResponse(
        [{ type: 'way', id: 2, center: at(0.0505, 0.05), tags: { highway: 'path' } }],
        [{ type: 'way', id: 2, geometry: [at(0.001, -0.05), at(0.001, 0.05), at(0.1, 0.1)] }],
      ),
      ORIGIN,
    );
    expect(round1(haversineMeters(0, 0, 0.0505, 0.05))).toBe(7902.1);
    expect(distances(result)).toEqual([['way', 2, EDGE_10]]);
    expect(EDGE_10).toBe(111.2);
  });

  it('reads 0 inside a closed way, and the edge distance once tagged area=no', () => {
    const park = { type: 'way', id: 3, center: at(0, 0), tags: { leisure: 'park' } };
    const fence = { type: 'way', id: 4, center: at(0, 0), tags: { barrier: 'fence', area: 'no' } };
    const result = rankByNearestPoint(
      aroundResponse(
        [park, fence],
        [
          { type: 'way', id: 3, geometry: square(0.01) },
          { type: 'way', id: 4, geometry: square(0.01) },
        ],
        // The fence would not reach the strip print; it is here to prove its tag is read.
        [
          { type: 'way', id: 3, geometry: squareStrip(0.01) },
          { type: 'way', id: 4, geometry: squareStrip(0.01) },
        ],
      ),
      ORIGIN,
    );
    expect(distances(result)).toEqual([
      ['way', 3, 0],
      ['way', 4, EDGE_100],
    ]);
    expect(EDGE_100).toBe(1111.9);
  });

  /**
   * A relation reaches each geometry print as a bare header followed by its member ways and
   * nodes that touch the box; everything up to the next header is that relation's.
   */
  describe('a multipolygon with an inner ring', () => {
    const lake = { type: 'relation', id: 5, center: at(0, 0), tags: { type: 'multipolygon' } };
    const group = (outer?: unknown[], inner?: unknown[], label?: OverpassLatLon) => [
      { type: 'relation', id: 5 },
      ...(outer ? [{ type: 'way', id: 50, geometry: outer }] : []),
      ...(inner ? [{ type: 'way', id: 51, geometry: inner }] : []),
      ...(label ? [{ type: 'node', id: 52, ...label }] : []),
    ];
    const nearest = group(square(0.01), square(0.001), at(0.005, 0.005));

    it('reads 0 for a point inside the outer ring and outside the hole', () => {
      // At (0.005, 0) the ray north crosses the outer ring's north edge alone.
      const result = rankByNearestPoint(
        aroundResponse([lake], nearest, group(squareStrip(0.01))),
        at(0.005, 0),
      );
      expect(distances(result)).toEqual([['relation', 5, 0]]);
    });

    it('reads the distance to the inner ring for a point in the hole', () => {
      const result = rankByNearestPoint(
        aroundResponse([lake], nearest, group(squareStrip(0.01), squareStrip(0.001))),
        ORIGIN,
      );
      expect(distances(result)).toEqual([['relation', 5, EDGE_10]]);
    });

    it('keeps a way printed on its own apart from the same way printed as a member', () => {
      // The outer ring is also a matched water way: on its own it contains the origin.
      const water = { type: 'way', id: 50, center: at(0, 0), tags: { natural: 'water' } };
      const result = rankByNearestPoint(
        aroundResponse(
          [water, lake],
          [{ type: 'way', id: 50, geometry: square(0.01) }, ...nearest],
          [
            { type: 'way', id: 50, geometry: squareStrip(0.01) },
            ...group(squareStrip(0.01), squareStrip(0.001)),
          ],
        ),
        ORIGIN,
      );
      expect(distances(result)).toEqual([
        ['way', 50, 0],
        ['relation', 5, EDGE_10],
      ]);
    });
  });

  it('never reads 0 for a route relation whose members encircle the point', () => {
    const route = {
      type: 'relation',
      id: 6,
      center: at(0, 0),
      tags: { type: 'route', route: 'bus' },
    };
    const result = rankByNearestPoint(
      aroundResponse(
        [route],
        [
          { type: 'relation', id: 6 },
          { type: 'way', id: 60, geometry: square(0.01) },
          { type: 'node', id: 61, lat: 0.01, lon: 0.002 },
        ],
        // A route never reaches the strip print; it is here to prove its type is read.
        [
          { type: 'relation', id: 6 },
          { type: 'way', id: 60, geometry: squareStrip(0.01) },
        ],
      ),
      ORIGIN,
    );
    expect(distances(result)).toEqual([['relation', 6, EDGE_100]]);
  });

  it('measures a relation to a member node nearer than any member way', () => {
    const route = { type: 'relation', id: 13, center: at(0, 0.5), tags: { type: 'route' } };
    const result = rankByNearestPoint(
      aroundResponse(
        [route],
        [
          { type: 'relation', id: 13 },
          { type: 'way', id: 130, geometry: [at(0.01, -0.01), at(0.01, 0.01)] },
          { type: 'node', id: 131, lat: 0.001, lon: 0 },
        ],
      ),
      ORIGIN,
    );
    expect(distances(result)).toEqual([['relation', 13, EDGE_10]]);
  });

  describe('a ray through a vertex', () => {
    /** A diamond whose north and south vertices sit on the origin's meridian. */
    const diamond = ring([0.01, 0], [0, 0.01], [-0.01, 0], [0, -0.01]);
    const record = { type: 'way', id: 7, center: at(0, 0), tags: { natural: 'water' } };

    it('reads 0 for a point inside, whose ray leaves through the north vertex', () => {
      const result = rankByNearestPoint(
        aroundResponse(
          [record],
          [{ type: 'way', id: 7, geometry: diamond }],
          // Both segments meeting at the north vertex touch the strip box.
          [
            {
              type: 'way',
              id: 7,
              geometry: [at(0.01, 0), at(0, 0.01), null, at(0, -0.01), at(0.01, 0)],
            },
          ],
        ),
        ORIGIN,
      );
      expect(distances(result)).toEqual([['way', 7, 0]]);
    });

    it('reads the vertex distance for a point south of it, whose ray passes two vertices', () => {
      const point = at(-0.02, 0);
      const result = rankByNearestPoint(
        aroundResponse(
          [record],
          [{ type: 'way', id: 7, geometry: diamond }],
          [{ type: 'way', id: 7, geometry: diamond }],
        ),
        point,
      );
      expect(distances(result)).toEqual([['way', 7, EDGE_100]]);
    });
  });

  it('reads a square straddling the antimeridian as one area from either side', () => {
    const straddle = ring([0.01, 179.99], [0.01, -179.99], [-0.01, -179.99], [-0.01, 179.99]);
    const record = { type: 'way', id: 8, center: at(0, 0), tags: { place: 'islet' } };
    const inside = rankByNearestPoint(
      aroundResponse(
        [record],
        [{ type: 'way', id: 8, geometry: straddle }],
        [{ type: 'way', id: 8, geometry: [at(0.01, 179.99), at(0.01, -179.99), null, null, null] }],
      ),
      at(0, 179.995),
    );
    expect(distances(inside)).toEqual([['way', 8, 0]]);

    const east = rankByNearestPoint(
      aroundResponse([record], [{ type: 'way', id: 8, geometry: straddle }]),
      at(0, -179.98),
    );
    expect(distances(east)).toEqual([['way', 8, EDGE_100]]);
  });

  it('gives a finite distance at the pole, where every point of a parallel is equidistant', () => {
    const result = rankByNearestPoint(
      aroundResponse(
        [{ type: 'way', id: 9, center: at(89.999, 45), tags: {} }],
        [{ type: 'way', id: 9, geometry: [at(89.999, 0), at(89.999, 90)] }],
      ),
      at(90, 0),
    );
    expect(distances(result)).toEqual([['way', 9, EDGE_10]]);
  });

  it('measures to the interior of a segment near the pole, nearer than either end', () => {
    const point = at(89.9995, 0);
    const result = rankByNearestPoint(
      aroundResponse(
        [{ type: 'way', id: 9, center: at(89.999, 0), tags: {} }],
        [{ type: 'way', id: 9, geometry: [at(89.999, -60), at(89.999, 60)] }],
      ),
      point,
    );
    expect(Math.round(haversineMeters(point.lat, point.lon, 89.999, 60))).toBe(96);
    expect(result.elements[0]!.distanceMeters).toBeCloseTo(
      haversineMeters(point.lat, 0, 89.999, 0),
      3,
    );
  });

  it('omits the distance of a way or relation that arrived without geometry, never using its center', () => {
    const result = rankByNearestPoint(
      aroundResponse(
        [
          { type: 'way', id: 10, center: at(0, 0.001), tags: {} },
          { type: 'relation', id: 11, center: at(0, 0.001), tags: { type: 'multipolygon' } },
          { type: 'way', id: 12, center: at(0, 0.001), tags: {} },
        ],
        [
          // Printed, but every vertex clipped away.
          { type: 'way', id: 12, geometry: [null, null] },
        ],
      ),
      ORIGIN,
    );
    expect(distances(result)).toEqual([
      ['way', 10, undefined],
      ['relation', 11, undefined],
      ['way', 12, undefined],
    ]);
    for (const el of result.elements) expect(el).not.toHaveProperty('distanceMeters');
  });

  it('returns the records alone, in upstream order, with no geometry or separator left', () => {
    const records = [
      { type: 'way', id: 21, center: at(0, 0.002), tags: { name: 'B' } },
      { type: 'node', id: 20, lat: 0, lon: 0.001, tags: { name: 'A' } },
    ];
    const response = aroundResponse(
      records,
      [{ type: 'way', id: 21, geometry: square(0.002) }],
      [{ type: 'way', id: 21, geometry: squareStrip(0.002) }],
    );
    const result = rankByNearestPoint(response, ORIGIN);
    expect(result.elements).toEqual([
      { ...records[0], distanceMeters: 0 },
      { ...records[1], distanceMeters: haversineMeters(0, 0, 0, 0.001) },
    ]);
    expect(result.osm3s).toEqual(response.osm3s);
    expect(result.version).toBe(0.6);
  });

  it('reads a response with no separators as records only, as a nodes-only query sends', () => {
    const body: OverpassResult = JSON.parse(
      JSON.stringify({ version: 0.6, elements: [{ type: 'node', id: 1, lat: 0, lon: 0.001 }] }),
    );
    expect(distances(rankByNearestPoint(body, ORIGIN))).toEqual([['node', 1, EDGE_10]]);
  });

  /**
   * Captured responses for the reproduction: the records `out center tags` printed and the
   * features' unclipped geometry. The prints the around query asks for are cut from that
   * geometry here the way Overpass clips (`Way_Bbox_Geometry_Store::get_geometry`): a vertex
   * survives when it is an end of a segment that touches the box, else it prints `null`.
   */
  describe('the Discovery Park reproduction', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/discovery-park-nearby.json', import.meta.url), 'utf8'),
    ) as { records: OverpassElement[]; geometry: OverpassElement[] };
    const POINT = at(47.6588, -122.4056);
    type Box = { south: number; west: number; north: number; east: number };
    const CIRCLE: Box = {
      south: 47.651528,
      west: -122.4163981,
      north: 47.666072,
      east: -122.3948019,
    };
    const STRIP: Box = { south: 47.6587999, west: -122.4056001, north: 90, east: -122.4055999 };

    /** `Bbox_Double::intersects`, without the antimeridian branch this fixture never needs. */
    function touches(a: OverpassLatLon, b: OverpassLatLon, box: Box): boolean {
      if ((a.lat < box.south && b.lat < box.south) || (a.lat > box.north && b.lat > box.north)) {
        return false;
      }
      const lonAt = (lat: number) => a.lon + ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat);
      const lons = [a, b].filter((p) => p.lat >= box.south && p.lat <= box.north).map((p) => p.lon);
      for (const edge of [box.south, box.north]) {
        if ((a.lat - edge) * (b.lat - edge) < 0) lons.push(lonAt(edge));
      }
      return Math.min(...lons) <= box.east && Math.max(...lons) >= box.west;
    }

    function clip(path: (OverpassLatLon | null)[], box: Box): (OverpassLatLon | null)[] {
      const keep = path.map(() => false);
      path.forEach((a, i) => {
        const b = path[i + 1];
        if (a && b && touches(a, b, box)) keep[i] = keep[i + 1] = true;
      });
      return path.map((p, i) => (keep[i] ? p : null));
    }

    type Member = { type: string; ref: number; geometry?: (OverpassLatLon | null)[] };

    /**
     * One geometry print as the around query receives it: each way, and each relation as a
     * header followed by its member ways, cut by `cut`. The strip print filters both to what
     * touches the strip; the circle print lists every matched way and relation.
     */
    function geometryPrint(
      cut: (path: (OverpassLatLon | null)[]) => (OverpassLatLon | null)[],
      strip: boolean,
    ) {
      const touching = (path: (OverpassLatLon | null)[]) => path.some((p) => p !== null);
      return fixture.geometry.flatMap((el): object[] => {
        if (el.geometry) {
          const geometry = cut(el.geometry);
          return strip && !touching(geometry) ? [] : [{ type: 'way', id: el.id, geometry }];
        }
        const members = (el.members as Member[])
          .filter((m) => m.type === 'way' && m.geometry)
          .map((m) => ({ type: 'way', id: m.ref, geometry: cut(m.geometry!) }))
          .filter((m) => touching(m.geometry));
        return strip && members.length === 0 ? [] : [{ type: 'relation', id: el.id }, ...members];
      });
    }

    const ranked = (nearest: object[], strip: object[]) =>
      rankByNearestPoint(aroundResponse(fixture.records, nearest, strip), POINT).elements.map(
        (el) => [el.tags?.name, round1(el.distanceMeters)],
      );

    const EXPECTED = [
      ['Commodore Park', 793.8],
      ['Kiwanis Memorial Preserve Park', 262.3],
      ['Kiwanis Ravine Overlook', 214.1],
      ['Discovery Park', 0],
    ];

    it('ranks from the clipped prints the around query asks for', () => {
      const nearest = geometryPrint((path) => clip(path, CIRCLE), false);
      const strip = geometryPrint((path) => clip(path, STRIP), true);
      // The strip print is tiny: Discovery Park's ray leaves through one outer segment.
      expect(strip).toEqual([
        { type: 'relation', id: 4874562 },
        {
          type: 'way',
          id: 374888416,
          geometry: expect.arrayContaining([
            at(47.6606021, -122.406347),
            at(47.6606021, -122.405521),
          ]),
        },
      ]);
      expect(ranked(nearest, strip)).toEqual(EXPECTED);
    });

    it('matches the distances unclipped geometry gives', () => {
      const full = (strip: boolean) => geometryPrint((path) => path, strip);
      expect(ranked(full(false), full(true))).toEqual(EXPECTED);
    });

    it('measured every feature from its bounding-box center before, past the radius for one', () => {
      const centers = fixture.records.map((el) => [
        el.tags?.name,
        round1(haversineMeters(POINT.lat, POINT.lon, el.center!.lat, el.center!.lon)),
      ]);
      expect(centers).toEqual([
        ['Commodore Park', 836.3],
        ['Kiwanis Memorial Preserve Park', 526.8],
        ['Kiwanis Ravine Overlook', 249],
        ['Discovery Park', 1112.8],
      ]);
    });
  });
});

/**
 * The ranking of a center-only around response, which answers when the geometry response
 * passes the read ceiling: every way and relation is measured to its `out center` point, as
 * 0.6.0 ranked every call, where `rankByNearestPoint` would leave them unmeasured.
 */
describe('rankByCenter', () => {
  const ORIGIN = at(0, 0);
  const response: OverpassResult = {
    version: 0.6,
    osm3s: { timestamp_osm_base: '2026-10-14T18:00:00Z' },
    servedBy: 'https://overpass-api.de',
    elements: [
      { type: 'relation', id: 9, center: at(0.01, 0), tags: { type: 'route' } },
      { type: 'way', id: 2, center: at(0.001, 0), tags: { highway: 'service' } },
      { type: 'node', id: 1, lat: 0, lon: 0.001, tags: {} },
      { type: 'way', id: 3, tags: { highway: 'path' } },
    ],
  };

  it('measures nodes to their coordinate and ways and relations to their center, in upstream order', () => {
    expect(
      rankByCenter(response, ORIGIN).elements.map((el) => [el.type, el.id, el.distanceMeters]),
    ).toEqual([
      ['relation', 9, haversineMeters(0, 0, 0.01, 0)],
      ['way', 2, haversineMeters(0, 0, 0.001, 0)],
      ['node', 1, haversineMeters(0, 0, 0, 0.001)],
      ['way', 3, undefined],
    ]);
  });

  it('marks the result rankedByCenter and keeps everything else it carried', () => {
    const { elements, ...rest } = rankByCenter(response, ORIGIN);
    expect(rest).toEqual({
      version: 0.6,
      osm3s: { timestamp_osm_base: '2026-10-14T18:00:00Z' },
      servedBy: 'https://overpass-api.de',
      rankedByCenter: true,
    });
    expect(elements[3]).toBe(response.elements[3]);
    expect(response.elements[1]).not.toHaveProperty('distanceMeters');
  });

  it('leaves the same center-only records unmeasured under rankByNearestPoint', () => {
    expect(
      rankByNearestPoint(response, ORIGIN).elements.map((el) => [el.id, el.distanceMeters]),
    ).toEqual([
      [9, undefined],
      [2, undefined],
      [1, haversineMeters(0, 0, 0, 0.001)],
      [3, undefined],
    ]);
  });
});
