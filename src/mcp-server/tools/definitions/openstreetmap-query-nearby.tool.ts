/**
 * @fileoverview Overpass nearby query tool — finds OSM features within a radius.
 * @module mcp-server/tools/definitions/openstreetmap-query-nearby.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getOverpassService, haversineMeters } from '@/services/overpass/overpass-service.js';
import { invalidTagMessage, resolveTagInput } from './openstreetmap-tag-input.js';

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
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Number of matching features to skip before applying limit, for paging through a large result set. Features are distance-sorted before paging, so higher offsets return progressively farther matches; the full set is cached ~10 minutes so re-paging costs no extra upstream request. Pass the nextOffset value from a prior truncated response.',
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
        'True if results were cut at the limit. Reduce radius, add more specific tags, or page with offset to retrieve the rest.',
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
        'Guidance when no features were found — e.g., try a larger radius or different tag. Absent when results were returned.',
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
        'Reduce radius_meters, add more specific tag filters, or increase timeout_seconds and retry.',
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass ran out of memory — the result set exceeds the server memory limit.',
      recovery:
        'Narrow the query: reduce radius_meters, add more specific tag filters, or limit element_types.',
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
      throw ctx.fail('invalid_tag', invalidTagMessage(resolved.error), {
        ...ctx.recoveryFor('invalid_tag'),
      });
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

    const response = await service.query(ql, ctx).catch((err) => {
      if (err instanceof McpError) {
        const data = err.data as Record<string, unknown> | undefined;
        const reason = data?.reason as string | undefined;
        // fetchWithTimeout throws RateLimited (no reason) for HTTP 429 — remap to rate_limited
        if (!reason && data?.statusCode === 429) {
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
    const limited = ranked.slice(input.offset, input.offset + input.limit);
    const truncated = allPois.length > input.offset + input.limit;

    const dataTimestamp = response.osm3s?.timestamp_osm_base ?? new Date().toISOString();

    ctx.log.info('Overpass nearby results', {
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
        `No ${tagKey}=${tagValue} features found within ${input.radius_meters}m. Try a larger radius_meters, a different tag, or verify the coordinates.`,
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
