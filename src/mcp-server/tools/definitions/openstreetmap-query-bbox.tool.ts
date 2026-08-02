/**
 * @fileoverview Overpass bounding box query tool — finds OSM features within a bbox.
 * @module mcp-server/tools/definitions/openstreetmap-query-bbox.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { extractOverpassError, withoutCapturedBody } from '@/services/overpass/overpass-error.js';
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
    'Every feature includes its full OSM tag set; the extratags flag (used by the Nominatim-backed openstreetmap_search_places, openstreetmap_reverse_geocode, and openstreetmap_lookup_objects tools) does not apply here. ' +
    'For proximity searches centered on a point, use openstreetmap_query_nearby instead.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    south: z.number().min(-90).max(90).describe('Southern boundary latitude (minimum latitude).'),
    west: z
      .number()
      .min(-180)
      .max(180)
      .describe(
        'Western boundary longitude (minimum longitude). A west greater than east is valid, not an error: Overpass reads it as an antimeridian-crossing box and returns the union of west..180 and -180..east.',
      ),
    north: z.number().min(-90).max(90).describe('Northern boundary latitude (maximum latitude).'),
    east: z
      .number()
      .min(-180)
      .max(180)
      .describe(
        'Eastern boundary longitude (maximum longitude). A value below west describes an antimeridian crossing rather than an inverted box.',
      ),
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
              .describe('OSM element ID. Use with osm_type for openstreetmap_lookup_objects.'),
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
        'Guidance when the page came back empty. Distinguishes a query that matched nothing (try a different bounding box or tag) from an offset past the end of a non-empty result set (retry at a lower offset). Absent when results were returned.',
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
      when: 'Overpass refused the query as throttled — HTTP 429, or a throttle document instead of JSON — on every configured endpoint. With a list in OSM_OVERPASS_ENDPOINTS the call advances to the next entry first, so this surfaces only once all of them have refused it.',
      retryable: true,
      recovery:
        'Every configured endpoint refused this query, so an immediate retry will not reach a free slot — wait a few seconds first. Reduce concurrent calls, set OSM_OVERPASS_MAX_CONCURRENCY to the slot budget the endpoint advertises at /api/status, add a mirror to OSM_OVERPASS_ENDPOINTS, or switch to a private Overpass instance via OSM_OVERPASS_BASE_URL.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass reported a runtime error that is neither a timeout nor memory exhaustion — the message carries the remark verbatim.',
      recovery:
        'Read the Overpass remark in the message: it names the fault. Retry in a minute when it points at the dispatcher or database being unavailable; otherwise adjust the query it describes.',
    },
    {
      reason: 'overpass_gateway_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Overpass answered HTTP 504 — it accepted the query but its dispatcher gave up before producing a result, so the query exceeded the time budget the endpoint enforces rather than timeout_seconds.',
      retryable: true,
      recovery:
        'Shrink the work per query: reduce the bounding box area, add more specific tag filters, or drop element_types, then retry. The endpoint budget is fixed, so raising timeout_seconds alone will not clear a 504.',
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
        'Shrink the work per query: reduce the bounding box area, add more specific tag filters, or drop element_types, then retry; every endpoint tried was too slow to answer a query this size. Listing a healthy mirror in OSM_OVERPASS_ENDPOINTS gives the retry a second server to reach.',
    },
  ],

  async handler(input, ctx) {
    /**
     * Reject latitude-inverted boxes before hitting Overpass (it returns a bare
     * HTTP 400). Only south > north is invalid; west > east is a legitimate
     * antimeridian crossing, so it must pass through untouched. Verified against
     * the default endpoint: a crossing box returns exactly the union of its two
     * non-crossing halves, not the complement a coordinate swap would scan.
     */
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
          reason === 'endpoints_exhausted'
        ) {
          throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
        }
      }
      throw err;
    });
    const allPois = service.normalizeElements(response.elements);
    const limited = allPois.slice(input.offset, input.offset + input.limit);
    const truncated = allPois.length > input.offset + input.limit;

    const dataTimestamp = response.osm3s?.timestamp_osm_base;

    ctx.log.info('Overpass bbox results', {
      total: allPois.length,
      returned: limited.length,
    });

    ctx.enrich({
      effectiveTag: `${tagKey}=${tagValue}`,
      totalFound: allPois.length,
      truncated,
      ...(response.servedBy ? { servingEndpoint: response.servedBy } : {}),
    });
    if (truncated) {
      ctx.enrich({ nextOffset: input.offset + limited.length });
    }
    if (limited.length === 0) {
      // An empty page with matches upstream means the offset ran past the last
      // page — a paging mistake. Telling the caller to widen the box would send
      // them to correct a query that already worked.
      ctx.enrich.notice(
        allPois.length === 0
          ? `No ${tagKey}=${tagValue} features found in the specified bounding box. Try a larger bbox, a different tag, or verify the coordinates.`
          : `Offset ${input.offset} is past the end of the result set: ${allPois.length} ${tagKey}=${tagValue} feature${allPois.length === 1 ? '' : 's'} matched in the specified bounding box. Retry with offset ${Math.max(0, allPois.length - input.limit)} for the last page, or offset 0 for the first.`,
      );
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
