/**
 * @fileoverview Tests for the openstreetmap-search-places tool.
 * @module tests/tools/openstreetmap-search-places.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapSearchPlaces } from '@/mcp-server/tools/definitions/openstreetmap-search-places.tool.js';
import type { NominatimPlace, NominatimSearchParams } from '@/services/nominatim/types.js';

/** Concatenated text of a CallToolResult's content blocks — the surface content[]-only clients read. */
function contentText(content: unknown): string {
  return (content as { type: string; text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

// --- service mock --------------------------------------------------------

const mockSearch =
  vi.fn<(params: NominatimSearchParams, ctx: Context) => Promise<NominatimPlace[]>>();

vi.mock('@/services/nominatim/nominatim-service.js', () => ({
  getNominatimService: () => ({ search: mockSearch }),
}));

// --- fixtures ------------------------------------------------------------

const minimalPlace: NominatimPlace = {
  place_id: 1234,
  lat: '47.6062',
  lon: '-122.3321',
  display_name: 'Seattle, King County, Washington, United States',
};

const richPlace: NominatimPlace = {
  place_id: 9999,
  osm_type: 'node',
  osm_id: 240109189,
  lat: '47.6205',
  lon: '-122.3493',
  display_name: 'Space Needle, 400, Broad Street, Seattle Center, Seattle, Washington, 98109',
  name: 'Space Needle',
  category: 'man_made',
  type: 'tower',
  importance: 0.7,
  address: { road: 'Broad Street', city: 'Seattle', state: 'Washington', country_code: 'us' },
  boundingbox: ['47.619', '47.622', '-122.352', '-122.347'],
  extratags: { wikidata: 'Q178640', website: 'https://www.spaceneedle.com' },
};

// -------------------------------------------------------------------------

describe('openstreetmapSearchPlaces', () => {
  beforeEach(() => {
    mockSearch.mockReset();
  });

  describe('happy path — free-form query', () => {
    it('returns geocoding results for a valid query', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Seattle' });
      const result = await openstreetmapSearchPlaces.handler(input, ctx);

      expect(result.total).toBe(1);
      expect(result.results[0]).toMatchObject({
        place_id: 1234,
        lat: '47.6062',
        lon: '-122.3321',
        display_name: 'Seattle, King County, Washington, United States',
      });
      expect(result.attribution).toContain('OpenStreetMap');
    });

    it('includes optional fields when present in upstream response', async () => {
      mockSearch.mockResolvedValue([richPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Space Needle Seattle' });
      const result = await openstreetmapSearchPlaces.handler(input, ctx);

      expect(result.results[0]).toMatchObject({
        osm_type: 'node',
        osm_id: 240109189,
        name: 'Space Needle',
        category: 'man_made',
        type: 'tower',
        importance: 0.7,
      });
      expect(result.results[0]?.address).toBeDefined();
      expect(result.results[0]?.extratags).toBeDefined();
    });
  });

  describe('happy path — structured query', () => {
    it('accepts structured address fields', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ city: 'Seattle', state: 'Washington' });
      const result = await openstreetmapSearchPlaces.handler(input, ctx);
      expect(result.total).toBe(1);
    });

    it('passes optional filters to the service', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'pharmacy',
        countrycodes: 'us',
        limit: 10,
        extratags: true,
        language: 'en',
      });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(mockSearch).toHaveBeenCalledOnce();
    });
  });

  describe('sparse upstream payload', () => {
    it('handles a place with only required fields (no optional data)', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Seattle' });
      const result = await openstreetmapSearchPlaces.handler(input, ctx);

      const r = result.results[0]!;
      expect(r.name).toBeUndefined();
      expect(r.category).toBeUndefined();
      expect(r.osm_type).toBeUndefined();
      expect(r.address).toBeUndefined();
      expect(r.extratags).toBeUndefined();
    });
  });

  describe('enrichment', () => {
    it('echoes free-form query as effectiveQuery', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Space Needle Seattle' });
      await openstreetmapSearchPlaces.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveQuery).toBe('Space Needle Seattle');
    });

    it('reconstructs effectiveQuery from structured address fields', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        city: 'Seattle',
        state: 'Washington',
        country: 'US',
      });
      await openstreetmapSearchPlaces.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveQuery).toBe('Seattle, Washington, US');
    });

    it('excludes undefined/empty structured fields from effectiveQuery', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ city: 'Seattle' });
      await openstreetmapSearchPlaces.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      // Only 'Seattle' — other fields are undefined and should be filtered out
      expect(enrichment.effectiveQuery).toBe('Seattle');
    });
  });

  describe('truncation (#15)', () => {
    it('omits truncated enrichment when results are below the requested limit', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Seattle', limit: 5 });
      await openstreetmapSearchPlaces.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.shown).toBeUndefined();
      expect(enrichment.cap).toBeUndefined();
    });

    it('discloses truncated when results reach the requested limit', async () => {
      const capped = Array.from({ length: 3 }, (_, i) => ({ ...minimalPlace, place_id: 1000 + i }));
      mockSearch.mockResolvedValue(capped);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'coffee shops', limit: 3 });
      const result = await openstreetmapSearchPlaces.handler(input, ctx);

      expect(result.total).toBe(3);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.shown).toBe(3);
      expect(enrichment.cap).toBe(3);
    });

    /**
     * Regression for #39: `notice` was documented as an empty-page field, but
     * `ctx.enrich.truncated()` writes its cap message into that same key, so a full
     * page of results arrives carrying a notice. An agent trusting the description
     * read a first-page cap notice as "the paging walk is exhausted" and abandoned
     * the walk one page in.
     */
    it('carries the cap notice alongside results, as the field description states', async () => {
      const capped = Array.from({ length: 3 }, (_, i) => ({ ...minimalPlace, place_id: 1000 + i }));
      mockSearch.mockResolvedValue(capped);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'coffee shops', limit: 3 });
      const result = await openstreetmapSearchPlaces.handler(input, ctx);

      expect(result.total).toBe(3);
      expect(getEnrichment(ctx).notice).toContain('capped at 3');

      // The description has to name the cap case too — the presence of `notice`
      // cannot be read as "the walk ended".
      const description = openstreetmapSearchPlaces.enrichment!.notice.description;
      expect(description).toContain('capped');
      expect(description).toContain('exhausted');
    });

    /**
     * Regression for #55: the notice carried the framework's default cap text
     * ("Raise the cap or narrow with filters"), and neither remedy reaches the rest
     * of the result set — `limit` stops at Nominatim's 40-result ceiling, and
     * narrowing returns a different set rather than the remainder of this one.
     */
    it('names the exclude_place_ids walk and the 40-result ceiling in the cap notice', async () => {
      const capped = Array.from({ length: 3 }, (_, i) => ({ ...minimalPlace, place_id: 1000 + i }));
      mockSearch.mockResolvedValue(capped);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'coffee shops', limit: 3 });
      await openstreetmapSearchPlaces.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('nextExcludeIds');
      expect(notice).toContain('exclude_place_ids');
      expect(notice).toContain('40');
      // The remedies the framework default names are the two that cannot reach the
      // rest of the set.
      expect(notice).not.toContain('Raise the cap or narrow with filters');
    });
  });

  describe('exclude_place_ids paging (#24)', () => {
    it('forwards exclude_place_ids to the service as excludePlaceIds', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'coffee',
        exclude_place_ids: ['111', '222'],
      });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ excludePlaceIds: ['111', '222'] }),
        expect.anything(),
      );
    });

    it('omits excludePlaceIds when an empty array is supplied (form-client blank)', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'coffee',
        exclude_place_ids: [],
      });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(mockSearch).toHaveBeenCalledWith(
        expect.not.objectContaining({ excludePlaceIds: expect.anything() }),
        expect.anything(),
      );
    });

    it('accumulates nextExcludeIds as stable OSM refs, preferring them over place_id (#25)', async () => {
      mockSearch.mockResolvedValue([
        { ...minimalPlace, place_id: 1000, osm_type: 'node', osm_id: 13872184444 },
        { ...minimalPlace, place_id: 1001, osm_type: 'relation', osm_id: 12345 },
      ]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'coffee',
        limit: 2,
        exclude_place_ids: ['999'],
      });
      await openstreetmapSearchPlaces.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      // Prior excludes carry through verbatim; this page emits N.../R... refs, not place_ids.
      expect(enrichment.nextExcludeIds).toEqual(['999', 'N13872184444', 'R12345']);
    });

    it('falls back to place_id in nextExcludeIds when a result lacks osm_type/osm_id (#25)', async () => {
      mockSearch.mockResolvedValue([
        { ...minimalPlace, place_id: 1000 },
        { ...minimalPlace, place_id: 1001 },
      ]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'coffee', limit: 2 });
      await openstreetmapSearchPlaces.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.nextExcludeIds).toEqual(['1000', '1001']);
    });

    it('selects ref-or-place_id per result in nextExcludeIds (#25)', async () => {
      mockSearch.mockResolvedValue([
        { ...minimalPlace, place_id: 1000, osm_type: 'way', osm_id: 555 },
        { ...minimalPlace, place_id: 1001 },
      ]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'coffee', limit: 2 });
      await openstreetmapSearchPlaces.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      // First result has an OSM ref (W555); the second falls back to its place_id.
      expect(enrichment.nextExcludeIds).toEqual(['W555', '1001']);
    });

    it('enrichmentTrailer.nextExcludeIds.render carries a self-identifying label (#25)', () => {
      const render = openstreetmapSearchPlaces.enrichmentTrailer!.nextExcludeIds!.render!;
      const rendered = render(['N13872184444', 'W8544921317']);
      expect(rendered).toBe('**Next Exclude IDs:** N13872184444, W8544921317');
    });

    it('omits nextExcludeIds when results are below the requested limit', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'coffee', limit: 5 });
      await openstreetmapSearchPlaces.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.nextExcludeIds).toBeUndefined();
    });
  });

  describe('exhausted paging (#35)', () => {
    it('returns success with an exhaustion notice when the walk runs dry', async () => {
      mockSearch.mockResolvedValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'Beinecke Library, New Haven',
        limit: 1,
        exclude_place_ids: ['W114134159'],
      });
      const result = await openstreetmapSearchPlaces.handler(input, ctx);

      expect(result.total).toBe(0);
      expect(result.results).toEqual([]);
      expect(result.attribution).toContain('OpenStreetMap');

      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveQuery).toBe('Beinecke Library, New Haven');
      expect(enrichment.notice).toContain('Paging complete');
      expect(enrichment.notice).toContain('1 already retrieved');
      // The terminal page is not a truncated page — no further token to walk with.
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.nextExcludeIds).toBeUndefined();
    });

    it('does not repeat the query-rewrite guidance reserved for a first-page miss', async () => {
      mockSearch.mockResolvedValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'Beinecke Library, New Haven',
        exclude_place_ids: ['W114134159'],
      });
      await openstreetmapSearchPlaces.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      const noResultsHint = openstreetmapSearchPlaces.errors!.find(
        (e) => e.reason === 'no_results',
      )!.recovery;
      expect(notice).not.toContain('intermediate qualifier');
      expect(notice).not.toBe(noResultsHint);
    });

    it('still throws no_results when an empty exclude_place_ids array is supplied', async () => {
      mockSearch.mockResolvedValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'xyzzy_nowhere_place',
        exclude_place_ids: [],
      });
      await expect(openstreetmapSearchPlaces.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_results' },
      });
    });
  });

  /**
   * Regression for #52: tag-based selection is Overpass-only, and nothing in a
   * Nominatim response said so. A caller asking for a tagged feature got a
   * well-formed result carrying no tag and no way to learn why.
   */
  describe('tag-selection caveat (#52)', () => {
    /**
     * The signal has to reach the caller who already chose wrong, and that caller has no
     * reason to have set `extratags` — it defaults to false. Gating emission on it here
     * would deliver the caveat only to callers who already knew to ask for the tag map,
     * the inverse of the population that needs it.
     */
    it('reaches structuredContent and content[] with extratags omitted', async () => {
      mockSearch.mockResolvedValue([richPlace]);
      const result = await runToolContract(openstreetmapSearchPlaces, {
        query: 'Space Needle Seattle',
      });

      const structured = result.structuredContent as { tagSelectionCaveat?: string };
      expect(structured.tagSelectionCaveat).toContain('Overpass-only');
      expect(structured.tagSelectionCaveat).toContain('openstreetmap_query_bbox');
      expect(contentText(result.content)).toContain(structured.tagSelectionCaveat!);
    });

    it('reaches structuredContent and content[] when extratags was requested', async () => {
      mockSearch.mockResolvedValue([richPlace]);
      const result = await runToolContract(openstreetmapSearchPlaces, {
        query: 'Space Needle Seattle',
        extratags: true,
      });

      const structured = result.structuredContent as { tagSelectionCaveat?: string };
      expect(structured.tagSelectionCaveat).toContain('Overpass-only');
      expect(contentText(result.content)).toContain(structured.tagSelectionCaveat!);
    });

    it('fires on the exhausted-walk path, where the result set is empty', async () => {
      mockSearch.mockResolvedValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'Beinecke Library, New Haven',
        exclude_place_ids: ['W114134159'],
      });
      await openstreetmapSearchPlaces.handler(input, ctx);

      expect(getEnrichment(ctx).tagSelectionCaveat).toContain('Overpass-only');
    });

    /**
     * The reason the caveat has its own enrichment field. `ctx.enrich.notice()` and
     * `ctx.enrich.truncated({ guidance })` both write the single `notice` key, so
     * routing the caveat through it would drop one of the two messages on a page that
     * is both truncated and tag-relevant, depending on call order.
     */
    it('survives alongside the paging guidance on a truncated page, both intact', async () => {
      const capped = Array.from({ length: 2 }, (_, i) => ({
        ...richPlace,
        place_id: 2000 + i,
        osm_id: 500 + i,
      }));
      mockSearch.mockResolvedValue(capped);
      const result = await runToolContract(openstreetmapSearchPlaces, {
        query: 'trailhead',
        limit: 2,
        extratags: true,
      });

      const structured = result.structuredContent as {
        notice?: string;
        tagSelectionCaveat?: string;
        truncated?: boolean;
      };
      expect(structured.truncated).toBe(true);
      expect(structured.notice).toContain('exclude_place_ids');
      expect(structured.tagSelectionCaveat).toContain('Overpass-only');

      const text = contentText(result.content);
      expect(text).toContain(structured.notice!);
      expect(text).toContain(structured.tagSelectionCaveat!);
    });
  });

  describe('error paths', () => {
    it('throws conflicting_query_mode when query and structured fields are combined', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Seattle', city: 'Seattle' });
      await expect(openstreetmapSearchPlaces.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'conflicting_query_mode' },
      });
    });

    it('throws missing_query_mode when neither query nor structured fields are provided', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ limit: 5 });
      await expect(openstreetmapSearchPlaces.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'missing_query_mode' },
      });
    });

    // Regression for #56: one reason served both mistakes, so the caller who
    // supplied neither mode was told "not both".
    it('gives each query-mode mistake its own recovery hint', async () => {
      const hintFor = async (raw: Record<string, unknown>) => {
        const ctx = createMockContext({
          tenantId: 'test',
          errors: openstreetmapSearchPlaces.errors,
        });
        const input = openstreetmapSearchPlaces.input.parse(raw);
        const err = await openstreetmapSearchPlaces.handler(input, ctx).catch((e) => e);
        return err.data.recovery.hint as string;
      };

      const conflicting = await hintFor({ query: 'Seattle', city: 'Seattle' });
      const missing = await hintFor({ limit: 5 });

      expect(conflicting).not.toBe(missing);
      expect(missing).not.toMatch(/not both/i);
      expect(conflicting).toMatch(/one mode only/i);
    });

    it('throws no_results when the service returns empty array', async () => {
      mockSearch.mockResolvedValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'xyzzy_nowhere_place' });
      await expect(openstreetmapSearchPlaces.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_results' },
      });
    });

    it('surfaces parent-institution recovery guidance on no_results (#18)', async () => {
      mockSearch.mockResolvedValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'Beinecke Library, Yale University, New Haven',
      });
      const err = await openstreetmapSearchPlaces.handler(input, ctx).catch((e) => e);
      expect(err.data.reason).toBe('no_results');
      expect(err.data.recovery?.hint).toContain('intermediate qualifier');
      expect(err.data.recovery.hint).toContain('structured address fields');
    });

    it('propagates service errors', async () => {
      mockSearch.mockRejectedValue(new Error('Network error'));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Seattle' });
      await expect(openstreetmapSearchPlaces.handler(input, ctx)).rejects.toThrow('Network error');
    });
  });

  describe('format', () => {
    it('renders result with all key fields', () => {
      const output = {
        results: [
          {
            place_id: 9999,
            osm_type: 'node' as const,
            osm_id: 240109189,
            lat: '47.6205',
            lon: '-122.3493',
            display_name: 'Space Needle, Seattle, WA',
            name: 'Space Needle',
            category: 'man_made',
            type: 'tower',
            importance: 0.7,
          },
        ],
        total: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapSearchPlaces.format!(output);
      expect(blocks[0]!.type).toBe('text');
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Space Needle');
      expect(text).toContain('47.6205');
      expect(text).toContain('-122.3493');
      expect(text).toContain('9999');
      expect(text).toContain('N240109189');
      expect(text).toContain('man_made');
      expect(text).toContain('OpenStreetMap');
    });

    it('renders multiple results with total count', () => {
      const output = {
        results: [
          { place_id: 1, lat: '47.0', lon: '-122.0', display_name: 'Place A' },
          { place_id: 2, lat: '48.0', lon: '-123.0', display_name: 'Place B' },
        ],
        total: 2,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapSearchPlaces.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('2 results found');
      expect(text).toContain('Place A');
      expect(text).toContain('Place B');
    });

    it('renders importance at full precision, matching structuredContent (#28)', () => {
      const importance = 0.43883445952664873;
      const output = {
        results: [
          {
            place_id: 9999,
            lat: '47.6205',
            lon: '-122.3493',
            display_name: 'Space Needle, Seattle, WA',
            importance,
          },
        ],
        total: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapSearchPlaces.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain(`**Importance:** ${importance}`);
      expect(text).not.toContain('0.439');
    });

    it('renders the exhausted-walk empty result set without inventing rows (#35)', () => {
      const output = {
        results: [],
        total: 0,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapSearchPlaces.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('0 results found');
      expect(text).toContain('OpenStreetMap');
    });

    it('renders bounding box and extratags when present', () => {
      const output = {
        results: [
          {
            place_id: 1,
            lat: '47.0',
            lon: '-122.0',
            display_name: 'Test Place',
            boundingbox: ['46.9', '47.1', '-122.1', '-121.9'] as [string, string, string, string],
            extratags: { website: 'https://example.com' },
          },
        ],
        total: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapSearchPlaces.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Bounding box');
      expect(text).toContain('website: https://example.com');
    });
  });
});
