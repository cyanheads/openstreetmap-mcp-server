/**
 * @fileoverview Tests for the openstreetmap-geocode tool.
 * @module tests/tools/openstreetmap-geocode.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapGeocode } from '@/mcp-server/tools/definitions/openstreetmap-geocode.tool.js';
import type { NominatimPlace, NominatimSearchParams } from '@/services/nominatim/types.js';

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

describe('openstreetmapGeocode', () => {
  beforeEach(() => {
    mockSearch.mockReset();
  });

  describe('happy path — free-form query', () => {
    it('returns geocoding results for a valid query', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ query: 'Seattle' });
      const result = await openstreetmapGeocode.handler(input, ctx);

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
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ query: 'Space Needle Seattle' });
      const result = await openstreetmapGeocode.handler(input, ctx);

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
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ city: 'Seattle', state: 'Washington' });
      const result = await openstreetmapGeocode.handler(input, ctx);
      expect(result.total).toBe(1);
    });

    it('passes optional filters to the service', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({
        query: 'pharmacy',
        countrycodes: 'us',
        limit: 10,
        extratags: true,
        language: 'en',
      });
      await openstreetmapGeocode.handler(input, ctx);
      expect(mockSearch).toHaveBeenCalledOnce();
    });
  });

  describe('sparse upstream payload', () => {
    it('handles a place with only required fields (no optional data)', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ query: 'Seattle' });
      const result = await openstreetmapGeocode.handler(input, ctx);

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
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ query: 'Space Needle Seattle' });
      await openstreetmapGeocode.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveQuery).toBe('Space Needle Seattle');
    });

    it('reconstructs effectiveQuery from structured address fields', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({
        city: 'Seattle',
        state: 'Washington',
        country: 'US',
      });
      await openstreetmapGeocode.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveQuery).toBe('Seattle, Washington, US');
    });

    it('excludes undefined/empty structured fields from effectiveQuery', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ city: 'Seattle' });
      await openstreetmapGeocode.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      // Only 'Seattle' — other fields are undefined and should be filtered out
      expect(enrichment.effectiveQuery).toBe('Seattle');
    });
  });

  describe('truncation (#15)', () => {
    it('omits truncated enrichment when results are below the requested limit', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ query: 'Seattle', limit: 5 });
      await openstreetmapGeocode.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.shown).toBeUndefined();
      expect(enrichment.cap).toBeUndefined();
    });

    it('discloses truncated when results reach the requested limit', async () => {
      const capped = Array.from({ length: 3 }, (_, i) => ({ ...minimalPlace, place_id: 1000 + i }));
      mockSearch.mockResolvedValue(capped);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ query: 'coffee shops', limit: 3 });
      const result = await openstreetmapGeocode.handler(input, ctx);

      expect(result.total).toBe(3);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.shown).toBe(3);
      expect(enrichment.cap).toBe(3);
    });
  });

  describe('exclude_place_ids paging (#24)', () => {
    it('forwards exclude_place_ids to the service as excludePlaceIds', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({
        query: 'coffee',
        exclude_place_ids: ['111', '222'],
      });
      await openstreetmapGeocode.handler(input, ctx);
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({ excludePlaceIds: ['111', '222'] }),
        expect.anything(),
      );
    });

    it('omits excludePlaceIds when an empty array is supplied (form-client blank)', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ query: 'coffee', exclude_place_ids: [] });
      await openstreetmapGeocode.handler(input, ctx);
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
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({
        query: 'coffee',
        limit: 2,
        exclude_place_ids: ['999'],
      });
      await openstreetmapGeocode.handler(input, ctx);

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
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ query: 'coffee', limit: 2 });
      await openstreetmapGeocode.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.nextExcludeIds).toEqual(['1000', '1001']);
    });

    it('selects ref-or-place_id per result in nextExcludeIds (#25)', async () => {
      mockSearch.mockResolvedValue([
        { ...minimalPlace, place_id: 1000, osm_type: 'way', osm_id: 555 },
        { ...minimalPlace, place_id: 1001 },
      ]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ query: 'coffee', limit: 2 });
      await openstreetmapGeocode.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      // First result has an OSM ref (W555); the second falls back to its place_id.
      expect(enrichment.nextExcludeIds).toEqual(['W555', '1001']);
    });

    it('enrichmentTrailer.nextExcludeIds.render carries a self-identifying label (#25)', () => {
      const render = openstreetmapGeocode.enrichmentTrailer!.nextExcludeIds!.render!;
      const rendered = render(['N13872184444', 'W8544921317']);
      expect(rendered).toBe('**Next Exclude IDs:** N13872184444, W8544921317');
    });

    it('omits nextExcludeIds when results are below the requested limit', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ query: 'coffee', limit: 5 });
      await openstreetmapGeocode.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.nextExcludeIds).toBeUndefined();
    });
  });

  describe('exhausted paging (#35)', () => {
    it('returns success with an exhaustion notice when the walk runs dry', async () => {
      mockSearch.mockResolvedValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({
        query: 'Beinecke Library, New Haven',
        limit: 1,
        exclude_place_ids: ['W114134159'],
      });
      const result = await openstreetmapGeocode.handler(input, ctx);

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
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({
        query: 'Beinecke Library, New Haven',
        exclude_place_ids: ['W114134159'],
      });
      await openstreetmapGeocode.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      const noResultsHint = openstreetmapGeocode.errors!.find(
        (e) => e.reason === 'no_results',
      )!.recovery;
      expect(notice).not.toContain('intermediate qualifier');
      expect(notice).not.toBe(noResultsHint);
    });

    it('still throws no_results when an empty exclude_place_ids array is supplied', async () => {
      mockSearch.mockResolvedValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({
        query: 'xyzzy_nowhere_place',
        exclude_place_ids: [],
      });
      await expect(openstreetmapGeocode.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_results' },
      });
    });
  });

  describe('error paths', () => {
    it('throws invalid_input when query and structured fields are combined', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ query: 'Seattle', city: 'Seattle' });
      await expect(openstreetmapGeocode.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_input' },
      });
    });

    it('throws invalid_input when neither query nor structured fields are provided', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ limit: 5 });
      await expect(openstreetmapGeocode.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_input' },
      });
    });

    it('throws no_results when the service returns empty array', async () => {
      mockSearch.mockResolvedValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ query: 'xyzzy_nowhere_place' });
      await expect(openstreetmapGeocode.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_results' },
      });
    });

    it('surfaces parent-institution recovery guidance on no_results (#18)', async () => {
      mockSearch.mockResolvedValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({
        query: 'Beinecke Library, Yale University, New Haven',
      });
      const err = await openstreetmapGeocode.handler(input, ctx).catch((e) => e);
      expect(err.data.reason).toBe('no_results');
      expect(err.data.recovery?.hint).toContain('intermediate qualifier');
      expect(err.data.recovery.hint).toContain('structured address fields');
    });

    it('propagates service errors', async () => {
      mockSearch.mockRejectedValue(new Error('Network error'));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapGeocode.errors });
      const input = openstreetmapGeocode.input.parse({ query: 'Seattle' });
      await expect(openstreetmapGeocode.handler(input, ctx)).rejects.toThrow('Network error');
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
      const blocks = openstreetmapGeocode.format!(output);
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
      const blocks = openstreetmapGeocode.format!(output);
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
      const blocks = openstreetmapGeocode.format!(output);
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
      const blocks = openstreetmapGeocode.format!(output);
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
      const blocks = openstreetmapGeocode.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Bounding box');
      expect(text).toContain('website: https://example.com');
    });
  });
});
