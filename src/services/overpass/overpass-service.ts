/**
 * @fileoverview Overpass API client with retry, session caching, and QL query builders.
 * @module services/overpass/overpass-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable, timeout as timeoutError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { RequestContextLike } from '@cyanheads/mcp-ts-core/utils';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  OverpassAroundParams,
  OverpassBboxParams,
  OverpassElement,
  OverpassPoi,
  OverpassResponse,
} from './types.js';

/** Cache TTL for Overpass results: 10 minutes (more volatile than geocoding). */
const CACHE_TTL_SECONDS = 600;

/** Overpass timeout error messages that indicate query-level timeout. */
const OVERPASS_TIMEOUT_PATTERN = /runtime error|query timed out|timed out/i;

/** Overpass out-of-memory error patterns. */
const OVERPASS_OOM_PATTERN = /out of memory|query run out/i;

export class OverpassService {
  // config and storage reserved for future use (private instance auth, custom storage)
  constructor(_config: AppConfig, _storage: StorageService) {}

  private endpoint(): string {
    return getServerConfig().overpassBaseUrl;
  }

  private buildCacheKey(query: string): string {
    return `overpass:${query}`;
  }

  /** Build an around-filter Overpass QL query. */
  buildAroundQuery(params: OverpassAroundParams): string {
    const { lat, lon, radiusMeters, tagKey, tagValue, elementTypes, timeoutSeconds } = params;
    const filter = `(around:${radiusMeters},${lat},${lon})`;
    const tagFilter = `["${tagKey}"="${tagValue}"]`;
    const lines = [
      `[out:json][timeout:${timeoutSeconds}];`,
      '(',
      ...elementTypes.map((t) => `  ${t}${tagFilter}${filter};`),
      ');',
      'out center tags;',
    ];
    return lines.join('\n');
  }

  /** Build a bounding-box Overpass QL query. */
  buildBboxQuery(params: OverpassBboxParams): string {
    const { south, west, north, east, tagKey, tagValue, elementTypes, timeoutSeconds } = params;
    // Overpass bbox order: south,west,north,east (latitude-first)
    const filter = `(${south},${west},${north},${east})`;
    const tagFilter = `["${tagKey}"="${tagValue}"]`;
    const lines = [
      `[out:json][timeout:${timeoutSeconds}];`,
      '(',
      ...elementTypes.map((t) => `  ${t}${tagFilter}${filter};`),
      ');',
      'out center tags;',
    ];
    return lines.join('\n');
  }

  private async executeQuery(query: string, ctx: Context): Promise<OverpassResponse> {
    const cacheKey = this.buildCacheKey(query);
    const cached = await ctx.state.get<OverpassResponse>(cacheKey);
    if (cached !== null) {
      ctx.log.debug('Overpass cache hit');
      return cached;
    }

    const result = await withRetry(
      async () => {
        const response = await fetch(this.endpoint(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
          signal: ctx.signal,
        });

        if (response.status === 429) {
          throw serviceUnavailable('Overpass API returned HTTP 429 — all query slots occupied.', {
            reason: 'rate_limited',
          });
        }

        if (response.status === 400) {
          const body = await response.text();
          throw serviceUnavailable(
            `Overpass API returned HTTP 400 — malformed query syntax. ${body.slice(0, 200)}`,
            { reason: 'query_error' },
          );
        }

        if (!response.ok) {
          throw serviceUnavailable(`Overpass API returned HTTP ${response.status}`, {
            status: response.status,
          });
        }

        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'Overpass returned an HTML page instead of JSON — likely rate-limited.',
          );
        }

        const data = JSON.parse(text) as OverpassResponse;

        // Detect runtime errors embedded in JSON response
        if ('remark' in data) {
          const remark = String((data as Record<string, unknown>).remark);
          if (OVERPASS_TIMEOUT_PATTERN.test(remark)) {
            throw timeoutError(`Overpass query timed out: ${remark}`, { reason: 'query_timeout' });
          }
          if (OVERPASS_OOM_PATTERN.test(remark)) {
            throw serviceUnavailable(`Overpass ran out of memory: ${remark}`, {
              reason: 'result_too_large',
            });
          }
        }

        return data;
      },
      {
        operation: 'overpass.query',
        context: ctx as unknown as RequestContextLike,
        baseDelayMs: 2000,
        signal: ctx.signal,
      },
    );

    await ctx.state.set(cacheKey, result, { ttl: CACHE_TTL_SECONDS });
    return result;
  }

  /** Execute a generated or raw Overpass QL query and return raw elements. */
  query(ql: string, ctx: Context): Promise<OverpassResponse> {
    ctx.log.info('Overpass query', { queryLength: ql.length });
    return this.executeQuery(ql, ctx);
  }

  /** Normalize Overpass elements into POI-friendly shape. */
  normalizeElements(elements: OverpassElement[]): OverpassPoi[] {
    return elements.map((el) => {
      const lat = el.type === 'node' ? el.lat : el.center?.lat;
      const lon = el.type === 'node' ? el.lon : el.center?.lon;
      const tags = el.tags ?? {};
      return {
        osm_type: el.type,
        osm_id: el.id,
        ...(lat !== undefined && { lat }),
        ...(lon !== undefined && { lon }),
        ...(tags.name ? { name: tags.name } : {}),
        tags,
      };
    });
  }
}

// --- Init/accessor pattern ---

let _service: OverpassService | undefined;

export function initOverpassService(config: AppConfig, storage: StorageService): void {
  _service = new OverpassService(config, storage);
}

export function getOverpassService(): OverpassService {
  if (!_service) {
    throw new Error('OverpassService not initialized — call initOverpassService() in setup()');
  }
  return _service;
}
