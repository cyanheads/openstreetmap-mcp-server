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
import { type ErrorContract, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
  it('keeps declared aliases out of the canonical advertised properties (#110)', () => {
    for (const definition of [
      openstreetmapQueryNearby,
      openstreetmapReverseGeocode,
      openstreetmapSearchPlaces,
    ]) {
      const schema = advertisedInputSchema(definition.input);
      const properties = schema.properties as Record<string, unknown>;
      for (const alias of ['latitude', 'longitude', 'radius_m', 'q']) {
        expect(properties).not.toHaveProperty(alias);
      }
      expect(properties).toHaveProperty(definition === openstreetmapSearchPlaces ? 'query' : 'lat');
      expect(schema.additionalProperties).toBe(false);
    }
  });

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
    {
      definition: openstreetmapQueryNearby,
      geoRequired: ['lat', 'lon'],
      // One spatial mode, so the advertised branches are the two tag modes alone.
      modes: [
        { type: 'object', required: ['amenity'] },
        { type: 'object', required: ['tag_key'] },
      ],
    },
    {
      definition: openstreetmapQueryBbox,
      // #71: the four corners became optional when `within` joined them as a second
      // spatial mode, so nothing is unconditionally required — the mode product below is
      // what states that every call carries one spatial scope and one primary tag.
      geoRequired: undefined,
      modes: [
        { type: 'object', required: ['south', 'west', 'north', 'east', 'amenity'] },
        { type: 'object', required: ['south', 'west', 'north', 'east', 'tag_key'] },
        { type: 'object', required: ['within', 'amenity'] },
        { type: 'object', required: ['within', 'tag_key'] },
      ],
    },
  ];

  for (const { definition, geoRequired, modes } of tagTools) {
    describe(definition.name, () => {
      const schema = advertisedInputSchema(definition.input);

      it('stays an object schema whose required fields are the geographic ones, if any', () => {
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

      it('publishes anyOf over the full mode product, each branch typed', () => {
        expect(schema.anyOf).toEqual(modes);
      });

      it('keeps every branch field in root properties, branches carrying required only', () => {
        const properties = schema.properties as Record<string, unknown>;
        for (const branch of modes) {
          for (const field of branch.required) expect(properties).toHaveProperty(field);
          expect(Object.keys(branch)).toEqual(['type', 'required']);
        }
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
              match: { type: 'string', enum: ['exact', 'list_item'] },
            },
          },
        });
        expect(properties.tag_key?.description).toContain('omit tag_value');
        expect(properties.tag_value?.description).toContain('blank');
        expect(properties.filters?.description).toContain('AND');
      });

      // #83: exact equality silently undercounts semicolon-list tags, so the option has to
      // be on the wire as a closed enum, and the value fields have to name it.
      it('advertises the list-item match mode on the primary tag and every filter', () => {
        const properties = schema.properties as Record<string, Record<string, unknown>>;
        expect(properties.tag_value_match).toMatchObject({
          type: 'string',
          enum: ['exact', 'list_item'],
        });
        expect(schema.required ?? []).not.toContain('tag_value_match');
        expect(properties.tag_value?.description).toContain('tag_value_match "list_item"');
        expect(properties.filters?.description).toContain('match "list_item"');
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
 * is larger for exactly that reason — 54,777 B against a 47,848 B budget when this ceiling
 * was first set.
 *
 * The number is a measured baseline, not a spec. Cutting text is expected; growing past it
 * means a description regrew, and the fix is to justify the new bytes and re-measure, not
 * to raise the ceiling reflexively.
 *
 * Re-measured once since, at 50,760 B, for #71's boundary scope. The 2,912 new bytes are a
 * capability rather than a regrown description: `within` and its `invalid_scope` contract on
 * openstreetmap_query_bbox, the `effectiveArea` and `areasTimestamp` enrichment that report
 * how the boundary resolved and how stale the area database is, and the chaining recipe on
 * the three Nominatim `osm_id` fields plus openstreetmap_query_raw — the ref was already
 * being handed out with nothing saying what consumes it.
 *
 * Re-measured at 51,423 B for #83's list-item match. The new bytes are the
 * `tag_value_match` and per-filter `match` enums on openstreetmap_query_nearby and
 * openstreetmap_query_bbox, the sentence on `tag_value` and `filters` saying exact equality
 * misses semicolon-list values, the `key∋value` form in `effectiveTag`, and the
 * `invalid_tag` condition for a list-item match with no value — without them the
 * undercount reaches the caller as a plausible-looking result.
 *
 * Re-measured at 52,161 B for #84's stray-amenity hint, 738 B over the #83 figure: one
 * sentence on each `amenity` field naming the sibling keys a caller is likely to miss
 * (tourism, leisure, shop, historic, natural), and the `notice` descriptions saying the
 * field now also appears on a page of matches. An `amenity=museum` survey otherwise comes
 * back empty over a city with dozens of museums and reads as "there are none".
 *
 * Re-measured at 52,298 B for #103's nearest-point distance. The new bytes are on
 * openstreetmap_query_nearby's `distance_meters`, which now says what it measures to — the
 * feature's nearest point, 0 inside an area, never 0 for a route — and on `lat`/`lon`, which
 * name the bounding-box center they always were. Without them a caller reads a 0 m park whose
 * coordinates sit a kilometre away as a contradiction.
 *
 * Re-measured at 52,771 B for #104 and #106. 312 B are the `overpass_gateway_timeout` and
 * `overpass_unavailable` `when` clauses on the three Overpass tools, which now say a 504 or
 * 408 whose remark names a busy or stopped dispatcher is the endpoint refusing the query,
 * not the query outrunning a budget — the one place a caller learns that shrinking the
 * query will not help. 161 B are on openstreetmap_query_raw: the `query` sentence naming
 * the `[maxsize:268435456]` it adds when the query carries none, and `effectiveQuery`
 * saying that injection shows there, so a caller reading its own query back can tell the
 * directive did not come from them.
 *
 * Re-measured at 52,942 B for #107, 171 B over the #104/#106 figure: the `result_too_large`
 * `when` clause on the three Overpass tools, 57 B each, now also names the 64 MiB the server
 * reads from one response. It named only the memory remark, so a caller whose response
 * passed the ceiling read a contract that did not describe what happened to it.
 *
 * Re-measured at 54,688 B for #82 and #105. #82's 588 B are on openstreetmap_lookup_objects:
 * `not_found` and the tool description now say the list holds IDs with no Nominatim record,
 * which includes live objects Nominatim does not index, and a `notice` field carries the
 * openstreetmap_query_raw check that tells the two apart. The old wording read as "deleted".
 * #105's 1,158 B are a capability: an over-cap `limit` on four tools and an over-50 `osm_ids`
 * are now served up to the cap instead of rejected, so each `limit` description names its
 * per-call value and the clamp, the four tools gain `limitNotice`, and lookup gains
 * `deferred_ids`; the removed `max_element_bytes` ceiling took its sentence off `maxElementBytes`.
 *
 * Re-measured at 54,817 B, 129 B over, for the center-only fallback on
 * openstreetmap_query_nearby: when the response carrying a survey's geometry passes the 64 MiB
 * read ceiling, the call is served ranked by bounding-box center rather than failing.
 * `distance_meters` now says it can measure to the center, and `notice` says it reports when it
 * did; without them a center distance reads as a nearest-point one.
 */
describe('advertised catalog budget', () => {
  const ADVERTISED_TEXT_CEILING_BYTES = 54_817;

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

  /**
   * #55 pinned `maximum: 40` here. #105 moved the 40 from a schema rejection to a clamp, so
   * the advertised `maximum` is the 10,000 absurd-input guard and the 40 lives in the
   * description, which says what a larger value gets.
   */
  it('#55/#105: the limit field names the 40-result ceiling and the clamp above it', () => {
    const limit = searchInputProperties().limit;
    expect(limit?.maximum).toBe(10_000);
    expect(limit?.description).toContain(
      "up to 40 (Nominatim's own ceiling); a larger value is served as 40 and limitNotice says so",
    );
  });

  /**
   * #105: the advertised schema loosens only the output-size bounds — `osm_ids` `maxItems`
   * 50 → 500, `limit` `maximum` → 10000, `max_element_bytes` loses its `maximum` — and each
   * description states the per-call value and what a larger one gets.
   */
  it('#105: osm_ids advertises maxItems 500 and the 50-per-call deferral', () => {
    const osmIds = (
      advertisedInputSchema(openstreetmapLookupObjects.input).properties as Record<
        string,
        { maxItems?: number; description?: string }
      >
    ).osm_ids;
    expect(osmIds?.maxItems).toBe(500);
    expect(osmIds?.description).toContain(
      'the first 50 unique IDs are looked up per call, the rest returned under deferred_ids',
    );
  });

  it('#105: each Overpass limit advertises maximum 10000 and the 500 clamp', () => {
    for (const definition of [
      openstreetmapQueryNearby,
      openstreetmapQueryBbox,
      openstreetmapQueryRaw,
    ]) {
      const limit = (
        advertisedInputSchema(definition.input).properties as Record<
          string,
          { maximum?: number; description?: string }
        >
      ).limit;
      expect(limit?.maximum).toBe(10_000);
      expect(limit?.description).toContain(
        'up to 500 per call; a larger value is served as 500 and limitNotice says so',
      );
    }
  });

  /**
   * Zod emits every `.int()` with `maximum: Number.MAX_SAFE_INTEGER` (offset carries the
   * same), so "no maximum" on the wire is that integer bound and no authored ceiling.
   */
  it('#105: max_element_bytes advertises its floor and no authored maximum', () => {
    const properties = advertisedInputSchema(openstreetmapQueryRaw.input).properties as Record<
      string,
      { minimum?: number; maximum?: number }
    >;
    expect(properties.max_element_bytes?.minimum).toBe(1_000);
    expect(properties.max_element_bytes?.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(properties.offset?.maximum).toBe(Number.MAX_SAFE_INTEGER);
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

  it('#84: amenity names the sibling keys and notice says it can appear on any page', () => {
    for (const definition of [openstreetmapQueryNearby, openstreetmapQueryBbox]) {
      const properties = advertisedInputSchema(definition.input).properties as Record<
        string,
        { description?: string }
      >;
      for (const key of ['tourism', 'leisure', 'shop', 'historic', 'natural']) {
        expect(properties.amenity?.description).toContain(key);
      }
      expect(properties.amenity?.description).toContain('tag_key and tag_value');
      const notice = (definition.enrichment as Record<string, z.ZodType | undefined>).notice;
      expect(notice?.description).toContain('On any page');
      expect(notice?.description).not.toContain('Absent when results were returned');
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
        'endpoints_rejected',
        'pacer_shed',
      ],
      openstreetmap_query_bbox: [
        'invalid_scope',
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
        'endpoints_rejected',
        'pacer_shed',
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
        'endpoints_rejected',
        'pacer_shed',
      ],
    } as const;

    for (const definition of allTools) {
      const reasons = (definition.errors ?? []).map((entry) => entry.reason);
      expect(reasons).toEqual(declared[definition.name as keyof typeof declared]);
    }
  });

  /**
   * #87: an all-refused call is an endpoint configuration fault, not a property of
   * the query, so every Overpass tool gives the caller the same next step for it —
   * unlike the size-dependent hints, which name each tool's own scope parameters.
   */
  it('#87: declares endpoints_rejected identically on all three Overpass tools', () => {
    const entries = [openstreetmapQueryNearby, openstreetmapQueryBbox, openstreetmapQueryRaw].map(
      (definition) => definition.errors?.find((entry) => entry.reason === 'endpoints_rejected'),
    );
    for (const entry of entries) {
      expect(entry).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        retryable: false,
        thrownBy: 'service',
      });
    }
    expect(new Set(entries.map((entry) => entry?.recovery)).size).toBe(1);
    expect(new Set(entries.map((entry) => entry?.when)).size).toBe(1);
    const hint = entries[0]?.recovery ?? '';
    for (const fact of ['404', '401', '403', 'OSM_OVERPASS_BASE_URL', 'OSM_OVERPASS_ENDPOINTS']) {
      expect(hint).toContain(fact);
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

/**
 * `thrownBy: 'service'` is lint-only: it tells `error-contract-unthrown` that a reason is
 * produced below the handler. Every handler here also re-throws through a computed reason,
 * which makes the linter skip the definition entirely, so these rules are enforced here
 * instead. A marker on a reason the handler throws itself would hide a dead entry; a marker
 * that differs between tools sharing one service means one of them is wrong.
 */
describe('error-contract provenance markers', () => {
  const siblingGroups = {
    nominatim: [openstreetmapSearchPlaces, openstreetmapReverseGeocode, openstreetmapLookupObjects],
    overpass: [openstreetmapQueryNearby, openstreetmapQueryBbox, openstreetmapQueryRaw],
  };

  /** Widened to the framework's entry type: an unmarked entry's literal type has no `thrownBy`. */
  const entriesOf = (definition: { errors?: readonly ErrorContract[] }): readonly ErrorContract[] =>
    definition.errors ?? [];

  for (const [service, definitions] of Object.entries(siblingGroups)) {
    it(`marks a reason identically on every ${service} tool that declares it`, () => {
      const markings = new Map<string, boolean>();
      for (const definition of definitions) {
        for (const entry of entriesOf(definition)) {
          const marked = entry.thrownBy === 'service';
          expect(marked, entry.reason).toBe(markings.get(entry.reason) ?? marked);
          markings.set(entry.reason, marked);
        }
      }
    });

    it(`never marks a reason a ${service} handler throws through a literal ctx.fail`, () => {
      for (const definition of definitions) {
        const source = definition.handler.toString();
        for (const entry of entriesOf(definition)) {
          if (entry.thrownBy !== 'service') continue;
          expect(source).not.toMatch(new RegExp(`ctx\\.fail\\(\\s*['"]${entry.reason}['"]`));
        }
      }
    });
  }
});
