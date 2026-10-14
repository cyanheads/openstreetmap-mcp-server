/**
 * @fileoverview OSM ID lookup tool — fetches address details for known OSM objects.
 * @module mcp-server/tools/definitions/openstreetmap-lookup-objects.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { extractNominatimError } from '@/services/nominatim/nominatim-error.js';
import { getNominatimService } from '@/services/nominatim/nominatim-service.js';
import { appendPlaceLines } from './openstreetmap-format.js';
import { escapeMarkdownText } from './openstreetmap-markdown-escape.js';
import { canonicalOsmId, existenceCheckQuery, OSM_ID_PATTERN } from './openstreetmap-osm-ids.js';
import { TAG_SELECTION_CAVEAT, tagSelectionCaveatOnExtratags } from './openstreetmap-tag-caveat.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

/** IDs per Nominatim /lookup request: "Up to 50 ids can be queried at the same time." */
const LOOKUP_BATCH_SIZE = 50;

export const openstreetmapLookupObjects = tool('openstreetmap_lookup_objects', {
  title: 'Look up address details for OSM objects by ID',
  description:
    'Fetch the Nominatim address record for known OSM objects by ID, 50 per call with any more returned under deferred_ids, each prefixed N (node), W (way), or R (relation), e.g. "N240109189". Use it for IDs already in hand from openstreetmap_query_nearby or openstreetmap_query_bbox; it returns only objects named in osm_ids and lists those with no Nominatim record under not_found (Nominatim skips unnamed and non-place objects, so such an ID may still exist). It cannot select by tag, so discover objects with those tools or openstreetmap_query_raw first.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    osm_ids: z
      .array(z.string())
      .min(1)
      .max(500)
      .describe(
        'OSM IDs to look up, each prefixed with N (node), W (way), or R (relation). Always an array, including for a single ID: ["N240109189"], ["W50637691", "R146656"]. Up to 500 entries; duplicates are dropped and the first 50 unique IDs are looked up per call, the rest returned under deferred_ids to pass on the next call.',
      ),
    extratags: z
      .boolean()
      .default(false)
      .describe(
        "Include each looked-up object's extra OSM tags — contact and metadata (phone, website, opening_hours, wikidata) and physical attributes (surface, tracktype, sac_scale, ele, access). An absent tag describes that object, not OpenStreetMap.",
      ),
    language: z.string().optional().describe('Preferred language for names (BCP 47 code).'),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            place_id: z.number().describe('Nominatim internal place ID.'),
            osm_type: z.enum(['node', 'way', 'relation']).optional().describe('OSM object type.'),
            osm_id: z
              .number()
              .optional()
              .describe(
                'OSM object ID. Pass "R"/"W" + this id as within on openstreetmap_query_bbox to search inside this boundary. The same scope in openstreetmap_query_raw is rel(<osm_id>);map_to_area->.a; or way(<osm_id>);map_to_area->.a; then (area.a) on each statement.',
              ),
            lat: z.number().describe('Latitude in WGS84 decimal degrees.'),
            lon: z.number().describe('Longitude in WGS84 decimal degrees.'),
            display_name: z.string().describe('Full human-readable address string.'),
            name: z.string().optional().describe('Feature name if applicable.'),
            category: z.string().optional().describe('OSM feature category.'),
            type: z.string().optional().describe('OSM feature type within category.'),
            address: z
              .record(z.string(), z.string())
              .optional()
              .describe('Structured address breakdown. Keys vary by feature type.'),
            boundingbox: z
              .tuple([z.number(), z.number(), z.number(), z.number()])
              .optional()
              .describe('Bounding box as [south, north, west, east] in WGS84 decimal degrees.'),
            extratags: z
              .record(z.string(), z.string())
              .optional()
              .describe(
                'Extra OSM tags this object carries — contact and metadata (phone, website, opening_hours, wikidata) and physical attributes (surface, tracktype, sac_scale, ele, access). Present only when extratags was requested; an absent tag describes this object, not OpenStreetMap.',
              ),
          })
          .describe('Address details for a single OSM ID lookup result.'),
      )
      .describe('Address details for the requested OSM IDs that were found.'),
    not_found: z
      .array(z.string())
      .describe(
        'OSM IDs from the request with no Nominatim record, each listed once in canonical form (prefix uppercased, leading zeros dropped). The object does not exist, or it exists and Nominatim does not index it (unnamed or non-place features such as street lamps or building parts); notice gives the openstreetmap_query_raw query that tells the two apart.',
      ),
    deferred_ids: z
      .array(z.string())
      .optional()
      .describe(
        'Unique IDs past the first 50, not looked up on this call; pass them as osm_ids on the next call. Absent when every ID was looked up.',
      ),
    total: z.number().describe('Number of results returned.'),
    attribution: z
      .string()
      .describe('Required data attribution: Data © OpenStreetMap contributors, ODbL 1.0.'),
  }),

  // Agent-facing context: what a non-empty not_found means and how to check it, and, on
  // calls that requested extratags, the disclosure that tags decorate the looked-up objects
  // but never select them. Reaches structuredContent and content[] alike.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when IDs were deferred or not_found is non-empty: the deferral first, then what not_found means and the openstreetmap_query_raw query and limit that return whichever of those IDs exist. Absent otherwise.',
      ),
    tagSelectionCaveat: tagSelectionCaveatOnExtratags,
  },

  // #63: without a label the caveat rendered under its raw camelCase key. The label
  // text is identical on all three Nominatim tools, matching the field name and text
  // they already share (#52).
  enrichmentTrailer: {
    tagSelectionCaveat: { label: 'Tag Selection Caveat' },
  },

  errors: [
    {
      reason: 'invalid_id_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An array element is not a single N/W/R-prefixed OSM ID.',
      recovery:
        'Each array element must be one OSM ID string prefixed with N (node), W (way), or R (relation) — "N12345", not "12345" and not a nested list of IDs in one element.',
    },
    {
      reason: 'invalid_parameters',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Nominatim returned HTTP 400, refusing one of the forwarded parameters; its own message names which one.',
      retryable: false,
      recovery:
        'Read the parameter Nominatim named in the message and correct that value before calling again — the identical request is refused identically, so retrying unchanged cannot succeed.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Nominatim returned HTTP 429, or HTTP 200 with a throttle document in place of JSON — the one request per second policy was exceeded.',
      retryable: true,
      recovery:
        'Wait several seconds before retrying and keep the call rate at or below one request per second, or point OSM_NOMINATIM_BASE_URL at a private Nominatim instance.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Nominatim returned a non-2xx status other than 429, or HTTP 200 with a non-JSON body carrying no throttle signature.',
      retryable: true,
      recovery:
        'Retry after a short delay. If it persists, verify OSM_NOMINATIM_BASE_URL points at a working Nominatim endpoint — a 404 usually means the base URL is wrong — and check whether the instance is up.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    for (const id of input.osm_ids) {
      if (!OSM_ID_PATTERN.test(id.trim())) {
        throw ctx.fail(
          'invalid_id_format',
          `Invalid OSM ID format: "${id}". IDs must be prefixed with N, W, or R (e.g., "N12345").`,
          { id },
        );
      }
    }

    /**
     * #82: canonical before dedupe, so " n1 " and "N01" both become the "N1" Nominatim
     * answers as, and share one lookup slot. A Set keeps first-seen order. #105: the cap
     * counts these unique IDs; past Nominatim's 50-ID batch the rest are handed back.
     */
    const unique = [...new Set(input.osm_ids.map(canonicalOsmId))];
    const ids = unique.slice(0, LOOKUP_BATCH_SIZE);
    const deferredIds = unique.slice(LOOKUP_BATCH_SIZE);

    const service = getNominatimService();
    const results = await service
      .lookup(
        {
          osm_ids: ids,
          extratags: input.extratags,
          ...(input.language?.trim() ? { language: input.language } : {}),
        },
        ctx,
      )
      .catch((err: unknown) => {
        if (err instanceof McpError) {
          const data = err.data as Record<string, unknown> | undefined;
          const reason = data?.reason as string | undefined;
          if (reason === 'rate_limited' || reason === 'upstream_error') {
            throw ctx.fail(reason, err.message);
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
              );
            }
            const mapped = data.status === 429 ? 'rate_limited' : 'upstream_error';
            throw ctx.fail(mapped, err.message);
          }
        }
        throw err;
      });

    const foundOsmIds = new Set(
      results.flatMap((r) =>
        r.osm_type && r.osm_id !== undefined
          ? [`${r.osm_type.charAt(0).toUpperCase()}${r.osm_id}`]
          : [],
      ),
    );

    const notFound = ids.filter((id) => !foundOsmIds.has(id));

    ctx.log.info('Lookup results', { found: results.length, notFound: notFound.length });

    /**
     * Nominatim indexes places and addresses, not every OSM object, so a missing record
     * does not mean a missing object. The existence check is handed over as an executable
     * query rather than run here: an Overpass call from a Nominatim tool would spend an
     * Overpass slot on every miss, whether or not the caller needs the answer.
     */
    const notice = [
      deferredIds.length > 0
        ? `Looked up the first ${LOOKUP_BATCH_SIZE} of ${unique.length} unique IDs; pass deferred_ids as osm_ids on the next call for the other ${deferredIds.length}.`
        : undefined,
      notFound.length > 0
        ? `not_found lists IDs with no Nominatim record: the object does not exist, or it exists and Nominatim does not index it (unnamed or non-place features such as street lamps or building parts). Check which exist with openstreetmap_query_raw, query ${existenceCheckQuery(notFound)} and limit ${notFound.length}; an ID missing from that result is not in OpenStreetMap.`
        : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    if (notice) ctx.enrich.notice(notice);

    // Only when tags were asked for — the caveat qualifies extratags, so a response
    // carrying none has nothing for it to qualify.
    if (input.extratags) ctx.enrich({ tagSelectionCaveat: TAG_SELECTION_CAVEAT });

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
        ...(r.address ? { address: r.address } : {}),
        ...(r.boundingbox ? { boundingbox: r.boundingbox } : {}),
        ...(r.extratags ? { extratags: r.extratags } : {}),
      })),
      not_found: notFound,
      ...(deferredIds.length > 0 ? { deferred_ids: deferredIds } : {}),
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
      appendPlaceLines(lines, r);
      lines.push('');
    }
    if (result.not_found.length > 0) {
      lines.push(`**Not found in Nominatim:** ${result.not_found.join(', ')}`);
      lines.push('');
    }
    if (result.deferred_ids) {
      lines.push(`**Deferred IDs:** ${result.deferred_ids.join(', ')}`);
      lines.push('');
    }
    lines.push(`*${result.attribution}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
