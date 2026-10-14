/**
 * @fileoverview N/W/R-prefixed OSM ID refs: their canonical form, and the Overpass QL that
 * checks which of them exist. `openstreetmap_lookup_objects` answers from Nominatim, which
 * indexes places and addresses rather than every OSM object, so an existence question goes
 * to `openstreetmap_query_raw` with the query built here.
 * @module mcp-server/tools/definitions/openstreetmap-osm-ids
 */

/** An N/W/R prefix followed by digits, either case. Checked after trimming. */
export const OSM_ID_PATTERN = /^[NWRnwr]\d+$/;

/**
 * Canonical form of a ref that already passed {@link OSM_ID_PATTERN}: trimmed, prefix
 * uppercased, leading zeros stripped from the digits. Kept as a string operation — node
 * ids sit well inside 2^53 today, but nothing here needs the number.
 */
export function canonicalOsmId(ref: string): string {
  const trimmed = ref.trim();
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1).replace(/^0+(?=\d)/, '')}`;
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
