/**
 * @fileoverview The `within` boundary scope on openstreetmap_query_bbox — generated QL,
 * both response surfaces, scope exclusivity, and the unresolved-boundary notice (#71).
 * @module tests/tools/openstreetmap-within-scope.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapQueryBbox } from '@/mcp-server/tools/definitions/openstreetmap-query-bbox.tool.js';
import { initOverpassService } from '@/services/overpass/overpass-service.js';
import { type ContractError, captureThrown } from '../helpers/handler-error.js';

const ENDPOINT = 'https://overpass.example/api/interpreter';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    overpassBaseUrl: ENDPOINT,
    overpassMaxConcurrency: 2,
    nominatimUserAgent: 'openstreetmap-mcp-server/test',
  }),
}));

/**
 * Overpass answers a `within` query with an `out count;` sentinel ahead of the matches.
 * Captured verbatim from `overpass-api.de` (Overpass API 0.7.62.11) for
 * `rel(237385);map_to_area->.a;.a out count;(node["amenity"="university"](area.a);…)` —
 * the six universities inside the Seattle city relation, trimmed to one node and one way.
 *
 * Fed through the service unchanged: the sentinel has to survive `parseOverpassBody` and
 * `normalizeElements` the way the endpoint sends it, not pre-stripped by a stub.
 */
const RESOLVED_RELATION_BODY = {
  version: 0.6,
  generator: 'Overpass API 0.7.62.11 87bfad18',
  osm3s: {
    timestamp_osm_base: '2026-09-16T20:43:48Z',
    timestamp_areas_base: '2026-09-16T05:04:09Z',
    copyright: 'The data included in this document is from www.openstreetmap.org.',
  },
  elements: [
    {
      type: 'count',
      id: 0,
      tags: { nodes: '0', ways: '0', relations: '0', areas: '1', total: '1' },
    },
    {
      type: 'node',
      id: 2312065990,
      lat: 47.6227393,
      lon: -122.3374244,
      tags: { amenity: 'university', name: 'Northeastern University - Seattle 401' },
    },
    {
      type: 'way',
      id: 39091998,
      center: { lat: 47.6553, lon: -122.3035 },
      tags: { amenity: 'university', name: 'University of Washington' },
    },
  ],
};

/**
 * A ref that reached no area. Overpass answers HTTP 200 with no `remark` either way, so
 * `total: "0"` on the sentinel is the only thing separating this from a boundary that
 * resolved and matched nothing.
 */
const UNRESOLVED_BODY = {
  version: 0.6,
  osm3s: {
    timestamp_osm_base: '2026-09-16T20:43:48Z',
    timestamp_areas_base: '2026-09-14T22:47:02Z',
  },
  elements: [
    {
      type: 'count',
      id: 0,
      tags: { nodes: '0', ways: '0', relations: '0', areas: '0', total: '0' },
    },
  ],
};

/** A closed way resolves too, and counts under `ways` rather than `areas`. */
function resolvedWayBody(elements: unknown[]) {
  return {
    version: 0.6,
    osm3s: {
      timestamp_osm_base: '2026-09-16T20:52:55Z',
      timestamp_areas_base: '2026-09-16T05:04:09Z',
    },
    elements: [
      {
        type: 'count',
        id: 0,
        tags: { nodes: '0', ways: '1', relations: '0', areas: '0', total: '1' },
      },
      ...elements,
    ],
  };
}

function textOf(content: { type: string; text?: string }[]): string {
  return content.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : [])).join('\n');
}

describe('openstreetmap_query_bbox within scope (#71)', () => {
  let http: ReturnType<typeof createFetchMock>;
  let body: unknown;

  beforeEach(() => {
    initOverpassService({} as AppConfig, {} as StorageService);
    body = RESOLVED_RELATION_BODY;
    http = createFetchMock([
      { method: 'POST', match: ENDPOINT, respond: () => Response.json(body) },
    ]);
    http.install();
  });

  afterEach(() => http.restore());

  async function sentQl(): Promise<string> {
    const request = http.calls[0]?.request;
    if (!request) throw new Error('no Overpass request was made');
    return new URLSearchParams(await request.text()).get('data') ?? '';
  }

  describe('generated QL', () => {
    it('maps a relation ref through map_to_area and emits the count sentinel', async () => {
      await runToolContract(openstreetmapQueryBbox, {
        within: 'R237385',
        amenity: 'university',
      });
      expect(await sentQl()).toBe(
        [
          '[out:json][timeout:25];',
          'rel(237385);map_to_area->.a;',
          '.a out count;',
          '(',
          '  node["amenity"="university"](area.a);',
          '  way["amenity"="university"](area.a);',
          ');',
          'out center tags;',
        ].join('\n'),
      );
    });

    it('maps a way ref through map_to_area with no id arithmetic', async () => {
      body = resolvedWayBody([]);
      await runToolContract(openstreetmapQueryBbox, {
        within: 'W13800188',
        tag_key: 'amenity',
      });
      const ql = await sentQl();
      expect(ql).toContain('way(13800188);map_to_area->.a;');
      // The 2400000000 offset was removed in Overpass 0.7.57 and resolves to no area.
      expect(ql).not.toContain('2413800188');
      expect(ql).not.toContain('area(');
    });

    it('accepts a lowercase ref and keeps the full AND filter chain under the area scope', async () => {
      await runToolContract(openstreetmapQueryBbox, {
        within: 'r237385',
        tag_key: 'amenity',
        tag_value: 'university',
        filters: [{ key: 'operator' }, { key: 'wheelchair', value: 'yes' }],
        element_types: ['node'],
        timeout_seconds: 40,
      });
      expect(await sentQl()).toBe(
        [
          '[out:json][timeout:40];',
          'rel(237385);map_to_area->.a;',
          '.a out count;',
          '(',
          '  node["amenity"="university"]["operator"]["wheelchair"="yes"](area.a);',
          ');',
          'out center tags;',
        ].join('\n'),
      );
    });

    it('keeps the four-corner path untouched', async () => {
      await runToolContract(openstreetmapQueryBbox, {
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        amenity: 'university',
      });
      expect(await sentQl()).toBe(
        [
          '[out:json][timeout:25];',
          '(',
          '  node["amenity"="university"](47.5,-122.5,47.7,-122.2);',
          '  way["amenity"="university"](47.5,-122.5,47.7,-122.2);',
          ');',
          'out center tags;',
        ].join('\n'),
      );
    });
  });

  describe('resolved boundary, on both surfaces', () => {
    it('returns the matches without the sentinel and echoes effectiveArea', async () => {
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'R237385',
        amenity: 'university',
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        elements: [
          { osm_type: 'node', osm_id: 2312065990 },
          { osm_type: 'way', osm_id: 39091998 },
        ],
        totalFound: 2,
        truncated: false,
        effectiveTag: 'amenity=university',
        effectiveArea: 'R237385 → Overpass area 3600237385 (relation 237385)',
        areasTimestamp: '2026-09-16T05:04:09Z',
        data_timestamp: '2026-09-16T20:43:48Z',
      });
      // The count sentinel is not an OSM feature and must never reach the caller.
      const elements = (result.structuredContent as { elements: { osm_type: string }[] }).elements;
      expect(elements.map((el) => el.osm_type)).toEqual(['node', 'way']);
      expect(result.structuredContent).not.toHaveProperty('notice');

      const text = textOf(result.content);
      expect(text).toContain('2 features returned');
      expect(text).toContain('**Scope:** R237385 → Overpass area 3600237385 (relation 237385)');
      expect(text).toContain('**Areas Data As Of:** 2026-09-16T05:04:09Z');
      expect(text).toContain('University of Washington');
      expect(text).not.toContain('count');
    });

    it('names the closed way rather than a computed area id for a W ref', async () => {
      body = resolvedWayBody([
        {
          type: 'node',
          id: 1726737152,
          lat: 47.6320134,
          lon: -122.3150608,
          tags: { amenity: 'toilets' },
        },
      ]);
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'w13800188',
        amenity: 'toilets',
      });
      expect(result.structuredContent).toMatchObject({
        totalFound: 1,
        effectiveArea: 'W13800188 → Overpass area of closed way 13800188',
      });
      expect(textOf(result.content)).toContain(
        '**Scope:** W13800188 → Overpass area of closed way 13800188',
      );
    });

    it('reports a resolved boundary that matched nothing with the ordinary empty notice', async () => {
      body = {
        version: 0.6,
        elements: [
          {
            type: 'count',
            id: 0,
            tags: { nodes: '0', ways: '0', relations: '0', areas: '1', total: '1' },
          },
        ],
      };
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'R237385',
        tag_key: 'shop',
        tag_value: 'kiosk',
      });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain('No shop=kiosk features found inside R237385');
      expect(notice).not.toContain('did not resolve');
      expect(textOf(result.content)).toContain('No shop=kiosk features found inside R237385');
    });
  });

  describe('unresolved boundary', () => {
    it('returns an empty page naming the cause on both surfaces, not a bare zero', async () => {
      body = UNRESOLVED_BODY;
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'R999999999',
        amenity: 'university',
      });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as { elements: unknown[]; notice: string };
      expect(structured.elements).toEqual([]);
      expect(result.structuredContent).toMatchObject({ totalFound: 0, truncated: false });
      for (const surface of [structured.notice, textOf(result.content)]) {
        expect(surface).toContain('R999999999 did not resolve to an Overpass area');
        expect(surface).toContain('unclosed way');
        expect(surface).toContain('boundary or area-forming tag');
        expect(surface).toContain('openstreetmap_lookup_objects');
      }
      // Distinct from the nothing-matched case, which blames the tag rather than the ref.
      expect(structured.notice).not.toContain('features found inside');
    });

    it('still echoes the scope so the caller can see which ref failed', async () => {
      body = UNRESOLVED_BODY;
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'W5000000',
        amenity: 'bench',
      });
      expect(result.structuredContent).toMatchObject({
        effectiveArea: 'W5000000 → Overpass area of closed way 5000000',
        effectiveTag: 'amenity=bench',
      });
    });
  });

  describe('paging under the area scope', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      type: 'node',
      id: 100 + i,
      lat: 47.6 + i / 1000,
      lon: -122.3,
      tags: { amenity: 'cafe' },
    }));

    it('truncates at the limit and offers nextOffset', async () => {
      body = resolvedWayBody(many);
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'W13800188',
        amenity: 'cafe',
        limit: 2,
      });
      expect(result.structuredContent).toMatchObject({
        totalFound: 5,
        truncated: true,
        nextOffset: 2,
      });
      expect((result.structuredContent as { elements: unknown[] }).elements).toHaveLength(2);
    });

    it('reports an offset past the end against the boundary, not a bounding box', async () => {
      body = resolvedWayBody(many);
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'W13800188',
        amenity: 'cafe',
        limit: 2,
        offset: 40,
      });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain('Offset 40 is past the end of the result set');
      expect(notice).toContain('inside W13800188');
      expect(notice).not.toContain('bounding box');
      expect(notice).toContain('Retry with offset 3 for the last page');
    });
  });

  describe('scope exclusivity', () => {
    async function failWith(input: Record<string, unknown>): Promise<ContractError> {
      const ctx = createMockContext({ errors: openstreetmapQueryBbox.errors });
      return (await captureThrown(
        openstreetmapQueryBbox.handler(openstreetmapQueryBbox.input.parse(input), ctx),
      )) as ContractError;
    }

    it('rejects within alongside a corner field before touching Overpass', async () => {
      const error = await failWith({ within: 'R237385', south: 47.5, amenity: 'cafe' });
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('invalid_scope');
      expect(error.data.recovery?.hint).toContain('within');
      expect(http.calls).toHaveLength(0);
    });

    it('rejects a call carrying neither scope', async () => {
      const error = await failWith({ amenity: 'cafe' });
      expect(error.data.reason).toBe('invalid_scope');
      expect(http.calls).toHaveLength(0);
    });

    it('rejects a partial corner set rather than guessing the missing bounds', async () => {
      const error = await failWith({ south: 47.5, north: 47.7, amenity: 'cafe' });
      expect(error.data.reason).toBe('invalid_scope');
      expect(error.message).toContain('east');
      expect(http.calls).toHaveLength(0);
    });

    it('keeps the inverted-latitude guard on the four-corner path', async () => {
      const error = await failWith({
        south: 47.7,
        west: -122.5,
        north: 47.5,
        east: -122.2,
        amenity: 'cafe',
      });
      expect(error.data.reason).toBe('invalid_bbox');
      expect(http.calls).toHaveLength(0);
    });
  });

  describe('advertised ref pattern', () => {
    it.each(['N1', 'N240109189', 'R', 'W', '12', 'R 237385', 'R237385x', 'Q237385', ''])(
      'rejects %j at the schema, before the handler runs',
      (within) => {
        expect(() => openstreetmapQueryBbox.input.parse({ within, amenity: 'cafe' })).toThrow();
      },
    );

    it.each(['R237385', 'W13800188', 'r237385', 'w13800188'])('accepts %j', (within) => {
      expect(() => openstreetmapQueryBbox.input.parse({ within, amenity: 'cafe' })).not.toThrow();
    });
  });

  describe('enrichment on the four-corner path', () => {
    it('omits effectiveArea and areasTimestamp when no boundary was used', async () => {
      body = {
        version: 0.6,
        osm3s: {
          timestamp_osm_base: '2026-09-16T20:43:48Z',
          timestamp_areas_base: '2026-09-16T05:04:09Z',
        },
        elements: [{ type: 'node', id: 7, lat: 47.6, lon: -122.3, tags: { amenity: 'cafe' } }],
      };
      const ctx = createMockContext({ errors: openstreetmapQueryBbox.errors });
      await openstreetmapQueryBbox.handler(
        openstreetmapQueryBbox.input.parse({
          south: 47.5,
          west: -122.5,
          north: 47.7,
          east: -122.2,
          amenity: 'cafe',
        }),
        ctx,
      );
      const enrichment = getEnrichment(ctx) as Record<string, unknown>;
      expect(enrichment.effectiveArea).toBeUndefined();
      expect(enrichment.areasTimestamp).toBeUndefined();
    });
  });
});
