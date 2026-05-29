#!/usr/bin/env node
/**
 * @fileoverview openstreetmap-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { openstreetmapGeocode } from './mcp-server/tools/definitions/openstreetmap-geocode.tool.js';
import { openstreetmapLookup } from './mcp-server/tools/definitions/openstreetmap-lookup.tool.js';
import { openstreetmapQueryBbox } from './mcp-server/tools/definitions/openstreetmap-query-bbox.tool.js';
import { openstreetmapQueryNearby } from './mcp-server/tools/definitions/openstreetmap-query-nearby.tool.js';
import { openstreetmapQueryRaw } from './mcp-server/tools/definitions/openstreetmap-query-raw.tool.js';
import { openstreetmapReverse } from './mcp-server/tools/definitions/openstreetmap-reverse.tool.js';
import { initNominatimService } from './services/nominatim/nominatim-service.js';
import { initOverpassService } from './services/overpass/overpass-service.js';

await createApp({
  tools: [
    openstreetmapGeocode,
    openstreetmapReverse,
    openstreetmapLookup,
    openstreetmapQueryNearby,
    openstreetmapQueryBbox,
    openstreetmapQueryRaw,
  ],
  resources: [],
  prompts: [],
  // Public-catalog server — landing page inventory is always public.
  landing: { requireAuth: false },
  instructions:
    'OpenStreetMap geocoding and spatial query server. ' +
    'Use openstreetmap_geocode to resolve place names or addresses to coordinates. ' +
    'Use openstreetmap_reverse to convert coordinates to an address. ' +
    'Use openstreetmap_lookup to fetch details for known OSM IDs. ' +
    'Use openstreetmap_query_nearby for "what\'s near X?" queries. ' +
    'Use openstreetmap_query_bbox for area surveys. ' +
    'Use openstreetmap_query_raw for advanced Overpass QL. ' +
    'All data © OpenStreetMap contributors, ODbL 1.0. ' +
    'Override endpoints via OSM_NOMINATIM_BASE_URL or OSM_OVERPASS_BASE_URL for private instances.',
  setup(core) {
    initNominatimService(core.config, core.storage);
    initOverpassService(core.config, core.storage);
  },
});
