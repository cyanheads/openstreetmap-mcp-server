/**
 * @fileoverview The name-search hint an exact-name filter that matched nothing adds to `notice`
 * on openstreetmap_query_nearby and openstreetmap_query_bbox (#136). OSM names carry branch
 * suffixes, punctuation, and their own casing, so `name=Dick's Drive-In` misses
 * `Dick's Drive-In - Queen Anne`; the hint prints a name search over the same scope as calls
 * that run as printed: openstreetmap_search_places arguments, and an openstreetmap_query_raw
 * query matching the value case-insensitively anywhere in the name.
 * @module mcp-server/tools/definitions/openstreetmap-name-hint
 */

import { qlRegexLiteral } from '@/services/overpass/overpass-ql.js';
import type { OverpassAreaRef, OverpassTagFilter } from '@/services/overpass/types.js';
import type { ResolvedTag } from './openstreetmap-tag-input.js';

type Box = { south: number; west: number; north: number; east: number };
type Radius = { lat: number; lon: number; radiusMeters: number };

/** Where the call searched: four corners as given, a radius around a point, or a boundary. */
export type NameHintScope = { box: Box } | Radius | { areaRef: OverpassAreaRef };

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
 * The hint for the first exact `name` / `name:*` entry in the chain, else `undefined`: a sentence,
 * then each route on a line of its own, which the notice renderer prints as one code span. The
 * search route carries the value as sent; the raw route escapes its ERE specials as the list-item
 * match does. A scope Nominatim's viewbox cannot carry — a boundary, or a box that crosses the
 * antimeridian or has zero width — gets the raw route alone. Overpass measures a box whose west
 * is greater than its east by the distance between the two, nearly 360°, so a crossing box is
 * searched as one box per side of the antimeridian. A box at or past
 * {@link RAW_ROUTE_BOX_LIMIT_SQ_DEG} gets the search route alone, and a crossing box with a side
 * that large gets no hint: neither route would run. The tag validator has already rejected `"`
 * and `\`, so the value cannot close the QL string it is printed in.
 */
export function nameSearchHint(resolved: ResolvedTag, scope: NameHintScope): string | undefined {
  const entry = [resolved, ...(resolved.filters ?? [])].find(isExactName);
  if (!entry) return;
  const { tagKey, tagValue } = entry;
  const filter = `nwr["${tagKey}"~"${qlRegexLiteral(tagValue)}",i]`;
  const lead = `Exact equality on ${tagKey} compares the whole value, case-sensitively.`;
  const rawOnly = (scoped: string) =>
    `${lead} Match the value anywhere in ${tagKey}, in any case, with openstreetmap_query_raw and this query:\n[out:json][timeout:25];${scoped}out center tags;`;
  if ('areaRef' in scope) {
    const { kind, osmId } = scope.areaRef;
    return rawOnly(
      `${kind === 'relation' ? 'rel' : 'way'}(${osmId});map_to_area->.a;${filter}(area.a);`,
    );
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
  const search = JSON.stringify({
    query: tagValue,
    viewbox: { west, south, east, north },
    bounded: true,
  });
  return rawRuns
    ? `${lead} Search by name with openstreetmap_search_places and these arguments, or match the value anywhere in ${tagKey}, in any case, with openstreetmap_query_raw and this query:\n${search}\n[out:json][timeout:25];${scoped}out center tags;`
    : `${lead} Search by name with openstreetmap_search_places and these arguments:\n${search}`;
}
