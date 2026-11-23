/**
 * @fileoverview Unit tests for the name-search hint an exact-name filter that matched nothing adds
 * to `notice` on openstreetmap_query_nearby and openstreetmap_query_bbox (#136): when it fires,
 * the two routes it prints, the box they search, the index blocks that pick a boundary's route
 * (#143), and the cost of its scans over the caller's value.
 * @module tests/tools/openstreetmap-name-hint.test
 */

import { describe, expect, it } from 'vitest';
import {
  areaIndexBlocks,
  type NameHintScope,
  nameSearchHint,
} from '@/mcp-server/tools/definitions/openstreetmap-name-hint.js';
import { resolveTagInput } from '@/mcp-server/tools/definitions/openstreetmap-tag-input.js';
import type { OverpassBounds } from '@/services/overpass/types.js';

/** The tool input as `resolveTagInput` resolves it, which is what both tools pass in. */
function resolved(input: Parameters<typeof resolveTagInput>[0]) {
  const tag = resolveTagInput(input);
  if ('error' in tag) throw new Error(`fixture rejected: ${tag.error}`);
  return tag;
}

const lead = (key: string) =>
  `Exact equality on ${key} compares the whole value, case-sensitively.`;

/** The hint with both routes: the search arguments line, then the raw query line. */
const bothRoutes = (key: string, search: string, raw: string) =>
  `${lead(key)} Search by name with openstreetmap_search_places and these arguments, or match the value anywhere in ${key}, in any case, with openstreetmap_query_raw and this query:\n${search}\n${raw}`;

/** The hint with the raw query alone, for a scope Nominatim's viewbox cannot carry. */
const rawRoute = (key: string, raw: string) =>
  `${lead(key)} Match the value anywhere in ${key}, in any case, with openstreetmap_query_raw and this query:\n${raw}`;

/** The hint with the search arguments alone, for a box too large for the raw query to run. */
const searchRoute = (key: string, search: string) =>
  `${lead(key)} Search by name with openstreetmap_search_places and these arguments:\n${search}`;

/** The two routes for `name=X` over a box given as south, west, north, east. */
function boxRoutes(south: number, west: number, north: number, east: number) {
  return {
    search: `{"query":"X","viewbox":{"west":${west},"south":${south},"east":${east},"north":${north}},"bounded":true}`,
    raw: `[out:json][timeout:25];nwr["name"~"X",i](${south},${west},${north},${east});out center tags;`,
  };
}

/** The issue's call: Dick's Drive-In within 3000 m of the Space Needle. */
const DICKS: NameHintScope = { lat: 47.6205, lon: -122.3493, radiusMeters: 3000 };
const DICKS_SEARCH =
  '{"query":"Dick\'s Drive-In","viewbox":{"west":-122.3894,"south":47.5935,"east":-122.3092,"north":47.6475},"bounded":true}';
const DICKS_RAW =
  '[out:json][timeout:25];nwr["name"~"Dick\'s Drive-In",i](47.5935,-122.3894,47.6475,-122.3092);out center tags;';

/**
 * Boundary bounds as `out bb` printed them (Overpass API 0.7.62.9, overpass.nextgis.com, data as
 * of 2026-11-23), then two invented boxes either side of the 12-block limit: 12 and 13 block rows
 * in one block column.
 */
const AREA_BOUNDS = {
  /** R237385, Seattle. */
  seattle: { minlat: 47.4810022, minlon: -122.459696, maxlat: 47.7341503, maxlon: -122.224433 },
  /** R165479, Washington. */
  washington: {
    minlat: 45.5437331,
    minlon: -124.8360916,
    maxlat: 49.0024392,
    maxlon: -116.9159938,
  },
  /** R3237101, Taveuni, wrapped across the antimeridian. */
  taveuni: { minlat: -17.0118282, minlon: 179.8870093, maxlat: -16.6857287, maxlon: -179.8259256 },
  /** R148838, United States, wrapped across the Pacific. */
  unitedStates: { minlat: -14.7608358, minlon: 144.4129186, maxlat: 71.5889534, maxlon: -64.35549 },
  twelveRows: { minlat: 10.0000001, minlon: 20.0000001, maxlat: 11.2000001, maxlon: 20.0100001 },
  thirteenRows: { minlat: 10.0000001, minlon: 20.0000001, maxlat: 11.3000001, maxlon: 20.0100001 },
} satisfies Record<string, OverpassBounds>;

/**
 * The index blocks a boundary's bounds cover (#143), each 2²⁰ of Overpass's 1e-7° units on a side.
 * Every expected count is a brute force, independent of the arithmetic under test: the distinct
 * block keys Overpass derives from a coordinate (`ll_upper & 0xffffff00` over its rounded integer
 * coordinate), sampled every 0.05° across each box and at its exact edges.
 */
describe('areaIndexBlocks', () => {
  it.each([
    { name: 'Seattle (R237385), 4 rows × 3 columns', bounds: AREA_BOUNDS.seattle, blocks: 12 },
    { name: 'Washington (R165479), 34 × 77', bounds: AREA_BOUNDS.washington, blocks: 2618 },
    {
      name: 'Taveuni (R3237101), 4 rows × (2 + 3) columns across the antimeridian',
      bounds: AREA_BOUNDS.taveuni,
      blocks: 20,
    },
    {
      name: 'the United States (R148838), 824 × (340 + 1104) across the antimeridian',
      bounds: AREA_BOUNDS.unitedStates,
      blocks: 1_189_856,
    },
  ])('counts $name', ({ bounds, blocks }) => {
    expect(areaIndexBlocks(bounds)).toBe(blocks);
  });

  it('counts one block for a one-point box', () => {
    expect(areaIndexBlocks({ minlat: 47.6, minlon: -122.3, maxlat: 47.6, maxlon: -122.3 })).toBe(1);
  });

  /**
   * Overpass stores a coordinate as an integer count of 1e-7° and rounds to it; in binary floating
   * point a coordinate exactly on a block line can land a hair below it, one block short.
   */
  it.each([
    {
      edge: 'a south edge on a block line, (37.0311296 + 91) × 10⁷ = 1221 × 2²⁰',
      bounds: { minlat: 37.0311296, minlon: -122, maxlat: 37.4, maxlon: -121.8 },
      blocks: 12,
    },
    {
      edge: 'a west edge on a block line, -178.25792 × 10⁷ = -1700 × 2²⁰',
      bounds: { minlat: 10.0000001, minlon: -178.25792, maxlat: 10.05, maxlon: -178.1 },
      blocks: 2,
    },
  ])('places $edge in the block that line opens', ({ bounds, blocks }) => {
    expect(areaIndexBlocks(bounds)).toBe(blocks);
  });
});

describe('nameSearchHint', () => {
  it("prints both routes for the issue's call, byte for byte, each on a line of its own", () => {
    const hint = nameSearchHint(resolved({ tag_key: 'name', tag_value: "Dick's Drive-In" }), DICKS);
    expect(hint).toBe(bothRoutes('name', DICKS_SEARCH, DICKS_RAW));
    expect(hint?.split('\n').slice(1)).toEqual([DICKS_SEARCH, DICKS_RAW]);
  });

  describe('when it fires', () => {
    it.each([
      {
        label: 'an exact name filter beside another primary tag',
        input: { amenity: 'fast_food', filters: [{ key: 'name', value: "Dick's Drive-In" }] },
        key: 'name',
      },
      {
        label: 'an explicit exact match',
        input: { tag_key: 'name', tag_value: "Dick's Drive-In", tag_value_match: 'exact' as const },
        key: 'name',
      },
      {
        label: 'a name:* primary key',
        input: { tag_key: 'name:en', tag_value: "Dick's Drive-In" },
        key: 'name:en',
      },
      {
        label: 'a name:* filter after key existence on name',
        input: { tag_key: 'name', filters: [{ key: 'name:en', value: "Dick's Drive-In" }] },
        key: 'name:en',
      },
      {
        label: 'the first exact name entry, past a list-item one',
        input: {
          tag_key: 'name',
          tag_value: 'Other',
          tag_value_match: 'list_item' as const,
          filters: [
            { key: 'name:en', value: "Dick's Drive-In" },
            { key: 'name:fr', value: 'Y' },
          ],
        },
        key: 'name:en',
      },
    ])('names the value of $label', ({ input, key }) => {
      expect(nameSearchHint(resolved(input), DICKS)).toBe(
        bothRoutes(
          key,
          DICKS_SEARCH,
          `[out:json][timeout:25];nwr["${key}"~"Dick's Drive-In",i](47.5935,-122.3894,47.6475,-122.3092);out center tags;`,
        ),
      );
    });

    it.each([
      { label: 'key existence on name', input: { tag_key: 'name' } },
      {
        label: 'a list-item match on name',
        input: { tag_key: 'name', tag_value: 'X', tag_value_match: 'list_item' as const },
      },
      { label: 'brand', input: { tag_key: 'brand', tag_value: "Dick's Drive-In" } },
      { label: 'a capitalized Name key', input: { tag_key: 'Name', tag_value: 'X' } },
      { label: 'a key that only contains name', input: { tag_key: 'alt_name', tag_value: 'X' } },
      { label: 'a key name_1', input: { tag_key: 'name_1', tag_value: 'X' } },
      { label: 'a key nameplate', input: { tag_key: 'nameplate', tag_value: 'X' } },
      { label: 'a key names', input: { tag_key: 'names', tag_value: 'X' } },
      { label: 'no name entry at all', input: { amenity: 'cafe', filters: [{ key: 'cuisine' }] } },
      { label: 'a value carrying LF', input: { tag_key: 'name', tag_value: 'Dick’s\nDrive-In' } },
      { label: 'a value carrying CR', input: { tag_key: 'name', tag_value: 'Dick’s\rDrive-In' } },
      { label: 'a value carrying CRLF', input: { tag_key: 'name', tag_value: 'a\r\nb' } },
      { label: 'a key carrying a line break', input: { tag_key: 'name:a\nb', tag_value: 'X' } },
    ])('returns nothing for $label', ({ input }) => {
      expect(nameSearchHint(resolved(input), DICKS)).toBeUndefined();
    });
  });

  /**
   * A radius scope searches its bounding box: latitude ± r / 111,195 m, longitude ± r /
   * (111,195 m × cos lat), rounded outward to 4 decimals and clamped at ±90°. A band that reaches
   * a pole spans every longitude; an edge past ±180° wraps, giving a crossing box.
   */
  describe('the box of a radius', () => {
    it.each([
      {
        label: 'edges already on the 4-decimal grid, unchanged',
        scope: { lat: 0, lon: 0, radiusMeters: 11_119.5 },
        box: [-0.1, -0.1, 0.1, 0.1],
      },
      {
        label: 'edges just past the grid, rounded outward',
        scope: { lat: 0, lon: 0, radiusMeters: 11_119.6 },
        box: [-0.1001, -0.1001, 0.1001, 0.1001],
      },
      // 0.8994° × 0.8994° is 0.809 square degrees, under the limit the raw query runs within.
      {
        label: 'the largest radius at the equator',
        scope: { lat: 0, lon: 0, radiusMeters: 50_000 },
        box: [-0.4497, -0.4497, 0.4497, 0.4497],
      },
      {
        label: 'an east edge that rounds out to 180, needing no wrap',
        scope: { lat: 0, lon: 179.973, radiusMeters: 3000 },
        box: [-0.027, 179.946, 0.027, 180],
      },
      // 179.9 + 11119.5 / 111195 is exactly 180 in binary floating point, before any rounding.
      {
        label: 'an east edge exactly on 180, needing no wrap',
        scope: { lat: 0, lon: 179.9, radiusMeters: 11119.5 },
        box: [-0.1, 179.8, 0.1, 180],
      },
      {
        label: 'a west edge exactly on -180, needing no wrap',
        scope: { lat: 0, lon: -179.9, radiusMeters: 11119.5 },
        box: [-0.1, -180, 0.1, -179.8],
      },
    ])('searches $label', ({ scope, box }) => {
      const [south, west, north, east] = box as [number, number, number, number];
      const { search, raw } = boxRoutes(south, west, north, east);
      expect(nameSearchHint(resolved({ tag_key: 'name', tag_value: 'X' }), scope)).toBe(
        bothRoutes('name', search, raw),
      );
    });

    /**
     * Overpass reads a box before the tag filter only when its height times its width is under
     * one square degree; at or over that the name regex runs first and the query runs out its
     * timeout, as the raw query for a 2 km radius at the pole did. Those boxes get the search call.
     */
    it.each([
      {
        label: 'a band clamped at the north pole',
        scope: { lat: 89.99, lon: 10, radiusMeters: 3000 },
        box: [89.963, -180, 90, 180],
      },
      {
        label: 'a band clamped at the south pole',
        scope: { lat: -89.99, lon: 10, radiusMeters: 3000 },
        box: [-90, -180, -89.963, 180],
      },
      // 0.8994° × 1.7988° is 1.618 square degrees.
      {
        label: 'the largest radius at latitude 60',
        scope: { lat: 60, lon: 0, radiusMeters: 50_000 },
        box: [59.5503, -0.8994, 60.4497, 0.8994],
      },
    ])('prints the search call alone for $label', ({ scope, box }) => {
      const [south, west, north, east] = box as [number, number, number, number];
      expect(nameSearchHint(resolved({ tag_key: 'name', tag_value: 'X' }), scope)).toBe(
        searchRoute('name', boxRoutes(south, west, north, east).search),
      );
    });

    it.each([
      {
        label: 'past 180',
        scope: { lat: 0, lon: 179.99, radiusMeters: 3000 },
        west: 179.963,
        east: -179.983,
      },
      {
        label: 'past -180',
        scope: { lat: 0, lon: -179.99, radiusMeters: 3000 },
        west: 179.983,
        east: -179.963,
      },
    ])(
      'wraps an edge $label into a crossing box and prints the raw query alone, one box per side',
      ({ scope, west, east }) => {
        expect(nameSearchHint(resolved({ tag_key: 'name', tag_value: 'X' }), scope)).toBe(
          rawRoute(
            'name',
            `[out:json][timeout:25];(nwr["name"~"X",i](-0.027,${west},0.027,180);nwr["name"~"X",i](-0.027,-180,0.027,${east}););out center tags;`,
          ),
        );
      },
    );
  });

  describe('the box of four corners', () => {
    it('searches the corners as given', () => {
      const { search, raw } = boxRoutes(47.58, -122.36, 47.63, -122.29);
      expect(
        nameSearchHint(resolved({ tag_key: 'name', tag_value: 'X' }), {
          box: { south: 47.58, west: -122.36, north: 47.63, east: -122.29 },
        }),
      ).toBe(bothRoutes('name', search, raw));
    });

    /**
     * Overpass measures a box whose west is greater than its east by the distance between the
     * two, nearly 360°, so the route searches each side of the antimeridian as a box of its own,
     * in one union.
     */
    it('prints the raw query alone for a box that crosses the antimeridian, one box per side', () => {
      const box = { south: -0.5, west: 179.5, north: 0.5, east: -179.5 };
      expect(nameSearchHint(resolved({ tag_key: 'name', tag_value: 'X' }), { box })).toBe(
        rawRoute(
          'name',
          '[out:json][timeout:25];(nwr["name"~"X",i](-0.5,179.5,0.5,180);nwr["name"~"X",i](-0.5,-180,0.5,-179.5););out center tags;',
        ),
      );
    });

    /** Height × width in square degrees, on either side of the limit of one. */
    it.each([
      { label: '0.9999° × 1°', box: { south: 10, west: 20, north: 10.9999, east: 21 } },
      // A strip 0.01° tall and 90° wide: 0.9 square degrees, answered in 1.6 s when probed.
      { label: 'a thin strip 90° wide', box: { south: 47.6, west: -130, north: 47.61, east: -40 } },
    ])('prints both routes for a box under one square degree: $label', ({ box }) => {
      const { search, raw } = boxRoutes(box.south, box.west, box.north, box.east);
      expect(nameSearchHint(resolved({ tag_key: 'name', tag_value: 'X' }), { box })).toBe(
        bothRoutes('name', search, raw),
      );
    });

    it.each([
      { label: '1° × 1°', box: { south: 10, west: 20, north: 11, east: 21 } },
      // The same strip 135° wide: 1.35 square degrees, timed out when probed.
      { label: 'a thin strip 135° wide', box: { south: 47.6, west: -130, north: 47.61, east: 5 } },
      { label: '1° × 180°', box: { south: 10, west: -90, north: 11, east: 90 } },
      { label: 'the whole longitude range', box: { south: 10, west: -180, north: 11, east: 180 } },
    ])('prints the search call alone for a box of one square degree or more: $label', ({ box }) => {
      expect(nameSearchHint(resolved({ tag_key: 'name', tag_value: 'X' }), { box })).toBe(
        searchRoute('name', boxRoutes(box.south, box.west, box.north, box.east).search),
      );
    });

    it.each([
      // Each side is 2° × 0.5°: exactly one square degree.
      { label: 'two sides at the limit', box: { south: -1, west: 179.5, north: 1, east: -179.5 } },
      { label: 'one side 190° wide', box: { south: -1, west: -10, north: 1, east: -20 } },
      // 2° × 0.1° west of the antimeridian runs, 2° × 1° east of it does not: the union would not.
      { label: 'one side under, one over', box: { south: -1, west: 179.9, north: 1, east: -179 } },
    ])(
      'returns nothing for a crossing box with a side of one square degree or more: $label',
      ({ box }) => {
        expect(
          nameSearchHint(resolved({ tag_key: 'name', tag_value: 'X' }), { box }),
        ).toBeUndefined();
      },
    );

    it.each([
      { label: 'has zero width', box: { south: -1, west: 10, north: 1, east: 10 } },
      { label: 'has zero height', box: { south: 1, west: 10, north: 1, east: 11 } },
    ])('prints the raw query alone for a box that $label', ({ box }) => {
      expect(nameSearchHint(resolved({ tag_key: 'name', tag_value: 'X' }), { box })).toBe(
        rawRoute(
          'name',
          `[out:json][timeout:25];nwr["name"~"X",i](${box.south},${box.west},${box.north},${box.east});out center tags;`,
        ),
      );
    });
  });

  /**
   * Overpass reads a boundary's area before the tag filter only while the area uses at most 12
   * index blocks (#143); past that the name regex runs over every `name` in the database first and
   * the raw query runs out its timeout, as it did inside Washington state. The area uses no block
   * outside its bounds, so the hint counts the blocks the bounds cover.
   */
  describe('a within boundary', () => {
    const NAME = resolved({ tag_key: 'name', tag_value: "Dick's Drive-In" });
    const SEATTLE_RAW =
      '[out:json][timeout:25];rel(237385);map_to_area->.a;nwr["name"~"Dick\'s Drive-In",i](area.a);out center tags;';
    const within = (bounds?: OverpassBounds): NameHintScope => ({
      areaRef: { kind: 'relation', osmId: '237385' },
      ...(bounds && { bounds }),
    });

    it.each([
      {
        kind: 'relation' as const,
        osmId: '237385',
        raw: SEATTLE_RAW,
      },
      {
        kind: 'way' as const,
        osmId: '13800188',
        raw: '[out:json][timeout:25];way(13800188);map_to_area->.a;nwr["name"~"Dick\'s Drive-In",i](area.a);out center tags;',
      },
    ])(
      'prints the raw query alone, scoped to the $kind area, when no bounds were printed',
      ({ kind, osmId, raw }) => {
        expect(nameSearchHint(NAME, { areaRef: { kind, osmId } })).toBe(rawRoute('name', raw));
      },
    );

    it("prints Seattle's raw query byte for byte: its bounds cover 4 × 3 = 12 blocks", () => {
      expect(nameSearchHint(NAME, within(AREA_BOUNDS.seattle))).toBe(rawRoute('name', SEATTLE_RAW));
    });

    it('prints the raw query for a way whose bounds cover few blocks', () => {
      expect(
        nameSearchHint(NAME, {
          areaRef: { kind: 'way', osmId: '13800188' },
          bounds: { minlat: 47.6266, minlon: -122.3172, maxlat: 47.6337, maxlon: -122.3122 },
        }),
      ).toBe(
        rawRoute(
          'name',
          '[out:json][timeout:25];way(13800188);map_to_area->.a;nwr["name"~"Dick\'s Drive-In",i](area.a);out center tags;',
        ),
      );
    });

    it("prints the search arguments alone for Washington's 2,618 blocks, bounds rounded outward", () => {
      expect(
        nameSearchHint(
          resolved({ tag_key: 'name', tag_value: 'Qqzzxx Nowhere' }),
          within(AREA_BOUNDS.washington),
        ),
      ).toBe(
        searchRoute(
          'name',
          '{"query":"Qqzzxx Nowhere","viewbox":{"west":-124.8361,"south":45.5437,"east":-116.9159,"north":49.0025},"bounded":true}',
        ),
      );
    });

    it('prints the raw query for bounds covering 12 blocks and the search arguments for 13', () => {
      expect(nameSearchHint(NAME, within(AREA_BOUNDS.twelveRows))).toBe(
        rawRoute('name', SEATTLE_RAW),
      );
      expect(nameSearchHint(NAME, within(AREA_BOUNDS.thirteenRows))).toBe(
        searchRoute(
          'name',
          '{"query":"Dick\'s Drive-In","viewbox":{"west":20,"south":10,"east":20.0101,"north":11.3001},"bounded":true}',
        ),
      );
    });

    it("returns nothing for crossing bounds over 12 blocks: Taveuni's 20, which a viewbox cannot carry", () => {
      expect(nameSearchHint(NAME, within(AREA_BOUNDS.taveuni))).toBeUndefined();
    });

    it('prints the raw query for crossing bounds of 12 blocks or fewer', () => {
      expect(
        nameSearchHint(
          NAME,
          within({ minlat: -16.8, minlon: 179.95, maxlat: -16.75, maxlon: -179.95 }),
        ),
      ).toBe(rawRoute('name', SEATTLE_RAW));
    });

    it('carries a name:* key and its escaped value into either route', () => {
      const tag = resolved({ tag_key: 'name:en', tag_value: "St. Mark's" });
      expect(nameSearchHint(tag, within(AREA_BOUNDS.seattle))).toBe(
        rawRoute(
          'name:en',
          '[out:json][timeout:25];rel(237385);map_to_area->.a;nwr["name:en"~"St\\\\. Mark\'s",i](area.a);out center tags;',
        ),
      );
      expect(nameSearchHint(tag, within(AREA_BOUNDS.washington))).toBe(
        searchRoute(
          'name:en',
          '{"query":"St. Mark\'s","viewbox":{"west":-124.8361,"south":45.5437,"east":-116.9159,"north":49.0025},"bounded":true}',
        ),
      );
    });
  });

  /**
   * The raw route escapes the value's POSIX ERE specials with the list-item match's own
   * definition (tabled at the service seam, normalize-elements.test.ts), each as `\\` plus the
   * character; the search route carries the value as sent.
   */
  describe('ERE specials in the value', () => {
    it.each([
      { value: "St. Mark's", escaped: "St\\\\. Mark's" },
      {
        value: 'a.b^c$d*e+f?g{2}h|i',
        escaped: 'a\\\\.b\\\\^c\\\\$d\\\\*e\\\\+f\\\\?g\\\\{2}h\\\\|i',
      },
    ])('escapes $value in the raw route only', ({ value, escaped }) => {
      const box = { south: 47.58, west: -122.36, north: 47.63, east: -122.29 };
      expect(nameSearchHint(resolved({ tag_key: 'name', tag_value: value }), { box })).toBe(
        bothRoutes(
          'name',
          `{"query":${JSON.stringify(value)},"viewbox":{"west":-122.36,"south":47.58,"east":-122.29,"north":47.63},"bounded":true}`,
          `[out:json][timeout:25];nwr["name"~"${escaped}",i](47.58,-122.36,47.63,-122.29);out center tags;`,
        ),
      );
    });
  });
});

/**
 * The tag inputs carry no schema length limit, so a caller-sized key and value reach the hint's
 * line-break check, the ERE escape, and the JSON serialization whole. Measured in this thread's
 * CPU time, never wall clock: each size is timed beside a fresh baseline, a batch of calls per
 * measurement, and the least growth across the pairs is held under 4× linear — 256 across the
 * digit run's 64× span — with an absolute ceiling of 1 µs per character. The input doubles,
 * checked at each size before the next runs. The renderer's code span over a route line is timed
 * at its own seam (openstreetmap-markdown-escape.test.ts).
 */
describe('nameSearchHint cost', () => {
  const BASE_CHARS = 5_000;
  /** Text one measurement spends, so a small input is timed over a batch of calls. */
  const BATCH_CHARS = 160_000;
  const PAIRS = 5;

  function cpuMicrosPerCall(tag: { tagKey: string; tagValue: string }, chars: number): number {
    const calls = Math.max(1, Math.round(BATCH_CHARS / chars));
    const start = process.threadCpuUsage();
    for (let call = 0; call < calls; call++) nameSearchHint(tag, DICKS);
    const spent = process.threadCpuUsage(start);
    return (spent.user + spent.system) / calls;
  }

  /**
   * Shapes stop at 80k characters, below Bun's regex slow-mode switch; the digit run reaches no
   * regex that switches, so it carries the full span.
   */
  it.each([
    {
      shape: "'§1 x' runs ending '\\ny'",
      make: (n: number) => ({ tagKey: 'name', tagValue: `${'§1 x'.repeat(n / 4)}\ny` }),
      maxChars: 80_000,
    },
    {
      shape: "'  \\r\\n' runs",
      make: (n: number) => ({ tagKey: 'name', tagValue: '  \r\n'.repeat(n / 4) }),
      maxChars: 80_000,
    },
    {
      shape: "'§1 x' runs with no break",
      make: (n: number) => ({ tagKey: 'name', tagValue: '§1 x'.repeat(n / 4) }),
      maxChars: 80_000,
    },
    {
      shape: 'a run of ERE specials',
      make: (n: number) => ({ tagKey: 'name', tagValue: '.^$*+?{|'.repeat(n / 8) }),
      maxChars: 80_000,
    },
    {
      shape: 'a long name:* key',
      make: (n: number) => ({ tagKey: `name:${'k'.repeat(n)}`, tagValue: 'x' }),
      maxChars: 80_000,
    },
    {
      shape: 'a digit run',
      make: (n: number) => ({ tagKey: 'name', tagValue: '1'.repeat(n) }),
      maxChars: 320_000,
    },
  ])(
    'stays linear over $shape',
    ({ make, maxChars }) => {
      const base = make(BASE_CHARS);
      cpuMicrosPerCall(base, BASE_CHARS);
      for (let chars = BASE_CHARS * 2; chars <= maxChars; chars *= 2) {
        const input = make(chars);
        let growth = Number.POSITIVE_INFINITY;
        let perCall = Number.POSITIVE_INFINITY;
        for (let pair = 0; pair < PAIRS; pair++) {
          const baseline = cpuMicrosPerCall(base, BASE_CHARS);
          const spent = cpuMicrosPerCall(input, chars);
          perCall = Math.min(perCall, spent);
          growth = Math.min(growth, spent / baseline);
        }
        expect(growth, `${chars} characters`).toBeLessThan(4 * (chars / BASE_CHARS));
        expect(perCall, `${chars} characters, µs per call`).toBeLessThan(chars);
      }
    },
    0,
  );
});
