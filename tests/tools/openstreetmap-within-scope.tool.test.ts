/**
 * @fileoverview The `within` boundary scope on openstreetmap_query_bbox — generated QL,
 * both response surfaces, scope exclusivity, and the unresolved-boundary notice (#71), and
 * the boundary `effectiveArea` names (#117).
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
import { type WireError, wireError } from '../helpers/handler-error.js';
import { markdownText } from '../helpers/markdown.js';

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

/** The print that reads the boundary's own tags (#117), between the sentinel and the matches. */
const SCOPE_PRINT =
  '.a convert scope ::id=id(),name=t["name"],boundary=t["boundary"],admin_level=t["admin_level"];out;';

/**
 * A resolved boundary's sentinel and scope print, then `matches`. The scope elements below are
 * what `overpass-api.de` (Overpass API 0.7.62.11) printed for `rel(1453306)`, `way(13800188)`,
 * and `rel(237385)` on 2026-11-05: `convert` writes a tag the boundary lacks as `""`.
 */
function namedBoundaryBody(kind: 'relation' | 'way', scope: unknown, matches: unknown[] = []) {
  return {
    version: 0.6,
    osm3s: {
      timestamp_osm_base: '2026-11-05T08:09:06Z',
      timestamp_areas_base: '2026-11-05T01:38:07Z',
    },
    elements: [
      {
        type: 'count',
        id: 0,
        tags:
          kind === 'relation'
            ? { nodes: '0', ways: '0', relations: '0', areas: '1', total: '1' }
            : { nodes: '0', ways: '1', relations: '0', areas: '0', total: '1' },
      },
      scope,
      ...matches,
    ],
  };
}

const YELLOWSTONE_SCOPE = {
  type: 'scope',
  id: 3601453306,
  tags: { name: 'Yellowstone National Park', boundary: 'protected_area', admin_level: '' },
};
const VOLUNTEER_PARK_SCOPE = {
  type: 'scope',
  id: 13800188,
  tags: { name: 'Volunteer Park', boundary: '', admin_level: '' },
};
const SEATTLE_SCOPE = {
  type: 'scope',
  id: 3600237385,
  tags: { name: 'Seattle', boundary: 'administrative', admin_level: '8' },
};

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
    it('maps a relation ref through map_to_area and emits the count sentinel and the scope print', async () => {
      await runToolContract(openstreetmapQueryBbox, {
        within: 'R237385',
        amenity: 'university',
      });
      expect(await sentQl()).toBe(
        [
          '[out:json][timeout:25][maxsize:268435456];',
          'rel(237385);map_to_area->.a;',
          '.a out count;',
          SCOPE_PRINT,
          '(',
          '  node["amenity"="university"](area.a);',
          '  way["amenity"="university"](area.a);',
          '  relation["amenity"="university"](area.a);',
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
          '[out:json][timeout:40][maxsize:268435456];',
          'rel(237385);map_to_area->.a;',
          '.a out count;',
          SCOPE_PRINT,
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
          '[out:json][timeout:25][maxsize:268435456];',
          '(',
          '  node["amenity"="university"](47.5,-122.5,47.7,-122.2);',
          '  way["amenity"="university"](47.5,-122.5,47.7,-122.2);',
          '  relation["amenity"="university"](47.5,-122.5,47.7,-122.2);',
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
      expect(markdownText(text)).toContain(
        'Scope: R237385 → Overpass area 3600237385 (relation 237385)',
      );
      expect(markdownText(text)).toContain('Areas Data As Of: 2026-09-16T05:04:09Z');
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
      expect(markdownText(textOf(result.content))).toContain(
        'Scope: W13800188 → Overpass area of closed way 13800188',
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

  /**
   * #117: a mistyped id or the wrong geocoding row resolves as readily as the intended
   * boundary, so `effectiveArea` names the boundary the ref reached, read off the `scope`
   * print in the same request.
   */
  describe('the boundary effectiveArea names (#117)', () => {
    const peak = {
      type: 'node',
      id: 358_249_473,
      lat: 44.6,
      lon: -110.7,
      tags: { natural: 'peak', name: 'Mount Washburn' },
    };

    it('names a relation-derived boundary on both surfaces and keeps the scope print out of the matches', async () => {
      body = namedBoundaryBody('relation', YELLOWSTONE_SCOPE, [peak]);
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'R1453306',
        tag_key: 'natural',
        tag_value: 'peak',
      });
      const effectiveArea =
        'R1453306 Yellowstone National Park (boundary=protected_area) → Overpass area 3601453306 (relation 1453306)';
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        elements: [{ osm_type: 'node', osm_id: 358_249_473, name: 'Mount Washburn' }],
        totalFound: 1,
        truncated: false,
        effectiveArea,
      });
      expect((result.structuredContent as { elements: unknown[] }).elements).toHaveLength(1);
      expect(textOf(result.content)).toContain(`**Scope:** \`${effectiveArea}\``);
      expect(markdownText(textOf(result.content))).toContain(`Scope: ${effectiveArea}`);
    });

    it.each([
      {
        label: 'a way-derived boundary by name alone',
        within: 'W13800188',
        kind: 'way' as const,
        scope: VOLUNTEER_PARK_SCOPE,
        effectiveArea: 'W13800188 Volunteer Park → Overpass area of closed way 13800188',
      },
      {
        label: 'an administrative boundary with its admin_level',
        within: 'R237385',
        kind: 'relation' as const,
        scope: SEATTLE_SCOPE,
        effectiveArea:
          'R237385 Seattle (boundary=administrative, admin_level=8) → Overpass area 3600237385 (relation 237385)',
      },
      {
        label: 'a boundary tag with no name',
        within: 'R237385',
        kind: 'relation' as const,
        scope: {
          ...SEATTLE_SCOPE,
          tags: { name: '', boundary: 'administrative', admin_level: '' },
        },
        effectiveArea:
          'R237385 (boundary=administrative) → Overpass area 3600237385 (relation 237385)',
      },
      {
        label: 'a boundary carrying none of the three tags, exactly as before #117',
        within: 'R237385',
        kind: 'relation' as const,
        scope: { ...SEATTLE_SCOPE, tags: { name: '', boundary: '', admin_level: '' } },
        effectiveArea: 'R237385 → Overpass area 3600237385 (relation 237385)',
      },
    ])('names $label', async ({ within, kind, scope, effectiveArea }) => {
      body = namedBoundaryBody(kind, scope);
      const result = await runToolContract(openstreetmapQueryBbox, { within, amenity: 'bench' });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ effectiveArea, totalFound: 0 });
      expect(markdownText(textOf(result.content))).toContain(`Scope: ${effectiveArea}`);
    });

    it('keeps the unresolved-boundary notice and the bare ref when the ref reached no area', async () => {
      body = UNRESOLVED_BODY;
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'R1',
        amenity: 'bench',
      });
      expect(result.structuredContent).toMatchObject({
        elements: [],
        totalFound: 0,
        effectiveArea: 'R1 → Overpass area 3600000001 (relation 1)',
      });
      expect((result.structuredContent as { notice: string }).notice).toContain(
        'Boundary R1 did not resolve to an Overpass area',
      );
    });

    it('reports a named boundary that matched nothing as empty, not as a page past the end', async () => {
      body = namedBoundaryBody('relation', YELLOWSTONE_SCOPE);
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'R1453306',
        amenity: 'bench',
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        elements: [],
        totalFound: 0,
        truncated: false,
        notice:
          'No amenity=bench features found inside R1453306. Try a different tag, or a boundary that encloses more.',
      });
    });

    it('pages the matches alone, never counting the scope print', async () => {
      const benches = Array.from({ length: 5 }, (_, i) => ({
        type: 'node',
        id: 900 + i,
        lat: 44.6,
        lon: -110.7 + i / 1000,
        tags: { amenity: 'bench' },
      }));
      body = namedBoundaryBody('relation', YELLOWSTONE_SCOPE, benches);
      const first = await runToolContract(openstreetmapQueryBbox, {
        within: 'R1453306',
        amenity: 'bench',
        limit: 2,
      });
      expect(first.structuredContent).toMatchObject({
        elements: [{ osm_id: 900 }, { osm_id: 901 }],
        totalFound: 5,
        truncated: true,
        nextOffset: 2,
      });

      const last = await runToolContract(openstreetmapQueryBbox, {
        within: 'R1453306',
        amenity: 'bench',
        limit: 2,
        offset: 4,
      });
      expect(last.structuredContent).toMatchObject({
        elements: [{ osm_id: 904 }],
        totalFound: 5,
        truncated: false,
      });
      expect(last.structuredContent).not.toHaveProperty('nextOffset');
    });

    /**
     * The name is upstream text. `effectiveArea` reaches `content[]` through the enrichment
     * trailer, which renders a string as a code literal — a code span on one line, a fence
     * across a line break — so Markdown in a boundary's name reads back as written, with no
     * escape added on either surface.
     */
    it('renders a name carrying Markdown inertly on content[] and raw on structuredContent', async () => {
      const name = '*Park* [x](https://example.test) `tick` <b>';
      body = namedBoundaryBody('relation', { ...YELLOWSTONE_SCOPE, tags: { name } });
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'R1453306',
        amenity: 'bench',
      });
      const effectiveArea = `R1453306 ${name} → Overpass area 3601453306 (relation 1453306)`;
      expect(result.structuredContent).toMatchObject({ effectiveArea });
      const text = textOf(result.content);
      expect(text).toContain(`**Scope:** \`\`${effectiveArea}\`\``);
      expect(markdownText(text)).toContain(`Scope: ${effectiveArea}`);
    });

    it('renders a name carrying a line break as a fenced block on content[]', async () => {
      const name = 'Line one\nLine two';
      body = namedBoundaryBody('way', { ...VOLUNTEER_PARK_SCOPE, tags: { name } });
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'W13800188',
        amenity: 'bench',
      });
      const effectiveArea = `W13800188 ${name} → Overpass area of closed way 13800188`;
      expect(result.structuredContent).toMatchObject({ effectiveArea });
      const text = textOf(result.content);
      expect(text).toContain(`**Scope:** \n\`\`\`\n${effectiveArea}\n\`\`\``);
      expect(markdownText(text)).toContain(effectiveArea);
    });
  });

  /**
   * #84: a resolved boundary that holds no `amenity=museum` names the key museums are
   * tagged under; an unresolved ref keeps its own notice, which sends the caller to the
   * ref rather than the tag.
   */
  describe('amenity-stray hint (#84)', () => {
    const HINT =
      'In OpenStreetMap this category is tagged tourism=museum, not amenity=museum; retry with tag_key "tourism" and tag_value "museum".';

    it('replaces the generic advice when the boundary resolved and nothing matched', async () => {
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
        amenity: 'museum',
      });
      const notice = `No amenity=museum features found inside R237385. ${HINT}`;
      expect(result.structuredContent).toMatchObject({ elements: [], notice });
      expect(textOf(result.content)).toContain(`> ${notice}`);
    });

    // The unresolved-boundary notice carries no stray hint. Its existence-check route
    // moved to openstreetmap_query_raw under #82 (pinned in the block below).
    it('keeps the stray hint out of the unresolved-boundary notice', async () => {
      body = UNRESOLVED_BODY;
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'R999999999',
        amenity: 'museum',
      });
      const notice =
        'Boundary R999999999 did not resolve to an Overpass area, so nothing can be inside it — the ref may name an id that does not exist, an unclosed way, or a relation without a boundary or area-forming tag. Check it with openstreetmap_query_raw, query [out:json];(rel(id:999999999););out tags; and limit 1: an empty result means the id is not in OpenStreetMap, otherwise its tags show what it is. Or scope with the four corner fields instead.';
      expect(result.structuredContent).toMatchObject({ notice });
      expect(textOf(result.content)).not.toContain('In OpenStreetMap');
    });
  });

  /**
   * #124: the spelling hint follows the stray hint's placement — after the empty-page sentence
   * of a resolved boundary, never on the unresolved-boundary notice, which points at the ref.
   */
  describe('primary-key spelling hint (#124)', () => {
    const HINT =
      'OpenStreetMap writes primary feature keys and their values in lowercase with underscores, and tags match exactly; retry with amenity=hospital.';

    it('replaces the generic advice when the boundary resolved and nothing matched', async () => {
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
        amenity: 'Hospital',
      });
      const notice = `No amenity=Hospital features found inside R237385. ${HINT}`;
      expect(result.structuredContent).toMatchObject({
        elements: [],
        effectiveTag: 'amenity=Hospital',
        notice,
      });
      expect(textOf(result.content)).toContain(`> ${notice}`);
      expect(await sentQl()).toContain('node["amenity"="Hospital"](area.a);');
    });

    it('keeps the hint out of the unresolved-boundary notice', async () => {
      body = UNRESOLVED_BODY;
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: 'R999999999',
        amenity: 'Hospital',
      });
      const notice =
        'Boundary R999999999 did not resolve to an Overpass area, so nothing can be inside it — the ref may name an id that does not exist, an unclosed way, or a relation without a boundary or area-forming tag. Check it with openstreetmap_query_raw, query [out:json];(rel(id:999999999););out tags; and limit 1: an empty result means the id is not in OpenStreetMap, otherwise its tags show what it is. Or scope with the four corner fields instead.';
      expect(result.structuredContent).toMatchObject({ notice });
      expect(textOf(result.content)).not.toContain('lowercase with underscores');
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
        // #82: openstreetmap_lookup_objects answers from Nominatim, which does not index
        // the unclosed ways and tagless relations this notice names, so the existence
        // check runs on Overpass instead.
        expect(surface).toContain(
          'Check it with openstreetmap_query_raw, query [out:json];(rel(id:999999999););out tags; and limit 1',
        );
        expect(surface).not.toContain('openstreetmap_lookup_objects');
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
      expect((result.structuredContent as { notice: string }).notice).toContain(
        'query [out:json];(way(id:5000000););out tags; and limit 1',
      );
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
    function failWith(
      input: Parameters<typeof runToolContract<typeof openstreetmapQueryBbox>>[1],
    ): Promise<WireError> {
      return wireError(openstreetmapQueryBbox, input);
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
    it.each([
      'N1',
      'N240109189',
      'node/240109189',
      'https://www.openstreetmap.org/node/240109189',
      'R',
      'W',
      '12',
      'R 237385',
      'R237385x',
      'Q237385',
      '   ',
    ])('rejects %j at the schema, before the handler runs', (within) => {
      expect(() => openstreetmapQueryBbox.input.parse({ within, amenity: 'cafe' })).toThrow();
    });

    // #126: '' is a form client's untouched field, accepted here and read as no ref.
    it.each([
      'R237385',
      'W13800188',
      'r237385',
      'w13800188',
      ' R237385 ',
      'relation/237385',
      'https://www.openstreetmap.org/way/13800188',
      '',
    ])('accepts %j', (within) => {
      expect(() => openstreetmapQueryBbox.input.parse({ within, amenity: 'cafe' })).not.toThrow();
    });
  });

  /**
   * #126: the object path and the openstreetmap.org URL name exactly one way or relation, so
   * `within` reduces each to the canonical ref before building the query. Which forms parse is
   * `parseOsmRef`'s table (openstreetmap-osm-ids.test.ts); these cases pin the wiring.
   */
  describe('ref forms (#126)', () => {
    const SEATTLE_QL = [
      '[out:json][timeout:25][maxsize:268435456];',
      'rel(237385);map_to_area->.a;',
      '.a out count;',
      SCOPE_PRINT,
      '(',
      '  node["amenity"="university"](area.a);',
      '  way["amenity"="university"](area.a);',
      '  relation["amenity"="university"](area.a);',
      ');',
      'out center tags;',
    ].join('\n');

    it.each([
      'https://www.openstreetmap.org/relation/237385',
      'osm.org/relation/237385#map=11/47.61/-122.33',
      'relation/237385',
      ' r0237385 ',
    ])('builds the R237385 query from %j and reports the canonical ref', async (within) => {
      const result = await runToolContract(openstreetmapQueryBbox, {
        within,
        amenity: 'university',
      });
      expect(await sentQl()).toBe(SEATTLE_QL);
      const effectiveArea = 'R237385 → Overpass area 3600237385 (relation 237385)';
      expect(result.structuredContent).toMatchObject({ effectiveArea, totalFound: 2 });
      expect(markdownText(textOf(result.content))).toContain(`Scope: ${effectiveArea}`);
    });

    it('names the canonical ref when a URL is sent beside a corner field', async () => {
      const error = await wireError(openstreetmapQueryBbox, {
        within: 'https://www.openstreetmap.org/way/13800188',
        north: 47.7,
        amenity: 'cafe',
      });
      expect(error.data.reason).toBe('invalid_scope');
      expect(error.message).toBe(
        'within (W13800188) cannot be combined with the corner field north.',
      );
      expect(http.calls).toHaveLength(0);
    });

    it.each(['N240109189', 'node/240109189', 'https://www.openstreetmap.org/node/240109189'])(
      'rejects the node %j at the schema with the accepted forms, not the pattern',
      async (within) => {
        const error = await wireError(openstreetmapQueryBbox, { within, amenity: 'cafe' });
        const forms =
          'within: Expected one way or relation ref: R or W plus the id ("R237385"), the object path ("relation/237385"), or its openstreetmap.org URL. A node is never an area.';
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.data.reason).toBe('invalid_arguments');
        expect(error.data.recovery?.hint).toBe(forms);
        expect(error.message).not.toContain('must match pattern');
        expect(error.text).toContain(forms);
        expect(http.calls).toHaveLength(0);
      },
    );
  });

  /**
   * An id past 2^63 − 1 names no OSM object, and the Overpass query built from it carried a
   * rounded or exponent-notation id. It fails before any query as invalid_scope.
   */
  describe('ids past the 64-bit range', () => {
    it.each(['R9223372036854775808', 'https://www.openstreetmap.org/way/99999999999999999999'])(
      'fails %j as invalid_scope before any Overpass query',
      async (within) => {
        const error = await wireError(openstreetmapQueryBbox, { within, amenity: 'cafe' });
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data.reason).toBe('invalid_scope');
        expect(error.message).toBe(
          `within (${within}) names an id above 9223372036854775807, the largest an OSM object can carry.`,
        );
        expect(error.text).toContain('(reason invalid_scope');
        expect(http.calls).toHaveLength(0);
      },
    );

    it('still queries the largest id itself', async () => {
      body = UNRESOLVED_BODY;
      await runToolContract(openstreetmapQueryBbox, {
        within: 'R9223372036854775807',
        amenity: 'cafe',
      });
      expect(http.calls).toHaveLength(1);
    });

    /** Past 2^53 a JS number rounds: 9223372036854775807 would print as 9223372036854776000. */
    it.each([
      [
        'R9223372036854775807',
        'rel(9223372036854775807)',
        'Overpass area 9223372040454775807 (relation 9223372036854775807)',
      ],
      [
        'W9007199254740993',
        'way(9007199254740993)',
        'Overpass area of closed way 9007199254740993',
      ],
    ])('queries and echoes every digit of %j', async (within, statement, area) => {
      body = UNRESOLVED_BODY;
      const result = await runToolContract(openstreetmapQueryBbox, { within, amenity: 'cafe' });
      expect(await sentQl()).toContain(`${statement};map_to_area->.a;`);
      expect(result.structuredContent).toMatchObject({ effectiveArea: `${within} → ${area}` });
      expect((result.structuredContent as { notice: string }).notice).toContain(
        `(${statement.replace('(', '(id:')};)`,
      );
    });
  });

  /**
   * #129: no OSM object carries id 0, and Overpass answers the query built from one with an
   * HTTP 400. Every form that reduces to R0 or W0 fails before any query as invalid_scope.
   */
  describe('id 0 (#129)', () => {
    it.each(['R0', 'w000', 'relation/0', 'https://www.openstreetmap.org/way/0', ' r00 '])(
      'fails %j as invalid_scope before any Overpass query',
      async (within) => {
        const error = await wireError(openstreetmapQueryBbox, { within, amenity: 'library' });
        const message = `within (${within.trim()}) names id 0, but OSM ids start at 1.`;
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data.reason).toBe('invalid_scope');
        expect(error.message).toBe(message);
        expect(error.data.recovery?.hint).toContain('OSM ids run from 1 to 9223372036854775807.');
        expect(markdownText(error.text)).toContain(message);
        expect(http.calls).toHaveLength(0);
      },
    );

    it('still queries id 1', async () => {
      body = UNRESOLVED_BODY;
      await runToolContract(openstreetmapQueryBbox, { within: 'W01', amenity: 'library' });
      expect(await sentQl()).toContain('way(1);map_to_area->.a;');
    });
  });

  /**
   * A form client submits the whole schema shape, so an untouched within arrives as "" beside
   * the four corners it did fill in — the case `layer` and `exclude_place_ids` already accept.
   */
  describe('an empty within', () => {
    const box = { south: 47.5, west: -122.5, north: 47.7, east: -122.2 };

    it('reads as no ref beside the four corners and queries the box', async () => {
      body = {
        version: 0.6,
        elements: [{ type: 'node', id: 7, lat: 47.6, lon: -122.3, tags: { amenity: 'cafe' } }],
      };
      const result = await runToolContract(openstreetmapQueryBbox, {
        within: '',
        ...box,
        amenity: 'cafe',
      });
      expect(result.isError).not.toBe(true);
      const ql = await sentQl();
      expect(ql).toContain('node["amenity"="cafe"](47.5,-122.5,47.7,-122.2);');
      expect(ql).not.toContain('map_to_area');
      expect(result.structuredContent).toMatchObject({ totalFound: 1 });
      expect(result.structuredContent).not.toHaveProperty('effectiveArea');
    });

    it('still fails as invalid_scope with no corners, before any query', async () => {
      const error = await wireError(openstreetmapQueryBbox, { within: '', amenity: 'cafe' });
      expect(error.data.reason).toBe('invalid_scope');
      expect(error.message).toContain('No scope given.');
      expect(http.calls).toHaveLength(0);
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
