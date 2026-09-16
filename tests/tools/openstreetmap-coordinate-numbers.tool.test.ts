/**
 * @fileoverview Regression for #77 — the Nominatim tools emit `lat`, `lon` and
 * `boundingbox` as numbers, so a coordinate copied out of one validates against the
 * Overpass tools that consume it. Every fixture below is a verbatim Nominatim jsonv2
 * body, driven through the real service (only the HTTP call is faked), so the parse
 * under test actually runs instead of being stubbed out by a service-level mock.
 * @module tests/tools/openstreetmap-coordinate-numbers.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openstreetmapLookupObjects } from '@/mcp-server/tools/definitions/openstreetmap-lookup-objects.tool.js';
import { openstreetmapQueryBbox } from '@/mcp-server/tools/definitions/openstreetmap-query-bbox.tool.js';
import { openstreetmapQueryNearby } from '@/mcp-server/tools/definitions/openstreetmap-query-nearby.tool.js';
import { openstreetmapReverseGeocode } from '@/mcp-server/tools/definitions/openstreetmap-reverse-geocode.tool.js';
import { openstreetmapSearchPlaces } from '@/mcp-server/tools/definitions/openstreetmap-search-places.tool.js';
import { initNominatimService } from '@/services/nominatim/nominatim-service.js';
import { type ContractError, captureThrown } from '../helpers/handler-error.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    nominatimBaseUrl: 'https://nominatim.openstreetmap.org',
    overpassBaseUrl: 'https://overpass-api.de/api/interpreter',
    nominatimUserAgent: 'openstreetmap-mcp-server/test',
  }),
}));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    fetchWithTimeout: vi.fn(async () => new Response('[]', { status: 200 })),
  };
});

const mockFetch = vi.mocked(fetchWithTimeout);

// --- verbatim Nominatim jsonv2 bodies ------------------------------------

/** `/search?q=Tremp Lleida Spain&limit=1` — the chain #76 reported failing. */
const SEARCH_BODY = `[{"place_id":84433023,"licence":"Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright","osm_type":"relation","osm_id":343014,"lat":"42.1669782","lon":"0.8950137","category":"boundary","type":"administrative","place_rank":16,"importance":0.5456084868702602,"addresstype":"town","name":"Tremp","display_name":"Tremp, Pallars Jussà, Lleida, Catalunya, España","address":{"town":"Tremp","county":"Pallars Jussà","state_district":"Lleida","ISO3166-2-lvl6":"ES-L","state":"Catalunya","ISO3166-2-lvl4":"ES-CT","country":"España","country_code":"es"},"boundingbox":["42.1099808","42.3758816","0.6953014","0.9717633"]}]`;

/** `/reverse?lat=42.1669782&lon=0.8950137&zoom=18` — a bare object, not an array. */
const REVERSE_BODY = `{"place_id":84346090,"licence":"Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright","osm_type":"way","osm_id":320367256,"lat":"42.1669694","lon":"0.8950311","category":"highway","type":"pedestrian","place_rank":26,"importance":0.053394303044174835,"addresstype":"road","name":"Plaça de Francesc Pujol","display_name":"Plaça de Francesc Pujol, Tremp, Pallars Jussà, Lleida, Catalunya, 25620, España","address":{"road":"Plaça de Francesc Pujol","town":"Tremp","county":"Pallars Jussà","state_district":"Lleida","ISO3166-2-lvl6":"ES-L","state":"Catalunya","ISO3166-2-lvl4":"ES-CT","postcode":"25620","country":"España","country_code":"es"},"boundingbox":["42.1668933","42.1670342","0.8949175","0.8951315"]}`;

/** `/lookup?osm_ids=R343014` — the osm_type/osm_id the search result hands out. */
const LOOKUP_BODY = `[{"place_id":84183574,"licence":"Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright","osm_type":"relation","osm_id":343014,"lat":"42.1669782","lon":"0.8950137","category":"boundary","type":"administrative","place_rank":16,"importance":0.5456084868702602,"addresstype":"town","name":"Tremp","display_name":"Tremp, Pallars Jussà, Lleida, Catalunya, España","address":{"town":"Tremp","county":"Pallars Jussà","state_district":"Lleida","ISO3166-2-lvl6":"ES-L","state":"Catalunya","ISO3166-2-lvl4":"ES-CT","country":"España","country_code":"es"},"boundingbox":["42.1099808","42.3758816","0.6953014","0.9717633"]}]`;

/**
 * `/search?q=Antarctica&limit=1` — Nominatim pads every coordinate to seven decimal
 * places, so a whole-degree bound arrives as `"-180.0000000"`. The one place the
 * rendered text is not byte-for-byte what it was before the parse landed.
 */
const PADDED_SEARCH_BODY = `[{"place_id":85003734,"licence":"Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright","osm_type":"relation","osm_id":2186646,"lat":"-72.8438691","lon":"0.0000000","category":"boundary","type":"administrative","place_rank":4,"importance":0.6,"addresstype":"continent","name":"Antarctica","display_name":"Antarctica","boundingbox":["-85.0511289","-59.9999999","-180.0000000","180.0000000"]}]`;

/** `/reverse` over open ocean — HTTP 200 with an error body and no place fields. */
const NO_COVERAGE_BODY = `{"error":"Unable to geocode"}`;

function respondWith(body: string) {
  mockFetch.mockImplementation(async () => new Response(body, { status: 200 }));
}

/**
 * A fresh tenant per call: the service caches on `ctx.state`, so reusing one tenant
 * across fixtures would serve the first body to every later test.
 */
function tenant(): string {
  return `t-${Math.random().toString(36).slice(2)}`;
}

/** The rendered `content[]` text a content-only client reads. */
function formatText(blocks: { type: string; text?: string }[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

async function runSearch(body = SEARCH_BODY) {
  respondWith(body);
  const result = await openstreetmapSearchPlaces.handler(
    openstreetmapSearchPlaces.input.parse({ query: 'Tremp Lleida Spain', limit: 1 }),
    createMockContext({ tenantId: tenant(), errors: openstreetmapSearchPlaces.errors }),
  );
  // `structuredContent` is the schema-stripped result, not the raw handler return.
  return openstreetmapSearchPlaces.output.parse(result);
}

async function runReverse(body = REVERSE_BODY) {
  respondWith(body);
  const result = await openstreetmapReverseGeocode.handler(
    openstreetmapReverseGeocode.input.parse({ lat: 42.1669782, lon: 0.8950137 }),
    createMockContext({ tenantId: tenant(), errors: openstreetmapReverseGeocode.errors }),
  );
  return openstreetmapReverseGeocode.output.parse(result);
}

async function runLookup(body = LOOKUP_BODY) {
  respondWith(body);
  const result = await openstreetmapLookupObjects.handler(
    openstreetmapLookupObjects.input.parse({ osm_ids: ['R343014'] }),
    createMockContext({ tenantId: tenant(), errors: openstreetmapLookupObjects.errors }),
  );
  return openstreetmapLookupObjects.output.parse(result);
}

describe('Nominatim coordinates are numbers end to end (#77)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    initNominatimService({} as unknown as AppConfig, {} as unknown as StorageService);
  });

  /**
   * `toEqual` reads `42.1669782` and `"42.1669782"` as different values but reports
   * them almost identically, so every type assertion here goes through the serialized
   * frame — the bytes a client actually parses.
   */
  describe('structuredContent carries JSON numbers', () => {
    it('openstreetmap_search_places emits numeric lat, lon and boundingbox', async () => {
      const parsed = await runSearch();
      const place = parsed.results[0]!;

      expect(typeof place.lat).toBe('number');
      expect(typeof place.lon).toBe('number');
      expect(JSON.stringify(place.lat)).toBe('42.1669782');
      expect(JSON.stringify(place.lon)).toBe('0.8950137');
      expect(JSON.stringify(place.boundingbox)).toBe('[42.1099808,42.3758816,0.6953014,0.9717633]');
    });

    it('openstreetmap_reverse_geocode emits numeric lat, lon and boundingbox', async () => {
      const parsed = await runReverse();
      const place = parsed.result;

      expect(JSON.stringify(place.lat)).toBe('42.1669694');
      expect(JSON.stringify(place.lon)).toBe('0.8950311');
      expect(JSON.stringify(place.boundingbox)).toBe('[42.1668933,42.1670342,0.8949175,0.8951315]');
    });

    it('openstreetmap_lookup_objects emits numeric lat, lon and boundingbox', async () => {
      const parsed = await runLookup();
      const place = parsed.results[0]!;

      expect(JSON.stringify(place.lat)).toBe('42.1669782');
      expect(JSON.stringify(place.lon)).toBe('0.8950137');
      expect(JSON.stringify(place.boundingbox)).toBe('[42.1099808,42.3758816,0.6953014,0.9717633]');
    });
  });

  /** The chain #76 reported: geocode a place, then ask what is near it. */
  describe('round trip into the Overpass tools', () => {
    it("feeds a search result's lat and lon straight into openstreetmap_query_nearby", async () => {
      const place = (await runSearch()).results[0]!;

      const input = openstreetmapQueryNearby.input.parse({
        lat: place.lat,
        lon: place.lon,
        amenity: 'pharmacy',
      });

      expect(input.lat).toBe(42.1669782);
      expect(input.lon).toBe(0.8950137);
    });

    it("maps a search result's boundingbox onto openstreetmap_query_bbox", async () => {
      const box = (await runSearch()).results[0]!.boundingbox!;
      const [south, north, west, east] = box;

      const input = openstreetmapQueryBbox.input.parse({
        south,
        north,
        west,
        east,
        amenity: 'pharmacy',
      });

      expect([input.south, input.north, input.west, input.east]).toEqual([
        42.1099808, 42.3758816, 0.6953014, 0.9717633,
      ]);
    });

    it("feeds a search result's lat and lon back into openstreetmap_reverse_geocode", async () => {
      const place = (await runSearch()).results[0]!;
      const input = openstreetmapReverseGeocode.input.parse({ lat: place.lat, lon: place.lon });
      expect([input.lat, input.lon]).toEqual([42.1669782, 0.8950137]);
    });

    it("feeds a lookup result's lat and lon into openstreetmap_query_nearby", async () => {
      const place = (await runLookup()).results[0]!;
      const input = openstreetmapQueryNearby.input.parse({
        lat: place.lat,
        lon: place.lon,
        amenity: 'pharmacy',
      });
      expect([input.lat, input.lon]).toEqual([42.1669782, 0.8950137]);
    });

    it("feeds a reverse result's lat and lon into openstreetmap_query_nearby", async () => {
      const place = (await runReverse()).result;
      const input = openstreetmapQueryNearby.input.parse({
        lat: place.lat,
        lon: place.lon,
        amenity: 'pharmacy',
      });
      expect([input.lat, input.lon]).toEqual([42.1669694, 0.8950311]);
    });
  });

  /**
   * Characterization: a coordinate Nominatim writes in canonical decimal form renders
   * byte-for-byte as it did while the field was a string, on all three tools.
   */
  describe('content[] rendering', () => {
    it('renders the search coordinate and bounding box unchanged', async () => {
      const text = formatText(openstreetmapSearchPlaces.format!(await runSearch()));
      expect(text).toContain('**Coordinates:** 42.1669782, 0.8950137');
      expect(text).toContain('**Bounding box:** S:42.1099808 N:42.3758816 W:0.6953014 E:0.9717633');
    });

    it('renders the reverse coordinate and bounding box unchanged', async () => {
      const text = formatText(openstreetmapReverseGeocode.format!(await runReverse()));
      expect(text).toContain('**Coordinates:** 42.1669694, 0.8950311');
      expect(text).toContain('**Bounding box:** S:42.1668933 N:42.1670342 W:0.8949175 E:0.8951315');
    });

    it('renders the lookup coordinate and bounding box unchanged', async () => {
      const text = formatText(openstreetmapLookupObjects.format!(await runLookup()));
      expect(text).toContain('**Coordinates:** 42.1669782, 0.8950137');
      expect(text).toContain('**Bounding box:** S:42.1099808 N:42.3758816 W:0.6953014 E:0.9717633');
    });

    /**
     * The single rendering delta the parse introduces, pinned rather than left to
     * drift: Nominatim pads coordinates to seven decimals, and a number drops the
     * padding. `0.0000000` renders `0` and `-180.0000000` renders `-180` — the same
     * coordinate, written the way every other numeric field on these tools is.
     */
    it('drops the upstream zero padding from a whole-degree coordinate', async () => {
      const parsed = await runSearch(PADDED_SEARCH_BODY);
      expect(JSON.stringify(parsed.results[0]!.boundingbox)).toBe(
        '[-85.0511289,-59.9999999,-180,180]',
      );

      const text = formatText(openstreetmapSearchPlaces.format!(parsed));
      expect(text).toContain('**Coordinates:** -72.8438691, 0');
      expect(text).toContain('**Bounding box:** S:-85.0511289 N:-59.9999999 W:-180 E:180');
    });
  });

  describe('malformed and absent coordinates', () => {
    it('fails the call as upstream_error when Nominatim sends a non-numeric lat', async () => {
      respondWith(`[{"place_id":1,"lat":"north","lon":"0.8950137","display_name":"Nowhere"}]`);
      const err = await captureThrown(
        openstreetmapSearchPlaces.handler(
          openstreetmapSearchPlaces.input.parse({ query: 'Tremp', limit: 1 }),
          createMockContext({ tenantId: tenant(), errors: openstreetmapSearchPlaces.errors }),
        ),
      );

      expect(err).toBeInstanceOf(McpError);
      expect((err as ContractError).data).toMatchObject({ reason: 'upstream_error' });
    });

    it('fails the call as upstream_error when a boundingbox entry is not a number', async () => {
      respondWith(
        `[{"place_id":1,"lat":"42.1","lon":"0.8","display_name":"Nowhere","boundingbox":["42.1","","0.6","0.9"]}]`,
      );
      const err = await captureThrown(
        openstreetmapSearchPlaces.handler(
          openstreetmapSearchPlaces.input.parse({ query: 'Tremp', limit: 1 }),
          createMockContext({ tenantId: tenant(), errors: openstreetmapSearchPlaces.errors }),
        ),
      );

      expect((err as ContractError).data).toMatchObject({ reason: 'upstream_error' });
    });

    it('still reports no_coverage for the error body Nominatim serves over open ocean', async () => {
      respondWith(NO_COVERAGE_BODY);
      const err = await captureThrown(
        openstreetmapReverseGeocode.handler(
          openstreetmapReverseGeocode.input.parse({ lat: 0, lon: -40 }),
          createMockContext({ tenantId: tenant(), errors: openstreetmapReverseGeocode.errors }),
        ),
      );

      expect((err as ContractError).data).toMatchObject({ reason: 'no_coverage' });
    });

    it('omits boundingbox entirely when the upstream record carries none', async () => {
      const parsed = await runSearch(
        `[{"place_id":1,"lat":"42.1669782","lon":"0.8950137","display_name":"Tremp"}]`,
      );
      expect(parsed.results[0]!.boundingbox).toBeUndefined();
      expect(JSON.stringify(parsed.results[0]!.lat)).toBe('42.1669782');
    });

    it('reports every requested id as not found when lookup returns an empty array', async () => {
      respondWith('[]');
      const result = await openstreetmapLookupObjects.handler(
        openstreetmapLookupObjects.input.parse({ osm_ids: ['R343014'] }),
        createMockContext({ tenantId: tenant(), errors: openstreetmapLookupObjects.errors }),
      );
      const parsed = openstreetmapLookupObjects.output.parse(result);
      expect(parsed.results).toHaveLength(0);
      expect(parsed.not_found).toEqual(['R343014']);
    });
  });

  /**
   * The advertised `outputSchema` is what a client reads to decide whether a value it
   * just received can be handed to the next tool — asserting on the Zod object alone
   * would pass even if the declaration never reached the wire.
   */
  describe('advertised output schema', () => {
    const cases = [
      { definition: openstreetmapSearchPlaces, place: ['results', 'items'] },
      { definition: openstreetmapLookupObjects, place: ['results', 'items'] },
      { definition: openstreetmapReverseGeocode, place: ['result'] },
    ] as const;

    for (const { definition, place } of cases) {
      it(`${definition.name} advertises lat, lon and boundingbox as numbers`, () => {
        const schema = z.toJSONSchema(definition.output as unknown as z.ZodType, {
          target: 'draft-2020-12',
          io: 'output',
        }) as Record<string, unknown>;

        let node = schema;
        for (const step of place) {
          node = (
            step === 'items' ? node.items : (node.properties as Record<string, unknown>)[step]
          ) as Record<string, unknown>;
        }

        const properties = node.properties as Record<string, Record<string, unknown>>;
        expect(properties.lat?.type).toBe('number');
        expect(properties.lon?.type).toBe('number');

        // Zod emits a fixed-length tuple as `prefixItems` under draft-2020-12.
        const box = properties.boundingbox as Record<string, unknown>;
        const items = (box.prefixItems ?? box.items) as { type?: string }[];
        expect(items).toHaveLength(4);
        for (const item of items) expect(item.type).toBe('number');
      });
    }
  });
});
