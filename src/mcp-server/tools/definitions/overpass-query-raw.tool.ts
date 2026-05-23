/**
 * @fileoverview Raw Overpass QL query tool — escape hatch for advanced spatial queries.
 * @module mcp-server/tools/definitions/overpass-query-raw.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOverpassService } from '@/services/overpass/overpass-service.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

export const overpassQueryRaw = tool('overpass_query_raw', {
  title: 'Execute a raw Overpass QL query',
  description:
    'Execute a raw Overpass QL query for advanced spatial queries that the convenience tools do not cover. ' +
    'Use for multi-type queries, union queries, relation membership, historical queries, or any operation ' +
    'requiring full Overpass QL expressiveness. ' +
    'The query must include [out:json]. ' +
    'Example: "[out:json][timeout:15];node[\\"natural\\"=\\"peak\\"](47.5,-122.5,47.7,-122.2);out body;" ' +
    'Validate complex queries at overpass-turbo.eu before use. ' +
    'For simple "what\'s near X?" or "what\'s in this area?" queries, use overpass_query_nearby or overpass_query_bbox instead.',
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

  errors: [
    {
      reason: 'query_error',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Overpass returned a 400 error — malformed query syntax.',
      recovery:
        'Check Overpass QL syntax. Validate the query at overpass-turbo.eu before using this tool.',
    },
    {
      reason: 'query_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The query exceeded its timeout (Overpass runtime error in response body).',
      retryable: true,
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
        'Wait a few seconds and retry. Switch to a private Overpass instance via OVERPASS_BASE_URL for higher concurrency.',
    },
  ],

  async handler(input, ctx) {
    // Inject timeout if the query doesn't already include one
    let ql = input.query.trim();
    if (!ql.includes('[timeout:')) {
      ql = ql.replace('[out:json]', `[out:json][timeout:${input.timeout_seconds}]`);
    }

    ctx.log.info('Overpass raw query', { queryLength: ql.length });

    const service = getOverpassService();
    const response = await service.query(ql, ctx);

    const dataTimestamp = response.osm3s?.timestamp_osm_base;

    ctx.log.info('Overpass raw results', { count: response.elements.length });

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
    for (const el of result.elements.slice(0, 50)) {
      const type = String(el.type ?? 'unknown');
      const id = String(el.id ?? '?');
      const tags = el.tags as Record<string, string> | undefined;
      const name = tags?.name;
      lines.push(`**${type}** ${id}${name ? ` — ${name}` : ''}`);
      if (tags && Object.keys(tags).length > 0) {
        const tagStr = Object.entries(tags)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        lines.push(`  Tags: ${tagStr}`);
      }
    }
    if (result.elements.length > 50) {
      lines.push(`... and ${result.elements.length - 50} more elements`);
    }
    lines.push('');
    lines.push(`*${result.attribution}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
