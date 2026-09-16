/**
 * @fileoverview Guards the advertised tool surface — the Nominatim tools use explicit
 * three-token names, the retired two-token names are no longer exposed, the Overpass
 * convenience tools publish their tag-mode requirement and their non-empty element_types
 * constraint, openstreetmap_search_places publishes its query / structured-address
 * requirement, and every tool advertises a closed argument object, all in the inputSchema
 * clients receive. Also budgets the advertised text every client loads per session, and
 * pins the facts prior decisions put on the wire so a tightening pass cannot drop one.
 * @module tests/tools/tool-surface.test
 */

import { z } from '@cyanheads/mcp-ts-core';
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

/**
 * Convert a tool's input the way tools/list does. `@modelcontextprotocol/server` reads the
 * Standard Schema JSON Schema hook at `draft-2020-12` (falling back to `z.toJSONSchema` for
 * a schema library that lacks the hook) and defaults a missing root `type` to `"object"`,
 * so this is the JSON a client parses — asserting on the Zod object instead would pass even
 * if the requirement never reached the wire.
 *
 * The definition's `input` is what `tool()` stored, which is the strictened schema: an
 * unrecognized argument key is rejected and `additionalProperties: false` is advertised.
 */
const SDK_TARGET = 'draft-2020-12';

function advertisedInputSchema(input: unknown): Record<string, unknown> {
  const standard = (input as { '~standard'?: { jsonSchema?: Record<string, unknown> } })[
    '~standard'
  ];
  const hook = standard?.jsonSchema as
    | { input?: (options: { target: string }) => Record<string, unknown> }
    | undefined;
  const result = hook?.input
    ? hook.input({ target: SDK_TARGET })
    : (z.toJSONSchema(input as z.ZodType, {
        target: SDK_TARGET,
        io: 'input',
      }) as unknown as Record<string, unknown>);
  return { type: 'object', ...result };
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

/**
 * Tool inputs are closed: an argument key the schema does not declare is rejected by name
 * rather than silently stripped, and `additionalProperties: false` says so on the wire. The
 * three tools that attach `anyOf` metadata declare `.strict()` themselves — Zod's `.strict()`
 * returns an instance outside the metadata registry, so metadata attached after the fact
 * would be dropped when the framework strictened the schema for them.
 */
describe('advertised argument closure', () => {
  const allTools = [
    openstreetmapSearchPlaces,
    openstreetmapReverseGeocode,
    openstreetmapLookupObjects,
    openstreetmapQueryNearby,
    openstreetmapQueryBbox,
    openstreetmapQueryRaw,
  ];

  for (const definition of allTools) {
    it(`advertises additionalProperties: false on ${definition.name}`, () => {
      const schema = advertisedInputSchema(definition.input);
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
    });

    it(`rejects an undeclared argument key on ${definition.name}`, () => {
      const parsed = (definition.input as z.ZodType).safeParse({
        __undeclared_key__: 'x',
      });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain('__undeclared_key__');
    });
  }
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
          { type: 'object', required: ['tag_key'] },
        ]);
      });

      it('advertises a bounded AND filter array with optional values', () => {
        const properties = schema.properties as Record<string, Record<string, unknown>>;
        expect(properties.filters).toMatchObject({
          type: 'array',
          maxItems: 5,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['key'],
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
            },
          },
        });
        expect(properties.tag_key?.description).toContain('omit tag_value');
        expect(properties.tag_value?.description).toContain('blank');
        expect(properties.filters?.description).toContain('AND');
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
 * Regression for #59: the documented `layer` set and the `exclude_place_ids` token
 * format lived in `.describe()` prose only, so a generator reading the schema saw two
 * free-form strings and learned the constraint from a live Nominatim 400.
 *
 * Both are `anyOf` over an empty-string literal and the constrained string — a form
 * client submits the whole schema shape, so an untouched field arrives as `""` and must
 * not be refused. The constraint still has to reach the wire as a `pattern`, which is
 * what a generator reads, so these assertions dig it out of the branch that carries it.
 */
describe('advertised Nominatim parameter constraints (#59)', () => {
  const searchProperties = advertisedInputSchema(openstreetmapSearchPlaces.input)
    .properties as Record<string, Record<string, unknown>>;

  /** The single `pattern` a property advertises, whether flat or inside its `anyOf`. */
  function advertisedPattern(property: Record<string, unknown> | undefined): string {
    const branches = (property?.anyOf as Record<string, unknown>[] | undefined) ?? [property ?? {}];
    const patterns = branches.map((branch) => branch?.pattern).filter(Boolean) as string[];
    expect(patterns).toHaveLength(1);
    return patterns[0]!;
  }

  /** True when the property advertises the empty string as an accepted value. */
  function advertisesEmptyString(property: Record<string, unknown> | undefined): boolean {
    const branches = (property?.anyOf as Record<string, unknown>[] | undefined) ?? [];
    return branches.some((branch) => branch?.const === '');
  }

  it('publishes the layer enum as a pattern on openstreetmap_search_places', () => {
    const pattern = new RegExp(advertisedPattern(searchProperties.layer));
    // Asserted by matching rather than by substring: the pattern spells each name as
    // per-letter character classes, since a JSON-Schema pattern carries no `i` flag.
    for (const layer of ['address', 'poi', 'railway', 'natural', 'manmade']) {
      expect(pattern.test(layer)).toBe(true);
    }
    expect(pattern.test('address,poi')).toBe(true);
    expect(pattern.test('bogus')).toBe(false);
    expect(pattern.test('address,bogus')).toBe(false);
  });

  it('publishes the layer pattern case-insensitively, as Nominatim accepts it', () => {
    const pattern = new RegExp(advertisedPattern(searchProperties.layer));
    expect(pattern.test('ADDRESS')).toBe(true);
    expect(pattern.test('Address, poi')).toBe(true);
    expect(pattern.test('BOGUS')).toBe(false);
  });

  it('publishes the same layer pattern on openstreetmap_reverse_geocode', () => {
    const reverseProperties = advertisedInputSchema(openstreetmapReverseGeocode.input)
      .properties as Record<string, Record<string, unknown>>;
    expect(advertisedPattern(reverseProperties.layer)).toBe(
      advertisedPattern(searchProperties.layer),
    );
  });

  it('advertises the empty string alongside the pattern on both layer fields', () => {
    const reverseProperties = advertisedInputSchema(openstreetmapReverseGeocode.input)
      .properties as Record<string, Record<string, unknown>>;
    expect(advertisesEmptyString(searchProperties.layer)).toBe(true);
    expect(advertisesEmptyString(reverseProperties.layer)).toBe(true);
  });

  it('publishes the exclude_place_ids token pattern on the array items', () => {
    const items = searchProperties.exclude_place_ids?.items as Record<string, unknown>;
    const pattern = new RegExp(advertisedPattern(items));
    expect(pattern.test('N13872184444')).toBe(true);
    expect(pattern.test('325649065')).toBe(true);
    expect(pattern.test('garbage')).toBe(false);
    expect(advertisesEmptyString(items)).toBe(true);
  });
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

/**
 * The advertised text every client loads before its first call, measured on the emitted
 * JSON Schema rather than the Zod objects — a `.describe()` that grows only reaches a
 * client through this surface.
 *
 * Coverage is every byte this server authors: the tool `description`, the emitted
 * `inputSchema`, the emitted success schema (`output` extended with `enrichment`, which is
 * where the paging and caveat fields live), and the error-contract `when` clauses the
 * framework concatenates into the `error.data.reason` enum description. The framework's own
 * error envelope, field optionalization, and `examples` array are excluded: they are
 * fixed per tool and no wording change here can move them. The delivered `tools/list` reply
 * is larger for exactly that reason — 54,777 B against this budget's 47,848 B when the
 * ceiling below was set.
 *
 * The number is a measured baseline, not a spec. Cutting text is expected; growing past it
 * means a description regrew, and the fix is to justify the new bytes and re-measure, not
 * to raise the ceiling reflexively.
 */
describe('advertised catalog budget', () => {
  const ADVERTISED_TEXT_CEILING_BYTES = 47_900;

  const definitions = [
    openstreetmapSearchPlaces,
    openstreetmapReverseGeocode,
    openstreetmapLookupObjects,
    openstreetmapQueryNearby,
    openstreetmapQueryBbox,
    openstreetmapQueryRaw,
  ];

  /** Serialized UTF-8 bytes — what the value costs on the wire, not its UTF-16 length. */
  function serializedBytes(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }

  /**
   * The success schema as advertised: `output` extended with `enrichment`, which is how
   * the framework merges the two before emission.
   */
  function advertisedOutputSchema(definition: (typeof definitions)[number]): unknown {
    const enrichment = definition.enrichment as z.ZodRawShape | undefined;
    const schema = enrichment ? definition.output.extend(enrichment) : definition.output;
    return z.toJSONSchema(schema as z.ZodType, { target: SDK_TARGET, io: 'output' });
  }

  /** The `when` clauses, in the shape the framework folds into the reason enum. */
  function advertisedErrorReasons(definition: (typeof definitions)[number]): string {
    return (definition.errors ?? []).map((entry) => `\`${entry.reason}\`: ${entry.when}`).join(' ');
  }

  function advertisedBytes(definition: (typeof definitions)[number]): number {
    return serializedBytes({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      inputSchema: advertisedInputSchema(definition.input),
      outputSchema: advertisedOutputSchema(definition),
      errorReasons: advertisedErrorReasons(definition),
    });
  }

  it('keeps the six-tool advertised text within the measured ceiling', () => {
    const total = definitions.reduce((sum, definition) => sum + advertisedBytes(definition), 0);
    expect(total).toBeLessThanOrEqual(ADVERTISED_TEXT_CEILING_BYTES);
  });

  it('keeps openstreetmap_search_places, the heaviest tool, under a third of the budget', () => {
    const heaviest = advertisedBytes(openstreetmapSearchPlaces);
    expect(heaviest).toBeLessThanOrEqual(ADVERTISED_TEXT_CEILING_BYTES / 3);
  });
});

/**
 * The facts prior issues put on the wire, pinned by name rather than by prose length.
 * Every entry is a decision a tightening pass must not quietly undo: #52's per-moment
 * tag-selection signals, #55's `exclude_place_ids` walk, #39's two-case `notice`, #54's
 * `element_types` floor, and the declared error reasons.
 */
describe('advertised facts held by prior decisions', () => {
  const nominatimTools = [
    openstreetmapSearchPlaces,
    openstreetmapReverseGeocode,
    openstreetmapLookupObjects,
  ];

  const allTools = [
    ...nominatimTools,
    openstreetmapQueryNearby,
    openstreetmapQueryBbox,
    openstreetmapQueryRaw,
  ];

  /** The `tagSelectionCaveat` description a Nominatim tool advertises. */
  function caveatDescription(definition: (typeof nominatimTools)[number]): string {
    const field = (definition.enrichment as Record<string, z.ZodType | undefined>)
      .tagSelectionCaveat;
    expect(field).toBeDefined();
    return field?.description ?? '';
  }

  /** An `openstreetmap_search_places` enrichment field description, by key. */
  function searchEnrichmentDescription(key: string): string {
    const field = (openstreetmapSearchPlaces.enrichment as Record<string, z.ZodType | undefined>)[
      key
    ];
    expect(field).toBeDefined();
    return field?.description ?? '';
  }

  /** The advertised `openstreetmap_search_places` input properties, keyed by field name. */
  function searchInputProperties(): Record<string, { description?: string; maximum?: number }> {
    return advertisedInputSchema(openstreetmapSearchPlaces.input).properties as Record<
      string,
      { description?: string; maximum?: number }
    >;
  }

  /**
   * Every `extratags` description in the three Nominatim tools' emitted output schemas.
   * Walked rather than indexed: the field sits under `results[].extratags` on two tools and
   * `result.extratags` on the third, and the assertion is about the text, not the path.
   */
  function extratagsOutputDescriptions(): string[] {
    const found: string[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const entry of node) visit(entry);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const extratags = (record.properties as Record<string, unknown> | undefined)?.extratags as
        | { description?: string }
        | undefined;
      if (extratags?.description) found.push(extratags.description);
      for (const value of Object.values(record)) visit(value);
    };
    for (const definition of nominatimTools) {
      visit(z.toJSONSchema(definition.output as z.ZodType, { target: SDK_TARGET, io: 'output' }));
    }
    expect(found).toHaveLength(nominatimTools.length);
    return found;
  }

  const OVERPASS_TOOL_NAMES = [
    'openstreetmap_query_nearby',
    'openstreetmap_query_bbox',
    'openstreetmap_query_raw',
  ];

  it('#52: every tagSelectionCaveat field names all three Overpass tools', () => {
    for (const definition of nominatimTools) {
      for (const name of OVERPASS_TOOL_NAMES) {
        expect(caveatDescription(definition)).toContain(name);
      }
    }
  });

  it('#52: every tagSelectionCaveat field keeps the decorates-not-selects distinction', () => {
    for (const definition of nominatimTools) {
      expect(caveatDescription(definition)).toMatch(
        /decorates the returned objects rather than selecting them/i,
      );
    }
  });

  it('#52: the caveat field states its own emission condition, which differs per tool', () => {
    expect(caveatDescription(openstreetmapSearchPlaces)).toContain(
      'Present on every successful response.',
    );
    for (const definition of [openstreetmapReverseGeocode, openstreetmapLookupObjects]) {
      expect(caveatDescription(definition)).toContain('Present when extratags was requested.');
    }
  });

  it('#52: every extratags output field names physical attribute tags', () => {
    for (const description of extratagsOutputDescriptions()) {
      for (const tag of ['surface', 'tracktype', 'sac_scale', 'ele', 'access']) {
        expect(description).toContain(tag);
      }
    }
  });

  it('#52: every extratags output field states the absence semantics', () => {
    for (const description of extratagsOutputDescriptions()) {
      expect(description).toContain('an absent tag describes this object, not OpenStreetMap');
    }
  });

  it('#39: the search_places notice field documents the cap case and the exhausted case', () => {
    const description = searchEnrichmentDescription('notice');
    expect(description).toContain('capped');
    expect(description).toContain('exhausted');
  });

  it('#39: the notice field says to tell the two cases apart by truncated and the count', () => {
    const description = searchEnrichmentDescription('notice');
    expect(description).toMatch(/truncated and the result count/i);
    expect(description).toMatch(/not by this field's presence/i);
  });

  it('#55: exclude_place_ids names the nextExcludeIds retrieval mechanism', () => {
    expect(searchInputProperties().exclude_place_ids?.description).toContain('nextExcludeIds');
  });

  it('#55: exclude_place_ids names the zero-result termination signal', () => {
    expect(searchInputProperties().exclude_place_ids?.description).toMatch(/returns zero results/i);
  });

  it('#55: nextExcludeIds points back at exclude_place_ids and names its token forms', () => {
    const description = searchEnrichmentDescription('nextExcludeIds');
    expect(description).toContain('exclude_place_ids');
    expect(description).toContain('N/W/R + osm_id');
    expect(description).toContain('place_id');
  });

  it('#55: truncated states the probe and that absence is not exhaustion', () => {
    const description = searchEnrichmentDescription('truncated');
    expect(description).toMatch(/probe/i);
    expect(description).toMatch(/relevance cutoff/i);
    expect(description).toMatch(/absence is not exhaustion/i);
  });

  it('#55: the 40-result ceiling stays on the limit field it bounds', () => {
    const limit = searchInputProperties().limit;
    expect(limit?.maximum).toBe(40);
    expect(limit?.description).toContain('40');
  });

  it('#54: element_types keeps its minItems floor and says why an empty array is rejected', () => {
    for (const definition of [openstreetmapQueryBbox, openstreetmapQueryNearby]) {
      const properties = advertisedInputSchema(definition.input).properties as Record<
        string,
        { minItems?: number; description?: string }
      >;
      expect(properties.element_types?.minItems).toBe(1);
      expect(properties.element_types?.description).toMatch(
        /an empty array is rejected because it can only match nothing/i,
      );
    }
  });

  it('keeps the query_raw cache ceiling literal on the offset field', () => {
    const properties = advertisedInputSchema(openstreetmapQueryRaw.input).properties as Record<
      string,
      { description?: string }
    >;
    expect(properties.offset?.description).toContain('100000');
  });

  it('still declares every error reason each tool shipped with', () => {
    const declared = {
      openstreetmap_search_places: [
        'no_results',
        'conflicting_query_mode',
        'missing_query_mode',
        'bounded_without_viewbox',
        'invalid_viewbox',
        'invalid_parameters',
        'rate_limited',
        'upstream_error',
      ],
      openstreetmap_reverse_geocode: [
        'no_coverage',
        'invalid_parameters',
        'rate_limited',
        'upstream_error',
      ],
      openstreetmap_lookup_objects: [
        'invalid_id_format',
        'invalid_parameters',
        'rate_limited',
        'upstream_error',
      ],
      openstreetmap_query_nearby: [
        'invalid_tag',
        'query_timeout',
        'result_too_large',
        'rate_limited',
        'upstream_error',
        'overpass_gateway_timeout',
        'overpass_unavailable',
        'endpoints_exhausted',
        'endpoints_unavailable',
      ],
      openstreetmap_query_bbox: [
        'invalid_bbox',
        'invalid_tag',
        'query_timeout',
        'result_too_large',
        'rate_limited',
        'upstream_error',
        'overpass_gateway_timeout',
        'overpass_unavailable',
        'endpoints_exhausted',
        'endpoints_unavailable',
      ],
      openstreetmap_query_raw: [
        'query_error',
        'query_timeout',
        'result_too_large',
        'rate_limited',
        'upstream_error',
        'overpass_gateway_timeout',
        'overpass_unavailable',
        'endpoints_exhausted',
        'endpoints_unavailable',
      ],
    } as const;

    for (const definition of allTools) {
      const reasons = (definition.errors ?? []).map((entry) => entry.reason);
      expect(reasons).toEqual(declared[definition.name as keyof typeof declared]);
    }
  });

  it('gives every declared reason a condition and a remedy of its own', () => {
    for (const definition of allTools) {
      for (const entry of definition.errors ?? []) {
        expect(entry.when.trim().length).toBeGreaterThan(0);
        // The linter's own floor for a hint that names an action rather than gesturing at one.
        expect(entry.recovery.trim().split(/\s+/).length).toBeGreaterThanOrEqual(5);
      }
    }
  });
});
