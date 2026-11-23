/**
 * @fileoverview Unit tests for OverpassService.normalizeElements, the query builders, and
 * the nearest-point ranking the around query's geometry prints feed.
 * @module tests/services/overpass/normalize-elements.test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  elementPoint,
  haversineMeters,
  OverpassService,
  rankByCenter,
  rankByNearestPoint,
} from '@/services/overpass/overpass-service.js';
import type {
  OverpassBounds,
  OverpassElement,
  OverpassLatLon,
  OverpassPoiType,
  OverpassResult,
} from '@/services/overpass/types.js';

/** Minimal stub config / storage accepted by the constructor. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const service = new OverpassService({} as any, {} as any);

/**
 * Boxes `out bb` printed (Overpass API 0.7.62.9, data as of 2026-11-23); each comment names
 * the point `out center` printed for the same element on the same data (#139). The queries
 * print a way's center, never its box, so the two way boxes serve only as boxes.
 */
const BOUNDS = {
  /** W165771208, Dick's Drive-In - Queen Anne: 47.6234672, -122.3563931. */
  driveIn: { minlat: 47.6233806, minlon: -122.3565938, maxlat: 47.6235538, maxlon: -122.3561923 },
  /** W56178742, Kiwanis Memorial Preserve Park: 47.6623084, -122.4008724 (lon mean a tie). */
  kiwanis: { minlat: 47.6588722, minlon: -122.4028391, maxlat: 47.6657446, maxlon: -122.3989056 },
  /** R165479, Washington: 47.2730861 (lat mean a tie), -120.8760427. */
  washington: {
    minlat: 45.5437331,
    minlon: -124.8360916,
    maxlat: 49.0024392,
    maxlon: -116.9159938,
  },
  /** R15781833, Laucala Island, beside the antimeridian, unwrapped: -16.7622862, -179.6834464. */
  laucala: { minlat: -16.7879224, minlon: -179.7038828, maxlat: -16.73665, maxlon: -179.66301 },
  /** R3237101, Taveuni, wrapped: -16.8487784, 0.0305418. */
  taveuni: { minlat: -17.0118282, minlon: 179.8870093, maxlat: -16.6857287, maxlon: -179.8259256 },
  /** R4097003, Vanua Levu, wrapped: -16.5701826, -0.7379481. */
  vanuaLevu: { minlat: -17.016014, minlon: 178.4754914, maxlat: -16.1243512, maxlon: -179.9513876 },
  /** R148838, United States, wrapped across the Pacific: 28.4140588, 40.0287143. */
  unitedStates: { minlat: -14.7608358, minlon: 144.4129186, maxlat: 71.5889534, maxlon: -64.35549 },
} satisfies Record<string, OverpassBounds>;

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

  /**
   * A way's point is the center its `out center` print carries, and a relation's the midpoint
   * of the box its `out bb` print carries (#139). Each expected value is what Overpass printed
   * for the same element under `out center` on the same data.
   */
  it('normalizes a way at the center Overpass printed for it', () => {
    const el: OverpassElement = {
      type: 'way',
      id: 165771208,
      center: { lat: 47.6234672, lon: -122.3563931 },
      tags: { name: "Dick's Drive-In - Queen Anne" },
    };
    const result = service.normalizeElements([el]);
    expect(result[0]).toEqual({
      osm_type: 'way',
      osm_id: 165771208,
      lat: 47.6234672,
      lon: -122.3563931,
      name: "Dick's Drive-In - Queen Anne",
      tags: { name: "Dick's Drive-In - Queen Anne" },
    });
  });

  it('normalizes a relation at the midpoint of its bounds, as Overpass printed its center', () => {
    const el: OverpassElement = {
      type: 'relation',
      id: 15781833,
      bounds: BOUNDS.laucala,
      tags: { name: 'Laucala Island' },
    };
    const result = service.normalizeElements([el]);
    expect(result[0]).toMatchObject({
      osm_type: 'relation',
      osm_id: 15781833,
      lat: -16.7622862,
      lon: -179.6834464,
    });
  });

  it('rounds a midpoint to the 7 decimals Overpass prints, from its binary value', () => {
    /**
     * Exact means 47.27308615 (R165479) and -122.40087235 (the box W56178742 printed, read here
     * as a relation's) are ties; rounded from the double each sum gives, as out center printed
     * them. A tie can land 1e-7° the other way.
     */
    const points = service.normalizeElements([
      { type: 'relation', id: 165479, bounds: BOUNDS.washington },
      { type: 'relation', id: 1, bounds: BOUNDS.kiwanis },
    ]);
    expect(points.map((poi) => [poi.lat, poi.lon])).toEqual([
      [47.2730861, -120.8760427],
      [47.6623084, -122.4008724],
    ]);
  });

  it('omits lat/lon for a way without a center and a relation without bounds', () => {
    /**
     * The second carries only the box `out bb` printed for its way, the third only the wrapped
     * `out center` point Overpass printed for Taveuni: neither is the print its type reads.
     */
    const elements = JSON.parse(
      JSON.stringify([
        { type: 'way', id: 99999, tags: { building: 'yes' } },
        { type: 'way', id: 165771208, bounds: BOUNDS.driveIn },
        { type: 'relation', id: 3237101, center: { lat: -16.8487784, lon: 0.0305418 } },
      ]),
    ) as OverpassElement[];
    const result = service.normalizeElements(elements);
    for (const poi of result) {
      expect(poi).not.toHaveProperty('lat');
      expect(poi).not.toHaveProperty('lon');
    }
    expect(result.map((poi) => poi.osm_id)).toEqual([99999, 165771208, 3237101]);
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

/**
 * #139: Overpass wraps a relation's bounds across the antimeridian (`minlon` > `maxlon`)
 * whenever its members span 180° of longitude or more, and its `out center` takes the plain
 * mean of the two longitudes — 180° from the box's midpoint. The midpoint is that mean moved
 * 180°, east for a mean at or below 0 and west above it, as Overpass's own
 * `Bbox_Double::center_lon` reads a box. Expected longitudes are the issue's, to 6 decimals.
 */
describe('elementPoint across the antimeridian (#139)', () => {
  const relation = (bounds: OverpassBounds): OverpassElement => ({
    type: 'relation',
    id: 1,
    bounds,
  });

  it.each([
    {
      name: 'Taveuni (R3237101), a mean above 0',
      bounds: BOUNDS.taveuni,
      center: { lat: -16.8487784, lon: 0.0305418 },
      lon: -179.969458,
    },
    {
      name: 'Vanua Levu (R4097003), a mean below 0',
      bounds: BOUNDS.vanuaLevu,
      center: { lat: -16.5701826, lon: -0.7379481 },
      lon: 179.262052,
    },
    {
      name: 'the United States (R148838), wrapped across the Pacific',
      bounds: BOUNDS.unitedStates,
      center: { lat: 28.4140588, lon: 40.0287143 },
      lon: -139.971286,
    },
  ])('places $name 180° of longitude from its out center', ({ bounds, center, lon }) => {
    const point = elementPoint(relation(bounds));
    expect(point?.lat).toBe(center.lat);
    expect(point?.lon).toBeCloseTo(lon, 6);
    expect(Math.abs(point!.lon - center.lon)).toBeCloseTo(180, 6);
    expect(Number(point!.lon.toFixed(7))).toBe(point!.lon);
  });

  it('keeps a box beside the antimeridian that does not wrap: Laucala Island (R15781833)', () => {
    expect(elementPoint(relation(BOUNDS.laucala))).toEqual({ lat: -16.7622862, lon: -179.6834464 });
  });

  it.each([
    { mean: 'exactly 0', minlon: 170, lon: 180 },
    { mean: 'one grid step above 0', minlon: 170.0000002, lon: -179.9999999 },
  ])('turns a wrapped mean of $mean to the side center_lon picks', ({ minlon, lon }) => {
    expect(elementPoint(relation({ minlat: 0, minlon, maxlat: 0, maxlon: -170 }))?.lon).toBe(lon);
  });

  it('reads a one-point box as that point, and a node as its own coordinate', () => {
    const at = { lat: -16.7349032, lon: -179.9411131 };
    expect(
      elementPoint(relation({ minlat: at.lat, minlon: at.lon, maxlat: at.lat, maxlon: at.lon })),
    ).toEqual(at);
    expect(elementPoint({ type: 'node', id: 9530936835, ...at })).toEqual(at);
  });

  it('reaches both normalizeElements fields', () => {
    const [taveuni] = service.normalizeElements([
      { type: 'relation', id: 3237101, bounds: BOUNDS.taveuni, tags: { name: 'Taveuni' } },
    ]);
    expect(taveuni).toMatchObject({ osm_id: 3237101, lat: -16.8487784, name: 'Taveuni' });
    expect(taveuni!.lon).toBeCloseTo(-179.969458, 6);
  });
});

/**
 * #139: each type is read from the print the queries give it — a node its own coordinate, a
 * way the `out center` point, a relation the `out bb` box. An element carrying another type's
 * print gets no point: a relation's center can sit 180° off, and no query prints a way's box.
 */
describe('elementPoint reads the print each type gets (#139)', () => {
  const driveIn = { lat: 47.6234672, lon: -122.3563931 };
  const wrappedCenter = { lat: -16.8487784, lon: 0.0305418 };

  it.each<[string, OverpassElement, OverpassLatLon | undefined]>([
    ['a node its own coordinate', { type: 'node', id: 1, ...driveIn }, driveIn],
    ['a way its center', { type: 'way', id: 165771208, center: driveIn }, driveIn],
    [
      'a relation the midpoint of its bounds',
      { type: 'relation', id: 15781833, bounds: BOUNDS.laucala },
      { lat: -16.7622862, lon: -179.6834464 },
    ],
    ['a node without a coordinate nothing', { type: 'node', id: 1 }, undefined],
    [
      'a way carrying only a box nothing',
      { type: 'way', id: 165771208, bounds: BOUNDS.driveIn },
      undefined,
    ],
    ['a way carrying neither nothing', { type: 'way', id: 2 }, undefined],
    [
      'a relation carrying only a center nothing',
      { type: 'relation', id: 3237101, center: wrappedCenter },
      undefined,
    ],
    ['a relation carrying neither nothing', { type: 'relation', id: 3237101 }, undefined],
  ])('gives %s', (_, el, point) => {
    expect(elementPoint(el)).toEqual(point);
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
 * #139: Overpass wraps only a relation's bounds, so only relations print `out bb tags;`.
 * Nodes and ways print `out center tags;`, and a query searching no relation is 0.7.3's text
 * byte for byte. Searching relations names the union `.matched` and prints it in two parts,
 * nodes and ways before relations — the order one print of the whole set gives, since a print
 * sorts by type. Tabled once at the shared match block, through the bbox builder; the union
 * lines are each searched type's own line, in input order.
 */
describe('the record print, split by type (#139)', () => {
  const RELEASED = [');', 'out center tags;'];
  const SPLIT = [
    ')->.matched;',
    '(node.matched;way.matched;);',
    'out center tags;',
    'rel.matched;',
    'out bb tags;',
  ];

  it.each<[OverpassPoiType[], string[]]>([
    [['node'], RELEASED],
    [['way'], RELEASED],
    [['node', 'way'], RELEASED],
    [['way', 'node'], RELEASED],
    [['relation'], SPLIT],
    [['node', 'relation'], SPLIT],
    [['way', 'relation'], SPLIT],
    [['node', 'way', 'relation'], SPLIT],
    [['relation', 'way', 'node', 'relation'], SPLIT],
  ])('ends a search of %j in its print', (elementTypes, tail) => {
    expect(
      service.buildBboxQuery({
        tagKey: 'tourism',
        elementTypes,
        timeoutSeconds: 25,
        south: 1,
        west: 2,
        north: 3,
        east: 4,
      }),
    ).toBe(
      [
        '[out:json][timeout:25][maxsize:268435456];',
        '(',
        ...elementTypes.map((type) => `  ${type}["tourism"](1,2,3,4);`),
        ...tail,
      ].join('\n'),
    );
  });

  /**
   * After the split print `_` holds the relations alone, so the around query's geometry prints
   * read the set the union named. A copy of `_` written to `.matched` after the print would rank
   * relations and leave every matched way unmeasured.
   */
  it('has the around query name the whole matched set once, at the union', () => {
    const ql = service.buildAroundQuery({
      tagKey: 'tourism',
      elementTypes: ['node', 'way', 'relation'],
      timeoutSeconds: 25,
      lat: 1,
      lon: 2,
      radiusMeters: 50,
    });
    const lines = ql.split('\n');
    expect(lines.filter((line) => line.includes('->.matched'))).toEqual([')->.matched;']);
    expect(
      lines.slice(lines.indexOf(')->.matched;') + 1, lines.indexOf('make nearby_nearest;')),
    ).toEqual(SPLIT.slice(1));
  });

  it('gives the center-only around query and the area query the same split print', () => {
    const params = { tagKey: 'tourism', elementTypes: ['way', 'relation'] as OverpassPoiType[] };
    const center = service.buildAroundCenterQuery({
      ...params,
      timeoutSeconds: 25,
      lat: 1,
      lon: 2,
      radiusMeters: 50,
    });
    const area = service.buildAreaQuery({
      ...params,
      timeoutSeconds: 25,
      areaRef: { kind: 'relation', osmId: '237385' },
    });
    for (const ql of [center, area]) expect(ql.endsWith(`\n${SPLIT.join('\n')}`)).toBe(true);
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
   * distance ranking reads, and #113 opens with `is_in` and adds a `pivot` line carrying the
   * same chain for the searched way type, so the legacy union lines sit unchanged inside the
   * head and the record print is unchanged.
   */
  it('emits the legacy union lines inside the containment arm, then the geometry prints', () => {
    expect(service.buildAroundQuery({ ...chain, lat: 47.6, lon: -122.3, radiusMeters: 1000 })).toBe(
      '[out:json][timeout:25][maxsize:268435456];\nis_in(47.6,-122.3)->.inside;\n(\n  node["amenity"="restaurant"]["cuisine"="italian"]["name"]["addr:street"="Pike St."](around:1000,47.6,-122.3);\n  way["amenity"="restaurant"]["cuisine"="italian"]["name"]["addr:street"="Pike St."](around:1000,47.6,-122.3);\n  way(pivot.inside)["amenity"="restaurant"]["cuisine"="italian"]["name"]["addr:street"="Pike St."];\n);\nout center tags;' +
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
        ')->.matched;',
        '(node.matched;way.matched;);',
        'out center tags;',
        'rel.matched;',
        'out bb tags;',
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
      service.buildAreaQuery({ ...primary, areaRef: { kind: 'relation', osmId: '237385' } }),
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
  /** The print that names the boundary (#117), between the sentinel and the match block. */
  const SCOPE_PRINT =
    '.a convert scope ::id=id(),name=t["name"],boundary=t["boundary"],admin_level=t["admin_level"];out;';

  describe('buildAreaQuery', () => {
    it('maps a relation ref with map_to_area and asks for the count sentinel and the scope print', () => {
      const ql = service.buildAreaQuery({
        areaRef: { kind: 'relation', osmId: '237385' },
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
          SCOPE_PRINT,
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
        areaRef: { kind: 'way', osmId: '13800188' },
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
          SCOPE_PRINT,
          '(',
          '  relation["leisure"]["name"="Amphitheater"](area.a);',
          ')->.matched;',
          '(node.matched;way.matched;);',
          'out center tags;',
          'rel.matched;',
          'out bb tags;',
        ].join('\n'),
      );
      expect(ql).not.toContain('2413800188');
    });

    /**
     * #143: the exact-name hint sizes the boundary from its bounding box, printed from the
     * default set — still the boundary element after `map_to_area` wrote `.a` — before the
     * sentinel, so `readAreaScope` can tell it from the features by position alone.
     */
    it.each([
      { kind: 'relation' as const, osmId: '165479', statement: 'rel(165479);map_to_area->.a;' },
      { kind: 'way' as const, osmId: '13800188', statement: 'way(13800188);map_to_area->.a;' },
    ])(
      'prints the $kind boundary with its bounds ahead of the sentinel under printBounds',
      ({ kind, osmId, statement }) => {
        const ql = service.buildAreaQuery({
          areaRef: { kind, osmId },
          tagKey: 'name',
          tagValue: 'Qqzzxx Nowhere',
          elementTypes: ['node', 'way', 'relation'],
          timeoutSeconds: 25,
          printBounds: true,
        });
        expect(ql).toBe(
          [
            '[out:json][timeout:25][maxsize:268435456];',
            statement,
            'out bb ids;',
            '.a out count;',
            SCOPE_PRINT,
            '(',
            '  node["name"="Qqzzxx Nowhere"](area.a);',
            '  way["name"="Qqzzxx Nowhere"](area.a);',
            '  relation["name"="Qqzzxx Nowhere"](area.a);',
            ')->.matched;',
            '(node.matched;way.matched;);',
            'out center tags;',
            'rel.matched;',
            'out bb tags;',
          ].join('\n'),
        );
      },
    );

    it('sends the query without the bounds print when printBounds is false', () => {
      const params = {
        areaRef: { kind: 'relation' as const, osmId: '237385' },
        tagKey: 'name',
        tagValue: 'Qqzzxx Nowhere',
        elementTypes: ['node' as const],
        timeoutSeconds: 25,
      };
      const ql = service.buildAreaQuery({ ...params, printBounds: false });
      expect(ql).toBe(service.buildAreaQuery(params));
      expect(ql).not.toContain('out bb ids;');
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

    /**
     * #117: what `rel(1453306)`, `way(13800188)`, and `rel(237385)` print under the scope
     * print, captured from `overpass-api.de` (Overpass API 0.7.62.11) on 2026-11-05. `convert`
     * writes a tag the boundary lacks as an empty string, and keeps the area's id — the area
     * id for a relation, the way's own for a closed way. `rel(1)` maps to no area and printed
     * its zero sentinel and no scope element at all.
     */
    const YELLOWSTONE_SCOPE: OverpassElement = {
      type: 'scope',
      id: 3601453306,
      tags: { name: 'Yellowstone National Park', boundary: 'protected_area', admin_level: '' },
    };
    const VOLUNTEER_PARK_SCOPE: OverpassElement = {
      type: 'scope',
      id: 13800188,
      tags: { name: 'Volunteer Park', boundary: '', admin_level: '' },
    };
    const SEATTLE_SCOPE: OverpassElement = {
      type: 'scope',
      id: 3600237385,
      tags: { name: 'Seattle', boundary: 'administrative', admin_level: '8' },
    };

    it.each([
      {
        label: 'relation-derived area',
        sentinel: RELATION_SENTINEL,
        print: YELLOWSTONE_SCOPE,
        boundary: { name: 'Yellowstone National Park', boundary: 'protected_area' },
      },
      {
        label: 'way-derived area',
        sentinel: WAY_SENTINEL,
        print: VOLUNTEER_PARK_SCOPE,
        boundary: { name: 'Volunteer Park' },
      },
      {
        label: 'administrative boundary',
        sentinel: RELATION_SENTINEL,
        print: SEATTLE_SCOPE,
        boundary: { name: 'Seattle', boundary: 'administrative', admin_level: '8' },
      },
    ])(
      'reads the boundary off the scope print for a $label, dropping empty values',
      ({ sentinel, print, boundary }) => {
        const scope = service.readAreaScope([sentinel, print, match]);
        expect(scope.resolved).toBe(true);
        expect(scope.boundary).toStrictEqual(boundary);
        expect(scope.elements).toEqual([match]);
      },
    );

    it('reads no boundary from a scope print whose every tag is empty', () => {
      const untagged: OverpassElement = {
        type: 'scope',
        id: 3600000002,
        tags: { name: '', boundary: '', admin_level: '' },
      };
      expect(service.readAreaScope([RELATION_SENTINEL, untagged]).boundary).toStrictEqual({});
    });

    it('reads no boundary when the ref resolved to no area, which prints no scope', () => {
      const scope = service.readAreaScope([EMPTY_SENTINEL]);
      expect(scope.resolved).toBe(false);
      expect(scope.boundary).toStrictEqual({});
    });

    it('never lets the scope print reach the features the tools count', () => {
      const scope = service.readAreaScope([RELATION_SENTINEL, YELLOWSTONE_SCOPE]);
      expect(scope.elements).toEqual([]);
      expect(service.normalizeElements(scope.elements)).toEqual([]);
    });

    /**
     * #143: `rel(237385);map_to_area->.a;out bb ids;` printed this ahead of the sentinel
     * (Overpass API 0.7.62.9, overpass.nextgis.com, data as of 2026-11-23).
     */
    const SEATTLE_BOUNDS_PRINT: OverpassElement = {
      type: 'relation',
      id: 237385,
      bounds: { minlat: 47.4810022, minlon: -122.459696, maxlat: 47.7341503, maxlon: -122.224433 },
    };

    it('reads the bounds off the print ahead of the sentinel and keeps it out of the features', () => {
      const scope = service.readAreaScope([
        SEATTLE_BOUNDS_PRINT,
        RELATION_SENTINEL,
        SEATTLE_SCOPE,
        match,
      ]);
      expect(scope).toStrictEqual({
        resolved: true,
        boundary: { name: 'Seattle', boundary: 'administrative', admin_level: '8' },
        bounds: SEATTLE_BOUNDS_PRINT.bounds,
        elements: [match],
      });
    });

    it('keeps the bounds print out of an empty page, so nothing counts', () => {
      const scope = service.readAreaScope([SEATTLE_BOUNDS_PRINT, RELATION_SENTINEL, SEATTLE_SCOPE]);
      expect(scope.elements).toEqual([]);
      expect(service.normalizeElements(scope.elements)).toEqual([]);
    });

    it("counts a feature carrying the boundary's own id after the sentinel", () => {
      const seattle: OverpassElement = {
        ...SEATTLE_BOUNDS_PRINT,
        tags: { boundary: 'administrative', admin_level: '8', name: 'Seattle' },
      };
      const scope = service.readAreaScope([
        SEATTLE_BOUNDS_PRINT,
        RELATION_SENTINEL,
        SEATTLE_SCOPE,
        seattle,
      ]);
      expect(scope.bounds).toEqual(SEATTLE_BOUNDS_PRINT.bounds);
      expect(scope.elements).toEqual([seattle]);
      expect(service.normalizeElements(scope.elements)).toMatchObject([
        { osm_type: 'relation', osm_id: 237385, name: 'Seattle' },
      ]);
    });

    it('still reads the bounds of a ref that exists but mapped to no area, unresolved', () => {
      const scope = service.readAreaScope([SEATTLE_BOUNDS_PRINT, EMPTY_SENTINEL]);
      expect(scope).toStrictEqual({
        resolved: false,
        boundary: {},
        bounds: SEATTLE_BOUNDS_PRINT.bounds,
        elements: [],
      });
    });

    it('reads no bounds when nothing precedes the sentinel', () => {
      expect(service.readAreaScope([RELATION_SENTINEL, match])).not.toHaveProperty('bounds');
      expect(service.readAreaScope([EMPTY_SENTINEL])).not.toHaveProperty('bounds');
    });

    /**
     * No sentinel means no bounds print either: the relation leading the page is a feature,
     * whose `bounds` come from the `out bb tags;` relation print, not the boundary's.
     */
    it('reads a body with no sentinel as unresolved features, taking no bounds off the first', () => {
      const seattle: OverpassElement = {
        ...SEATTLE_BOUNDS_PRINT,
        tags: { boundary: 'administrative', admin_level: '8', name: 'Seattle' },
      };
      expect(service.readAreaScope([seattle, match])).toStrictEqual({
        resolved: false,
        boundary: {},
        elements: [seattle, match],
      });
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

    it('drops a scope element, the boundary print of a within query (#117)', () => {
      const scope: OverpassElement = {
        type: 'scope',
        id: 13800188,
        tags: { name: 'Volunteer Park' },
      };
      const node: OverpassElement = { type: 'node', id: 7, lat: 47.6, lon: -122.3 };
      expect(service.normalizeElements([scope, node]).map((poi) => poi.osm_id)).toEqual([7]);
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
        '[out:json][timeout:25][maxsize:268435456];',
        'is_in(47.6,-122.3)->.inside;',
        '(',
        '  relation["amenity"="cafe"](around:200,47.6,-122.3);',
        '  relation(pivot.inside)["amenity"="cafe"];',
        ')->.matched;',
        '(node.matched;way.matched;);',
        'out center tags;',
        'rel.matched;',
        'out bb tags;',
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
        '[out:json][timeout:25][maxsize:268435456];',
        'is_in(47.6588,-122.4056)->.inside;',
        '(',
        '  node["amenity"="cafe"](around:800,47.6588,-122.4056);',
        '  way["amenity"="cafe"](around:800,47.6588,-122.4056);',
        '  relation["amenity"="cafe"](around:800,47.6588,-122.4056);',
        '  way(pivot.inside)["amenity"="cafe"];',
        '  relation(pivot.inside)["amenity"="cafe"];',
        ')->.matched;',
        '(node.matched;way.matched;);',
        'out center tags;',
        'rel.matched;',
        'out bb tags;',
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
/**
 * A one-point `out bb` box: the relation records below carry one as the records print does,
 * though nothing but `rankByCenter` reads it, and `rankByNearestPoint` never does.
 */
const box = (lat: number, lon: number): OverpassBounds => ({
  minlat: lat,
  minlon: lon,
  maxlat: lat,
  maxlon: lon,
});
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
    const lake = { type: 'relation', id: 5, bounds: box(0, 0), tags: { type: 'multipolygon' } };
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
      bounds: box(0, 0),
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
    const route = { type: 'relation', id: 13, bounds: box(0, 0.5), tags: { type: 'route' } };
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

  it('omits the distance of a way or relation that arrived without geometry, never using its bounds', () => {
    const result = rankByNearestPoint(
      aroundResponse(
        [
          { type: 'way', id: 10, center: at(0, 0.001), tags: {} },
          { type: 'relation', id: 11, bounds: box(0, 0.001), tags: { type: 'multipolygon' } },
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
   * Captured responses for the reproduction: the records `out center tags` printed, the
   * relation's center since replaced by its `out bb` bounds, whose midpoint it is, and the
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
      const centers = fixture.records.map((el) => {
        const { lat, lon } = elementPoint(el)!;
        return [el.tags?.name, round1(haversineMeters(POINT.lat, POINT.lon, lat, lon))];
      });
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
 * passes the read ceiling: every way is measured to its `out center` point and every relation
 * to the midpoint of its `out bb` bounds, as 0.6.0 ranked every call, where
 * `rankByNearestPoint` would leave them unmeasured.
 */
describe('rankByCenter', () => {
  const ORIGIN = at(0, 0);
  const response: OverpassResult = {
    version: 0.6,
    osm3s: { timestamp_osm_base: '2026-10-14T18:00:00Z' },
    servedBy: 'https://overpass-api.de',
    elements: [
      {
        type: 'relation',
        id: 9,
        bounds: { minlat: 0.005, minlon: -0.001, maxlat: 0.015, maxlon: 0.001 },
        tags: { type: 'route' },
      },
      { type: 'way', id: 2, center: at(0.001, 0), tags: { highway: 'service' } },
      { type: 'node', id: 1, lat: 0, lon: 0.001, tags: {} },
      { type: 'way', id: 3, tags: { highway: 'path' } },
    ],
  };

  it('measures a relation whose bounds wrap across the antimeridian to their midpoint (#139)', () => {
    const taveuni: OverpassResult = {
      version: 0.6,
      elements: [
        { type: 'relation', id: 3237101, bounds: BOUNDS.taveuni, tags: { name: 'Taveuni' } },
      ],
    };
    const [ranked] = rankByCenter(taveuni, at(-16.85, 179.97)).elements;
    // About 6.4 km; Overpass's `out center` point (lon 0.0305418) sits some 16,268 km away.
    expect(Math.round(ranked!.distanceMeters! / 100) / 10).toBe(6.4);
  });

  it('measures nodes to their coordinate, ways to their center, and relations to their bounds midpoint, in upstream order', () => {
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
