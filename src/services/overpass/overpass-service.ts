/**
 * @fileoverview Overpass API client with retry, session caching, and QL query builders.
 * @module services/overpass/overpass-service
 */

import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  internalError,
  McpError,
  serviceUnavailable,
  timeout as timeoutError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { RequestContextLike } from '@cyanheads/mcp-ts-core/utils';
import { createHistogram, httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  OverpassAroundParams,
  OverpassBboxParams,
  OverpassElement,
  OverpassPoi,
  OverpassResponse,
  OverpassResult,
} from './types.js';

/** Cache TTL for Overpass results: 10 minutes (more volatile than geocoding). */
const CACHE_TTL_SECONDS = 600;

/**
 * Overpass remark text for a query-level timeout. Every Overpass runtime remark
 * opens with `runtime error:`, so matching that prefix classified out-of-memory
 * (and every other runtime fault) as a timeout — the timeout recovery hint tells
 * the caller to raise `[timeout:N]`, which re-runs an OOM query identically and
 * spends another of the endpoint's slots.
 */
const OVERPASS_TIMEOUT_PATTERN = /query timed out|timed out/i;

/** Overpass out-of-memory error patterns. */
const OVERPASS_OOM_PATTERN = /out of memory|query run out/i;

/** Client-side deadline per attempt (Overpass queries can run long). */
const OVERPASS_CLIENT_TIMEOUT_MS = 90_000;

/**
 * No attempt is submitted once one `query()` call has spent this much wall-clock
 * time. The per-attempt deadline, the queue wait for an endpoint slot, and
 * withRetry's backoff between attempts all draw from it, so the call settles one
 * backoff past the budget at the latest.
 *
 * Without it the attempt budget multiplies the per-attempt deadline: four
 * attempts against a socket that accepts and never answers cost 4 × 90s plus
 * backoff, over six minutes for a single tool call, and endpoint rotation makes
 * that shape likelier by giving each attempt a fresh host to hang on. A hanging
 * endpoint burns its full per-attempt deadline and the next entry in the list
 * still gets whatever the budget has left — a shortened attempt rather than none
 * — while the caller gets an answer inside a plausible client patience window.
 */
const OVERPASS_TOTAL_DEADLINE_MS = 120_000;

/**
 * Characters of a non-2xx Overpass body captured into `error.data.body`.
 *
 * The public endpoint answers a malformed query with a 977-byte XHTML document
 * that spends its first 501 bytes on boilerplate — XML declaration, DOCTYPE,
 * `<head>`, and the ODbL attribution paragraph — so the first `Error:` line
 * starts at byte 502. Anything at or below the framework's 500-byte default
 * discards every parse-error line, which is the only actionable signal on the
 * raw-query path. 4000 bytes covers the boilerplate plus the full error list;
 * the agent-facing message stays bounded independently by the extraction cap in
 * `overpass-error.ts`.
 */
const OVERPASS_ERROR_BODY_LIMIT = 4000;

/**
 * Duration of outbound Overpass requests. Records the same series
 * `fetchWithTimeout` emits, with the same attributes, so owning the request does
 * not blank out the endpoint's latency histogram.
 */
let requestDurationHistogram: ReturnType<typeof createHistogram> | undefined;

function getRequestDurationHistogram(): ReturnType<typeof createHistogram> {
  requestDurationHistogram ??= createHistogram(
    'http.client.request.duration',
    'Duration of outbound HTTP requests',
    's',
  );
  return requestDurationHistogram;
}

/**
 * Returns false for failures that cannot clear inside the retry window, so
 * withRetry surfaces them immediately instead of re-submitting. Exported for
 * unit testing.
 *
 * Non-transient cases:
 * - reason 'query_timeout' / 'result_too_large' / 'upstream_error' — thrown by
 *   the service after parsing a JSON remark from Overpass (HTTP 200 with an
 *   embedded error). The query fails identically on re-submission.
 * - reason 'rate_limited' — Overpass served an HTML throttle page with HTTP 200.
 *   Re-submitting adds load to an endpoint already known to be throttling.
 * - status 429 with no Retry-After — the same block signalled by status. Overpass
 *   sends no Retry-After, so this is the usual shape; when a mirror *does* send
 *   one the error stays transient and withRetry honors the requested wait.
 * - status 400 — malformed query. `httpErrorFromResponse` classifies it as
 *   InvalidParams with no reason; re-submitting the same QL fails identically.
 * - `data.retryable === false` — the framework's in-band opt-out, honored here
 *   because this predicate replaces the default one that reads it. The call's
 *   total deadline uses it: once the budget is spent there is no attempt left to
 *   retry into, on this endpoint or any other.
 */
export function isTransientOverpassError(error: unknown): boolean {
  if (error instanceof McpError) {
    const data = error.data as Record<string, unknown> | undefined;
    if (data?.retryable === false) return false;
    const reason = data?.reason as string | undefined;
    if (
      reason === 'query_timeout' ||
      reason === 'result_too_large' ||
      reason === 'upstream_error' ||
      reason === 'rate_limited'
    ) {
      return false;
    }
    if (data?.status === 429 && data.retryAfter === undefined) return false;
    // HTTP 400 classifies as InvalidParams — malformed query, never transient
    if (data?.status === 400) return false;
  }
  return true;
}

/**
 * Strips the query string, fragment, and any embedded credentials from the
 * configured endpoint before it enters error data. Mirrors what
 * `fetchWithTimeout` does for its own error text, so owning the request does not
 * start echoing a private mirror's `?key=…` back to the client. The config schema
 * validates the value as a URL, so parsing cannot fail here.
 */
function redactEndpoint(endpoint: string): string {
  const parsed = new URL(endpoint);
  return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`;
}

/**
 * Great-circle distance in meters between two WGS84 coordinates (haversine).
 * Accurate to well within a meter at the ≤50km radius this server supports —
 * no need for geodesic (Vincenty) precision.
 */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusMeters = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(h));
}

export class OverpassService {
  /** Submissions currently occupying an endpoint slot. */
  private inFlight = 0;

  /** FIFO of callers parked until a slot frees. */
  private readonly slotQueue: (() => void)[] = [];

  // config and storage reserved for future use (private instance auth, custom storage)
  constructor(_config: AppConfig, _storage: StorageService) {}

  /**
   * Ordered endpoints for one query, tried in list order until one answers.
   *
   * `OSM_OVERPASS_BASE_URL` pins a single endpoint and so disables rotation
   * outright — a private or self-hosted instance is not interchangeable with a
   * public mirror, and an operator who named one endpoint did not ask for their
   * queries to be sent anywhere else.
   */
  private endpoints(): readonly string[] {
    const config = getServerConfig();
    return config.overpassBaseUrl ? [config.overpassBaseUrl] : config.overpassEndpoints;
  }

  /**
   * Run `fn` holding one of the endpoint's concurrent query slots, queueing
   * locally past the cap rather than piling submissions onto the endpoint. This
   * bounds what the server sends at once; it does not make 429 impossible, since
   * Overpass keeps a slot reserved for the full `[timeout:N]` after answering.
   *
   * A concurrency gate rather than the request-rate throttle Nominatim uses: the
   * Overpass constraint is how many queries are *in flight*, and one query can
   * hold its slot for the full `[timeout:N]` (up to 180s on the raw tool), so
   * spacing request start times would not bound the in-flight count.
   *
   * `signal` cancels the wait as well as the request. Without it a cancelled
   * caller would stay parked until a slot reached it — the client deadline over
   * again for every position ahead of it — because withRetry awaits the operation
   * and cannot abandon a pending one. An aborted caller never holds a slot: it
   * either has not taken one yet (rejected before the count moves) or is spliced
   * out of the queue, so a release still hands its slot to a live waiter.
   */
  private async withSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw internalError('Overpass query was aborted before it was submitted.', {
        errorSource: 'OverpassSlotAborted',
      });
    }
    if (this.inFlight < getServerConfig().overpassMaxConcurrency) {
      this.inFlight++;
    } else {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const queued = this.slotQueue.indexOf(grantSlot);
          if (queued !== -1) this.slotQueue.splice(queued, 1);
          reject(
            internalError('Overpass query was aborted while waiting for an endpoint slot.', {
              errorSource: 'OverpassSlotAborted',
            }),
          );
        };
        /**
         * Drops the abort listener before resolving, so a signal outliving one
         * request doesn't accumulate a listener per query it queued. The abort
         * path needs no matching removal — `once` handles that side. Removal is
         * synchronous with the handoff, so a waiter cannot both take a slot and
         * splice itself out.
         */
        const grantSlot = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        this.slotQueue.push(grantSlot);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next waiter and leave the count alone —
      // decrementing first would let a caller arriving in the same tick claim it
      // too, putting one more submission in flight than the cap allows.
      const next = this.slotQueue.shift();
      if (next) next();
      else this.inFlight--;
    }
  }

  private buildCacheKey(query: string): string {
    const hash = createHash('sha256').update(query).digest('hex').slice(0, 16);
    return `overpass/${hash}`;
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

  /**
   * POST one query to Overpass under a per-attempt client deadline and return the
   * response body, throwing a status-classified `McpError` for any non-2xx.
   *
   * Owns the request instead of delegating to `fetchWithTimeout` because that
   * helper truncates a non-2xx body at a hard-coded 500 bytes — two bytes short
   * of the first `Error:` line in the endpoint's error document, so the parse
   * error naming the syntax fault never reaches the caller.
   * `httpErrorFromResponse` applies the same status → code table and produces the
   * same `error.data` shape (`status`, `statusText`, `body`, `retryAfter`, plus
   * the legacy `statusCode`/`responseBody` aliases) with a caller-set body limit,
   * so the retry classifier and the tools' catch blocks read it unchanged.
   *
   * The deadline is an `AbortController` rather than `AbortSignal.timeout()` —
   * the latter can fail under Bun's stdio transport on a realm mismatch — composed
   * with `ctx.signal` so a cancelling caller still aborts the request in flight.
   *
   * `deadlineAt` is the whole call's budget, read here rather than in the caller
   * so the slot wait counts against it: this method runs holding a slot, so time
   * spent queued behind other submissions is already elapsed by the time the
   * per-attempt deadline is derived from what remains.
   */
  private async postQuery(
    query: string,
    endpoint: string,
    deadlineAt: number,
    ctx: Context,
  ): Promise<string> {
    const remainingMs = deadlineAt - performance.now();
    if (remainingMs <= 0) {
      throw timeoutError(
        `Overpass did not answer within the ${OVERPASS_TOTAL_DEADLINE_MS}ms budget for this call.`,
        // retryable: false — the budget is spent; no further attempt can fit.
        { reason: 'endpoints_exhausted', retryable: false, errorSource: 'OverpassTotalTimeout' },
      );
    }
    const attemptTimeoutMs = Math.min(remainingMs, OVERPASS_CLIENT_TIMEOUT_MS);
    const serverAddress = new URL(endpoint).hostname;
    const controller = new AbortController();
    /**
     * Abort with a held exception instance so the catch block can identity-match
     * our own deadline: `fetch` rejects with the abort *reason*, and a caller
     * signal aborting with its own TimeoutError must stay classified as a caller
     * abort, not as this deadline firing.
     */
    const deadlineReason = new DOMException(
      `Overpass query exceeded the ${attemptTimeoutMs}ms client deadline.`,
      'TimeoutError',
    );
    const timer = setTimeout(() => controller.abort(deadlineReason), attemptTimeoutMs);
    const signal = ctx.signal
      ? AbortSignal.any([controller.signal, ctx.signal])
      : controller.signal;

    const startedAt = performance.now();
    let statusCode = 0;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': getServerConfig().nominatimUserAgent,
        },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      });
      statusCode = response.status;

      if (!response.ok) {
        throw await httpErrorFromResponse(response, {
          service: 'Overpass',
          bodyLimit: OVERPASS_ERROR_BODY_LIMIT,
          data: {
            // Redacted to origin + path: the endpoint is operator-configured and a
            // private mirror can carry a key in the query string.
            url: redactEndpoint(endpoint),
            requestId: ctx.requestId,
            operation: 'overpass.query',
            errorSource: 'OverpassHttpError',
          },
        });
      }

      return await response.text();
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (controller.signal.reason === deadlineReason) {
        throw timeoutError('Overpass query exceeded the client deadline.', {
          errorSource: 'OverpassClientTimeout',
        });
      }
      if (signal.aborted) {
        throw internalError('Overpass query was aborted by the caller.', {
          errorSource: 'OverpassAborted',
        });
      }
      throw serviceUnavailable(
        `Network error contacting Overpass: ${error instanceof Error ? error.message : String(error)}`,
        { url: redactEndpoint(endpoint), errorSource: 'OverpassNetworkError' },
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      const attributes: Record<string, string | number> = {
        'http.request.method': 'POST',
        'server.address': serverAddress,
      };
      if (statusCode > 0) attributes['http.response.status_code'] = statusCode;
      getRequestDurationHistogram().record((performance.now() - startedAt) / 1000, attributes);
    }
  }

  /** POST one query to Overpass, holding an endpoint slot for the submission. */
  private submitQuery(
    query: string,
    endpoint: string,
    deadlineAt: number,
    ctx: Context,
  ): Promise<OverpassResult> {
    return this.withSlot(async () => {
      // postQuery throws a status-classified McpError for every non-2xx, so the
      // body reaching here always came back with HTTP 2xx.
      const text = await this.postQuery(query, endpoint, deadlineAt, ctx);
      if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
        throw serviceUnavailable(
          'Overpass returned an HTML page instead of JSON — likely rate-limited.',
          { reason: 'rate_limited' },
        );
      }

      const data = JSON.parse(text) as OverpassResponse & { remark?: string };

      // Detect runtime errors embedded in JSON response
      if (data.remark) {
        if (OVERPASS_TIMEOUT_PATTERN.test(data.remark)) {
          throw timeoutError(`Overpass query timed out: ${data.remark}`, {
            reason: 'query_timeout',
          });
        }
        if (OVERPASS_OOM_PATTERN.test(data.remark)) {
          throw serviceUnavailable(`Overpass ran out of memory: ${data.remark}`, {
            reason: 'result_too_large',
          });
        }
        // Overpass reports area lookups, malformed filters, and dispatcher or
        // database outages here too, alongside an empty element list. Returning
        // that as a success hides the failure behind "no results", so surface the
        // remark verbatim — it names the fault.
        throw serviceUnavailable(`Overpass reported an error: ${data.remark}`, {
          reason: 'upstream_error',
        });
      }

      // Redacted here rather than at the tool layer: the value is reported to the
      // client, and an operator-configured mirror can carry credentials or a
      // `?key=` that must not travel with it.
      return { ...data, servedBy: redactEndpoint(endpoint) };
    }, ctx.signal);
  }

  /**
   * Serve a query from cache, or submit it — advancing through the endpoint list
   * on each retry so a degraded endpoint costs latency rather than the answer.
   *
   * Rotation rides withRetry's existing attempt loop keyed on the attempt index,
   * which is what keeps deterministic failures on one endpoint:
   * `isTransientOverpassError` stops the loop for a query that every mirror would
   * reject identically (`query_timeout`, `result_too_large`, HTTP 400), so the
   * closure never runs again to pick up the next endpoint. Only a transient
   * failure — 5xx, HTML throttle page, connection error — rotates.
   *
   * The serving endpoint is cached with the response, so a cache hit reports the
   * endpoint that actually produced the data rather than whichever one the current
   * call would have tried first.
   */
  private async executeQuery(query: string, ctx: Context): Promise<OverpassResult> {
    const cacheKey = this.buildCacheKey(query);
    const cached = await ctx.state.get<OverpassResult>(cacheKey);
    if (cached !== null) {
      ctx.log.debug('Overpass cache hit');
      return cached;
    }

    const endpoints = this.endpoints();
    const deadlineAt = performance.now() + OVERPASS_TOTAL_DEADLINE_MS;
    let attempt = 0;

    const result = await withRetry(
      () => {
        /**
         * Wraps rather than stopping at the last entry: with more attempts than
         * endpoints, coming back to the first one gives an endpoint that shed load
         * a moment ago a chance to have recovered. The modulo keeps the index in
         * range and the config schema requires at least one entry, so the cast
         * states an invariant the index type cannot carry.
         */
        const endpoint = endpoints[attempt % endpoints.length] as string;
        if (attempt > 0) {
          ctx.log.info('Overpass retry submitting to endpoint', {
            attempt: attempt + 1,
            endpoint: redactEndpoint(endpoint),
          });
        }
        attempt++;
        return this.submitQuery(query, endpoint, deadlineAt, ctx);
      },
      {
        operation: 'overpass.query',
        context: ctx as unknown as RequestContextLike,
        baseDelayMs: 2000,
        isTransient: isTransientOverpassError,
        signal: ctx.signal,
      },
    );

    await ctx.state.set(cacheKey, result, { ttl: CACHE_TTL_SECONDS });
    return result;
  }

  /** Execute a generated or raw Overpass QL query and return raw elements. */
  query(ql: string, ctx: Context): Promise<OverpassResult> {
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
