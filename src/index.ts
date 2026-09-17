#!/usr/bin/env node
/**
 * @fileoverview openstreetmap-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { openstreetmapLookupObjects } from './mcp-server/tools/definitions/openstreetmap-lookup-objects.tool.js';
import { openstreetmapQueryBbox } from './mcp-server/tools/definitions/openstreetmap-query-bbox.tool.js';
import { openstreetmapQueryNearby } from './mcp-server/tools/definitions/openstreetmap-query-nearby.tool.js';
import { openstreetmapQueryRaw } from './mcp-server/tools/definitions/openstreetmap-query-raw.tool.js';
import { openstreetmapReverseGeocode } from './mcp-server/tools/definitions/openstreetmap-reverse-geocode.tool.js';
import { openstreetmapSearchPlaces } from './mcp-server/tools/definitions/openstreetmap-search-places.tool.js';
import { initNominatimService } from './services/nominatim/nominatim-service.js';
import { initOverpassService } from './services/overpass/overpass-service.js';

await createApp({
  name: 'openstreetmap-mcp-server',
  title: 'openstreetmap-mcp-server',
  tools: [
    openstreetmapSearchPlaces,
    openstreetmapReverseGeocode,
    openstreetmapLookupObjects,
    openstreetmapQueryNearby,
    openstreetmapQueryBbox,
    openstreetmapQueryRaw,
  ],
  resources: [],
  prompts: [],
  // Public-catalog server — landing page inventory is always public.
  landing: { requireAuth: false },
  /**
   * No handler keeps per-session state or calls `ctx.requestInput`, so every HTTP
   * deployment is correct stateless. Declared here rather than left to each
   * deployment's `MCP_SESSION_MODE`, which still wins when it carries a value.
   */
  sessionMode: 'stateless',
  /**
   * The advertised surface is fixed at startup — six tools, no resources, no prompts, and
   * nothing emits a `*Changed` notification — so a client re-listing every turn re-fetches
   * a constant. One hour is the redeploy granularity: a new image is the only thing that
   * can change any of these answers. `public` because no listing is filtered per caller —
   * no tool declares `auth` scopes, so every client sees the same list. `resources/read`
   * carries no hint: this server registers no resources.
   *
   * Protocol revision 2026-07-28 only; 2025-era responses are unaffected.
   */
  cacheHints: {
    'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'prompts/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/templates/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
  },
  instructions:
    'Resolve place names and addresses to coordinates with openstreetmap_search_places, coordinates to an address with openstreetmap_reverse_geocode, and known OSM IDs to full records with openstreetmap_lookup_objects. Survey features with openstreetmap_query_nearby (a radius around a point) or openstreetmap_query_bbox (a bounding box, or within an OSM boundary ref such as R237385, built from the osm_type and osm_id the geocoding tools return), filtering by amenity or tag_key with an optional tag_value, and drop to openstreetmap_query_raw for arbitrary Overpass QL. Data is © OpenStreetMap contributors under ODbL 1.0.',
  setup(core) {
    initNominatimService(core.config, core.storage);
    initOverpassService(core.config, core.storage);
  },
});
