/**
 * @fileoverview Reads the Overpass cause out of a non-2xx response body, names the
 * declared reason a bare HTTP status maps to, and trims the captured body back off the
 * error data the tools forward.
 * @module services/overpass/overpass-error
 */

/**
 * Overpass error lines in a non-2xx response body. The public endpoint returns an
 * XHTML document (`<strong>Error</strong>: line 1: parse error: ...` on a 400,
 * `<strong>Error</strong>: runtime error: ...` on a 5xx); some instances return
 * the same text as plain `Error: ...` lines.
 */
const OVERPASS_ERROR_PATTERN = /Error(?:<\/strong>)?:\s*([^<\n]+)/g;

/** Cap on upstream detail appended to the error message. */
const UPSTREAM_DETAIL_LIMIT = 300;

/**
 * Extracts the Overpass error from a non-2xx response body — the parse error and
 * its line number on a 400, the runtime error and dispatcher state on a 5xx. That
 * line is the only signal in the document that names the fault. Returns undefined
 * when the body carries no recognizable error text, so the caller keeps the bare
 * status message instead of appending the response document's boilerplate.
 */
export function extractOverpassError(body: unknown): string | undefined {
  if (typeof body !== 'string') return;
  const detail = [...body.matchAll(OVERPASS_ERROR_PATTERN)]
    .map((match) => match[1]?.trim())
    .filter((line): line is string => Boolean(line))
    .join(' ');
  if (!detail) return;
  return detail.length > UPSTREAM_DETAIL_LIMIT
    ? `${detail.slice(0, UPSTREAM_DETAIL_LIMIT)}…`
    : detail;
}

/**
 * The declared reason the three Overpass tools give a status error the service passes
 * through without one (#38, #95). A 504 or 408 is the endpoint's own clock running out
 * on the request — `overpass_gateway_timeout`. Any other 5xx, or a 425, is the endpoint
 * not taking the query now — `overpass_unavailable`. Undefined for every other status,
 * which the tools leave as it is.
 */
export function overpassStatusReason(
  status: unknown,
): 'overpass_gateway_timeout' | 'overpass_unavailable' | undefined {
  if (status === 504 || status === 408) return 'overpass_gateway_timeout';
  if (status === 425 || (typeof status === 'number' && status >= 500)) {
    return 'overpass_unavailable';
  }
  return;
}

/**
 * Upstream error data without the captured response body. The service captures up
 * to 4000 characters so the `Error:` lines survive extraction, but that capture is
 * a server-side working buffer: once the cause is in the message, forwarding it
 * would put the same document on the wire twice, under `body` and the legacy
 * `responseBody` alias. Status, statusText, retryAfter, and the request metadata
 * are kept.
 */
export function withoutCapturedBody(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!data) return {};
  const { body: _body, responseBody: _responseBody, ...rest } = data;
  return rest;
}
