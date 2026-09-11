/**
 * @fileoverview Tests for the openstreetmap-search-places tool.
 * @module tests/tools/openstreetmap-search-places.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapSearchPlaces } from '@/mcp-server/tools/definitions/openstreetmap-search-places.tool.js';
import type { NominatimPlace, NominatimSearchParams } from '@/services/nominatim/types.js';
import { type ContractError, captureThrown } from '../helpers/handler-error.js';

/**
 * The error `fetchWithTimeout` raises for a Nominatim HTTP 400: status-mapped to
 * InvalidParams, no `reason`, and the rejected request's JSON body under `data.body`.
 */
function nominatimBadRequest(message: string): McpError {
  return new McpError(JsonRpcErrorCode.InvalidParams, 'Nominatim returned HTTP 400 Bad Request.', {
    status: 400,
    statusText: 'Bad Request',
    body: JSON.stringify({ error: { code: 400, message } }),
    errorSource: 'FetchHttpError',
  });
}

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

    /**
     * The case this issue tracks: a page that exactly fills `limit` with nothing
     * beyond it. Nominatim's /search reports no total anywhere — not in the JSON body
     * (a bare array) and not in the response headers — so page size alone cannot tell
     * "capped, more available" from "coincidentally exhausted", and the false positive
     * pointed callers at a nextExcludeIds walk that came back empty on the next call.
     */
    it('asks Nominatim for one result past the limit as the exhaustion probe', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'coffee shops', limit: 3 });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(mockSearch.mock.calls[0]![0].limit).toBe(4);
    });

    /**
     * The probe reports the relevance cutoff, not the end of the set: verified live,
     * `q=pharmacy&limit=11` returns 10 rows, yet excluding those 10 ids returns 10 more.
     * So a full page with no probe hit still offers the paging token — withholding it
     * ended the walk while less-accurate matches remained reachable.
     */
    it('offers nextExcludeIds on a full page even when the probe finds nothing', async () => {
      const exact = Array.from({ length: 3 }, (_, i) => ({ ...minimalPlace, place_id: 1000 + i }));
      mockSearch.mockResolvedValue(exact);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'coffee shops', limit: 3 });
      const result = await openstreetmapSearchPlaces.handler(input, ctx);

      expect(result.total).toBe(3);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.shown).toBeUndefined();
      expect(enrichment.cap).toBeUndefined();
      expect(enrichment.nextExcludeIds).toEqual(['1000', '1001', '1002']);
    });

    it('discloses truncated when the probe confirms a further match', async () => {
      const probed = Array.from({ length: 4 }, (_, i) => ({ ...minimalPlace, place_id: 1000 + i }));
      mockSearch.mockResolvedValue(probed);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'coffee shops', limit: 3 });
      const result = await openstreetmapSearchPlaces.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.shown).toBe(3);
      expect(enrichment.cap).toBe(3);
      expect(enrichment.nextExcludeIds).toHaveLength(3);
      // The probe row is a signal, never a result — the caller sees at most `limit`.
      expect(result.total).toBe(3);
      expect(result.results).toHaveLength(3);
      expect(result.results.map((r) => r.place_id)).toEqual([1000, 1001, 1002]);
    });

    it('never leaks the probe row into nextExcludeIds', async () => {
      mockSearch.mockResolvedValue([
        { ...minimalPlace, place_id: 1000, osm_type: 'node', osm_id: 11 },
        { ...minimalPlace, place_id: 1001, osm_type: 'way', osm_id: 22 },
        { ...minimalPlace, place_id: 1002, osm_type: 'relation', osm_id: 33 },
      ]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'coffee', limit: 2 });
      await openstreetmapSearchPlaces.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.nextExcludeIds).toEqual(['N11', 'W22']);
      expect(enrichment.nextExcludeIds).not.toContain('R33');
    });

    // Regression: the fixed below-limit case from v0.2.9 must keep behaving.
    it('omits truncated when the probe comes back short of the limit', async () => {
      mockSearch.mockResolvedValue([minimalPlace, { ...minimalPlace, place_id: 1001 }]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'coffee shops', limit: 5 });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(getEnrichment(ctx).truncated).toBeUndefined();
    });

    /**
     * The probe at the tool's own 40-result ceiling asks Nominatim for 41. Measured
     * live against the public instance on two queries (`q=pharmacy`, `q=school`): both
     * answer 41 rows in full, so the probe is never silently clipped into a false
     * negative at any `limit` this tool accepts. How many rows a request *above* 41
     * yields is query-dependent rather than a fixed clip, and nothing here depends on
     * it — the documented 40 maximum is not enforced as a hard clip either.
     */
    it('probes past the 40-result input ceiling without clipping', async () => {
      const probed = Array.from({ length: 41 }, (_, i) => ({
        ...minimalPlace,
        place_id: 2000 + i,
      }));
      mockSearch.mockResolvedValue(probed);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'coffee shops', limit: 40 });
      const result = await openstreetmapSearchPlaces.handler(input, ctx);

      expect(mockSearch.mock.calls[0]![0].limit).toBe(41);
      expect(result.total).toBe(40);
      expect(getEnrichment(ctx).truncated).toBe(true);
    });

    it('reports the truncation contract in the field descriptions', () => {
      const truncated = openstreetmapSearchPlaces.enrichment!.truncated.description!;
      expect(truncated).toMatch(/probe|confirm/i);
      // The old contract — a full page inferred as truncation — must not survive.
      expect(truncated).not.toContain('Nominatim may have more');
      // Absent truncation is not a claim that the set is exhausted.
      expect(truncated).toMatch(/relevance cutoff/i);

      const nextExcludeIds = openstreetmapSearchPlaces.enrichment!.nextExcludeIds.description!;
      expect(nextExcludeIds).not.toContain('Present only when truncated is true');
      expect(nextExcludeIds).toMatch(/filled the requested limit/i);
    });

    /**
     * Regression for #39: `notice` was documented as an empty-page field, but
     * `ctx.enrich.truncated()` writes its cap message into that same key, so a full
     * page of results arrives carrying a notice. An agent trusting the description
     * read a first-page cap notice as "the paging walk is exhausted" and abandoned
     * the walk one page in.
     */
    it('carries the cap notice alongside results, as the field description states', async () => {
      // Four rows for a limit of three: the #15 probe row confirms the cap is real.
      const capped = Array.from({ length: 4 }, (_, i) => ({ ...minimalPlace, place_id: 1000 + i }));
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
      const capped = Array.from({ length: 4 }, (_, i) => ({ ...minimalPlace, place_id: 1000 + i }));
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
        // Probe row (#15): confirms the page was capped; never returned to the caller.
        { ...minimalPlace, place_id: 1002, osm_type: 'way', osm_id: 999 },
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
        { ...minimalPlace, place_id: 1002 },
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
        { ...minimalPlace, place_id: 1002 },
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

    it('omits truncated and nextExcludeIds alike when results are below the requested limit', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'coffee', limit: 5 });
      await openstreetmapSearchPlaces.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.nextExcludeIds).toBeUndefined();
    });

    it('trims, drops blank entries and uppercases the ref prefix before forwarding', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'coffee',
        exclude_place_ids: [' n123 ', '', 'w456', '789'],
      });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(mockSearch.mock.calls[0]![0].excludePlaceIds).toEqual(['N123', 'W456', '789']);
    });

    /**
     * A form-based client submits the whole schema shape, so an untouched repeated field
     * arrives as one empty string. That was a silent no-op before the token pattern
     * landed and must stay accepted rather than newly rejected.
     */
    it('accepts an all-blank exclude array and forwards no exclusion at all', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'coffee',
        exclude_place_ids: ['', '   '],
      });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(mockSearch).toHaveBeenCalledWith(
        expect.not.objectContaining({ excludePlaceIds: expect.anything() }),
        expect.anything(),
      );
    });

    // Blank entries exclude nothing, so an empty page is a first-page miss to be
    // rewritten — not the terminal state of a paging walk.
    it('treats a blank-only exclude array as a first page when nothing matches', async () => {
      mockSearch.mockResolvedValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'xyzzy_nowhere_place',
        exclude_place_ids: [''],
      });
      await expect(openstreetmapSearchPlaces.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_results' },
      });
    });
  });

  /**
   * `layer` was a bare `z.string()` before the documented set became a published
   * `pattern`, so an empty value parsed and the handler dropped it. Nominatim itself
   * accepts any casing of a documented layer name, so neither form may be newly refused.
   */
  describe('layer normalization', () => {
    const searchParams = () => mockSearch.mock.calls[0]![0];

    it('accepts an empty layer and forwards none', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Seattle', layer: '' });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(searchParams().layer).toBeUndefined();
    });

    it('accepts an uppercase layer and forwards it as given', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Seattle', layer: 'ADDRESS' });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(searchParams().layer).toBe('ADDRESS');
    });

    it('accepts a mixed-case list and forwards the spacing as given', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'Seattle',
        layer: 'Address, poi',
      });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(searchParams().layer).toBe('Address, poi');
    });
  });

  /**
   * #66: `countrycodes` was a bare `z.string()`, so the alpha-2 constraint reached the
   * caller as prose only. The pattern must not newly refuse a spelling the endpoint
   * honors, and the blank a form client submits stays a no-op rather than a rejection.
   */
  describe('countrycodes normalization (#66)', () => {
    const searchParams = () => mockSearch.mock.calls[0]![0];

    it('accepts an empty countrycodes and forwards none', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Paris', countrycodes: '' });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(searchParams().countrycodes).toBeUndefined();
    });

    it.each(['us,ca', 'US', 'us, ca'])('forwards %j as given', async (countrycodes) => {
      mockSearch.mockReset().mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Paris', countrycodes });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(searchParams().countrycodes).toBe(countrycodes);
    });

    /**
     * A well-formed code for a country that does not exist is Nominatim's to answer:
     * it returns HTTP 200 with an empty array, which is the existing no_results path
     * and stays distinct from the malformed case the pattern now refuses.
     */
    it('forwards a well-formed non-existent code and reports no_results', async () => {
      mockSearch.mockResolvedValue([]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Paris', countrycodes: 'xx' });
      const err = (await captureThrown(
        openstreetmapSearchPlaces.handler(input, ctx),
      )) as ContractError;
      expect(searchParams().countrycodes).toBe('xx');
      expect(err.data.reason).toBe('no_results');
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
      const capped = Array.from({ length: 3 }, (_, i) => ({
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

  /**
   * Regression for #63: the three Overpass tools label every trailer field, so their
   * `content[]` reads as prose headings. This tool labeled only `nextExcludeIds`, so
   * everything else fell back to the raw camelCase key and rendered as a struct dump.
   * `structuredContent` was correct throughout — this is the rendering only.
   */
  describe('enrichment trailer labels (#63)', () => {
    it('renders human headings for every field on a truncated, tag-relevant page', async () => {
      mockSearch.mockResolvedValue(
        Array.from({ length: 3 }, (_, i) => ({
          ...richPlace,
          place_id: 2000 + i,
          osm_id: 500 + i,
        })),
      );
      const result = await runToolContract(openstreetmapSearchPlaces, {
        query: 'trailhead',
        limit: 2,
        extratags: true,
      });
      const text = contentText(result.content);

      expect(text).toContain('**Effective Query:**');
      expect(text).toContain('**Results Truncated:**');
      expect(text).toContain('**Results Shown:**');
      expect(text).toContain('**Result Cap:**');
      expect(text).toContain('**Tag Selection Caveat:**');
      expect(text).toContain('**Next Exclude IDs:**');

      for (const key of [
        '**effectiveQuery:**',
        '**truncated:**',
        '**shown:**',
        '**cap:**',
        '**tagSelectionCaveat:**',
        '**nextExcludeIds:**',
      ]) {
        expect(text).not.toContain(key);
      }
    });

    it('leaves structuredContent byte-identical to the unlabeled values', async () => {
      mockSearch.mockResolvedValue(
        Array.from({ length: 3 }, (_, i) => ({
          ...richPlace,
          place_id: 2000 + i,
          osm_id: 500 + i,
        })),
      );
      const result = await runToolContract(openstreetmapSearchPlaces, {
        query: 'trailhead',
        limit: 2,
        extratags: true,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      const text = contentText(result.content);

      // The label changes the heading, never the value behind it.
      expect(structured.effectiveQuery).toBe('trailhead');
      expect(structured.truncated).toBe(true);
      expect(structured.cap).toBe(2);
      expect(structured.tagSelectionCaveat).toContain('Overpass-only');
      expect(text).toContain(`**Effective Query:** ${structured.effectiveQuery as string}`);
      expect(text).toContain(`**Results Shown:** ${structured.shown as number}`);
      expect(text).toContain(`**Result Cap:** ${structured.cap as number}`);
      expect(text).toContain(
        `**Next Exclude IDs:** ${(structured.nextExcludeIds as string[]).join(', ')}`,
      );
    });

    // The framework sets `notice`'s trailer kind, which `label`/`render` do not touch.
    it('keeps notice rendering as a blockquote, not a labeled field', async () => {
      mockSearch.mockResolvedValue(
        Array.from({ length: 3 }, (_, i) => ({
          ...richPlace,
          place_id: 2000 + i,
          osm_id: 500 + i,
        })),
      );
      const result = await runToolContract(openstreetmapSearchPlaces, {
        query: 'trailhead',
        limit: 2,
      });
      const text = contentText(result.content);
      const notice = (result.structuredContent as { notice?: string }).notice!;
      expect(text).toContain(`> ${notice}`);
      expect(text).not.toContain('**notice:**');
    });
  });

  /**
   * #62: `countrycodes` cannot constrain a search to a city, watershed, or study-area
   * rectangle, and adding locality words to the free-form query is fuzzier than
   * Nominatim's own geographic bias. A bbox discovered with openstreetmap_query_bbox
   * had no way to reach the geocoding step.
   */
  describe('viewbox locality bias (#62)', () => {
    /** Boston-area box: the case that disambiguates Cambridge MA from Cambridge UK. */
    const boston = { west: -71.2, south: 42.3, east: -70.9, north: 42.45 };

    const searchParams = () => mockSearch.mock.calls[0]![0];

    it('forwards the viewbox as Nominatim west,north,east,south', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'Cambridge',
        viewbox: boston,
      });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(searchParams().viewbox).toBe('-71.2,42.45,-70.9,42.3');
    });

    it('omits bounded when it is absent or false — viewbox biases ranking only', async () => {
      for (const raw of [
        { query: 'Cambridge', viewbox: boston },
        { query: 'Cambridge', viewbox: boston, bounded: false },
      ]) {
        mockSearch.mockReset().mockResolvedValue([minimalPlace]);
        const ctx = createMockContext({
          tenantId: 'test',
          errors: openstreetmapSearchPlaces.errors,
        });
        await openstreetmapSearchPlaces.handler(openstreetmapSearchPlaces.input.parse(raw), ctx);
        expect(searchParams().viewbox).toBeDefined();
        expect(searchParams().bounded).toBeFalsy();
      }
    });

    it('forwards bounded alongside the viewbox as a hard restriction', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'Cambridge',
        viewbox: boston,
        bounded: true,
      });
      await openstreetmapSearchPlaces.handler(input, ctx);
      expect(searchParams().bounded).toBe(true);
      expect(searchParams().viewbox).toBe('-71.2,42.45,-70.9,42.3');
    });

    it('sends no viewbox or bounded when neither was supplied', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      await openstreetmapSearchPlaces.handler(
        openstreetmapSearchPlaces.input.parse({ query: 'Cambridge' }),
        ctx,
      );
      expect(searchParams().viewbox).toBeUndefined();
      expect(searchParams().bounded).toBeUndefined();
    });

    it('rejects bounded: true with no viewbox rather than ignoring it', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Cambridge', bounded: true });
      const err = (await captureThrown(
        openstreetmapSearchPlaces.handler(input, ctx),
      )) as ContractError;
      expect(err.data.reason).toBe('bounded_without_viewbox');
      expect(err.data.recovery?.hint).toContain('viewbox');
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('accepts bounded: false with no viewbox — nothing to restrict, nothing to reject', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Cambridge', bounded: false });
      await expect(openstreetmapSearchPlaces.handler(input, ctx)).resolves.toBeDefined();
    });

    /**
     * Not openstreetmap_query_bbox's antimeridian allowance. Verified live: Nominatim
     * reads the two longitudes as an unordered min/max pair, so `viewbox=170,10,-170,-10`
     * searches the ~340°-wide box between them — the opposite of the intended sliver —
     * and reports no error.
     */
    it.each([
      [
        'inverted longitude (antimeridian-shaped)',
        { west: 170, south: -10, east: -170, north: 10 },
      ],
      ['inverted latitude', { west: -71.2, south: 42.45, east: -70.9, north: 42.3 }],
      ['degenerate longitude', { west: -71.2, south: 42.3, east: -71.2, north: 42.45 }],
      ['degenerate latitude', { west: -71.2, south: 42.3, east: -70.9, north: 42.3 }],
    ])('rejects a %s viewbox before any request is sent', async (_label, viewbox) => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Cambridge', viewbox });
      const err = (await captureThrown(
        openstreetmapSearchPlaces.handler(input, ctx),
      )) as ContractError;
      expect(err.data.reason).toBe('invalid_viewbox');
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('names the antimeridian divergence from openstreetmap_query_bbox in the message', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'Cambridge',
        viewbox: { west: 170, south: -10, east: -170, north: 10 },
      });
      const err = (await captureThrown(
        openstreetmapSearchPlaces.handler(input, ctx),
      )) as ContractError;
      expect(err.message).toMatch(/antimeridian/i);
      expect(err.message).toContain('openstreetmap_query_bbox');
    });

    it('echoes the effective viewbox and restriction mode on both surfaces', async () => {
      mockSearch.mockResolvedValue([richPlace]);
      const result = await runToolContract(openstreetmapSearchPlaces, {
        query: 'Cambridge',
        viewbox: boston,
        bounded: true,
      });

      const structured = result.structuredContent as {
        effectiveViewbox?: typeof boston;
        boundedApplied?: boolean;
      };
      expect(structured.effectiveViewbox).toEqual(boston);
      expect(structured.boundedApplied).toBe(true);

      const text = contentText(result.content);
      expect(text).toContain(
        '**Effective Viewbox:** west -71.2, south 42.3, east -70.9, north 42.45',
      );
      expect(text).toContain('**Viewbox Restricted:** true');
      expect(text).not.toContain('**effectiveViewbox:**');
      expect(text).not.toContain('**boundedApplied:**');
    });

    it('reports boundedApplied false when the viewbox only biased ranking', async () => {
      mockSearch.mockResolvedValue([richPlace]);
      const result = await runToolContract(openstreetmapSearchPlaces, {
        query: 'Cambridge',
        viewbox: boston,
      });
      const structured = result.structuredContent as { boundedApplied?: boolean };
      expect(structured.boundedApplied).toBe(false);
      expect(contentText(result.content)).toContain('**Viewbox Restricted:** false');
    });

    it('omits both echo fields entirely when no viewbox was supplied', async () => {
      mockSearch.mockResolvedValue([richPlace]);
      const result = await runToolContract(openstreetmapSearchPlaces, { query: 'Cambridge' });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.effectiveViewbox).toBeUndefined();
      expect(structured.boundedApplied).toBeUndefined();
      expect(contentText(result.content)).not.toContain('Effective Viewbox');
    });

    it('composes with countrycodes, limit, layer, featureType and exclude_place_ids', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        query: 'Cambridge',
        viewbox: boston,
        bounded: true,
        countrycodes: 'us',
        limit: 3,
        layer: 'address,poi',
        featureType: 'city',
        exclude_place_ids: ['N123'],
      });
      await openstreetmapSearchPlaces.handler(input, ctx);

      expect(searchParams()).toMatchObject({
        q: 'Cambridge',
        countrycodes: 'us',
        layer: 'address,poi',
        featureType: 'city',
        excludePlaceIds: ['N123'],
        viewbox: '-71.2,42.45,-70.9,42.3',
        bounded: true,
      });
    });

    // The box scopes a structured-address search the same way it scopes a free-form one:
    // both modes reach the same Nominatim endpoint, and neither field set displaces the other.
    it('composes with the structured address mode, forwarding both', async () => {
      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({
        city: 'Cambridge',
        state: 'Massachusetts',
        viewbox: boston,
        bounded: true,
      });
      const result = await openstreetmapSearchPlaces.handler(input, ctx);

      expect(searchParams()).toMatchObject({
        city: 'Cambridge',
        state: 'Massachusetts',
        viewbox: '-71.2,42.45,-70.9,42.3',
        bounded: true,
      });
      expect(searchParams().q).toBeUndefined();
      expect(result.total).toBe(1);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveQuery).toBe('Cambridge, Massachusetts');
      expect(enrichment.effectiveViewbox).toEqual(boston);
      expect(enrichment.boundedApplied).toBe(true);
    });

    it('accepts a viewbox at the coordinate extremes and rejects one beyond them', () => {
      expect(() =>
        openstreetmapSearchPlaces.input.parse({
          query: 'anywhere',
          viewbox: { west: -180, south: -90, east: 180, north: 90 },
        }),
      ).not.toThrow();
      expect(() =>
        openstreetmapSearchPlaces.input.parse({
          query: 'anywhere',
          viewbox: { west: -181, south: -90, east: 180, north: 90 },
        }),
      ).toThrow();
      expect(() =>
        openstreetmapSearchPlaces.input.parse({
          query: 'anywhere',
          viewbox: { west: -180, south: -90, east: 180, north: 91 },
        }),
      ).toThrow();
    });

    it('rejects a partial viewbox rather than forwarding a half-specified box', () => {
      expect(() =>
        openstreetmapSearchPlaces.input.parse({
          query: 'Cambridge',
          viewbox: { west: -71.2, south: 42.3 },
        }),
      ).toThrow();
      expect(() =>
        openstreetmapSearchPlaces.input.parse({ query: 'Cambridge', viewbox: {} }),
      ).toThrow();
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
        const err = (await captureThrown(
          openstreetmapSearchPlaces.handler(input, ctx),
        )) as ContractError;
        return err.data.recovery?.hint;
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
      const err = (await captureThrown(
        openstreetmapSearchPlaces.handler(input, ctx),
      )) as ContractError;
      expect(err.data.reason).toBe('no_results');
      expect(err.data.recovery?.hint).toContain('intermediate qualifier');
      expect(err.data.recovery?.hint).toContain('structured address fields');
    });

    it('propagates service errors', async () => {
      mockSearch.mockRejectedValue(new Error('Network error'));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Seattle' });
      await expect(openstreetmapSearchPlaces.handler(input, ctx)).rejects.toThrow('Network error');
    });
  });

  /**
   * #69: the no_results message was built from `input.query ?? [city, state, country]`,
   * a field list predating the six-field `effectiveQuery` the success path echoes. A
   * street-, county- or postalcode-only search therefore reported an empty quoted
   * string, and street was dropped from a street+city echo. `??` also treats an explicit
   * empty query as present, so `query: ""` beside a structured field hit the same
   * message — which `effectiveQuery`'s truthy check does not.
   */
  describe('no_results message (#69)', () => {
    /** The message as both surfaces carry it: the error envelope and the rendered text. */
    const noResultsMessage = async (raw: Record<string, unknown>) => {
      mockSearch.mockResolvedValue([]);
      const result = await runToolContract(openstreetmapSearchPlaces, raw as never);
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error?: { message?: string; data?: { reason?: string } };
      };
      expect(error?.data?.reason).toBe('no_results');
      return { structured: error?.message ?? '', text: contentText(result.content) };
    };

    it.each([
      [
        'a street-only search',
        { street: '99999 Zzzqx Nonexistent Blvd' },
        '99999 Zzzqx Nonexistent Blvd',
      ],
      ['a county-only search', { county: 'Cook County' }, 'Cook County'],
      ['a postalcode-only search', { postalcode: '90210' }, '90210'],
      [
        'a street and city search',
        { street: '1 Main St', city: 'Springfield' },
        '1 Main St, Springfield',
      ],
      [
        'an empty query beside a structured field',
        { query: '', city: 'Springfield' },
        'Springfield',
      ],
      // Characterization: the free-form path echoed its query correctly all along.
      ['a free-form query', { query: 'xyzzy_nowhere_place' }, 'xyzzy_nowhere_place'],
    ])('echoes the effective query for %s on both surfaces', async (_label, raw, expected) => {
      const { structured, text } = await noResultsMessage(raw);
      expect(structured).toBe(`No places found for "${expected}"`);
      expect(text).toContain(`No places found for "${expected}"`);
    });

    /** The echo follows the same six-field order and separator the success path uses. */
    it('orders the structured fields exactly as the success path echoes them', async () => {
      const raw = {
        street: '1 Main St',
        city: 'Springfield',
        county: 'Sangamon',
        state: 'Illinois',
        country: 'US',
        postalcode: '62701',
      };
      const expected = '1 Main St, Springfield, Sangamon, Illinois, US, 62701';
      const { structured, text } = await noResultsMessage(raw);
      expect(structured).toBe(`No places found for "${expected}"`);
      expect(text).toContain(expected);

      mockSearch.mockResolvedValue([minimalPlace]);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      await openstreetmapSearchPlaces.handler(openstreetmapSearchPlaces.input.parse(raw), ctx);
      expect(getEnrichment(ctx).effectiveQuery).toBe(expected);
    });
  });

  /**
   * Regression for #59: a 400 arrived with no `reason`, so the catch block's bare
   * non-429 branch folded it into the retryable `upstream_error` bucket — the same
   * one an actual Nominatim outage lands in — and dropped the parameter name
   * Nominatim's own JSON body carries.
   */
  describe('invalid parameters (#59)', () => {
    const failWith = async (
      message: string,
      raw: Record<string, unknown> = { query: 'Seattle' },
    ) => {
      mockSearch.mockRejectedValue(nominatimBadRequest(message));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse(raw);
      return (await captureThrown(openstreetmapSearchPlaces.handler(input, ctx))) as ContractError;
    };

    it('surfaces a Nominatim 400 as non-retryable invalid_parameters', async () => {
      const err = await failWith("Parameter 'layer' must be a comma-separated list of: address");
      expect(err.data.reason).toBe('invalid_parameters');
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.data.retryable).not.toBe(true);
    });

    it("preserves Nominatim's own message naming the rejected parameter", async () => {
      const err = await failWith("Parameter 'layer' must be a comma-separated list of: address");
      expect(err.message).toContain("Parameter 'layer' must be a comma-separated list of: address");
    });

    it('does not hand back the base-URL recovery hint that cannot fix bad input', async () => {
      const err = await failWith('Invalid exclude ID: garbage');
      expect(err.data.recovery?.hint).toBeDefined();
      expect(err.data.recovery?.hint).not.toContain('OSM_NOMINATIM_BASE_URL');
    });

    it('leaves a bare 400 message intact when the body carries no error text', async () => {
      mockSearch.mockRejectedValue(
        new McpError(JsonRpcErrorCode.InvalidParams, 'Nominatim returned HTTP 400 Bad Request.', {
          status: 400,
          body: 'not json at all',
          errorSource: 'FetchHttpError',
        }),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      const input = openstreetmapSearchPlaces.input.parse({ query: 'Seattle' });
      const err = (await captureThrown(
        openstreetmapSearchPlaces.handler(input, ctx),
      )) as ContractError;
      expect(err.data.reason).toBe('invalid_parameters');
      expect(err.message).toBe('Nominatim returned HTTP 400 Bad Request.');
    });

    // The 429 and non-429 branches this fix sits beside are unchanged (#26, #32, #53).
    it('still routes a 429 to rate_limited and a 503 to upstream_error', async () => {
      mockSearch.mockRejectedValue(
        new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', { status: 429 }),
      );
      let ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      let input = openstreetmapSearchPlaces.input.parse({ query: 'Seattle' });
      let err = (await captureThrown(
        openstreetmapSearchPlaces.handler(input, ctx),
      )) as ContractError;
      expect(err.data.reason).toBe('rate_limited');

      mockSearch.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 503', {
          status: 503,
        }),
      );
      ctx = createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors });
      input = openstreetmapSearchPlaces.input.parse({ query: 'Seattle' });
      err = (await captureThrown(openstreetmapSearchPlaces.handler(input, ctx))) as ContractError;
      expect(err.data.reason).toBe('upstream_error');
    });
  });

  /**
   * Regression for #59: both reproduction cases were deterministic bad input that the
   * published schema advertised as valid, so they cost a live Nominatim round trip
   * (four, before the retry fix) to learn what a `pattern` states up front.
   */
  describe('schema-level parameter validation (#59)', () => {
    /** The field paths a rejection is attributed to, so a failure names the offending input. */
    const rejectedPaths = (raw: Record<string, unknown>): string[] => {
      const parsed = openstreetmapSearchPlaces.input.safeParse(raw);
      expect(parsed.success).toBe(false);
      return parsed.error!.issues.map((issue) => issue.path.join('.'));
    };

    it('accepts every documented layer value', () => {
      for (const layer of ['address', 'poi', 'railway', 'natural', 'manmade']) {
        expect(openstreetmapSearchPlaces.input.parse({ query: 'Seattle', layer }).layer).toBe(
          layer,
        );
      }
    });

    it('accepts a comma-separated layer list, with or without spaces', () => {
      expect(
        openstreetmapSearchPlaces.input.parse({ query: 'Seattle', layer: 'address,poi' }).layer,
      ).toBe('address,poi');
      expect(
        openstreetmapSearchPlaces.input.parse({ query: 'Seattle', layer: 'address, poi' }).layer,
      ).toBe('address, poi');
    });

    it('rejects an undocumented layer value, naming the field', () => {
      for (const layer of ['bogus', 'address,bogus', 'addres']) {
        expect(rejectedPaths({ query: 'Seattle', layer })).toContain('layer');
      }
    });

    it('accepts both exclude token forms the tool itself emits', () => {
      const parsed = openstreetmapSearchPlaces.input.parse({
        query: 'coffee',
        exclude_place_ids: ['N13872184444', 'W555', 'R146656', '325649065'],
      });
      expect(parsed.exclude_place_ids).toHaveLength(4);
    });

    it('rejects a malformed exclude_place_ids entry, naming the offending index', () => {
      expect(rejectedPaths({ query: 'coffee', exclude_place_ids: ['garbage'] })).toContain(
        'exclude_place_ids.0',
      );
      expect(rejectedPaths({ query: 'coffee', exclude_place_ids: ['N123', 'W12x'] })).toContain(
        'exclude_place_ids.1',
      );
    });

    /**
     * #66: Nominatim discards a `countrycodes` token it cannot parse and answers HTTP
     * 200 with the search run unfiltered, so an alpha-3 code or a semicolon list
     * silently widened the query to the whole world while the response still echoed
     * the filter. There is no upstream rejection to remap — the pattern is the fix.
     */
    it('accepts an alpha-2 countrycodes list in either casing, spaced or not', () => {
      for (const countrycodes of ['us,ca', 'US', 'us, ca', 'us , ca', 'uS,Ca', '']) {
        expect(
          openstreetmapSearchPlaces.input.parse({ query: 'Paris', countrycodes }).countrycodes,
        ).toBe(countrycodes);
      }
    });

    /**
     * Nominatim skips an empty list element and applies the codes around it, so a
     * trailing, leading, or doubled comma must not be refused as a dropped filter.
     */
    it('accepts a list carrying an empty element, as Nominatim does', () => {
      for (const countrycodes of ['us,', ',us', 'us,,ca', 'us, ,ca']) {
        expect(
          openstreetmapSearchPlaces.input.parse({ query: 'Paris', countrycodes }).countrycodes,
        ).toBe(countrycodes);
      }
    });

    it('rejects a countrycodes value Nominatim would silently drop, naming the field', () => {
      for (const countrycodes of ['USA', 'us;fr', 'France', 'u', 'us,USA', 'us ca', 'zzzzzzzzzz']) {
        expect(rejectedPaths({ query: 'Paris', countrycodes })).toContain('countrycodes');
      }
    });

    /** A well-formed but non-existent code is Nominatim's to answer, not the schema's. */
    it('accepts a well-formed code for a country that does not exist', () => {
      expect(
        openstreetmapSearchPlaces.input.parse({ query: 'Paris', countrycodes: 'xx' }).countrycodes,
      ).toBe('xx');
    });

    it('leaves the structured country field free-form', () => {
      for (const country of ['USA', 'France', 'us']) {
        expect(openstreetmapSearchPlaces.input.parse({ city: 'Paris', country }).country).toBe(
          country,
        );
      }
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
