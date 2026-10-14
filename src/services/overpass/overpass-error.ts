/**
 * @fileoverview Reads the Overpass cause out of a non-2xx response body, recognizes the
 * faults that belong to the instance rather than the query, names the declared reason a
 * bare HTTP status maps to, and trims the captured body back off the error data the
 * tools forward.
 * @module services/overpass/overpass-error
 */

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
 * on one endpoint while letting a genuine instance fault fail over. A query that
 * outran its own `[timeout:N]` (`Query timed out in "query" at line 1 after N
 * seconds.`) and an out-of-memory remark carry none of the three.
 *
 * Read against Overpass's own words — a remark, the `Error:` line
 * {@link extractOverpassError} reads off an error document, or a message that
 * carries one verbatim — never against a raw body.
 */
export const OVERPASS_INSTANCE_FAULT_PATTERN = /dispatcher|too busy|open64:/i;

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
 * A 504 or 408 whose Overpass `Error:` line names the instance (#104): its dispatcher
 * could not admit the query and gave up — "probably too busy" — or is turned off. OSM3S
 * sends a 504 only for those; a query outrunning its own `[timeout:N]` answers HTTP 200.
 * The query never ran, so shrinking it changes nothing, and asking that host again
 * within seconds only adds to its load. A 504 or 408 with no such line — a proxy's own
 * gateway page — is not one.
 *
 * `detail` is {@link extractOverpassError}'s reading of the body.
 */
export function isInstanceRefusal(status: unknown, detail: string | undefined): boolean {
  return (
    (status === 504 || status === 408) &&
    detail !== undefined &&
    OVERPASS_INSTANCE_FAULT_PATTERN.test(detail)
  );
}

/**
 * The declared reason the three Overpass tools give a status error the service passes
 * through without one (#38, #95, #104). A 504 or 408 is the endpoint's own clock — or a
 * proxy's — running out on the request: `overpass_gateway_timeout`. Any other 5xx, a
 * 425, or a 504 or 408 an instance refused ({@link isInstanceRefusal}) is the endpoint
 * not taking the query now: `overpass_unavailable`. Undefined for every other status,
 * which the tools leave as it is.
 *
 * Each reason's declared code is the code its statuses already carry — `Timeout` for a
 * gateway 504 or 408, `ServiceUnavailable` for the rest, a 425 included once the
 * service overrides it (#95) — so the tools restate the error through the contract and
 * a refused 504 leaves as -32000, like the 503 it means.
 */
export function overpassStatusReason(
  status: unknown,
  detail: string | undefined,
): 'overpass_gateway_timeout' | 'overpass_unavailable' | undefined {
  if (isInstanceRefusal(status, detail)) return 'overpass_unavailable';
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
