/**
 * @fileoverview Shared tag input validation and resolution for Overpass convenience tools.
 * @module mcp-server/tools/definitions/openstreetmap-tag-input
 */

import type { OverpassTagFilter } from '@/services/overpass/types.js';

/** Resolved primary tag and any additional filters, all ANDed in input order. */
export type ResolvedTag = OverpassTagFilter & { filters?: OverpassTagFilter[] };

/**
 * JSON-Schema fragment naming the two valid tag modes, attached to a tool's input
 * object with Zod's `.meta()`. Metadata keys pass through JSON-Schema conversion
 * verbatim, so this lands in the advertised `inputSchema` as a sibling of `type`,
 * `properties`, and `required` — the surface an argument generator reads.
 *
 * `anyOf` over required-sets rules out a call carrying no primary tag at all.
 * `tag_key` alone is a key-existence query. The fragment does NOT express
 * mutual exclusivity — `amenity` sent alongside `tag_key`/`tag_value` still satisfies the
 * first branch, and encoding that needs nested `not` subschemas that generators handle
 * poorly. Nothing here is enforced by Zod at call time either: `resolveTagInput` stays the
 * only enforcement point, and it is what rejects every case, `both` included.
 *
 * Each branch carries its own `type: 'object'` because Gemini rejects an anyOf branch
 * without one ("reference to undefined schema"); `lint:mcp` enforces it as schema-anyof-needs-type.
 *
 * Attach it to an input that already declares `.strict()`. `tool()` strictens a default-mode
 * input itself, and Zod's `.strict()` returns a fresh instance absent from the metadata
 * registry, so metadata attached first never reaches the advertised schema.
 */
const TAG_MODE_REQUIRED_SETS: readonly (readonly string[])[] = [['amenity'], ['tag_key']];

export const TAG_MODE_SCHEMA_META = {
  anyOf: TAG_MODE_REQUIRED_SETS.map((required) => ({ type: 'object', required: [...required] })),
};

/**
 * `TAG_MODE_SCHEMA_META` for a tool that carries a second mode dimension of its own —
 * openstreetmap_query_bbox's four corner fields versus its `within` boundary ref.
 *
 * Crosses the caller's required-sets with the tag modes rather than replacing them, so
 * every advertised branch names both a spatial scope and a primary tag and no combination
 * silently drops one. Same constraints as the constant above: every field stays in root
 * `properties`, each branch carries its own `type: 'object'`, and nothing here is enforced
 * by Zod — the handler's resolvers remain the only enforcement point.
 */
export function crossTagModes(scopeModes: readonly (readonly string[])[]): {
  anyOf: { type: string; required: string[] }[];
} {
  return {
    anyOf: scopeModes.flatMap((scope) =>
      TAG_MODE_REQUIRED_SETS.map((tag) => ({ type: 'object', required: [...scope, ...tag] })),
    ),
  };
}

/** Why the primary tag or an additional filter was rejected. */
export type TagInputError =
  | 'both'
  | 'neither'
  | 'blank'
  | 'duplicate_key'
  | 'invalid_chars'
  | 'list_item_without_value';

/** How a supplied value matches: the whole tag value, or one item of a semicolon list. */
export type TagMatchMode = 'exact' | 'list_item';

/**
 * Overpass QL structural metacharacters rejected in convenience-tool tag inputs.
 *
 * The convenience tools interpolate the resolved key/value into `["key"="value"]`.
 * `"` and `\` are the real injection vectors — a literal `"` closes the quoted string and
 * lets a crafted value inject a second filter, and `\` drives escape parsing. The remaining
 * structurals `[` `]` `;` `(` `)` are inert inside the quoted template, but a bare `][`
 * silently degrades the intended filter into a zero-result literal match, so rejecting the
 * whole structural set keeps these tools predictable. Legitimate OSM tag characters —
 * letters, digits, spaces, `:` `_` `-` `.` `/`, and unicode — all pass; openstreetmap_query_raw
 * is the escape hatch for arbitrary Overpass QL.
 */
const TAG_METACHAR_PATTERN = /["\\[\];()]/;

/**
 * Validate the mutually-exclusive amenity / tag_key modes and their additional filters.
 * Omitted values mean existence; explicit blanks are rejected. Duplicate trimmed keys
 * are rejected across the whole chain, including the primary tag.
 * Values are trimmed on resolution, not just for the presence check: Overpass matches tag values
 * exactly, so a padded value interpolated into `["key"="value"]` matches nothing while looking
 * like a geographic miss. Trimming runs before the metacharacter check, so a value that is only
 * whitespace around a metacharacter is still rejected.
 * The metacharacter check runs on the RESOLVED key/value, so it covers the amenity shortcut
 * (which funnels into tagValue here) as well as explicit tag_key/tag_value, in both match
 * modes — a list-item value is escaped for the regex later, but only after this check has
 * ruled out every character that could close the quoted string.
 *
 * A `list_item` mode lands on the resolved filter; `exact` is dropped, so an explicit exact
 * resolves to exactly what a legacy call did. A list-item match with no value — on key
 * existence, or on the amenity shortcut, which takes no mode — is rejected rather than
 * silently read as exact.
 */
export function resolveTagInput(input: {
  amenity?: string | undefined;
  tag_key?: string | undefined;
  tag_value?: string | undefined;
  tag_value_match?: TagMatchMode | undefined;
  filters?:
    | { key: string; value?: string | undefined; match?: TagMatchMode | undefined }[]
    | undefined;
}): ResolvedTag | { error: TagInputError } {
  const hasAmenity = Boolean(input.amenity?.trim());
  const hasTagKey = Boolean(input.tag_key?.trim());
  const hasTagValue = Boolean(input.tag_value?.trim());

  if (hasAmenity && (hasTagKey || hasTagValue)) return { error: 'both' };
  if (!hasAmenity && !hasTagKey) return { error: 'neither' };
  if (hasAmenity && input.tag_value_match === 'list_item') {
    return { error: 'list_item_without_value' };
  }

  const tagKey = hasAmenity ? 'amenity' : (input.tag_key ?? '').trim();
  const tagValue = (hasAmenity ? input.amenity : input.tag_value)?.trim();
  const primary = withMatch(
    { tagKey, ...(tagValue !== undefined ? { tagValue } : {}) },
    hasAmenity ? undefined : input.tag_value_match,
  );
  const filters = (input.filters ?? []).map(({ key, value, match }) =>
    withMatch(
      { tagKey: key.trim(), ...(value !== undefined ? { tagValue: value.trim() } : {}) },
      match,
    ),
  );

  const keys = new Set<string>();
  for (const tag of [primary, ...filters]) {
    if (!tag.tagKey || tag.tagValue === '') return { error: 'blank' };
    if (tag.match === 'list_item' && tag.tagValue === undefined) {
      return { error: 'list_item_without_value' };
    }
    if (
      TAG_METACHAR_PATTERN.test(tag.tagKey) ||
      (tag.tagValue !== undefined && TAG_METACHAR_PATTERN.test(tag.tagValue))
    ) {
      return { error: 'invalid_chars' };
    }
    if (keys.has(tag.tagKey)) return { error: 'duplicate_key' };
    keys.add(tag.tagKey);
  }

  return { ...primary, ...(filters.length ? { filters } : {}) };
}

/** Adds the mode to a resolved filter when it is `list_item`; `exact` stays implicit. */
function withMatch(tag: OverpassTagFilter, match: TagMatchMode | undefined): OverpassTagFilter {
  return match === 'list_item' ? { ...tag, match } : tag;
}

/**
 * The resolved chain as the caller-facing `effectiveTag` echo: `key=value` for equality,
 * `key∋value` for list-item membership, `key` alone for existence, in input order. Every
 * notice that names the filter is built from this string, so it describes the emitted QL.
 */
export function describeTagChain(resolved: ResolvedTag): string {
  return [resolved, ...(resolved.filters ?? [])]
    .map(({ tagKey, tagValue, match }) =>
      tagValue === undefined ? tagKey : `${tagKey}${match === 'list_item' ? '∋' : '='}${tagValue}`,
    )
    .join(', ');
}

/** Human-readable message for each resolveTagInput error variant, shared by both convenience tools. */
export function invalidTagMessage(error: TagInputError): string {
  switch (error) {
    case 'both':
      return 'Cannot combine amenity with tag_key/tag_value.';
    case 'neither':
      return 'Provide either amenity or tag_key; omit tag_value for a key-existence query.';
    case 'blank':
      return 'Tag keys and supplied values must not be blank; omit a value to require key existence.';
    case 'duplicate_key':
      return 'Each tag key must be unique across the primary tag and filters after trimming.';
    case 'invalid_chars':
      return 'Tag key or value contains disallowed Overpass QL metacharacters (" \\ [ ] ; ( )).';
    case 'list_item_without_value':
      return 'A list_item match needs a value to match: pair it with tag_value or a filter value. The amenity shortcut takes no match mode; use tag_key "amenity" with tag_value instead.';
  }
}
