/**
 * @fileoverview Reverse geocoding tool — converts coordinates to nearest address or place.
 * @module mcp-server/tools/definitions/openstreetmap-reverse-geocode.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getNominatimService } from '@/services/nominatim/nominatim-service.js';
import { appendPlaceLines } from './openstreetmap-format.js';
import { TAG_SELECTION_CAVEAT, tagSelectionCaveatOnExtratags } from './openstreetmap-tag-caveat.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

export const openstreetmapReverseGeocode = tool('openstreetmap_reverse_geocode', {
  title: 'Reverse geocode coordinates to an address',
  description:
    'Convert latitude/longitude coordinates to the nearest address or place name via Nominatim/OpenStreetMap. ' +
    'Returns the closest matching OSM object at the given coordinates. ' +
    'Note: Nominatim finds the nearest indexed OSM object — in dense areas this may differ from the address at the exact coordinate. ' +
    'Use zoom=18 for building-level accuracy, lower zoom values for coarser resolution (e.g., zoom=10 for city-level). ' +
    'The match is made on proximity and layer, never on an OSM attribute tag: extratags decorates the matched object ' +
    'and cannot select one. To find the objects in an area that carry a given tag, use openstreetmap_query_nearby, ' +
    'openstreetmap_query_bbox, or openstreetmap_query_raw.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    lat: z.number().min(-90).max(90).describe('Latitude in WGS84 decimal degrees.'),
    lon: z.number().min(-180).max(180).describe('Longitude in WGS84 decimal degrees.'),
    zoom: z
      .number()
      .int()
      .min(3)
      .max(18)
      .default(18)
      .describe(
        'Address detail level, roughly corresponding to map zoom. 18=building, 16=street, 14=neighbourhood, 12=town, 10=city, 8=county, 5=state, 3=country.',
      ),
    layer: z
      .string()
      .optional()
      .describe(
        'Restrict which OSM layer is matched. Comma-separated: address, poi, railway, natural, manmade. Default: address,poi.',
      ),
    extratags: z
      .boolean()
      .default(false)
      .describe(
        'Include the extra OSM tags the matched object carries — contact and metadata tags (phone, website, opening_hours, wikidata) and physical attribute tags alike (surface, tracktype, sac_scale, ele, access). Opportunistic, not selective: it reports whatever the matched object happens to carry, so an absent tag describes that object rather than OpenStreetMap, and no value here can steer which object is matched.',
      ),
    language: z
      .string()
      .optional()
      .describe('Preferred language for the result (BCP 47 code or Accept-Language string).'),
  }),

  output: z.object({
    result: z
      .object({
        place_id: z.number().describe('Nominatim internal place ID.'),
        osm_type: z.enum(['node', 'way', 'relation']).optional().describe('OSM object type.'),
        osm_id: z
          .number()
          .optional()
          .describe('OSM object ID. Combine with osm_type for openstreetmap_lookup_objects.'),
        lat: z.string().describe('Latitude of the matched OSM object.'),
        lon: z.string().describe('Longitude of the matched OSM object.'),
        display_name: z.string().describe('Full human-readable address.'),
        name: z.string().optional().describe('Feature name if the result is a named place.'),
        category: z
          .string()
          .optional()
          .describe('OSM feature category (e.g., "amenity", "building").'),
        type: z.string().optional().describe('OSM feature type within category.'),
        address: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Structured address. Keys vary by feature type. Common: house_number, road, suburb, city, state, postcode, country, country_code.',
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
      .describe('The closest matching OSM object at the given coordinates.'),
    attribution: z.string().describe('Required data attribution.'),
  }),

  // Agent-facing context: on calls that requested extratags, the disclosure that tags
  // decorate the matched object but never select it. Reaches structuredContent and
  // content[] alike.
  enrichment: {
    tagSelectionCaveat: tagSelectionCaveatOnExtratags,
  },

  errors: [
    {
      reason: 'no_coverage',
      code: JsonRpcErrorCode.NotFound,
      when: 'Nominatim returns an error indicating no OSM data at the given coordinates (e.g., open ocean or unmapped territory).',
      recovery:
        'Verify the coordinates are correct. Try a lower zoom value to match at a coarser level (e.g., zoom=10 for city-level).',
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
    const service = getNominatimService();
    const raw = await service
      .reverse(
        {
          lat: input.lat,
          lon: input.lon,
          zoom: input.zoom,
          extratags: input.extratags,
          ...(input.layer?.trim() ? { layer: input.layer } : {}),
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
            const mapped = data.status === 429 ? 'rate_limited' : 'upstream_error';
            throw ctx.fail(mapped, err.message, { ...ctx.recoveryFor(mapped) });
          }
        }
        throw err;
      });

    // Nominatim returns HTTP 200 with {"error": "Unable to geocode"} for unmapped areas
    if (raw.error) {
      throw ctx.fail(
        'no_coverage',
        `No OSM data at coordinates (${input.lat}, ${input.lon}): ${raw.error}`,
        { ...ctx.recoveryFor('no_coverage') },
      );
    }

    ctx.log.info('Reverse geocode result', { display_name: raw.display_name });

    // Only when tags were asked for — the caveat qualifies extratags, so a response
    // carrying none has nothing for it to qualify.
    if (input.extratags) ctx.enrich({ tagSelectionCaveat: TAG_SELECTION_CAVEAT });

    return {
      result: {
        place_id: raw.place_id,
        ...(raw.osm_type ? { osm_type: raw.osm_type } : {}),
        ...(raw.osm_id !== undefined ? { osm_id: raw.osm_id } : {}),
        lat: raw.lat,
        lon: raw.lon,
        display_name: raw.display_name,
        ...(raw.name ? { name: raw.name } : {}),
        ...(raw.category ? { category: raw.category } : {}),
        ...(raw.type ? { type: raw.type } : {}),
        ...(raw.address ? { address: raw.address } : {}),
        ...(raw.boundingbox ? { boundingbox: raw.boundingbox } : {}),
        ...(raw.extratags ? { extratags: raw.extratags } : {}),
      },
      attribution: ATTRIBUTION,
    };
  },

  format: (result) => {
    const r = result.result;
    const lines: string[] = [];
    if (r.name) lines.push(`## ${r.name}`);
    lines.push(`**Address:** ${r.display_name}`);
    lines.push(`**Coordinates:** ${r.lat}, ${r.lon}`);
    lines.push(`**Place ID:** ${r.place_id}`);
    appendPlaceLines(lines, r);
    lines.push('');
    lines.push(`*${result.attribution}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
