/**
 * @fileoverview The `sort_by` ranking on openstreetmap_query_bbox (#127): which tag values
 * rank, where the rest go, and that ranking never reorders the set it was handed.
 * @module tests/tools/openstreetmap-tag-sort.test
 */

import { describe, expect, it } from 'vitest';
import {
  rankByTag,
  resolveTagSort,
  sortByInput,
} from '@/mcp-server/tools/definitions/openstreetmap-tag-sort.js';

/** One feature per value, ids ascending in input order as Overpass prints them. */
function features(values: (string | undefined)[]) {
  return values.map((value, i) => ({
    osm_type: 'node' as const,
    osm_id: i + 1,
    tags: value === undefined ? { natural: 'peak' } : { natural: 'peak', ele: value },
  }));
}

const ids = (list: { osm_id: number }[]) => list.map((feature) => feature.osm_id);

describe('resolveTagSort', () => {
  it('reads an absent sort_by and a blank key as no sort', () => {
    expect(resolveTagSort(undefined)).toBeUndefined();
    expect(resolveTagSort({ key: '', order: 'desc' })).toBeUndefined();
    expect(resolveTagSort({ key: '   ', order: 'asc' })).toBeUndefined();
  });

  it('trims the key and keeps its case', () => {
    expect(resolveTagSort({ key: ' Population ', order: 'asc' })).toEqual({
      key: 'Population',
      order: 'asc',
    });
  });
});

describe('sortByInput', () => {
  it('defaults order to desc', () => {
    expect(sortByInput.parse({ key: 'ele' })).toEqual({ key: 'ele', order: 'desc' });
  });

  it('rejects an order outside desc and asc, and an undeclared key', () => {
    expect(sortByInput.safeParse({ key: 'ele', order: 'descending' }).success).toBe(false);
    const extra = sortByInput.safeParse({ key: 'ele', direction: 'asc' });
    expect(extra.success).toBe(false);
    expect(JSON.stringify(extra.error?.issues)).toContain('direction');
  });
});

describe('rankByTag', () => {
  /**
   * The plain-decimal grammar: the whole trimmed value is an optional minus, digits, and an
   * optional fraction. Every other shape stays unranked, with no unit conversion — OSM's
   * default unit differs by key, and a comma or dot can mean thousands or a decimal.
   */
  it.each([
    { value: '4392', ranks: true },
    { value: '1425.9', ranks: true },
    { value: '-12', ranks: true },
    { value: '-0.5', ranks: true },
    { value: '0', ranks: true },
    { value: '007', ranks: true },
    { value: ' 2071.4 ', ranks: true },
    { value: '\t300\n', ranks: true },
    { value: '8280ft', ranks: false },
    { value: "4445'", ranks: false },
    { value: '30 m', ranks: false },
    { value: '2,5', ranks: false },
    { value: '176,846', ranks: false },
    { value: '100-200', ranks: false },
    { value: '849;871', ranks: false },
    { value: '~1000', ranks: false },
    { value: 'ca. 1000', ranks: false },
    { value: '1e3', ranks: false },
    { value: '0x10', ranks: false },
    { value: '+5', ranks: false },
    { value: '.5', ranks: false },
    { value: '5.', ranks: false },
    { value: '4 070', ranks: false },
    { value: '', ranks: false },
    { value: 'NaN', ranks: false },
    { value: 'Infinity', ranks: false },
  ])('ranks $value: $ranks', ({ value, ranks }) => {
    // A ranked value outranks 1 under desc; an unranked one follows it.
    const { ranked, unrankedCount } = rankByTag(features([value, '1']), {
      key: 'ele',
      order: 'desc',
    });
    expect(unrankedCount).toBe(ranks ? 0 : 1);
    if (!ranks) expect(ids(ranked)).toEqual([2, 1]);
  });

  it('puts the largest value first under desc and the smallest under asc', () => {
    const set = features(['1454', '4392', '-3.5', '2071.4', '1148']);
    expect(ids(rankByTag(set, { key: 'ele', order: 'desc' }).ranked)).toEqual([2, 4, 1, 5, 3]);
    expect(ids(rankByTag(set, { key: 'ele', order: 'asc' }).ranked)).toEqual([3, 5, 1, 4, 2]);
  });

  it('compares values numerically, not as text', () => {
    const set = features(['900', '1000', '95.5', '100']);
    expect(ids(rankByTag(set, { key: 'ele', order: 'desc' }).ranked)).toEqual([2, 1, 4, 3]);
  });

  it('keeps tied values in input order under both orders', () => {
    const set = features(['1917', '2000', '1917', '1917.0', '1000', '1917']);
    // 1917 and 1917.0 are one value, so ids 1, 3, 4, 6 tie and stay in that order.
    expect(ids(rankByTag(set, { key: 'ele', order: 'desc' }).ranked)).toEqual([2, 1, 3, 4, 6, 5]);
    expect(ids(rankByTag(set, { key: 'ele', order: 'asc' }).ranked)).toEqual([5, 1, 3, 4, 6, 2]);
  });

  it('follows the ranked features with the unparseable and missing ones, in input order, under both orders', () => {
    const set = features(['8280ft', '1454', undefined, '4392', '2,5', '1148', '~1000']);
    for (const order of ['desc', 'asc'] as const) {
      const { ranked, unrankedCount } = rankByTag(set, { key: 'ele', order });
      expect(ids(ranked).slice(3)).toEqual([1, 3, 5, 7]);
      expect(unrankedCount).toBe(4);
    }
    expect(ids(rankByTag(set, { key: 'ele', order: 'desc' }).ranked).slice(0, 3)).toEqual([
      4, 2, 6,
    ]);
    expect(ids(rankByTag(set, { key: 'ele', order: 'asc' }).ranked).slice(0, 3)).toEqual([6, 2, 4]);
  });

  it('counts every feature unranked when none carries the key, leaving input order', () => {
    const set = features(['1454', '4392']);
    const { ranked, unrankedCount } = rankByTag(set, { key: 'population', order: 'desc' });
    expect(ids(ranked)).toEqual([1, 2]);
    expect(unrankedCount).toBe(2);
  });

  it('matches the key exactly and never reads it off the object prototype', () => {
    const set = features(['1454', '4392']);
    expect(rankByTag(set, { key: 'Ele', order: 'desc' }).unrankedCount).toBe(2);
    for (const key of ['constructor', 'toString', '__proto__']) {
      const { ranked, unrankedCount } = rankByTag(set, { key, order: 'desc' });
      expect(ids(ranked)).toEqual([1, 2]);
      expect(unrankedCount).toBe(2);
    }
  });

  it('returns a new array and leaves the one it was given in its order', () => {
    const set = features(['1148', '4392', '2071.4']);
    const before = ids(set);
    const { ranked } = rankByTag(set, { key: 'ele', order: 'desc' });
    expect(ranked).not.toBe(set);
    expect(ids(set)).toEqual(before);
    // The features themselves are passed through, not copied.
    expect(ranked[0]).toBe(set[1]);
  });

  it('ranks an empty set to an empty set with nothing unranked', () => {
    expect(rankByTag([], { key: 'ele', order: 'desc' })).toEqual({ ranked: [], unrankedCount: 0 });
  });
});
