/**
 * @fileoverview Overpass bounding box query tool — finds OSM features within a bbox.
 * @module mcp-server/tools/definitions/openstreetmap-query-bbox.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getOverpassService } from '@/services/overpass/overpass-service.js';
import { invalidTagMessage, resolveTagInput } from './openstreetmap-tag-input.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

export const openstreetmapQueryBbox = tool('openstreetmap_query_bbox', {
  title: 'Find OSM features within a bounding box',
  description:
    'Find OSM features within a rectangular geographic area (bounding box) via the Overpass API. ' +
    'Useful for area surveys where you want everything in a region, not proximity searches. ' +
    'Use amenity for common POI types (hospital, pharmacy, cafe, school, etc.) ' +
    'or tag_key + tag_value for other OSM categories (leisure=park, shop=supermarket, natural=peak). ' +
    'Exactly one of amenity or tag_key/tag_value must be provided. ' +
    'Every feature includes its full OSM tag set; the extratags flag (used by geocode/reverse/lookup) does not apply here. ' +
    'For proximity searches centered on a point, use openstreetmap_query_nearby instead.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    south: z.number().min(-90).max(90).describe('Southern boundary latitude (minimum latitude).'),
    west: z.number().min(-180).max(180).describe('Western boundary longitude (minimum longitude).'),
    north: z.number().min(-90).max(90).describe('Northern boundary latitude (maximum latitude).'),
    east: z.number().min(-180).max(180).describe('Eastern boundary longitude (maximum longitude).'),
    amenity: z
      .string()
      .optional()
      .describe(
        'OSM amenity tag value shortcut (e.g., "cafe", "bench", "hospital"). Cannot be combined with tag_key/tag_value.',
      ),
    tag_key: z
      .string()
      .optional()
      .describe(
        'OSM tag key for non-amenity queries (e.g., "leisure", "shop", "natural"). Use with tag_value. Cannot be combined with amenity.',
      ),
    tag_value: z
      .string()
      .optional()
      .describe('OSM tag value paired with tag_key (e.g., "park", "supermarket", "peak").'),
    element_types: z
      .array(z.enum(['node', 'way', 'relation']))
      .default(['node', 'way'])
      .describe(
        'OSM element types to search. Ways cover most buildings and areas; nodes cover most standalone POIs. Add "relation" for complex structures.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(20)
      .describe(
        'Maximum results to return. Applied after the Overpass query — if the area has more features, they are truncated.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Number of matching features to skip before applying limit, for paging through a large result set. The full match set is fetched and cached ~10 minutes keyed by the query, so re-paging at a new offset is deterministic and costs no extra upstream request. Pass the nextOffset value from a prior truncated response.',
      ),
    timeout_seconds: z
      .number()
      .int()
      .min(5)
      .max(60)
      .default(25)
      .describe(
        'Overpass query timeout in seconds. Increase for large bounding boxes or dense areas.',
      ),
  }),

  output: z.object({
    elements: z
      .array(
        z
          .object({
            osm_type: z.enum(['node', 'way', 'relation']).describe('OSM element type.'),
            osm_id: z
              .number()
              .describe('OSM element ID. Use with osm_type for openstreetmap_lookup.'),
            lat: z
              .number()
              .optional()
              .describe('Latitude (present for nodes and ways/relations with computed center).'),
            lon: z
              .number()
              .optional()
              .describe('Longitude (present for nodes and ways/relations with computed center).'),
            name: z.string().optional().describe('Feature name from OSM tags.'),
            tags: z
              .record(z.string(), z.string())
              .describe('All OSM tags for this feature. Values are always strings.'),
          })
          .describe('A single matching OSM feature.'),
      )
      .describe('Matching OSM features within the bounding box, up to the limit.'),
    data_timestamp: z.string().describe('OSM data freshness timestamp from the Overpass response.'),
    attribution: z
      .string()
      .describe('Required data attribution: Data © OpenStreetMap contributors, ODbL 1.0.'),
  }),

  // Agent-facing context: resolved tag filter, result-set counts, and empty-result guidance.
  // Reaches both structuredContent and content[] without a format() entry.
  enrichment: {
    effectiveTag: z
      .string()
      .describe('The OSM tag filter applied (key=value, e.g. "amenity=cafe" or "leisure=park").'),
    totalFound: z.number().describe('Total features returned by Overpass before limit truncation.'),
    truncated: z
      .boolean()
      .describe(
        'True if results were cut at the limit. Reduce bbox area, add more specific tags, or page with offset to retrieve the rest.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call to retrieve the following page of features. Present only when more features remain beyond this page.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no features were found — e.g., try a different bounding box or tag. Absent when results were returned.',
      ),
  },

  enrichmentTrailer: {
    effectiveTag: { label: 'Tag Filter' },
    totalFound: { label: 'Total Found' },
    truncated: { label: 'Results Truncated' },
    nextOffset: { label: 'Next Offset' },
  },

  errors: [
    {
      reason: 'invalid_bbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The bounding box is inverted on the latitude axis — south is greater than north.',
      recovery:
        'Order the bounds so south is at most north (south is the minimum latitude, north the maximum); a west greater than east is valid and describes an antimeridian-crossing box.',
    },
    {
      reason: 'invalid_tag',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both amenity and tag_key/tag_value are provided, neither is provided, or a tag key/value contains Overpass QL metacharacters.',
      recovery:
        'Provide either amenity (e.g., "hospital") or both tag_key and tag_value (e.g., tag_key="leisure", tag_value="park"); tag_key without tag_value is not valid. Tag keys and values must be literal text without Overpass QL metacharacters (" \\ [ ] ; ( )); use openstreetmap_query_raw for arbitrary Overpass QL.',
    },
    {
      reason: 'query_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The Overpass query exceeded the timeout.',
      retryable: false,
      recovery:
        'Reduce the bounding box area, add more specific tag filters, or increase timeout_seconds and retry.',
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass ran out of memory — the result set exceeds the server memory limit.',
      recovery:
        'Narrow the query: reduce the bounding box area, add more specific tag filters, or limit element_types.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass returned HTTP 429 — all 4 concurrent query slots are occupied.',
      retryable: true,
      recovery:
        'Wait a few seconds and retry. Reduce concurrent calls or switch to a private Overpass instance via OSM_OVERPASS_BASE_URL.',
    },
  ],

  async handler(input, ctx) {
    // Reject latitude-inverted boxes before hitting Overpass (it returns a bare HTTP
    // 400). Only south > north is invalid; west > east is a legitimate antimeridian
    // crossing that Overpass accepts, so it must pass through untouched.
    if (input.south > input.north) {
      throw ctx.fail(
        'invalid_bbox',
        `Inverted bounding box: south (${input.south}) exceeds north (${input.north}).`,
        { ...ctx.recoveryFor('invalid_bbox') },
      );
    }

    const resolved = resolveTagInput(input);
    if ('error' in resolved) {
      throw ctx.fail('invalid_tag', invalidTagMessage(resolved.error), {
        ...ctx.recoveryFor('invalid_tag'),
      });
    }
    const { tagKey, tagValue } = resolved;

    const service = getOverpassService();
    const ql = service.buildBboxQuery({
      south: input.south,
      west: input.west,
      north: input.north,
      east: input.east,
      tagKey,
      tagValue,
      elementTypes: input.element_types,
      timeoutSeconds: input.timeout_seconds,
    });

    const response = await service.query(ql, ctx).catch((err) => {
      if (err instanceof McpError) {
        const data = err.data as Record<string, unknown> | undefined;
        const reason = data?.reason as string | undefined;
        // fetchWithTimeout throws RateLimited (no reason) for HTTP 429 — remap to rate_limited
        if (!reason && data?.status === 429) {
          throw ctx.fail('rate_limited', err.message, { ...ctx.recoveryFor('rate_limited') });
        }
        if (
          reason === 'query_timeout' ||
          reason === 'result_too_large' ||
          reason === 'rate_limited'
        ) {
          throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
        }
      }
      throw err;
    });
    const allPois = service.normalizeElements(response.elements);
    const limited = allPois.slice(input.offset, input.offset + input.limit);
    const truncated = allPois.length > input.offset + input.limit;

    const dataTimestamp = response.osm3s?.timestamp_osm_base ?? new Date().toISOString();

    ctx.log.info('Overpass bbox results', {
      total: allPois.length,
      returned: limited.length,
    });

    ctx.enrich({
      effectiveTag: `${tagKey}=${tagValue}`,
      totalFound: allPois.length,
      truncated,
    });
    if (truncated) {
      ctx.enrich({ nextOffset: input.offset + limited.length });
    }
    if (limited.length === 0) {
      ctx.enrich.notice(
        `No ${tagKey}=${tagValue} features found in the specified bounding box. Try a larger bbox, a different tag, or verify the coordinates.`,
      );
    }

    return {
      elements: limited,
      data_timestamp: dataTimestamp,
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const count = result.elements.length;
    const lines: string[] = [
      `**${count} feature${count === 1 ? '' : 's'} returned**`,
      `**Data as of:** ${result.data_timestamp}`,
      '',
    ];
    for (const el of result.elements) {
      const nameStr = el.name ?? 'Unnamed';
      lines.push(`## ${nameStr}`);
      lines.push(`**OSM:** ${el.osm_type.charAt(0).toUpperCase()}${el.osm_id}`);
      if (el.lat !== undefined && el.lon !== undefined) {
        lines.push(`**Coordinates:** ${el.lat}, ${el.lon}`);
      }
      const tagEntries = Object.entries(el.tags)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      if (tagEntries) lines.push(`**Tags:** ${tagEntries}`);
      lines.push('');
    }
    lines.push(`*${result.attribution}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
