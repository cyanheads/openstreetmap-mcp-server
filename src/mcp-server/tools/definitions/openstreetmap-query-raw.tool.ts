/**
 * @fileoverview Raw Overpass QL query tool — escape hatch for advanced spatial queries.
 * @module mcp-server/tools/definitions/openstreetmap-query-raw.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline as escapeMarkdownText } from '@cyanheads/mcp-ts-core/utils';
import {
  extractOverpassError,
  overpassStatusReason,
  withoutCapturedBody,
} from '@/services/overpass/overpass-error.js';
import {
  OVERPASS_QL_DEFAULT_MAXSIZE_BYTES,
  OVERPASS_QL_MAXSIZE_PATTERN,
  OVERPASS_QL_OUT_JSON_PATTERN,
  OVERPASS_QL_TIMEOUT_PATTERN,
} from '@/services/overpass/overpass-ql.js';
import { getOverpassService } from '@/services/overpass/overpass-service.js';
import { clampLimit, LIMIT_SCHEMA_MAX, limitNoticeField } from './openstreetmap-limit.js';
import { escapeMarkdownValue } from './openstreetmap-markdown-escape.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

/**
 * Default per-element serialized-byte budget. Sized from measurement: an Overpass
 * member or geometry vertex serializes at roughly 50 bytes, so this clears an
 * ordinary way or small relation (a few hundred entries) and catches the ones —
 * a 1,714-member boundary relation, a thousand-vertex coastline — that scale a
 * single element past a client context window on both result surfaces.
 */
export const DEFAULT_MAX_ELEMENT_BYTES = 20_000;

/** Elements served per page; a larger limit is clamped to it. */
const MAX_PAGE = 500;

/**
 * Element keys whose arrays scale with membership or vertex count. Overpass QL has
 * no construct that slices one of them — the verbosity directives are all-or-
 * nothing per array (`out ids;` drops it, `out skel;` and above return it whole) —
 * so the bound has to be applied server-side.
 */
const HEAVY_ELEMENT_KEYS = ['members', 'nodes', 'geometry'] as const;

const encoder = new TextEncoder();

/**
 * Serialized size of a value in UTF-8 bytes — what the value costs on the wire.
 * `String.length` counts UTF-16 code units, which under-reports every non-ASCII
 * character in an OSM name, tag or member role by a factor of two or three.
 */
function serializedBytesOf(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/** One heavy key withheld from an element, disclosed identically on both surfaces. */
interface WithheldKey {
  item_count: number;
  key: string;
  serialized_bytes: number;
}

/** An element that lost heavy keys, plus the arguments that fetch it back whole. */
interface WithheldElement {
  id: number;
  keys: string[];
  maxElementBytes: number;
  offset: number;
  type: string;
}

/**
 * Withholds an element's heavy arrays — largest first, and only as many as it
 * takes to fit — when the element's own serialized size exceeds `budget`.
 *
 * Nothing is truncated to a prefix and no other key is touched, so what comes back
 * is either the element exactly as Overpass sent it or that element minus whole
 * arrays it names under `withheld_keys`. An over-budget element carrying no heavy
 * key is returned untouched: the bound addresses the nested-array dimension, and
 * dropping anything else would lose data the caller asked for by name.
 */
function boundElement(
  element: Record<string, unknown>,
  budget: number,
): { element: Record<string, unknown>; withheld: WithheldKey[]; serializedBytes: number } {
  const serializedBytes = serializedBytesOf(element);
  if (serializedBytes <= budget) return { element, withheld: [], serializedBytes };

  const candidates: WithheldKey[] = HEAVY_ELEMENT_KEYS.filter((key) => Array.isArray(element[key]))
    .map((key) => {
      const items = element[key] as unknown[];
      return { key, item_count: items.length, serialized_bytes: serializedBytesOf(items) };
    })
    .sort((a, b) => b.serialized_bytes - a.serialized_bytes);

  const kept: Record<string, unknown> = { ...element };
  const withheld: WithheldKey[] = [];
  // Re-measured after each drop, so a way whose `geometry` alone put it over
  // budget keeps its `nodes`. The disclosure's own bytes are not counted back in —
  // a fixed ~60 per key against a budget of at least 1000.
  for (const candidate of candidates) {
    if (serializedBytesOf(kept) <= budget) break;
    delete kept[candidate.key];
    withheld.push(candidate);
  }
  if (withheld.length === 0) return { element, withheld: [], serializedBytes };
  return { element: { ...kept, withheld_keys: withheld }, withheld, serializedBytes };
}

/** `, and N more under withheldElements` for whatever a clause could not name. */
function andMore(total: number, shown: number): string {
  const remaining = total - shown;
  return remaining > 0 ? `, and ${remaining} more under withheldElements` : '';
}

/**
 * Builds the guidance for the withheld elements on a page: a recipe executable verbatim
 * for each — the same query, `limit: 1`, that element's absolute offset, and the
 * smallest budget that returns it whole. `max_element_bytes` has no ceiling (#105), so
 * every withheld element has one.
 */
function buildWithheldNotice(entries: WithheldElement[], budget: number): string {
  const single = entries.length === 1;
  const shown = entries.slice(0, 3);
  const recipes = shown
    .map((w) => `${w.type} ${w.id}: offset ${w.offset}, max_element_bytes ${w.maxElementBytes}`)
    .join('; ');
  return (
    `${entries.length} element${single ? '' : 's'} on this page exceeded max_element_bytes (${budget}). ` +
    `${single ? 'Its' : 'Their'} members, nodes and geometry arrays were withheld whole — never truncated to a prefix — and are unchanged upstream. ` +
    'Retrieve one whole by re-calling this tool with the same query plus limit: 1 and that element’s offset and max_element_bytes: ' +
    `${recipes}${andMore(entries.length, shown.length)}.`
  );
}

export const openstreetmapQueryRaw = tool('openstreetmap_query_raw', {
  title: 'Execute a raw Overpass QL query',
  description:
    'Run an arbitrary Overpass QL query for anything the convenience tools cannot express: multi-type or union queries, relation membership, historical queries, regex tag matching. The query must include [out:json], e.g. "[out:json][timeout:15];node[\\"natural\\"=\\"peak\\"](47.5,-122.5,47.7,-122.2);out body;"; scope to an OSM boundary with rel(<id>);map_to_area->.a; or way(<id>);map_to_area->.a; then (area.a) on each statement (the 2400000000 way-area offset is gone since Overpass 0.7.57; openstreetmap_query_bbox takes the same scope as within, without QL). The response is one page: page with limit and offset, read totalFound and truncated for the whole match, and an element over max_element_bytes arrives with its members, nodes or geometry array withheld whole and withheldNotice saying how to fetch it back. For plain "near X" or "in this area" questions use openstreetmap_query_nearby or openstreetmap_query_bbox.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .describe(
        `Overpass QL query string. Must include [out:json]. The server sets the endpoint and User-Agent; do not include those. With no [maxsize:N] it adds [maxsize:${OVERPASS_QL_DEFAULT_MAXSIZE_BYTES}] (256 MiB), which a busy endpoint admits sooner than its 512 MiB default; write your own to change it. Example: "[out:json][timeout:15];node[\\"natural\\"=\\"peak\\"](47.5,-122.5,47.7,-122.2);out body;"`,
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMIT_SCHEMA_MAX)
      .default(20)
      .describe(
        `Maximum elements to return, up to ${MAX_PAGE} per call; a larger value is served as ${MAX_PAGE} and limitNotice says so. Applied after the Overpass query — if the query matched more, they are truncated.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Elements to skip before applying limit, for paging a large result set. The full match set is cached ~10 minutes keyed by the query, so re-paging at a new offset is deterministic and costs no extra request; a result over 100000 elements is served uncached, so paging that far re-queries and depends on the endpoint returning the same order. Pass the nextOffset from a prior truncated response.',
      ),
    max_element_bytes: z
      .number()
      .int()
      .min(1_000)
      .default(DEFAULT_MAX_ELEMENT_BYTES)
      .describe(
        'Serialized-byte budget for one element, in UTF-8 bytes, applied per element after limit and offset — the dimension limit cannot bound, a single relation or geometry-heavy way. An over-budget element keeps every scalar and its tags but has its members, nodes and geometry arrays withheld whole, never truncated to a prefix, and lists each under withheld_keys with its item count and byte size; withheldElements and withheldNotice then give the offset and raised budget that fetch it back whole in one more call. That disclosure is not counted against the budget, so a bounded element runs ~60 bytes per withheld key above it.',
      ),
    timeout_seconds: z
      .number()
      .int()
      .min(5)
      .max(180)
      .default(30)
      .describe(
        'How long Overpass may spend on the query. A [timeout:N] directive in the query string wins over this. The client waits the full value rather than cutting a long query off early, but the endpoint enforces its own budget and may answer HTTP 504 first.',
      ),
  }),

  output: z.object({
    elements: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Raw Overpass elements for this page, up to the limit. Shape varies by type: nodes carry lat/lon, ways nodes[], relations members[]. An element over max_element_bytes swaps those heavy arrays for withheld_keys, each naming the key, its item count, and its byte size.',
      ),
    total_elements: z
      .number()
      .describe(
        'Number of elements returned on this page. See totalFound for the full match count.',
      ),
    data_timestamp: z
      .string()
      .optional()
      .describe(
        'OSM data freshness timestamp from the Overpass response. Absent when the endpoint reported no freshness metadata.',
      ),
    attribution: z
      .string()
      .describe('Required data attribution: Data © OpenStreetMap contributors, ODbL 1.0.'),
  }),

  // Agent-facing context: the effective query sent and empty-result guidance.
  // Reaches both structuredContent and content[] without a format() entry.
  enrichment: {
    effectiveQuery: z
      .string()
      .describe(
        'The Overpass QL string as sent to the API (after any timeout or maxsize injection).',
      ),
    totalFound: z.number().describe('Total elements returned by Overpass before limit truncation.'),
    truncated: z
      .boolean()
      .describe(
        'True if elements were cut at the limit. Narrow the query, or page with offset to retrieve the rest.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call to retrieve the following page of elements. Present only when more elements remain beyond this page.',
      ),
    servingEndpoint: z
      .string()
      .optional()
      .describe(
        'Overpass endpoint that answered, named by origin alone (scheme, host, port), with "(entry N)" added when two configured endpoints share an origin. May name a failover mirror, or the endpoint that originally served a cached response. Read with data_timestamp when a result looks slow, sparse, or stale.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Why this page is empty and what to try: nothing matched (check the query syntax or broaden the filter), or offset ran past the end (retry lower). Absent when results were returned.',
      ),
    withheldElements: z
      .array(
        z.object({
          type: z.string().describe('OSM element type of the bounded element.'),
          id: z.number().describe('OSM id of the bounded element.'),
          keys: z
            .array(z.string())
            .describe('Keys withheld whole from this element: members, nodes, or geometry.'),
          offset: z
            .number()
            .describe(
              'Absolute offset of this element in the full match set. Pass it with limit 1 to fetch this element alone.',
            ),
          maxElementBytes: z
            .number()
            .describe(
              'Serialized UTF-8 byte size of this element whole, which is the smallest max_element_bytes that returns it. Pass it on the retrieval call.',
            ),
        }),
      )
      .optional()
      .describe(
        'Elements on this page that exceeded max_element_bytes, each with the arguments that fetch it back whole. Absent when every element fit.',
      ),
    withheldNotice: z
      .string()
      .optional()
      .describe(
        'How to retrieve the withheld arrays, one element per call. Absent when every element fit.',
      ),
    limitNotice: limitNoticeField,
  },

  enrichmentTrailer: {
    effectiveQuery: { label: 'Effective Query' },
    totalFound: { label: 'Total Found' },
    truncated: { label: 'Results Truncated' },
    nextOffset: { label: 'Next Offset' },
    servingEndpoint: { label: 'Served By' },
    withheldNotice: { label: 'Retrieving Withheld Data' },
    limitNotice: { label: 'Limit Clamped' },
    // Without a renderer the trailer JSON-blobs the array, which is both unreadable
    // and unescaped Markdown on the one surface this list exists to serve. The
    // renderer supplies its own prefix, so no label is set alongside it.
    withheldElements: {
      render: (value) =>
        `**Withheld Elements:** ${(value as WithheldElement[])
          .map(
            (w) =>
              `${escapeMarkdownText(w.type)} ${w.id} (${w.keys.join(', ')}) — offset ${w.offset}, max_element_bytes ${w.maxElementBytes}`,
          )
          .join('; ')}`,
    },
  },

  errors: [
    {
      reason: 'query_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Overpass returned HTTP 400 — malformed query syntax.',
      recovery:
        'Fix the fault the message names — a missing [out:json], or the parse error Overpass reported with its line and character — and resend; the identical query is refused identically.',
    },
    {
      reason: 'query_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The query exceeded its timeout.',
      retryable: false,
      recovery:
        'Add [timeout:N] to the query string with a higher value, or simplify the query (smaller bbox, fewer element types, more specific tags).',
      thrownBy: 'service',
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "Overpass ran out of memory on this query, or its response passed the server's 64 MiB read ceiling.",
      recovery:
        "Narrow the query scope: reduce the bbox or around radius, add more tag filters, or limit element types. Past the read ceiling, also print less per element (out tags or out center rather than out geom or out body). Only when Overpass ran out of memory, raise [maxsize:N] in the query instead, up to 536870912 (Overpass's own default); a busy endpoint is slower to admit a larger value and may refuse it as busy.",
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every configured endpoint refused the query as throttled — HTTP 429, or a throttle document in place of JSON.',
      retryable: true,
      recovery:
        'Every configured Overpass endpoint refused this query as throttled. Wait at least 30 seconds before retrying, longer when the error carries a retryAfter asking for more, and make fewer Overpass calls at once. For sustained load, pin a private Overpass instance via OSM_OVERPASS_BASE_URL.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass reported a runtime error that is neither a timeout nor memory exhaustion.',
      recovery:
        'Read the Overpass remark carried verbatim in the message: it names the fault. Retry in a minute when it points at the dispatcher or database being unavailable; otherwise fix the query it describes.',
      thrownBy: 'service',
    },
    {
      reason: 'overpass_gateway_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: "Overpass answered HTTP 504 or 408 with no busy-dispatcher remark — the query exceeded the endpoint's own time budget, not the [timeout:N] directive.",
      retryable: true,
      recovery:
        'Shrink the work per query: narrow the bbox or around radius, add more tag filters, or split the query into parts, then retry. The endpoint budget is fixed, so raising [timeout:N] alone will not clear a 504 or 408.',
    },
    {
      reason: 'overpass_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass answered an HTTP 5xx other than 501 and 504, a 425, or a 504 or 408 whose remark says its dispatcher is too busy or turned off — the endpoint is down, restarting, shedding load, or not taking the query yet.',
      retryable: true,
      recovery:
        'The query is fine; the endpoint is not. Wait about 30 seconds and retry unchanged. If it keeps failing, pin a mirror or private instance via OSM_OVERPASS_BASE_URL.',
    },
    {
      reason: 'endpoints_exhausted',
      code: JsonRpcErrorCode.Timeout,
      when: 'No endpoint answered within its attempt window, or the total time budget ran out first.',
      retryable: true,
      recovery:
        'Shrink the work per query: narrow the bbox or around radius, add more tag filters, or split the query into parts, then retry — the message names each endpoint and the window it was given, and every one was too slow for a query this size. Raising [timeout:N] widens each window. Listing a healthy mirror in OSM_OVERPASS_ENDPOINTS gives the retry a second server to reach.',
      thrownBy: 'service',
    },
    {
      reason: 'endpoints_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No configured endpoint would serve the call — connections refused, DNS failures, HTTP refusals such as 401/403/404, throttling, or instance faults, in some mix.',
      retryable: true,
      recovery:
        'The query is fine; no endpoint would serve it. Read the per-endpoint outcomes in the message: a host that refused the connection, failed to resolve, or answered 401/403/404 belongs out of OSM_OVERPASS_ENDPOINTS, while a throttle or instance fault usually clears within a minute. An outcome marked (cooling down) is one an earlier call met; that host is skipped until its cooldown of 30 seconds to 10 minutes lapses. Adding a healthy mirror, or pinning a private instance via OSM_OVERPASS_BASE_URL, gives the retry somewhere else to reach.',
      thrownBy: 'service',
    },
    {
      reason: 'endpoints_rejected',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every configured endpoint refused the call by HTTP status: a 401, 403, 404, or 501, a redirect, or another non-retried status below 500 other than 400 and 429.',
      retryable: false,
      recovery:
        'The query is fine, but every configured Overpass endpoint refused this server, so a retry gets the same answer. Read the status beside each endpoint in the message: a 404 usually means a wrong path in OSM_OVERPASS_BASE_URL or OSM_OVERPASS_ENDPOINTS, whose instance paths normally end in /interpreter; a 401, a 403, or a redirect (3xx) means a missing or invalid API key, or a block on this server. Fix or replace those endpoints, or add a working mirror to OSM_OVERPASS_ENDPOINTS.',
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The query waited 30 seconds in total for an Overpass slot while other calls held every slot it could take.',
      retryable: true,
      recovery:
        'Other calls held every Overpass slot this query could take for its whole 30-second wait. Wait the retryAfter seconds the error names, then call again unchanged; fewer Overpass calls at once avoid the wait.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    let ql = input.query.trim();

    /**
     * Preflight: require the output directive before calling the service. Without
     * it Overpass returns XML, JSON.parse throws, and the error surfaces as
     * InternalError. Matched with Overpass's own spacing and case tolerance, so a
     * valid `[out: json]` is not refused here.
     */
    const outJson = OVERPASS_QL_OUT_JSON_PATTERN.exec(ql);
    if (!outJson) {
      throw ctx.fail(
        'query_error',
        'Query is missing [out:json]. Add [out:json] at the start of the settings block (e.g. "[out:json][timeout:30];..."). Whitespace inside the brackets is fine; the keywords are lowercase.',
      );
    }

    /**
     * Inject the timeout unless the caller already wrote one, honoring the
     * precedence `timeout_seconds` advertises; anchored on the directive the
     * preflight matched rather than a literal, so it lands inside the settings
     * block whatever spacing the caller used. The 256 MiB maxsize (#106) goes at
     * the head of the query instead: Overpass applies the last maxsize it parses,
     * so a caller directive the presence check misses (a comment inside its
     * brackets) still comes later and wins.
     */
    if (!OVERPASS_QL_TIMEOUT_PATTERN.test(ql)) {
      ql = ql.replace(outJson[0], `${outJson[0]}[timeout:${input.timeout_seconds}]`);
    }
    if (!OVERPASS_QL_MAXSIZE_PATTERN.test(ql)) {
      ql = `[maxsize:${OVERPASS_QL_DEFAULT_MAXSIZE_BYTES}]${ql}`;
    }

    ctx.log.info('Overpass raw query', { queryLength: ql.length });

    const service = getOverpassService();
    const response = await service.query(ql, ctx).catch((err) => {
      if (err instanceof McpError) {
        const data = err.data as Record<string, unknown> | undefined;
        const reason = data?.reason as string | undefined;
        if (!reason) {
          // HTTP status errors arrive without a reason — remap by status.
          const status = data?.status;
          if (status === 400) {
            const detail = extractOverpassError(data?.body);
            const message = detail
              ? `${err.message} Overpass rejected the query: ${detail}`
              : err.message;
            throw ctx.fail('query_error', message);
          }
          /**
           * The status fields ride along: a 429 whose Retry-After outlasts the retry ceiling
           * ends the call at once, and its `retryAfter` is the wait the hint defers to.
           */
          if (status === 429) {
            throw ctx.fail('rate_limited', err.message, withoutCapturedBody(data), { cause: err });
          }
          /**
           * Overpass states the cause in the 5xx body too ("runtime error: … The server
           * is probably too busy to handle your request."), in the same shape as a 400.
           * It decides the reason — a 504 a busy dispatcher sent is not a slow query
           * (#104) — and the status fields ride along, so a caller still reads
           * `data.status`.
           */
          const detail = extractOverpassError(data?.body);
          const remapped = overpassStatusReason(status, detail);
          if (remapped) {
            throw ctx.fail(
              remapped,
              detail ? `${err.message} Overpass reported: ${detail}` : err.message,
              withoutCapturedBody(data),
              { cause: err },
            );
          }
        } else if (
          reason === 'query_error' ||
          reason === 'query_timeout' ||
          reason === 'result_too_large' ||
          reason === 'rate_limited' ||
          reason === 'upstream_error' ||
          reason === 'endpoints_exhausted' ||
          reason === 'endpoints_unavailable' ||
          reason === 'endpoints_rejected'
        ) {
          throw ctx.fail(reason, err.message);
        }
      }
      throw err;
    });

    const allElements = response.elements as Record<string, unknown>[];
    const { limit, limitNotice } = clampLimit(input.limit, MAX_PAGE);
    const limited = allElements.slice(input.offset, input.offset + limit);
    const truncated = allElements.length > input.offset + limit;

    // #60: limit/offset bound how many elements come back; this bounds how large
    // each one may be, which is the dimension a single relation or geometry-heavy
    // way blows through on its own.
    const bounded = limited.map((element) => boundElement(element, input.max_element_bytes));
    const elements = bounded.map((b) => b.element);
    const withheldElements: WithheldElement[] = [];
    bounded.forEach((b, index) => {
      if (b.withheld.length === 0) return;
      const source = limited[index] as Record<string, unknown>;
      withheldElements.push({
        type: String(source.type ?? 'unknown'),
        id: Number(source.id),
        keys: b.withheld.map((w) => w.key),
        offset: input.offset + index,
        maxElementBytes: b.serializedBytes,
      });
    });

    const dataTimestamp = response.osm3s?.timestamp_osm_base;

    ctx.log.info('Overpass raw results', {
      total: allElements.length,
      returned: elements.length,
      withheld: withheldElements.length,
    });

    ctx.enrich({
      effectiveQuery: ql,
      totalFound: allElements.length,
      truncated,
      ...(response.servedBy ? { servingEndpoint: response.servedBy } : {}),
      ...(limitNotice ? { limitNotice } : {}),
    });
    if (truncated) {
      ctx.enrich({ nextOffset: input.offset + limited.length });
    }
    if (withheldElements.length > 0) {
      ctx.enrich({
        withheldElements,
        withheldNotice: buildWithheldNotice(withheldElements, input.max_element_bytes),
      });
    }
    if (limited.length === 0) {
      const total = allElements.length;
      if (total === 0) {
        ctx.enrich.notice(
          'No elements returned. Verify query syntax, check the bbox or around filter bounds, and test at overpass-turbo.eu.',
        );
      } else {
        // An empty page with matches upstream means the offset ran past the last
        // page — a paging mistake. Sending the caller to fix their syntax would
        // point them at a query that already worked.
        //
        // #70: the last-page offset is `total - limit`, which floors to 0 once
        // the whole match set fits in one page — offering offset 0 twice as if
        // the two were alternatives. There is only one page to go back to.
        const retry =
          total <= limit
            ? `, which fit in one page of ${limit}. Retry with offset 0.`
            : `. Retry with offset ${total - limit} for the last page, or offset 0 for the first.`;
        ctx.enrich.notice(
          `Offset ${input.offset} is past the end of the result set: the query matched ${total} element${total === 1 ? '' : 's'}${retry}`,
        );
      }
    }

    return {
      elements,
      total_elements: elements.length,
      ...(dataTimestamp ? { data_timestamp: dataTimestamp } : {}),
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.total_elements} element${result.total_elements === 1 ? '' : 's'} returned**`,
    ];
    if (result.data_timestamp) {
      lines.push(`**Data as of:** ${result.data_timestamp}`);
    }
    lines.push('');
    // Keys consumed by the pretty-printed lines above; every other element key
    // is rendered generically below so content[] never drops data.
    const RENDERED_KEYS = new Set(['type', 'id', 'lat', 'lon', 'tags', 'withheld_keys']);
    for (const el of result.elements) {
      const type = String(el.type ?? 'unknown');
      const id = String(el.id ?? '?');
      const tags = el.tags as Record<string, string> | undefined;
      const name = tags?.name;
      const suffix = name ? ` — ${escapeMarkdownText(name)}` : '';
      lines.push(`**${escapeMarkdownText(type)}** ${id}${suffix}`);
      if (el.lat !== undefined && el.lon !== undefined) {
        lines.push(`  Coordinates: ${String(el.lat)}, ${String(el.lon)}`);
      }
      if (tags && Object.keys(tags).length > 0) {
        const tagStr = Object.entries(tags)
          .map(([k, v]) => `${escapeMarkdownText(k)}=${escapeMarkdownText(v)}`)
          .join(', ');
        lines.push(`  Tags: ${tagStr}`);
      }
      // #60: the withheld arrays are absent from this element, so the disclosure
      // is the only place content[] can say what is missing and how big it was.
      const withheld = el.withheld_keys as WithheldKey[] | undefined;
      if (withheld && withheld.length > 0) {
        const summary = withheld
          .map((w) => `${w.key} (${w.item_count} items, ${w.serialized_bytes} bytes)`)
          .join(', ');
        lines.push(`  Withheld over max_element_bytes: ${summary}`);
      }
      // Render every remaining key so content[] reaches full parity with
      // structuredContent.elements for any Overpass verbosity (way nodes[],
      // relation members[], out meta/geom/center fields, etc.). Scalars
      // stringify; arrays/objects serialize to JSON so nothing is truncated.
      for (const [key, value] of Object.entries(el)) {
        if (RENDERED_KEYS.has(key)) continue;
        lines.push(`  ${escapeMarkdownText(key)}: ${escapeMarkdownValue(value)}`);
      }
    }
    lines.push('');
    lines.push(`*${result.attribution}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
