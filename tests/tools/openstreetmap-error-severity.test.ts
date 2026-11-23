/**
 * @fileoverview #138 at each tool's seam: the `data.reason` a failure reaches the caller with
 * resolves to the `errors[]` entry whose `severity` sets the level of its `Error in tool:` log
 * record. The framework resolves that entry as the last one declaring the reason, so a test reads
 * the level there: `runToolContract` skips the logging step. One `notice` reason and one `error`
 * reason per tool; the full reason → level table is pinned in tool-surface.test.ts.
 * @module tests/tools/openstreetmap-error-severity.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { type ErrorContract, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapLookupObjects } from '@/mcp-server/tools/definitions/openstreetmap-lookup-objects.tool.js';
import { openstreetmapQueryBbox } from '@/mcp-server/tools/definitions/openstreetmap-query-bbox.tool.js';
import { openstreetmapQueryNearby } from '@/mcp-server/tools/definitions/openstreetmap-query-nearby.tool.js';
import { openstreetmapQueryRaw } from '@/mcp-server/tools/definitions/openstreetmap-query-raw.tool.js';
import { openstreetmapReverseGeocode } from '@/mcp-server/tools/definitions/openstreetmap-reverse-geocode.tool.js';
import { openstreetmapSearchPlaces } from '@/mcp-server/tools/definitions/openstreetmap-search-places.tool.js';
import type { NominatimErrorBody, NominatimPlace } from '@/services/nominatim/types.js';
import type { OverpassResponse } from '@/services/overpass/types.js';
import { pacerShed, wireError } from '../helpers/handler-error.js';

// --- service mocks -------------------------------------------------------

const mockSearch = vi.fn<(params: unknown, ctx: Context) => Promise<NominatimPlace[]>>();
const mockReverse =
  vi.fn<(params: unknown, ctx: Context) => Promise<NominatimPlace | NominatimErrorBody>>();
const mockLookup = vi.fn<(params: unknown, ctx: Context) => Promise<NominatimPlace[]>>();

vi.mock('@/services/nominatim/nominatim-service.js', () => ({
  getNominatimService: () => ({ search: mockSearch, reverse: mockReverse, lookup: mockLookup }),
}));

const mockQuery = vi.fn<(ql: string, ctx: unknown) => Promise<OverpassResponse>>();

/** Every builder answers fixed QL: these cases fail in `query` or before the service is reached. */
vi.mock('@/services/overpass/overpass-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/overpass/overpass-service.js')>()),
  getOverpassService: () => ({
    buildAroundQuery: () => '[out:json];node(1);out;',
    buildAroundRankFrom: () => ({ lat: 47.6, lon: -122.3, centerQuery: '[out:json];node(1);out;' }),
    buildBboxQuery: () => '[out:json];node(1);out;',
    query: mockQuery,
  }),
}));

// --- helpers -------------------------------------------------------------

/** The level an entry sets, found as the framework finds it: the last entry naming the reason. */
function declaredSeverity(
  definition: { errors?: readonly ErrorContract[] },
  reason: string | undefined,
): ErrorContract['severity'] {
  const entry = definition.errors?.findLast((candidate) => candidate.reason === reason);
  expect(entry, `no errors[] entry declares ${reason}`).toBeDefined();
  return entry?.severity;
}

/** The bare status-mapped error `fetchWithTimeout` raises for an HTTP 503 from Nominatim. */
const nominatim503 = () =>
  new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 503', {
    status: 503,
    errorSource: 'FetchHttpError',
  });

const context = { tenantId: 'test' };

// -------------------------------------------------------------------------

describe('declared log level per failure reason (#138)', () => {
  beforeEach(() => {
    for (const mock of [mockSearch, mockReverse, mockLookup, mockQuery]) mock.mockReset();
  });

  it('openstreetmap_search_places: no_results logs at notice, upstream_error at error', async () => {
    mockSearch.mockResolvedValue([]);
    const miss = await wireError(openstreetmapSearchPlaces, { query: 'qzxjvwq kqzzvxj' }, context);
    expect(miss.data.reason).toBe('no_results');
    expect(declaredSeverity(openstreetmapSearchPlaces, miss.data.reason)).toBe('notice');

    mockSearch.mockRejectedValue(nominatim503());
    const outage = await wireError(openstreetmapSearchPlaces, { query: 'Seattle' }, context);
    expect(outage.data.reason).toBe('upstream_error');
    expect(declaredSeverity(openstreetmapSearchPlaces, outage.data.reason)).toBeUndefined();
  });

  it('openstreetmap_reverse_geocode: no_coverage logs at notice, upstream_error at error', async () => {
    mockReverse.mockResolvedValue({ error: 'Unable to geocode' });
    const ocean = await wireError(openstreetmapReverseGeocode, { lat: 0, lon: -150 }, context);
    expect(ocean.data.reason).toBe('no_coverage');
    expect(declaredSeverity(openstreetmapReverseGeocode, ocean.data.reason)).toBe('notice');

    mockReverse.mockRejectedValue(nominatim503());
    const outage = await wireError(
      openstreetmapReverseGeocode,
      { lat: 47.6, lon: -122.3 },
      context,
    );
    expect(outage.data.reason).toBe('upstream_error');
    expect(declaredSeverity(openstreetmapReverseGeocode, outage.data.reason)).toBeUndefined();
  });

  it('openstreetmap_lookup_objects: invalid_id_format logs at notice, upstream_error at error', async () => {
    const malformed = await wireError(
      openstreetmapLookupObjects,
      { osm_ids: ['240109189'] },
      context,
    );
    expect(malformed.data.reason).toBe('invalid_id_format');
    expect(declaredSeverity(openstreetmapLookupObjects, malformed.data.reason)).toBe('notice');
    expect(mockLookup).not.toHaveBeenCalled();

    mockLookup.mockRejectedValue(nominatim503());
    const outage = await wireError(
      openstreetmapLookupObjects,
      { osm_ids: ['N240109189'] },
      context,
    );
    expect(outage.data.reason).toBe('upstream_error');
    expect(declaredSeverity(openstreetmapLookupObjects, outage.data.reason)).toBeUndefined();
  });

  it('openstreetmap_query_nearby: result_too_large logs at notice, endpoints_unavailable at error', async () => {
    const cafes = { lat: 47.6, lon: -122.3, amenity: 'cafe' };
    mockQuery.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Overpass ran out of memory: runtime error',
        {
          reason: 'result_too_large',
        },
      ),
    );
    const tooLarge = await wireError(openstreetmapQueryNearby, cafes, context);
    expect(tooLarge.data.reason).toBe('result_too_large');
    expect(declaredSeverity(openstreetmapQueryNearby, tooLarge.data.reason)).toBe('notice');

    mockQuery.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'No Overpass endpoint could serve this query — http://127.0.0.1:9/api/interpreter: connection refused.',
        { reason: 'endpoints_unavailable', errorSource: 'OverpassEndpointsUnavailable' },
      ),
    );
    const unreachable = await wireError(openstreetmapQueryNearby, cafes, context);
    expect(unreachable.data.reason).toBe('endpoints_unavailable');
    expect(declaredSeverity(openstreetmapQueryNearby, unreachable.data.reason)).toBeUndefined();
  });

  it('openstreetmap_query_bbox: invalid_bbox logs at notice, overpass_unavailable at error', async () => {
    const inverted = await wireError(
      openstreetmapQueryBbox,
      { south: 10, west: 0, north: 5, east: 1, amenity: 'cafe' },
      context,
    );
    expect(inverted.data.reason).toBe('invalid_bbox');
    expect(declaredSeverity(openstreetmapQueryBbox, inverted.data.reason)).toBe('notice');
    expect(mockQuery).not.toHaveBeenCalled();

    mockQuery.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Overpass returned HTTP 502.', {
        status: 502,
        statusText: 'Bad Gateway',
      }),
    );
    const down = await wireError(
      openstreetmapQueryBbox,
      { south: 47.5, west: -122.5, north: 47.7, east: -122.2, amenity: 'cafe' },
      context,
    );
    expect(down.data.reason).toBe('overpass_unavailable');
    expect(declaredSeverity(openstreetmapQueryBbox, down.data.reason)).toBeUndefined();
  });

  it('openstreetmap_query_raw: query_error logs at notice, pacer_shed at error', async () => {
    const noJson = await wireError(openstreetmapQueryRaw, { query: 'node(1);out;' }, context);
    expect(noJson.data.reason).toBe('query_error');
    expect(declaredSeverity(openstreetmapQueryRaw, noJson.data.reason)).toBe('notice');
    expect(mockQuery).not.toHaveBeenCalled();

    mockQuery.mockRejectedValue(await pacerShed());
    const shed = await wireError(
      openstreetmapQueryRaw,
      { query: '[out:json];node(1);out;' },
      context,
    );
    expect(shed.data.reason).toBe('pacer_shed');
    expect(declaredSeverity(openstreetmapQueryRaw, shed.data.reason)).toBeUndefined();
  });
});
