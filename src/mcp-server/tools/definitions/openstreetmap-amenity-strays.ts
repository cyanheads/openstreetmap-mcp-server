/**
 * @fileoverview Values whose `amenity=<v>` is a stray of an established tag under another
 * key, and the notice hint naming that key, shared by openstreetmap_query_nearby and
 * openstreetmap_query_bbox.
 * @module mcp-server/tools/definitions/openstreetmap-amenity-strays
 */

import type { OverpassTagFilter } from '@/services/overpass/types.js';

/**
 * Same-value strays only: each entry is a value whose `amenity=<v>` holds under 0.15% of
 * `<key>=<v>` on taginfo, with `<key>=<v>` on at least 9,000 features. Museums are the
 * pattern — `tourism=museum` carries 111,484, `amenity=museum` 119 — so a museum survey
 * built on `amenity` comes back empty, or holding a few mistagged features, and reads as
 * "none here". Values renamed under the other key (`amenity=gym` →
 * `leisure=fitness_centre`) are out of scope: the hint names the same value under a new key.
 */
const STRAY_VALUES_BY_KEY: Readonly<Record<string, readonly string[]>> = {
  tourism: [
    'museum',
    'hotel',
    'hostel',
    'motel',
    'guest_house',
    'camp_site',
    'attraction',
    'viewpoint',
    'gallery',
    'artwork',
    'information',
    'picnic_site',
    'zoo',
    'theme_park',
  ],
  leisure: [
    'park',
    'playground',
    'garden',
    'pitch',
    'stadium',
    'sports_centre',
    'swimming_pool',
    'fitness_centre',
    'golf_course',
    'nature_reserve',
    'marina',
    'dog_park',
    'beach_resort',
  ],
  shop: ['supermarket', 'convenience', 'bakery', 'hairdresser', 'mall', 'department_store'],
  historic: ['castle', 'monument', 'memorial', 'ruins', 'archaeological_site'],
  natural: ['beach', 'peak'],
};

/** Stray amenity value → the key OpenStreetMap actually tags it under. */
export const AMENITY_STRAY_KEYS: ReadonlyMap<string, string> = new Map(
  Object.entries(STRAY_VALUES_BY_KEY).flatMap(([key, values]) =>
    values.map((value) => [value, key] as const),
  ),
);

/**
 * The retry hint for a primary tag that is `amenity=<v>` with `<v>` in the map, else
 * `undefined`. Reads key and value only, so a list-item match on the tag triggers it too.
 * Advisory: the query and its results are never changed, only the notice.
 */
export function amenityStrayHint({ tagKey, tagValue }: OverpassTagFilter): string | undefined {
  if (tagKey !== 'amenity' || tagValue === undefined) return;
  const key = AMENITY_STRAY_KEYS.get(tagValue);
  if (!key) return;
  return `In OpenStreetMap this category is tagged ${key}=${tagValue}, not amenity=${tagValue}; retry with tag_key "${key}" and tag_value "${tagValue}".`;
}
