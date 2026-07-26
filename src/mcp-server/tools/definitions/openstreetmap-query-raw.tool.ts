/**
 * @fileoverview Raw Overpass QL query tool — escape hatch for advanced spatial queries.
 * @module mcp-server/tools/definitions/openstreetmap-query-raw.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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
    'Validate complex queries at overpass-turbo.eu before use. ' +
    'For simple "what\'s near X?" or "what\'s in this area?" queries, use openstreetmap_query_nearby or openstreetmap_query_bbox instead.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .describe(
        'Overpass QL query string. Must include [out:json]. The server sets the endpoint and User-Agent; do not include those. Example: "[out:json][timeout:15];node[\\"natural\\"=\\"peak\\"](47.5,-122.5,47.7,-122.2);out body;"',
      ),
    timeout_seconds: z
      .number()
      .int()
      .min(5)
      .max(180)
      .default(30)
      .describe(
        'Query timeout in seconds. The [timeout:N] directive in the query string takes precedence if present. Max 180s.',
      ),
  }),

  output: z.object({
    elements: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Raw Overpass API response elements. Structure varies by query type — nodes have lat/lon, ways have nodes[], relations have members[].',
      ),
    total_elements: z.number().describe('Number of elements returned.'),
    data_timestamp: z
      .string()
      .optional()
      .describe(
        'OSM data freshness timestamp from the Overpass response. Absent if not included in the response.',
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
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no elements were returned — e.g., check query syntax or broaden the filter. Absent when results were returned.',
      ),
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
      when: 'Overpass returned HTTP 429 — all 4 concurrent query slots are occupied.',
      retryable: true,
      recovery:
        'Wait a few seconds and retry. Switch to a private Overpass instance via OSM_OVERPASS_BASE_URL for higher concurrency.',
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
          // fetchWithTimeout throws without a reason for HTTP status errors — remap by status
          if (data?.status === 400) {
            throw ctx.fail('query_error', err.message, { ...ctx.recoveryFor('query_error') });
          }
          if (data?.status === 429) {
            throw ctx.fail('rate_limited', err.message, { ...ctx.recoveryFor('rate_limited') });
          }
        } else if (
          reason === 'query_error' ||
          reason === 'query_timeout' ||
          reason === 'result_too_large' ||
          reason === 'rate_limited'
        ) {
          throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
        }
      }
      throw err;
    });

    const dataTimestamp = response.osm3s?.timestamp_osm_base;

    ctx.log.info('Overpass raw results', { count: response.elements.length });

    ctx.enrich({ effectiveQuery: ql });
    if (response.elements.length === 0) {
      ctx.enrich.notice(
        'No elements returned. Verify query syntax, check the bbox or around filter bounds, and test at overpass-turbo.eu.',
      );
    }

    return {
      elements: response.elements as Record<string, unknown>[],
      total_elements: response.elements.length,
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
