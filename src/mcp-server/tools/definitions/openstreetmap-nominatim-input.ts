/**
 * @fileoverview Input validators for parameters Nominatim refuses with HTTP 400 or
 *   silently discards, and the one output field the Nominatim-backed tool definitions
 *   share word for word.
 * @module mcp-server/tools/definitions/openstreetmap-nominatim-input
 */

import { z } from '@cyanheads/mcp-ts-core';

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
export const anyCasing = (word: string) =>
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
 * What a rejected `layer` value is told, in place of Zod's default — the pattern source, which
 * spells each name as per-letter classes and so never names one (#133). Like the other
 * messages here, it reaches the caller as the `invalid_arguments` hint and stays out of the
 * advertised `inputSchema`, which carries the pattern alone.
 */
export const NOMINATIM_LAYER_MESSAGE = `Expected one or more of ${NOMINATIM_LAYER_VALUES}, comma-separated, in any casing.`;

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

/** What a rejected `exclude_place_ids` token is told (#133). */
export const NOMINATIM_EXCLUDE_ID_MESSAGE =
  'Expected an OSM ref — N, W, or R plus the object id ("R237385") — or a bare Nominatim place_id ("325649065"); paths and URLs are not accepted here.';

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

/** What a rejected `countrycodes` value is told (#133). */
export const NOMINATIM_COUNTRYCODE_MESSAGE =
  'Expected ISO 3166-1 alpha-2 country codes in any casing, comma-separated ("us,ca") — not an alpha-3 code ("usa"), a country name, or a semicolon list.';

/**
 * A `language` value that selects the names it asks for (#134): `*` or a language tag per
 * comma-separated part, each with an optional `;q=` weight.
 *
 * Nominatim reads a part only when it is letters, `_`, and `-` with a weight written as
 * `;q=` plus 0 or 1 and optional decimals, and silently drops any other part, answering HTTP 200
 * in the local language with nothing saying the preference was lost. So a value that carries
 * no tag — a language name, a malformed token — is rejected here, and so is a list holding one
 * beside a readable part: the dropped part changes the answer whenever an object lacks a name in
 * the part before it. `*` is the one part accepted although Nominatim drops it: the wildcard
 * asks for any language, which is the local name Nominatim falls back to, and a browser-style
 * list (`en-US,en;q=0.9,*;q=0.5`) carries one.
 *
 * A tag is a two- or three-letter primary subtag in any casing, then lowercase `_` suffixes
 * (`ja_rm`, the OSM convention for romanized names), then `-` subtags. An uppercase primary, a
 * lowercase script (`sr-latn`), and a digit-bearing subtag (`es-419`) are accepted because the
 * service rewrites each into the spelling Nominatim reads before sending
 * (`toNominatimLanguage`). A `-` subtag may be empty or hold a `_` (`en-`, `en--us`, `en-US_x`):
 * Nominatim answers a tag it has no name for from the part before the first `-`, so whatever
 * follows that `-` leaves the answer alone. The suffixes come before the subtags, and a `-`
 * subtag's own characters exclude `-`, so a value splits into parts one way and matching stays
 * linear. Whitespace, empty parts, and a blank value are tolerated, as `countrycodes` tolerates
 * them; the handler drops a blank.
 */
const NOMINATIM_LANGUAGE_PATTERN = (() => {
  const part = String.raw`(?:\*|[A-Za-z]{2,3}(?:_[a-z]+)*(?:-[A-Za-z0-9_]*)*)(?:;\s*[qQ]\s*=\s*[01](?:\.\d+)?)?\s*`;
  return new RegExp(String.raw`^\s*(?:${part})?(?:,\s*(?:${part})?)*$`);
})();

/** What a rejected `language` value is told (#134). */
const NOMINATIM_LANGUAGE_MESSAGE =
  'Expected a language tag with a two- or three-letter primary subtag ("en", "zh-Hant", "ja_rm"), or a comma-separated list of them, each optionally weighted ("fr;q=0.8"); a language name ("English") is not one.';

/**
 * The `language` input the three Nominatim tools share. The empty-string variant keeps a form
 * client's untouched field a no-op; each handler drops a blank before the request is built.
 */
export const nominatimLanguageInput = z
  .union([
    z.literal(''),
    z
      .string()
      .regex(NOMINATIM_LANGUAGE_PATTERN, { error: NOMINATIM_LANGUAGE_MESSAGE })
      .describe(
        'A tag ("en", "zh-Hant") or a comma-separated, optionally weighted list ("fr,en;q=0.8").',
      ),
  ])
  .optional()
  .describe('Language for names. Default: the local OSM language.');

/**
 * The `addresstype` output field the three Nominatim tools share, held once so its text
 * cannot drift between them.
 */
export const nominatimAddressTypeOutput = z
  .string()
  .optional()
  .describe(
    "Nominatim's address label: an administrative boundary's level (e.g. state, county, city); otherwise usually repeats type or category.",
  );

/**
 * The `addresstype` entry of one result: Nominatim's label when it sent a non-empty string, no
 * key otherwise. The upstream body reaches the handlers unvalidated, so a label of any other
 * type is left out here rather than failing the whole call on the output schema.
 */
export const nominatimAddressTypeEntry = (label: unknown): { addresstype?: string } =>
  typeof label === 'string' && label !== '' ? { addresstype: label } : {};
