/**
 * @fileoverview Overpass area query tool — finds OSM features inside a bbox or an OSM boundary.
 * @module mcp-server/tools/definitions/openstreetmap-query-bbox.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { extractOverpassError, withoutCapturedBody } from '@/services/overpass/overpass-error.js';
import { getOverpassService } from '@/services/overpass/overpass-service.js';
import type { OverpassAreaRef } from '@/services/overpass/types.js';
import { escapeMarkdownText } from './openstreetmap-markdown-escape.js';
import { crossTagModes, invalidTagMessage, resolveTagInput } from './openstreetmap-tag-input.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

/** The four corner fields, in the order the bounding-box mode requires them. */
const CORNER_FIELDS = ['south', 'west', 'north', 'east'] as const;

/**
 * Overpass area id for a relation. Stable and documented; the way counterpart
 * (`2400000000 + id`) was removed in Overpass 0.7.57, which is why the generated query
 * uses `map_to_area` rather than arithmetic. Kept only to name the id in `effectiveArea`,
 * so a caller moving the same scope to openstreetmap_query_raw has it in hand.
 */
const RELATION_AREA_ID_OFFSET = 3_600_000_000;

/** The call's spatial scope once resolved — exactly one of the two modes. */
type ResolvedScope =
  | { areaRef: OverpassAreaRef; ref: string; label: string; effectiveArea: string }
  | { box: { south: number; west: number; north: number; east: number }; label: string };

/**
 * Resolve the spatial scope: one OSM boundary ref, or the complete four-corner box.
 *
 * The schema's `anyOf` advertises the two modes but enforces neither — the same division
 * `resolveTagInput` holds for the tag modes — so this is the only enforcement point, and
 * it rejects a partial corner set as well as the two obvious conflicts.
 */
function resolveScope(input: {
  within?: string | undefined;
  south?: number | undefined;
  west?: number | undefined;
  north?: number | undefined;
  east?: number | undefined;
}): ResolvedScope | { error: string } {
  const supplied = CORNER_FIELDS.filter((field) => input[field] !== undefined);
  const ref = input.within?.toUpperCase();

  if (ref) {
    if (supplied.length > 0) {
      return {
        error: `within (${ref}) cannot be combined with the corner field${supplied.length === 1 ? '' : 's'} ${supplied.join(', ')}.`,
      };
    }
    const kind = ref.startsWith('R') ? 'relation' : 'way';
    const osmId = Number(ref.slice(1));
    return {
      areaRef: { kind, osmId },
      ref,
      label: `inside ${ref}`,
      effectiveArea:
        kind === 'relation'
          ? `${ref} → Overpass area ${RELATION_AREA_ID_OFFSET + osmId} (relation ${osmId})`
          : `${ref} → Overpass area of closed way ${osmId}`,
    };
  }

  const { south, west, north, east } = input;
  if (south === undefined || west === undefined || north === undefined || east === undefined) {
    const missing = CORNER_FIELDS.filter((field) => input[field] === undefined);
    return {
      error:
        supplied.length === 0
          ? 'No scope given. Supply within with an OSM boundary ref (R for a relation, W for a closed way), or all four corner fields: south, west, north, east.'
          : `Incomplete bounding box — ${missing.join(', ')} missing. Supply all four corner fields, or use within with an OSM boundary ref instead.`,
    };
  }
  return { box: { south, west, north, east }, label: 'in the specified bounding box' };
}

export const openstreetmapQueryBbox = tool('openstreetmap_query_bbox', {
  title: 'Find OSM features inside a bounding box or an OSM boundary',
  description:
    'Find OSM features inside an area via the Overpass API, under one of two scopes: a rectangular bounding box (south, west, north, east), or within — a single OSM boundary ref such as a city relation or a park way, which scopes to the boundary itself where its bounding box overcovers with water and neighbouring places. Exactly one scope per call. ' +
    'Useful for area surveys where you want everything in a region, not proximity searches. ' +
    'Use amenity for common POI types (hospital, pharmacy, cafe, school, etc.) ' +
    'or tag_key with an optional tag_value for other OSM categories (leisure=park, shop=supermarket, natural=peak). ' +
    'Every feature includes its full OSM tag set; the extratags flag (used by the Nominatim-backed openstreetmap_search_places, openstreetmap_reverse_geocode, and openstreetmap_lookup_objects tools) does not apply here. ' +
    'For proximity searches centered on a point, use openstreetmap_query_nearby instead.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z
    .object({
      within: z
        .string()
        .regex(/^[RWrw]\d+$/)
        .optional()
        .describe(
          'OSM boundary to search inside, as one ref: R plus a relation id ("R237385", Seattle) or W plus a closed-way id ("W13800188", a park), case-insensitive. Take it from osm_type plus osm_id on openstreetmap_search_places, openstreetmap_reverse_geocode, or openstreetmap_lookup_objects. The alternative to the four corner fields, never both. A node ref is rejected: a node is never an area. A ref that maps to no Overpass area returns an empty page whose notice names the cause.',
        ),
      south: z
        .number()
        .min(-90)
        .max(90)
        .optional()
        .describe(
          'Southern boundary latitude (minimum latitude). One of four corner fields: supply all four, or use within instead.',
        ),
      west: z
        .number()
        .min(-180)
        .max(180)
        .optional()
        .describe(
          'Western boundary longitude (minimum longitude). A west greater than east is valid, not an error: Overpass reads it as an antimeridian-crossing box and returns the union of west..180 and -180..east.',
        ),
      north: z
        .number()
        .min(-90)
        .max(90)
        .optional()
        .describe('Northern boundary latitude (maximum latitude).'),
      east: z
        .number()
        .min(-180)
        .max(180)
        .optional()
        .describe(
          'Eastern boundary longitude (maximum longitude). A value below west describes an antimeridian crossing rather than an inverted box.',
        ),
      amenity: z
        .string()
        .optional()
        .describe(
          'OSM amenity tag value shortcut (e.g. "cafe", "bench", "hospital"). Exactly one primary mode is required: this or tag_key, never both.',
        ),
      tag_key: z
        .string()
        .optional()
        .describe(
          'Primary OSM tag key (e.g. "leisure", "shop", "natural"); omit tag_value to match any feature carrying the key, or supply it for exact equality. The alternative to amenity, never both. Additional filters are ANDed with this tag.',
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
          'OSM element types to search, at least one. Ways cover most buildings and areas; nodes cover most standalone POIs. Add "relation" for complex structures. Omit the field to search nodes and ways; an empty array is rejected because it can only match nothing.',
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
    })
    // Advertises "(four corners, or within) and (amenity, or tag_key)" in the published inputSchema.
    // `.strict()` is declared here rather than left to the framework: `tool()` applies it
    // to a default-mode input itself, and Zod's `.strict()` returns a fresh instance that
    // is not in the metadata registry, dropping the `anyOf` before it reaches the wire.
    // Declaring it first means `.meta()` lands on the schema the framework keeps.
    .strict()
    .meta(crossTagModes([CORNER_FIELDS, ['within']])),

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
      .describe(
        'Matching OSM features inside the requested scope — the bounding box, or the within boundary — up to the limit.',
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

  // Agent-facing context: resolved tag filter, result-set counts, and empty-result guidance.
  // Reaches both structuredContent and content[] without a format() entry.
  enrichment: {
    effectiveTag: z
      .string()
      .describe(
        'The full ordered AND filter chain: key=value for equality, key alone for existence (e.g. "amenity=restaurant, cuisine=italian, name").',
      ),
    effectiveArea: z
      .string()
      .optional()
      .describe(
        'The boundary scope as resolved: the within ref and the Overpass area it mapped to. Absent when the call used the four corner fields.',
      ),
    areasTimestamp: z
      .string()
      .optional()
      .describe(
        'Freshness of the Overpass area database, rebuilt on its own schedule and so lagging data_timestamp — a boundary edited since is scoped against its older polygon. Present only on a within call whose endpoint reported it.',
      ),
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
        'Overpass endpoint that answered, as origin and path. May name a failover mirror, or the endpoint that originally served a cached response. Read with data_timestamp when a result looks slow, sparse, or stale.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Why this page is empty and what to try: the within ref resolved to no Overpass area, nothing matched (change the scope or tag), or offset ran past the end (retry lower). Absent when results were returned.',
      ),
  },

  enrichmentTrailer: {
    effectiveTag: { label: 'Tag Filter' },
    effectiveArea: { label: 'Scope' },
    areasTimestamp: { label: 'Areas Data As Of' },
    totalFound: { label: 'Total Found' },
    truncated: { label: 'Results Truncated' },
    nextOffset: { label: 'Next Offset' },
    servingEndpoint: { label: 'Served By' },
  },

  errors: [
    {
      reason: 'invalid_scope',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The two spatial scopes conflict: within sent alongside a corner field, neither scope sent, or only part of the four-corner set sent.',
      recovery:
        'Choose one scope and give it whole: either all four corner fields (south, west, north, east), or within carrying a single OSM boundary ref — R for a relation, W for a closed way. Never both, and never a partial corner set.',
    },
    {
      reason: 'invalid_bbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'south exceeds north — the latitude bounds are inverted.',
      recovery:
        'Order the bounds so south is at most north (south is the minimum latitude, north the maximum); a west greater than east is valid and describes an antimeridian-crossing box.',
    },
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
        'Reduce the bounding box area, add more specific tag filters, or increase timeout_seconds and retry.',
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass ran out of memory on this query.',
      recovery:
        'Narrow the query: reduce the bounding box area, add more specific tag filters, or limit element_types.',
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
        'Shrink the work per query: reduce the bounding box area, add more specific tag filters, or narrow element_types, then retry. The endpoint budget is fixed, so raising timeout_seconds alone will not clear a 504.',
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
        'Shrink the work per query: reduce the bounding box area, add more specific tag filters, or narrow element_types, then retry — the message names each endpoint and the window it was given, and every one was too slow for a query this size. Raising timeout_seconds widens each window. Listing a healthy mirror in OSM_OVERPASS_ENDPOINTS gives the retry a second server to reach.',
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
    const scope = resolveScope(input);
    if ('error' in scope) {
      throw ctx.fail('invalid_scope', scope.error, { ...ctx.recoveryFor('invalid_scope') });
    }

    /**
     * Reject latitude-inverted boxes before hitting Overpass (it returns a bare
     * HTTP 400). Only south > north is invalid; west > east is a legitimate
     * antimeridian crossing, so it must pass through untouched. Verified against
     * the default endpoint: a crossing box returns exactly the union of its two
     * non-crossing halves, not the complement a coordinate swap would scan.
     */
    if ('box' in scope && scope.box.south > scope.box.north) {
      throw ctx.fail(
        'invalid_bbox',
        `Inverted bounding box: south (${scope.box.south}) exceeds north (${scope.box.north}).`,
        { ...ctx.recoveryFor('invalid_bbox') },
      );
    }

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
    const common = {
      ...resolved,
      elementTypes: input.element_types,
      timeoutSeconds: input.timeout_seconds,
    };
    const ql =
      'areaRef' in scope
        ? service.buildAreaQuery({ areaRef: scope.areaRef, ...common })
        : service.buildBboxQuery({ ...scope.box, ...common });

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
    /**
     * A `within` query carries an `out count;` sentinel ahead of its matches, which is the
     * only thing separating "this ref maps to no area" from "the boundary resolved and
     * nothing matched" — Overpass answers both with HTTP 200, an empty list, and no remark.
     */
    const areaScope = 'areaRef' in scope ? service.readAreaScope(response.elements) : undefined;
    const allPois = service.normalizeElements(areaScope?.elements ?? response.elements);
    const limited = allPois.slice(input.offset, input.offset + input.limit);
    const truncated = allPois.length > input.offset + input.limit;

    const dataTimestamp = response.osm3s?.timestamp_osm_base;
    const areasTimestamp = response.osm3s?.timestamp_areas_base;

    ctx.log.info('Overpass bbox results', {
      total: allPois.length,
      returned: limited.length,
    });

    ctx.enrich({
      effectiveTag,
      totalFound: allPois.length,
      truncated,
      ...('areaRef' in scope ? { effectiveArea: scope.effectiveArea } : {}),
      ...('areaRef' in scope && areasTimestamp ? { areasTimestamp } : {}),
      ...(response.servedBy ? { servingEndpoint: response.servedBy } : {}),
    });
    if (truncated) {
      ctx.enrich({ nextOffset: input.offset + limited.length });
    }

    if (limited.length === 0) {
      const total = allPois.length;
      if (areaScope && !areaScope.resolved && 'ref' in scope) {
        // Never a bare zero: a ref that reached no area is a different problem from a
        // boundary that holds nothing, and sends the caller somewhere else entirely.
        ctx.enrich.notice(
          `Boundary ${scope.ref} did not resolve to an Overpass area, so nothing can be inside it — the ref may name an id that does not exist, an unclosed way, or a relation without a boundary or area-forming tag. Verify it with openstreetmap_lookup_objects, or scope with the four corner fields instead.`,
        );
      } else if (total === 0) {
        ctx.enrich.notice(
          `No ${effectiveTag} features found ${scope.label}. ${
            'areaRef' in scope
              ? 'Try a different tag, or a boundary that encloses more.'
              : 'Try a larger bbox, a different tag, or verify the coordinates.'
          }`,
        );
      } else {
        // An empty page with matches upstream means the offset ran past the last
        // page — a paging mistake. Telling the caller to widen the scope would send
        // them to correct a query that already worked.
        //
        // #70: the last-page offset is `total - limit`, which floors to 0 once
        // the whole match set fits in one page — offering offset 0 twice as if
        // the two were alternatives. There is only one page to go back to.
        const retry =
          total <= input.limit
            ? `, which fit in one page of ${input.limit}. Retry with offset 0.`
            : `. Retry with offset ${total - input.limit} for the last page, or offset 0 for the first.`;
        ctx.enrich.notice(
          `Offset ${input.offset} is past the end of the result set: ${total} ${effectiveTag} feature${total === 1 ? '' : 's'} matched ${scope.label}${retry}`,
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
