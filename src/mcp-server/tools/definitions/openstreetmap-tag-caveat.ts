/**
 * @fileoverview Shared runtime disclosure that OSM attribute tags decorate a Nominatim
 * result but never select one. `openstreetmap_search_places` carries it on every success;
 * `openstreetmap_reverse_geocode` and `openstreetmap_lookup_objects` carry it when the call
 * requested `extratags`.
 * @module mcp-server/tools/definitions/openstreetmap-tag-caveat
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * The caveat text the Nominatim-backed tools write on a success path.
 *
 * Worded so it holds for all three, which pick their objects by different means — name and
 * address relevance (search), coordinate proximity (reverse), an explicit ID list (lookup).
 * What they share is that no tag value steers the pick and `extratags` only reports what the
 * chosen objects carry, so that is what the shared text says; naming a mechanism here would
 * be wrong on the other two. It says *attribute* tag rather than tag: `layer` and
 * `featureType` narrow by tag-derived class on two of the three, so the broader claim would
 * be false.
 *
 * Deliberately terse. `openstreetmap_search_places` emits it on every response, and the
 * string lands twice — once in `structuredContent`, once in the `content[]` trailer — so
 * every character is paid for twice on every call. The three tool names are 77 of these
 * characters and are the actionable part; the rest is cut to the two facts that matter.
 */
export const TAG_SELECTION_CAVEAT =
  'Tag selection is Overpass-only: openstreetmap_query_nearby, openstreetmap_query_bbox, openstreetmap_query_raw. extratags reports only what the returned objects carry — an absent attribute tag describes them, not OpenStreetMap.';

/**
 * Body shared by both field descriptions below; each appends its own presence sentence,
 * because the emission condition differs per tool.
 */
const CAVEAT_DESCRIPTION =
  'Standing caveat: tag-based selection lives on the Overpass tools (openstreetmap_query_nearby, openstreetmap_query_bbox, openstreetmap_query_raw), never here. extratags decorates the returned objects rather than selecting them, so a missing tag is not evidence the tag is missing from OpenStreetMap.';

/**
 * The `tagSelectionCaveat` field for `openstreetmap_search_places`, which writes it on every
 * success path.
 *
 * That tool is the only one of the three taking a free-form query, so it is the only one a
 * caller can reach for expecting tag-based *selection* — and that caller has no reason to
 * have set `extratags`, which defaults to `false`. Gating the signal on `extratags` would
 * deliver it only to callers who already knew to ask for the tag map, roughly the inverse of
 * the population that needs it.
 *
 * Optional rather than required even though it is unconditional. The effective output is
 * parsed as `output.extend(enrichment)`, so a required field a refactor stops writing fails
 * the parse and returns `isError` for the whole call — too much blast radius for an advisory
 * string. Presence is held by tests instead.
 *
 * Never `notice`: `ctx.enrich.notice()` and `ctx.enrich.truncated({ guidance })` both write
 * that single key in `@cyanheads/mcp-ts-core` (last write wins), and this tool already writes
 * it from two branches. Sharing the key would drop one of the two messages on a page that is
 * both truncated and tag-relevant.
 */
export const tagSelectionCaveatOnEveryResponse = z
  .string()
  .optional()
  .describe(`${CAVEAT_DESCRIPTION} Present on every successful response.`);

/**
 * The `tagSelectionCaveat` field for `openstreetmap_reverse_geocode` and
 * `openstreetmap_lookup_objects`, which write it only when the call requested `extratags`.
 *
 * Neither tool takes a query, so no tag-selection mistake is available to their callers —
 * coordinates and explicit OSM IDs are what pick the objects. The one live hazard is reading
 * an absent tag as absent from OpenStreetMap, which requires having asked for the tag map. A
 * response carrying no tags has nothing for the caveat to qualify, and the string costs ~450
 * bytes across the two surfaces each time it fires.
 */
export const tagSelectionCaveatOnExtratags = z
  .string()
  .optional()
  .describe(`${CAVEAT_DESCRIPTION} Present when extratags was requested.`);
