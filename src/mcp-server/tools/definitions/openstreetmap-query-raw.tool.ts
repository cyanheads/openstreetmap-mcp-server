/**
 * @fileoverview Raw Overpass QL query tool — escape hatch for advanced spatial queries.
 * @module mcp-server/tools/definitions/openstreetmap-query-raw.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { extractOverpassError, withoutCapturedBody } from '@/services/overpass/overpass-error.js';
import {
  OVERPASS_QL_OUT_JSON_PATTERN,
  OVERPASS_QL_TIMEOUT_PATTERN,
} from '@/services/overpass/overpass-ql.js';
import { getOverpassService } from '@/services/overpass/overpass-service.js';
import { escapeMarkdownText, escapeMarkdownValue } from './openstreetmap-markdown-escape.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

/**
 * Default per-element serialized-byte budget. Sized from measurement: an Overpass
 * member or geometry vertex serializes at roughly 50 bytes, so this clears an
 * ordinary way or small relation (a few hundred entries) and catches the ones —
 * a 1,714-member boundary relation, a thousand-vertex coastline — that scale a
 * single element past a client context window on both result surfaces.
 */
export const DEFAULT_MAX_ELEMENT_BYTES = 20_000;

/** Largest per-element budget the tool accepts, bounding the retrieval call too. */
const MAX_ELEMENT_BYTES_CEILING = 10_000_000;

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
 * Builds the guidance for the withheld elements on a page.
 *
 * An element at or below the ceiling gets a recipe that is executable verbatim —
 * the same query, `limit: 1`, that element's absolute offset, and the smallest
 * budget that returns it whole. One above the ceiling gets no recipe: the schema
 * would refuse the budget it needs, so printing one would send the caller into a
 * validation error. It is named with its size and pointed at a narrower query
 * instead, which is the only path Overpass itself offers.
 */
function buildWithheldNotice(entries: WithheldElement[], budget: number): string {
  const single = entries.length === 1;
  const clauses = [
    `${entries.length} element${single ? '' : 's'} on this page exceeded max_element_bytes (${budget}). ` +
      `${single ? 'Its' : 'Their'} members, nodes and geometry arrays were withheld whole — never truncated to a prefix — and are unchanged upstream.`,
  ];

  const retrievable = entries.filter((w) => w.maxElementBytes <= MAX_ELEMENT_BYTES_CEILING);
  if (retrievable.length > 0) {
    const shown = retrievable.slice(0, 3);
    const recipes = shown
      .map((w) => `${w.type} ${w.id}: offset ${w.offset}, max_element_bytes ${w.maxElementBytes}`)
      .join('; ');
    clauses.push(
      'Retrieve one whole by re-calling this tool with the same query plus limit: 1 and that element’s offset and max_element_bytes: ' +
        `${recipes}${andMore(retrievable.length, shown.length)}.`,
    );
  }

  const overCeiling = entries.filter((w) => w.maxElementBytes > MAX_ELEMENT_BYTES_CEILING);
  if (overCeiling.length > 0) {
    const shown = overCeiling.slice(0, 3);
    const named = shown.map((w) => `${w.type} ${w.id} (${w.maxElementBytes} bytes)`).join('; ');
    clauses.push(
      `No budget returns ${named}${andMore(overCeiling.length, shown.length)}: each exceeds the max_element_bytes ceiling of ${MAX_ELEMENT_BYTES_CEILING}. ` +
        'Narrow the query instead — out ids; or out tags; drops the heavy arrays entirely, or query the members of one such element individually.',
    );
  }

  return clauses.join(' ');
}

export const openstreetmapQueryRaw = tool('openstreetmap_query_raw', {
  title: 'Execute a raw Overpass QL query',
  description:
    'Execute a raw Overpass QL query for advanced spatial queries that the convenience tools do not cover. ' +
    'Use for multi-type queries, union queries, relation membership, historical queries, or any operation ' +
    'requiring full Overpass QL expressiveness. ' +
    'The query must include [out:json]. ' +
    'Example: "[out:json][timeout:15];node[\\"natural\\"=\\"peak\\"](47.5,-122.5,47.7,-122.2);out body;" ' +
    'Returns one page of the result set: use limit and offset to page through it, and read totalFound and truncated to see how much the query matched. ' +
    'One element is bounded too: an element over max_element_bytes has its members, nodes or geometry array withheld whole and discloses under withheldNotice how to fetch it back in one call. ' +
    'Validate complex queries at overpass-turbo.eu before use. ' +
    'For simple "what\'s near X?" or "what\'s in this area?" queries, use openstreetmap_query_nearby or openstreetmap_query_bbox instead.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .describe(
        'Overpass QL query string. Must include [out:json]. The server sets the endpoint and User-Agent; do not include those. Example: "[out:json][timeout:15];node[\\"natural\\"=\\"peak\\"](47.5,-122.5,47.7,-122.2);out body;"',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(20)
      .describe(
        'Maximum elements to return. Applied after the Overpass query — if the query matched more, they are truncated.',
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
      .max(MAX_ELEMENT_BYTES_CEILING)
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
      .describe('The Overpass QL string as sent to the API (after any timeout injection).'),
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
        'Overpass endpoint that answered, as origin and path. May name a failover mirror, or the endpoint that originally served a cached response. Read with data_timestamp when a result looks slow, sparse, or stale.',
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
              'Serialized UTF-8 byte size of this element whole, which is the smallest max_element_bytes that returns it. Pass it on the retrieval call when it is at or below the 10000000 ceiling; above that no accepted budget returns the element whole and withheldNotice names the narrower query to use instead.',
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
  },

  enrichmentTrailer: {
    effectiveQuery: { label: 'Effective Query' },
    totalFound: { label: 'Total Found' },
    truncated: { label: 'Results Truncated' },
    nextOffset: { label: 'Next Offset' },
    servingEndpoint: { label: 'Served By' },
    withheldNotice: { label: 'Retrieving Withheld Data' },
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
        'Check Overpass QL syntax. Validate the query at overpass-turbo.eu before using this tool.',
    },
    {
      reason: 'query_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The query exceeded its timeout.',
      retryable: false,
      recovery:
        'Add [timeout:N] to the query string with a higher value, or simplify the query (smaller bbox, fewer element types, more specific tags).',
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass ran out of memory on this query.',
      recovery:
        'Narrow the query scope: reduce the bbox or around radius, add more tag filters, limit element types, or add [maxsize:N] to the query.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every configured endpoint refused the query as throttled — HTTP 429, or a throttle document in place of JSON.',
      retryable: true,
      recovery:
        'Every configured endpoint refused this query, so an immediate retry will not reach a free slot — wait a few seconds first. Set OSM_OVERPASS_MAX_CONCURRENCY to the slot budget the endpoint advertises at /api/status, add a mirror to OSM_OVERPASS_ENDPOINTS, or switch to a private Overpass instance via OSM_OVERPASS_BASE_URL for higher concurrency.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass reported a runtime error that is neither a timeout nor memory exhaustion.',
      recovery:
        'Read the Overpass remark carried verbatim in the message: it names the fault. Retry in a minute when it points at the dispatcher or database being unavailable; otherwise fix the query it describes.',
    },
    {
      reason: 'overpass_gateway_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: "Overpass answered HTTP 504 — the query exceeded the endpoint's own time budget, not the [timeout:N] directive.",
      retryable: true,
      recovery:
        'Shrink the work per query: narrow the bbox or around radius, add more tag filters, or split the query into parts, then retry. The endpoint budget is fixed, so raising [timeout:N] alone will not clear a 504.',
    },
    {
      reason: 'overpass_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass answered an HTTP 5xx other than 504 — the endpoint is down, restarting, or shedding load.',
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
    },
    {
      reason: 'endpoints_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No configured endpoint would serve the call — connections refused, DNS failures, throttling, or instance faults, in some mix.',
      retryable: true,
      recovery:
        'The query is fine; no endpoint would serve it. Read the per-endpoint outcomes in the message: a host that refused the connection or failed to resolve belongs out of OSM_OVERPASS_ENDPOINTS, while a throttle or instance fault usually clears within a minute. Adding a healthy mirror, or pinning a private instance via OSM_OVERPASS_BASE_URL, gives the retry somewhere else to reach.',
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
        { ...ctx.recoveryFor('query_error') },
      );
    }

    /**
     * Inject the timeout unless the caller already wrote one, honoring the
     * precedence `timeout_seconds` advertises. Anchored on the directive the
     * preflight matched rather than a literal, so the injected value lands inside
     * the settings block whatever spacing the caller used.
     */
    if (!OVERPASS_QL_TIMEOUT_PATTERN.test(ql)) {
      ql = ql.replace(outJson[0], `${outJson[0]}[timeout:${input.timeout_seconds}]`);
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
            throw ctx.fail('query_error', message, { ...ctx.recoveryFor('query_error') });
          }
          if (status === 429) {
            throw ctx.fail('rate_limited', err.message, { ...ctx.recoveryFor('rate_limited') });
          }
          if (typeof status === 'number' && status >= 500) {
            /**
             * Constructed rather than routed through ctx.fail: fail() rewrites the
             * code to the contract's declared one, which would collapse the 504
             * Timeout (-32004) and the 5xx ServiceUnavailable (-32000) onto one
             * value. Only reason, the upstream detail, and the recovery hint are
             * added here, so the status-mapped code reaches the client intact.
             */
            const remapped = status === 504 ? 'overpass_gateway_timeout' : 'overpass_unavailable';
            // Overpass states the cause in the 5xx body too ("runtime error: ...
            // Probably the server is overloaded."), in the same shape as a 400.
            const detail = extractOverpassError(data?.body);
            throw new McpError(
              err.code,
              detail ? `${err.message} Overpass reported: ${detail}` : err.message,
              {
                ...withoutCapturedBody(data),
                retryable: true,
                reason: remapped,
                ...ctx.recoveryFor(remapped),
              },
            );
          }
        } else if (
          reason === 'query_error' ||
          reason === 'query_timeout' ||
          reason === 'result_too_large' ||
          reason === 'rate_limited' ||
          reason === 'upstream_error' ||
          reason === 'endpoints_exhausted' ||
          reason === 'endpoints_unavailable'
        ) {
          throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
        }
      }
      throw err;
    });

    const allElements = response.elements as Record<string, unknown>[];
    const limited = allElements.slice(input.offset, input.offset + input.limit);
    const truncated = allElements.length > input.offset + input.limit;

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
          total <= input.limit
            ? `, which fit in one page of ${input.limit}. Retry with offset 0.`
            : `. Retry with offset ${total - input.limit} for the last page, or offset 0 for the first.`;
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
