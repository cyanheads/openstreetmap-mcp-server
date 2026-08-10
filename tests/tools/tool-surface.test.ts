/**
 * @fileoverview Guards the advertised tool surface — the Nominatim tools use explicit
 * three-token names, the retired two-token names are no longer exposed, the Overpass
 * convenience tools publish their tag-mode requirement and their non-empty element_types
 * constraint, and openstreetmap_search_places publishes its query / structured-address
 * requirement, all in the inputSchema clients receive.
 * @module tests/tools/tool-surface.test
 */

import { describe, expect, it } from 'vitest';
import { toJSONSchema } from 'zod/v4-mini';
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

/**
 * Convert a tool's input the way tools/list does. The MCP SDK hands the definition's
 * schema to `toJSONSchema` from zod/v4-mini with exactly these options
 * (server/zod-json-schema-compat.ts), so this is the JSON a client parses — asserting on
 * the Zod object instead would pass even if the requirement never reached the wire.
 */
function advertisedInputSchema(input: unknown): Record<string, unknown> {
  return toJSONSchema(input as Parameters<typeof toJSONSchema>[0], {
    target: 'draft-7',
    io: 'input',
  }) as unknown as Record<string, unknown>;
}

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

describe('advertised tag-mode requirement', () => {
  const tagTools = [
    { definition: openstreetmapQueryNearby, geoRequired: ['lat', 'lon'] },
    { definition: openstreetmapQueryBbox, geoRequired: ['south', 'west', 'north', 'east'] },
  ];

  for (const { definition, geoRequired } of tagTools) {
    describe(definition.name, () => {
      const schema = advertisedInputSchema(definition.input);

      it('stays an object schema whose only required fields are the geographic ones', () => {
        // A top-level union would drop `type: "object"` — the MCP spec requires it, and
        // the SDK swaps a non-object schema for an empty one when serving tools/list.
        expect(schema.type).toBe('object');
        expect(schema.required).toEqual(geoRequired);
      });

      it('keeps amenity, tag_key, and tag_value as flat optional strings', () => {
        const properties = schema.properties as Record<string, { type?: string }>;
        expect(properties.amenity?.type).toBe('string');
        expect(properties.tag_key?.type).toBe('string');
        expect(properties.tag_value?.type).toBe('string');
      });

      it('publishes anyOf over the two tag modes, each branch typed', () => {
        expect(schema.anyOf).toEqual([
          { type: 'object', required: ['amenity'] },
          { type: 'object', required: ['tag_key', 'tag_value'] },
        ]);
      });

      // Regression for #54: an empty array built an Overpass union with no members
      // and returned the guaranteed-empty result as a geographic miss. The
      // constraint has to reach the client, not just the handler.
      it('publishes minItems: 1 on element_types, keeping its default', () => {
        const properties = schema.properties as Record<
          string,
          { type?: string; minItems?: number; default?: unknown }
        >;
        expect(properties.element_types?.type).toBe('array');
        expect(properties.element_types?.minItems).toBe(1);
        expect(properties.element_types?.default).toEqual(['node', 'way']);
      });
    });
  }
});

/**
 * Regression for #57: every field was optional with no `required`, so an argument
 * generator reading the published schema saw a tool where a call with no arguments at
 * all was valid, and learned otherwise only from the handler's runtime rejection.
 */
describe('advertised search-mode requirement', () => {
  const schema = advertisedInputSchema(openstreetmapSearchPlaces.input);

  it('stays an object schema with no unconditionally-required field', () => {
    // A top-level union would drop `type: "object"` — the MCP spec requires it, and
    // the SDK swaps a non-object schema for an empty one when serving tools/list.
    expect(schema.type).toBe('object');
    // Every field is optional or defaulted, so Zod emits no `required` at the root.
    // The anyOf below is what states the requirement; a root `required` would make
    // one mode mandatory for both.
    expect(schema.required).toBeUndefined();
  });

  it('publishes anyOf over the seven query-mode branches, each branch typed', () => {
    expect(schema.anyOf).toEqual([
      { type: 'object', required: ['query'] },
      { type: 'object', required: ['street'] },
      { type: 'object', required: ['city'] },
      { type: 'object', required: ['county'] },
      { type: 'object', required: ['state'] },
      { type: 'object', required: ['country'] },
      { type: 'object', required: ['postalcode'] },
    ]);
  });

  // A branch declaring its own `properties` generates no request body at all under an
  // OpenAPI converter that builds one model per branch — the arguments are dropped in
  // flight. Every field definition has to stay in the root object.
  it('keeps every field definition in root properties, branches carrying required only', () => {
    const properties = schema.properties as Record<string, { type?: string }>;
    for (const field of ['query', 'street', 'city', 'county', 'state', 'country', 'postalcode']) {
      expect(properties[field]?.type).toBe('string');
    }
    for (const branch of schema.anyOf as Record<string, unknown>[]) {
      expect(Object.keys(branch).sort()).toEqual(['required', 'type']);
    }
  });
});
