/**
 * @fileoverview Nominatim API client with rate limiting, retry, and session caching.
 * @module services/nominatim/nominatim-service
 */

import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { RequestContextLike } from '@cyanheads/mcp-ts-core/utils';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  NominatimLookupParams,
  NominatimPlace,
  NominatimReverseParams,
  NominatimSearchParams,
} from './types.js';

/** Cache TTL: 60 minutes (geocoding results rarely change within a session). */
const CACHE_TTL_SECONDS = 3600;

/** Nominatim enforces a strict 1 req/sec limit. */
export const MIN_REQUEST_INTERVAL_MS = 1050;

/**
 * Returns false for failures that cannot clear inside the retry window, so
 * withRetry surfaces them immediately instead of re-submitting. Exported for
 * unit testing.
 *
 * Non-transient cases:
 * - reason 'rate_limited' — Nominatim served an HTML throttle page with HTTP 200.
 *   A quota block, not a momentary blip; retrying only adds load.
 * - status 429 with no Retry-After — same block, signalled by status instead.
 *   When the response *does* carry Retry-After, the error stays transient so
 *   withRetry honors the wait the upstream asked for (and fails fast on its own
 *   when that wait exceeds the retry budget).
 */
export function isTransientNominatimError(error: unknown): boolean {
  if (error instanceof McpError) {
    const data = error.data as Record<string, unknown> | undefined;
    if (data?.reason === 'rate_limited') return false;
    if (data?.status === 429 && data.retryAfter === undefined) return false;
  }
  return true;
}

export class NominatimService {
  /** Epoch ms of the next request slot. Reserved synchronously, so concurrent callers queue. */
  private nextRequestSlot = 0;

  // config and storage reserved for future use (private instance auth, custom storage)
  constructor(_config: AppConfig, _storage: StorageService) {}

  /**
   * Enforce the 1 req/sec rate limit across concurrent callers. The slot is
   * claimed synchronously before any await, so N callers that arrive together
   * each reserve a distinct slot instead of all computing the same delay from a
   * timestamp none of them has written back yet.
   */
  private throttle(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextRequestSlot);
    this.nextRequestSlot = slot + MIN_REQUEST_INTERVAL_MS;
    const delay = slot - now;
    if (delay <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  private userAgent(): string {
    return getServerConfig().nominatimUserAgent;
  }

  private baseUrl(): string {
    return getServerConfig().nominatimBaseUrl;
  }

  private buildCacheKey(endpoint: string, params: Record<string, unknown>): string {
    const hash = createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16);
    return `nominatim/${endpoint}/${hash}`;
  }

  private async fetchJson<T>(
    path: string,
    params: Record<string, string>,
    ctx: Context,
  ): Promise<T> {
    // A leading-slash path is absolute and would replace the base's own path, so
    // endpoints are joined relative against a slash-terminated base — that keeps
    // any prefix in OSM_NOMINATIM_BASE_URL (e.g. https://host/nominatim) intact.
    const base = this.baseUrl();
    const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    }

    await this.throttle();

    const response = await fetchWithTimeout(
      url.toString(),
      30_000,
      ctx as unknown as RequestContextLike,
      {
        headers: {
          'User-Agent': this.userAgent(),
          Accept: 'application/json',
        },
        signal: ctx.signal,
      },
    );

    const text = await response.text();
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        'Nominatim returned an HTML error page — likely rate-limited or unavailable.',
        { reason: 'rate_limited' },
      );
    }

    return JSON.parse(text) as T;
  }

  async search(params: NominatimSearchParams, ctx: Context): Promise<NominatimPlace[]> {
    const cacheKey = this.buildCacheKey('search', params);
    const cached = await ctx.state.get<NominatimPlace[]>(cacheKey);
    if (cached != null) {
      ctx.log.debug('Nominatim search cache hit', { cacheKey });
      return cached;
    }

    const queryParams: Record<string, string> = {};
    const setIfTruthy = (key: string, val: string | number | boolean | undefined) => {
      if (val) queryParams[key] = String(val);
    };
    setIfTruthy('q', params.q);
    setIfTruthy('street', params.street);
    setIfTruthy('city', params.city);
    setIfTruthy('county', params.county);
    setIfTruthy('state', params.state);
    setIfTruthy('country', params.country);
    setIfTruthy('postalcode', params.postalcode);
    setIfTruthy('limit', params.limit);
    setIfTruthy('countrycodes', params.countrycodes);
    setIfTruthy('layer', params.layer);
    // Nominatim reads this parameter camel-cased and drops unknown params, so the
    // all-lowercase form silently disables the filter.
    setIfTruthy('featureType', params.featureType);
    if (params.extratags) queryParams.extratags = '1';
    setIfTruthy('accept-language', params.language);
    // Comma-joined list Nominatim honors to drop already-seen matches and promote
    // the next-best ones (mirrors the osm_ids.join(',') pattern used in lookup()).
    if (params.excludePlaceIds?.length) {
      queryParams.exclude_place_ids = params.excludePlaceIds.join(',');
    }

    ctx.log.info('Nominatim search', { params });

    const results = await withRetry(
      () => this.fetchJson<NominatimPlace[]>('search', queryParams, ctx),
      {
        operation: 'nominatim.search',
        context: ctx as unknown as RequestContextLike,
        baseDelayMs: 1100,
        isTransient: isTransientNominatimError,
        signal: ctx.signal,
      },
    );

    await ctx.state.set(cacheKey, results, { ttl: CACHE_TTL_SECONDS });
    return results;
  }

  async reverse(params: NominatimReverseParams, ctx: Context): Promise<NominatimPlace> {
    const cacheKey = this.buildCacheKey('reverse', params);
    const cached = await ctx.state.get<NominatimPlace>(cacheKey);
    if (cached != null) {
      ctx.log.debug('Nominatim reverse cache hit', { cacheKey });
      return cached;
    }

    const queryParams: Record<string, string> = {
      lat: String(params.lat),
      lon: String(params.lon),
    };
    if (params.zoom !== undefined) queryParams.zoom = String(params.zoom);
    if (params.layer) queryParams.layer = params.layer;
    if (params.extratags) queryParams.extratags = '1';
    if (params.language) queryParams['accept-language'] = params.language;

    ctx.log.info('Nominatim reverse', { lat: params.lat, lon: params.lon });

    const result = await withRetry(
      () => this.fetchJson<NominatimPlace>('reverse', queryParams, ctx),
      {
        operation: 'nominatim.reverse',
        context: ctx as unknown as RequestContextLike,
        baseDelayMs: 1100,
        isTransient: isTransientNominatimError,
        signal: ctx.signal,
      },
    );

    await ctx.state.set(cacheKey, result, { ttl: CACHE_TTL_SECONDS });
    return result;
  }

  async lookup(params: NominatimLookupParams, ctx: Context): Promise<NominatimPlace[]> {
    const cacheKey = this.buildCacheKey('lookup', params);
    const cached = await ctx.state.get<NominatimPlace[]>(cacheKey);
    if (cached != null) {
      ctx.log.debug('Nominatim lookup cache hit', { cacheKey });
      return cached;
    }

    const queryParams: Record<string, string> = {
      osm_ids: params.osm_ids.join(','),
    };
    if (params.extratags) queryParams.extratags = '1';
    if (params.language) queryParams['accept-language'] = params.language;

    ctx.log.info('Nominatim lookup', { osm_ids: params.osm_ids });

    const results = await withRetry(
      () => this.fetchJson<NominatimPlace[]>('lookup', queryParams, ctx),
      {
        operation: 'nominatim.lookup',
        context: ctx as unknown as RequestContextLike,
        baseDelayMs: 1100,
        isTransient: isTransientNominatimError,
        signal: ctx.signal,
      },
    );

    await ctx.state.set(cacheKey, results, { ttl: CACHE_TTL_SECONDS });
    return results;
  }
}

// --- Init/accessor pattern ---

let _service: NominatimService | undefined;

export function initNominatimService(config: AppConfig, storage: StorageService): void {
  _service = new NominatimService(config, storage);
}

export function getNominatimService(): NominatimService {
  if (!_service) {
    throw new Error('NominatimService not initialized — call initNominatimService() in setup()');
  }
  return _service;
}
