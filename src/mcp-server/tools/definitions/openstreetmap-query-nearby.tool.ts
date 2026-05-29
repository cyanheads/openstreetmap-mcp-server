/**
 * @fileoverview Overpass nearby query tool — finds OSM features within a radius.
 * @module mcp-server/tools/definitions/openstreetmap-query-nearby.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOverpassService, haversineMeters } from '@/services/overpass/overpass-service.js';
import { resolveTagInput } from './openstreetmap-tag-input.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

export const openstreetmapQueryNearby = tool('openstreetmap_query_nearby', {
  title: 'Find OSM features near a point',
  description:
    'Find OSM features within a radius around a geographic point via the Overpass API. ' +
    'The primary tool for "what\'s near X?" spatial queries. ' +
    'Use amenity for common POI types (hospital, pharmacy, restaurant, cafe, school, atm, etc.) ' +
    'or tag_key + tag_value for other OSM categories (leisure=park, shop=supermarket, natural=peak). ' +
    'Exactly one of amenity or tag_key/tag_value must be provided. ' +
    'Results include all element types specified (nodes cover standalone POIs, ways cover buildings and areas), ' +
    'each with its full OSM tag set, sorted nearest-first by distance_meters from the center point. ' +
    'The extratags flag is not needed here — it applies only to the Nominatim-backed geocode/reverse/lookup tools.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    lat: z.number().min(-90).max(90).describe('Center latitude in WGS84 decimal degrees.'),
    lon: z.number().min(-180).max(180).describe('Center longitude in WGS84 decimal degrees.'),
    radius_meters: z
      .number()
      .positive()
      .max(50000)
      .default(1000)
      .describe(
        'Search radius in meters. Max 50,000m (50km). Keep under 5,000m for dense urban POI queries to avoid slow responses.',
      ),
    amenity: z
      .string()
      .optional()
      .describe(
        'OSM amenity tag value (e.g., "hospital", "pharmacy", "restaurant", "school", "atm"). Shortcut for tag_key="amenity". Cannot be combined with tag_key/tag_value.',
      ),
    tag_key: z
      .string()
      .optional()
      .describe(
        'OSM tag key for non-amenity queries (e.g., "leisure", "shop", "highway", "natural"). Use with tag_value. Cannot be combined with amenity.',
      ),
    tag_value: z
      .string()
      .optional()
      .describe(
        'OSM tag value paired with tag_key (e.g., "park", "supermarket", "primary", "peak").',
      ),
    element_types: z
      .array(z.enum(['node', 'way', 'relation']))
      .default(['node', 'way'])
      .describe(
        'OSM element types to search. Ways cover most buildings and areas; nodes cover most standalone POIs. Add "relation" for complex structures like large campuses.',
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
      .describe('Overpass query timeout in seconds. Increase for large radius or dense areas.'),
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
            distance_meters: z
              .number()
              .optional()
              .describe(
                'Great-circle distance in meters from the query center, rounded to one decimal. Results are sorted ascending by this value; omitted for elements without a computed coordinate.',
              ),
            name: z.string().optional().describe('Feature name from OSM tags.'),
            tags: z
              .record(z.string(), z.string())
              .describe('All OSM tags for this feature. Values are always strings.'),
          })
          .describe('A single matching OSM feature.'),
      )
      .describe('Matching OSM features, up to the limit.'),
    total_found: z
      .number()
      .describe('Total features returned by Overpass before limit truncation.'),
    truncated: z
      .boolean()
      .describe(
        'True if results were cut at the limit. Reduce radius or add more specific tags to narrow the result set.',
      ),
    data_timestamp: z.string().describe('OSM data freshness timestamp from the Overpass response.'),
    attribution: z
      .string()
      .describe('Required data attribution: Data © OpenStreetMap contributors, ODbL 1.0.'),
  }),

  errors: [
    {
      reason: 'invalid_tag',
      code: JsonRpcErrorCode.ValidationError,
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
        'Reduce radius_meters, add more specific tag filters, or increase timeout_seconds and retry.',
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
    const resolved = resolveTagInput(input);
    if ('error' in resolved) {
      throw ctx.fail(
        'invalid_tag',
        resolved.error === 'both'
          ? 'Cannot combine amenity with tag_key/tag_value.'
          : 'Provide either amenity or tag_key + tag_value.',
        { ...ctx.recoveryFor('invalid_tag') },
      );
    }
    const { tagKey, tagValue } = resolved;

    const service = getOverpassService();
    const ql = service.buildAroundQuery({
      lat: input.lat,
      lon: input.lon,
      radiusMeters: input.radius_meters,
      tagKey,
      tagValue,
      elementTypes: input.element_types,
      timeoutSeconds: input.timeout_seconds,
    });

    const response = await service.query(ql, ctx);
    const allPois = service.normalizeElements(response.elements);
    // Attach great-circle distance from the query center, then sort nearest-first
    // BEFORE truncating so `limit` keeps the closest matches, not the lowest element IDs.
    const ranked = allPois
      .map((poi) => ({
        ...poi,
        distance_meters:
          poi.lat !== undefined && poi.lon !== undefined
            ? Math.round(haversineMeters(input.lat, input.lon, poi.lat, poi.lon) * 10) / 10
            : undefined,
      }))
      .sort((a, b) => {
        const da = a.distance_meters ?? Number.POSITIVE_INFINITY;
        const db = b.distance_meters ?? Number.POSITIVE_INFINITY;
        return da === db ? 0 : da < db ? -1 : 1;
      });
    const limited = ranked.slice(0, input.limit);

    const dataTimestamp = response.osm3s?.timestamp_osm_base ?? new Date().toISOString();

    ctx.log.info('Overpass nearby results', {
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
      if (el.distance_meters !== undefined) {
        lines.push(`**Distance:** ${el.distance_meters} m`);
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
