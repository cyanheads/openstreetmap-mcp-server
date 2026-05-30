/**
 * @fileoverview Unit tests for resolveTagInput — the shared tag validation helper.
 * @module tests/tools/openstreetmap-tag-input.test
 */

import { describe, expect, it } from 'vitest';
import { resolveTagInput } from '@/mcp-server/tools/definitions/openstreetmap-tag-input.js';

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
});
