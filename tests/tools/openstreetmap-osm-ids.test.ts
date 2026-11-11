/**
 * @fileoverview Unit tests for the OSM ref parser shared by `osm_ids` and `within` — the forms
 * it accepts and rejects, the canonical ref it reduces each to, the 64-bit id bound, the two
 * advertised patterns (#126) — and the Overpass existence-check query built from refs (#82).
 * @module tests/tools/openstreetmap-osm-ids.test
 */

import { describe, expect, it } from 'vitest';
import {
  AREA_REF_PATTERN,
  existenceCheckQuery,
  MAX_OSM_ID,
  OSM_REF_PATTERN,
  parseOsmRef,
} from '@/mcp-server/tools/definitions/openstreetmap-osm-ids.js';

/** The canonical ref an input parses to under a pattern, or undefined when it does not parse. */
function refOf(raw: string, pattern: RegExp): string | undefined {
  const parsed = parseOsmRef(raw, pattern);
  return parsed.kind === 'ref' ? parsed.ref : undefined;
}

/**
 * Input → canonical ref under `osm_ids`, then under `within` (null: rejected). The rows are the
 * forms #126 accepts: the short ref, the object path, and that path on the website's hosts.
 */
const ACCEPTED: readonly (readonly [string, string, string | null])[] = [
  ['N240109189', 'N240109189', null],
  ['n240109189', 'N240109189', null],
  [' N240109189 ', 'N240109189', null],
  ['\tW13800188\n', 'W13800188', 'W13800188'],
  ['N0240109189', 'N240109189', null],
  ['N0', 'N0', null],
  ['N000', 'N0', null],
  ['W012903132', 'W12903132', 'W12903132'],
  ['r0099', 'R99', 'R99'],
  [' r0237385 ', 'R237385', 'R237385'],
  ['node/240109189', 'N240109189', null],
  ['way/13800188', 'W13800188', 'W13800188'],
  ['relation/237385', 'R237385', 'R237385'],
  ['NODE/240109189', 'N240109189', null],
  ['Relation/237385', 'R237385', 'R237385'],
  ['node/240109189/', 'N240109189', null],
  ['/relation/237385', 'R237385', 'R237385'],
  ['node/0240109189', 'N240109189', null],
  ['https://www.openstreetmap.org/node/240109189', 'N240109189', null],
  ['https://openstreetmap.org/relation/237385', 'R237385', 'R237385'],
  ['http://www.openstreetmap.org/way/13800188', 'W13800188', 'W13800188'],
  ['www.openstreetmap.org/relation/237385', 'R237385', 'R237385'],
  ['openstreetmap.org/way/13800188', 'W13800188', 'W13800188'],
  ['https://osm.org/relation/237385', 'R237385', 'R237385'],
  ['osm.org/node/240109189', 'N240109189', null],
  ['https://www.openstreetmap.org/node/240109189/history', 'N240109189', null],
  ['https://www.openstreetmap.org/node/240109189/history/3', 'N240109189', null],
  ['https://www.openstreetmap.org/relation/237385#map=11/47.61/-122.33', 'R237385', 'R237385'],
  [
    'https://www.openstreetmap.org/way/13800188?layers=N#map=17/47.63/-122.31',
    'W13800188',
    'W13800188',
  ],
  // The object is the path's own type and id, never one named later in the tail.
  [
    'https://www.openstreetmap.org/way/13800188#map=19/47.6/-122.3&node/5',
    'W13800188',
    'W13800188',
  ],
  ['https://www.openstreetmap.org/relation/237385/', 'R237385', 'R237385'],
  ['  https://www.openstreetmap.org/relation/237385  ', 'R237385', 'R237385'],
];

/** Forms #126 leaves out, each rejected under both patterns. */
const REJECTED: readonly string[] = [
  'node:240109189',
  'n/240109189',
  'node 240109189',
  'nodes/240109189',
  'node/240109189abc',
  'node/',
  '240109189',
  'N 240109189',
  'N240109189/',
  'N1x',
  'https://osm.org/go/WIdEVc5r-?node=240109189',
  'https://www.openstreetmap.org/?node=240109189',
  'https://www.openstreetmap.org/browse/node/240109189',
  'https://api.openstreetmap.org/api/0.6/node/240109189',
  'https://www.openstreetmap.org/changeset/123',
  'https://www.openstreetmap.org/note/123',
  'https://example.com/node/240109189',
  'https://www.openhistoricalmap.org/node/240109189',
  'https://evil.openstreetmap.org.example.com/node/1',
  'https://example.com/x.openstreetmap.org/node/1',
  'https://api.openstreetmap.org/node/240109189',
  'openstreetmap.orgnode/1',
  'HTTPS://WWW.OPENSTREETMAP.ORG/node/1',
  'node/1 node/2',
  'N1,N2',
  '["N1", "N2"]',
  '',
  '   ',
];

describe('parseOsmRef', () => {
  it.each(ACCEPTED)('%j → %s for osm_ids, %s for within', (raw, osmIds, within) => {
    expect(parseOsmRef(raw, OSM_REF_PATTERN)).toEqual({ kind: 'ref', ref: osmIds });
    expect(refOf(raw, AREA_REF_PATTERN) ?? null).toBe(within);
  });

  it.each(REJECTED)('rejects %j under both patterns', (raw) => {
    expect(parseOsmRef(raw, OSM_REF_PATTERN)).toEqual({ kind: 'malformed' });
    expect(parseOsmRef(raw, AREA_REF_PATTERN)).toEqual({ kind: 'malformed' });
  });

  it('rejects a node in every form as an area ref', () => {
    for (const raw of [
      'N240109189',
      'node/240109189',
      'https://www.openstreetmap.org/node/240109189',
    ]) {
      expect(parseOsmRef(raw, AREA_REF_PATTERN)).toEqual({ kind: 'malformed' });
    }
  });

  it('keeps every digit of an id past 2^53, since it never parses a number', () => {
    expect(refOf('N0009007199254740993', OSM_REF_PATTERN)).toBe('N9007199254740993');
    expect(refOf(`N${'0'.repeat(30)}42`, OSM_REF_PATTERN)).toBe('N42');
  });
});

/**
 * Nominatim answers an id past 2^63 − 1 with HTTP 500, which the lookup tool retried and
 * reported as a retryable outage. The bound sits in the parser, so both inputs refuse it before
 * any request is built.
 */
describe('the 64-bit id bound', () => {
  it('names the bound as 2^63 − 1', () => {
    expect(MAX_OSM_ID).toBe((2n ** 63n - 1n).toString());
  });

  it.each([
    ['N9223372036854775807', 'N9223372036854775807'],
    ['N09223372036854775807', 'N9223372036854775807'],
    ['node/0009223372036854775807', 'N9223372036854775807'],
    ['N999999999999999999', 'N999999999999999999'],
  ])('accepts %j as %s, the bound compared after leading zeros drop', (raw, ref) => {
    expect(parseOsmRef(raw, OSM_REF_PATTERN)).toEqual({ kind: 'ref', ref });
  });

  it.each([
    'N9223372036854775808',
    'N10000000000000000000',
    'N99999999999999999999999999',
    'https://www.openstreetmap.org/relation/9223372036854775808',
    'N09223372036854775808',
    'node/0009223372036854775808',
  ])('refuses %j as out of range', (raw) => {
    expect(parseOsmRef(raw, OSM_REF_PATTERN)).toEqual({ kind: 'out_of_range' });
  });

  it('refuses an out-of-range way or relation under the area pattern too', () => {
    expect(parseOsmRef('R9223372036854775808', AREA_REF_PATTERN)).toEqual({
      kind: 'out_of_range',
    });
    expect(parseOsmRef('way/99999999999999999999', AREA_REF_PATTERN)).toEqual({
      kind: 'out_of_range',
    });
  });

  // Both ids round to the same double, so a bound checked through Number cannot split them.
  it('tells 2^63 − 1 from 2^63, which Number cannot', () => {
    expect(Number('9223372036854775807')).toBe(Number('9223372036854775808'));
    expect(parseOsmRef('N9223372036854775807', OSM_REF_PATTERN).kind).toBe('ref');
    expect(parseOsmRef('N9223372036854775808', OSM_REF_PATTERN).kind).toBe('out_of_range');
  });
});

/**
 * The patterns reach the wire as their `source` with no flags, the form a JSON-Schema validator
 * compiles. Asserted by matching a RegExp rebuilt from that source, never by substring.
 */
describe('advertised ref patterns', () => {
  const advertised = {
    osm_ids: new RegExp(OSM_REF_PATTERN.source),
    within: new RegExp(AREA_REF_PATTERN.source),
  };

  it('carry no flags, so the source alone is the whole grammar', () => {
    expect(OSM_REF_PATTERN.flags).toBe('');
    expect(AREA_REF_PATTERN.flags).toBe('');
  });

  it.each(ACCEPTED)('match %j where the parser accepts it', (raw, _osmIds, within) => {
    expect(advertised.osm_ids.test(raw)).toBe(true);
    expect(advertised.within.test(raw)).toBe(within !== null);
  });

  it.each(REJECTED)('reject %j', (raw) => {
    expect(advertised.osm_ids.test(raw)).toBe(false);
    expect(advertised.within.test(raw)).toBe(false);
  });

  // `(?:` is the only group modifier: no lookbehind, lookahead, named group, or inline flag.
  it('use no group syntax beyond plain and non-capturing groups', () => {
    for (const pattern of [OSM_REF_PATTERN, AREA_REF_PATTERN]) {
      expect(pattern.source).not.toMatch(/\(\?(?!:)/);
    }
  });
});

/**
 * Every input the handlers accepted before #126 parses to the same canonical ref after it. The
 * oracle is a frozen copy of that grammar: `osm_ids` trimmed each entry and tested
 * `^[NWRnwr]\d+$`, then uppercased the prefix and stripped leading zeros; `within` tested
 * `^[RWrw]\d+$` untrimmed. Every string up to four characters over an alphabet of the prefix
 * letters, digits, whitespace `String#trim` strips, and two separators is checked.
 *
 * The alphabet holds no letter of a type word, so the path and URL forms cannot be spelled from
 * it: over these strings the new grammar must accept exactly what the old one did, in both
 * directions. `within` now takes whatever `osm_ids` took with a W or R prefix, which covers
 * every ref it took before and adds the whitespace around one.
 */
describe('grammar sweep against the pre-#126 grammar', () => {
  const LEGACY_OSM_ID = /^[NWRnwr]\d+$/;
  const LEGACY_WITHIN = /^[RWrw]\d+$/;
  const legacyCanonical = (raw: string) => {
    const trimmed = raw.trim();
    return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1).replace(/^0+(?=\d)/, '')}`;
  };

  const ALPHABET = [
    ...['N', 'n', 'W', 'w', 'R', 'r', 'x', '0', '1', '9'],
    ...[' ', '\t', ' ', '﻿', '/', ':'],
  ];

  function* strings(length: number, prefix = ''): Generator<string> {
    if (length === 0) {
      yield prefix;
      return;
    }
    for (const char of ALPHABET) yield* strings(length - 1, prefix + char);
  }

  it('accepts exactly what the old grammar accepted, each as the same canonical ref', () => {
    const mismatches: string[] = [];
    let legacyAccepted = 0;
    let legacyWithin = 0;
    let checked = 0;
    for (let length = 1; length <= 4; length++) {
      for (const raw of strings(length)) {
        checked++;
        const legacyOsmId = LEGACY_OSM_ID.test(raw.trim()) ? legacyCanonical(raw) : undefined;
        const legacyArea = legacyOsmId && /^[WR]/.test(legacyOsmId) ? legacyOsmId : undefined;
        if (legacyOsmId) legacyAccepted++;
        if (LEGACY_WITHIN.test(raw)) legacyWithin++;
        if (refOf(raw, OSM_REF_PATTERN) !== legacyOsmId) mismatches.push(`osm_ids ${raw}`);
        if (refOf(raw, AREA_REF_PATTERN) !== legacyArea) mismatches.push(`within ${raw}`);
      }
    }
    expect(checked).toBe(69_904);
    /**
     * The sweep reaches every old-grammar string the alphabet spells: 6 prefixes, 1–3 of 3
     * digits, and w whitespace characters of 4 split w + 1 ways, w + digits ≤ 3, sums to 1,674;
     * `within` took 4 of those prefixes with no whitespace, 4 × (3 + 9 + 27) = 156.
     */
    expect(legacyAccepted).toBe(1_674);
    expect(legacyWithin).toBe(156);
    expect(mismatches.slice(0, 10).map((entry) => JSON.stringify(entry))).toEqual([]);
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
