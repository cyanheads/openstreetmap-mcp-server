/**
 * @fileoverview Unit tests for openstreetmap-format shared formatting helpers.
 * @module tests/tools/openstreetmap-format.test
 */

import { describe, expect, it } from 'vitest';
import { appendPlaceLines } from '@/mcp-server/tools/definitions/openstreetmap-format.js';
import {
  escapeMarkdownText,
  escapeMarkdownValue,
} from '@/mcp-server/tools/definitions/openstreetmap-markdown-escape.js';

/**
 * The characters the escape pass neutralizes, and the ones it deliberately leaves
 * alone (#61). Both lists are asserted, because the second is what keeps ordinary
 * OSM addresses free of backslashes. `_` is in neither: it is escaped only at a
 * word boundary, which the dedicated cases below pin from both sides.
 */
const ESCAPED_SET = ['\\', '`', '*', '[', ']', '<', '>', '#', '|', '~'];
const UNESCAPED_SET = ['-', '.', '+', '!', '(', ')', ':', '/', '=', ',', '{', '}', "'", '"'];

describe('escapeMarkdownText (#61)', () => {
  it('escapes every character in the declared set', () => {
    expect(escapeMarkdownText(ESCAPED_SET.join(''))).toBe(
      ESCAPED_SET.map((ch) => `\\${ch}`).join(''),
    );
  });

  it('leaves every deliberately excluded character untouched', () => {
    expect(escapeMarkdownText(UNESCAPED_SET.join(''))).toBe(UNESCAPED_SET.join(''));
  });

  it('escapes the backslash so upstream text cannot forge an escape of its own', () => {
    // Upstream `\*x` must render as a literal backslash followed by a literal
    // asterisk — not as an escaped asterisk that re-arms emphasis downstream.
    expect(escapeMarkdownText('\\*x')).toBe('\\\\\\*x');
  });

  it('renders an embedded newline inert without dropping it', () => {
    expect(escapeMarkdownText('# Evil Heading\n\n**FAKE SYSTEM NOTICE**')).toBe(
      '\\# Evil Heading\\n\\n\\*\\*FAKE SYSTEM NOTICE\\*\\*',
    );
  });

  it('renders a carriage return and a CRLF pair inert', () => {
    expect(escapeMarkdownText('a\rb')).toBe('a\\rb');
    expect(escapeMarkdownText('a\r\nb')).toBe('a\\r\\nb');
  });

  it('renders angle-bracket HTML as literal text', () => {
    expect(escapeMarkdownText('<script>alert(1)</script>')).toBe(
      '\\<script\\>alert(1)\\</script\\>',
    );
  });

  it('returns ordinary OSM text unchanged', () => {
    expect(escapeMarkdownText('Pike Place Market')).toBe('Pike Place Market');
    expect(escapeMarkdownText('US-WA country_code https://spaceneedle.com')).toBe(
      'US-WA country_code https://spaceneedle.com',
    );
    expect(escapeMarkdownText('')).toBe('');
  });

  it('escapes an underscore that is not flanked by an alphanumeric', () => {
    expect(escapeMarkdownText('a _word_ b')).toBe('a \\_word\\_ b');
    expect(escapeMarkdownText('_lead')).toBe('\\_lead');
    expect(escapeMarkdownText('trail_')).toBe('trail\\_');
  });

  it('leaves an intraword underscore untouched', () => {
    const keys = 'country_code addr_full man_made ISO3166-2-lvl4';
    expect(escapeMarkdownText(keys)).toBe(keys);
  });

  it('renders a doubled-underscore bold run inert', () => {
    expect(escapeMarkdownText('__FAKE SYSTEM NOTICE__')).toBe('\\_\\_FAKE SYSTEM NOTICE\\_\\_');
  });

  /**
   * The accepted residual of the escape set: a bare URL, a bare `www.` host and a
   * bare email address stay exactly as OSM wrote them, and a GFM renderer may turn
   * each into a link on its own. Autolinking needs no upstream metacharacter, so
   * disarming it would mean mangling the value itself — which is what every one of
   * these assertions denies.
   */
  it('leaves a bare URL, a www. literal and an email readable', () => {
    const value = 'https://spaceneedle.com www.spaceneedle.com info@spaceneedle.com';
    expect(escapeMarkdownText(value)).toBe(value);
  });

  it('deletes nothing — every input character survives the escape', () => {
    const value = '# a *b* [c](d) `e` <f> |g| ~h~ \\i\\';
    // Nothing is deleted: stripping the inserted backslashes recovers the input.
    expect(escapeMarkdownText(value).replaceAll('\\\\', '\0').replaceAll('\\', '')).toBe(
      value.replaceAll('\\', '\0'),
    );
  });
});

describe('escapeMarkdownValue (#61)', () => {
  it('passes a scalar through the scalar escape set', () => {
    expect(escapeMarkdownValue('[label](https://evil.example)')).toBe(
      '\\[label\\](https://evil.example)',
    );
    expect(escapeMarkdownValue(47.6)).toBe('47.6');
  });

  it('keeps JSON array and object delimiters readable', () => {
    expect(escapeMarkdownValue([1, 2, 3])).toBe('[1,2,3]');
    expect(escapeMarkdownValue([{ lat: 47.6, lon: -122.3 }])).toBe('[{"lat":47.6,"lon":-122.3}]');
  });

  it('escapes nested free text inside the serialized blob', () => {
    expect(escapeMarkdownValue([{ type: 'way', ref: 1, role: '# *evil* <b>' }])).toBe(
      '[{"type":"way","ref":1,"role":"\\# \\*evil\\* \\<b\\>"}]',
    );
  });

  it('disarms a nested link by escaping the paren, not the bracket', () => {
    const rendered = escapeMarkdownValue([{ role: '[label](https://evil.example)' }]);
    expect(rendered).toContain('[label]\\(https://evil.example\\)');
    expect(rendered).not.toMatch(/(?<!\\)\]\(/);
  });

  it('escapes a boundary underscore inside the blob but not an intraword one', () => {
    // The JSON quotes are what put the outer underscores at a word boundary; the
    // tag key beside them is the shape that has to stay backslash-free.
    expect(escapeMarkdownValue([{ role: '__outer__', key: 'country_code' }])).toBe(
      '[{"role":"\\_\\_outer\\_\\_","key":"country_code"}]',
    );
  });

  it('neutralizes a backslash the leaf carried, so it cannot re-arm a marker', () => {
    // JSON.stringify doubles the source backslash; escaping the finished string is
    // what keeps the following asterisk from becoming live emphasis again.
    const rendered = escapeMarkdownValue([{ role: '\\*evil*' }]);
    expect(rendered).toBe('[{"role":"\\\\\\\\\\*evil\\*"}]');
  });
});

describe('appendPlaceLines', () => {
  describe('OSM ref line', () => {
    it('appends OSM ref when osm_type and osm_id are present', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { osm_type: 'node', osm_id: 240109189 });
      expect(lines).toContain('**OSM:** N240109189');
    });

    it('uses W prefix for way type', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { osm_type: 'way', osm_id: 50637691 });
      expect(lines).toContain('**OSM:** W50637691');
    });

    it('uses R prefix for relation type', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { osm_type: 'relation', osm_id: 146656 });
      expect(lines).toContain('**OSM:** R146656');
    });

    it('omits OSM ref when osm_type is absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { osm_id: 12345 });
      expect(lines.some((l) => l.includes('**OSM:**'))).toBe(false);
    });

    it('omits OSM ref when osm_id is absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { osm_type: 'node' });
      expect(lines.some((l) => l.includes('**OSM:**'))).toBe(false);
    });

    it('includes osm_id=0 (falsy but valid)', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { osm_type: 'node', osm_id: 0 });
      expect(lines).toContain('**OSM:** N0');
    });
  });

  describe('category/type line', () => {
    it('appends category with type when both present', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { category: 'man_made', type: 'tower' });
      expect(lines).toContain('**Category:** man_made / tower');
    });

    it('appends category without slash when type is absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { category: 'amenity' });
      expect(lines).toContain('**Category:** amenity');
    });

    it('omits category line when category is absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { type: 'tower' });
      expect(lines.some((l) => l.includes('**Category:**'))).toBe(false);
    });
  });

  describe('address details line', () => {
    it('appends address details including technical code keys', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {
        address: {
          road: 'Broad Street',
          city: 'Seattle',
          country_code: 'us',
          'ISO3166-2-lvl4': 'US-WA',
        },
      });
      const addrLine = lines.find((l) => l.startsWith('**Address details:**'));
      expect(addrLine).toBeDefined();
      expect(addrLine).toContain('road: Broad Street');
      expect(addrLine).toContain('city: Seattle');
      expect(addrLine).toContain('country_code: us');
      expect(addrLine).toContain('ISO3166-2-lvl4: US-WA');
    });

    it('omits address line when address is absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {});
      expect(lines.some((l) => l.includes('**Address details:**'))).toBe(false);
    });

    it('renders address details for a code-only address', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {
        address: { country_code: 'us', 'ISO3166-2-lvl4': 'US-WA' },
      });
      const addrLine = lines.find((l) => l.startsWith('**Address details:**'));
      expect(addrLine).toBeDefined();
      expect(addrLine).toContain('country_code: us');
      expect(addrLine).toContain('ISO3166-2-lvl4: US-WA');
    });

    it('omits address line when the address object is empty', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { address: {} });
      expect(lines.some((l) => l.includes('**Address details:**'))).toBe(false);
    });

    it('formats multiple address entries as key: value pairs joined by comma', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { address: { road: 'Main St', city: 'Portland' } });
      const addrLine = lines.find((l) => l.startsWith('**Address details:**'))!;
      expect(addrLine).toContain('road: Main St, city: Portland');
    });
  });

  /**
   * Characterization for #61: the value shapes that dominate real Nominatim
   * payloads carry `_`, `-`, `.`, `/`, `:` and `+`, none of which the escape pass
   * touches. Pinning the whole line — not a substring — is what would catch an
   * escape set widened until ordinary addresses grow backslashes.
   */
  describe('characters left unescaped (#61)', () => {
    it('renders underscores, hyphens, dots, slashes, colons and plus signs verbatim', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {
        address: { country_code: 'us', 'ISO3166-2-lvl4': 'US-WA', road: 'Route 66 N/S' },
        extratags: { phone: '+1-206-555-1234', website: 'https://spaceneedle.com' },
      });
      expect(lines.find((l) => l.startsWith('**Address details:**'))).toBe(
        '**Address details:** country_code: us, ISO3166-2-lvl4: US-WA, road: Route 66 N/S',
      );
      expect(lines.find((l) => l.startsWith('**Extra tags:**'))).toBe(
        '**Extra tags:** phone: +1-206-555-1234, website: https://spaceneedle.com',
      );
    });

    it('escapes hostile address values, extratags keys and values, and the category', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {
        category: '# cat',
        type: '*type*',
        address: { road: '[Main](https://evil.example)' },
        extratags: { '<script>': 'a\nb' },
      });
      expect(lines).toContain('**Category:** \\# cat / \\*type\\*');
      expect(lines).toContain('**Address details:** road: \\[Main\\](https://evil.example)');
      expect(lines).toContain('**Extra tags:** \\<script\\>: a\\nb');
      // Nothing renders as an active construct or spills onto a line of its own.
      // Splitting the joined text is what makes the second assertion real: `lines`
      // holds composed lines, so the tail of the newline value could only ever
      // appear inside one of them, never as an element of the array.
      expect(lines.join('\n')).not.toContain('<script>');
      expect(lines.join('\n').split('\n')).not.toContain('b');
    });

    it('renders a plain category and bounding box verbatim', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {
        category: 'man_made',
        type: 'tower',
        boundingbox: ['47.619', '47.622', '-122.352', '-122.347'],
      });
      expect(lines[0]).toBe('**Category:** man_made / tower');
      expect(lines[1]).toBe('**Bounding box:** S:47.619 N:47.622 W:-122.352 E:-122.347');
    });
  });

  describe('bounding box line', () => {
    it('appends bounding box with all four compass points', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {
        boundingbox: ['47.619', '47.622', '-122.352', '-122.347'],
      });
      expect(lines).toContain('**Bounding box:** S:47.619 N:47.622 W:-122.352 E:-122.347');
    });

    it('omits bounding box line when absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {});
      expect(lines.some((l) => l.includes('**Bounding box:**'))).toBe(false);
    });
  });

  describe('extratags line', () => {
    it('appends extratags when present and non-empty', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {
        extratags: { wikidata: 'Q178640', website: 'https://spaceneedle.com' },
      });
      const extraLine = lines.find((l) => l.startsWith('**Extra tags:**'));
      expect(extraLine).toBeDefined();
      expect(extraLine).toContain('wikidata: Q178640');
      expect(extraLine).toContain('website: https://spaceneedle.com');
    });

    it('omits extratags line when extratags is absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {});
      expect(lines.some((l) => l.includes('**Extra tags:**'))).toBe(false);
    });

    it('omits extratags line when extratags is an empty object', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, { extratags: {} });
      expect(lines.some((l) => l.includes('**Extra tags:**'))).toBe(false);
    });
  });

  describe('full combination', () => {
    it('produces all lines in order when all fields are present', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {
        osm_type: 'node',
        osm_id: 123,
        category: 'amenity',
        type: 'cafe',
        address: { road: 'Main St' },
        boundingbox: ['47.6', '47.7', '-122.4', '-122.3'],
        extratags: { phone: '+1-206-555-1234' },
      });
      expect(lines[0]).toContain('**OSM:** N123');
      expect(lines[1]).toContain('**Category:** amenity / cafe');
      expect(lines[2]).toContain('**Address details:**');
      expect(lines[3]).toContain('**Bounding box:**');
      expect(lines[4]).toContain('**Extra tags:**');
    });

    it('produces empty array when all fields are absent', () => {
      const lines: string[] = [];
      appendPlaceLines(lines, {});
      expect(lines).toHaveLength(0);
    });
  });
});
