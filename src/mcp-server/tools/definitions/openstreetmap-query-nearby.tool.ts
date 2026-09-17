/**
 * @fileoverview Overpass nearby query tool — finds OSM features within a radius.
 * @module mcp-server/tools/definitions/openstreetmap-query-nearby.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { extractOverpassError, withoutCapturedBody } from '@/services/overpass/overpass-error.js';
import { getOverpassService, haversineMeters } from '@/services/overpass/overpass-service.js';
import { escapeMarkdownText } from './openstreetmap-markdown-escape.js';
import {
  invalidTagMessage,
  resolveTagInput,
  TAG_MODE_SCHEMA_META,
} from './openstreetmap-tag-input.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

export const openstreetmapQueryNearby = tool('openstreetmap_query_nearby', {
  title: 'Find OSM features near a point',
  description:
    'Find OSM features within a radius of a point via the Overpass API, the tool for "what is near X?" questions. Filter with amenity, or with tag_key plus an optional tag_value, ANDing up to five more filters; every feature returns with its full OSM tag set (no extratags flag here), sorted nearest-first by distance_meters, with nodes covering standalone POIs and ways covering buildings and areas.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z
    .object({
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
          'OSM amenity tag value (e.g. "hospital", "pharmacy", "restaurant", "atm"), shortcut for tag_key="amenity". Exactly one primary mode is required: this or tag_key, never both.',
        ),
      tag_key: z
        .string()
        .optional()
        .describe(
          'Primary OSM tag key (e.g. "leisure", "shop", "highway"); omit tag_value to match any feature carrying the key, or supply it for exact equality. The alternative to amenity, never both. Additional filters are ANDed with this tag.',
        ),
      tag_value: z
        .string()
        .optional()
        .describe(
          'Literal value paired with tag_key for exact equality (e.g., "park", "supermarket"); omit for key existence. Explicit empty or whitespace-only values are invalid. Keys and values are trimmed; blank unused fields are ignored in amenity mode.',
        ),
      filters: z
        .array(
          z
            .object({
              key: z
                .string()
                .describe(
                  'Literal OSM tag key. Trimmed and nonblank; must be unique across the primary tag and all filters.',
                ),
              value: z
                .string()
                .optional()
                .describe(
                  'Literal exact-match value. Omit for key existence; an explicitly blank value is invalid. Trimmed before matching.',
                ),
            })
            .strict()
            .describe('One additional literal equality or key-existence filter.'),
        )
        .max(5)
        .optional()
        .describe(
          'Up to five additional filters, ANDed with the required primary amenity or tag_key filter in input order. Omitted or [] adds no conditions. Keys must be unique after trimming; keys and values must not contain Overpass QL metacharacters (" \\ [ ] ; ( )).',
        ),
      element_types: z
        .array(z.enum(['node', 'way', 'relation']))
        .min(1)
        .default(['node', 'way'])
        .describe(
          'OSM element types to search, at least one. Ways cover most buildings and areas; nodes cover most standalone POIs. Add "relation" for complex structures like large campuses. Omit the field to search nodes and ways; an empty array is rejected because it can only match nothing.',
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
    })
    // Advertises "amenity, or tag_key" in the published inputSchema.
    // `.strict()` is declared here rather than left to the framework: `tool()` applies it
    // to a default-mode input itself, and Zod's `.strict()` returns a fresh instance that
    // is not in the metadata registry, dropping the `anyOf` before it reaches the wire.
    // Declaring it first means `.meta()` lands on the schema the framework keeps.
    .strict()
    .meta(TAG_MODE_SCHEMA_META),

  output: z.object({
    elements: z
      .array(
        z
          .object({
            osm_type: z.enum(['node', 'way', 'relation']).describe('OSM element type.'),
            osm_id: z
              .number()
              .describe('OSM element ID. Use with osm_type for openstreetmap_lookup_objects.'),
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

  // Agent-facing context: resolved tag filter, result-set counts, and empty-result guidance.
  // Reaches both structuredContent and content[] without a format() entry.
  enrichment: {
    effectiveTag: z
      .string()
      .describe(
        'The full ordered AND filter chain: key=value for equality, key alone for existence (e.g. "amenity=restaurant, cuisine=italian, name").',
      ),
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
        'Why this page is empty and what to try: nothing matched (widen the radius or change the tag), or offset ran past the end (retry lower). Absent when results were returned.',
      ),
  },

  enrichmentTrailer: {
    effectiveTag: { label: 'Tag Filter' },
    totalFound: { label: 'Total Found' },
    truncated: { label: 'Results Truncated' },
    nextOffset: { label: 'Next Offset' },
    servingEndpoint: { label: 'Served By' },
  },

  errors: [
    {
      reason: 'invalid_tag',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Tag modes conflict or are missing, a key or supplied value is blank, keys repeat after trimming, or a filter carries Overpass QL metacharacters.',
      recovery:
        'Provide either amenity (e.g., "hospital") or tag_key (e.g., "shop"); omit tag_value for key existence or supply a nonblank literal value for equality. Use at most five additional filters with unique trimmed keys; omit an entry value for existence, never send a blank value. Tag keys and values must be literal text without Overpass QL metacharacters (" \\ [ ] ; ( )); use openstreetmap_query_raw for arbitrary Overpass QL.',
    },
    {
      reason: 'query_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The query exceeded timeout_seconds.',
      retryable: false,
      recovery:
        'Reduce radius_meters, add more specific tag filters, or increase timeout_seconds and retry.',
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass ran out of memory on this query.',
      recovery:
        'Narrow the query: reduce radius_meters, add more specific tag filters, or limit element_types.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every configured endpoint refused the query as throttled — HTTP 429, or a throttle document in place of JSON.',
      retryable: true,
      recovery:
        'Every configured endpoint refused this query, so an immediate retry will not reach a free slot — wait a few seconds first. Reduce concurrent calls, set OSM_OVERPASS_MAX_CONCURRENCY to the slot budget the endpoint advertises at /api/status, add a mirror to OSM_OVERPASS_ENDPOINTS, or switch to a private Overpass instance via OSM_OVERPASS_BASE_URL.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass reported a runtime error that is neither a timeout nor memory exhaustion.',
      recovery:
        'Read the Overpass remark carried verbatim in the message: it names the fault. Retry in a minute when it points at the dispatcher or database being unavailable; otherwise adjust the query it describes.',
    },
    {
      reason: 'overpass_gateway_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: "Overpass answered HTTP 504 — the query exceeded the endpoint's own time budget, not timeout_seconds.",
      retryable: true,
      recovery:
        'Shrink the work per query: reduce radius_meters, add more specific tag filters, or narrow element_types, then retry. The endpoint budget is fixed, so raising timeout_seconds alone will not clear a 504.',
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
        'Shrink the work per query — reduce radius_meters, add more specific tag filters, or narrow element_types — then retry; the message names each endpoint and the window it was given, and every one was too slow for a query this size. Raising timeout_seconds widens each window. Listing a healthy mirror in OSM_OVERPASS_ENDPOINTS gives the retry a second server to reach.',
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
    const resolved = resolveTagInput(input);
    if ('error' in resolved) {
      throw ctx.fail('invalid_tag', invalidTagMessage(resolved.error), {
        ...ctx.recoveryFor('invalid_tag'),
      });
    }
    const effectiveTag = [resolved, ...(resolved.filters ?? [])]
      .map(({ tagKey, tagValue }) => (tagValue === undefined ? tagKey : `${tagKey}=${tagValue}`))
      .join(', ');

    const service = getOverpassService();
    const ql = service.buildAroundQuery({
      lat: input.lat,
      lon: input.lon,
      radiusMeters: input.radius_meters,
      ...resolved,
      elementTypes: input.element_types,
      timeoutSeconds: input.timeout_seconds,
    });

    const response = await service.query(ql, ctx).catch((err) => {
      if (err instanceof McpError) {
        const data = err.data as Record<string, unknown> | undefined;
        const reason = data?.reason as string | undefined;
        const status = data?.status;
        // HTTP status errors arrive without a reason — remap by status.
        if (!reason && status === 429) {
          throw ctx.fail('rate_limited', err.message, { ...ctx.recoveryFor('rate_limited') });
        }
        if (!reason && typeof status === 'number' && status >= 500) {
          /**
           * Constructed rather than routed through ctx.fail: fail() rewrites the
           * code to the contract's declared one, which would collapse the 504
           * Timeout (-32004) and the 5xx ServiceUnavailable (-32000) onto one
           * value. Only reason and the recovery hint are added here, so the
           * status-mapped code reaches the client intact.
           */
          const remapped = status === 504 ? 'overpass_gateway_timeout' : 'overpass_unavailable';
          // Overpass names the fault in the 5xx body ("runtime error: ... Probably
          // the server is overloaded."); it belongs in the message, not as an XHTML
          // document the agent has to parse out of the error data.
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
        if (
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

    const dataTimestamp = response.osm3s?.timestamp_osm_base;

    ctx.log.info('Overpass nearby results', {
      total: allPois.length,
      returned: limited.length,
    });

    ctx.enrich({
      effectiveTag,
      totalFound: allPois.length,
      truncated,
      ...(response.servedBy ? { servingEndpoint: response.servedBy } : {}),
    });
    if (truncated) {
      ctx.enrich({ nextOffset: input.offset + limited.length });
    }
    if (limited.length === 0) {
      const total = allPois.length;
      if (total === 0) {
        ctx.enrich.notice(
          `No ${effectiveTag} features found within ${input.radius_meters}m. Try a larger radius_meters, a different tag, or verify the coordinates.`,
        );
      } else {
        // An empty page with matches upstream means the offset ran past the last
        // page — a paging mistake. Telling the caller to widen the search would
        // send them to correct a query that already worked.
        //
        // #70: the last-page offset is `total - limit`, which floors to 0 once
        // the whole match set fits in one page — offering offset 0 twice as if
        // the two were alternatives. There is only one page to go back to.
        const retry =
          total <= input.limit
            ? `, which fit in one page of ${input.limit}. Retry with offset 0.`
            : `. Retry with offset ${total - input.limit} for the last page, or offset 0 for the nearest matches.`;
        ctx.enrich.notice(
          `Offset ${input.offset} is past the end of the result set: ${total} ${effectiveTag} feature${total === 1 ? '' : 's'} matched within ${input.radius_meters}m${retry}`,
        );
      }
    }

    return {
      elements: limited,
      ...(dataTimestamp ? { data_timestamp: dataTimestamp } : {}),
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const count = result.elements.length;
    const lines: string[] = [`**${count} feature${count === 1 ? '' : 's'} returned**`];
    if (result.data_timestamp) {
      lines.push(`**Data as of:** ${result.data_timestamp}`);
    }
    lines.push('');
    for (const el of result.elements) {
      const nameStr = el.name ? escapeMarkdownText(el.name) : 'Unnamed';
      lines.push(`## ${nameStr}`);
      lines.push(`**OSM:** ${el.osm_type.charAt(0).toUpperCase()}${el.osm_id}`);
      if (el.lat !== undefined && el.lon !== undefined) {
        lines.push(`**Coordinates:** ${el.lat}, ${el.lon}`);
      }
      if (el.distance_meters !== undefined) {
        lines.push(`**Distance:** ${el.distance_meters} m`);
      }
      const tagEntries = Object.entries(el.tags)
        .map(([k, v]) => `${escapeMarkdownText(k)}=${escapeMarkdownText(v)}`)
        .join(', ');
      if (tagEntries) lines.push(`**Tags:** ${tagEntries}`);
      lines.push('');
    }
    lines.push(`*${result.attribution}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
