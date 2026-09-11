/**
 * @fileoverview Forward geocoding tool — converts place names or addresses to coordinates.
 * @module mcp-server/tools/definitions/openstreetmap-search-places.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { extractNominatimError } from '@/services/nominatim/nominatim-error.js';
import { getNominatimService } from '@/services/nominatim/nominatim-service.js';
import { appendPlaceLines } from './openstreetmap-format.js';
import { escapeMarkdownText } from './openstreetmap-markdown-escape.js';
import {
  NOMINATIM_COUNTRYCODE_PATTERN,
  NOMINATIM_EXCLUDE_ID_PATTERN,
  NOMINATIM_LAYER_PATTERN,
  NOMINATIM_LAYER_VALUES,
} from './openstreetmap-nominatim-input.js';
import {
  TAG_SELECTION_CAVEAT,
  tagSelectionCaveatOnEveryResponse,
} from './openstreetmap-tag-caveat.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

/**
 * JSON-Schema fragment naming the two valid query modes — free-form `query`, or any one
 * of the six structured address fields, which is why the structured mode costs a branch
 * per field. Attached to the input object with Zod's `.meta()`, whose metadata keys pass
 * through JSON-Schema conversion verbatim, so this lands in the advertised `inputSchema`
 * beside `type`, `properties`, and `required` — the surface an argument generator reads.
 * Without it every field is optional and a call with no arguments at all looks valid.
 *
 * `anyOf` over required-sets closes that empty call. It does NOT express mutual
 * exclusivity: `query` alongside `city` still satisfies the first branch, and encoding
 * that needs nested `not` subschemas generators handle poorly. The handler stays the
 * only enforcement point for both `conflicting_query_mode` and `missing_query_mode`.
 *
 * Every field definition stays in the object's own `properties`; the branches carry
 * `required` only. A converter that builds one request model per branch emits no request
 * body at all for branches that declare their own fields, silently dropping arguments in
 * flight. Each branch carries its own `type: 'object'` because Gemini rejects an untyped
 * branch; `lint:mcp` enforces it as schema-anyof-needs-type.
 *
 * The input declares `.strict()` before `.meta()`. `tool()` strictens a default-mode input
 * itself, and Zod's `.strict()` returns a fresh instance absent from the metadata registry,
 * so metadata attached first is dropped before the schema is advertised.
 */
const SEARCH_MODE_SCHEMA_META = {
  anyOf: [
    { type: 'object', required: ['query'] },
    { type: 'object', required: ['street'] },
    { type: 'object', required: ['city'] },
    { type: 'object', required: ['county'] },
    { type: 'object', required: ['state'] },
    { type: 'object', required: ['country'] },
    { type: 'object', required: ['postalcode'] },
  ],
};

export const openstreetmapSearchPlaces = tool('openstreetmap_search_places', {
  title: 'Geocode a place name or address',
  description:
    'Convert a place name or address to geographic coordinates and structured place data via Nominatim/OpenStreetMap. ' +
    'Accepts either a free-form query string (e.g., "Space Needle Seattle") or structured address fields (street, city, state, etc.) — ' +
    'the two modes are mutually exclusive. Returns results ordered by Nominatim relevance (importance score). ' +
    'Use countrycodes to restrict results to specific countries. ' +
    'For exhaustive POI lists in an area, use openstreetmap_query_nearby or openstreetmap_query_bbox instead — ' +
    'Nominatim search returns best matches, not all matching objects. ' +
    'Results are matched on name and address relevance, never on an OSM attribute tag: extratags decorates whichever object matched ' +
    'and cannot select one, so a named feature may resolve to a different OSM object than the one carrying the tags you want. ' +
    'To filter or enumerate by tag (surface, sac_scale, ele, access, amenity), use openstreetmap_query_nearby, ' +
    'openstreetmap_query_bbox, or openstreetmap_query_raw.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z
    .object({
      query: z
        .string()
        .optional()
        .describe(
          'Free-form search string (e.g., "Space Needle Seattle" or "1600 Pennsylvania Ave NW, Washington DC"). Cannot be combined with structured address fields. Keep the query to a POI name plus its city or region. Do not insert a parent institution, campus, or building name between the name and the locality: Nominatim reads commas as an address hierarchy and returns nothing when an intermediate token is not a matching containment level. For example, use "Beinecke Library, New Haven", not "Beinecke Library, Yale University, New Haven".',
        ),
      street: z
        .string()
        .optional()
        .describe(
          'House number and street name (structured query). Use with city/state/country fields. Cannot be combined with query.',
        ),
      city: z.string().optional().describe('City name (structured query).'),
      county: z.string().optional().describe('County or district (structured query).'),
      state: z.string().optional().describe('State or province (structured query).'),
      country: z
        .string()
        .optional()
        .describe('Country name or ISO 3166-1 alpha-2 code (structured query).'),
      postalcode: z.string().optional().describe('Postal or ZIP code (structured query).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(40)
        .default(5)
        .describe(
          'Maximum results to return. Nominatim may return fewer when additional results do not sufficiently match. Max 40.',
        ),
      // The empty-string variant keeps a form client's untouched field a no-op.
      countrycodes: z
        .union([
          z.literal(''),
          z
            .string()
            .regex(NOMINATIM_COUNTRYCODE_PATTERN)
            .describe(
              'One ISO 3166-1 alpha-2 country code, or a comma-separated list of them, in any casing.',
            ),
        ])
        .optional()
        .describe(
          'Restrict results to one or more countries. Comma-separated ISO 3166-1 alpha-2 codes (e.g., "us,ca"), in any casing and with optional spaces around the commas. Anything else — an alpha-3 code, a semicolon list, a country name — is rejected here rather than by Nominatim, which would discard it and silently return unfiltered results. A well-formed code for a country that does not exist is forwarded and matches nothing. An empty value is accepted and treated as omitted. Preferred over the structured country field when filtering.',
        ),
      viewbox: z
        .object({
          west: z
            .number()
            .min(-180)
            .max(180)
            .describe('Western boundary longitude. Must be strictly less than east.'),
          south: z
            .number()
            .min(-90)
            .max(90)
            .describe('Southern boundary latitude. Must be strictly less than north.'),
          east: z
            .number()
            .min(-180)
            .max(180)
            .describe('Eastern boundary longitude. Must be strictly greater than west.'),
          north: z
            .number()
            .min(-90)
            .max(90)
            .describe('Northern boundary latitude. Must be strictly greater than south.'),
        })
        .optional()
        .describe(
          'Rectangular area to bias results toward, for disambiguating a name that repeats worldwide — a creek inside one watershed, a street inside one municipal boundary. Finer-grained than countrycodes and more precise than adding locality words to the query. Bias only by default: a better match outside the box is still returned. Set bounded to make it a hard restriction. Unlike openstreetmap_query_bbox, this box may not cross the antimeridian: west must be less than east and south less than north, or the call is rejected.',
        ),
      bounded: z
        .boolean()
        .optional()
        .describe(
          'Restrict results to the viewbox instead of merely biasing toward it. Requires viewbox — setting it alone is rejected rather than ignored. With it, a match outside the box is dropped even when it scores higher.',
        ),
      // The empty-string variant keeps a form client's untouched field acceptable: it
      // submits the whole schema shape, and the value is treated exactly as omitted.
      layer: z
        .union([
          z.literal(''),
          z
            .string()
            .regex(NOMINATIM_LAYER_PATTERN)
            .describe(
              'One documented layer name, or a comma-separated list of them, in any casing.',
            ),
        ])
        .optional()
        .describe(
          `Filter by data layer. One value or a comma-separated list drawn from: ${NOMINATIM_LAYER_VALUES}, in any casing. An undocumented layer name is rejected here rather than by Nominatim; an empty value is accepted and treated as omitted. Default: no restriction.`,
        ),
      featureType: z
        .enum(['country', 'state', 'city', 'settlement'])
        .optional()
        .describe(
          'Restrict results to a geographic feature type. Automatically implies the address layer.',
        ),
      extratags: z
        .boolean()
        .default(false)
        .describe(
          'Include the extra OSM tags the matched object carries — contact and metadata tags (phone, website, opening_hours, wikidata) and physical attribute tags alike (surface, tracktype, sac_scale, ele, access). Opportunistic, not selective: it reports whatever the matched object happens to carry, so an absent tag describes that object rather than OpenStreetMap, and no value here can steer which object is matched. Increases response size.',
        ),
      language: z
        .string()
        .optional()
        .describe(
          'Preferred language for result names (BCP 47 code or Accept-Language string, e.g., "en", "de", "fr,en"). Defaults to local OSM language.',
        ),
      exclude_place_ids: z
        .array(
          z
            .union([
              z.literal(''),
              z
                .string()
                .regex(NOMINATIM_EXCLUDE_ID_PATTERN)
                .describe('An OSM ref (N/W/R plus the object id) or a bare Nominatim place_id.'),
            ])
            .describe('One exclusion token, or an empty value that excludes nothing.'),
        )
        .optional()
        .describe(
          'OSM refs (N/W/R + id) or Nominatim place_ids to drop from results, forwarded as the exclude_place_ids parameter. Each entry must be one of those two token forms — anything else is rejected here rather than by Nominatim. Entries are trimmed and lowercase ref prefixes uppercased before forwarding, and a blank entry is treated as absent. Pass the nextExcludeIds value from a prior full page to page toward further matches — it emits stable OSM refs when available, which page more reliably than volatile place_ids. When the walk runs out, the call succeeds with zero results and an exhaustion notice rather than failing — treat that as the loop-termination signal. Best-effort progressive retrieval, not a stable cursor — Nominatim ranking can reorder slightly between calls, so already-seen results may shift.',
        ),
    })
    .strict()
    .meta(SEARCH_MODE_SCHEMA_META),

  output: z.object({
    results: z
      .array(
        z
          .object({
            place_id: z
              .number()
              .describe(
                'Nominatim internal place ID. Use osm_type+osm_id for stable cross-server references.',
              ),
            osm_type: z.enum(['node', 'way', 'relation']).optional().describe('OSM object type.'),
            osm_id: z
              .number()
              .optional()
              .describe('OSM object ID. Combine with osm_type for openstreetmap_lookup_objects.'),
            lat: z.string().describe('Latitude (WGS84, as string from API).'),
            lon: z.string().describe('Longitude (WGS84, as string from API).'),
            display_name: z.string().describe('Full human-readable address string.'),
            name: z
              .string()
              .optional()
              .describe(
                'Feature name if applicable (e.g., "Space Needle"). Absent for address-only results.',
              ),
            category: z
              .string()
              .optional()
              .describe('OSM feature category (e.g., "amenity", "man_made", "boundary").'),
            type: z
              .string()
              .optional()
              .describe(
                'OSM feature type within category (e.g., "hospital", "tower", "administrative").',
              ),
            importance: z
              .number()
              .optional()
              .describe('Nominatim relevance score (0–1). Higher is more globally prominent.'),
            address: z
              .record(z.string(), z.string())
              .optional()
              .describe(
                'Structured address breakdown. Keys vary by feature type and country. Common keys: house_number, road, suburb, city, state, postcode, country, country_code.',
              ),
            boundingbox: z
              .tuple([z.string(), z.string(), z.string(), z.string()])
              .optional()
              .describe('Bounding box as [south, north, west, east] strings.'),
            extratags: z
              .record(z.string(), z.string())
              .optional()
              .describe(
                'Extra OSM tags this object carries — contact and metadata (phone, website, opening_hours, wikidata) and physical attributes (surface, tracktype, sac_scale, ele, access). Present only when extratags was requested; an absent tag describes this object, not OpenStreetMap.',
              ),
          })
          .describe('A single geocoding result.'),
      )
      .describe('Geocoding results, ordered by Nominatim relevance (importance score descending).'),
    total: z.number().describe('Number of results returned.'),
    attribution: z
      .string()
      .describe('Required data attribution: Data © OpenStreetMap contributors, ODbL 1.0.'),
  }),

  // Agent-facing context: the effective query sent to Nominatim, result-set counts, and
  // the standing disclosure that tags decorate the matched objects but never select them.
  // Reaches both structuredContent and content[] without a format() entry.
  enrichment: {
    effectiveQuery: z
      .string()
      .describe(
        'The effective query sent to Nominatim — the free-form query string, or a reconstructed string from the provided structured address fields.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        "True when the page filled the requested limit and a same-call probe for one further result confirmed another match at this query's relevance cutoff. Absent otherwise. Absence is not a claim that the set is exhausted: Nominatim applies its own relevance cutoff, so excluding a full page's ids can still surface further, less accurate matches — which is why nextExcludeIds is offered on any full page. Nominatim reports no total, so this is a confirmed observation rather than an inference from page size.",
      ),
    shown: z.number().optional().describe('Number of results returned.'),
    cap: z.number().optional().describe('The limit applied to this request.'),
    nextExcludeIds: z
      .array(z.string())
      .optional()
      .describe(
        'Accumulated exclude tokens (prior excludes plus this page) to pass as exclude_place_ids on the next call, retrieving further matches. Each token is a stable OSM ref (N/W/R + osm_id) when the result carries one, falling back to the Nominatim place_id otherwise. Present whenever the page filled the requested limit, whether or not truncated is set — the probe reads the relevance cutoff, and excluding this page can still surface less accurate matches beyond it. Best-effort rather than a stable cursor: Nominatim ranking can reorder slightly between calls, so a walk can still end sooner than the page count suggests.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        "Guidance for this page, covering two cases: results were capped at limit and a probe confirmed a further match at the query's relevance cutoff (truncated is true — keep paging with nextExcludeIds), or an exclude_place_ids paging walk is exhausted and the page came back empty (the query matched, the walk simply ended, so no rewrite is needed). Tell them apart by truncated and the result count, not by this field being present. Absent when a page returns below the limit, and absent when it fills the limit with nothing past the cutoff — that page still carries nextExcludeIds, which is the field to read for whether paging can continue. Carries paging guidance only — the tag-selection caveat has its own field so neither message can overwrite the other.",
      ),
    effectiveViewbox: z
      .object({
        west: z.number().describe('Western boundary longitude sent to Nominatim.'),
        south: z.number().describe('Southern boundary latitude sent to Nominatim.'),
        east: z.number().describe('Eastern boundary longitude sent to Nominatim.'),
        north: z.number().describe('Northern boundary latitude sent to Nominatim.'),
      })
      .optional()
      .describe(
        'The viewbox forwarded to Nominatim on this call, echoed so an ambiguous result can be read against the area that scoped it. Absent when no viewbox was supplied.',
      ),
    boundedApplied: z
      .boolean()
      .optional()
      .describe(
        'True when the viewbox was a hard restriction (bounded=1 was sent), false when it biased ranking only and a match outside it could still be returned. Absent when no viewbox was supplied.',
      ),
    tagSelectionCaveat: tagSelectionCaveatOnEveryResponse,
  },

  // #63: without a label an enrichment field renders under its raw camelCase key, so
  // the trailer read as a struct dump beside the Overpass tools' prose headings.
  // `notice` is deliberately absent — the framework tags its trailer kind, which
  // renders it as a blockquote, and a label here would not change that.
  enrichmentTrailer: {
    effectiveQuery: { label: 'Effective Query' },
    truncated: { label: 'Results Truncated' },
    shown: { label: 'Results Shown' },
    cap: { label: 'Result Cap' },
    tagSelectionCaveat: { label: 'Tag Selection Caveat' },
    boundedApplied: { label: 'Viewbox Restricted' },
    // Object-valued, so it needs a renderer or it JSON-blobs into the trailer. The
    // renderer supplies its own heading, so no label is set alongside it.
    effectiveViewbox: {
      render: (v) =>
        `**Effective Viewbox:** west ${v?.west}, south ${v?.south}, east ${v?.east}, north ${v?.north}`,
    },
    nextExcludeIds: { render: (v) => `**Next Exclude IDs:** ${(v ?? []).join(', ')}` },
  },

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No places matched the query on a first page — no exclude_place_ids were supplied. An exhausted paging walk returns success with zero results instead.',
      recovery:
        'Drop any intermediate qualifier token (a parent institution or campus between the POI and the city) and retry as "name, city", check spelling, or switch to the structured address fields.',
    },
    {
      reason: 'conflicting_query_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The free-form query and at least one structured address field are both provided — the two modes are mutually exclusive.',
      recovery:
        'Send one mode only: keep query and drop every structured address field, or drop query and keep the structured fields (street, city, county, state, country, postalcode).',
    },
    {
      reason: 'missing_query_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither the free-form query nor any structured address field is provided.',
      recovery:
        'Supply one of the two modes: the query parameter for a free-form search ("Space Needle Seattle"), or at least one structured address field (street, city, county, state, country, postalcode).',
    },
    {
      reason: 'bounded_without_viewbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'bounded was set to true but no viewbox was supplied — there is no area for it to restrict results to.',
      recovery:
        'Supply a viewbox with west, south, east and north for bounded to restrict results to, or drop bounded to search without an area restriction.',
    },
    {
      reason: 'invalid_viewbox',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The viewbox is inverted or degenerate on either axis — west at or beyond east, or south at or beyond north.',
      recovery:
        'Order the corners so west is strictly less than east and south strictly less than north. A box spanning the antimeridian cannot be expressed here — split it into one call east of 180 and one west of it.',
    },
    {
      reason: 'invalid_parameters',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Nominatim returned HTTP 400 — it refused one of the forwarded parameters. Its own message names the parameter and is carried in this error.',
      retryable: false,
      recovery:
        'Read the parameter Nominatim named in the message and correct that value before calling again — the identical request is refused identically, so retrying unchanged cannot succeed.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Nominatim returned HTTP 429, or answered HTTP 200 with a throttle document instead of JSON — the one request per second usage policy was exceeded.',
      retryable: true,
      recovery:
        'Wait several seconds before retrying and keep the call rate at or below one request per second, or point OSM_NOMINATIM_BASE_URL at a private Nominatim instance.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Nominatim returned an unexpected non-2xx status other than 429, or answered HTTP 200 with a body that is not JSON and carries no throttle signature.',
      retryable: true,
      recovery:
        'Retry after a short delay. If it persists, verify OSM_NOMINATIM_BASE_URL points at a working Nominatim endpoint — a 404 usually means the base URL is wrong — and check whether the instance is up.',
    },
  ],

  async handler(input, ctx) {
    const hasQuery = Boolean(input.query?.trim());
    const hasStructured = Boolean(
      input.street?.trim() ||
        input.city?.trim() ||
        input.county?.trim() ||
        input.state?.trim() ||
        input.country?.trim() ||
        input.postalcode?.trim(),
    );

    if (hasQuery && hasStructured) {
      throw ctx.fail(
        'conflicting_query_mode',
        'Cannot combine free-form query with structured address fields.',
        { ...ctx.recoveryFor('conflicting_query_mode') },
      );
    }
    if (!hasQuery && !hasStructured) {
      throw ctx.fail(
        'missing_query_mode',
        'Provide either the query parameter or at least one structured address field.',
        { ...ctx.recoveryFor('missing_query_mode') },
      );
    }

    // #62. Both checks run before the request so an unsatisfiable box costs no
    // upstream slot, mirroring how the query-mode guards above already work.
    if (input.bounded && !input.viewbox) {
      throw ctx.fail(
        'bounded_without_viewbox',
        'bounded restricts results to a viewbox, and no viewbox was supplied.',
        { ...ctx.recoveryFor('bounded_without_viewbox') },
      );
    }
    if (input.viewbox) {
      const { west, south, east, north } = input.viewbox;
      /**
       * Deliberately not openstreetmap_query_bbox's antimeridian allowance. Overpass
       * implements a `west > east` box as the wrap; Nominatim reads the two longitudes
       * as an unordered min/max pair and searches the box *between* them — for
       * `170,-170` that is roughly the whole globe rather than the intended sliver —
       * and reports no error, so the caller would act on a silently inverted result.
       */
      if (west >= east || south >= north) {
        throw ctx.fail(
          'invalid_viewbox',
          `Viewbox (west ${west}, south ${south}, east ${east}, north ${north}) is inverted or degenerate: west must be strictly less than east and south strictly less than north. Nominatim's viewbox has no antimeridian support — unlike openstreetmap_query_bbox, a west greater than east is not read as a box crossing 180 degrees, it silently searches the far larger box between the two longitudes.`,
          { ...ctx.recoveryFor('invalid_viewbox') },
        );
      }
    }

    /**
     * #15: Nominatim's /search reports no total anywhere — the body is a bare array
     * and the headers carry neither X-Total-Count nor Link — so a page that exactly
     * fills `limit` is indistinguishable by size alone from one with nothing beyond
     * it, and reporting truncation from size pointed callers at a paging walk that
     * came back empty on the very next call.
     *
     * Asking for one row past the cap in the same call makes the extra row's presence
     * the signal, at no additional request against the 1 req/sec budget. It is dropped
     * below before the page is returned, so the caller never sees more than `limit`.
     * Measured on two queries (`q=pharmacy`, `q=school`), a request for 41 is served
     * in full, so the probe stays honest at this tool's own 40-result ceiling — the
     * documented 40 maximum is not enforced as a hard clip.
     *
     * What the probe proves is bounded: it reads Nominatim's own relevance cutoff, not
     * the end of the matching set. `q=pharmacy&limit=11` returns 10 rows, yet excluding
     * those 10 ids returns 10 more — the docs say as much, that excluding ids "would
     * cause the search to return other, less accurate, matches (if possible)". So the
     * probe gates `truncated` alone; the paging token is offered on any full page.
     */
    const service = getNominatimService();

    /**
     * Trimmed, blank entries dropped, prefixes uppercased — the same normalization
     * openstreetmap_lookup_objects applies to osm_ids. A form client submits the whole
     * schema shape, so an untouched repeated field arrives as one empty token that
     * excludes nothing; dropping it here keeps it the no-op it reads as.
     */
    const excludePlaceIds = (input.exclude_place_ids ?? [])
      .map((id) => id.trim().toUpperCase())
      .filter(Boolean);
    const probed = await service
      .search(
        {
          ...(hasQuery && input.query ? { q: input.query } : {}),
          ...(input.street?.trim() ? { street: input.street } : {}),
          ...(input.city?.trim() ? { city: input.city } : {}),
          ...(input.county?.trim() ? { county: input.county } : {}),
          ...(input.state?.trim() ? { state: input.state } : {}),
          ...(input.country?.trim() ? { country: input.country } : {}),
          ...(input.postalcode?.trim() ? { postalcode: input.postalcode } : {}),
          limit: input.limit + 1,
          ...(input.countrycodes?.trim() ? { countrycodes: input.countrycodes } : {}),
          ...(input.layer?.trim() ? { layer: input.layer } : {}),
          ...(input.featureType ? { featureType: input.featureType } : {}),
          extratags: input.extratags,
          ...(input.language?.trim() ? { language: input.language } : {}),
          ...(excludePlaceIds.length ? { excludePlaceIds } : {}),
          // Nominatim takes any two opposite corners of the box, each as longitude then
          // latitude; this sends the north-west and south-east pair. Not the
          // south,west,north,east ordering the Overpass tools use.
          ...(input.viewbox
            ? {
                viewbox: `${input.viewbox.west},${input.viewbox.north},${input.viewbox.east},${input.viewbox.south}`,
                ...(input.bounded ? { bounded: true } : {}),
              }
            : {}),
        },
        ctx,
      )
      .catch((err: unknown) => {
        if (err instanceof McpError) {
          const data = err.data as Record<string, unknown> | undefined;
          const reason = data?.reason as string | undefined;
          if (reason === 'rate_limited' || reason === 'upstream_error') {
            throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
          }
          // fetchWithTimeout throws status-mapped errors with no reason — remap by status
          if (!reason && typeof data?.status === 'number') {
            // #59: a 400 is rejected input, not an outage. Folding it into
            // upstream_error marked it retryable and replaced the parameter
            // Nominatim named with a hint about the base URL.
            if (data.status === 400) {
              const detail = extractNominatimError(data.body);
              throw ctx.fail(
                'invalid_parameters',
                detail ? `${err.message} Nominatim rejected the request: ${detail}` : err.message,
                { ...ctx.recoveryFor('invalid_parameters') },
              );
            }
            const mapped = data.status === 429 ? 'rate_limited' : 'upstream_error';
            throw ctx.fail(mapped, err.message, { ...ctx.recoveryFor(mapped) });
          }
        }
        throw err;
      });

    // The probe row proves a further match at the relevance cutoff; it is not itself a
    // result. A full page is what makes paging worth another call, cutoff or not.
    const hasFurtherMatch = probed.length > input.limit;
    const results = hasFurtherMatch ? probed.slice(0, input.limit) : probed;
    const pageIsFull = results.length >= input.limit;

    /**
     * #69: one reconstruction for every echo of what was searched — the success
     * path's enrichment, the exhausted-walk notice, and the no_results message
     * alike. Truthy rather than nullish: an explicit `query: ''` is not a query,
     * and every structured field belongs in the fallback.
     */
    const effectiveQuery = input.query
      ? input.query
      : [input.street, input.city, input.county, input.state, input.country, input.postalcode]
          .filter(Boolean)
          .join(', ');

    // An empty page after exclude_place_ids were supplied is the terminal state of a
    // successful paging walk, not a query that matched nothing — reserve no_results
    // and its rewrite hint for a first page that came back empty.
    const excludedCount = excludePlaceIds.length;
    if (results.length === 0 && excludedCount === 0) {
      throw ctx.fail('no_results', `No places found for "${effectiveQuery}"`, {
        ...ctx.recoveryFor('no_results'),
      });
    }

    ctx.log.info('Geocode results', { count: results.length });

    ctx.enrich({ effectiveQuery });
    // #62: which box scoped the search, and whether it filtered or merely re-ranked.
    // Not inferable from the input echo — bounded is only honored with a viewbox.
    if (input.viewbox) {
      ctx.enrich({ effectiveViewbox: input.viewbox, boundedApplied: input.bounded === true });
    }
    if (results.length === 0) {
      ctx.enrich.notice(
        `Paging complete: no matches remain beyond the ${excludedCount} already retrieved for "${effectiveQuery}". The query is correct — stop paging rather than rewriting it.`,
      );
    }
    if (hasFurtherMatch) {
      // The framework's default cap text names remedies that cannot reach the rest of
      // the set: limit tops out at Nominatim's own 40-result ceiling, and narrowing with
      // filters returns a different set rather than the remainder of this one. Name the
      // exclude_place_ids walk instead — the tool's actual retrieval path.
      ctx.enrich.truncated({
        shown: results.length,
        cap: input.limit,
        guidance: `Page capped at ${input.limit}, and a probe for one further result confirmed another match at this query's relevance cutoff. Pass this response's nextExcludeIds back as exclude_place_ids on the next call to reach the next-best matches; the walk ends when a page returns zero results. Raising limit does not reach them and cannot exceed 40 — that is Nominatim's own ceiling, not a setting here.`,
      });
    }
    // Gated on the page being full, not on the probe: excluding a full page's ids can
    // surface further, less accurate matches even where the probe found nothing at the
    // cutoff, so withholding the token there ended a walk that still had results in it.
    // Accumulate prior excludes + this page's stable refs. Prefer the OSM ref (N/W/R +
    // osm_id) over the volatile Nominatim place_id, which can differ across calls for
    // the same OSM object; fall back to place_id only when a result carries neither.
    if (pageIsFull) {
      ctx.enrich({
        nextExcludeIds: [
          ...excludePlaceIds,
          ...results.map((r) =>
            r.osm_type && r.osm_id !== undefined
              ? `${r.osm_type.charAt(0).toUpperCase()}${r.osm_id}`
              : String(r.place_id),
          ),
        ],
      });
    }

    // Unconditional. This is the one Nominatim tool taking a free-form query, so it is
    // the one a caller reaches for expecting tag-based selection — and that caller has
    // no reason to have set extratags, which defaults to false. Both the normal-results
    // path and the exhausted-walk path funnel into the return below, so one call covers
    // both. Its own field, never ctx.enrich.notice — the paging branches above already
    // own that key, and notice is last-write-wins.
    ctx.enrich({ tagSelectionCaveat: TAG_SELECTION_CAVEAT });

    return {
      results: results.map((r) => ({
        place_id: r.place_id,
        ...(r.osm_type ? { osm_type: r.osm_type } : {}),
        ...(r.osm_id !== undefined ? { osm_id: r.osm_id } : {}),
        lat: r.lat,
        lon: r.lon,
        display_name: r.display_name,
        ...(r.name ? { name: r.name } : {}),
        ...(r.category ? { category: r.category } : {}),
        ...(r.type ? { type: r.type } : {}),
        ...(r.importance !== undefined ? { importance: r.importance } : {}),
        ...(r.address ? { address: r.address } : {}),
        ...(r.boundingbox ? { boundingbox: r.boundingbox } : {}),
        ...(r.extratags ? { extratags: r.extratags } : {}),
      })),
      total: results.length,
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.total} result${result.total === 1 ? '' : 's'} found**`,
      '',
    ];
    for (const r of result.results) {
      if (r.name) lines.push(`## ${escapeMarkdownText(r.name)}`);
      lines.push(`**Address:** ${escapeMarkdownText(r.display_name)}`);
      lines.push(`**Coordinates:** ${r.lat}, ${r.lon}`);
      lines.push(`**Place ID:** ${r.place_id}`);
      if (r.importance !== undefined) lines.push(`**Importance:** ${r.importance}`);
      appendPlaceLines(lines, r);
      lines.push('');
    }
    lines.push(`*${result.attribution}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
