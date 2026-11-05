/**
 * @fileoverview Classifies a failed Nominatim request for the tools' error contracts: the
 * cause a rejection's response body states, and a request that got no answer at all.
 * @module services/nominatim/nominatim-error
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';

/** Cap on upstream detail appended to the error message. */
const UPSTREAM_DETAIL_LIMIT = 300;

/**
 * The `errorSource` values the framework's `fetchWithTimeout` sets when Nominatim never
 * answered: `FetchNetworkErrorWrapper` when the runtime's fetch rejected (connection
 * refused, host not found, reset), `FetchTimeout` when the 30 s exchange deadline fired
 * before the headers or mid-body. `withRetry` keeps the field when it appends the attempt
 * count to the final error.
 */
const UNANSWERED_SOURCES: ReadonlySet<unknown> = new Set([
  'FetchNetworkErrorWrapper',
  'FetchTimeout',
]);

/**
 * True when a Nominatim request failed with no answer from the instance — refused,
 * unresolvable, or timed out (#120).
 *
 * Keyed on `errorSource` rather than the code, because a caller's own deadline arrives
 * with the same `Timeout` code under `FetchSignalTimeout`, and that is the caller's to
 * report. No other caller cancellation carries a source in the set: `FetchAborted`,
 * `NominatimSlotAborted`, and the bare abort reason a cancelled backoff rejects with.
 */
export function isNetworkOrTimeoutFailure(error: McpError): boolean {
  return UNANSWERED_SOURCES.has(error.data?.errorSource);
}

/**
 * Extracts the message Nominatim states when it rejects a request.
 *
 * Nominatim answers a bad parameter with JSON rather than the XHTML document
 * Overpass emits, so there is no `Error:` line to scan for — the cause is a field:
 * `{"error":{"code":400,"message":"Parameter 'layer' must be a comma-separated list
 * of: address, poi, railway, natural, manmade"}}`. The `/reverse` endpoint uses the
 * same key with a bare string value (`{"error":"Unable to geocode"}`), so both
 * shapes are read.
 *
 * Returns undefined when the body carries no recognizable error text — a proxy's
 * HTML page, an empty body, a truncated capture — so the caller keeps the bare
 * status message instead of appending boilerplate.
 */
export function extractNominatimError(body: unknown): string | undefined {
  if (typeof body !== 'string') return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }

  const error = (parsed as { error?: unknown } | null)?.error;
  const detail =
    typeof error === 'string'
      ? error
      : typeof (error as { message?: unknown } | null)?.message === 'string'
        ? (error as { message: string }).message
        : undefined;

  const trimmed = detail?.trim();
  if (!trimmed) return;
  return trimmed.length > UPSTREAM_DETAIL_LIMIT
    ? `${trimmed.slice(0, UPSTREAM_DETAIL_LIMIT)}…`
    : trimmed;
}
