/**
 * @fileoverview End-to-end regression for #53 — a non-JSON Nominatim 2xx body,
 * driven through the real service into each Nominatim-backed tool, so the reason,
 * the recovery hint the caller receives, and the submission count are asserted on
 * one path. The service suite covers the classification and the edge-case suite
 * the tool remap; only this one shows what a caller gets for a given body.
 * @module tests/tools/openstreetmap-nominatim-body.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapLookupObjects } from '@/mcp-server/tools/definitions/openstreetmap-lookup-objects.tool.js';
import { openstreetmapReverseGeocode } from '@/mcp-server/tools/definitions/openstreetmap-reverse-geocode.tool.js';
import { openstreetmapSearchPlaces } from '@/mcp-server/tools/definitions/openstreetmap-search-places.tool.js';
import { initNominatimService } from '@/services/nominatim/nominatim-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    nominatimBaseUrl: 'https://nominatim.openstreetmap.org',
    overpassBaseUrl: 'https://overpass-api.de/api/interpreter',
    nominatimUserAgent: 'openstreetmap-mcp-server/test',
  }),
}));

// Only the HTTP call is faked — the real service, the real withRetry loop, and the
// real retry predicate all run, so the submission count is the production one.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: vi.fn(async () => new Response('[]', { status: 200 })),
  };
});

const mockFetch = vi.mocked(fetchWithTimeout);

type ContractEntry = { readonly reason: string; readonly recovery: string };

/** The recovery text a tool's contract declares for a reason. */
function contractHint(errors: readonly ContractEntry[], reason: string): string | undefined {
  return errors.find((entry) => entry.reason === reason)?.recovery;
}

const bodies = [
  {
    label: 'markup behind an XML declaration',
    body: '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html><body><p>Access blocked</p></body></html>',
    reason: 'rate_limited',
  },
  {
    label: 'plain-text throttle message with no markup',
    body: 'Bandwidth limit exceeded. Please reduce your request rate.',
    reason: 'rate_limited',
  },
  {
    label: 'markup carrying no throttle signature',
    body: '<?xml version="1.0"?><html><head><title>502 Bad Gateway</title></head></html>',
    reason: 'upstream_error',
  },
  {
    label: 'unrecognized non-JSON body',
    body: 'openstreetmap-mcp-server placeholder page',
    reason: 'upstream_error',
  },
] as const;

const tools = [
  {
    name: openstreetmapSearchPlaces.name,
    errors: openstreetmapSearchPlaces.errors as readonly ContractEntry[],
    invoke: () =>
      openstreetmapSearchPlaces.handler(
        openstreetmapSearchPlaces.input.parse({ query: 'Seattle', limit: 2 }),
        createMockContext({ tenantId: 'test', errors: openstreetmapSearchPlaces.errors }),
      ),
  },
  {
    name: openstreetmapReverseGeocode.name,
    errors: openstreetmapReverseGeocode.errors as readonly ContractEntry[],
    invoke: () =>
      openstreetmapReverseGeocode.handler(
        openstreetmapReverseGeocode.input.parse({ lat: 47.6205, lon: -122.3493 }),
        createMockContext({ tenantId: 'test', errors: openstreetmapReverseGeocode.errors }),
      ),
  },
  {
    name: openstreetmapLookupObjects.name,
    errors: openstreetmapLookupObjects.errors as readonly ContractEntry[],
    invoke: () =>
      openstreetmapLookupObjects.handler(
        openstreetmapLookupObjects.input.parse({ osm_ids: ['N240109189'] }),
        createMockContext({ tenantId: 'test', errors: openstreetmapLookupObjects.errors }),
      ),
  },
];

describe('Nominatim tools — non-JSON 2xx body reaches the caller classified (#53)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // The service ignores both dependencies (caching goes through ctx.state), so
    // typed stubs are sufficient.
    initNominatimService({} as unknown as AppConfig, {} as unknown as StorageService);
  });

  for (const { name, errors, invoke } of tools) {
    describe(name, () => {
      for (const { label, body, reason } of bodies) {
        it(`answers ${label} with ${reason}, a recovery hint, and one submission`, async () => {
          mockFetch.mockImplementation(async () => new Response(body, { status: 200 }));

          const err = await invoke().catch((e: unknown) => e);

          expect(err).toBeInstanceOf(McpError);
          const data = (err as McpError).data as Record<string, unknown>;
          expect(data.reason).toBe(reason);
          expect((data.recovery as { hint?: string } | undefined)?.hint).toBe(
            contractHint(errors, reason),
          );
          expect(mockFetch).toHaveBeenCalledTimes(1);
        });
      }
    });
  }
});
