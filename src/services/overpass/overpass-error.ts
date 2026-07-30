/**
 * @fileoverview Reads the Overpass cause out of a non-2xx response body and trims
 * the captured body back off the error data the tools forward.
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
