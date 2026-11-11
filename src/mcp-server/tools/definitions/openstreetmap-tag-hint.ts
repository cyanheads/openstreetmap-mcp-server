/**
 * @fileoverview The one retry hint a resolved tag chain adds to `notice` on
 * openstreetmap_query_nearby and openstreetmap_query_bbox: the conventional spelling when a
 * primary feature key or its value was sent capitalized or spaced (#124), or the key a stray
 * `amenity=<v>` belongs under (#84).
 * @module mcp-server/tools/definitions/openstreetmap-tag-hint
 */

import type { OverpassTagFilter } from '@/services/overpass/types.js';
import { amenityStrayHint } from './openstreetmap-amenity-strays.js';
import { describeTagChain, type ResolvedTag } from './openstreetmap-tag-input.js';

/**
 * The primary features of the OSM wiki's Map features page. Values under these keys are
 * lowercase with underscores — across the 999 most-used `amenity` and `shop` values on taginfo,
 * under 0.01% of uses carry an uppercase letter or a space — and Overpass matches tags exactly,
 * so `amenity=Hospital` matches nothing in a city full of `amenity=hospital`. An allowlist:
 * free-text keys (`name`, `brand`, `operator`, `ref`, `addr:*`) are case-sensitive, and
 * lowercasing `brand=Starbucks` turns its matches into none, so any key not known to follow
 * the convention draws no hint.
 */
export const PRIMARY_FEATURE_KEYS: ReadonlySet<string> = new Set([
  'aerialway',
  'aeroway',
  'amenity',
  'barrier',
  'boundary',
  'building',
  'craft',
  'emergency',
  'geological',
  'healthcare',
  'highway',
  'historic',
  'landuse',
  'leisure',
  'man_made',
  'military',
  'natural',
  'office',
  'place',
  'power',
  'public_transport',
  'railway',
  'route',
  'shop',
  'telecom',
  'tourism',
  'water',
  'waterway',
]);

/** Lowercase with each whitespace run as `_`; hyphens and other punctuation stay. */
function conventional(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '_');
}

/** The entry as OSM spells it when its key is a primary feature key, else as sent. */
function conventionalEntry(tag: OverpassTagFilter): OverpassTagFilter {
  const tagKey = conventional(tag.tagKey);
  if (!PRIMARY_FEATURE_KEYS.has(tagKey)) return tag;
  return {
    ...tag,
    tagKey,
    ...(tag.tagValue !== undefined ? { tagValue: conventional(tag.tagValue) } : {}),
  };
}

/**
 * The retry hint for the chain, else `undefined`. When respelling changes the chain, the hint
 * names the whole respelled chain in `effectiveTag` form, or — when the respelled primary tag
 * is a stray amenity — the stray's own key, so `amenity: "Museum"` takes one retry rather than
 * two; a respelled filter beside a stray primary is left to the next call's hint. A chain
 * already in convention gets the #84 hint or nothing. Advisory: the caller's spelling is what
 * the query matches and what `effectiveTag` echoes.
 */
export function tagRetryHint(resolved: ResolvedTag): string | undefined {
  const { filters, ...primary } = resolved;
  const spelledPrimary = conventionalEntry(primary);
  const spelled: ResolvedTag = {
    ...spelledPrimary,
    ...(filters ? { filters: filters.map(conventionalEntry) } : {}),
  };
  const chain = describeTagChain(spelled);
  // Respelling only ever replaces characters, so the chain reads the same only when unchanged.
  if (chain === describeTagChain(resolved)) return amenityStrayHint(resolved);
  return (
    amenityStrayHint(spelledPrimary, primary) ??
    `OpenStreetMap writes primary feature keys and their values in lowercase with underscores, and tags match exactly; retry with ${chain}.`
  );
}
