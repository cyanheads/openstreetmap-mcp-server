/**
 * @fileoverview Tests for the openstreetmap-query-raw tool.
 * @module tests/tools/openstreetmap-query-raw.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapQueryRaw } from '@/mcp-server/tools/definitions/openstreetmap-query-raw.tool.js';
import type { OverpassElement, OverpassResponse } from '@/services/overpass/types.js';

// --- service mock --------------------------------------------------------

const mockQuery = vi.fn<() => Promise<OverpassResponse>>();

vi.mock('@/services/overpass/overpass-service.js', () => ({
  getOverpassService: () => ({ query: mockQuery }),
}));

// --- fixtures ------------------------------------------------------------

const peakElement: OverpassElement = {
  type: 'node',
  id: 987654321,
  lat: 47.62,
  lon: -122.35,
  tags: { natural: 'peak', name: 'Mt Rainier', ele: '4392' },
};

const responseWithTimestamp: OverpassResponse = {
  version: 0.6,
  osm3s: { timestamp_osm_base: '2025-03-01T12:00:00Z' },
  elements: [peakElement],
};

const responseWithoutTimestamp: OverpassResponse = {
  version: 0.6,
  elements: [peakElement],
};

const VALID_QUERY =
  '[out:json][timeout:15];node["natural"="peak"](47.5,-122.5,47.7,-122.2);out body;';
const QUERY_WITHOUT_TIMEOUT =
  '[out:json];node["natural"="peak"](47.5,-122.5,47.7,-122.2);out body;';

// -------------------------------------------------------------------------

describe('openstreetmapQueryRaw', () => {
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue(responseWithTimestamp);
  });

  describe('happy path', () => {
    it('returns raw elements from a valid query', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const result = await openstreetmapQueryRaw.handler(input, ctx);

      expect(result.total_elements).toBe(1);
      expect(result.elements).toHaveLength(1);
      expect(result.elements[0]).toMatchObject({ type: 'node', id: 987654321 });
      expect(result.data_timestamp).toBe('2025-03-01T12:00:00Z');
      expect(result.attribution).toContain('OpenStreetMap');

      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveQuery).toContain('[out:json]');
      expect(enrichment.notice).toBeUndefined();
    });

    it('injects [timeout:N] when query lacks a timeout directive', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({
        query: QUERY_WITHOUT_TIMEOUT,
        timeout_seconds: 45,
      });
      await openstreetmapQueryRaw.handler(input, ctx);

      const calledQuery = mockQuery.mock.calls[0]?.[0] as string;
      expect(calledQuery).toContain('[timeout:45]');
    });

    it('does not inject timeout when query already includes [timeout:]', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      await openstreetmapQueryRaw.handler(input, ctx);

      const calledQuery = mockQuery.mock.calls[0]?.[0] as string;
      // Should preserve the original timeout, not add a second one
      expect(calledQuery.match(/\[timeout:/g)).toHaveLength(1);
    });

    it('handles multiple elements', async () => {
      const elements: OverpassElement[] = Array.from({ length: 5 }, (_, i) => ({
        type: 'node' as const,
        id: i + 1,
        lat: 47.6 + i * 0.01,
        lon: -122.3,
        tags: { natural: 'peak' },
      }));
      mockQuery.mockResolvedValue({ ...responseWithTimestamp, elements });
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const result = await openstreetmapQueryRaw.handler(input, ctx);
      expect(result.total_elements).toBe(5);
      expect(result.elements).toHaveLength(5);
    });
  });

  describe('enrichment', () => {
    it('echoes the effective query (with injected timeout)', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({
        query: QUERY_WITHOUT_TIMEOUT,
        timeout_seconds: 45,
      });
      await openstreetmapQueryRaw.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveQuery).toContain('[timeout:45]');
    });

    it('sets notice when no elements are returned', async () => {
      mockQuery.mockResolvedValue({ ...responseWithTimestamp, elements: [] });
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      await openstreetmapQueryRaw.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('No elements returned');
    });
  });

  describe('missing timestamp', () => {
    it('omits data_timestamp when osm3s is absent', async () => {
      mockQuery.mockResolvedValue(responseWithoutTimestamp);
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const result = await openstreetmapQueryRaw.handler(input, ctx);
      expect(result.data_timestamp).toBeUndefined();
    });
  });

  describe('error paths', () => {
    it('preflight: missing [out:json] carries the query_error recovery hint (#16)', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      // No [out:json] — hits the LOCAL preflight branch, not the service catch handler
      // (mockQuery is never reached).
      const input = openstreetmapQueryRaw.input.parse({
        query: 'node["amenity"="cafe"](around:100,47.6205,-122.3493);out body;',
      });
      const err = await openstreetmapQueryRaw.handler(input, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('query_error');
      // The declared recovery hint is present on structuredContent's surface; the framework's
      // buildToolErrorResult mirrors it into content[] as the "Recovery:" line for format()-only
      // clients (a framework guarantee downstream of the hint being set here).
      expect(err.data.recovery?.hint).toBeDefined();
      expect(typeof err.data.recovery.hint).toBe('string');
      const contractHint = openstreetmapQueryRaw.errors?.find(
        (entry) => entry.reason === 'query_error',
      )?.recovery;
      expect(err.data.recovery.hint).toBe(contractHint);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('propagates plain service errors without remapping', async () => {
      mockQuery.mockRejectedValue(new Error('Overpass query timed out'));
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      await expect(openstreetmapQueryRaw.handler(input, ctx)).rejects.toThrow(
        'Overpass query timed out',
      );
    });

    it('remaps query_error McpError to ctx.fail with ValidationError code and recovery.hint', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass API returned HTTP 400 — malformed query syntax.',
          { reason: 'query_error' },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const err = await openstreetmapQueryRaw.handler(input, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      // After remapping via ctx.fail, code should match the contract (ValidationError)
      expect(err.data.reason).toBe('query_error');
      expect(err.data.recovery?.hint).toBeDefined();
    });

    it('remaps query_timeout McpError to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(JsonRpcErrorCode.Timeout, 'Overpass query timed out: runtime error', {
          reason: 'query_timeout',
        }),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const err = await openstreetmapQueryRaw.handler(input, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('query_timeout');
      expect(err.data.recovery?.hint).toBeDefined();
    });

    it('remaps result_too_large McpError to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass ran out of memory: runtime error',
          { reason: 'result_too_large' },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const err = await openstreetmapQueryRaw.handler(input, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('result_too_large');
      expect(err.data.recovery?.hint).toBeDefined();
    });

    it('remaps rate_limited McpError to ctx.fail with recovery.hint populated', async () => {
      mockQuery.mockRejectedValue(
        new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'Overpass API returned HTTP 429 — all query slots occupied.',
          { reason: 'rate_limited' },
        ),
      );
      const ctx = createMockContext({ tenantId: 'test', errors: openstreetmapQueryRaw.errors });
      const input = openstreetmapQueryRaw.input.parse({ query: VALID_QUERY });
      const err = await openstreetmapQueryRaw.handler(input, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err.data.reason).toBe('rate_limited');
      expect(err.data.recovery?.hint).toBeDefined();
    });
  });

  describe('format', () => {
    it('renders elements with type, id, and tags', () => {
      const output = {
        elements: [
          {
            type: 'node',
            id: 987654321,
            lat: 47.62,
            lon: -122.35,
            tags: { natural: 'peak', name: 'Mt Rainier' },
          },
        ],
        total_elements: 1,
        data_timestamp: '2025-03-01T12:00:00Z',
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      expect(blocks[0]!.type).toBe('text');
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('1 element returned');
      expect(text).toContain('node');
      expect(text).toContain('987654321');
      expect(text).toContain('Mt Rainier');
      expect(text).toContain('natural=peak');
      expect(text).toContain('Coordinates: 47.62, -122.35');
      expect(text).toContain('2025-03-01');
      expect(text).toContain('OpenStreetMap');
    });

    it('renders "elements returned" in singular for one element', () => {
      const output = {
        elements: [{ type: 'node', id: 1 }],
        total_elements: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('1 element returned');
    });

    it('renders all elements without truncating at 50 (#20)', () => {
      const elements = Array.from({ length: 75 }, (_, i) => ({
        type: 'node',
        id: i + 1,
        lat: 47.6,
        lon: -122.3,
      }));
      const output = {
        elements,
        total_elements: 75,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('**node** 75');
      expect(text).not.toContain('more elements');
    });

    it('omits the coordinates line for elements without lat/lon (#20)', () => {
      const output = {
        elements: [{ type: 'way', id: 5, tags: { highway: 'residential' } }],
        total_elements: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).not.toContain('Coordinates:');
      expect(text).toContain('highway=residential');
    });

    it('omits data_timestamp line when absent', () => {
      const output = {
        elements: [{ type: 'node', id: 1 }],
        total_elements: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).not.toContain('Data as of:');
    });

    it('renders a way element nodes array in content[] (#20)', () => {
      const output = {
        elements: [
          {
            type: 'way',
            id: 12903132,
            nodes: [825308606, 118329594, 825308607],
            tags: { name: 'Space Needle', building: 'tower' },
          },
        ],
        total_elements: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      const text = (blocks[0] as { text: string }).text;
      expect(text).toContain('Space Needle');
      // The full nodes array must reach content[], not just structuredContent.
      expect(text).toContain('nodes:');
      expect(text).toContain('825308606');
      expect(text).toContain('118329594');
      expect(text).toContain('825308607');
    });

    it('renders out-meta fields (timestamp/version/changeset/user/uid) in content[] (#20)', () => {
      const output = {
        elements: [
          {
            type: 'node',
            id: 663911505,
            lat: 47.599091,
            lon: -122.331856,
            timestamp: '2024-01-15T12:00:00Z',
            version: 7,
            changeset: 145678901,
            user: 'osm_mapper',
            uid: 42,
            tags: { amenity: 'cafe' },
          },
        ],
        total_elements: 1,
        attribution: 'Data © OpenStreetMap contributors, ODbL 1.0',
      };
      const blocks = openstreetmapQueryRaw.format!(output);
      const text = (blocks[0] as { text: string }).text;
      // Existing readable lines still render.
      expect(text).toContain('Coordinates: 47.599091, -122.331856');
      expect(text).toContain('amenity=cafe');
      // Every out-meta field also reaches content[].
      expect(text).toContain('timestamp: 2024-01-15T12:00:00Z');
      expect(text).toContain('version: 7');
      expect(text).toContain('changeset: 145678901');
      expect(text).toContain('user: osm_mapper');
      expect(text).toContain('uid: 42');
    });
  });
});
