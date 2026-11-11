/**
 * @fileoverview Reads the Overpass cause out of a non-2xx response body, recognizes the
 * faults that belong to the instance rather than the query — the data it was built without
 * among them — names the declared reason a bare HTTP status maps to, and trims the captured
 * body back off the error data the tools forward.
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
 * OSM3S's words for a query that reads data the instance was built without (#123):
 * `Tried to use museum file but no museum files available on this instance.` for attic
 * data — what a `[date:]`, `[diff:]`, or `[adiff:]` setting reads — and `Tried to use meta
 * file but no meta files available on this instance.` for metadata, which `out meta` prints.
 * Both come from one branch of OSM3S's `web_query.cc`, followed by the file error's own
 * `open64:` line, so the same remark also carries {@link OVERPASS_INSTANCE_FAULT_PATTERN}
 * and is read for this first.
 */
const OVERPASS_MISSING_DATA_PATTERN = /no (museum|meta) files available on this instance/;

/**
 * What an instance's remark says it lacks for this query — `'no attic data'` or
 * `'no meta data'` — or undefined when it says neither. Another instance may hold that
 * data; this one never will, however often it is asked.
 *
 * Read against Overpass's own words or a message carrying them verbatim, as
 * {@link OVERPASS_INSTANCE_FAULT_PATTERN} is.
 */
export function missingDataOf(text: string): 'no attic data' | 'no meta data' | undefined {
  const match = OVERPASS_MISSING_DATA_PATTERN.exec(text);
  if (!match) return;
  return match[1] === 'museum' ? 'no attic data' : 'no meta data';
}

/**
 * Overpass error lines in a non-2xx response body. The public endpoint returns an
 * XHTML document (`<strong>Error</strong>: line 1: parse error: ...` on a 400,
 * `<strong>Error</strong>: runtime error: ...` on a 5xx); some instances return
 * the same text as plain `Error: ...` lines. A line stops at the first `<`, which an
 * escaped `<` (`&lt;`) never is.
 */
const OVERPASS_ERROR_PATTERN = /Error(?:<\/strong>)?:\s*([^<\n]+)/g;

/** Cap on upstream detail appended to the error message. */
const UPSTREAM_DETAIL_LIMIT = 300;

/** An XML entity or character reference: decimal digits, hex digits, or one of the five names. */
const XML_REFERENCE_PATTERN = /&(?:#(\d+)|#x([\dA-Fa-f]+)|(lt|gt|quot|apos|amp));/g;

const XML_NAMED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as const;

/** XML 1.0's `Char` production: the code points a character reference may name. */
function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/**
 * Decodes the XML entities OSM3S writes into its XHTML error document (#129): the remark
 * quotes `"ref"` as `&quot;ref&quot;`. One left-to-right pass, so the `&` an `&amp;` yields
 * is never read again — `&amp;quot;` reads `&quot;`, as if `&amp;` were decoded last. A
 * reference naming no XML character, and any other `&`, stays as written.
 */
function decodeXmlEntities(text: string): string {
  return text.replace(
    XML_REFERENCE_PATTERN,
    (reference, decimal?: string, hex?: string, name?: keyof typeof XML_NAMED_ENTITIES) => {
      if (name) return XML_NAMED_ENTITIES[name];
      const codePoint = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);
      return isXmlChar(codePoint) ? String.fromCodePoint(codePoint) : reference;
    },
  );
}

/**
 * Extracts the Overpass error from a non-2xx response body — the parse error and
 * its line number on a 400, the runtime error and dispatcher state on a 5xx. That
 * line is the only signal in the document that names the fault. Returns undefined
 * when the body carries no recognizable error text, so the caller keeps the bare
 * status message instead of appending the response document's boilerplate.
 *
 * Each line is entity-decoded before it is trimmed and the whole is cut to
 * {@link UPSTREAM_DETAIL_LIMIT}, so the detail reads as Overpass wrote it and the cut
 * counts its characters, never an entity's.
 */
export function extractOverpassError(body: unknown): string | undefined {
  if (typeof body !== 'string') return;
  const detail = [...body.matchAll(OVERPASS_ERROR_PATTERN)]
    .map((match) => match[1] && decodeXmlEntities(match[1]).trim())
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
 * A refusal that can belong to the area dispatcher alone (#113). OSM3S admits a query that reads
 * the area database (`is_in`) at two dispatchers, the base one and then the area one, and names
 * the dispatcher's shared file in a busy or throttled refusal: `/osm3s_areas`, or with the
 * version, `/osm3s_v0.7.62_areas`. A dispatcher that is not running is reported as "turned off"
 * with no file name, so that answer counts unless it names the base share — an endpoint with
 * no area database answers every `is_in` query that way.
 *
 * `detail` is {@link extractOverpassError}'s reading of the body, at most a few hundred
 * characters.
 */
export function isAreaDispatcherRefusal(detail: string): boolean {
  return (
    /\/osm3s\S*_areas Dispatcher_Client::request_read_and_idx::(?:timeout|rate_limited)/.test(
      detail,
    ) ||
    (/is turned off/i.test(detail) && !/_osm_base\b/.test(detail))
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
