/**
 * @fileoverview Unit tests for the amenity-stray map — values whose `amenity=<v>` is a
 * stray of an established `<key>=<v>` — and the hint it produces (#84).
 * @module tests/tools/openstreetmap-amenity-strays.test
 */

import { describe, expect, it } from 'vitest';
import {
  AMENITY_STRAY_KEYS,
  amenityStrayHint,
} from '@/mcp-server/tools/definitions/openstreetmap-amenity-strays.js';

/** The map as the issue pinned it, each entry checked on taginfo. */
const PINNED: Record<string, string[]> = {
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

describe('AMENITY_STRAY_KEYS', () => {
  /** A value mapped to two keys keeps only one entry in the map, so this fails on it too. */
  it('holds exactly the pinned value → key entries, no value under two keys', () => {
    const expected = Object.entries(PINNED).flatMap(([key, values]) =>
      values.map((value) => [value, key] as const),
    );
    expect([...AMENITY_STRAY_KEYS].sort()).toEqual([...expected].sort());
  });
});

describe('amenityStrayHint', () => {
  it.each(Object.entries(PINNED).flatMap(([key, values]) => values.map((value) => [value, key])))(
    'routes amenity=%s to %s',
    (value, key) => {
      expect(amenityStrayHint({ tagKey: 'amenity', tagValue: value })).toBe(
        `In OpenStreetMap this category is tagged ${key}=${value}, not amenity=${value}; retry with tag_key "${key}" and tag_value "${value}".`,
      );
    },
  );

  it('reads key and value only, so a list-item match on the tag triggers it too', () => {
    expect(amenityStrayHint({ tagKey: 'amenity', tagValue: 'park', match: 'list_item' })).toBe(
      'In OpenStreetMap this category is tagged leisure=park, not amenity=park; retry with tag_key "leisure" and tag_value "park".',
    );
  });

  it.each([
    { label: 'an unmapped amenity value', tag: { tagKey: 'amenity', tagValue: 'restaurant' } },
    { label: 'amenity key existence', tag: { tagKey: 'amenity' } },
    { label: 'the target tag itself', tag: { tagKey: 'tourism', tagValue: 'museum' } },
    { label: 'a mapped value under another key', tag: { tagKey: 'shop', tagValue: 'museum' } },
    { label: 'a value differing only in case', tag: { tagKey: 'amenity', tagValue: 'Museum' } },
    { label: 'an inherited object key', tag: { tagKey: 'amenity', tagValue: 'constructor' } },
  ])('returns nothing for $label', ({ tag }) => {
    expect(amenityStrayHint(tag)).toBeUndefined();
  });
});
