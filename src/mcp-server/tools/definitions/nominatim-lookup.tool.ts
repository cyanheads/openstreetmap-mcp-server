/**
 * @fileoverview OSM ID lookup tool — fetches address details for known OSM objects.
 * @module mcp-server/tools/definitions/nominatim-lookup.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNominatimService } from '@/services/nominatim/nominatim-service.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

/** Regex for valid OSM IDs: N/W/R prefix followed by digits. */
const OSM_ID_PATTERN = /^[NWRnwr]\d+$/;

export const nominatimLookup = tool('nominatim_lookup', {
  title: 'Look up address details for OSM objects by ID',
  description:
    'Fetch address details for one or more known OSM objects by their IDs via Nominatim. ' +
    'Each ID must be prefixed with N (node), W (way), or R (relation), e.g., "N240109189", "W50637691", "R146656". ' +
    'Up to 50 IDs per call. ' +
    'Use when an OSM ID is already known from a prior overpass_query_nearby or overpass_query_bbox result — ' +
    'this is more efficient than a geocoding round trip to get the full Nominatim address record.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    osm_ids: z
      .union([
        z.string().describe('Single OSM ID string, e.g., "N240109189".'),
        z.array(z.string()).min(1).max(50).describe('Array of OSM ID strings, up to 50.'),
      ])
      .describe(
        'One or more OSM IDs, each prefixed with N (node), W (way), or R (relation). E.g., "N240109189", ["W50637691", "R146656"]. Up to 50 IDs per call.',
      ),
    extratags: z
      .boolean()
      .default(false)
      .describe('Include extra OSM tags (phone, website, wikidata, etc.).'),
    language: z.string().optional().describe('Preferred language for names (BCP 47 code).'),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            place_id: z.number().describe('Nominatim internal place ID.'),
            osm_type: z.enum(['node', 'way', 'relation']).optional().describe('OSM object type.'),
            osm_id: z.number().optional().describe('OSM object ID.'),
            lat: z.string().describe('Latitude (WGS84, as string from API).'),
            lon: z.string().describe('Longitude (WGS84, as string from API).'),
            display_name: z.string().describe('Full human-readable address string.'),
            name: z.string().optional().describe('Feature name if applicable.'),
            category: z.string().optional().describe('OSM feature category.'),
            type: z.string().optional().describe('OSM feature type within category.'),
            address: z
              .record(z.string(), z.string())
              .optional()
              .describe('Structured address breakdown. Keys vary by feature type.'),
            boundingbox: z
              .tuple([z.string(), z.string(), z.string(), z.string()])
              .optional()
              .describe('Bounding box as [south, north, west, east] strings.'),
            extratags: z
              .record(z.string(), z.string())
              .optional()
              .describe('Additional OSM tags. Present only when extratags was requested.'),
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

  errors: [
    {
      reason: 'invalid_id_format',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'An OSM ID is missing the N/W/R prefix or is otherwise malformed.',
      recovery:
        'Prefix each ID with N (node), W (way), or R (relation), e.g., "N12345" not "12345".',
    },
  ],

  async handler(input, ctx) {
    const ids = Array.isArray(input.osm_ids) ? input.osm_ids : [input.osm_ids];

    for (const id of ids) {
      if (!OSM_ID_PATTERN.test(id.trim())) {
        throw ctx.fail(
          'invalid_id_format',
          `Invalid OSM ID format: "${id}". IDs must be prefixed with N, W, or R (e.g., "N12345").`,
          { id, ...ctx.recoveryFor('invalid_id_format') },
        );
      }
    }

    const normalizedIds = ids.map((id) => id.trim().toUpperCase());

    const service = getNominatimService();
    const results = await service.lookup(
      {
        osm_ids: normalizedIds,
        extratags: input.extratags,
        ...(input.language?.trim() ? { language: input.language } : {}),
      },
      ctx,
    );

    const foundOsmIds = new Set(
      results
        .map((r) => {
          if (r.osm_type && r.osm_id !== undefined) {
            return `${r.osm_type.charAt(0).toUpperCase()}${r.osm_id}`;
          }
          return null;
        })
        .filter((id): id is string => id !== null),
    );

    const notFound = normalizedIds.filter((id) => !foundOsmIds.has(id));

    ctx.log.info('Lookup results', { found: results.length, notFound: notFound.length });

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
      if (r.name) lines.push(`## ${r.name}`);
      lines.push(`**Address:** ${r.display_name}`);
      lines.push(`**Coordinates:** ${r.lat}, ${r.lon}`);
      lines.push(`**Place ID:** ${r.place_id}`);
      if (r.osm_type && r.osm_id !== undefined) {
        lines.push(`**OSM:** ${r.osm_type.charAt(0).toUpperCase()}${r.osm_id}`);
      }
      if (r.category) lines.push(`**Category:** ${r.category}${r.type ? ` / ${r.type}` : ''}`);
      if (r.address) {
        const addrParts = Object.entries(r.address)
          .filter(([k]) => !['country_code', 'ISO3166-2-lvl4'].includes(k))
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        if (addrParts) lines.push(`**Address details:** ${addrParts}`);
      }
      if (r.boundingbox) {
        lines.push(
          `**Bounding box:** S:${r.boundingbox[0]} N:${r.boundingbox[1]} W:${r.boundingbox[2]} E:${r.boundingbox[3]}`,
        );
      }
      if (r.extratags && Object.keys(r.extratags).length > 0) {
        const extra = Object.entries(r.extratags)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        lines.push(`**Extra tags:** ${extra}`);
      }
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
