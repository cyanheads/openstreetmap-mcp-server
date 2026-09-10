/**
 * @fileoverview Reads the Nominatim cause out of a rejected request's response body.
 * @module services/nominatim/nominatim-error
 */

/** Cap on upstream detail appended to the error message. */
const UPSTREAM_DETAIL_LIMIT = 300;

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
