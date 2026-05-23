/**
 * @fileoverview Overpass bounding box query tool — finds OSM features within a bbox.
 * @module mcp-server/tools/definitions/overpass-query-bbox.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOverpassService } from '@/services/overpass/overpass-service.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

export const overpassQueryBbox = tool('overpass_query_bbox', {
  title: 'Find OSM features within a bounding box',
  description:
    'Find OSM features within a rectangular geographic area (bounding box) via the Overpass API. ' +
    'Useful for area surveys where you want everything in a region, not proximity searches. ' +
    'Use amenity for common POI types (hospital, pharmacy, cafe, school, etc.) ' +
    'or tag_key + tag_value for other OSM categories (leisure=park, shop=supermarket, natural=peak). ' +
    'Exactly one of amenity or tag_key/tag_value must be provided. ' +
    'For proximity searches centered on a point, use overpass_query_nearby instead.',
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
            osm_id: z.number().describe('OSM element ID. Use with osm_type for nominatim_lookup.'),
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
    total_found: z
      .number()
      .describe('Total features returned by Overpass before limit truncation.'),
    truncated: z
      .boolean()
      .describe(
        'True if results were cut at the limit. Reduce bbox area or add more specific tags to narrow the result set.',
      ),
    data_timestamp: z.string().describe('OSM data freshness timestamp from the Overpass response.'),
    attribution: z
      .string()
      .describe('Required data attribution: Data © OpenStreetMap contributors, ODbL 1.0.'),
  }),

  errors: [
    {
      reason: 'invalid_tag',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Both amenity and tag_key/tag_value are provided, or neither is provided.',
      recovery:
        'Provide either amenity (e.g., "hospital") or tag_key + tag_value (e.g., tag_key="leisure", tag_value="park"), but not both and not neither.',
    },
    {
      reason: 'query_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The Overpass query exceeded the timeout.',
      retryable: true,
      recovery:
        'Reduce the bounding box area, add more specific tag filters, or increase timeout_seconds and retry.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass returned HTTP 429 — all 4 concurrent query slots are occupied.',
      retryable: true,
      recovery:
        'Wait a few seconds and retry. Reduce concurrent calls or switch to a private Overpass instance via OVERPASS_BASE_URL.',
    },
  ],

  async handler(input, ctx) {
    const hasAmenity = Boolean(input.amenity?.trim());
    const hasTagKey = Boolean(input.tag_key?.trim());
    const hasTagValue = Boolean(input.tag_value?.trim());

    if (hasAmenity && (hasTagKey || hasTagValue)) {
      throw ctx.fail('invalid_tag', 'Cannot combine amenity with tag_key/tag_value.', {
        ...ctx.recoveryFor('invalid_tag'),
      });
    }
    if (!hasAmenity && !hasTagKey) {
      throw ctx.fail('invalid_tag', 'Provide either amenity or tag_key + tag_value.', {
        ...ctx.recoveryFor('invalid_tag'),
      });
    }

    const tagKey = hasAmenity ? 'amenity' : (input.tag_key ?? '');
    const tagValue = hasAmenity ? (input.amenity ?? '') : (input.tag_value ?? '');

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

    const response = await service.query(ql, ctx);
    const allPois = service.normalizeElements(response.elements);
    const limited = allPois.slice(0, input.limit);

    const dataTimestamp = response.osm3s?.timestamp_osm_base ?? new Date().toISOString();

    ctx.log.info('Overpass bbox results', {
      total: allPois.length,
      returned: limited.length,
    });

    return {
      elements: limited,
      total_found: allPois.length,
      truncated: allPois.length > input.limit,
      data_timestamp: dataTimestamp,
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.total_found} feature${result.total_found === 1 ? '' : 's'} found**${result.truncated ? ` (showing first ${result.elements.length} — results truncated)` : ''}`,
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
