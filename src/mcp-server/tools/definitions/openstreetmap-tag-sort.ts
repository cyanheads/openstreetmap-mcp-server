/**
 * @fileoverview The `sort_by` ranking on openstreetmap_query_bbox (#127): the whole match set
 * ordered by a tag's numeric value before `offset` and `limit` cut the page. Overpass prints a
 * set by type, then id, and can sort by nothing else, so the ranking happens here.
 * @module mcp-server/tools/definitions/openstreetmap-tag-sort
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * A value that ranks: the whole trimmed value is a plain decimal. Units, commas, ranges,
 * lists, and approximations stay unranked rather than converted — OSM's default unit differs
 * by key, and a comma or dot can mean a decimal or a thousands separator.
 */
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/** The `sort_by` input. Closed, so a misspelled `order` is rejected rather than dropped. */
export const sortByInput = z
  .object({
    key: z
      .string()
      .describe('Tag whose numeric value ranks the features, e.g. "ele", "population".'),
    order: z.enum(['desc', 'asc']).default('desc').describe('"desc" puts the largest value first.'),
  })
  .strict()
  .optional()
  .describe(
    "Rank the whole match set by a tag's numeric value before offset and limit apply. A value ranks when it is a plain decimal such as 4392 or -12.5; one with a unit, comma, range, or list (8280ft, 2,5, 100-200, 849;871) is not converted. Those and features lacking the tag follow the ranked ones in default order, counted in unrankedCount. A blank key means no sort.",
  );

/** The `unrankedCount` enrichment field; its presence also says the page is ranked. */
export const unrankedCountField = z
  .number()
  .optional()
  .describe(
    'Features whose sort_by tag was missing or not a plain decimal; they follow the ranked ones in default order. Present whenever sort_by applies.',
  );

/** A sort as a call applies it. */
export type TagSort = { key: string; order: 'desc' | 'asc' };

/** `sort_by` as applied: the key trimmed, and no sort when it is absent or its key is blank. */
export function resolveTagSort(requested: TagSort | undefined): TagSort | undefined {
  const key = requested?.key.trim();
  return requested && key ? { key, order: requested.order } : undefined;
}

/**
 * `features` ranked by the numeric value of `sort.key`, then every feature whose value is
 * missing or not a plain decimal, in the order given. A stable sort, so ties keep that order
 * too. Returns a new array and leaves `features` as it was: pages served from one cached set
 * have to see the same ranking.
 */
export function rankByTag<T extends { tags: Record<string, string> }>(
  features: readonly T[],
  sort: TagSort,
): { ranked: T[]; unrankedCount: number } {
  const valued: { feature: T; value: number }[] = [];
  const unranked: T[] = [];
  for (const feature of features) {
    const raw = Object.hasOwn(feature.tags, sort.key) ? feature.tags[sort.key]?.trim() : undefined;
    if (raw !== undefined && PLAIN_DECIMAL.test(raw)) valued.push({ feature, value: Number(raw) });
    else unranked.push(feature);
  }
  const sign = sort.order === 'desc' ? -1 : 1;
  valued.sort((a, b) => sign * (a.value - b.value));
  return {
    ranked: [...valued.map(({ feature }) => feature), ...unranked],
    unrankedCount: unranked.length,
  };
}
