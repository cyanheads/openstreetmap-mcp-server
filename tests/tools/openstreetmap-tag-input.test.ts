/**
 * @fileoverview Unit tests for resolveTagInput — the shared tag validation helper.
 * @module tests/tools/openstreetmap-tag-input.test
 */

import { describe, expect, it } from 'vitest';
import {
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

    it('returns error=neither when tag_key is provided without tag_value', () => {
      const result = resolveTagInput({ tag_key: 'leisure' });
      expect(result).toEqual({ error: 'neither' });
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

describe('invalidTagMessage', () => {
  it('returns a distinct message per error variant', () => {
    expect(invalidTagMessage('both')).toContain('Cannot combine');
    expect(invalidTagMessage('neither')).toContain('Provide either');
    expect(invalidTagMessage('invalid_chars')).toContain('metacharacters');
  });
});
