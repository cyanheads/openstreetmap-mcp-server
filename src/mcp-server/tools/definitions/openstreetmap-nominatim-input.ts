/**
 * @fileoverview Input validators for parameters Nominatim refuses with HTTP 400 or
 *   silently discards, shared by the Nominatim-backed tool definitions.
 * @module mcp-server/tools/definitions/openstreetmap-nominatim-input
 */

/**
 * The data layers Nominatim documents for `/search` and `/reverse`. Anything else
 * is refused with `Parameter 'layer' must be a comma-separated list of: address,
 * poi, railway, natural, manmade`.
 */
export const NOMINATIM_LAYERS = ['address', 'poi', 'railway', 'natural', 'manmade'] as const;

/**
 * Spells a lowercase word so it matches in any casing, as a per-letter character
 * class. A JSON-Schema `pattern` carries no flags, so an `i` on the RegExp would
 * validate here and silently drop from the published `inputSchema` — the surface a
 * generator reads — leaving it stricter than the validator behind it.
 */
const anyCasing = (word: string) =>
  word.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);

/**
 * A comma-separated list drawn from {@link NOMINATIM_LAYERS}, in any casing.
 *
 * A list rather than a bare enum because Nominatim documents the parameter as one —
 * `openstreetmap_reverse_geocode` matches `address,poi` by default — so a
 * single-value enum would advertise less than the endpoint accepts. Zod emits the
 * pattern into the published `inputSchema`, which is the surface an argument
 * generator reads; prose in `.describe()` alone left the constraint discoverable
 * only through a live rejection.
 *
 * Whitespace around a comma and the casing of a layer name are both tolerated rather
 * than rejected: this validator exists to catch an undocumented layer *name*, and
 * Nominatim itself accepts `ADDRESS` and `address, poi` alike — refusing a spelling
 * that costs nothing to forward would reject input the endpoint honors.
 *
 * A blank value matches too, and the handler drops it before the request is built.
 * The layer list is what carries meaning; whitespace alone carries none, and the
 * field was a bare string that silently ignored it before this pattern existed.
 */
export const NOMINATIM_LAYER_PATTERN = (() => {
  const layer = `(?:${NOMINATIM_LAYERS.map(anyCasing).join('|')})`;
  return new RegExp(`^\\s*(?:${layer}(?:\\s*,\\s*${layer})*)?\\s*$`);
})();

/** Shared `.describe()` text for the `layer` parameter's accepted values. */
export const NOMINATIM_LAYER_VALUES = NOMINATIM_LAYERS.join(', ');

/**
 * One `exclude_place_ids` token: an OSM ref (`N`/`W`/`R` plus the object id) or a
 * bare Nominatim `place_id`.
 *
 * Both forms are what `openstreetmap_search_places` itself emits as
 * `nextExcludeIds` — the OSM ref when a result carries `osm_type`/`osm_id`, the
 * `place_id` otherwise — and both are accepted upstream. Anything else is refused
 * with `Invalid exclude ID: <token>`.
 *
 * Surrounding whitespace is tolerated because the handler trims each token before
 * forwarding it, and a blank token matches for the same reason `layer` accepts one:
 * it excludes nothing, and the handler drops it. Both fields pair this pattern with
 * an explicit `z.literal('')` variant — that is what puts the empty string in the
 * advertised schema as a `const`, where an argument generator reads it; an optional
 * group inside a `pattern` states the same thing where nothing looks.
 */
export const NOMINATIM_EXCLUDE_ID_PATTERN = /^\s*(?:[NWRnwr]\d+|\d+)?\s*$/;

/**
 * A comma-separated list of ISO 3166-1 alpha-2 country codes, in any casing.
 *
 * Unlike `layer` and `exclude_place_ids`, this one guards a failure that is silent
 * rather than loud: Nominatim discards a `countrycodes` token it cannot parse and
 * answers HTTP 200 with the search run unfiltered, so an alpha-3 code, a semicolon
 * list, or a country name widens the query to the whole world while the response
 * still echoes the filter as if it applied. There is no upstream rejection to remap
 * into an error reason — the published pattern is the only place the constraint can
 * be stated.
 *
 * Casing is spelled as `[A-Za-z]` rather than through `anyCasing`, which exists for a
 * fixed word. Whitespace around a comma and an empty list element are both
 * tolerated because Nominatim honors `us, ca`, `us,`, and `us,,ca` identically to
 * `us,ca` — a code beside a stray comma is still applied, not dropped. A blank value
 * matches for the same reason `layer` accepts one, and the handler drops it before
 * the request is built.
 *
 * A well-formed code for a country that does not exist (`xx`) is deliberately accepted:
 * Nominatim answers it with an empty array, which is a real, reportable empty match
 * rather than a dropped filter.
 */
export const NOMINATIM_COUNTRYCODE_PATTERN = /^\s*(?:[A-Za-z]{2}\s*)?(?:,\s*(?:[A-Za-z]{2}\s*)?)*$/;
