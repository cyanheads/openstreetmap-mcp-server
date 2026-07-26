/**
 * @fileoverview Guards the advertised tool-name surface — the Nominatim tools use
 * explicit three-token names and the retired two-token names are no longer exposed.
 * @module tests/tools/tool-surface.test
 */

import { describe, expect, it } from 'vitest';
import { openstreetmapLookupObjects } from '@/mcp-server/tools/definitions/openstreetmap-lookup-objects.tool.js';
import { openstreetmapQueryBbox } from '@/mcp-server/tools/definitions/openstreetmap-query-bbox.tool.js';
import { openstreetmapQueryNearby } from '@/mcp-server/tools/definitions/openstreetmap-query-nearby.tool.js';
import { openstreetmapQueryRaw } from '@/mcp-server/tools/definitions/openstreetmap-query-raw.tool.js';
import { openstreetmapReverseGeocode } from '@/mcp-server/tools/definitions/openstreetmap-reverse-geocode.tool.js';
import { openstreetmapSearchPlaces } from '@/mcp-server/tools/definitions/openstreetmap-search-places.tool.js';

const toolNames = [
  openstreetmapSearchPlaces,
  openstreetmapReverseGeocode,
  openstreetmapLookupObjects,
  openstreetmapQueryNearby,
  openstreetmapQueryBbox,
  openstreetmapQueryRaw,
].map((definition) => definition.name);

describe('tool surface', () => {
  it('advertises the three-token Nominatim tool names', () => {
    expect(toolNames).toContain('openstreetmap_search_places');
    expect(toolNames).toContain('openstreetmap_reverse_geocode');
    expect(toolNames).toContain('openstreetmap_lookup_objects');
  });

  it('no longer advertises the retired two-token names', () => {
    expect(toolNames).not.toContain('openstreetmap_geocode');
    expect(toolNames).not.toContain('openstreetmap_reverse');
    expect(toolNames).not.toContain('openstreetmap_lookup');
  });

  it('keeps the Overpass tool names unchanged', () => {
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'openstreetmap_query_nearby',
        'openstreetmap_query_bbox',
        'openstreetmap_query_raw',
      ]),
    );
  });
});
