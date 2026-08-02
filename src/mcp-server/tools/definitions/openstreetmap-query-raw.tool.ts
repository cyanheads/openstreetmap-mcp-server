/**
 * @fileoverview Raw Overpass QL query tool — escape hatch for advanced spatial queries.
 * @module mcp-server/tools/definitions/openstreetmap-query-raw.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { extractOverpassError, withoutCapturedBody } from '@/services/overpass/overpass-error.js';
import { getOverpassService } from '@/services/overpass/overpass-service.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

export const openstreetmapQueryRaw = tool('openstreetmap_query_raw', {
  title: 'Execute a raw Overpass QL query',
  description:
    'Execute a raw Overpass QL query for advanced spatial queries that the convenience tools do not cover. ' +
    'Use for multi-type queries, union queries, relation membership, historical queries, or any operation ' +
    'requiring full Overpass QL expressiveness. ' +
    'The query must include [out:json]. ' +
    'Example: "[out:json][timeout:15];node[\\"natural\\"=\\"peak\\"](47.5,-122.5,47.7,-122.2);out body;" ' +
    'Returns one page of the result set: use limit and offset to page through it, and read totalFound and truncated to see how much the query matched. ' +
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
        'Number of matching elements to skip before applying limit, for paging through a large result set. The full match set is fetched and cached ~10 minutes keyed by the query, so re-paging at a new offset is deterministic and costs no extra upstream request; a result over 100000 elements is served but not cached, so paging that far re-queries and depends on the endpoint returning the same order. Pass the nextOffset value from a prior truncated response.',
      ),
    timeout_seconds: z
      .number()
      .int()
      .min(5)
      .max(180)
      .default(30)
      .describe(
        'Query timeout in seconds, bounding how long Overpass itself spends on the query. The [timeout:N] directive in the query string takes precedence if present. The client waits for what is requested here, up to 180s, so a long-running query is not cut off early — but the endpoint enforces its own budget and may answer HTTP 504 first.',
      ),
  }),

  output: z.object({
    elements: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Raw Overpass API response elements for this page, up to the limit. Structure varies by query type — nodes have lat/lon, ways have nodes[], relations have members[].',
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
        'Overpass endpoint that produced this response, as origin and path. Differs from the first configured endpoint when a mirror answered after the primary failed, and names the endpoint that served a cached response rather than the one this call would have tried. Pair it with data_timestamp when a result looks unexpectedly slow, sparse, or stale.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the page came back empty. Distinguishes a query that matched nothing (check syntax or broaden the filter) from an offset past the end of a non-empty result set (retry at a lower offset). Absent when results were returned.',
      ),
  },

  enrichmentTrailer: {
    totalFound: { label: 'Total Found' },
    truncated: { label: 'Results Truncated' },
    nextOffset: { label: 'Next Offset' },
    servingEndpoint: { label: 'Served By' },
  },

  errors: [
    {
      reason: 'query_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Overpass returned a 400 error — malformed query syntax.',
      recovery:
        'Check Overpass QL syntax. Validate the query at overpass-turbo.eu before using this tool.',
    },
    {
      reason: 'query_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The query exceeded its timeout (Overpass runtime error in response body).',
      retryable: false,
      recovery:
        'Add [timeout:N] to the query string with a higher value, or simplify the query (smaller bbox, fewer element types, more specific tags).',
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass runtime error: query ran out of memory — result set exceeds the server memory limit.',
      recovery:
        'Narrow the query scope: reduce the bbox or around radius, add more tag filters, limit element types, or add [maxsize:N] to the query.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass refused the query as throttled — HTTP 429, or a throttle document instead of JSON — on every configured endpoint. With a list in OSM_OVERPASS_ENDPOINTS the call advances to the next entry first, so this surfaces only once all of them have refused it.',
      retryable: true,
      recovery:
        'Every configured endpoint refused this query, so an immediate retry will not reach a free slot — wait a few seconds first. Set OSM_OVERPASS_MAX_CONCURRENCY to the slot budget the endpoint advertises at /api/status, add a mirror to OSM_OVERPASS_ENDPOINTS, or switch to a private Overpass instance via OSM_OVERPASS_BASE_URL for higher concurrency.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass reported a runtime error that is neither a timeout nor memory exhaustion — the message carries the remark verbatim.',
      recovery:
        'Read the Overpass remark in the message: it names the fault. Retry in a minute when it points at the dispatcher or database being unavailable; otherwise fix the query it describes.',
    },
    {
      reason: 'overpass_gateway_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Overpass answered HTTP 504 — it accepted the query but its dispatcher gave up before producing a result, so the query exceeded the time budget the endpoint enforces rather than the [timeout:N] directive.',
      retryable: true,
      recovery:
        'Shrink the work per query: narrow the bbox or around radius, add more tag filters, or split the query into parts, then retry. The endpoint budget is fixed, so raising [timeout:N] alone will not clear a 504.',
    },
    {
      reason: 'overpass_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass answered with an HTTP 5xx other than 504 (500, 501, 502, 503) — the endpoint is down, restarting, or shedding load. The thrown code tracks the status: 500 and 501 surface as InternalError, every other 5xx as ServiceUnavailable.',
      retryable: true,
      recovery:
        'The query is fine; the endpoint is not. Wait about 30 seconds and retry unchanged. If it keeps failing, pin a mirror or private instance via OSM_OVERPASS_BASE_URL.',
    },
    {
      reason: 'endpoints_exhausted',
      code: JsonRpcErrorCode.Timeout,
      when: 'Every Overpass endpoint tried was still unanswered when the call ran out of its total time budget — each accepted the query and held the connection instead of failing outright.',
      retryable: true,
      recovery:
        'Shrink the work per query: narrow the bbox or around radius, add more tag filters, or split the query into parts, then retry; every endpoint tried was too slow to answer a query this size. Listing a healthy mirror in OSM_OVERPASS_ENDPOINTS gives the retry a second server to reach.',
    },
  ],

  async handler(input, ctx) {
    let ql = input.query.trim();

    // Preflight: require [out:json] before calling the service.
    // Without it Overpass returns XML, JSON.parse throws, and the error surfaces as InternalError.
    if (!ql.includes('[out:json]')) {
      throw ctx.fail(
        'query_error',
        'Query is missing [out:json]. Add [out:json] at the start of the settings block (e.g. "[out:json][timeout:30];...").',
        { ...ctx.recoveryFor('query_error') },
      );
    }

    // Inject timeout if the query doesn't already include one
    if (!ql.includes('[timeout:')) {
      ql = ql.replace('[out:json]', `[out:json][timeout:${input.timeout_seconds}]`);
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
          reason === 'endpoints_exhausted'
        ) {
          throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
        }
      }
      throw err;
    });

    const allElements = response.elements as Record<string, unknown>[];
    const limited = allElements.slice(input.offset, input.offset + input.limit);
    const truncated = allElements.length > input.offset + input.limit;

    const dataTimestamp = response.osm3s?.timestamp_osm_base;

    ctx.log.info('Overpass raw results', {
      total: allElements.length,
      returned: limited.length,
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
    if (limited.length === 0) {
      // An empty page with matches upstream means the offset ran past the last
      // page — a paging mistake. Sending the caller to fix their syntax would
      // point them at a query that already worked.
      ctx.enrich.notice(
        allElements.length === 0
          ? 'No elements returned. Verify query syntax, check the bbox or around filter bounds, and test at overpass-turbo.eu.'
          : `Offset ${input.offset} is past the end of the result set: the query matched ${allElements.length} element${allElements.length === 1 ? '' : 's'}. Retry with offset ${Math.max(0, allElements.length - input.limit)} for the last page, or offset 0 for the first.`,
      );
    }

    return {
      elements: limited,
      total_elements: limited.length,
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
    const RENDERED_KEYS = new Set(['type', 'id', 'lat', 'lon', 'tags']);
    for (const el of result.elements) {
      const type = String(el.type ?? 'unknown');
      const id = String(el.id ?? '?');
      const tags = el.tags as Record<string, string> | undefined;
      const name = tags?.name;
      lines.push(`**${type}** ${id}${name ? ` — ${name}` : ''}`);
      if (el.lat !== undefined && el.lon !== undefined) {
        lines.push(`  Coordinates: ${String(el.lat)}, ${String(el.lon)}`);
      }
      if (tags && Object.keys(tags).length > 0) {
        const tagStr = Object.entries(tags)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        lines.push(`  Tags: ${tagStr}`);
      }
      // Render every remaining key so content[] reaches full parity with
      // structuredContent.elements for any Overpass verbosity (way nodes[],
      // relation members[], out meta/geom/center fields, etc.). Scalars
      // stringify; arrays/objects serialize to JSON so nothing is truncated.
      for (const [key, value] of Object.entries(el)) {
        if (RENDERED_KEYS.has(key)) continue;
        const rendered =
          typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
        lines.push(`  ${key}: ${rendered}`);
      }
    }
    lines.push('');
    lines.push(`*${result.attribution}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
