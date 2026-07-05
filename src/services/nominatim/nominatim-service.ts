/**
 * @fileoverview Nominatim API client with rate limiting, retry, and session caching.
 * @module services/nominatim/nominatim-service
 */

import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
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
const MIN_REQUEST_INTERVAL_MS = 1050;

export class NominatimService {
  private lastRequestTime = 0;

  // config and storage reserved for future use (private instance auth, custom storage)
  constructor(_config: AppConfig, _storage: StorageService) {}

  /** Enforce the 1 req/sec rate limit. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    this.lastRequestTime = Date.now();
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
    const url = new URL(path, this.baseUrl());
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
    setIfTruthy('featuretype', params.featureType);
    if (params.extratags) queryParams.extratags = '1';
    setIfTruthy('accept-language', params.language);

    ctx.log.info('Nominatim search', { params });

    const results = await withRetry(
      () => this.fetchJson<NominatimPlace[]>('/search', queryParams, ctx),
      {
        operation: 'nominatim.search',
        context: ctx as unknown as RequestContextLike,
        baseDelayMs: 1100,
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
      () => this.fetchJson<NominatimPlace>('/reverse', queryParams, ctx),
      {
        operation: 'nominatim.reverse',
        context: ctx as unknown as RequestContextLike,
        baseDelayMs: 1100,
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
      () => this.fetchJson<NominatimPlace[]>('/lookup', queryParams, ctx),
      {
        operation: 'nominatim.lookup',
        context: ctx as unknown as RequestContextLike,
        baseDelayMs: 1100,
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
