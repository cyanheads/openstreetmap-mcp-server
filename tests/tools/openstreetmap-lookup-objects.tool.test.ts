/**
 * @fileoverview Tests for the openstreetmap-lookup-objects tool.
 * @module tests/tools/openstreetmap-lookup-objects.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapLookupObjects } from '@/mcp-server/tools/definitions/openstreetmap-lookup-objects.tool.js';
import type { NominatimPlace } from '@/services/nominatim/types.js';
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

// --- service mock --------------------------------------------------------

const mockLookup = vi.fn<() => Promise<NominatimPlace[]>>();

vi.mock('@/services/nominatim/nominatim-service.js', () => ({
  getNominatimService: () => ({ lookup: mockLookup }),
}));

// --- fixtures ------------------------------------------------------------

const nodePlace: NominatimPlace = {
  place_id: 1001,
  osm_type: 'node',
  osm_id: 240109189,
  lat: 47.6205,
  lon: -122.3493,
  display_name: 'Space Needle, 400 Broad Street, Seattle, WA',
  name: 'Space Needle',
  category: 'man_made',
  type: 'tower',
};

const wayPlace: NominatimPlace = {
  place_id: 2002,
  osm_type: 'way',
  osm_id: 50637691,
  lat: 47.6062,
  lon: -122.3321,
  display_name: '1600 Pennsylvania Ave, Washington, DC',
};

// -------------------------------------------------------------------------

describe('openstreetmapLookupObjects', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  describe('happy path', () => {
    it('returns results for a single-element ID array', async () => {
      mockLookup.mockResolvedValue([nodePlace]);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['N240109189'] });
      const result = await openstreetmapLookupObjects.handler(input, ctx);

      expect(result.total).toBe(1);
      expect(result.results[0]).toMatchObject({
        place_id: 1001,
        osm_type: 'node',
        osm_id: 240109189,
        name: 'Space Needle',
      });
      expect(result.not_found).toHaveLength(0);
      expect(result.attribution).toContain('OpenStreetMap');
    });

    it('returns results for multiple OSM IDs', async () => {
      mockLookup.mockResolvedValue([nodePlace, wayPlace]);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({
        osm_ids: ['N240109189', 'W50637691'],
      });
      const result = await openstreetmapLookupObjects.handler(input, ctx);

      expect(result.total).toBe(2);
      expect(result.not_found).toHaveLength(0);
    });

    it('reports not_found IDs when service returns fewer results', async () => {
      mockLookup.mockResolvedValue([nodePlace]); // only one result for two requested IDs
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({
        osm_ids: ['N240109189', 'W99999999'],
      });
      const result = await openstreetmapLookupObjects.handler(input, ctx);

      expect(result.total).toBe(1);
      expect(result.not_found).toContain('W99999999');
    });

    it('normalizes IDs to uppercase before lookup', async () => {
      mockLookup.mockResolvedValue([nodePlace]);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['n240109189'] });
      await openstreetmapLookupObjects.handler(input, ctx);
      expect(mockLookup).toHaveBeenCalledWith(
        expect.objectContaining({ osm_ids: ['N240109189'] }),
        expect.anything(),
      );
    });

    it('passes extratags and language to the service', async () => {
      mockLookup.mockResolvedValue([nodePlace]);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({
        osm_ids: ['N240109189'],
        extratags: true,
        language: 'de',
      });
      await openstreetmapLookupObjects.handler(input, ctx);
      expect(mockLookup).toHaveBeenCalledOnce();
    });
  });

  /**
   * Regression for #52: nothing in the response said that extratags decorates the
   * objects named in osm_ids rather than selecting them, leaving no signal that
   * "find the objects carrying this tag" is a question for the Overpass tools.
   */
  describe('tag-selection caveat (#52)', () => {
    it('reaches structuredContent and content[] when extratags was requested', async () => {
      mockLookup.mockResolvedValue([nodePlace]);
      const result = await runToolContract(openstreetmapLookupObjects, {
        osm_ids: ['N240109189'],
        extratags: true,
      });

      const structured = result.structuredContent as { tagSelectionCaveat?: string };
      expect(structured.tagSelectionCaveat).toContain('Overpass-only');
      expect(structured.tagSelectionCaveat).toContain('openstreetmap_query_raw');
      expect(
        (result.content as { type: string; text?: string }[])
          .map((block) => block.text ?? '')
          .join('\n'),
      ).toContain(structured.tagSelectionCaveat!);
    });

    it('fires when every requested ID came back not_found', async () => {
      mockLookup.mockResolvedValue([]);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({
        osm_ids: ['W99999999'],
        extratags: true,
      });
      const result = await openstreetmapLookupObjects.handler(input, ctx);

      expect(result.not_found).toEqual(['W99999999']);
      expect(getEnrichment(ctx).tagSelectionCaveat).toContain('Overpass-only');
    });

    // This tool takes explicit OSM IDs, so no tag-selection mistake is available to
    // its callers. The one live hazard is misreading an absent tag, which needs the tag
    // map — a default call carries none, so the caveat stays off rather than repeating
    // ~450 bytes across both surfaces on every lookup.
    it('stays off when extratags was not requested', async () => {
      mockLookup.mockResolvedValue([nodePlace]);
      const result = await runToolContract(openstreetmapLookupObjects, {
        osm_ids: ['N240109189'],
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
   * enrichment field rendered under the raw key `**tagSelectionCaveat:**`. The label
   * text matches the other two Nominatim tools, as the field name and text already do.
   */
  describe('enrichment trailer labels (#63)', () => {
    it('renders the caveat under a human heading, not the raw camelCase key', async () => {
      mockLookup.mockResolvedValue([nodePlace]);
      const result = await runToolContract(openstreetmapLookupObjects, {
        osm_ids: ['N240109189'],
        extratags: true,
      });
      const text = (result.content as { type: string; text?: string }[])
        .map((block) => block.text ?? '')
        .join('\n');

      expect(text).toContain('**Tag Selection Caveat:**');
      expect(text).not.toContain('**tagSelectionCaveat:**');
      expect(text).toContain(
        `**Tag Selection Caveat:** ${(result.structuredContent as { tagSelectionCaveat: string }).tagSelectionCaveat}`,
      );
    });

    it('leaves structuredContent unchanged', async () => {
      mockLookup.mockResolvedValue([nodePlace]);
      const result = await runToolContract(openstreetmapLookupObjects, {
        osm_ids: ['N240109189'],
        extratags: true,
      });
      expect(
        (result.structuredContent as { tagSelectionCaveat?: string }).tagSelectionCaveat,
      ).toContain('Overpass-only');
    });
  });

  describe('schema boundary', () => {
    it('rejects a bare ID string — osm_ids is array-only', () => {
      expect(() => openstreetmapLookupObjects.input.parse({ osm_ids: 'N240109189' })).toThrow(
        /expected array/i,
      );
    });

    it('rejects a JSON-stringified array rather than treating it as one malformed ID', () => {
      expect(() =>
        openstreetmapLookupObjects.input.parse({ osm_ids: '["W50637691", "R146656"]' }),
      ).toThrow(/expected array/i);
    });

    it('rejects an empty array', () => {
      expect(() => openstreetmapLookupObjects.input.parse({ osm_ids: [] })).toThrow();
    });
  });

  describe('error paths', () => {
    it('throws invalid_id_format for an ID without N/W/R prefix', async () => {
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['240109189'] }); // missing prefix
      await expect(openstreetmapLookupObjects.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_id_format' },
      });
    });

    it('throws invalid_id_format for a malformed ID in an array', async () => {
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['N240109189', 'bad_id'] });
      await expect(openstreetmapLookupObjects.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_id_format' },
      });
    });

    it('propagates service errors', async () => {
      mockLookup.mockRejectedValue(new Error('Nominatim unavailable'));
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['N240109189'] });
      await expect(openstreetmapLookupObjects.handler(input, ctx)).rejects.toThrow(
        'Nominatim unavailable',
      );
    });
  });

  /**
   * Regression for #59: `OSM_ID_PATTERN` stops a malformed ID at the boundary, but a
   * genuine Nominatim 400 — an unsupported `accept-language` value, say — still reached
   * the same catch block and was folded into the retryable `upstream_error` bucket.
   */
  describe('invalid parameters (#59)', () => {
    const failWith = async (message: string) => {
      mockLookup.mockRejectedValue(nominatimBadRequest(message));
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['N240109189'] });
      return (await captureThrown(openstreetmapLookupObjects.handler(input, ctx))) as ContractError;
    };

    it('surfaces a Nominatim 400 as non-retryable invalid_parameters', async () => {
      const err = await failWith("Unsupported 'accept-language' value");
      expect(err.data.reason).toBe('invalid_parameters');
      expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err.data.retryable).not.toBe(true);
    });

    it("preserves Nominatim's own message and drops the base-URL hint", async () => {
      const err = await failWith("Unsupported 'accept-language' value");
      expect(err.message).toContain("Unsupported 'accept-language' value");
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
        mockLookup.mockRejectedValue(error);
        const ctx = createMockContext({
          tenantId: 'test',
          errors: openstreetmapLookupObjects.errors,
        });
        const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['N240109189'] });
        const err = (await captureThrown(
          openstreetmapLookupObjects.handler(input, ctx),
        )) as ContractError;
        expect(err.data.reason).toBe(reason);
      }
    });
  });

  describe('sparse upstream payload', () => {
    it('handles results with minimal fields', async () => {
      const sparsePlace: NominatimPlace = {
        place_id: 777,
        lat: 47.0,
        lon: -122.0,
        display_name: 'Unnamed place',
      };
      mockLookup.mockResolvedValue([sparsePlace]);
      const ctx = createMockContext({
        tenantId: 'test',
        errors: openstreetmapLookupObjects.errors,
      });
      const input = openstreetmapLookupObjects.input.parse({ osm_ids: ['R777'] });
      const result = await openstreetmapLookupObjects.handler(input, ctx);

      // Sparse place has no osm_type/osm_id so it won't match the requested ID
      expect(result.total).toBe(1);
      expect(result.results[0]?.name).toBeUndefined();
      expect(result.results[0]?.category).toBeUndefined();
    });
  });

  describe('format', () => {
    it('renders results with key fields', () => {
      const output = {
        results: [
          {
            place_id: 1001,
            osm_type: 'node' as const,
            osm_id: 240109189,
            lat: 47.6205,
            lon: -122.3493,
            display_name: 'Space Needle, Seattle, WA',
            name: 'Space Needle',
            category: 'man_made',
            type: 'tower',
          },
        ],
        not_found: [],
        total: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapLookupObjects.format!(output);
      expect(blocks[0]!.type).toBe('text');
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Space Needle');
      expect(text).toContain('47.6205');
      expect(text).toContain('-122.3493');
      expect(text).toContain('N240109189');
      expect(text).toContain('man_made');
      expect(text).toContain('OpenStreetMap');
    });

    it('renders not_found IDs when present', () => {
      const output = {
        results: [],
        not_found: ['W99999999'],
        total: 0,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapLookupObjects.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Not found');
      expect(text).toContain('W99999999');
    });
  });
});
