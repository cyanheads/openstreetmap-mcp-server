/**
 * @fileoverview The `tag_keys` projection shared by openstreetmap_query_nearby and
 * openstreetmap_query_bbox (#125): which keys a call keeps, and how a page's tags are cut to
 * them without touching the tag objects the service handed out.
 * @module tests/tools/openstreetmap-tag-keys.test
 */

import { describe, expect, it } from 'vitest';
import {
  projectTags,
  resolveTagKeys,
  tagKeysInput,
} from '@/mcp-server/tools/definitions/openstreetmap-tag-keys.js';

describe('resolveTagKeys', () => {
  it.each([
    { label: 'omitted', requested: undefined },
    { label: 'an empty list', requested: [] },
    { label: 'blank entries only', requested: ['', '  ', '\t'] },
  ])('reads $label as the full tag set', ({ requested }) => {
    expect(resolveTagKeys(requested)).toBeUndefined();
  });

  it('trims each key, drops blank entries, and keeps the first of a repeated key', () => {
    expect(resolveTagKeys([' admin_level ', '', 'wikidata', 'admin_level', 'name:en'])).toEqual([
      'admin_level',
      'wikidata',
      'name:en',
    ]);
  });

  it('keeps keys exactly as cased', () => {
    expect(resolveTagKeys(['Name', 'name'])).toEqual(['Name', 'name']);
  });
});

describe('tagKeysInput', () => {
  it('accepts 50 keys and rejects 51', () => {
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);
    expect(tagKeysInput.safeParse(keys(50)).success).toBe(true);
    const over = tagKeysInput.safeParse(keys(51));
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]).toMatchObject({ code: 'too_big', maximum: 50 });
  });

  it('accepts an empty list, so a form client sending [] gets the full set', () => {
    expect(tagKeysInput.safeParse([]).success).toBe(true);
  });
});

describe('projectTags', () => {
  const unitedStates = {
    osm_type: 'relation' as const,
    osm_id: 148838,
    name: 'United States',
    tags: {
      admin_level: '2',
      boundary: 'administrative',
      name: 'United States',
      'name:en': 'United States',
      'name:fr': "États-Unis d'Amérique",
      wikidata: 'Q30',
    },
  };
  const seattle = {
    osm_type: 'relation' as const,
    osm_id: 237385,
    name: 'Seattle',
    tags: { admin_level: '8', boundary: 'administrative', name: 'Seattle', wikidata: 'Q5083' },
  };

  it('keeps exactly the listed keys a feature carries, in the listed order', () => {
    const [us, city] = projectTags([unitedStates, seattle], ['wikidata', 'name:fr', 'admin_level']);
    expect(us?.tags).toEqual({
      wikidata: 'Q30',
      'name:fr': "États-Unis d'Amérique",
      admin_level: '2',
    });
    expect(Object.keys(us?.tags ?? {})).toEqual(['wikidata', 'name:fr', 'admin_level']);
    // Seattle carries no name:fr, so the key is absent rather than blank.
    expect(city?.tags).toEqual({ wikidata: 'Q5083', admin_level: '8' });
    expect(city?.tags).not.toHaveProperty('name:fr');
  });

  it('leaves every other field as it was, name included, and keeps tags.name only when listed', () => {
    const [unlisted] = projectTags([unitedStates], ['admin_level']);
    expect(unlisted).toEqual({ ...unitedStates, tags: { admin_level: '2' } });
    const [listed] = projectTags([unitedStates], ['name']);
    expect(listed?.tags).toEqual({ name: 'United States' });
  });

  it('matches case-sensitively and reads no wildcard', () => {
    const [us] = projectTags([unitedStates], ['Name', 'name:*', 'NAME:EN']);
    expect(us?.tags).toEqual({});
  });

  it('never reads a key off the object prototype', () => {
    const [us] = projectTags(
      [unitedStates],
      ['constructor', 'toString', '__proto__', 'hasOwnProperty'],
    );
    expect(us?.tags).toEqual({});
    expect(Object.keys(us?.tags ?? { x: 1 })).toEqual([]);
  });

  it('builds new tag objects and leaves the features it was given untouched', () => {
    const features = [unitedStates, seattle];
    const snapshot = structuredClone(features);
    const projected = projectTags(features, ['wikidata']);
    expect(features).toEqual(snapshot);
    expect(projected[0]).not.toBe(unitedStates);
    expect(projected[0]?.tags).not.toBe(unitedStates.tags);
    expect(projected[1]?.tags).not.toBe(seattle.tags);
  });

  it('returns an empty page for an empty page', () => {
    expect(projectTags([], ['wikidata'])).toEqual([]);
  });
});
