/**
 * @fileoverview The `tag_keys` projection shared by openstreetmap_query_nearby and
 * openstreetmap_query_bbox (#125): each returned feature's tags cut to the keys the caller
 * lists, as the handler's last step, so matching, ranking, paging, and the cache all read the
 * full tag set.
 * @module mcp-server/tools/definitions/openstreetmap-tag-keys
 */

import { z } from '@cyanheads/mcp-ts-core';

/** The `tag_keys` input. No floor: `[]` reads as omitted, as `filters: []` does. */
export const tagKeysInput = z
  .array(z.string())
  .max(50)
  .optional()
  .describe(
    "Return only these tag keys in each feature's tags, matched exactly; list name:en to get it, no wildcards. Shrinks responses on heavily tagged features such as boundary relations. Matching, ranking, and paging still read every tag. Omitted or [] returns the full tag set.",
  );

/**
 * The `effectiveTagKeys` enrichment field. It says the page was cut, so a tag missing from a
 * projected feature is not read as missing from OpenStreetMap.
 */
export const effectiveTagKeysField = z
  .string()
  .optional()
  .describe(
    "The keys each feature's tags were cut to by tag_keys, comma-separated; tags beyond them were left out, not missing from OpenStreetMap. Present only when tag_keys was set.",
  );

/**
 * The keys a call keeps: each trimmed, blanks dropped, a repeat kept once. Undefined when none
 * remain, which serves the full tag set — a form client's `[""]` reads as omitted.
 */
export function resolveTagKeys(requested: readonly string[] | undefined): string[] | undefined {
  const keys = [...new Set((requested ?? []).map((key) => key.trim()).filter(Boolean))];
  return keys.length > 0 ? keys : undefined;
}

/**
 * Each feature with its tags cut to `keys`, in the listed order, a key it lacks left out.
 * Builds new tag objects: the service hands each feature's tags out by reference, and
 * identical in-flight calls share one result (#89), so a cut made in place would reach a
 * caller that asked for every tag.
 */
export function projectTags<T extends { tags: Record<string, string> }>(
  features: readonly T[],
  keys: readonly string[],
): T[] {
  return features.map((feature) => ({
    ...feature,
    tags: Object.fromEntries(
      keys.flatMap((key) => {
        const value = Object.hasOwn(feature.tags, key) ? feature.tags[key] : undefined;
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  }));
}
