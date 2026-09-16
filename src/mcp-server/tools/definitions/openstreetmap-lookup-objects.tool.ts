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
import { TAG_SELECTION_CAVEAT, tagSelectionCaveatOnExtratags } from './openstreetmap-tag-caveat.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

/** Regex for valid OSM IDs: N/W/R prefix followed by digits. */
const OSM_ID_PATTERN = /^[NWRnwr]\d+$/;

export const openstreetmapLookupObjects = tool('openstreetmap_lookup_objects', {
  title: 'Look up address details for OSM objects by ID',
  description:
    'Fetch address details for one or more known OSM objects by their IDs via Nominatim. ' +
    'Each ID must be prefixed with N (node), W (way), or R (relation), e.g., "N240109189", "W50637691", "R146656". ' +
    'Up to 50 IDs per call. ' +
    'Use when an OSM ID is already known from a prior openstreetmap_query_nearby or openstreetmap_query_bbox result — ' +
    'this is more efficient than a geocoding round trip to get the full Nominatim address record. ' +
    'The results are exactly the objects named in osm_ids: extratags decorates them and cannot select them, ' +
    'and there is no way to ask this tool for objects carrying a given tag. ' +
    'Discover such objects with openstreetmap_query_nearby, openstreetmap_query_bbox, or openstreetmap_query_raw, ' +
    'then pass their IDs here.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    osm_ids: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe(
        'OSM IDs to look up, each prefixed with N (node), W (way), or R (relation). Always an array, including for a single ID: ["N240109189"], ["W50637691", "R146656"]. Up to 50 IDs per call.',
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
    not_found: z.array(z.string()).describe('OSM IDs from the request that returned no result.'),
    total: z.number().describe('Number of results returned.'),
    attribution: z
      .string()
      .describe('Required data attribution: Data © OpenStreetMap contributors, ODbL 1.0.'),
  }),

  // Agent-facing context: on calls that requested extratags, the disclosure that tags
  // decorate the looked-up objects but never select them. Reaches structuredContent and
  // content[] alike.
  enrichment: {
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
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Nominatim returned a non-2xx status other than 429, or HTTP 200 with a non-JSON body carrying no throttle signature.',
      retryable: true,
      recovery:
        'Retry after a short delay. If it persists, verify OSM_NOMINATIM_BASE_URL points at a working Nominatim endpoint — a 404 usually means the base URL is wrong — and check whether the instance is up.',
    },
  ],

  async handler(input, ctx) {
    for (const id of input.osm_ids) {
      if (!OSM_ID_PATTERN.test(id.trim())) {
        throw ctx.fail(
          'invalid_id_format',
          `Invalid OSM ID format: "${id}". IDs must be prefixed with N, W, or R (e.g., "N12345").`,
          { id, ...ctx.recoveryFor('invalid_id_format') },
        );
      }
    }

    const normalizedIds = input.osm_ids.map((id) => id.trim().toUpperCase());

    const service = getNominatimService();
    const results = await service
      .lookup(
        {
          osm_ids: normalizedIds,
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

    const foundOsmIds = new Set(
      results.flatMap((r) =>
        r.osm_type && r.osm_id !== undefined
          ? [`${r.osm_type.charAt(0).toUpperCase()}${r.osm_id}`]
          : [],
      ),
    );

    const notFound = normalizedIds.filter((id) => !foundOsmIds.has(id));

    ctx.log.info('Lookup results', { found: results.length, notFound: notFound.length });

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
      lines.push(`**Not found:** ${result.not_found.join(', ')}`);
      lines.push('');
    }
    lines.push(`*${result.attribution}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
