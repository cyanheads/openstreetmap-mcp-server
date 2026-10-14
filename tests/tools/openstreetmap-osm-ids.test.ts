/**
 * @fileoverview Unit tests for the N/W/R ref canonical form and the Overpass existence-check
 * query built from a list of refs (#82).
 * @module tests/tools/openstreetmap-osm-ids.test
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalOsmId,
  existenceCheckQuery,
  OSM_ID_PATTERN,
} from '@/mcp-server/tools/definitions/openstreetmap-osm-ids.js';

describe('canonicalOsmId', () => {
  it.each([
    ['N240109189', 'N240109189'],
    [' n240109189 ', 'N240109189'],
    ['W012903132', 'W12903132'],
    ['r0099', 'R99'],
    ['N000', 'N0'],
    ['N0', 'N0'],
    ['N10', 'N10'],
  ])('%j → %s', (ref, canonical) => {
    expect(OSM_ID_PATTERN.test(ref.trim())).toBe(true);
    expect(canonicalOsmId(ref)).toBe(canonical);
  });

  it('keeps every digit of an id past 2^53, since it never parses a number', () => {
    expect(canonicalOsmId('N0009007199254740993')).toBe('N9007199254740993');
  });
});

describe('existenceCheckQuery', () => {
  it('emits one group per type present, node then way then rel, ids in the order given', () => {
    expect(existenceCheckQuery(['R146656', 'W241876407', 'N8502074800', 'R99', 'N7', 'W5'])).toBe(
      '[out:json];(node(id:8502074800,7);way(id:241876407,5);rel(id:146656,99););out tags;',
    );
  });

  it('omits the group of an absent type', () => {
    expect(existenceCheckQuery(['W1'])).toBe('[out:json];(way(id:1););out tags;');
    expect(existenceCheckQuery(['R2', 'N1'])).toBe('[out:json];(node(id:1);rel(id:2););out tags;');
  });
});
