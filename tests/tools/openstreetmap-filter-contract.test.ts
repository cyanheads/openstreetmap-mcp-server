/**
 * @fileoverview Overpass convenience filters through input, service, and both response surfaces.
 * @module tests/tools/openstreetmap-filter-contract.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapQueryBbox } from '@/mcp-server/tools/definitions/openstreetmap-query-bbox.tool.js';
import { openstreetmapQueryNearby } from '@/mcp-server/tools/definitions/openstreetmap-query-nearby.tool.js';
import { initOverpassService } from '@/services/overpass/overpass-service.js';
import type { OverpassElement } from '@/services/overpass/types.js';
import { markdownText } from '../helpers/markdown.js';

const ENDPOINT = 'https://overpass.example/api/interpreter';
/** How the response names `ENDPOINT` on both surfaces (#91). */
const ENDPOINT_ORIGIN = 'https://overpass.example';
const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    overpassBaseUrl: ENDPOINT,
    overpassMaxConcurrency: 2,
    nominatimUserAgent: 'openstreetmap-mcp-server/test',
  }),
}));

/**
 * What the around query prints after `out center tags;` for the ways and relations its
 * distance ranking measures (#103). Both tools ended at that line before; bbox still does.
 */
function aroundTail(relations: boolean): string[] {
  const circle = '(47.5909100,-122.3134829,47.6090900,-122.2865171)';
  const strip = '(47.5999999,-122.3000001,90.0000000,-122.2999999)';
  return [
    '(._;)->.matched;',
    'make nearby_nearest;',
    'out;',
    'way.matched;',
    `out ids geom${circle};`,
    ...(relations
      ? [
          'rel.matched->.rels;',
          `foreach.rels->.r(.r out ids;way(r.r)${circle};out ids geom${circle};node(r.r)${circle};out skel;);`,
        ]
      : []),
    'make nearby_strip;',
    'out;',
    `way.matched(if:is_closed())["area"!="no"]${strip};`,
    `out ids geom${strip};`,
    ...(relations
      ? [
          `rel.matched["type"~"^(multipolygon|boundary)$"]${strip}->.areas;`,
          `foreach.areas->.r(.r out ids;way(r.r)${strip};out ids geom${strip};);`,
        ]
      : []),
  ];
}

const cases = [
  {
    definition: openstreetmapQueryNearby,
    geo: { lat: 47.6, lon: -122.3 },
    spatial: '(around:1000,47.6,-122.3)',
    tail: aroundTail,
  },
  {
    definition: openstreetmapQueryBbox,
    geo: { south: 47.5, west: -122.5, north: 47.7, east: -122.2 },
    spatial: '(47.5,-122.5,47.7,-122.2)',
    tail: (_relations: boolean): string[] => [],
  },
];

/** The `content[]` text a client reads. */
function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

for (const { definition, geo, spatial, tail } of cases) {
  describe(`${definition.name} filter contract`, () => {
    let http: ReturnType<typeof createFetchMock>;
    let elements: OverpassElement[];

    /** The QL of each submission, in order. */
    async function sentQueries(): Promise<(string | null)[]> {
      return Promise.all(
        http.calls.map(async ({ request }) =>
          new URLSearchParams(await request.text()).get('data'),
        ),
      );
    }

    beforeEach(() => {
      initOverpassService({} as AppConfig, {} as StorageService);
      elements = [{ type: 'node', id: 7, lat: 47.6, lon: -122.3, tags: { name: 'Cafe' } }];
      http = createFetchMock([
        {
          method: 'POST',
          match: ENDPOINT,
          respond: () =>
            Response.json({
              version: 0.6,
              elements,
            }),
        },
      ]);
      http.install();
    });

    afterEach(() => http.restore());

    it('rejects a misspelled filter field instead of broadening equality to existence', async () => {
      const result = await runToolContract(definition, {
        ...geo,
        amenity: 'restaurant',
        filters: [{ key: 'cuisine', values: 'italian' }],
      } as never);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          message: expect.stringContaining('values'),
        },
      });
      const text = result.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      expect(text).toContain('values');
      expect(http.calls).toHaveLength(0);
    });

    it.each([
      { amenity: ' cafe ' },
      { tag_key: ' amenity ', tag_value: ' cafe ' },
      { amenity: ' cafe ', tag_key: ' ', tag_value: '' },
      // #83: an explicit exact mode is the legacy call, byte for byte.
      { tag_key: ' amenity ', tag_value: ' cafe ', tag_value_match: 'exact' as const },
      { amenity: ' cafe ', tag_value_match: 'exact' as const },
    ])('characterizes legacy single-pair calls: %j', async (tag) => {
      const result = await runToolContract(definition, { ...geo, ...tag });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        elements: [
          {
            osm_type: 'node',
            osm_id: 7,
            lat: 47.6,
            lon: -122.3,
            name: 'Cafe',
            tags: { name: 'Cafe' },
            ...(definition === openstreetmapQueryNearby ? { distance_meters: 0 } : {}),
          },
        ],
        attribution: ATTRIBUTION,
        effectiveTag: 'amenity=cafe',
        totalFound: 1,
        truncated: false,
        servingEndpoint: ENDPOINT_ORIGIN,
      });
      const text = result.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      expect(text).toMatch(/^\*\*Served By:\*\* https:\/\/overpass\.example$/m);
      expect(text).toContain('**Tag Filter:** amenity=cafe');
      expect(text).toContain('**OSM:** N7');
      expect(text).toContain('**Coordinates:** 47.6, -122.3');
      expect(text).toContain(ATTRIBUTION);
      expect(http.calls).toHaveLength(1);
      const ql = new URLSearchParams(await http.calls[0]!.request.text()).get('data');
      expect(ql).toBe(
        [
          '[out:json][timeout:25][maxsize:268435456];',
          '(',
          `  node["amenity"="cafe"]${spatial};`,
          `  way["amenity"="cafe"]${spatial};`,
          ');',
          'out center tags;',
          ...tail(false),
        ].join('\n'),
      );
    });

    it.each([
      { tag: { tag_key: ' shop ' }, ql: '["shop"]', echo: 'shop' },
      { tag: { tag_key: 'shop', filters: [] }, ql: '["shop"]', echo: 'shop' },
      { tag: { amenity: 'cafe', filters: [] }, ql: '["amenity"="cafe"]', echo: 'amenity=cafe' },
      {
        tag: { amenity: ' restaurant ', filters: [{ key: ' cuisine ', value: ' italian ' }] },
        ql: '["amenity"="restaurant"]["cuisine"="italian"]',
        echo: 'amenity=restaurant, cuisine=italian',
      },
      {
        tag: {
          tag_key: 'leisure',
          tag_value: 'park',
          filters: [{ key: 'name' }, { key: 'website' }],
        },
        ql: '["leisure"="park"]["name"]["website"]',
        echo: 'leisure=park, name, website',
      },
      {
        tag: {
          tag_key: ' shop ',
          filters: [{ key: 'name', value: ' Café House ' }, { key: 'website' }],
        },
        ql: '["shop"]["name"="Café House"]["website"]',
        echo: 'shop, name=Café House, website',
      },
      {
        tag: {
          amenity: 'restaurant',
          tag_key: ' ',
          tag_value: '',
          filters: [
            { key: 'cuisine', value: 'italian' },
            { key: 'name' },
            { key: 'website' },
            { key: 'wheelchair', value: 'yes' },
            { key: 'outdoor_seating' },
          ],
        },
        ql: '["amenity"="restaurant"]["cuisine"="italian"]["name"]["website"]["wheelchair"="yes"]["outdoor_seating"]',
        echo: 'amenity=restaurant, cuisine=italian, name, website, wheelchair=yes, outdoor_seating',
      },
      {
        tag: {
          tag_key: 'amenity',
          tag_value: 'restaurant',
          tag_value_match: 'exact' as const,
          filters: [
            { key: ' cuisine ', value: ' italian ', match: 'exact' as const },
            { key: 'name' },
          ],
        },
        ql: '["amenity"="restaurant"]["cuisine"="italian"]["name"]',
        echo: 'amenity=restaurant, cuisine=italian, name',
      },
      // #83: list-item membership, the acceptance case and its primary-tag twin.
      {
        tag: {
          amenity: 'restaurant',
          filters: [{ key: 'cuisine', value: 'pizza', match: 'list_item' as const }],
        },
        ql: '["amenity"="restaurant"]["cuisine"~"(^|;) *pizza *(;|$)"]',
        echo: 'amenity=restaurant, cuisine∋pizza',
      },
      {
        tag: {
          tag_key: ' sport ',
          tag_value: ' soccer ',
          tag_value_match: 'list_item' as const,
          filters: [{ key: 'name' }],
        },
        ql: '["sport"~"(^|;) *soccer *(;|$)"]["name"]',
        echo: 'sport∋soccer, name',
      },
      {
        tag: { tag_key: 'k', filters: [{ key: 'v', value: 'a.b*', match: 'list_item' as const }] },
        ql: String.raw`["k"]["v"~"(^|;) *a\\.b\\* *(;|$)"]`,
        echo: 'k, v∋a.b*',
      },
    ])('emits the entire literal chain on both surfaces: $echo', async ({ tag, ql, echo }) => {
      const result = await runToolContract(definition, {
        ...geo,
        ...tag,
        element_types: ['node', 'way', 'relation'],
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        effectiveTag: echo,
        totalFound: 1,
        truncated: false,
      });
      const text = result.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      expect(markdownText(text)).toContain(`Tag Filter: ${echo}`);
      expect(text).toContain('**OSM:** N7');
      const query = new URLSearchParams(await http.calls[0]!.request.text()).get('data');
      expect(query).toBe(
        [
          '[out:json][timeout:25][maxsize:268435456];',
          '(',
          `  node${ql}${spatial};`,
          `  way${ql}${spatial};`,
          `  relation${ql}${spatial};`,
          ');',
          'out center tags;',
          ...tail(true),
        ].join('\n'),
      );
      expect(query).not.toContain('=""');
    });

    it.each([
      { tag_key: 'shop', tag_value: '' },
      { tag_key: 'shop', tag_value: ' \t ' },
      { filters: [{ key: 'shop' }] },
      { amenity: 'cafe', tag_key: 'shop' },
      { amenity: 'cafe', tag_value: 'bakery' },
      { amenity: 'cafe', filters: [{ key: '' }] },
      { amenity: 'cafe', filters: [{ key: ' \t ' }] },
      { amenity: 'cafe', filters: [{ key: 'name', value: '' }] },
      { amenity: 'cafe', filters: [{ key: 'name', value: ' \t ' }] },
      { amenity: 'cafe', filters: [{ key: ' amenity ', value: 'cafe' }] },
      { tag_key: ' shop ', filters: [{ key: 'shop' }] },
      { amenity: 'cafe', filters: [{ key: 'name' }, { key: ' name ', value: 'Cafe' }] },
      { amenity: 'cafe', filters: [{ key: 'name' }, { key: 'website', value: 'x\\y' }] },
      { tag_key: 'shop', filters: [{ key: 'name' }, { key: ' website][' }] },
      // #83: the metacharacter set in list-item mode. Its full table, and every value-less
      // list-item form, are resolveTagInput's (openstreetmap-tag-input.test.ts).
      { tag_key: 'cuisine', tag_value: 'pi"za', tag_value_match: 'list_item' as const },
    ])('rejects invalid domain input before HTTP with recovery: %j', async (tag) => {
      const result = await runToolContract(definition, { ...geo, ...tag });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'invalid_tag',
            recovery: { hint: expect.stringContaining('omit') },
          },
        },
      });
      const text = result.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      expect(text).toContain('openstreetmap_query_raw');
      expect(text).toContain('omit');
      expect(http.calls).toHaveLength(0);
    });

    it.each([0, 1, 2, 9])(
      'preserves sorted pages and full-chain guidance at offset %i',
      async (offset) => {
        elements = [3, 1, 2].map((id) => ({
          type: 'node',
          id,
          lat: 47.6 + id * 0.001,
          lon: -122.3,
        }));
        const result = await runToolContract(definition, {
          ...geo,
          tag_key: 'shop',
          filters: [{ key: 'name' }],
          offset,
          limit: 1,
        });
        expect(result.isError).not.toBe(true);
        const ids = definition === openstreetmapQueryNearby ? [1, 2, 3] : [3, 1, 2];
        expect(result.structuredContent).toMatchObject({
          elements: offset < 3 ? [{ osm_id: ids[offset] }] : [],
          effectiveTag: 'shop, name',
          totalFound: 3,
          truncated: offset < 2,
          ...(offset < 2 ? { nextOffset: offset + 1 } : {}),
        });
        const text = result.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n');
        expect(text).toContain('**Tag Filter:** shop, name');
        expect(text).toContain('**Total Found:** 3');
        if (offset < 2) expect(text).toContain(`**Next Offset:** ${offset + 1}`);
        else expect(result.structuredContent).not.toHaveProperty('nextOffset');
        if (offset > 2) {
          expect(result.structuredContent).toHaveProperty(
            'notice',
            expect.stringContaining('3 shop, name features matched'),
          );
          expect(text).toContain('Offset 9 is past the end');
          expect(text).toContain('shop, name');
        } else {
          expect(text).toContain(`**OSM:** N${ids[offset]}`);
        }
      },
    );

    it('reports a genuine empty chain query on both surfaces', async () => {
      elements = [];
      const result = await runToolContract(definition, {
        ...geo,
        tag_key: 'shop',
        filters: [{ key: 'website' }],
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        elements: [],
        totalFound: 0,
        truncated: false,
        effectiveTag: 'shop, website',
        notice: expect.stringContaining('No shop, website features found'),
      });
      const text = result.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      expect(text).toContain('No shop, website features found');
      expect(text).toContain('**Tag Filter:** shop, website');
      expect(text).toContain('0 features returned');
    });

    /**
     * #70: the two-offset form degenerates when the whole match set fits in one
     * page — `total - limit` floors to 0, so both alternatives read "offset 0".
     * Asserted through the contract so the replacement is pinned on the surface a
     * `content[]`-only client reads as well as on `structuredContent`.
     */
    it.each([
      { label: 'total below the limit', limit: 5 },
      { label: 'total equal to the limit', limit: 3 },
    ])(
      'names one retry offset on both surfaces when the match set fits in one page ($label)',
      async ({ limit }) => {
        elements = [3, 1, 2].map((id) => ({
          type: 'node',
          id,
          lat: 47.6 + id * 0.001,
          lon: -122.3,
        }));
        const result = await runToolContract(definition, {
          ...geo,
          tag_key: 'shop',
          filters: [{ key: 'name' }],
          offset: 40,
          limit,
        });

        const tail =
          definition === openstreetmapQueryNearby
            ? 'matched within 1000m'
            : 'matched in the specified bounding box';
        const expected = `Offset 40 is past the end of the result set: 3 shop, name features ${tail}, which fit in one page of ${limit}. Retry with offset 0.`;
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          elements: [],
          totalFound: 3,
          notice: expected,
        });
        const text = result.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n');
        expect(text).toContain(expected);
        expect(text).not.toContain('for the last page');
      },
    );

    it('caches the full chain across pages and isolates a changed later filter', async () => {
      elements = [3, 1, 2].map((id) => ({ type: 'node', id, lat: 47.6 + id * 0.001, lon: -122.3 }));
      const ctx = createMockContext({ errors: definition.errors });
      for (const offset of [0, 1, 2]) {
        const input = definition.input.parse({
          ...geo,
          tag_key: 'shop',
          filters: [{ key: 'name' }, { key: 'website' }],
          offset,
          limit: 1,
        });
        const page = await definition.handler(input as never, ctx);
        expect(page.elements).toHaveLength(1);
      }
      expect(http.calls).toHaveLength(1);
      await definition.handler(
        definition.input.parse({
          ...geo,
          tag_key: 'shop',
          filters: [{ key: 'name' }, { key: 'phone' }],
        }) as never,
        ctx,
      );
      expect(http.calls).toHaveLength(2);
      const queries = await Promise.all(
        http.calls.map(async ({ request }) =>
          new URLSearchParams(await request.text()).get('data'),
        ),
      );
      expect(queries[0]).toContain('["shop"]["name"]["website"]');
      expect(queries[1]).toContain('["shop"]["name"]["phone"]');
    });

    it('names the missing list-item value on both surfaces before HTTP, with recovery (#83)', async () => {
      const result = await runToolContract(definition, {
        ...geo,
        tag_key: 'cuisine',
        tag_value_match: 'list_item',
      });
      const message =
        'A list_item match needs a value to match: pair it with tag_value or a filter value. The amenity shortcut takes no match mode; use tag_key "amenity" with tag_value instead.';
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          message,
          data: { reason: 'invalid_tag', recovery: { hint: expect.stringContaining('omit') } },
        },
      });
      const text = textOf(result);
      expect(text).toContain(message);
      expect(text).toContain('openstreetmap_query_raw');
      expect(text).toContain('omit');
      expect(http.calls).toHaveLength(0);
    });

    it('pages a list-item chain from one cached fetch and names it past the end (#83)', async () => {
      elements = [3, 1, 2].map((id) => ({ type: 'node', id, lat: 47.6 + id * 0.001, lon: -122.3 }));
      const list = {
        ...geo,
        tag_key: 'cuisine',
        tag_value: 'pizza',
        tag_value_match: 'list_item' as const,
        limit: 1,
      };
      const ctx = createMockContext({ errors: definition.errors });
      for (const offset of [0, 1, 2]) {
        const page = await definition.handler(
          definition.input.parse({ ...list, offset }) as never,
          ctx,
        );
        expect(page.elements).toHaveLength(1);
      }
      expect(http.calls).toHaveLength(1);

      // The exact spelling of the same pair is a different query, so a different cache entry.
      await definition.handler(
        definition.input.parse({ ...geo, tag_key: 'cuisine', tag_value: 'pizza' }) as never,
        ctx,
      );
      expect(http.calls).toHaveLength(2);

      const past = await runToolContract(definition, { ...list, offset: 7 });
      const tail =
        definition === openstreetmapQueryNearby
          ? 'matched within 1000m. Retry with offset 2 for the last page, or offset 0 for the nearest matches.'
          : 'matched in the specified bounding box. Retry with offset 2 for the last page, or offset 0 for the first.';
      const notice = `Offset 7 is past the end of the result set: 3 cuisine∋pizza features ${tail}`;
      expect(past.structuredContent).toMatchObject({ elements: [], notice });
      expect(textOf(past)).toContain(`> ${notice}`);
      const queries = await sentQueries();
      expect(queries[0]).toContain('["cuisine"~"(^|;) *pizza *(;|$)"]');
      expect(queries[1]).toContain('["cuisine"="pizza"]');
    });

    /**
     * #84: `amenity=museum` is a stray of `tourism=museum`. The hint is advisory — the
     * query, the elements, and the counts are exactly what the same call returned before —
     * and it rides `notice`, composed once per call so no branch overwrites it.
     */
    describe('amenity-stray hint (#84)', () => {
      const HINT =
        'In OpenStreetMap this category is tagged tourism=museum, not amenity=museum; retry with tag_key "tourism" and tag_value "museum".';
      const scope =
        definition === openstreetmapQueryNearby ? 'within 1000m' : 'in the specified bounding box';
      const generic =
        definition === openstreetmapQueryNearby
          ? 'Try a larger radius_meters, a different tag, or verify the coordinates.'
          : 'Try a larger bbox, a different tag, or verify the coordinates.';

      it.each([{ amenity: 'museum' }, { tag_key: 'amenity', tag_value: 'museum' }])(
        'replaces the generic advice on an empty page, on both surfaces: %j',
        async (tag) => {
          elements = [];
          const result = await runToolContract(definition, { ...geo, ...tag });
          const notice = `No amenity=museum features found ${scope}. ${HINT}`;
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toMatchObject({ elements: [], totalFound: 0, notice });
          expect(textOf(result)).toContain(`> ${notice}`);
          expect(textOf(result)).not.toContain(generic);
          expect((await sentQueries())[0]).toBe(
            [
              '[out:json][timeout:25][maxsize:268435456];',
              '(',
              `  node["amenity"="museum"]${spatial};`,
              `  way["amenity"="museum"]${spatial};`,
              ');',
              'out center tags;',
              ...tail(false),
            ].join('\n'),
          );
        },
      );

      it('carries the hint alone on a page of matches, leaving the page unchanged', async () => {
        elements = [1, 2].map((id) => ({
          type: 'node',
          id,
          lat: 47.6 + id * 0.001,
          lon: -122.3,
          tags: { amenity: 'museum' },
        }));
        const result = await runToolContract(definition, { ...geo, amenity: 'museum', limit: 1 });
        expect(result.structuredContent).toMatchObject({
          elements: [{ osm_id: 1 }],
          effectiveTag: 'amenity=museum',
          totalFound: 2,
          truncated: true,
          nextOffset: 1,
          notice: HINT,
        });
        expect(textOf(result)).toContain(`> ${HINT}`);
        expect(textOf(result)).toContain('**OSM:** N1');
      });

      it('follows the paging notice with the hint when the offset runs past the end', async () => {
        elements = [1, 2, 3].map((id) => ({
          type: 'node',
          id,
          lat: 47.6 + id * 0.001,
          lon: -122.3,
          tags: { amenity: 'museum' },
        }));
        const result = await runToolContract(definition, {
          ...geo,
          tag_key: 'amenity',
          tag_value: 'museum',
          offset: 9,
          limit: 2,
        });
        const first = definition === openstreetmapQueryNearby ? 'the nearest matches' : 'the first';
        const notice = `Offset 9 is past the end of the result set: 3 amenity=museum features matched ${scope}. Retry with offset 1 for the last page, or offset 0 for ${first}. ${HINT}`;
        expect(result.structuredContent).toMatchObject({ elements: [], totalFound: 3, notice });
        expect(textOf(result)).toContain(`> ${notice}`);
      });

      /** Also the ∋ chain in the empty-page notice (#83), on both surfaces. */
      it('fires on a list-item match of the same tag', async () => {
        elements = [];
        const result = await runToolContract(definition, {
          ...geo,
          tag_key: 'amenity',
          tag_value: 'museum',
          tag_value_match: 'list_item',
        });
        const notice = `No amenity∋museum features found ${scope}. ${HINT}`;
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          elements: [],
          effectiveTag: 'amenity∋museum',
          notice,
        });
        expect(textOf(result)).toContain(`> ${notice}`);
        expect(textOf(result)).toContain('**Tag Filter:** amenity∋museum');
      });

      /**
       * Wiring only: the tool reads the primary tag, never a filter. Which tags map is
       * `amenityStrayHint`'s table (openstreetmap-amenity-strays.test.ts).
       */
      it.each([
        { label: 'an unmapped value', tag: { amenity: 'restaurant' }, echo: 'amenity=restaurant' },
        {
          label: 'amenity inside filters',
          tag: { tag_key: 'building', filters: [{ key: 'amenity', value: 'museum' }] },
          echo: 'building, amenity=museum',
        },
      ])('keeps today’s notices for $label', async ({ tag, echo }) => {
        elements = [];
        const empty = await runToolContract(definition, { ...geo, ...tag });
        expect(empty.structuredContent).toMatchObject({
          notice: `No ${echo} features found ${scope}. ${generic}`,
        });
        expect(textOf(empty)).not.toContain('In OpenStreetMap');

        elements = [{ type: 'node', id: 7, lat: 47.6, lon: -122.3, tags: { name: 'Cafe' } }];
        const page = await runToolContract(definition, { ...geo, ...tag });
        expect(page.structuredContent).toMatchObject({ totalFound: 1, effectiveTag: echo });
        expect(page.structuredContent).not.toHaveProperty('notice');
        expect(textOf(page)).not.toContain('In OpenStreetMap');
      });
    });
  });
}
