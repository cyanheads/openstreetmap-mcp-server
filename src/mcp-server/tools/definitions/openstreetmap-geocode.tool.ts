/**
 * @fileoverview Forward geocoding tool — converts place names or addresses to coordinates.
 * @module mcp-server/tools/definitions/openstreetmap-geocode.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNominatimService } from '@/services/nominatim/nominatim-service.js';
import { appendPlaceLines } from './openstreetmap-format.js';

const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0';

export const openstreetmapGeocode = tool('openstreetmap_geocode', {
  title: 'Geocode a place name or address',
  description:
    'Convert a place name or address to geographic coordinates and structured place data via Nominatim/OpenStreetMap. ' +
    'Accepts either a free-form query string (e.g., "Space Needle Seattle") or structured address fields (street, city, state, etc.) — ' +
    'the two modes are mutually exclusive. Returns results ordered by Nominatim relevance (importance score). ' +
    'Use countrycodes to restrict results to specific countries. ' +
    'For exhaustive POI lists in an area, use openstreetmap_query_nearby or openstreetmap_query_bbox instead — ' +
    'Nominatim search returns best matches, not all matching objects.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
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
    countrycodes: z
      .string()
      .optional()
      .describe(
        'Restrict results to one or more countries. Comma-separated ISO 3166-1 alpha-2 codes (e.g., "us,ca"). Preferred over the structured country field when filtering.',
      ),
    layer: z
      .string()
      .optional()
      .describe(
        'Filter by data layer. Comma-separated values: address, poi, railway, natural, manmade. Default: no restriction.',
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
        'Include extra OSM tags when available (e.g., phone, website, opening_hours, wikidata). Increases response size.',
      ),
    language: z
      .string()
      .optional()
      .describe(
        'Preferred language for result names (BCP 47 code or Accept-Language string, e.g., "en", "de", "fr,en"). Defaults to local OSM language.',
      ),
    exclude_place_ids: z
      .array(z.string())
      .optional()
      .describe(
        'OSM refs (N/W/R + id) or Nominatim place_ids to drop from results, forwarded as the exclude_place_ids parameter. Pass the nextExcludeIds value from a prior truncated response to page toward the next-best matches — it emits stable OSM refs when available, which page more reliably than volatile place_ids. Best-effort progressive retrieval, not a stable cursor — Nominatim ranking can reorder slightly between calls, so already-seen results may shift.',
      ),
  }),

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
              .describe('OSM object ID. Combine with osm_type for openstreetmap_lookup.'),
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
                'Additional OSM tags (phone, website, opening_hours, wikidata). Present only when extratags was requested.',
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

  // Agent-facing context: the effective query sent to Nominatim and result-set counts.
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
      .describe('True if the result count equals the requested limit (Nominatim may have more).'),
    shown: z.number().optional().describe('Number of results returned.'),
    cap: z.number().optional().describe('The limit applied to this request.'),
    nextExcludeIds: z
      .array(z.string())
      .optional()
      .describe(
        'Accumulated exclude tokens (prior excludes plus this page) to pass as exclude_place_ids on the next call, retrieving the next-best matches. Each token is a stable OSM ref (N/W/R + osm_id) when the result carries one, falling back to the Nominatim place_id otherwise. Present only when results were truncated. Best-effort: Nominatim ranking is not perfectly stable across calls.',
      ),
  },

  enrichmentTrailer: {
    nextExcludeIds: { render: (v) => `**Next Exclude IDs:** ${(v ?? []).join(', ')}` },
  },

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No places matched the query.',
      recovery:
        'Drop any intermediate qualifier token (a parent institution or campus between the POI and the city) and retry as "name, city", check spelling, or switch to the structured address fields.',
    },
    {
      reason: 'invalid_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both query and structured fields are provided, or neither is provided.',
      recovery:
        'Provide either the query parameter (free-form) or structured address fields (street, city, etc.), not both.',
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
        'invalid_input',
        'Cannot combine free-form query with structured address fields.',
        { ...ctx.recoveryFor('invalid_input') },
      );
    }
    if (!hasQuery && !hasStructured) {
      throw ctx.fail(
        'invalid_input',
        'Provide either the query parameter or at least one structured address field.',
        { ...ctx.recoveryFor('invalid_input') },
      );
    }

    const service = getNominatimService();
    const results = await service.search(
      {
        ...(hasQuery && input.query ? { q: input.query } : {}),
        ...(input.street?.trim() ? { street: input.street } : {}),
        ...(input.city?.trim() ? { city: input.city } : {}),
        ...(input.county?.trim() ? { county: input.county } : {}),
        ...(input.state?.trim() ? { state: input.state } : {}),
        ...(input.country?.trim() ? { country: input.country } : {}),
        ...(input.postalcode?.trim() ? { postalcode: input.postalcode } : {}),
        limit: input.limit,
        ...(input.countrycodes?.trim() ? { countrycodes: input.countrycodes } : {}),
        ...(input.layer?.trim() ? { layer: input.layer } : {}),
        ...(input.featureType ? { featureType: input.featureType } : {}),
        extratags: input.extratags,
        ...(input.language?.trim() ? { language: input.language } : {}),
        ...(input.exclude_place_ids?.length ? { excludePlaceIds: input.exclude_place_ids } : {}),
      },
      ctx,
    );

    if (results.length === 0) {
      throw ctx.fail(
        'no_results',
        `No places found for "${input.query ?? [input.city, input.state, input.country].filter(Boolean).join(', ')}"`,
        { ...ctx.recoveryFor('no_results') },
      );
    }

    ctx.log.info('Geocode results', { count: results.length });

    const effectiveQuery = input.query
      ? input.query
      : [input.street, input.city, input.county, input.state, input.country, input.postalcode]
          .filter(Boolean)
          .join(', ');
    ctx.enrich({ effectiveQuery });
    if (results.length >= input.limit) {
      ctx.enrich.truncated({ shown: results.length, cap: input.limit });
      // Accumulate prior excludes + this page's stable refs so the caller can
      // page to the next-best matches via exclude_place_ids on the follow-up
      // call. Prefer the OSM ref (N/W/R + osm_id) over the volatile Nominatim
      // place_id, which can differ across calls for the same OSM object; fall
      // back to place_id only when a result carries no osm_type/osm_id.
      ctx.enrich({
        nextExcludeIds: [
          ...(input.exclude_place_ids ?? []),
          ...results.map((r) =>
            r.osm_type && r.osm_id !== undefined
              ? `${r.osm_type.charAt(0).toUpperCase()}${r.osm_id}`
              : String(r.place_id),
          ),
        ],
      });
    }

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
      if (r.name) lines.push(`## ${r.name}`);
      lines.push(`**Address:** ${r.display_name}`);
      lines.push(`**Coordinates:** ${r.lat}, ${r.lon}`);
      lines.push(`**Place ID:** ${r.place_id}`);
      if (r.importance !== undefined) lines.push(`**Importance:** ${r.importance.toFixed(3)}`);
      appendPlaceLines(lines, r);
      lines.push('');
    }
    lines.push(`*${result.attribution}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
