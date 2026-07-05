/**
 * @fileoverview Tests for the Nominatim service HTTP client — request construction.
 * @module tests/services/nominatim/nominatim-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NominatimService } from '@/services/nominatim/nominatim-service.js';

// Mock only fetchWithTimeout so we can inspect the outgoing request URL; the real
// withRetry still wraps the call. Every endpoint returns a JSON array — the tests
// assert on the request, not the response body.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: vi.fn(async () => new Response('[]', { status: 200 })),
  };
});

const mockFetch = vi.mocked(fetchWithTimeout);

/** URL of the single request the mocked fetch captured for this test. */
function firstRequestUrl(): URL {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  return new URL(mockFetch.mock.calls[0]![0] as string);
}

describe('NominatimService', () => {
  let service: NominatimService;

  beforeEach(() => {
    mockFetch.mockClear();
    // The service ignores its storage dependency (caching goes through ctx.state),
    // so a typed stub is sufficient — the tests only inspect the outgoing request.
    service = new NominatimService({} as unknown as AppConfig, {} as unknown as StorageService);
  });

  // Regression for #19: Nominatim reads `accept-language` (hyphen) and drops unknown
  // params, so the underscore form silently ignored the requested language.
  describe('accept-language query parameter (#19)', () => {
    it('sends accept-language (not accept_language) for search', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'München', language: 'en', limit: 5 }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.get('accept-language')).toBe('en');
      expect(url.searchParams.has('accept_language')).toBe(false);
    });

    it('sends accept-language (not accept_language) for reverse', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.reverse({ lat: 48.1371079, lon: 11.5753822, language: 'fr' }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.get('accept-language')).toBe('fr');
      expect(url.searchParams.has('accept_language')).toBe(false);
    });

    it('sends accept-language (not accept_language) for lookup', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.lookup({ osm_ids: ['N240109189'], language: 'de' }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.get('accept-language')).toBe('de');
      expect(url.searchParams.has('accept_language')).toBe(false);
    });

    it('omits accept-language entirely when no language is requested', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      await service.search({ q: 'Seattle', limit: 5 }, ctx);
      const url = firstRequestUrl();
      expect(url.searchParams.has('accept-language')).toBe(false);
      expect(url.searchParams.has('accept_language')).toBe(false);
    });
  });
});
