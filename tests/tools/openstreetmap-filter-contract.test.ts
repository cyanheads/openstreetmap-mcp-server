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

const ENDPOINT = 'https://overpass.example/api/interpreter';
const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    overpassBaseUrl: ENDPOINT,
    overpassMaxConcurrency: 2,
    nominatimUserAgent: 'openstreetmap-mcp-server/test',
  }),
}));

const cases = [
  {
    definition: openstreetmapQueryNearby,
    geo: { lat: 47.6, lon: -122.3 },
    spatial: '(around:1000,47.6,-122.3)',
  },
  {
    definition: openstreetmapQueryBbox,
    geo: { south: 47.5, west: -122.5, north: 47.7, east: -122.2 },
    spatial: '(47.5,-122.5,47.7,-122.2)',
  },
];

for (const { definition, geo, spatial } of cases) {
  describe(`${definition.name} filter contract`, () => {
    let http: ReturnType<typeof createFetchMock>;
    let elements: OverpassElement[];

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
        servingEndpoint: ENDPOINT,
      });
      const text = result.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      expect(text).toContain('**Tag Filter:** amenity=cafe');
      expect(text).toContain('**OSM:** N7');
      expect(text).toContain('**Coordinates:** 47.6, -122.3');
      expect(text).toContain(ATTRIBUTION);
      expect(http.calls).toHaveLength(1);
      const ql = new URLSearchParams(await http.calls[0]!.request.text()).get('data');
      expect(ql).toBe(
        [
          '[out:json][timeout:25];',
          '(',
          `  node["amenity"="cafe"]${spatial};`,
          `  way["amenity"="cafe"]${spatial};`,
          ');',
          'out center tags;',
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
      expect(text).toContain(`**Tag Filter:** ${echo}`);
      expect(text).toContain('**OSM:** N7');
      const query = new URLSearchParams(await http.calls[0]!.request.text()).get('data');
      expect(query).toBe(
        [
          '[out:json][timeout:25];',
          '(',
          `  node${ql}${spatial};`,
          `  way${ql}${spatial};`,
          `  relation${ql}${spatial};`,
          ');',
          'out center tags;',
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
  });
}
