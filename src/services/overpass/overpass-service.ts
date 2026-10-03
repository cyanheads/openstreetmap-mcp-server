/**
 * @fileoverview Overpass API client with retry, session caching, and QL query builders.
 * @module services/overpass/overpass-service
 */

import { createHash } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  requestCancelled,
  serviceUnavailable,
  timeout as timeoutError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createHistogram,
  createPacer,
  defaultIsTransient,
  httpErrorFromResponse,
  type Pacer,
  type RetryAttempt,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import { extractOverpassError } from './overpass-error.js';
import { OVERPASS_QL_TIMEOUT_PATTERN } from './overpass-ql.js';
import type {
  OverpassAreaParams,
  OverpassAreaScope,
  OverpassAroundParams,
  OverpassBboxParams,
  OverpassElement,
  OverpassPoi,
  OverpassQueryParams,
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
 * Floor for the whole-call budget: one wall-clock budget for a `query()` call,
 * counted from when the call joins the line. The line wait, every entry-slot wait,
 * the per-attempt deadline, and the backoff between attempts all draw from it —
 * `withRetry` gets what the line wait left as its `deadlineMs`. It aborts the
 * attempt in flight when it runs out, and a backoff that would outlast it fails
 * fast instead of sleeping, so the call settles at the budget rather than past it.
 *
 * Bounds the endpoint list: an unanswered attempt faults the host that produced
 * it, so a hanging endpoint costs one attempt window and is never asked again,
 * leaving a worst case of one full window per configured entry. Under this budget
 * each entry after the first gets only what is left — a shortened attempt rather
 * than a full one — and once nothing is left no further endpoint is submitted to
 * at all, so a long list of hanging mirrors cannot hold the caller past any
 * plausible patience window.
 */
const OVERPASS_TOTAL_DEADLINE_MS = 120_000;

/**
 * Floor of the submissions one call may make: `withRetry`'s own default of four
 * attempts, so a list of up to four entries spends what it always has. A longer list
 * raises it to one per entry. The walk inside the first attempt asks every entry once
 * on its own; the rest of the cap is returns to entries already asked.
 */
const DEFAULT_MAX_SUBMISSIONS = 4;

/**
 * The most one call waits for slots, summed over the line and every entry slot it
 * waits at (#90). Past it the call sheds as the framework's `pacer_shed` with a
 * `retryAfter`, so a backlog reaches the caller as a busy signal rather than as a
 * cancellation or a spent budget. 30 s leaves the shed — and a short query admitted
 * just inside it — within the MCP TypeScript SDK's 60 s default request timeout.
 * Shorter than the smallest call budget, so the line wait alone never outlasts one.
 */
const OVERPASS_SLOT_WAIT_MS = 30_000;

/**
 * How long later calls skip an entry after a fault remembered across calls (#81), doubling
 * per consecutive remembered fault up to {@link HOST_COOLDOWN_MAX_MS}. Long enough that a
 * burst of calls does not each pay a dead host's connect timeout or attempt window; short
 * enough that a host back from a restart is asked again within a minute or two.
 */
const HOST_COOLDOWN_BASE_MS = 30_000;

/** The longest a remembered entry is skipped before one call probes it again. */
const HOST_COOLDOWN_MAX_MS = 600_000;

/**
 * A refusal arrives within a few round trips, SYN retransmits included. Bun reports the OS
 * giving up on a host that never answered (75 s on macOS) as the same `ConnectionRefused`,
 * so one that took at least this long is read as no connection at all.
 */
const SLOW_REFUSAL_MS = 10_000;

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

/**
 * Largest `[timeout:N]` the budget widens for; past it the flat pair applies. Longer
 * than any window a client holds open, and inside the 32-bit millisecond range of
 * the attempt timer, which a runaway value would overflow into an immediate abort.
 */
const OVERPASS_QL_TIMEOUT_MAX_SECONDS = 99_999;

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
 * is the whole question when one endpoint is configured. `attempts` layers a
 * call-scoped wrapper over it for the multi-endpoint case, where a host-specific
 * refusal can still be worth retrying somewhere else.
 *
 * Composes off the framework's `defaultIsTransient`, which retries only
 * `ServiceUnavailable`, `Timeout`, and `RateLimited` and honors the
 * `data.retryable: false` opt-out and a pacer shed — so a 401, 403, or 404 is
 * never re-submitted (#86). On top of that default, failures that arrive under a
 * retryable code but fail identically on re-submission are non-transient too:
 * - reason 'query_timeout' / 'result_too_large' / 'upstream_error' — thrown by
 *   the service after parsing a JSON remark from Overpass (HTTP 200 with an
 *   embedded error). The query fails identically on re-submission.
 * - reason 'rate_limited' — Overpass served an HTML throttle page with HTTP 200.
 *   Re-submitting adds load to an endpoint already known to be throttling.
 * - status 429 with no Retry-After — the same block signalled by status. Overpass
 *   sends no Retry-After, so this is the usual shape; when a mirror *does* send
 *   one the error stays transient and withRetry honors the requested wait.
 * - status 400 — malformed query. Keyed on the status rather than on the
 *   InvalidParams code it maps to: re-submitting the same QL fails identically.
 */
export function isTransientOverpassError(error: unknown): boolean {
  if (error instanceof McpError) {
    const data = error.data as Record<string, unknown> | undefined;
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
    if (data?.status === 400) return false;
  }
  return defaultIsTransient(error);
}

/**
 * What one endpoint did to a call, in the terms the composed terminal error
 * reports. The kind decides which reason a call of only these faults ends on;
 * the detail is the phrase quoted beside that endpoint in the message.
 */
interface EndpointFault {
  readonly detail: string;
  readonly kind: 'instance' | 'rejected' | 'throttled' | 'unanswered' | 'unavailable';
}

/**
 * Connection-level rejection codes, in the words a caller can act on. Bun rejects
 * every one of them as a plain `TypeError` whose `code` is the only thing
 * separating a refusal from a name that does not resolve; the message is the same
 * sentence in all cases. Node rejects them all as `TypeError('fetch failed')`
 * carrying the system error, code included, as its `cause`.
 */
const CONNECTION_FAILURE_DETAIL: Readonly<Record<string, string>> = {
  EAI_AGAIN: 'DNS lookup failed',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ENOTFOUND: 'DNS lookup failed',
  ETIMEDOUT: 'connection timed out',
  ConnectionRefused: 'connection refused',
};

/**
 * Levels of a failed `fetch` read for its system code — Bun puts it on the rejection, Node one
 * `cause` down. Bounded because the chain is the runtime's object: one that looped back on
 * itself would otherwise hold the event loop for good.
 */
const CONNECTION_CODE_DEPTH = 4;

/** The system error code of a failed `fetch`: on the rejection itself (Bun) or along its `cause` chain (Node). */
function connectionCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < CONNECTION_CODE_DEPTH && current instanceof Error; depth++) {
    const { code } = current as Error & { code?: unknown };
    if (typeof code === 'string') return code;
    current = current.cause;
  }
  return;
}

/**
 * How a connection-level failure reads beside its endpoint. A host the client never
 * connected to is named by the time it was given: Bun's `ConnectionRefused` once it took
 * {@link SLOW_REFUSAL_MS} or more, and Node's own connect timeout, `UND_ERR_CONNECT_TIMEOUT`.
 */
function connectionFailureDetail(code: string | undefined, elapsedMs: number): string {
  if (
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    (code === 'ConnectionRefused' && elapsedMs >= SLOW_REFUSAL_MS)
  ) {
    return `no connection within ${elapsedMs}ms`;
  }
  return (code === undefined ? undefined : CONNECTION_FAILURE_DETAIL[code]) ?? 'unreachable';
}

/**
 * Classifies a failure that belongs to the endpoint that produced it rather than
 * to the query — so another endpoint may answer the same query, but this one will
 * not, however many times it is asked. Returns undefined for everything else,
 * including an HTTP 5xx other than 501: shedding load is not refusing the call, and
 * a host that sheds is worth asking again.
 *
 * Five families qualify:
 *
 * - **Throttled.** The `rate_limited` reason the service attaches to a throttle
 *   document, and a bare HTTP 429. A 429 carrying Retry-After is excluded — the
 *   endpoint named a window, so honoring it beats writing the host off.
 * - **Rejected.** An HTTP status that the query did not cause and the framework
 *   does not retry — a 401, 403, or 404 (#86), a redirect, which is never
 *   followed (#93), the rest of the 4xx outside that retryable set, and a 501, the
 *   host not implementing what it was asked. The QL travels in the request body,
 *   so such a status describes the host: a mirror at the wrong path, retired, or
 *   blocking this client answers the same way however often it is asked, and
 *   another host may not. A 400 is excluded — the query is malformed, and every
 *   endpoint rejects it identically.
 * - **Unanswered.** The per-attempt client deadline fired: the host took the
 *   query and produced nothing inside a full attempt window. Bun's `fetch` cannot
 *   tell that from a handshake that never completed, and the decision does not
 *   need it to — a host re-asked after this gets only the budget's remainder,
 *   which cannot succeed where the whole window did not.
 * - **Unreachable.** A connection-level rejection: refused, no DNS answer, or a
 *   blackhole the OS gave up on before the deadline did.
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
function endpointFaultOf(error: unknown): EndpointFault | undefined {
  if (!(error instanceof McpError)) return;
  const data = error.data as Record<string, unknown> | undefined;
  if (data?.reason === 'rate_limited') return { detail: 'throttled', kind: 'throttled' };
  if (data?.status === 429 && data.retryAfter === undefined) {
    return { detail: 'HTTP 429', kind: 'throttled' };
  }
  if (
    typeof data?.status === 'number' &&
    (data.status < 500 || data.status === 501) &&
    data.status !== 400 &&
    !defaultIsTransient(error)
  ) {
    return { detail: `HTTP ${data.status}`, kind: 'rejected' };
  }
  if (data?.errorSource === 'OverpassClientTimeout') {
    return {
      detail: `no answer inside its ${String(data.attemptTimeoutMs)}ms attempt window`,
      kind: 'unanswered',
    };
  }
  if (data?.errorSource === 'OverpassNetworkError') {
    return {
      detail: connectionFailureDetail(connectionCode(error.cause), Number(data.elapsedMs)),
      kind: 'unavailable',
    };
  }
  if (data?.reason === 'upstream_error' && OVERPASS_INSTANCE_FAULT_PATTERN.test(error.message)) {
    return { detail: 'instance fault', kind: 'instance' };
  }
  return;
}

/**
 * The error a call ends on once every configured endpoint has faulted it or is
 * cooling down (#81), composed from what each one did rather than from whichever
 * attempt happened to fail last — `withRetry` rethrows the raw error when the
 * predicate turns it down, and the last fault is no more representative of the call
 * than the first. A cooling entry contributes its remembered outcome, marked
 * `(cooling down)`, since this call never asked it.
 *
 * A call whose faults are all of one kind that already ends on a true error keeps
 * that error untouched: an all-throttled call stays `rate_limited` down to its
 * status code, and one refused by an OSM3S dispatcher on every host stays
 * `upstream_error` carrying the remark its recovery hint tells the caller to
 * read. Composition exists for the shapes that reach the caller with no reason
 * at all, each message naming every endpoint by its {@link endpointLabel} beside
 * what it did:
 *
 * - Every endpoint refused by HTTP status (a 401, 403, 404, 501, a redirect, …):
 *   `endpoints_rejected`, not retryable — the query is fine, and the next call
 *   gets the same answers until the endpoint configuration changes. The last
 *   status alone named one host and filed an endpoint misconfiguration under a
 *   `client`-category code.
 * - Every endpoint unanswered: `endpoints_exhausted`, whose shrink-the-query
 *   recovery is right for a query no endpoint could finish.
 * - Anything else — a connection refusal, a name that does not resolve, or any
 *   mix of kinds — `endpoints_unavailable`, which sends the caller to the
 *   endpoint list rather than blaming the size of a query no host ever ran.
 *
 * Anything short of a full set (`outcomes` undefined) is left alone: the total-budget
 * guard and a deterministic failure both end calls the endpoint list cannot speak for.
 */
function terminalEndpointFailure(
  error: unknown,
  outcomes: ReadonlyArray<readonly [OverpassEndpoint, EndpointFault]> | undefined,
): unknown {
  if (!outcomes || !endpointFaultOf(error)) return error;
  const kinds = new Set(outcomes.map(([, fault]) => fault.kind));
  if (kinds.size === 1 && (kinds.has('throttled') || kinds.has('instance'))) {
    return error;
  }

  const summary = outcomes
    .map(([endpoint, fault]) => `${endpoint.label}: ${fault.detail}`)
    .join('; ');
  if (kinds.size === 1 && kinds.has('rejected')) {
    return serviceUnavailable(
      `Every configured Overpass endpoint refused this query — ${summary}.`,
      {
        errorSource: 'OverpassEndpointsRejected',
        reason: 'endpoints_rejected',
        retryable: false,
      },
      { cause: error },
    );
  }
  if (kinds.size === 1 && kinds.has('unanswered')) {
    return timeoutError(
      `No Overpass endpoint answered this query inside its attempt window — ${summary}.`,
      {
        errorSource: 'OverpassEndpointsUnanswered',
        reason: 'endpoints_exhausted',
        retryable: true,
      },
      { cause: error },
    );
  }
  return serviceUnavailable(
    `No Overpass endpoint could serve this query — ${summary}.`,
    {
      errorSource: 'OverpassEndpointsUnavailable',
      reason: 'endpoints_unavailable',
      retryable: true,
    },
    { cause: error },
  );
}

/**
 * The error a call ends on when its budget runs out before every endpoint has
 * faulted — `endpoints_exhausted` under the budget's own `errorSource`.
 * `retryable: false` because no attempt is left to retry into, on this endpoint
 * or any other. `withRetry` reports the same expiry as `Timeout` with reason
 * `retry_deadline_exceeded`; the tools declare this shape instead.
 */
function budgetSpent(budget: OverpassQueryBudget, cause?: unknown): McpError {
  return timeoutError(
    `Overpass did not answer within the ${budget.totalMs}ms budget for this call.`,
    { reason: 'endpoints_exhausted', retryable: false, errorSource: 'OverpassTotalTimeout' },
    { cause },
  );
}

/**
 * `withRetry`'s exhaustion shape — the attempt count in the message and as
 * `data.retryAttempts` — counted in submissions. The service ends the loop itself at
 * its submission cap, because one attempt can hold several submissions (the walk to
 * entries the call has not tried), and `withRetry`'s own count would report rounds.
 */
function exhaustedAfter(error: unknown, submissions: number): unknown {
  if (!(error instanceof McpError)) return error;
  return new McpError(
    error.code,
    `${error.message} (failed after ${submissions} attempts)`,
    { ...error.data, retryAttempts: submissions, operation: 'overpass.query' },
    { cause: error },
  );
}

/** A caller that left before its query reached the line: before or during the cache read. */
function abortedBeforeSubmission(): McpError {
  return requestCancelled('Overpass query was aborted before it was submitted.', {
    errorSource: 'OverpassSlotAborted',
  });
}

/** A caller that left while waiting for a slot, in the line or at an entry. */
function slotAborted(): McpError {
  return requestCancelled('Overpass query was aborted while waiting for an endpoint slot.', {
    errorSource: 'OverpassSlotAborted',
  });
}

/** One configured Overpass endpoint and its own concurrent slots (#92). */
interface OverpassEndpoint {
  /** Takes new calls: the first entry, and every later entry sized with `|N`. */
  readonly admits: boolean;
  /**
   * Calls holding or waiting for one of its slots. A pacer exposes no count, and
   * routing needs one: an entry is free while this sits below `maxConcurrent`.
   */
  inFlight: number;
  /** Its {@link endpointLabel} — how every surface that leaves the process names it. */
  readonly label: string;
  /** Its slot cap: the entry's `|N`, else `OSM_OVERPASS_MAX_CONCURRENCY`. */
  readonly maxConcurrent: number;
  /** What later calls remember of it (#81); undefined while it is in good standing. */
  record: HostRecord | undefined;
  /** Its slot line, named by `label` so no path or key reaches a metric or a shed message. */
  readonly slots: Pacer;
  /** The full configured URL — where the request goes. */
  readonly url: string;
}

/**
 * What later calls remember of an entry that failed at the connection level, or stayed
 * silent through a full attempt window the budget did not clamp (#81). A host in that
 * state costs every call that reaches it a connect timeout or an attempt window, so the
 * service, not the call, keeps the record. Every other fault describes the call rather
 * than the host — a throttle, a 5xx, a status refusal, an instance fault such as OSM3S's
 * `duplicate_query`, which is about the query's recent traffic — and stays in the call's
 * own map. Any HTTP response from the host clears the record.
 */
interface HostRecord {
  /** Remembered faults since the host last answered; each doubles the cooldown. */
  readonly consecutive: number;
  /** The outcome the composed terminal error names beside the entry, marked `(cooling down)`. */
  readonly fault: EndpointFault;
  /** Set while a call probes the lapsed host, so the calls arriving with it keep skipping it. */
  probing: boolean;
  /** When it was recorded: with every entry cooling, the one cooling longest is asked. */
  readonly recordedAt: number;
  /** When the cooldown lapses and one call may probe the host. */
  readonly until: number;
}

/**
 * Remembers a fault for later calls. One arriving while the host still cools came from the
 * same outage — a submission sent before the record existed, or the single submission a
 * call makes when every entry is cooling — and leaves the record as it is, so the cooldown
 * doubles only when the host faults again after its cooldown lapsed.
 */
function remember(endpoint: OverpassEndpoint, error: McpError): void {
  const now = Date.now();
  const previous = endpoint.record;
  if (previous && now < previous.until) return;
  const consecutive = (previous?.consecutive ?? 0) + 1;
  endpoint.record = {
    consecutive,
    fault: endpointFaultOf(error) as EndpointFault,
    recordedAt: now,
    until: now + Math.min(HOST_COOLDOWN_BASE_MS * 2 ** (consecutive - 1), HOST_COOLDOWN_MAX_MS),
    probing: false,
  };
}

/** Skipped by routing: still in its cooldown, or lapsed with another call's probe in flight. */
function isCooling(endpoint: OverpassEndpoint): boolean {
  const { record } = endpoint;
  return record !== undefined && (Date.now() < record.until || record.probing);
}

/** A cooling entry as the composed terminal error names it: its remembered outcome, marked. */
function cooledOutcome(endpoint: OverpassEndpoint): EndpointFault | undefined {
  if (!isCooling(endpoint)) return;
  const { fault } = endpoint.record as HostRecord;
  return { detail: `${fault.detail} (cooling down)`, kind: fault.kind };
}

/** Claims a lapsed host's one probe for the submission about to go to it, when one is due. */
function claimProbe(endpoint: OverpassEndpoint): HostRecord | undefined {
  const { record } = endpoint;
  if (!record || record.probing || Date.now() < record.until) return;
  record.probing = true;
  return record;
}

/** The server-wide line and every entry's slots; see {@link OverpassService.slots}. */
interface OverpassSlots {
  readonly endpoints: readonly OverpassEndpoint[];
  readonly line: Pacer;
  /** The {@link endpointScrubber} over every configured endpoint. */
  readonly scrub: (text: string) => string;
}

/**
 * One call as it moves through the line, its attempts, and every slot wait (#90).
 * The cancellation signal is carried here rather than read off a `Context`, so a
 * submission can run on a signal of its own.
 */
interface OverpassCall {
  readonly budget: OverpassQueryBudget;
  /** When the budget runs out, counted from the moment the call joined the line. */
  readonly deadlineAt: number;
  readonly query: string;
  readonly signal: AbortSignal;
  /** What is left of {@link OVERPASS_SLOT_WAIT_MS}; every slot wait draws on it. */
  waitLeftMs: number;
}

/**
 * One submission the identical in-flight calls of a tenant share (#89). It runs on a
 * signal of its own, never a caller's, so one caller leaving cannot end it for the rest.
 */
interface SharedQuery {
  /** The callers attached to it — each one's context, so the result can be cached through one. */
  readonly callers: Set<Context>;
  /** Aborted, with the last caller's own reason, when that caller leaves. */
  readonly controller: AbortController;
  /** The dispatch, then the cache write. */
  readonly settled: Promise<OverpassResult>;
}

/**
 * Runs `task` once `pacer` grants a slot, charging the wait to the call's allowance:
 * the pacer sheds the call as `pacer_shed` when what is left of it runs out first. A
 * call with nothing left still takes a slot that is free on arrival.
 *
 * A rejection before the slot is granted is restated for the call; once granted, the
 * task's own errors pass through. A caller that leaves the queue is rejected with its
 * signal's own reason, which names neither this service nor the wait. A shed's
 * `retryAfter` is sized by the pacer from its own queue, which at an entry can be the
 * last few seconds of a call that has waited the whole allowance, so it is floored at
 * that allowance; and the wait goes into the message too, since a client that reads only
 * `content[]` sees the message and the recovery hint but never error data.
 */
function waitForSlot<T>(
  pacer: Pacer,
  call: OverpassCall,
  signal: AbortSignal,
  task: (slotSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const queuedAt = Date.now();
  let granted = false;
  return pacer
    .run(
      (slotSignal) => {
        granted = true;
        call.waitLeftMs -= Date.now() - queuedAt;
        return task(slotSignal);
      },
      { signal, maxWaitMs: Math.max(0, call.waitLeftMs) },
    )
    .catch((error: unknown) => {
      if (granted) throw error;
      if (call.signal.aborted && error === call.signal.reason) throw slotAborted();
      if (!(error instanceof McpError) || error.data?.reason !== 'pacer_shed') throw error;
      const retryAfter = Math.max(Number(error.data.retryAfter), OVERPASS_SLOT_WAIT_MS / 1000);
      throw new McpError(
        error.code,
        `${error.message} Retry after ${retryAfter} seconds.`,
        { ...error.data, retryAfter },
        { cause: error },
      );
    });
}

/** Client-side time budget for one `query()` call. */
export interface OverpassQueryBudget {
  /** Ceiling on any single attempt's client deadline. */
  readonly attemptMs: number;
  /** Whole-call budget — `withRetry`'s `deadlineMs`, and the figure reported when it runs out. */
  readonly totalMs: number;
}

/**
 * Derives the client-side budget from the `[timeout:N]` the query carries, so a
 * caller asking Overpass for more time is actually waited for. Reading the QL
 * covers both routes to that directive with one mechanism: the value
 * `timeout_seconds` injects, and one a caller wrote into the query string
 * themselves, which no input validator can reach. The pattern is shared with the
 * raw tool's presence check, so a spelling that stops a second directive from
 * being injected is the same spelling that is waited out here.
 *
 * Widens only — both layers keep the flat constant as a floor. A query asking for
 * less than the flat budget still gets the flat budget, so no query that succeeds
 * under a generous client deadline today can start failing under a tighter
 * derived one. A query with no parseable directive, or one asking for more than
 * `OVERPASS_QL_TIMEOUT_MAX_SECONDS`, falls back to the flat pair.
 *
 * Exported for unit testing.
 */
export function deriveQueryBudget(query: string): OverpassQueryBudget {
  const requestedSeconds = Number(OVERPASS_QL_TIMEOUT_PATTERN.exec(query)?.[1]);
  const attemptMs =
    requestedSeconds <= OVERPASS_QL_TIMEOUT_MAX_SECONDS
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
 *
 * What it quotes is read from the body after `scrub` (#94), so neither the extraction
 * cap nor the excerpt can cut a quoted path in half before it is recognized. The extra
 * pass runs only on a body that failed to parse.
 */
function parseOverpassBody(
  text: string,
  scrub: (text: string) => string,
): OverpassResponse & { remark?: string } {
  try {
    return JSON.parse(text) as OverpassResponse & { remark?: string };
  } catch {
    const quoted = scrub(text);
    const detail = extractOverpassError(quoted);
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
      `Overpass returned a body that is not JSON: ${quoted.slice(0, OVERPASS_BODY_EXCERPT_LIMIT).trim()}`,
      { reason: 'upstream_error' },
    );
  }
}

/**
 * Names a configured Overpass endpoint everywhere it leaves the process — the
 * `servedBy` attribution and the cache entry holding it, `error.data.url`, the
 * composed terminal messages, and log lines — by its origin alone: scheme, host,
 * and port, never the path, query, fragment, or userinfo. Every keyed public
 * provider takes its API key in the path, at a depth and under a prefix of its
 * own, so the origin is the one form no configuration can defeat. The request
 * itself still goes to the full configured URL.
 *
 * Two entries on one origin — two keys for one provider, or one host serving
 * instances at different paths — would read identically, so each gains its
 * 1-based position in `endpoints`: `https://overpass.example.com (entry 2)`.
 *
 * The config schema validates every entry as a URL, so parsing cannot fail here.
 */
export function endpointLabel(endpoint: string, endpoints: readonly string[]): string {
  const { origin } = new URL(endpoint);
  const shared = endpoints.some((other) => other !== endpoint && new URL(other).origin === origin);
  return shared ? `${origin} (entry ${endpoints.indexOf(endpoint) + 1})` : origin;
}

/** What replaces a scrubbed fragment, and how a capture cut at its byte limit ends. */
const ELLIPSIS = '…';

/**
 * Builds the scrub for text the upstream wrote and the service quotes (#94): an error
 * body, the status line, a remark, a non-JSON excerpt. {@link endpointLabel} keeps the
 * path, query, and userinfo out of every name the server writes; this keeps them out of
 * what it repeats, since a keyed endpoint can quote its own request path back. Every
 * occurrence of any configured endpoint's path, query (without the `?`), username, or
 * password — verbatim, as the URL parser normalizes it — becomes `…`, longest first so a
 * whole path goes before a shorter fragment inside it. The rest of the text is kept.
 *
 * A bare `/` path is no secret and would match every slash, so it is skipped. A capture
 * cut at its byte limit ends in `…`, and the cut can fall inside an occurrence, so a stub
 * of two or more characters that opens a fragment and runs into that mark goes too.
 *
 * Exported for unit testing.
 */
export function endpointScrubber(urls: readonly string[]): (text: string) => string {
  const fragments = [
    ...new Set(
      urls.flatMap((url) => {
        const { pathname, search, username, password } = new URL(url);
        return [pathname === '/' ? '' : pathname, search.slice(1), username, password];
      }),
    ),
  ]
    .filter((fragment) => fragment.length > 0)
    .sort((a, b) => b.length - a.length);

  return (text) => {
    const scrubbed = fragments.reduce((out, fragment) => out.replaceAll(fragment, ELLIPSIS), text);
    if (!scrubbed.endsWith(ELLIPSIS)) return scrubbed;
    const head = scrubbed.slice(0, -ELLIPSIS.length);
    let stub = 0;
    for (const fragment of fragments) {
      for (let length = fragment.length - 1; length > Math.max(stub, 1); length--) {
        if (head.endsWith(fragment.slice(0, length))) {
          stub = length;
          break;
        }
      }
    }
    return stub > 0 ? `${head.slice(0, -stub)}${ELLIPSIS}` : scrubbed;
  };
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
  /** The line and every entry's slots; see {@link OverpassService.slots}. */
  private slotState: OverpassSlots | undefined;

  /** Submissions identical in-flight calls share (#89), keyed by tenant and cache key. */
  private readonly sharedQueries = new Map<string, SharedQuery>();

  // config and storage reserved for future use (private instance auth, custom storage)
  constructor(_config: AppConfig, _storage: StorageService) {}

  /** Rejects any caller still waiting in the line or for an endpoint's slot. */
  dispose(): void {
    if (!this.slotState) return;
    this.slotState.line.dispose();
    for (const endpoint of this.slotState.endpoints) endpoint.slots.dispose();
  }

  /**
   * The ordered endpoints, the two levels of slots a call passes through, and the scrub
   * for upstream text that quotes an endpoint's own URL (#94).
   *
   * `OSM_OVERPASS_BASE_URL` pins a single endpoint and so disables rotation outright
   * — a private or self-hosted instance is not interchangeable with a public mirror,
   * and an operator who named one endpoint did not ask for their queries to be sent
   * anywhere else. `OSM_OVERPASS_MAX_CONCURRENCY` sizes the pin.
   *
   * **Entry slots (#92).** Each endpoint has its own FIFO line, capped at its `|N` or
   * `OSM_OVERPASS_MAX_CONCURRENCY`, which holds submissions past that cap locally
   * rather than piling them onto the endpoint. This bounds what the server sends to
   * each host at once; it does not make 429 impossible, since Overpass keeps a slot
   * reserved for the full `[timeout:N]` after answering. A concurrency cap rather
   * than the start gap Nominatim paces by: the Overpass constraint is how many
   * queries are *in flight*, and one query can hold its slot for the full
   * `[timeout:N]` (up to 180s on the raw tool).
   *
   * **The line (#90).** One server-wide FIFO a call joins once and holds for its
   * whole life. It admits the first entry's slots plus every later `|N` entry's: an
   * unsuffixed later entry adds no admission, so it serves only as failover and an
   * existing list keeps the load it always had. Each admitted call holds at most one
   * entry slot at a time, so an admitted call always finds a free slot on some entry
   * that takes new calls.
   *
   * Built on first use, from the server configuration `setup()` already parsed and
   * validated at startup.
   */
  private slots(): OverpassSlots {
    if (this.slotState) return this.slotState;
    const config = getServerConfig();
    const configured: ServerConfig['overpassEndpoints'] = config.overpassBaseUrl
      ? [{ url: config.overpassBaseUrl }]
      : config.overpassEndpoints;
    const urls = configured.map((entry) => entry.url);
    const endpoints = configured.map(({ url, maxConcurrent: sized }, index) => {
      const label = endpointLabel(url, urls);
      const maxConcurrent = sized ?? config.overpassMaxConcurrency;
      return {
        url,
        label,
        admits: index === 0 || sized !== undefined,
        maxConcurrent,
        slots: createPacer({ name: label, maxConcurrent }),
        inFlight: 0,
        record: undefined,
      };
    });
    const admitted = endpoints.reduce(
      (sum, endpoint) => (endpoint.admits ? sum + endpoint.maxConcurrent : sum),
      0,
    );
    this.slotState = {
      line: createPacer({ name: 'overpass', maxConcurrent: admitted }),
      endpoints,
      scrub: endpointScrubber(urls),
    };
    return this.slotState;
  }

  private buildCacheKey(query: string): string {
    const hash = createHash('sha256').update(query).digest('hex').slice(0, 16);
    return `overpass/${hash}`;
  }

  /**
   * The union block every convenience query ends in: one line per element type carrying
   * the same AND tag chain and the same spatial filter, then `out center tags;`.
   *
   * Shared so the three spatial filters — around, bbox, and area — differ in exactly the
   * one clause that distinguishes them, and a change to the tag chain or the output
   * verbosity cannot reach one builder without reaching all three.
   */
  private matchBlock(params: OverpassQueryParams, spatialFilter: string): string[] {
    const tagFilter = [params, ...(params.filters ?? [])]
      .map(({ tagKey, tagValue }) =>
        tagValue === undefined ? `["${tagKey}"]` : `["${tagKey}"="${tagValue}"]`,
      )
      .join('');
    return [
      `[out:json][timeout:${params.timeoutSeconds}];`,
      '(',
      ...params.elementTypes.map((t) => `  ${t}${tagFilter}${spatialFilter};`),
      ');',
      'out center tags;',
    ];
  }

  /** Build an around-filter Overpass QL query. */
  buildAroundQuery(params: OverpassAroundParams): string {
    const { lat, lon, radiusMeters } = params;
    return this.matchBlock(params, `(around:${radiusMeters},${lat},${lon})`).join('\n');
  }

  /** Build a bounding-box Overpass QL query. */
  buildBboxQuery(params: OverpassBboxParams): string {
    const { south, west, north, east } = params;
    // Overpass bbox order: south,west,north,east (latitude-first)
    return this.matchBlock(params, `(${south},${west},${north},${east})`).join('\n');
  }

  /**
   * Build a boundary-area Overpass QL query: the same tag chain and output verbosity as
   * the bbox path, scoped to everything inside one OSM relation or closed way.
   *
   * `map_to_area` rather than `area(<computed id>)`. The relation formula is stable, but
   * the way formula (`2400000000 + id`) was removed in Overpass 0.7.57 and resolves to no
   * area on a current endpoint, so the arithmetic spelling only works for half the refs
   * this scope accepts.
   *
   * `.a out count;` is the boundary-resolution sentinel. Overpass answers a ref that maps
   * to no area with HTTP 200, an empty element list, and no `remark` — byte-identical to a
   * boundary that resolved and matched nothing — so without it the two cases are
   * indistinguishable and the caller gets a bare zero for a ref that never existed. The
   * count element rather than `out ids;`: a relation-derived area prints as
   * `type: 'area'`, but a way-derived one prints as `type: 'way'` carrying the underlying
   * way's own id, which a matching way can carry too. `type: 'count'` cannot collide.
   */
  buildAreaQuery(params: OverpassAreaParams): string {
    const { kind, osmId } = params.areaRef;
    const [settings, ...block] = this.matchBlock(params, '(area.a)');
    return [
      settings,
      `${kind === 'relation' ? 'rel' : 'way'}(${osmId});map_to_area->.a;`,
      '.a out count;',
      ...block,
    ].join('\n');
  }

  /**
   * Split a `within`-scoped response into whether the boundary resolved and the features
   * inside it, dropping the `out count;` sentinel `buildAreaQuery` asked for.
   *
   * Reads `tags.total` rather than the per-type breakdown: the set holds one area however
   * Overpass types it, and the breakdown files a relation-derived area under `areas` and a
   * way-derived one under `ways`.
   */
  readAreaScope(elements: OverpassElement[]): OverpassAreaScope {
    const sentinel = elements.find((el) => el.type === 'count');
    return {
      resolved: Number(sentinel?.tags?.total ?? 0) > 0,
      elements: elements.filter((el) => el.type !== 'count'),
    };
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
   * with `attemptSignal`, which carries both the call's cancellation and the
   * whole call's budget. `attemptTimeoutMs` is already clamped to what that budget
   * leaves, so the two clocks end the same window: whichever fires first, the
   * attempt was given `attemptTimeoutMs` and no answer. `call.signal` is the
   * cancellation alone, which is what separates the call going away from either.
   *
   * It is also where the endpoint's cross-call record is kept (#81), since only the
   * request knows whether the host answered at all. Any HTTP response, whatever its
   * status, clears the record. With no response, a connection-level failure is
   * remembered, and so is this request's own deadline firing on a window the budget
   * left whole; a window the budget clamped says little about the host.
   *
   * The request goes to the endpoint's full configured URL; every error names it
   * by its {@link endpointLabel}, and quotes what it read off the response only
   * through the {@link endpointScrubber} (#94).
   */
  private async postQuery(
    call: OverpassCall,
    endpoint: OverpassEndpoint,
    attemptTimeoutMs: number,
    attemptSignal: AbortSignal,
  ): Promise<string> {
    const serverAddress = new URL(endpoint.url).hostname;
    const { scrub } = this.slots();
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
    const signal = AbortSignal.any([controller.signal, attemptSignal]);

    const startedAt = performance.now();
    let statusCode = 0;
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': getServerConfig().nominatimUserAgent,
        },
        body: `data=${encodeURIComponent(call.query)}`,
        /**
         * Never followed. A keyed provider answers a missing or wrong key with a
         * redirect to its docs page: followed, a 301/302 turns the POST into a GET
         * whose HTML reads as a throttle, and a 307/308 re-POSTs the query to
         * whatever host `Location` names. Unfollowed, Bun and Node both hand back
         * the 3xx itself, which `httpErrorFromResponse` maps to a non-retried
         * status and `endpointFaultOf` files as the host refusing the call.
         */
        redirect: 'manual',
        signal,
      });
      statusCode = response.status;
      endpoint.record = undefined;

      if (!response.ok) {
        const upstream = await httpErrorFromResponse(response, {
          service: 'Overpass',
          bodyLimit: OVERPASS_ERROR_BODY_LIMIT,
          // A 425 is the endpoint not taking the query yet, as a 503 is (#95); the
          // framework files it under Timeout beside 408 and 504.
          codeOverride: (status) =>
            status === 425 ? JsonRpcErrorCode.ServiceUnavailable : undefined,
        });
        // Everything it read off the response — the status line in the message, the
        // body, Retry-After — is scrubbed before anything quotes it (#94); the request
        // metadata the server writes itself goes on after.
        throw new McpError(upstream.code, scrub(upstream.message), {
          ...Object.fromEntries(
            Object.entries(upstream.data ?? {}).map(([key, value]) => [
              key,
              typeof value === 'string' ? scrub(value) : value,
            ]),
          ),
          url: endpoint.label,
          operation: 'overpass.query',
          errorSource: 'OverpassHttpError',
        });
      }

      return await response.text();
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (controller.signal.reason !== deadlineReason && call.signal.aborted) {
        throw requestCancelled('Overpass query was aborted by the caller.', {
          errorSource: 'OverpassAborted',
        });
      }
      if (signal.aborted) {
        // The window carries into error data as well as the message: it is what
        // the composed terminal error quotes per endpoint, and the clamp can put
        // it below the ceiling this call derived.
        const unanswered = timeoutError(
          `Overpass query exceeded the ${attemptTimeoutMs}ms client deadline.`,
          { attemptTimeoutMs, errorSource: 'OverpassClientTimeout' },
        );
        if (
          statusCode === 0 &&
          controller.signal.reason === deadlineReason &&
          attemptTimeoutMs === call.budget.attemptMs
        ) {
          remember(endpoint, unanswered);
        }
        throw unanswered;
      }
      /**
       * The time it took is what tells a refusal from an OS connect timeout. Node's
       * `fetch` refuses a URL carrying credentials with the whole URL in its message,
       * so the rejection is restated scrubbed, keeping the `code` and `cause` its
       * fault label is read from.
       */
      const said = error instanceof Error ? error.message : String(error);
      const quoted = scrub(said);
      const rejection =
        error instanceof Error && quoted !== said
          ? Object.assign(new Error(quoted, { cause: error.cause }), {
              name: error.name,
              code: (error as Error & { code?: unknown }).code,
            })
          : error;
      const unreachable = serviceUnavailable(
        `Network error contacting Overpass: ${quoted}`,
        {
          url: endpoint.label,
          errorSource: 'OverpassNetworkError',
          elapsedMs: Math.round(performance.now() - startedAt),
        },
        { cause: rejection },
      );
      if (statusCode === 0) remember(endpoint, unreachable);
      throw unreachable;
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

  /**
   * POST one query to one endpoint, holding that endpoint's slot for the submission
   * and waiting for it when every slot is taken.
   *
   * The wait draws on the call's slot-wait allowance, so it sheds as `pacer_shed`
   * once that is spent, and on `attemptSignal`, which carries the call's budget as
   * well as the caller's cancellation: a caller that goes away while parked leaves
   * the queue instead of waiting for a slot to reach it, and a budget that runs out
   * there ends the call without a submission.
   *
   * The window is what the budget leaves once the slot is granted, so time spent
   * queued is taken off it. That is the window the request actually gets — the figure
   * the composed terminal error quotes — and a call granted a slot with nothing left
   * is never submitted.
   *
   * `inFlight` counts the call from the moment it commits to the endpoint, waiting
   * included, so routing never sends a new call to an entry others are queued at. A
   * call committing to a lapsed remembered host holds its one probe for as long (#81),
   * so the calls arriving with it keep skipping the host until the probe settles.
   */
  private async submitQuery(
    call: OverpassCall,
    endpoint: OverpassEndpoint,
    attemptSignal: AbortSignal,
  ): Promise<OverpassResult> {
    const probe = claimProbe(endpoint);
    endpoint.inFlight++;
    try {
      return await waitForSlot(endpoint.slots, call, attemptSignal, async (signal) => {
        const remainingMs = call.deadlineAt - Date.now();
        if (remainingMs <= 0) throw budgetSpent(call.budget);
        // postQuery throws a status-classified McpError for every non-2xx, so the
        // body reaching here always came back with HTTP 2xx.
        const text = await this.postQuery(
          call,
          endpoint,
          Math.min(call.budget.attemptMs, remainingMs),
          signal,
        );
        const { scrub } = this.slots();
        const data = parseOverpassBody(text, scrub);

        // Detect runtime errors embedded in JSON response
        if (data.remark) {
          const remark = scrub(data.remark);
          if (OVERPASS_TIMEOUT_PATTERN.test(remark)) {
            throw timeoutError(`Overpass query timed out: ${remark}`, {
              reason: 'query_timeout',
            });
          }
          if (OVERPASS_OOM_PATTERN.test(remark)) {
            throw serviceUnavailable(`Overpass ran out of memory: ${remark}`, {
              reason: 'result_too_large',
            });
          }
          // Overpass reports area lookups, malformed filters, and dispatcher or
          // database outages here too, alongside an empty element list. Returning
          // that as a success hides the failure behind "no results", so surface the
          // remark verbatim — it names the fault — less any quote of an endpoint's URL.
          throw serviceUnavailable(`Overpass reported an error: ${remark}`, {
            reason: 'upstream_error',
          });
        }

        // The label rather than the URL: the value is reported to the client and
        // cached, and a configured endpoint can carry a key in its path or query.
        return { ...data, servedBy: endpoint.label };
      });
    } finally {
      endpoint.inFlight--;
      if (probe) probe.probing = false;
    }
  }

  /**
   * Run one query through the line and the endpoint list (#90, #92) — everything
   * past the cache.
   *
   * The call joins the server-wide line once and keeps its place through every
   * attempt, backoff, and failover, so a backlog is served in arrival order and a
   * retry never goes to the back. The line wait draws on the call's 30 s slot-wait
   * allowance; past it the call sheds as the framework's `pacer_shed`, and the
   * budget `withRetry` gets is what the wait left of the call's own.
   *
   * `signal` is the shared submission's own (#89), never a caller's, and the budget is
   * the one its query text derives; `ctx` is used only for logging.
   */
  private dispatch(query: string, signal: AbortSignal, ctx: Context): Promise<OverpassResult> {
    const { line, endpoints } = this.slots();
    const budget = deriveQueryBudget(query);
    const call: OverpassCall = {
      query,
      budget,
      deadlineAt: Date.now() + budget.totalMs,
      signal,
      waitLeftMs: OVERPASS_SLOT_WAIT_MS,
    };
    return waitForSlot(line, call, signal, () => this.attempts(call, endpoints, ctx));
  }

  /**
   * The attempts of one admitted call: `withRetry` over the endpoint list, advancing
   * through it so a degraded endpoint costs latency rather than the answer.
   *
   * **Routing (#92).** A call's first submission goes to the first entry that takes
   * new calls, passes the eligibility check, and has a free slot. With one that takes
   * new calls cooling (#81), its share goes to the first eligible entry with a free
   * slot, else waits at the first eligible entry. Later attempts return to the next
   * eligible entry after the one last used, wrapping, so an endpoint that shed load a
   * moment ago gets a chance to have recovered.
   *
   * **The walk (#90).** A failure the call can recover from goes straight to the next
   * eligible entry this call has not tried, inside the same attempt: no backoff, since
   * that host has not been asked yet. Only once every eligible entry has been tried
   * does the failure reach `withRetry`, whose backoff then precedes the return to an
   * entry already asked. The walk is what asks every entry once, however long the
   * list; the submission cap bounds the returns that follow, at `max(4, N)`. A call the
   * cap ends reports the last failure it retried, not an entry's own refusal.
   *
   * `isTransientOverpassError` is what keeps a deterministic failure on one endpoint:
   * it stops the call for a query every mirror would reject identically
   * (`query_timeout`, `result_too_large`, HTTP 400). It answers "should another
   * attempt be made?" with no knowledge of where it would go, which is the wrong
   * question for a host that refused, could not be reached, or took the query and
   * never answered — each a property of that host, not of the query. The fault map
   * answers the endpoint-aware question on top of it: such a host is never asked
   * again, and the call ends once every endpoint is in the map. The map records what
   * each endpoint did, so `terminalEndpointFailure` can compose the call's terminal
   * error from it. Both it and the walk state live in this closure, so concurrent
   * calls never see each other's rotation.
   *
   * **Cooling entries (#81).** An entry the service remembers as unreachable or silent
   * counts as already faulted: the call never submits to it while a live entry
   * remains, and ends once every entry is faulted or cooling. A call that finds every
   * entry cooling at its start still makes one submission, to the entry cooling
   * longest, so a single endpoint — or a recovered list — is never refused unasked.
   *
   * The serving endpoint is cached with the response, so a cache hit reports the
   * endpoint that actually produced the data rather than whichever one the current
   * call would have tried first.
   */
  private attempts(
    call: OverpassCall,
    endpoints: readonly OverpassEndpoint[],
    ctx: Context,
  ): Promise<OverpassResult> {
    /**
     * Endpoints that failed this call on their own account; never asked again,
     * and the record the terminal error is composed from.
     */
    const faults = new Map<OverpassEndpoint, EndpointFault>();
    /** Endpoints this call has submitted to: a move to any other skips the backoff. */
    const tried = new Set<OverpassEndpoint>();
    const maxSubmissions = Math.max(DEFAULT_MAX_SUBMISSIONS, endpoints.length);
    let submissions = 0;
    /** Set when the submission cap, not the failure, is what ended the call. */
    let exhausted = false;
    /** Index of the entry the last submission went to. */
    let last: number | undefined;
    /** What the last submission failed with — what the call ends on should no entry be left. */
    let lastError: unknown;
    /**
     * The last failure no endpoint fault explains — what the cap ends the call on. The
     * cap can land on an entry's own refusal while the entries that shed load stay
     * eligible, and that refusal speaks for one host, not for what the call retried.
     */
    let lastRetried: unknown;

    /** The one check routing and rotation both consult before sending this call to an entry. */
    const eligible = (endpoint: OverpassEndpoint): boolean =>
      !faults.has(endpoint) && !isCooling(endpoint);

    /**
     * What every endpoint did, in list order — this call's fault, else its remembered
     * outcome while it cools — or undefined while any endpoint is still in play.
     */
    const outcomes = (): Array<readonly [OverpassEndpoint, EndpointFault]> | undefined => {
      const settled: Array<readonly [OverpassEndpoint, EndpointFault]> = [];
      for (const endpoint of endpoints) {
        const fault = faults.get(endpoint) ?? cooledOutcome(endpoint);
        if (!fault) return;
        settled.push([endpoint, fault]);
      }
      return settled;
    };

    /** Next index after `from` in list order, wrapping onto `from` itself last, that `accept` takes. */
    const after = (from: number, accept: (endpoint: OverpassEndpoint) => boolean) => {
      for (let step = 1; step <= endpoints.length; step++) {
        const index = (from + step) % endpoints.length;
        if (accept(endpoints[index] as OverpassEndpoint)) return index;
      }
      return;
    };

    /**
     * A new call's entry: the first that takes new calls and has a free slot, else the
     * first eligible entry with a free slot, else the first eligible entry, to wait at.
     * Only a cooling entry ever leaves the first choice empty: the line admits no more
     * calls than the entries that take new calls have slots, and each call holds at most
     * one. Undefined when every entry is cooling.
     */
    const firstEntry = (): number | undefined => {
      const usable = [...endpoints.entries()].filter(([, endpoint]) => eligible(endpoint));
      const free = ([, endpoint]: (typeof usable)[number]) =>
        endpoint.inFlight < endpoint.maxConcurrent;
      return (usable.find((entry) => entry[1].admits && free(entry)) ??
        usable.find(free) ??
        usable[0])?.[0];
    };

    /**
     * With every entry cooling, the one cooling longest that no probe holds — every entry has
     * a record then. A lapsed host under probe counts as cooling and is passed over while any
     * entry is free of a probe, so only a list whose every entry is being probed, a single
     * endpoint included, sends it a second submission.
     */
    const longestCooling = (): number =>
      endpoints.reduce((best, endpoint, index) => {
        const candidate = endpoint.record as HostRecord;
        const current = (endpoints[best] as OverpassEndpoint).record as HostRecord;
        const ahead =
          candidate.probing === current.probing
            ? candidate.recordedAt < current.recordedAt
            : current.probing;
        return ahead ? index : best;
      }, 0);

    /**
     * Transient for the call while an eligible endpoint remains, never for the host that
     * just faulted it. With one endpoint configured a fault ends the call at once, which
     * is the single-endpoint behavior the throttle and remark fail-fasts established.
     */
    const transientForCall = (error: unknown): boolean =>
      (endpointFaultOf(error) !== undefined || isTransientOverpassError(error)) &&
      endpoints.some(eligible);

    const attempt = async ({ signal }: RetryAttempt): Promise<OverpassResult> => {
      const next = last === undefined ? firstEntry() : after(last, eligible);
      // An entry another call faulted during the backoff can leave none to return to.
      if (next === undefined && submissions > 0) throw lastError;
      let index = next ?? longestCooling();
      for (;;) {
        const endpoint = endpoints[index] as OverpassEndpoint;
        if (submissions > 0) {
          ctx.log.info('Overpass retry submitting to endpoint', {
            attempt: submissions + 1,
            endpoint: endpoint.label,
          });
        }
        submissions++;
        tried.add(endpoint);
        last = index;
        try {
          return await this.submitQuery(call, endpoint, signal);
        } catch (error) {
          lastError = error;
          // Recorded before anything else, so an attempt the budget cut short still
          // completes the fault set it belongs to.
          const fault = endpointFaultOf(error);
          if (fault) faults.set(endpoint, fault);
          else lastRetried = error;
          const untried =
            signal.aborted || !transientForCall(error)
              ? undefined
              : after(index, (candidate) => eligible(candidate) && !tried.has(candidate));
          if (untried === undefined) throw error;
          index = untried;
        }
      }
    };

    return withRetry(attempt, {
      operation: 'overpass.query',
      context: ctx,
      baseDelayMs: 2000,
      // An upper bound only: every attempt makes at least one submission, so the
      // predicate's cap ends the call first.
      maxRetries: maxSubmissions - 1,
      isTransient: (error) => {
        if (!transientForCall(error)) return false;
        exhausted = submissions >= maxSubmissions;
        return !exhausted;
      },
      signal: call.signal,
      deadlineMs: call.deadlineAt - Date.now(),
    }).catch((error: unknown) => {
      // A cancel that lands in the backoff comes back as the signal's own reason (#96);
      // one in a slot wait or a request is already a RequestCancelled of this service's.
      if (call.signal.aborted && error === call.signal.reason) {
        throw requestCancelled(
          'Overpass query was aborted by the caller during the retry backoff.',
          {
            errorSource: 'OverpassAborted',
          },
        );
      }
      if (exhausted) throw exhaustedAfter(lastRetried ?? error, submissions);
      if (!(error instanceof McpError && error.data?.reason === 'retry_deadline_exceeded')) {
        throw terminalEndpointFailure(error, outcomes());
      }
      /**
       * The budget ran out. An attempt it cut short was recorded as the unanswered
       * fault it is, so when that completes the set the call ends on the composed
       * error exactly as it would had the attempt's own timer fired first. Short of a
       * full set, the budget itself is what ended the call.
       */
      const settled = outcomes();
      throw settled
        ? terminalEndpointFailure(error.cause, settled)
        : budgetSpent(call.budget, error);
    });
  }

  /** Caches a result in the tenant store `ctx` writes to, unless it is past the ceiling. */
  private async cacheResult(cacheKey: string, result: OverpassResult, ctx: Context): Promise<void> {
    if (result.elements.length > CACHE_MAX_ELEMENTS) {
      ctx.log.info('Overpass result too large to cache', {
        elements: result.elements.length,
        ceiling: CACHE_MAX_ELEMENTS,
      });
      return;
    }
    await ctx.state.set(cacheKey, result, { ttl: CACHE_TTL_SECONDS });
  }

  /**
   * Starts the submission identical calls will share (#89): the dispatch, on a signal of
   * its own under the budget its query text derives, then one cache write through a
   * caller still attached — `ctx.state` rejects once its own caller has aborted, so the
   * caller that started it may no longer be able to write. A write that fails costs only
   * the cache: it is logged as a warning through the writer and every caller still gets
   * the result — unless every caller left during the write, since the last one out is
   * still waiting and must not be handed a success. The entry leaves the map once that is
   * done, so a later arrival finds either the cache or a fresh submission. A failure is
   * never cached; it reaches every caller attached when it lands.
   */
  private share(key: string, cacheKey: string, query: string, ctx: Context): SharedQuery {
    const callers = new Set<Context>();
    const controller = new AbortController();
    const settled = this.dispatch(query, controller.signal, ctx)
      .then(async (result) => {
        const writer = [...callers].find((caller) => !caller.signal.aborted);
        if (writer) {
          await this.cacheResult(cacheKey, result, writer).catch((error: unknown) => {
            if (callers.size === 0) throw error;
            writer.log.warning('Overpass result served but not cached: the cache write failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        return result;
      })
      .finally(() => {
        if (this.sharedQueries.get(key) === shared) this.sharedQueries.delete(key);
      });
    // Observed here too: every caller may have left before it settles.
    settled.catch(() => undefined);
    const shared: SharedQuery = { callers, controller, settled };
    this.sharedQueries.set(key, shared);
    return shared;
  }

  /**
   * Waits on a shared submission for one caller (#89). A caller that leaves while others
   * stay ends at once as a cancellation, and the submission runs on for them. The last
   * one out removes the entry, so the next identical call submits afresh, and aborts the
   * submission with its own reason — a lone caller's cancellation therefore ends exactly
   * as it always has: `OverpassSlotAborted` in a slot wait, `OverpassAborted` mid-request
   * or in the retry backoff.
   *
   * Listens on a signal derived from the caller's rather than on the caller's own: an
   * agent session can reuse one signal across many queries, and the derived one carries
   * the abort without leaving a listener on it per query.
   */
  private async attach(key: string, shared: SharedQuery, ctx: Context): Promise<OverpassResult> {
    const { promise: left, reject: leaveNow } = Promise.withResolvers<never>();
    const signal = AbortSignal.any([ctx.signal]);
    const leave = () => {
      shared.callers.delete(ctx);
      if (shared.callers.size > 0) {
        leaveNow(
          requestCancelled('Overpass query was aborted by the caller.', {
            errorSource: 'OverpassAborted',
          }),
        );
        return;
      }
      if (this.sharedQueries.get(key) === shared) this.sharedQueries.delete(key);
      shared.controller.abort(ctx.signal.reason);
    };
    shared.callers.add(ctx);
    signal.addEventListener('abort', leave, { once: true });
    try {
      return await Promise.race([shared.settled, left]);
    } finally {
      signal.removeEventListener('abort', leave);
      shared.callers.delete(ctx);
    }
  }

  /**
   * Serve a query from cache, else from the identical submission already in flight for
   * this tenant (#89), else from a new one through the line and the endpoint list.
   */
  private async executeQuery(query: string, ctx: Context): Promise<OverpassResult> {
    /**
     * Checked ahead of the cache read: `ctx.state` is tenant storage and honors
     * `ctx.signal`, so an already-cancelled caller would otherwise reject with a bare
     * `AbortError` naming neither this service nor the query. The code and
     * `errorSource` match what a cancellation arriving later raises, while the
     * caller waits for a slot.
     */
    if (ctx.signal.aborted) throw abortedBeforeSubmission();

    const cacheKey = this.buildCacheKey(query);
    const cached = await ctx.state.get<OverpassResult>(cacheKey);
    if (cached !== null) {
      ctx.log.debug('Overpass cache hit');
      return cached;
    }
    /**
     * Checked again once the read settles: a cancel that landed during it would otherwise
     * be seen only after the line, the slot, and `fetch` had run — synchronously, behind
     * `share()` — so the request would already be out.
     */
    if (ctx.signal.aborted) throw abortedBeforeSubmission();

    // Keyed by tenant like the cache it fronts; the cache read has already required one.
    const key = `${ctx.tenantId}/${cacheKey}`;
    const running = this.sharedQueries.get(key);
    if (running) ctx.log.debug('Overpass query joined an identical one in flight');
    return this.attach(key, running ?? this.share(key, cacheKey, query, ctx), ctx);
  }

  /** Execute a generated or raw Overpass QL query and return raw elements. */
  query(ql: string, ctx: Context): Promise<OverpassResult> {
    ctx.log.info('Overpass query', { queryLength: ql.length });
    return this.executeQuery(ql, ctx);
  }

  /**
   * Normalize Overpass elements into POI-friendly shape.
   *
   * `area` and `count` elements are dropped rather than mapped: neither is an OSM feature,
   * neither carries an `osm_type` the convenience tools advertise, and both are reachable
   * in a response — Overpass emits them for an area or counted set. Dropping them here
   * keeps the counts the tools derive from this result (`totalFound`, paging) measuring
   * features only.
   */
  normalizeElements(elements: OverpassElement[]): OverpassPoi[] {
    return elements.flatMap((el) => {
      if (el.type === 'area' || el.type === 'count') return [];
      const lat = el.type === 'node' ? el.lat : el.center?.lat;
      const lon = el.type === 'node' ? el.lon : el.center?.lon;
      const tags = el.tags ?? {};
      return [
        {
          osm_type: el.type,
          osm_id: el.id,
          ...(lat !== undefined && { lat }),
          ...(lon !== undefined && { lon }),
          ...(tags.name ? { name: tags.name } : {}),
          tags,
        },
      ];
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
