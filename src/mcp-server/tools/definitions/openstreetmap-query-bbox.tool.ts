/**
 * @fileoverview Overpass area query tool — finds OSM features inside a bbox or an OSM boundary.
 * @module mcp-server/tools/definitions/openstreetmap-query-bbox.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline as escapeMarkdownText } from '@cyanheads/mcp-ts-core/utils';
import {
  extractOverpassError,
  overpassStatusReason,
  withoutCapturedBody,
} from '@/services/overpass/overpass-error.js';
import { getOverpassService } from '@/services/overpass/overpass-service.js';
import type { OverpassAreaRef, OverpassBoundaryTags } from '@/services/overpass/types.js';
import { clampLimit, limitNoticeField } from './openstreetmap-limit.js';
import {
  AREA_REF_PATTERN,
  existenceCheckQuery,
  MAX_OSM_ID,
  parseOsmRef,
} from './openstreetmap-osm-ids.js';
import { tagRetryHint } from './openstreetmap-tag-hint.js';
import {
  crossTagModes,
  describeTagChain,
  invalidTagMessage,
  resolveTagInput,
} from './openstreetmap-tag-input.js';
import {
  effectiveTagKeysField,
  projectTags,
  resolveTagKeys,
  tagKeysInput,
} from './openstreetmap-tag-keys.js';
import {
  rankByTag,
  resolveTagSort,
  sortByInput,
  unrankedCountField,
} from './openstreetmap-tag-sort.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

/** Features served per page; a larger limit is clamped to it. */
const MAX_PAGE = 500;

/** The four corner fields, in the order the bounding-box mode requires them. */
const CORNER_FIELDS = ['south', 'west', 'north', 'east'] as const;

/**
 * What a `within` value that is not an area ref is told: the forms it accepts, in place of the
 * pattern itself, which is too long to read as an answer.
 */
const AREA_REF_FORMS =
  'Expected one way or relation ref: R or W plus the id ("R237385"), the object path ("relation/237385"), or its openstreetmap.org URL. A node is never an area.';

/**
 * Overpass area id for a relation. Stable and documented; the way counterpart
 * (`2400000000 + id`) was removed in Overpass 0.7.57, which is why the generated query
 * uses `map_to_area` rather than arithmetic. Kept only to name the id in `effectiveArea`,
 * so a caller moving the same scope to openstreetmap_query_raw has it in hand. A bigint, as
 * the id it is added to can pass 2^53.
 */
const RELATION_AREA_ID_OFFSET = 3_600_000_000n;

/** The call's spatial scope once resolved — exactly one of the two modes. */
type ResolvedScope =
  | { areaRef: OverpassAreaRef; ref: string; label: string }
  | { box: { south: number; west: number; north: number; east: number }; label: string };

/**
 * `effectiveArea` for a `within` call: the ref, the boundary it reached (#117) — its name, then
 * its boundary and admin_level tags, whichever it carries — and the Overpass area it mapped
 * to. A boundary carrying none of the three, or a ref that reached no area, reads as the ref
 * and the area alone, with no name or tags between them.
 */
function describeArea(
  ref: string,
  { kind, osmId }: OverpassAreaRef,
  tags: OverpassBoundaryTags,
): string {
  const classes = (['boundary', 'admin_level'] as const).flatMap((key) =>
    tags[key] ? [`${key}=${tags[key]}`] : [],
  );
  const named = [ref, tags.name, classes.length > 0 ? `(${classes.join(', ')})` : '']
    .filter((part) => part)
    .join(' ');
  return kind === 'relation'
    ? `${named} → Overpass area ${RELATION_AREA_ID_OFFSET + BigInt(osmId)} (relation ${osmId})`
    : `${named} → Overpass area of closed way ${osmId}`;
}

/**
 * Resolve the spatial scope: one OSM boundary ref, or the complete four-corner box.
 *
 * The schema's `anyOf` advertises the two modes but enforces neither — the same division
 * `resolveTagInput` holds for the tag modes — so this is the only enforcement point, and
 * it rejects a partial corner set as well as the two obvious conflicts. The schema checks the
 * ref's form; its id's range is checked here, before any query is built. That range starts at
 * 1 (#129): Overpass rejects `rel(0)` with HTTP 400. `parseOsmRef` still accepts 0, since
 * `openstreetmap_lookup_objects` sends it to Nominatim, whose not-found is the right answer.
 */
function resolveScope(input: {
  within?: string | undefined;
  south?: number | undefined;
  west?: number | undefined;
  north?: number | undefined;
  east?: number | undefined;
}): ResolvedScope | { error: string } {
  const supplied = CORNER_FIELDS.filter((field) => input[field] !== undefined);

  // An empty within is a form client's untouched field, and reads as no ref at all.
  if (input.within) {
    const parsed = parseOsmRef(input.within, AREA_REF_PATTERN);
    if (parsed.kind !== 'ref') {
      return {
        error:
          parsed.kind === 'out_of_range'
            ? `within (${input.within.trim()}) names an id above ${MAX_OSM_ID}, the largest an OSM object can carry.`
            : AREA_REF_FORMS,
      };
    }
    const { ref } = parsed;
    const osmId = ref.slice(1);
    if (osmId === '0') {
      return { error: `within (${input.within.trim()}) names id 0, but OSM ids start at 1.` };
    }
    if (supplied.length > 0) {
      return {
        error: `within (${ref}) cannot be combined with the corner field${supplied.length === 1 ? '' : 's'} ${supplied.join(', ')}.`,
      };
    }
    return {
      areaRef: { kind: ref.startsWith('R') ? 'relation' : 'way', osmId },
      ref,
      label: `inside ${ref}`,
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
    'Find OSM features inside an area via the Overpass API, for surveys of everything in a region (openstreetmap_query_nearby covers proximity to a point). Scope with the four corner fields south, west, north, east, or with within and a single OSM boundary ref such as a city relation or a park way, which searches the boundary polygon itself instead of an overcovering box; never both. Filter with amenity, or with tag_key plus an optional tag_value, ANDing up to five more filters; every feature returns with its full OSM tag set (no extratags flag here) or the keys tag_keys lists.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z
    .object({
      // The empty-string variant keeps a form client's untouched field acceptable beside the
      // four corners; resolveScope reads it as no ref.
      within: z
        .union([
          z.literal(''),
          z
            .string()
            .regex(AREA_REF_PATTERN, { error: AREA_REF_FORMS })
            .describe('One way or relation ref, path, or openstreetmap.org URL.'),
        ])
        .optional()
        .describe(
          'OSM boundary to search inside, as one ref: R plus a relation id ("R237385", Seattle) or W plus a closed-way id ("W13800188", a park), case-insensitive, or the object path ("relation/237385") or its openstreetmap.org URL. Take it from osm_type plus osm_id on openstreetmap_search_places, openstreetmap_reverse_geocode, or openstreetmap_lookup_objects. The alternative to the four corner fields, never both. A node ref is rejected: a node is never an area. A ref that maps to no Overpass area returns an empty page whose notice names the cause.',
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
          'OSM amenity tag value shortcut (e.g. "cafe", "bench", "hospital"). Exactly one primary mode is required: this or tag_key, never both. Many categories live under other keys — tourism (museums, hotels, viewpoints), leisure (parks, pitches, playgrounds), shop (supermarkets), historic (castles, memorials), natural (beaches, peaks); query those with tag_key and tag_value.',
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
          'Literal value paired with tag_key for exact equality (e.g., "park", "supermarket"); omit for key existence. Exact equality misses semicolon-list values (cuisine=pizza;italian); tag_value_match "list_item" catches them. Explicit empty or whitespace-only values are invalid. Keys and values are trimmed; blank unused fields are ignored in amenity mode.',
        ),
      tag_value_match: z
        .enum(['exact', 'list_item'])
        .optional()
        .describe(
          'How tag_value matches: "exact" (default) compares the whole value; "list_item" matches one item of a semicolon list, so "pizza" finds cuisine=pizza;italian. Needs tag_value; not available with amenity.',
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
                  'Literal value to match. Omit for key existence; an explicitly blank value is invalid. Trimmed before matching.',
                ),
              match: z
                .enum(['exact', 'list_item'])
                .optional()
                .describe(
                  'How value matches: "exact" (default) or "list_item", one item of a semicolon list. Needs value.',
                ),
            })
            .strict()
            .describe('One additional equality, list-item, or key-existence filter.'),
        )
        .max(5)
        .optional()
        .describe(
          'Up to five additional filters, ANDed with the required primary amenity or tag_key filter in input order. Omitted or [] adds no conditions. Exact values miss semicolon-list values; set match "list_item" on the entry. Keys must be unique after trimming; keys and values must not contain Overpass QL metacharacters (" \\ [ ] ; ( )).',
        ),
      element_types: z
        .array(z.enum(['node', 'way', 'relation']))
        .min(1)
        .default(['node', 'way', 'relation'])
        .describe(
          'OSM element types to search, at least one. Nodes cover most standalone POIs, ways most buildings and areas, relations large parks, lakes, campuses, and boundaries. Omit the field to search all three; pass ["node", "way"] to leave relations out. An empty array is rejected because it can only match nothing.',
        ),
      tag_keys: tagKeysInput,
      sort_by: sortByInput,
      limit: z
        .number()
        .int()
        .min(1)
        .default(20)
        .describe(
          `Maximum results to return, up to ${MAX_PAGE} per call; a larger value is served as ${MAX_PAGE} and limitNotice says so. Applied after the Overpass query — if the area has more features, they are truncated.`,
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe(
          'Number of matching features to skip before applying limit, for paging through a large result set; sort_by ranks the whole set before the page is cut. The full match set is fetched and cached ~10 minutes keyed by the query, so re-paging at a new offset is deterministic and costs no extra upstream request. Pass the nextOffset value from a prior truncated response.',
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
              .describe("Latitude: a node's own, or a way's or relation's bounding-box center."),
            lon: z
              .number()
              .optional()
              .describe("Longitude: a node's own, or a way's or relation's bounding-box center."),
            name: z.string().optional().describe('Feature name from OSM tags.'),
            tags: z
              .record(z.string(), z.string())
              .describe(
                'All OSM tags for this feature, or only the keys tag_keys lists. Values are always strings.',
              ),
          })
          .describe('A single matching OSM feature.'),
      )
      .describe(
        'Matching OSM features inside the requested scope — the bounding box, or the within boundary — up to the limit. Unless sort_by ranks them they arrive nodes, then ways, then relations, each by ascending OSM id, which is not a ranking.',
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
        'The full ordered AND filter chain: key=value for equality, key∋value for a list-item match, key alone for existence (e.g. "amenity=restaurant, cuisine∋pizza, name").',
      ),
    effectiveTagKeys: effectiveTagKeysField,
    effectiveArea: z
      .string()
      .optional()
      .describe(
        'The boundary scope as resolved: the within ref, the boundary it reached (its name, boundary, and admin_level tags, those it carries), and the Overpass area it mapped to. A mistyped ref resolves too, so check the name. Absent when the call used the four corner fields.',
      ),
    areasTimestamp: z
      .string()
      .optional()
      .describe(
        'Freshness of the Overpass area database, rebuilt on its own schedule and so lagging data_timestamp — a boundary edited since is scoped against its older polygon. Present only on a within call whose endpoint reported it.',
      ),
    totalFound: z.number().describe('Total features returned by Overpass before limit truncation.'),
    unrankedCount: unrankedCountField,
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
        'Overpass endpoint that answered, named by origin alone (scheme, host, port), with "(entry N)" added when two configured endpoints share an origin. May name a failover mirror, or the endpoint that originally served a cached response. Read with data_timestamp when a result looks slow, sparse, or stale.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Why this page is empty and what to try: the within ref resolved to no Overpass area, nothing matched (change the scope or tag), or offset ran past the end (retry lower). On any page, also names the tag to retry with when amenity names a value OpenStreetMap tags under another key (tourism=museum, not amenity=museum) or a primary feature key or value was sent capitalized or spaced (amenity=fast_food). Absent otherwise.',
      ),
    limitNotice: limitNoticeField,
  },

  enrichmentTrailer: {
    effectiveTag: { label: 'Tag Filter' },
    effectiveTagKeys: { label: 'Tags Returned' },
    effectiveArea: { label: 'Scope' },
    areasTimestamp: { label: 'Areas Data As Of' },
    totalFound: { label: 'Total Found' },
    unrankedCount: { label: 'Unranked by sort_by' },
    truncated: { label: 'Results Truncated' },
    nextOffset: { label: 'Next Offset' },
    servingEndpoint: { label: 'Served By' },
    limitNotice: { label: 'Limit Clamped' },
  },

  errors: [
    {
      reason: 'invalid_scope',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No usable spatial scope: within sent alongside a corner field, neither scope sent, only part of the four-corner set sent, or a within id of 0 or above 9223372036854775807.',
      recovery:
        'Choose one scope and give it whole: either all four corner fields (south, west, north, east), or within carrying a single OSM boundary ref — R for a relation, W for a closed way. Never both, and never a partial corner set. OSM ids run from 1 to 9223372036854775807.',
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
      when: 'Tag modes conflict or are missing, a key or supplied value is blank, keys repeat after trimming, a list_item match has no value, or a filter carries Overpass QL metacharacters.',
      recovery:
        'Provide either amenity (e.g., "hospital") or tag_key (e.g., "shop"); omit tag_value for key existence or supply a nonblank literal value for equality. Use at most five additional filters with unique trimmed keys; omit an entry value for existence, never send a blank value. A list_item match needs a value and never applies to amenity; use tag_key "amenity" instead. Tag keys and values must be literal text without Overpass QL metacharacters (" \\ [ ] ; ( )); use openstreetmap_query_raw for arbitrary Overpass QL.',
    },
    {
      reason: 'query_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The query exceeded timeout_seconds.',
      retryable: false,
      recovery:
        'Reduce the bounding box area, add more specific tag filters, or increase timeout_seconds and retry.',
      thrownBy: 'service',
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "Overpass ran out of memory on this query, or its response passed the server's 64 MiB read ceiling.",
      recovery:
        'Narrow the query: reduce the bounding box area or use a smaller within boundary, add more specific tag filters, or limit element_types.',
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every configured endpoint refused the query as throttled — HTTP 429, or a throttle document in place of JSON.',
      retryable: true,
      recovery:
        'Every configured Overpass endpoint refused this query as throttled. Wait at least 30 seconds before retrying, longer when the error carries a retryAfter asking for more, and make fewer Overpass calls at once. For sustained load, pin a private Overpass instance via OSM_OVERPASS_BASE_URL.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass reported a runtime error that is neither a timeout nor memory exhaustion.',
      recovery:
        'Read the Overpass remark carried verbatim in the message: it names the fault. Retry in a minute when it points at the dispatcher or database being unavailable; otherwise adjust the query it describes.',
      thrownBy: 'service',
    },
    {
      reason: 'overpass_gateway_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: "Overpass answered HTTP 504 or 408 with no busy-dispatcher remark — the query exceeded the endpoint's own time budget, not timeout_seconds.",
      retryable: true,
      recovery:
        'Shrink the work per query: reduce the bounding box area, add more specific tag filters, or narrow element_types, then retry. The endpoint budget is fixed, so raising timeout_seconds alone will not clear a 504 or 408.',
    },
    {
      reason: 'overpass_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Overpass answered an HTTP 5xx other than 501 and 504, a 425, or a 504 or 408 whose remark says its dispatcher is too busy or turned off — the endpoint is down, restarting, shedding load, or not taking the query yet.',
      retryable: true,
      recovery:
        'The query is fine; the endpoint is not. Wait about 30 seconds and retry unchanged. If it keeps failing, pin a mirror or private instance via OSM_OVERPASS_BASE_URL.',
    },
    {
      reason: 'endpoints_exhausted',
      code: JsonRpcErrorCode.Timeout,
      when: 'No endpoint completed within its attempt window, or the total budget ran out first.',
      retryable: true,
      recovery:
        'Shrink the work per query: reduce the bounding box area, add more specific tag filters, or narrow element_types, then retry — the message names each endpoint and the window it was given, and every one was too slow for a query this size. Raising timeout_seconds widens each window. Listing a healthy mirror in OSM_OVERPASS_ENDPOINTS gives the retry a second server to reach.',
      thrownBy: 'service',
    },
    {
      reason: 'endpoints_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No configured endpoint would serve the call — connections refused, DNS failures, HTTP refusals such as 401/403/404, throttling, or instance faults, in some mix.',
      retryable: true,
      recovery:
        'The query is fine; no endpoint would serve it. Read the per-endpoint outcomes in the message: a host that refused the connection, failed to resolve, or answered 401/403/404 belongs out of OSM_OVERPASS_ENDPOINTS, while a throttle or instance fault usually clears within a minute. An outcome marked (cooling down) is one an earlier call met; that host is skipped until its cooldown of 30 seconds to 10 minutes lapses. Adding a healthy mirror, or pinning a private instance via OSM_OVERPASS_BASE_URL, gives the retry somewhere else to reach.',
      thrownBy: 'service',
    },
    {
      reason: 'endpoints_rejected',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every configured endpoint refused the call by HTTP status: a 401, 403, 404, or 501, a redirect, or another non-retried status below 500 other than 400 and 429.',
      retryable: false,
      recovery:
        'The query is fine, but every configured Overpass endpoint refused this server, so a retry gets the same answer. Read the status beside each endpoint in the message: a 404 usually means a wrong path in OSM_OVERPASS_BASE_URL or OSM_OVERPASS_ENDPOINTS, whose instance paths normally end in /interpreter; a 401, a 403, or a redirect (3xx) means a missing or invalid API key, or a block on this server. Fix or replace those endpoints, or add a working mirror to OSM_OVERPASS_ENDPOINTS.',
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The query waited 30 seconds in total for an Overpass slot while other calls held every slot it could take.',
      retryable: true,
      recovery:
        'Other calls held every Overpass slot this query could take for its whole 30-second wait. Wait the retryAfter seconds the error names, then call again unchanged; fewer Overpass calls at once avoid the wait.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const scope = resolveScope(input);
    if ('error' in scope) {
      throw ctx.fail('invalid_scope', scope.error);
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
      );
    }

    const resolved = resolveTagInput(input);
    if ('error' in resolved) {
      throw ctx.fail('invalid_tag', invalidTagMessage(resolved.error));
    }
    const effectiveTag = describeTagChain(resolved);
    const { limit, limitNotice } = clampLimit(input.limit, MAX_PAGE);

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
        /**
         * HTTP status errors arrive without a reason — remap by status. The status fields
         * ride along: a 429 whose Retry-After outlasts the retry ceiling ends the call at
         * once, and its `retryAfter` is the wait the hint defers to.
         */
        if (!reason && status === 429) {
          throw ctx.fail('rate_limited', err.message, withoutCapturedBody(data), { cause: err });
        }
        /**
         * Overpass names the fault in the 5xx body ("runtime error: … The server is
         * probably too busy to handle your request."). It decides the reason — a 504 a
         * busy dispatcher sent is not a slow query (#104) — and belongs in the message,
         * not as an XHTML document the agent has to parse out of the error data. The
         * status fields ride along, so a caller still reads `data.status`.
         */
        const detail = reason ? undefined : extractOverpassError(data?.body);
        const remapped = reason ? undefined : overpassStatusReason(status, detail);
        if (remapped) {
          throw ctx.fail(
            remapped,
            detail ? `${err.message} Overpass reported: ${detail}` : err.message,
            withoutCapturedBody(data),
            { cause: err },
          );
        }
        if (
          reason === 'query_timeout' ||
          reason === 'result_too_large' ||
          reason === 'rate_limited' ||
          reason === 'upstream_error' ||
          reason === 'endpoints_exhausted' ||
          reason === 'endpoints_unavailable' ||
          reason === 'endpoints_rejected'
        ) {
          throw ctx.fail(reason, err.message);
        }
        /**
         * Any other status — a 400 against a query this tool generated — keeps the service's
         * error, with Overpass's cause in the message rather than the captured document in
         * the data.
         */
        if (!reason) {
          throw new McpError(
            err.code,
            detail ? `${err.message} Overpass reported: ${detail}` : err.message,
            withoutCapturedBody(data),
            { cause: err },
          );
        }
      }
      throw err;
    });
    /**
     * A `within` query carries an `out count;` sentinel ahead of its matches, which is the
     * only thing separating "this ref maps to no area" from "the boundary resolved and
     * nothing matched" — Overpass answers both with HTTP 200, an empty list, and no remark —
     * and a `scope` print carrying the boundary's own tags, which `effectiveArea` names.
     */
    const areaScope = 'areaRef' in scope ? service.readAreaScope(response.elements) : undefined;
    const allPois = service.normalizeElements(areaScope?.elements ?? response.elements);
    // Ranked over the whole set before the page is cut (#127), into a new array.
    const tagSort = resolveTagSort(input.sort_by);
    const sorted = tagSort ? rankByTag(allPois, tagSort) : undefined;
    const limited = (sorted?.ranked ?? allPois).slice(input.offset, input.offset + limit);
    const truncated = allPois.length > input.offset + limit;

    const dataTimestamp = response.osm3s?.timestamp_osm_base;
    const areasTimestamp = response.osm3s?.timestamp_areas_base;

    ctx.log.info('Overpass bbox results', {
      total: allPois.length,
      returned: limited.length,
    });

    const tagKeys = resolveTagKeys(input.tag_keys);
    ctx.enrich({
      effectiveTag,
      ...(tagKeys ? { effectiveTagKeys: tagKeys.join(', ') } : {}),
      totalFound: allPois.length,
      ...(sorted ? { unrankedCount: sorted.unrankedCount } : {}),
      truncated,
      ...(areaScope && 'areaRef' in scope
        ? { effectiveArea: describeArea(scope.ref, scope.areaRef, areaScope.boundary) }
        : {}),
      ...('areaRef' in scope && areasTimestamp ? { areasTimestamp } : {}),
      ...(response.servedBy ? { servingEndpoint: response.servedBy } : {}),
      ...(limitNotice ? { limitNotice } : {}),
    });
    if (truncated) {
      ctx.enrich({ nextOffset: input.offset + limited.length });
    }

    /**
     * `ctx.enrich.notice()` keeps only its last write, so the page's one notice is composed
     * here and written once. The tag hint — a primary key's conventional spelling (#124) or a
     * stray amenity's key (#84) — replaces the generic advice on an empty page, follows the
     * paging notice, and stands alone on a page of matches; an unresolved boundary keeps its
     * own notice, which points at the ref rather than the tag.
     */
    const tagHint = tagRetryHint(resolved);
    let notice = tagHint;
    if (limited.length === 0) {
      const total = allPois.length;
      if (areaScope && !areaScope.resolved && 'ref' in scope) {
        // Never a bare zero: a ref that reached no area is a different problem from a
        // boundary that holds nothing, and sends the caller somewhere else entirely. The
        // check goes to Overpass: Nominatim indexes neither unclosed ways nor relations
        // without boundary tags, so openstreetmap_lookup_objects misses the cases named.
        const check = existenceCheckQuery([scope.ref]);
        notice = `Boundary ${scope.ref} did not resolve to an Overpass area, so nothing can be inside it — the ref may name an id that does not exist, an unclosed way, or a relation without a boundary or area-forming tag. Check it with openstreetmap_query_raw, query ${check} and limit 1: an empty result means the id is not in OpenStreetMap, otherwise its tags show what it is. Or scope with the four corner fields instead.`;
      } else if (total === 0) {
        notice = `No ${effectiveTag} features found ${scope.label}. ${
          tagHint ??
          ('areaRef' in scope
            ? 'Try a different tag, or a boundary that encloses more.'
            : 'Try a larger bbox, a different tag, or verify the coordinates.')
        }`;
      } else {
        // An empty page with matches upstream means the offset ran past the last
        // page — a paging mistake. Telling the caller to widen the scope would send
        // them to correct a query that already worked.
        //
        // #70: the last-page offset is `total - limit`, which floors to 0 once
        // the whole match set fits in one page — offering offset 0 twice as if
        // the two were alternatives. There is only one page to go back to.
        const retry =
          total <= limit
            ? `, which fit in one page of ${limit}. Retry with offset 0.`
            : `. Retry with offset ${total - limit} for the last page, or offset 0 for the first.`;
        notice = `Offset ${input.offset} is past the end of the result set: ${total} ${effectiveTag} feature${total === 1 ? '' : 's'} matched ${scope.label}${retry}${tagHint ? ` ${tagHint}` : ''}`;
      }
    }
    if (notice) ctx.enrich.notice(notice);

    return {
      // Cut last, on the page alone: the ranking, the paging, and the cache read every tag.
      elements: tagKeys ? projectTags(limited, tagKeys) : limited,
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
      lines.push(`${el.name && /[\r\n]|(?:^|[ \t])#+$/.test(el.name) ? '' : '## '}${nameStr}`);
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
