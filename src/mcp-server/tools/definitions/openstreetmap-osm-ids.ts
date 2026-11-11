/**
 * @fileoverview OSM object refs: the forms `openstreetmap_lookup_objects` (`osm_ids`) and
 * `openstreetmap_query_bbox` (`within`) accept, one parser that reduces each to its canonical
 * N/W/R ref, and the Overpass QL that checks which refs exist. `openstreetmap_lookup_objects`
 * answers from Nominatim, which indexes places and addresses rather than every OSM object, so
 * an existence question goes to `openstreetmap_query_raw` with the query built here.
 * @module mcp-server/tools/definitions/openstreetmap-osm-ids
 */

import { anyCasing } from './openstreetmap-nominatim-input.js';

/** The OSM object type each canonical prefix letter names, as the website spells it. */
const TYPE_WORDS = { N: 'node', W: 'way', R: 'relation' } as const;

type OsmPrefix = keyof typeof TYPE_WORDS;

/**
 * One ref of a type among `prefixes`, surrounding whitespace allowed (`\s` matches exactly the
 * code points `String#trim` strips), in one of three forms:
 *
 * - the prefix letter in either case plus the id: `N240109189`, `r0237385`;
 * - the type word in any casing, `/`, and the id, optionally after a `/`: `node/240109189`,
 *   `/relation/237385`;
 * - that path on `www.openstreetmap.org`, `openstreetmap.org`, or `osm.org`, after `https://`,
 *   `http://`, or no scheme, with any tail opened by `/`, `?`, or `#`:
 *   `https://www.openstreetmap.org/node/240109189/history`.
 *
 * The host is pinned rather than inferred from the path: other sites running the OSM website
 * software keep their own id spaces, so their `/node/<id>` names a different object. Short links
 * (`/go/…?node=`), legacy `/?node=` and `/browse/` URLs, and API URLs are not accepted.
 *
 * The RegExp is advertised verbatim as a JSON-Schema `pattern`, so it uses plain capture groups
 * and no lookbehind, named groups, or inline flags, which other validators' dialects reject.
 * Groups 1–2 are the short form's letter and digits, 3–4 the path form's type word and digits.
 */
function refPattern(prefixes: readonly OsmPrefix[]): RegExp {
  const letters = `${prefixes.join('')}${prefixes.join('').toLowerCase()}`;
  const words = prefixes.map((prefix) => anyCasing(TYPE_WORDS[prefix])).join('|');
  const site = '(?:(?:https?://)?(?:(?:www\\.)?openstreetmap|osm)\\.org/|/)?';
  return new RegExp(`^\\s*(?:([${letters}])(\\d+)|${site}(${words})/(\\d+)(?:[/?#]\\S*)?)\\s*$`);
}

/** A node, way, or relation ref in any accepted form: what `osm_ids` takes. */
export const OSM_REF_PATTERN = refPattern(['N', 'W', 'R']);

/** A way or relation ref in any accepted form: what `within` takes, a node never being an area. */
export const AREA_REF_PATTERN = refPattern(['W', 'R']);

/** The largest id an OSM object can carry (2^63 − 1). Nominatim answers HTTP 500 past it. */
export const MAX_OSM_ID = '9223372036854775807';

/** One ref as parsed: its canonical form, or why it has none. */
export type OsmRefParse =
  | { kind: 'ref'; ref: string }
  | { kind: 'malformed' }
  | { kind: 'out_of_range' };

/**
 * Parse one ref against {@link OSM_REF_PATTERN} or {@link AREA_REF_PATTERN} into its canonical
 * form: the prefix letter uppercased and the id's leading zeros dropped, so `" n0240109189 "`,
 * `node/240109189`, and its URL all read `N240109189`. The id stays a digit string throughout,
 * compared against {@link MAX_OSM_ID} by length and then digit by digit, so an id past 2^53 keeps
 * every digit and one past the 64-bit range is refused before any request is built.
 */
export function parseOsmRef(raw: string, pattern: RegExp): OsmRefParse {
  const match = pattern.exec(raw);
  if (!match) return { kind: 'malformed' };
  // One alternative matched, so its two groups (the prefix letter or the type word, then the
  // digits) join into `N0240109189` or `node240109189`, and the other two join as nothing.
  const typeAndId = match.slice(1).join('');
  const letter = typeAndId.charAt(0).toUpperCase();
  const id = typeAndId.replace(/^\D+0*/, '') || '0';
  const outOfRange =
    id.length > MAX_OSM_ID.length || (id.length === MAX_OSM_ID.length && id > MAX_OSM_ID);
  return outOfRange ? { kind: 'out_of_range' } : { kind: 'ref', ref: `${letter}${id}` };
}

/** Overpass QL statement keyword per prefix, in the order the groups are emitted. */
const GROUPS = [
  ['N', 'node'],
  ['W', 'way'],
  ['R', 'rel'],
] as const;

/**
 * The `openstreetmap_query_raw` query that returns whichever of `refs` exist: one `id:`
 * group per type present, node then way then rel, ids in the order given. `out tags;`
 * returns an untagged object too, as type and id alone, so an id missing from its result
 * is not in OpenStreetMap. Expects canonical refs.
 */
export function existenceCheckQuery(refs: readonly string[]): string {
  const groups = GROUPS.flatMap(([prefix, keyword]) => {
    const ids = refs.filter((ref) => ref.startsWith(prefix)).map((ref) => ref.slice(1));
    return ids.length > 0 ? [`${keyword}(id:${ids.join(',')});`] : [];
  });
  return `[out:json];(${groups.join('')});out tags;`;
}
