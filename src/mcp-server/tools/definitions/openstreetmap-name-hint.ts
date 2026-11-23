/**
 * @fileoverview The name-search hint an exact-name filter that matched nothing adds to `notice`
 * on openstreetmap_query_nearby and openstreetmap_query_bbox (#136). OSM names carry branch
 * suffixes, punctuation, and their own casing, so `name=Dick's Drive-In` misses
 * `Dick's Drive-In - Queen Anne`; the hint prints a name search over the same scope as calls
 * that run as printed: openstreetmap_search_places arguments, and an openstreetmap_query_raw
 * query matching the value case-insensitively anywhere in the name. A boundary too large for
 * that query to run is searched over its bounding box instead (#143).
 * @module mcp-server/tools/definitions/openstreetmap-name-hint
 */

import { qlRegexLiteral } from '@/services/overpass/overpass-ql.js';
import type {
  OverpassAreaRef,
  OverpassBounds,
  OverpassTagFilter,
} from '@/services/overpass/types.js';
import type { ResolvedTag } from './openstreetmap-tag-input.js';

type Box = { south: number; west: number; north: number; east: number };
type Radius = { lat: number; lon: number; radiusMeters: number };

/**
 * Where the call searched: four corners as given, a radius around a point, or a boundary with
 * the bounding box its query printed, when it printed one (#143).
 */
export type NameHintScope =
  | { box: Box }
  | Radius
  | { areaRef: OverpassAreaRef; bounds?: OverpassBounds };

/** Meters per degree of arc on the 6,371 km sphere, the figure a radius's box is drawn with. */
const METERS_PER_DEGREE = 111_195;

/** No route line can carry a line break: each must stand on a line of its own. */
const LINE_BREAK = /[\r\n]/;

/** An exact match on `name` or a `name:*` key whose key and value fit on one line. */
function isExactName(tag: OverpassTagFilter): tag is OverpassTagFilter & { tagValue: string } {
  return (
    tag.tagValue !== undefined &&
    tag.match !== 'list_item' &&
    (tag.tagKey === 'name' || tag.tagKey.startsWith('name:')) &&
    !LINE_BREAK.test(tag.tagKey) &&
    !LINE_BREAK.test(tag.tagValue)
  );
}

/**
 * The first exact `name` / `name:*` entry in the chain, the one {@link nameSearchHint} names, else
 * `undefined`. openstreetmap_query_bbox asks for a boundary's bounds exactly when there is one.
 */
export function exactNameEntry(
  resolved: ResolvedTag,
): (OverpassTagFilter & { tagValue: string }) | undefined {
  return [resolved, ...(resolved.filters ?? [])].find(isExactName);
}

const floor4 = (deg: number) => Math.floor(deg * 1e4) / 1e4;
const ceil4 = (deg: number) => Math.ceil(deg * 1e4) / 1e4;

/**
 * The box holding a radius: latitude ± r / 111,195 m and longitude ± r / (111,195 m × cos lat),
 * rounded outward to 4 decimals, latitude clamped at ±90°. A band that reaches a pole holds every
 * meridian, so it spans every longitude; one that stops short never does, its half width staying
 * under 90° for any radius the tools admit. An edge past ±180° wraps, leaving west > east: a box
 * that crosses the antimeridian, as Overpass reads it.
 */
function radiusBox({ lat, lon, radiusMeters }: Radius): Box {
  const halfHeight = radiusMeters / METERS_PER_DEGREE;
  const south = Math.max(-90, floor4(lat - halfHeight));
  const north = Math.min(90, ceil4(lat + halfHeight));
  if (south === -90 || north === 90) return { south, west: -180, north, east: 180 };
  const halfWidth = halfHeight / Math.cos((lat * Math.PI) / 180);
  const west = lon - halfWidth;
  const east = lon + halfWidth;
  return {
    south,
    west: floor4(west < -180 ? west + 360 : west),
    north,
    east: ceil4(east > 180 ? east - 360 : east),
  };
}

/**
 * Square degrees (height × width) under which Overpass reads a box before it applies the tag
 * filter: `Bbox_Constraint::delivers_data` in its source tests
 * `(north - south) * abs(east - west) < 1.0`. At or over that the filter runs first, and a regex
 * over every `name` in the database runs out the timeout however little the box holds, as a
 * 2 km radius at the pole did (0.036° × 360°).
 */
const RAW_ROUTE_BOX_LIMIT_SQ_DEG = 1;

/**
 * The most index blocks a `map_to_area` area can use and still be read before the tag filter:
 * `Area_Constraint::delivers_data` in Overpass's source sums the blocks the input areas use and
 * prefers their ranges at 12 or fewer. Past that the filter runs first, and a regex over every
 * `name` in the database runs out the timeout, as the raw query inside Washington state did.
 */
const AREA_BLOCK_LIMIT = 12;

/** Overpass's integer coordinate unit, 1e-7°, and the side of an index block in those units. */
const UNITS_PER_DEGREE = 1e7;
const BLOCK_UNITS = 2 ** 20;

/**
 * Overpass index blocks the bounds cover, each 2²⁰ of its 1e-7° units (0.1048576°) on a side: block
 * rows `⌊(lat + 91) × 10⁷ / 2²⁰⌋` from `minlat` to `maxlat` times block columns `⌊lon × 10⁷ / 2²⁰⌋`
 * from `minlon` to `maxlon`, inclusive, each side of the antimeridian counted on its own when
 * `minlon` is greater than `maxlon`. A coordinate is rounded to the 1e-7° grid first, as Overpass
 * stores it. An area uses no block outside its bounds, so this is the most it can use. Exported for
 * unit testing.
 */
export function areaIndexBlocks({ minlat, minlon, maxlat, maxlon }: OverpassBounds): number {
  const block = (units: number) => Math.floor(Math.round(units) / BLOCK_UNITS);
  const row = (lat: number) => block((lat + 91) * UNITS_PER_DEGREE);
  const col = (lon: number) => block(lon * UNITS_PER_DEGREE);
  const span = (west: number, east: number) => col(east) - col(west) + 1;
  const cols = minlon > maxlon ? span(minlon, 180) + span(-180, maxlon) : span(minlon, maxlon);
  return (row(maxlat) - row(minlat) + 1) * cols;
}

/**
 * The hint for the first exact `name` / `name:*` entry in the chain, else `undefined`: a sentence,
 * then each route on a line of its own, which the notice renderer prints as one code span. The
 * search route carries the value as sent; the raw route escapes its ERE specials as the list-item
 * match does. A box that crosses the antimeridian or has zero width, which Nominatim's viewbox
 * cannot carry, gets the raw route alone. Overpass measures a box whose west is greater than its
 * east by the distance between the two, nearly 360°, so a crossing box is searched as one box per
 * side of the antimeridian. A box at or past {@link RAW_ROUTE_BOX_LIMIT_SQ_DEG} gets the search
 * route alone, and a crossing box with a side that large gets no hint: neither route would run.
 *
 * A boundary gets the raw route alone, scoped to its area, while its bounds cover at most
 * {@link AREA_BLOCK_LIMIT} index blocks, or when its query printed no bounds (#143). Past that it
 * gets the search route alone over its bounds rounded outward, and none for bounds that cross the
 * antimeridian. The tag validator has already rejected `"` and `\`, so the value cannot close the
 * QL string it is printed in.
 */
export function nameSearchHint(resolved: ResolvedTag, scope: NameHintScope): string | undefined {
  const entry = exactNameEntry(resolved);
  if (!entry) return;
  const { tagKey, tagValue } = entry;
  const filter = `nwr["${tagKey}"~"${qlRegexLiteral(tagValue)}",i]`;
  const lead = `Exact equality on ${tagKey} compares the whole value, case-sensitively.`;
  const rawOnly = (scoped: string) =>
    `${lead} Match the value anywhere in ${tagKey}, in any case, with openstreetmap_query_raw and this query:\n[out:json][timeout:25];${scoped}out center tags;`;
  const searchArgs = ({ west, south, east, north }: Box) =>
    JSON.stringify({ query: tagValue, viewbox: { west, south, east, north }, bounded: true });
  const searchOnly = (viewbox: Box) =>
    `${lead} Search by name with openstreetmap_search_places and these arguments:\n${searchArgs(viewbox)}`;
  if ('areaRef' in scope) {
    const { areaRef, bounds } = scope;
    if (!bounds || areaIndexBlocks(bounds) <= AREA_BLOCK_LIMIT) {
      return rawOnly(
        `${areaRef.kind === 'relation' ? 'rel' : 'way'}(${areaRef.osmId});map_to_area->.a;${filter}(area.a);`,
      );
    }
    if (bounds.minlon > bounds.maxlon) return;
    return searchOnly({
      west: floor4(bounds.minlon),
      south: floor4(bounds.minlat),
      east: ceil4(bounds.maxlon),
      north: ceil4(bounds.maxlat),
    });
  }
  const box = 'box' in scope ? scope.box : radiusBox(scope);
  const { west, south, east, north } = box;
  const sides =
    west > east
      ? [
          { west, east: 180 },
          { west: -180, east },
        ]
      : [{ west, east }];
  const rawRuns = sides.every(
    (side) => (north - south) * (side.east - side.west) < RAW_ROUTE_BOX_LIMIT_SQ_DEG,
  );
  const boxes = sides.map((side) => `${filter}(${south},${side.west},${north},${side.east});`);
  const scoped = boxes.length > 1 ? `(${boxes.join('')});` : boxes.join('');
  if (!(west < east && south < north)) return rawRuns ? rawOnly(scoped) : undefined;
  return rawRuns
    ? `${lead} Search by name with openstreetmap_search_places and these arguments, or match the value anywhere in ${tagKey}, in any case, with openstreetmap_query_raw and this query:\n${searchArgs(box)}\n[out:json][timeout:25];${scoped}out center tags;`
    : searchOnly(box);
}
