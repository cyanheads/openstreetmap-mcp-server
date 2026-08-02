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
import { extractOverpassError } from './overpass-error.js';
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

/**
 * Throttle signatures in an Overpass error document. OSM3S renders a rate-limit
 * refusal as `Dispatcher_Client::request_read_and_idx::rate_limited. Please check
 * <server>status for the quota of your IP address.`; a proxy in front of an
 * instance may phrase the same refusal in prose instead.
 */
const OVERPASS_THROTTLE_TEXT_PATTERN = /rate_limited|too many requests|quota of your ip/i;

/**
 * Faults that belong to the instance rather than the query, so another endpoint
 * may serve the same query fine. OSM3S names all of them: every dispatcher fault
 * carries a `Dispatcher_Client::…` origin, a dispatcher that gave up adds "The
 * server is probably too busy to handle your request.", one that is switched off
 * adds "The dispatcher (i.e. the database management system) is turned off.", and
 * every underlying file fault renders as an `open64:` line.
 *
 * Deliberately narrow. The remark bucket also holds query-deterministic faults —
 * a malformed filter, a bad area reference — that every endpoint rejects
 * identically, and rotating those spends a second endpoint's slot on a request
 * that cannot succeed (#13). Matching a recognized instance signature keeps them
 * on one endpoint while letting a genuine instance fault fail over.
 */
const OVERPASS_INSTANCE_FAULT_PATTERN = /dispatcher|too busy|open64:/i;

/**
 * A body that opens a tag — markup where JSON was requested. Tolerates a leading
 * XML declaration: OSM3S error documents lead with `<?xml version="1.0" …?>`
 * before the doctype, so a pattern anchored on `<!DOCTYPE`/`<html` misses every
 * one of them.
 */
const MARKUP_DOCUMENT_PATTERN = /^\s*<[?!a-z]/i;

/** Characters of an unrecognized non-JSON body quoted into the error message. */
const OVERPASS_BODY_EXCERPT_LIMIT = 200;

/** Floor for the client-side deadline of one attempt (Overpass queries run long). */
const OVERPASS_CLIENT_TIMEOUT_MS = 90_000;

/**
 * Floor for the whole-call budget. No attempt is submitted once one `query()`
 * call has spent this much wall-clock time. The per-attempt deadline, the queue
 * wait for an endpoint slot, and withRetry's backoff between attempts all draw
 * from it, so the call settles one backoff past the budget at the latest.
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
 * Headroom over the query's own `[timeout:N]`, which bounds Overpass's runtime
 * and nothing else: the answer still has to be queued for a slot on the endpoint
 * and transferred. Measured against the default endpoint, a 20 MB / 174k-element
 * response spends about 10s in transfer beyond the server-side work, and the
 * shipped flat pair already encodes the same 30s margin twice — 90s per attempt
 * over the 60s ceiling the convenience tools request, and 120s total over that
 * 90s. Deriving both layers with the same margin keeps that calibration.
 */
const OVERPASS_TIMEOUT_GRACE_MS = 30_000;

/** The effective `[timeout:N]` of the QL actually being submitted. */
const OVERPASS_QL_TIMEOUT_PATTERN = /\[timeout:\s*(\d{1,5})\s*\]/;

/**
 * Elements past which a result is served but not cached. `ctx.state` is in-memory
 * by default, so a cached result is charged against the same budget as the live
 * response for the full TTL. Measured against the default endpoint, a parsed
 * Overpass element retains about 250 bytes, so this ceiling caps one cached
 * result near 25 MB; the 2.77M-element extract that motivated the cap would have
 * retained roughly 700 MB for ten minutes.
 *
 * Sized well past what paging can consume — 200 full pages at the tools' 500-item
 * maximum — so re-paging a plausible result set still costs no upstream request.
 * Past it, each page re-queries: slower, and only as stable as the endpoint's own
 * ordering, which the `offset` descriptions state.
 *
 * Exported so the tools' `offset` descriptions and this ceiling can be pinned to
 * each other in a test rather than drifting apart.
 */
export const CACHE_MAX_ELEMENTS = 100_000;

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
 * Endpoint-agnostic: it answers whether another attempt could help at all, which
 * is the whole question when one endpoint is configured. `executeQuery` layers a
 * call-scoped wrapper over it for the multi-endpoint case, where a host-specific
 * refusal can still be worth retrying somewhere else.
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
 * True for a failure that belongs to the endpoint that produced it rather than to
 * the query — so another endpoint may answer the same query, but this one will
 * not, however many times it is asked.
 *
 * Two families qualify, both an explicit statement by the instance about itself:
 *
 * - **Throttled.** The `rate_limited` reason the service attaches to a throttle
 *   document, and a bare HTTP 429. A 429 carrying Retry-After is excluded — the
 *   endpoint named a window, so honoring it beats writing the host off.
 * - **Instance fault.** An `upstream_error` whose text carries a recognized OSM3S
 *   dispatcher or database signature. The rest of that bucket is
 *   query-deterministic and stays put.
 *
 * Asked separately from `isTransientOverpassError` because it answers a different
 * question. That predicate answers "could another attempt help at all?", which
 * for these is no when one endpoint is configured — and re-submitting to a host
 * that just refused is the load amplification the fail-fast exists to prevent.
 * This one answers "could another *host* help?", which the caller resolves
 * against the endpoints it has left.
 */
function isEndpointFault(error: unknown): boolean {
  if (!(error instanceof McpError)) return false;
  const data = error.data as Record<string, unknown> | undefined;
  if (data?.reason === 'rate_limited') return true;
  if (data?.status === 429 && data.retryAfter === undefined) return true;
  return data?.reason === 'upstream_error' && OVERPASS_INSTANCE_FAULT_PATTERN.test(error.message);
}

/** Client-side time budget for one `query()` call. */
export interface OverpassQueryBudget {
  /** Ceiling on any single attempt's client deadline. */
  readonly attemptMs: number;
  /** Whole-call budget, reported when it is spent. */
  readonly totalMs: number;
}

/**
 * Derives the client-side budget from the `[timeout:N]` the query carries, so a
 * caller asking Overpass for more time is actually waited for. Reading the QL
 * covers both routes to that directive with one mechanism: the value
 * `timeout_seconds` injects, and one a caller wrote into the query string
 * themselves, which no input validator can reach.
 *
 * Widens only — both layers keep the flat constant as a floor. A query asking for
 * less than the flat budget still gets the flat budget, so no query that succeeds
 * under a generous client deadline today can start failing under a tighter
 * derived one. A query with no parseable directive falls back to the flat pair.
 *
 * Exported for unit testing.
 */
export function deriveQueryBudget(query: string): OverpassQueryBudget {
  const requestedSeconds = Number(OVERPASS_QL_TIMEOUT_PATTERN.exec(query)?.[1]);
  const attemptMs = Number.isFinite(requestedSeconds)
    ? Math.max(OVERPASS_CLIENT_TIMEOUT_MS, requestedSeconds * 1000 + OVERPASS_TIMEOUT_GRACE_MS)
    : OVERPASS_CLIENT_TIMEOUT_MS;
  return {
    attemptMs,
    totalMs: Math.max(OVERPASS_TOTAL_DEADLINE_MS, attemptMs + OVERPASS_TIMEOUT_GRACE_MS),
  };
}

/**
 * Parses an Overpass 2xx body, classifying a non-JSON one instead of letting
 * `JSON.parse` throw. A raw `SyntaxError` carries no reason, no recovery, and no
 * status, and withRetry reads a non-`McpError` as transient — so an endpoint
 * serving an error document used to cost four submissions and surface as an
 * unclassified internal error.
 *
 * The classification is by what the document says, not by the fact that it isn't
 * JSON. Overpass emits this shape whenever it fails before it can start streaming
 * the payload, which covers throttling and instance faults alike, and the two
 * want different recovery advice.
 */
function parseOverpassBody(text: string): OverpassResponse & { remark?: string } {
  try {
    return JSON.parse(text) as OverpassResponse & { remark?: string };
  } catch {
    const detail = extractOverpassError(text);
    if (detail && OVERPASS_THROTTLE_TEXT_PATTERN.test(detail)) {
      throw serviceUnavailable(`Overpass refused the query as throttled: ${detail}`, {
        reason: 'rate_limited',
      });
    }
    if (detail) {
      throw serviceUnavailable(`Overpass reported an error: ${detail}`, {
        reason: 'upstream_error',
      });
    }
    if (MARKUP_DOCUMENT_PATTERN.test(text)) {
      // A page with no error line to read — a proxy interstitial rather than an
      // OSM3S document. Throttling is what puts one in front of a public
      // instance, and it is endpoint-scoped either way.
      throw serviceUnavailable(
        'Overpass returned an HTML page instead of JSON — likely rate-limited.',
        { reason: 'rate_limited' },
      );
    }
    throw serviceUnavailable(
      `Overpass returned a body that is not JSON: ${text.slice(0, OVERPASS_BODY_EXCERPT_LIMIT).trim()}`,
      { reason: 'upstream_error' },
    );
  }
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
    budget: OverpassQueryBudget,
    ctx: Context,
  ): Promise<string> {
    const remainingMs = deadlineAt - performance.now();
    if (remainingMs <= 0) {
      throw timeoutError(
        `Overpass did not answer within the ${budget.totalMs}ms budget for this call.`,
        // retryable: false — the budget is spent; no further attempt can fit.
        { reason: 'endpoints_exhausted', retryable: false, errorSource: 'OverpassTotalTimeout' },
      );
    }
    const attemptTimeoutMs = Math.min(remainingMs, budget.attemptMs);
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
    budget: OverpassQueryBudget,
    ctx: Context,
  ): Promise<OverpassResult> {
    return this.withSlot(async () => {
      // postQuery throws a status-classified McpError for every non-2xx, so the
      // body reaching here always came back with HTTP 2xx.
      const text = await this.postQuery(query, endpoint, deadlineAt, budget, ctx);
      const data = parseOverpassBody(text);

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
   * closure never runs again to pick up the next endpoint.
   *
   * That predicate answers "should another attempt be made?" with no knowledge of
   * where the next attempt would go, which is the wrong question for a throttled
   * endpoint: the refusal is a property of that host, not of the query. The
   * call-scoped wrapper below asks the endpoint-aware question on top of it, so a
   * throttle rotates to a host that has not refused this call and ends the call
   * only once every endpoint has. Both the tried-set and the counter live in this
   * closure rather than on the service, so concurrent calls never see each other's
   * rotation state.
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
    const budget = deriveQueryBudget(query);
    const deadlineAt = performance.now() + budget.totalMs;
    let attempt = 0;

    /** Endpoints that failed this call on their own account; never asked again. */
    const faulted = new Set<string>();
    /** Endpoint the attempt in flight went to, so the predicate can attribute its failure. */
    let lastEndpoint: string | undefined;

    /**
     * Wraps rather than stopping at the last entry: with more attempts than
     * endpoints, coming back to the first one gives an endpoint that shed load a
     * moment ago a chance to have recovered. A host that stated its own fault is
     * the exception — it did not shed load, it refused — so rotation steps over it
     * and takes the next live entry instead.
     */
    const selectEndpoint = (): string => {
      const start = attempt % endpoints.length;
      for (let i = 0; i < endpoints.length; i++) {
        const candidate = endpoints[(start + i) % endpoints.length] as string;
        if (!faulted.has(candidate)) return candidate;
      }
      // Unreachable: the predicate ends the call on the fault that fills the set,
      // so no attempt is ever selected with every endpoint in it. The config
      // schema requires at least one entry, so the cast states an invariant the
      // index type cannot carry.
      return endpoints[start] as string;
    };

    const isTransient = (error: unknown): boolean => {
      if (isEndpointFault(error)) {
        if (lastEndpoint) faulted.add(lastEndpoint);
        // Transient for the call while an endpoint remains that has not failed it,
        // never for the host that just did. With one endpoint configured this is
        // false on the first fault, which is the single-endpoint behavior the
        // throttle and remark fail-fasts established.
        return faulted.size < endpoints.length;
      }
      return isTransientOverpassError(error);
    };

    const result = await withRetry(
      () => {
        const endpoint = selectEndpoint();
        if (attempt > 0) {
          ctx.log.info('Overpass retry submitting to endpoint', {
            attempt: attempt + 1,
            endpoint: redactEndpoint(endpoint),
          });
        }
        attempt++;
        lastEndpoint = endpoint;
        return this.submitQuery(query, endpoint, deadlineAt, budget, ctx);
      },
      {
        operation: 'overpass.query',
        context: ctx as unknown as RequestContextLike,
        baseDelayMs: 2000,
        isTransient,
        signal: ctx.signal,
      },
    );

    if (result.elements.length <= CACHE_MAX_ELEMENTS) {
      await ctx.state.set(cacheKey, result, { ttl: CACHE_TTL_SECONDS });
    } else {
      ctx.log.info('Overpass result too large to cache', {
        elements: result.elements.length,
        ceiling: CACHE_MAX_ELEMENTS,
      });
    }
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
