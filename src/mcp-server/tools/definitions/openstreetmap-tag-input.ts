/**
 * @fileoverview Shared tag input validation and resolution for Overpass convenience tools.
 * @module mcp-server/tools/definitions/openstreetmap-tag-input
 */

/** Resolved tag key/value pair extracted from amenity shortcut or explicit tag_key/tag_value. */
export type ResolvedTag = { tagKey: string; tagValue: string };

/** Why a tag input was rejected: mutual-exclusivity, missing pair, or disallowed characters. */
export type TagInputError = 'both' | 'neither' | 'invalid_chars';

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
 * Validate and resolve the mutually-exclusive amenity / tag_key+tag_value input pattern.
 * Returns a resolved key/value, or an error variant callers translate to `ctx.fail('invalid_tag')`.
 * Values are trimmed on resolution, not just for the presence check: Overpass matches tag values
 * exactly, so a padded value interpolated into `["key"="value"]` matches nothing while looking
 * like a geographic miss. Trimming runs before the metacharacter check, so a value that is only
 * whitespace around a metacharacter is still rejected.
 * The metacharacter check runs on the RESOLVED key/value, so it covers the amenity shortcut
 * (which funnels into tagValue here) as well as explicit tag_key/tag_value.
 */
export function resolveTagInput(input: {
  amenity?: string | undefined;
  tag_key?: string | undefined;
  tag_value?: string | undefined;
}): ResolvedTag | { error: TagInputError } {
  const hasAmenity = Boolean(input.amenity?.trim());
  const hasTagKey = Boolean(input.tag_key?.trim());
  const hasTagValue = Boolean(input.tag_value?.trim());

  if (hasAmenity && (hasTagKey || hasTagValue)) return { error: 'both' };
  if (!hasAmenity && (!hasTagKey || !hasTagValue)) return { error: 'neither' };

  const tagKey = hasAmenity ? 'amenity' : (input.tag_key ?? '').trim();
  const tagValue = (hasAmenity ? (input.amenity ?? '') : (input.tag_value ?? '')).trim();

  if (TAG_METACHAR_PATTERN.test(tagKey) || TAG_METACHAR_PATTERN.test(tagValue)) {
    return { error: 'invalid_chars' };
  }

  return { tagKey, tagValue };
}

/** Human-readable message for each resolveTagInput error variant, shared by both convenience tools. */
export function invalidTagMessage(error: TagInputError): string {
  switch (error) {
    case 'both':
      return 'Cannot combine amenity with tag_key/tag_value.';
    case 'neither':
      return 'Provide either amenity or both tag_key and tag_value (both are required).';
    case 'invalid_chars':
      return 'Tag key or value contains disallowed Overpass QL metacharacters (" \\ [ ] ; ( )).';
  }
}
