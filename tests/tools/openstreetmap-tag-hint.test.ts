/**
 * @fileoverview Unit tests for the tag retry hint: the conventional spelling of a primary
 * feature key or value sent capitalized or spaced (#124), composed with the stray-amenity
 * lookup (#84).
 * @module tests/tools/openstreetmap-tag-hint.test
 */

import { describe, expect, it } from 'vitest';
import {
  PRIMARY_FEATURE_KEYS,
  tagRetryHint,
} from '@/mcp-server/tools/definitions/openstreetmap-tag-hint.js';
import { resolveTagInput } from '@/mcp-server/tools/definitions/openstreetmap-tag-input.js';

/** The tool input as `resolveTagInput` resolves it, which is what both tools pass in. */
function resolved(input: Parameters<typeof resolveTagInput>[0]) {
  const tag = resolveTagInput(input);
  if ('error' in tag) throw new Error(`fixture rejected: ${tag.error}`);
  return tag;
}

const spelling = (chain: string) =>
  `OpenStreetMap writes primary feature keys and their values in lowercase with underscores, and tags match exactly; retry with ${chain}.`;

describe('PRIMARY_FEATURE_KEYS', () => {
  it('holds exactly the primary features of the OSM wiki Map features page', () => {
    expect([...PRIMARY_FEATURE_KEYS].sort()).toEqual([
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
  });
});

describe('tagRetryHint', () => {
  it.each([
    {
      label: 'a capitalized amenity value',
      input: { amenity: 'Hospital' },
      chain: 'amenity=hospital',
    },
    {
      label: 'a spaced amenity value',
      input: { amenity: 'fast food' },
      chain: 'amenity=fast_food',
    },
    {
      label: 'a whitespace run of tabs and spaces as one underscore',
      input: { amenity: 'Fast \t Food' },
      chain: 'amenity=fast_food',
    },
    {
      label: 'a no-break space',
      input: { tag_key: 'shop', tag_value: 'ice cream' },
      chain: 'shop=ice_cream',
    },
    { label: 'a capitalized key on its own', input: { tag_key: 'Amenity' }, chain: 'amenity' },
    {
      label: 'a capitalized key with a conventional value',
      input: { tag_key: 'Amenity', tag_value: 'hospital' },
      chain: 'amenity=hospital',
    },
    {
      label: 'a spaced key',
      input: { tag_key: 'Public Transport', tag_value: 'Platform' },
      chain: 'public_transport=platform',
    },
    {
      label: 'a list-item match, kept as one',
      input: { tag_key: 'Shop', tag_value: 'Bakery', tag_value_match: 'list_item' as const },
      chain: 'shop∋bakery',
    },
    {
      label: 'a filter entry, with the primary tag as sent',
      input: { tag_key: 'building', filters: [{ key: 'Shop', value: 'Bakery' }] },
      chain: 'building, shop=bakery',
    },
    {
      label: 'the whole chain, leaving free-text keys as sent',
      input: {
        tag_key: 'Amenity',
        tag_value: 'Cafe',
        filters: [{ key: 'brand', value: 'Starbucks' }, { key: 'Name' }, { key: 'Building' }],
      },
      chain: 'amenity=cafe, brand=Starbucks, Name, building',
    },
    {
      label: 'a hyphenated value, keeping the hyphen',
      input: { tag_key: 'shop', tag_value: 'E-Cigarette' },
      chain: 'shop=e-cigarette',
    },
    {
      label: 'an uppercase letter outside ASCII',
      input: { amenity: 'Ñ' },
      chain: 'amenity=ñ',
    },
  ])('names the conventional spelling for $label', ({ input, chain }) => {
    expect(tagRetryHint(resolved(input))).toBe(spelling(chain));
  });

  /** The stray lookup reads the corrected spelling, so the caller gets one retry, not two. */
  it.each([
    {
      label: 'the amenity shortcut',
      input: { amenity: 'Museum' },
      hint: 'In OpenStreetMap this category is tagged tourism=museum, not amenity=Museum; retry with tag_key "tourism" and tag_value "museum".',
    },
    {
      label: 'a capitalized key',
      input: { tag_key: 'Amenity', tag_value: 'museum' },
      hint: 'In OpenStreetMap this category is tagged tourism=museum, not Amenity=museum; retry with tag_key "tourism" and tag_value "museum".',
    },
    {
      label: 'a spaced value',
      input: { amenity: 'Guest House' },
      hint: 'In OpenStreetMap this category is tagged tourism=guest_house, not amenity=Guest House; retry with tag_key "tourism" and tag_value "guest_house".',
    },
    {
      label: 'a list-item match',
      input: { tag_key: 'amenity', tag_value: 'PARK', tag_value_match: 'list_item' as const },
      hint: 'In OpenStreetMap this category is tagged leisure=park, not amenity=PARK; retry with tag_key "leisure" and tag_value "park".',
    },
  ])('names the stray key once when the corrected value is a stray: $label', ({ input, hint }) => {
    expect(tagRetryHint(resolved(input))).toBe(hint);
  });

  it('returns the #84 hint unchanged for a conventionally spelled stray', () => {
    expect(tagRetryHint(resolved({ amenity: 'museum' }))).toBe(
      'In OpenStreetMap this category is tagged tourism=museum, not amenity=museum; retry with tag_key "tourism" and tag_value "museum".',
    );
  });

  /** #84 reads the primary tag only, so a stray amenity in a filter is spelled, not routed. */
  it('spells a stray amenity filter without routing it to its key', () => {
    expect(
      tagRetryHint(
        resolved({ tag_key: 'building', filters: [{ key: 'Amenity', value: 'Museum' }] }),
      ),
    ).toBe(spelling('building, amenity=museum'));
  });

  it.each([
    { label: 'a conventional spelling', input: { amenity: 'hospital' } },
    { label: 'a conventional chain', input: { amenity: 'cafe', filters: [{ key: 'cuisine' }] } },
    { label: 'a hyphenated value', input: { tag_key: 'shop', tag_value: 'e-cigarette' } },
    { label: 'name', input: { tag_key: 'name', tag_value: "Joe's Diner" } },
    {
      label: 'brand in a filter',
      input: { amenity: 'cafe', filters: [{ key: 'brand', value: 'Starbucks' }] },
    },
    { label: 'a key with legitimate uppercase', input: { tag_key: 'ISO3166-1', tag_value: 'US' } },
    {
      label: 'a capitalized key outside the list',
      input: { tag_key: 'Cuisine', tag_value: 'Pizza' },
    },
    { label: 'an address key', input: { tag_key: 'Addr:Street', tag_value: 'Main Street' } },
    { label: 'an inherited object key', input: { tag_key: 'Constructor', tag_value: 'X' } },
  ])('returns nothing for $label', ({ input }) => {
    expect(tagRetryHint(resolved(input))).toBeUndefined();
  });
});
