/**
 * @fileoverview Tests for the openstreetmap-reverse-geocode tool.
 * @module tests/tools/openstreetmap-reverse-geocode.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapReverseGeocode } from '@/mcp-server/tools/definitions/openstreetmap-reverse-geocode.tool.js';
import type { NominatimService } from '@/services/nominatim/nominatim-service.js';
import type {
  NominatimErrorBody,
  NominatimPlace,
  NominatimReverseParams,
} from '@/services/nominatim/types.js';
import { type ContractError, captureThrown, wireError } from '../helpers/handler-error.js';
import { markdownText } from '../helpers/markdown.js';

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

// --- service mock --------------------------------------------------------

const mockReverse =
  vi.fn<
    (params: NominatimReverseParams, ctx: Context) => Promise<NominatimPlace | NominatimErrorBody>
  >();

vi.mock('@/services/nominatim/nominatim-service.js', () => ({
  getNominatimService: () => ({ reverse: mockReverse }),
}));

// The #120 cases route mockReverse through the real service at the fetch seam, which reads
// its base URL here rather than from the developer's environment.
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    nominatimBaseUrl: 'https://nominatim.openstreetmap.org',
    nominatimUserAgent: 'openstreetmap-mcp-server/test',
  }),
}));

// --- fixtures ------------------------------------------------------------

const validPlace: NominatimPlace = {
  place_id: 5678,
  osm_type: 'way',
  osm_id: 50637691,
  lat: 47.6062,
  lon: -122.3321,
  display_name: '400 Broad Street, Seattle, Washington, 98109, United States',
  name: 'Space Needle',
  category: 'man_made',
  type: 'tower',
  address: {
    house_number: '400',
    road: 'Broad Street',
    city: 'Seattle',
    state: 'Washington',
    postcode: '98109',
    country: 'United States',
    country_code: 'us',
  },
  boundingbox: [47.619, 47.622, -122.352, -122.347],
};

/** What /reverse serves over open ocean — an error string and no place fields at all. */
const noDataBody: NominatimErrorBody = { error: 'Unable to geocode' };

const sparsePlace: NominatimPlace = {
  place_id: 1111,
  lat: 47.6,
  lon: -122.3,
  display_name: 'Some unnamed road, Seattle, WA',
};

// -------------------------------------------------------------------------

describe('openstreetmapReverseGeocode', () => {
  beforeEach(() => {
    mockReverse.mockReset();
  });

  describe('argument aliases (#110)', () => {
    it('maps latitude and longitude with canonical defaults and both output surfaces', async () => {
      mockReverse.mockResolvedValue(validPlace);
      const result = await runToolContract(openstreetmapReverseGeocode, {
        latitude: 47.6205,
        longitude: -122.3493,
      } as never);
      expect(result.isError).not.toBe(true);
      expect(mockReverse).toHaveBeenCalledWith(
        { lat: 47.6205, lon: -122.3493, zoom: 18, extratags: false },
        expect.anything(),
      );
      expect(result.structuredContent).toMatchObject({ result: { place_id: 5678 } });
      expect(
        result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
      ).toContain('Space Needle');
    });

    it('keeps no_coverage recovery on both surfaces after alias parsing', async () => {
      mockReverse.mockResolvedValue(noDataBody);
      const result = await runToolContract(openstreetmapReverseGeocode, {
        latitude: 0,
        longitude: 0,
      } as never);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'no_coverage' } },
      });
      expect(
        result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
      ).toContain('No OSM data at coordinates (0, 0)');
    });
  });

  describe('happy path', () => {
    it('returns the closest OSM object for valid coordinates', async () => {
      mockReverse.mockResolvedValue(validPlace);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({ lat: 47.6205, lon: -122.3493 });
      const result = await openstreetmapReverseGeocode.handler(input, ctx);

      expect(result.result).toMatchObject({
        place_id: 5678,
        osm_type: 'way',
        osm_id: 50637691,
        lat: 47.6062,
        lon: -122.3321,
        display_name: expect.stringContaining('Broad Street'),
        name: 'Space Needle',
        category: 'man_made',
        type: 'tower',
      });
      expect(result.attribution).toContain('OpenStreetMap');
    });

    it('accepts optional parameters (zoom, layer, extratags, language)', async () => {
      mockReverse.mockResolvedValue(validPlace);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({
        lat: 47.6062,
        lon: -122.3321,
        zoom: 16,
        extratags: true,
        language: 'en',
      });
      const result = await openstreetmapReverseGeocode.handler(input, ctx);
      expect(result.result.place_id).toBe(5678);
      expect(mockReverse).toHaveBeenCalledOnce();
    });
  });

  describe('sparse upstream payload', () => {
    it('handles a result missing all optional fields', async () => {
      mockReverse.mockResolvedValue(sparsePlace);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({ lat: 47.6, lon: -122.3 });
      const result = await openstreetmapReverseGeocode.handler(input, ctx);

      expect(result.result.place_id).toBe(1111);
      expect(result.result.name).toBeUndefined();
      expect(result.result.category).toBeUndefined();
      expect(result.result.address).toBeUndefined();
    });
  });

  /**
   * Regression for #52: the tool matched on proximity and never disclosed that
   * extratags decorates whatever object it matched rather than selecting one, so an
   * absent tag read as an absent tag in OpenStreetMap.
   */
  describe('tag-selection caveat (#52)', () => {
    it('reaches structuredContent and content[] when extratags was requested', async () => {
      mockReverse.mockResolvedValue(validPlace);
      const result = await runToolContract(openstreetmapReverseGeocode, {
        lat: 47.6205,
        lon: -122.3493,
        extratags: true,
      });

      const structured = result.structuredContent as { tagSelectionCaveat?: string };
      expect(structured.tagSelectionCaveat).toContain('Overpass-only');
      expect(structured.tagSelectionCaveat).toContain('openstreetmap_query_nearby');
      expect(
        (result.content as { type: string; text?: string }[])
          .map((block) => block.text ?? '')
          .join('\n'),
      ).toContain(structured.tagSelectionCaveat!);
    });

    // The case the caveat exists for: tags were asked for and the matched object
    // carries none, which says nothing about OpenStreetMap.
    it('fires on a sparse result carrying no tags at all', async () => {
      mockReverse.mockResolvedValue(sparsePlace);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({
        lat: 47.6,
        lon: -122.3,
        extratags: true,
      });
      await openstreetmapReverseGeocode.handler(input, ctx);

      expect(getEnrichment(ctx).tagSelectionCaveat).toContain('Overpass-only');
    });

    // Coordinates pick the object here, so no tag-selection mistake is available. The
    // one live hazard needs the tag map, which a default call does not carry.
    it('stays off when extratags was not requested', async () => {
      mockReverse.mockResolvedValue(validPlace);
      const result = await runToolContract(openstreetmapReverseGeocode, {
        lat: 47.6205,
        lon: -122.3493,
      });

      const structured = result.structuredContent as { tagSelectionCaveat?: string };
      expect(structured.tagSelectionCaveat).toBeUndefined();
      expect(
        (result.content as { type: string; text?: string }[])
          .map((block) => block.text ?? '')
          .join('\n'),
      ).not.toContain('Overpass-only');
    });
  });

  /**
   * Regression for #63: this tool declared no `enrichmentTrailer` at all, so its one
   * enrichment field rendered under the raw key `**tagSelectionCaveat:**` while the
   * three Overpass tools showed prose headings.
   */
  describe('enrichment trailer labels (#63)', () => {
    it('renders the caveat under a human heading, not the raw camelCase key', async () => {
      mockReverse.mockResolvedValue(validPlace);
      const result = await runToolContract(openstreetmapReverseGeocode, {
        lat: 47.6205,
        lon: -122.3493,
        extratags: true,
      });
      const text = (result.content as { type: string; text?: string }[])
        .map((block) => block.text ?? '')
        .join('\n');

      expect(text).toContain('**Tag Selection Caveat:**');
      expect(text).not.toContain('**tagSelectionCaveat:**');
      expect(markdownText(text)).toContain(
        `Tag Selection Caveat: ${(result.structuredContent as { tagSelectionCaveat: string }).tagSelectionCaveat}`,
      );
    });

    it('leaves structuredContent unchanged', async () => {
      mockReverse.mockResolvedValue(validPlace);
      const result = await runToolContract(openstreetmapReverseGeocode, {
        lat: 47.6205,
        lon: -122.3493,
        extratags: true,
      });
      expect(
        (result.structuredContent as { tagSelectionCaveat?: string }).tagSelectionCaveat,
      ).toContain('Overpass-only');
    });
  });

  describe('error paths', () => {
    it('throws no_coverage when Nominatim returns an error field', async () => {
      mockReverse.mockResolvedValue(noDataBody);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({ lat: 0, lon: 0 });
      await expect(openstreetmapReverseGeocode.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_coverage' },
      });
    });

    it('propagates service errors', async () => {
      mockReverse.mockRejectedValue(new Error('ServiceUnavailable'));
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({ lat: 47.6, lon: -122.3 });
      await expect(openstreetmapReverseGeocode.handler(input, ctx)).rejects.toThrow(
        'ServiceUnavailable',
      );
    });
  });

  /**
   * Regression for #59: a 400 arrived with no `reason` and the catch block's bare
   * non-429 branch folded it into the retryable `upstream_error` bucket, handing back
   * a "verify OSM_NOMINATIM_BASE_URL" hint that cannot fix a rejected parameter.
   */
  describe('invalid parameters (#59)', () => {
    const failWith = (message: string) => {
      mockReverse.mockRejectedValue(nominatimBadRequest(message));
      return wireError(
        openstreetmapReverseGeocode,
        { lat: 47.6, lon: -122.3 },
        { tenantId: 'test' },
      );
    };

    it('surfaces a Nominatim 400 as non-retryable invalid_parameters', async () => {
      const err = await failWith("Parameter 'layer' must be a comma-separated list of: address");
      expect(err.data.reason).toBe('invalid_parameters');
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.data.retryable).not.toBe(true);
    });

    it("preserves Nominatim's own message and drops the base-URL hint", async () => {
      const err = await failWith("Parameter 'layer' must be a comma-separated list of: address");
      expect(err.message).toContain("Parameter 'layer'");
      expect(err.data.recovery?.hint).toBeDefined();
      expect(err.data.recovery?.hint).not.toContain('OSM_NOMINATIM_BASE_URL');
    });

    it('still routes a 429 to rate_limited and a 503 to upstream_error', async () => {
      for (const [error, reason] of [
        [
          new McpError(JsonRpcErrorCode.RateLimited, 'Status: 429', { status: 429 }),
          'rate_limited',
        ],
        [
          new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Status: 503', { status: 503 }),
          'upstream_error',
        ],
      ] as const) {
        mockReverse.mockRejectedValue(error);
        const ctx = createMockContext({
          tenantId: 'test',
          errors: openstreetmapReverseGeocode.errors,
        });
        const input = openstreetmapReverseGeocode.input.parse({ lat: 47.6, lon: -122.3 });
        const err = (await captureThrown(
          openstreetmapReverseGeocode.handler(input, ctx),
        )) as ContractError;
        expect(err.data.reason).toBe(reason);
      }
    });
  });

  /**
   * #120: a request Nominatim never answered reached the caller with no reason or recovery.
   * The refused, unresolvable, and timed-out shapes are tabled on
   * openstreetmap_search_places; this proves this tool's catch maps one and leaves a caller
   * cancellation alone, through the real service with only `fetch` faked.
   */
  describe('unanswered requests (#120)', () => {
    const fetchStub = vi.fn<typeof fetch>();
    let service: NominatimService;

    beforeEach(async () => {
      const actual = await vi.importActual<
        typeof import('@/services/nominatim/nominatim-service.js')
      >('@/services/nominatim/nominatim-service.js');
      service = new actual.NominatimService({} as AppConfig, {} as StorageService);
      mockReverse.mockImplementation((params, ctx) => service.reverse(params, ctx));
      fetchStub.mockReset();
      vi.stubGlobal('fetch', fetchStub);
      vi.useFakeTimers();
    });

    afterEach(() => {
      service.dispose();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    /** Answers the Nominatim host with `respond(init)`; any other host fails the call. */
    const nominatimFetch = (respond: (init: RequestInit | undefined) => Promise<Response>) => {
      fetchStub.mockImplementation(async (url, init) => {
        const { hostname } = new URL(String(url));
        if (hostname === 'nominatim.openstreetmap.org') return respond(init);
        throw new Error(`Unmocked fetch to ${hostname}`);
      });
    };

    it('fails a refused connection as retryable upstream_error on both surfaces', async () => {
      nominatimFetch(async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
            code: 'ECONNREFUSED',
          }),
        });
      });
      const recovery = openstreetmapReverseGeocode.errors?.find(
        (entry) => entry.reason === 'upstream_error',
      )?.recovery;

      const pending = wireError(
        openstreetmapReverseGeocode,
        { lat: 47.6, lon: -122.3 },
        { tenantId: 't' },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const err = await pending;

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
      expect(err.data.recovery?.hint).toBe(recovery);
      expect(err.message).toBe(
        'Network error during fetch GET https://nominatim.openstreetmap.org/…?…: fetch failed (failed after 4 attempts)',
      );
      expect(err.text).toContain(`Recovery: ${recovery}`);
      expect(err.text).toContain('(reason upstream_error · retryable');
      expect(fetchStub).toHaveBeenCalledTimes(4);
    });

    // Read off the handler's throw: the envelope settles any post-abort failure as cancelled.
    it('passes a caller abort through untouched', async () => {
      nominatimFetch(
        (init) =>
          new Promise<never>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const caller = new AbortController();
      const ctx = createMockContext({
        tenantId: 't',
        signal: caller.signal,
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({ lat: 47.6, lon: -122.3 });
      const pending = captureThrown(openstreetmapReverseGeocode.handler(input, ctx));
      await vi.advanceTimersByTimeAsync(1_000);
      caller.abort();
      const thrown = (await pending) as ContractError;

      expect(thrown).toBeInstanceOf(McpError);
      expect(thrown.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(thrown.data).toMatchObject({ errorSource: 'FetchAborted' });
      expect(thrown.data.reason).toBeUndefined();
    });
  });

  describe('schema-level layer validation (#59)', () => {
    const reverseParams = () => mockReverse.mock.calls[0]![0];

    it('accepts every documented layer value and a comma-separated list', () => {
      for (const layer of ['address', 'poi', 'railway', 'natural', 'manmade', 'address,poi']) {
        expect(
          openstreetmapReverseGeocode.input.parse({ lat: 47.6, lon: -122.3, layer }).layer,
        ).toBe(layer);
      }
    });

    it('rejects an undocumented layer value, naming the field', () => {
      const parsed = openstreetmapReverseGeocode.input.safeParse({
        lat: 47.6,
        lon: -122.3,
        layer: 'bogus',
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error!.issues.map((issue) => issue.path.join('.'))).toContain('layer');
    });

    /**
     * `layer` was a bare `z.string()` before the documented set became a published
     * `pattern`, so an empty value parsed and the handler dropped it. Nominatim itself
     * accepts any casing of a documented layer name, so neither form may be newly refused.
     */
    it('accepts an empty layer and forwards none', async () => {
      mockReverse.mockResolvedValue(validPlace);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({ lat: 47.6, lon: -122.3, layer: '' });
      await openstreetmapReverseGeocode.handler(input, ctx);
      expect(reverseParams().layer).toBeUndefined();
    });

    it('accepts an uppercase layer and forwards it as given', async () => {
      mockReverse.mockResolvedValue(validPlace);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({
        lat: 47.6,
        lon: -122.3,
        layer: 'ADDRESS',
      });
      await openstreetmapReverseGeocode.handler(input, ctx);
      expect(reverseParams().layer).toBe('ADDRESS');
    });

    it('accepts a mixed-case list and forwards the spacing as given', async () => {
      mockReverse.mockResolvedValue(validPlace);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapReverseGeocode.errors,
      });
      const input = openstreetmapReverseGeocode.input.parse({
        lat: 47.6,
        lon: -122.3,
        layer: 'Address, poi',
      });
      await openstreetmapReverseGeocode.handler(input, ctx);
      expect(reverseParams().layer).toBe('Address, poi');
    });
  });

  describe('format', () => {
    it('renders all key fields', () => {
      const output = {
        result: {
          place_id: 5678,
          osm_type: 'way' as const,
          osm_id: 50637691,
          lat: 47.6062,
          lon: -122.3321,
          display_name: '400 Broad Street, Seattle, WA',
          name: 'Space Needle',
          category: 'man_made',
          type: 'tower',
          address: { road: 'Broad Street', city: 'Seattle' },
          boundingbox: [47.619, 47.622, -122.352, -122.347] as [number, number, number, number],
        },
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapReverseGeocode.format!(output);
      expect(blocks[0]!.type).toBe('text');
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Space Needle');
      expect(text).toContain('47.6062');
      expect(text).toContain('-122.3321');
      expect(text).toContain('5678');
      expect(text).toContain('W50637691');
      expect(text).toContain('man_made');
      expect(text).toContain('OpenStreetMap');
    });

    it('renders without optional fields when absent', () => {
      const output = {
        result: {
          place_id: 1111,
          lat: 47.6,
          lon: -122.3,
          display_name: 'Some road, Seattle, WA',
        },
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapReverseGeocode.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('1111');
      expect(text).toContain('47.6');
    });
  });
});
