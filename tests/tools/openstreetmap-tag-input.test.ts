/**
 * @fileoverview Unit tests for resolveTagInput — the shared tag validation helper.
 * @module tests/tools/openstreetmap-tag-input.test
 */

import { describe, expect, it } from 'vitest';
import {
  describeTagChain,
  invalidTagMessage,
  resolveTagInput,
} from '@/mcp-server/tools/definitions/openstreetmap-tag-input.js';

describe('resolveTagInput', () => {
  describe('amenity shortcut', () => {
    it('returns tagKey=amenity and tagValue from amenity field', () => {
      const result = resolveTagInput({ amenity: 'cafe' });
      expect(result).toEqual({ tagKey: 'amenity', tagValue: 'cafe' });
    });

    it('trims whitespace before determining presence', () => {
      const result = resolveTagInput({ amenity: '  hospital  ' });
      // hasAmenity should be truthy — result is a ResolvedTag
      expect('tagKey' in result).toBe(true);
    });
  });

  describe('tag_key / tag_value pair', () => {
    it('returns tagKey and tagValue from tag_key/tag_value fields', () => {
      const result = resolveTagInput({ tag_key: 'leisure', tag_value: 'park' });
      expect(result).toEqual({ tagKey: 'leisure', tagValue: 'park' });
    });

    it('returns tagKey and tagValue for non-standard keys', () => {
      const result = resolveTagInput({ tag_key: 'natural', tag_value: 'peak' });
      expect(result).toEqual({ tagKey: 'natural', tagValue: 'peak' });
    });
  });

  describe('trimming the resolved pair (#36)', () => {
    it('trims a padded amenity so the Overpass filter matches exactly', () => {
      expect(resolveTagInput({ amenity: ' cafe ' })).toEqual({
        tagKey: 'amenity',
        tagValue: 'cafe',
      });
    });

    it('trims a padded tag_key', () => {
      expect(resolveTagInput({ tag_key: '  leisure', tag_value: 'park' })).toEqual({
        tagKey: 'leisure',
        tagValue: 'park',
      });
    });

    it('trims a padded tag_value', () => {
      expect(resolveTagInput({ tag_key: 'shop', tag_value: 'supermarket\t' })).toEqual({
        tagKey: 'shop',
        tagValue: 'supermarket',
      });
    });

    it('preserves interior whitespace while trimming the edges', () => {
      expect(resolveTagInput({ tag_key: 'shop', tag_value: '  Coffee House  ' })).toEqual({
        tagKey: 'shop',
        tagValue: 'Coffee House',
      });
    });

    it('still rejects a metacharacter wrapped in whitespace', () => {
      expect(resolveTagInput({ amenity: '  cafe"]["name  ' })).toEqual({ error: 'invalid_chars' });
    });
  });

  describe('error: both', () => {
    it('returns error=both when amenity and tag_key are combined', () => {
      const result = resolveTagInput({ amenity: 'cafe', tag_key: 'leisure', tag_value: 'park' });
      expect(result).toEqual({ error: 'both' });
    });

    it('returns error=both when amenity and tag_value are combined (without tag_key)', () => {
      const result = resolveTagInput({ amenity: 'cafe', tag_value: 'park' });
      expect(result).toEqual({ error: 'both' });
    });
  });

  describe('error: neither', () => {
    it('returns error=neither when nothing is provided', () => {
      const result = resolveTagInput({});
      expect(result).toEqual({ error: 'neither' });
    });

    it('resolves key existence when tag_value is omitted', () => {
      const result = resolveTagInput({ tag_key: 'leisure' });
      expect(result).toEqual({ tagKey: 'leisure' });
    });

    it('returns error=neither when tag_value is provided without tag_key', () => {
      const result = resolveTagInput({ tag_value: 'park' });
      expect(result).toEqual({ error: 'neither' });
    });

    it('returns error=neither when amenity is an empty string', () => {
      const result = resolveTagInput({ amenity: '' });
      expect(result).toEqual({ error: 'neither' });
    });

    it('returns error=neither when amenity is only whitespace', () => {
      const result = resolveTagInput({ amenity: '   ' });
      expect(result).toEqual({ error: 'neither' });
    });

    it('returns error=neither when tag_key is empty string', () => {
      const result = resolveTagInput({ tag_key: '', tag_value: 'park' });
      expect(result).toEqual({ error: 'neither' });
    });
  });

  describe('edge cases', () => {
    it('keeps an empty extra-filter array identical to omission', () => {
      expect(resolveTagInput({ amenity: 'cafe', filters: [] })).toEqual(
        resolveTagInput({ amenity: 'cafe' }),
      );
    });

    it('resolves and trims the entire chain without inventing omitted values', () => {
      expect(
        resolveTagInput({
          tag_key: ' shop ',
          filters: [{ key: ' name ', value: ' Café House ' }, { key: ' website ' }],
        }),
      ).toEqual({
        tagKey: 'shop',
        filters: [{ tagKey: 'name', tagValue: 'Café House' }, { tagKey: 'website' }],
      });
    });

    it('ignores blank unused fields in amenity mode', () => {
      expect(resolveTagInput({ amenity: 'cafe', tag_key: ' ', tag_value: '' })).toEqual({
        tagKey: 'amenity',
        tagValue: 'cafe',
      });
    });

    it.each(['', ' \t '])('rejects an explicitly blank primary value: %j', (tag_value) => {
      expect(resolveTagInput({ tag_key: 'shop', tag_value })).toEqual({ error: 'blank' });
    });

    it('rejects duplicates in later entries after trimming', () => {
      expect(
        resolveTagInput({
          amenity: 'cafe',
          filters: [{ key: 'name' }, { key: ' name ', value: 'Cafe' }],
        }),
      ).toEqual({ error: 'duplicate_key' });
    });
    it('handles undefined fields consistently', () => {
      const result = resolveTagInput({
        amenity: undefined,
        tag_key: undefined,
        tag_value: undefined,
      });
      expect(result).toEqual({ error: 'neither' });
    });

    it('uses tag_key/tag_value when amenity is explicitly undefined', () => {
      const result = resolveTagInput({
        amenity: undefined,
        tag_key: 'shop',
        tag_value: 'supermarket',
      });
      expect(result).toEqual({ tagKey: 'shop', tagValue: 'supermarket' });
    });
  });

  describe('error: invalid_chars (Overpass QL metacharacters) — #14', () => {
    // Injection repro from the issue: a literal `"` closes ["key"="value"] and injects a
    // second filter (amenity=cafe + name=Cafe Bee) instead of matching a literal value.
    const INJECTION = 'cafe"]["name"="Cafe Bee';

    it('rejects a tag_value carrying quote/bracket metacharacters', () => {
      expect(resolveTagInput({ tag_key: 'amenity', tag_value: INJECTION })).toEqual({
        error: 'invalid_chars',
      });
    });

    it('rejects a tag_key carrying quote/bracket metacharacters', () => {
      expect(resolveTagInput({ tag_key: 'amenity"]["name', tag_value: 'cafe' })).toEqual({
        error: 'invalid_chars',
      });
    });

    it('rejects the amenity shortcut carrying quote/bracket metacharacters (third vector)', () => {
      expect(resolveTagInput({ amenity: INJECTION })).toEqual({ error: 'invalid_chars' });
    });

    it('rejects the bare-bracket value that silently returned zero results', () => {
      expect(resolveTagInput({ amenity: 'cafe][name=Cafe Bee' })).toEqual({
        error: 'invalid_chars',
      });
    });

    it('rejects a backslash (escape-parsing vector)', () => {
      expect(resolveTagInput({ tag_key: 'amenity', tag_value: 'cafe\\bar' })).toEqual({
        error: 'invalid_chars',
      });
    });

    it('rejects the remaining QL structurals ; ( )', () => {
      for (const value of ['a;b', 'a(b', 'a)b']) {
        expect(resolveTagInput({ tag_key: 'amenity', tag_value: value })).toEqual({
          error: 'invalid_chars',
        });
      }
    });
  });

  describe('legitimate OSM tag characters pass', () => {
    it('accepts values with space, colon, slash, dot, hyphen, underscore, and unicode', () => {
      const legit = [
        'Coffee House',
        'addr:street',
        'some/path',
        '3.5',
        'drive-through',
        'fast_food',
        'café',
      ];
      for (const value of legit) {
        expect(resolveTagInput({ tag_key: 'shop', tag_value: value })).toEqual({
          tagKey: 'shop',
          tagValue: value,
        });
      }
    });

    it('accepts a colon-bearing tag_key like addr:street', () => {
      expect(resolveTagInput({ tag_key: 'addr:street', tag_value: 'Main Street' })).toEqual({
        tagKey: 'addr:street',
        tagValue: 'Main Street',
      });
    });
  });
});

/**
 * #83: semicolon-list values. The mode is carried on the resolved filter only when it is
 * `list_item`, so an omitted or explicit `exact` resolves to the same object a legacy call
 * did — and therefore to the same QL and the same cache key.
 */
describe('list-item match mode (#83)', () => {
  it('carries list_item on a filter entry', () => {
    expect(
      resolveTagInput({
        amenity: 'restaurant',
        filters: [{ key: 'cuisine', value: ' pizza ', match: 'list_item' }],
      }),
    ).toEqual({
      tagKey: 'amenity',
      tagValue: 'restaurant',
      filters: [{ tagKey: 'cuisine', tagValue: 'pizza', match: 'list_item' }],
    });
  });

  it('carries tag_value_match list_item on the primary tag', () => {
    expect(
      resolveTagInput({ tag_key: 'sport', tag_value: 'soccer', tag_value_match: 'list_item' }),
    ).toEqual({ tagKey: 'sport', tagValue: 'soccer', match: 'list_item' });
  });

  it('resolves an explicit exact to the legacy object, primary and filter alike', () => {
    expect(
      resolveTagInput({
        tag_key: 'amenity',
        tag_value: 'restaurant',
        tag_value_match: 'exact',
        filters: [{ key: 'cuisine', value: 'italian', match: 'exact' }],
      }),
    ).toEqual(
      resolveTagInput({
        tag_key: 'amenity',
        tag_value: 'restaurant',
        filters: [{ key: 'cuisine', value: 'italian' }],
      }),
    );
  });

  it('ignores an exact tag_value_match in amenity mode, as it ignores blank unused fields', () => {
    expect(resolveTagInput({ amenity: 'cafe', tag_value_match: 'exact' })).toEqual({
      tagKey: 'amenity',
      tagValue: 'cafe',
    });
  });

  it.each([
    {
      label: 'a key-existence filter',
      input: { amenity: 'cafe', filters: [{ key: 'cuisine', match: 'list_item' as const }] },
    },
    {
      label: 'tag_key without tag_value',
      input: { tag_key: 'cuisine', tag_value_match: 'list_item' as const },
    },
    {
      label: 'the amenity shortcut',
      input: { amenity: 'restaurant', tag_value_match: 'list_item' as const },
    },
  ])('rejects list_item on $label as list_item_without_value', ({ input }) => {
    expect(resolveTagInput(input)).toEqual({ error: 'list_item_without_value' });
  });

  it('keeps both ahead of the list-item check when amenity meets tag_key', () => {
    expect(
      resolveTagInput({ amenity: 'cafe', tag_key: 'cuisine', tag_value_match: 'list_item' }),
    ).toEqual({ error: 'both' });
  });

  it('keeps blank ahead of the list-item check for an explicitly blank value', () => {
    expect(
      resolveTagInput({ tag_key: 'cuisine', tag_value: '  ', tag_value_match: 'list_item' }),
    ).toEqual({ error: 'blank' });
  });

  it.each(['"', '\\', '[', ']', ';', '(', ')'])(
    'rejects %j in a list-item value as invalid_chars, primary and filter alike',
    (character) => {
      expect(
        resolveTagInput({
          tag_key: 'cuisine',
          tag_value: `pi${character}za`,
          tag_value_match: 'list_item',
        }),
      ).toEqual({ error: 'invalid_chars' });
      expect(
        resolveTagInput({
          amenity: 'restaurant',
          filters: [{ key: 'cuisine', value: `pi${character}za`, match: 'list_item' }],
        }),
      ).toEqual({ error: 'invalid_chars' });
    },
  );

  it('accepts the regex specials the metacharacter set lets through, unescaped', () => {
    expect(
      resolveTagInput({ tag_key: 'k', tag_value: '.^$*+?{}|', tag_value_match: 'list_item' }),
    ).toEqual({ tagKey: 'k', tagValue: '.^$*+?{}|', match: 'list_item' });
  });
});

describe('describeTagChain', () => {
  it('renders equality, existence, and list-item membership in input order', () => {
    expect(
      describeTagChain({
        tagKey: 'amenity',
        tagValue: 'restaurant',
        filters: [
          { tagKey: 'cuisine', tagValue: 'pizza', match: 'list_item' },
          { tagKey: 'name' },
          { tagKey: 'wheelchair', tagValue: 'yes' },
        ],
      }),
    ).toBe('amenity=restaurant, cuisine∋pizza, name, wheelchair=yes');
  });

  it('renders a list-item primary tag', () => {
    expect(describeTagChain({ tagKey: 'sport', tagValue: 'soccer', match: 'list_item' })).toBe(
      'sport∋soccer',
    );
  });
});

describe('invalidTagMessage', () => {
  it('returns a distinct message per error variant', () => {
    expect(invalidTagMessage('both')).toContain('Cannot combine');
    expect(invalidTagMessage('neither')).toContain('Provide either');
    expect(invalidTagMessage('invalid_chars')).toContain('metacharacters');
    expect(invalidTagMessage('blank')).toContain('omit');
    expect(invalidTagMessage('duplicate_key')).toContain('unique');
  });

  it('names the value a list-item match needs and the amenity alternative (#83)', () => {
    expect(invalidTagMessage('list_item_without_value')).toBe(
      'A list_item match needs a value to match: pair it with tag_value or a filter value. The amenity shortcut takes no match mode; use tag_key "amenity" with tag_value instead.',
    );
  });
});
