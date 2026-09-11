# openstreetmap-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `openstreetmap_search_places` | Forward geocoding: convert a place name or address to coordinates and structured place data. Supports free-form and structured address input. | `query` (free-form) OR structured fields (`street`, `city`, `state`, `country`, `postalcode`); `limit`, `countrycodes`, `layer`, `featureType` | `readOnlyHint: true` |
| `openstreetmap_reverse_geocode` | Reverse geocoding: convert lat/lon to the nearest address or place. Returns the closest OSM object with full address breakdown. | `lat`, `lon`, `zoom` (detail level 3–18), `layer` | `readOnlyHint: true` |
| `openstreetmap_lookup_objects` | Look up address details for specific OSM objects by their IDs. Useful when an OSM node/way/relation ID is already known. | `osm_ids` (up to 50, prefixed with N/W/R) | `readOnlyHint: true` |
| `openstreetmap_query_nearby` | Find OSM features within a radius around a point. The primary convenience tool for "what's near X?" spatial queries. Covers nodes, ways, and relations. | `lat`, `lon`, `radius_meters`, `amenity` or `tag_key` (optional `tag_value`), `filters`, `limit`, `offset` | `readOnlyHint: true` |
| `openstreetmap_query_bbox` | Find OSM features within a bounding box. Useful for area surveys, not proximity searches. | `south`, `west`, `north`, `east`; `amenity` or `tag_key` (optional `tag_value`), `filters`, `limit`, `offset` | `readOnlyHint: true` |
| `openstreetmap_query_raw` | Execute a raw Overpass QL query for advanced spatial queries the convenience tools don't cover. | `query` (Overpass QL string), `limit`, `offset`, `max_element_bytes`, `timeout_seconds` | `readOnlyHint: true` |

### Resources

None — this server is tool-only. Geocoding results are point-in-time lookups with no stable addressable identity that would benefit from resource URIs. All data is accessible via tools.

### Prompts

None — the domain is data/action oriented. Tool descriptions are sufficient to guide agent usage.

---

## Overview

An MCP server bridging OpenStreetMap's two primary data APIs into a unified geocoding and spatial query interface. Nominatim handles text-to-coordinates and coordinates-to-text; Overpass handles "what exists at/near/within this location?" Both are free, require no API keys, and together cover the full range of location-resolution workflows agents need.

Primary use cases:
- Resolving place names to coordinates before calling other servers (NWS weather, earthquake data, GBIF biodiversity)
- Address parsing and validation
- Finding points of interest within a geographic area
- Reverse geocoding coordinates back to human-readable addresses

Global coverage. Read-only.

---

## Requirements

- Forward geocoding: free-form text and structured address queries via Nominatim `/search`
- Reverse geocoding: lat/lon → address/place via Nominatim `/reverse`, with zoom-level detail control
- OSM ID lookup: address details for known OSM node/way/relation IDs via Nominatim `/lookup`
- Spatial POI search: find features by tag within a radius (around filter) via Overpass
- Spatial bbox search: find features by tag within a bounding box via Overpass
- Raw Overpass QL: full query expressiveness for advanced use cases
- No authentication required for either API
- Nominatim public instance: max 1 req/sec; valid User-Agent required
- Overpass public instance: rate limit is 2 concurrent slots (reported by `/api/status`), up to 10,000 queries/day and 1 GB/day
- No bulk geocoding patterns (systematic grids, exhaustive POI downloads)
- Must not autocomplete — Nominatim explicitly forbids autocomplete use
- Must cache results in `ctx.state` to avoid redundant requests to the same query within a session
- Attribution: data © OpenStreetMap contributors, ODbL 1.0

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `NominatimService` | Nominatim API (nominatim.openstreetmap.org) | `openstreetmap_search_places`, `openstreetmap_reverse_geocode`, `openstreetmap_lookup_objects` |
| `OverpassService` | Overpass API (overpass-api.de/api/interpreter) | `openstreetmap_query_nearby`, `openstreetmap_query_bbox`, `openstreetmap_query_raw` |

Both services are stateless HTTP clients with retry logic and session-level result caching via `ctx.state`.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `OSM_NOMINATIM_BASE_URL` | No | Override the Nominatim endpoint (default: `https://nominatim.openstreetmap.org`). Use when running a private instance. |
| `OSM_OVERPASS_BASE_URL` | No | Pin every query to one Overpass endpoint, disabling mirror failover (default: unset). What a private-instance deployment wants. |
| `OSM_OVERPASS_ENDPOINTS` | No | Comma-separated ordered failover list (default: `https://overpass-api.de/api/interpreter` — one entry, so no failover). A transient failure advances to the next entry inside the same tool call. Ignored when `OSM_OVERPASS_BASE_URL` is set. |
| `OSM_OVERPASS_MAX_CONCURRENCY` | No | Cap on Overpass queries in flight at once (default: `2`, the public endpoint's slot budget). Submissions past the cap queue locally. |
| `OSM_USER_AGENT` | No | Identifies the application to Nominatim (default: `openstreetmap-mcp-server/<version>`). Must be set if the default violates the operator's policy. |

---

## Implementation Order

1. Config and server setup (`server-config.ts` with its optional env vars)
2. `NominatimService` — HTTP client, retry, response normalization, session cache
3. `OverpassService` — HTTP client, Overpass QL builder helpers, retry, session cache
4. `openstreetmap_search_places` tool
5. `openstreetmap_reverse_geocode` tool
6. `openstreetmap_lookup_objects` tool
7. `openstreetmap_query_nearby` tool
8. `openstreetmap_query_bbox` tool
9. `openstreetmap_query_raw` tool

Each tool is independently testable after its service is in place.

---

## Domain Mapping

### Nominatim operations

| Operation | Endpoint | Notes |
|:----------|:---------|:------|
| Forward geocode (free-form) | `GET /search?q=...&format=jsonv2` | Up to 40 results; returns importance score for ranking |
| Forward geocode (structured) | `GET /search?street=...&city=...&format=jsonv2` | Cannot combine with `q` |
| Reverse geocode | `GET /reverse?lat=...&lon=...&format=jsonv2` | Returns exactly one result or error |
| OSM ID lookup | `GET /lookup?osm_ids=N123,W456&format=jsonv2` | Up to 50 IDs per request; prefixed N/W/R |

All Nominatim requests: `format=jsonv2`, `addressdetails=1` by default. `extratags=1` optional (adds wikipedia, opening_hours, phone, etc.).

**Response shape (jsonv2):**
```json
{
  "place_id": 324761213,
  "osm_type": "way",
  "osm_id": 12903132,
  "lat": "47.6205131",
  "lon": "-122.3493036",
  "category": "man_made",
  "type": "tower",
  "place_rank": 30,
  "importance": 0.439,
  "addresstype": "man_made",
  "name": "Space Needle",
  "display_name": "Space Needle, 400, Broad Street, ..., Seattle, ...",
  "address": {
    "man_made": "Space Needle",
    "house_number": "400",
    "road": "Broad Street",
    "city": "Seattle",
    "county": "King County",
    "state": "Washington",
    "postcode": "98109",
    "country": "United States",
    "country_code": "us"
  },
  "boundingbox": ["47.6203", "47.6207", "-122.3496", "-122.3491"],
  "extratags": { "phone": "+1-206-905-2100", "website": "...", "wikidata": "Q5317" }
}
```

Observed field sparsity: `name` is absent for address-only results; `extratags` present only when requested; `address` contents vary by feature type (not normalized).

### Overpass operations

All queries POST to `/api/interpreter` with `Content-Type: application/x-www-form-urlencoded`, body `data=<query>`.

**Endpoint selection and failover.** `OSM_OVERPASS_BASE_URL` pins one endpoint when set; otherwise the ordered `OSM_OVERPASS_ENDPOINTS` list applies, defaulting to a single entry so failover is off unless an operator opts in. Rotation rides the existing `withRetry` attempt loop keyed on the attempt index and wraps past the end of the list, so the first entry stays the preferred endpoint and one that shed load a moment ago gets another chance.

`isTransientOverpassError` is what keeps a deterministic failure on one endpoint: a `query_timeout`, `result_too_large`, HTTP 400, or a query-describing `upstream_error` remark stops the retry loop, so the closure never runs again to pick up the next endpoint. A 5xx rotates — that is the endpoint shedding load, not refusing the call.

Four failures are *endpoint*-scoped rather than call-scoped, so a call-local wrapper in `executeQuery` handles them separately: a throttle (HTTP 429 without `Retry-After`, or a throttle document), a connection-level rejection (refused, unresolvable, or a blackhole the OS gave up on), a per-attempt client deadline, and an `upstream_error` whose text carries a recognized OSM3S dispatcher signature. Such a host is recorded in a per-call fault map, rotation skips it for the rest of the call, and the call ends once every endpoint is in the map. With one endpoint configured the map fills on the first fault, so the single-endpoint fail-fast is unchanged. The map is a closure local, not service state, so concurrent calls never see each other's rotation.

The client deadline is on that list because Bun's `fetch` cannot distinguish a handshake that never completed from a query accepted and held — it exposes no connect-phase timeout, and its socket `timeout` option is an idle timer that resets on every byte, so any value short enough to catch a blackhole would also abort a healthy long query. The faulting decision does not need the distinction: a host given a full attempt window and re-asked would get only the budget's remainder, which cannot succeed where the whole window did not.

The map records *what* each endpoint did, not merely that it failed, because `withRetry` rethrows the raw error once the predicate turns it down — so the terminal error would otherwise be whichever attempt happened to fail last. A call whose faults are all of one kind that already ends on a true, declared reason keeps that error untouched: all-throttled stays `rate_limited`, and an OSM3S dispatcher fault on every host stays `upstream_error` carrying the remark its recovery hint tells the caller to read. The two shapes that reach the caller with no reason at all are composed instead — all-unanswered as `endpoints_exhausted`, and a refusal, an unreachable host, or any mix as `endpoints_unavailable` — each message naming every endpoint and its outcome (`overpass-api.de/api/interpreter: HTTP 429; mirror.example/api/interpreter: connection refused`), so a caller can tell "every host was unavailable" from "every host was too slow for this query". Endpoint names are redacted to origin plus path, the same as `servedBy`.

Three properties bound the cost:

- **One slot budget, not one per endpoint.** `withSlot` acquires and releases inside a single attempt, so a rotating caller never carries the previous endpoint's slot. A global cap can only ever be at or below any single endpoint's budget, which under-uses a mirror during a failover — acceptable, because failover is a fallback rather than a load-balancing target.
- **One time budget across attempts.** Each attempt derives its deadline from `min(remaining budget, per-attempt ceiling)`, measured after the slot is granted so the queue wait counts against it. Both the ceiling and the total budget derive from the `[timeout:N]` the query carries — `max(90s, N + 30s)` per attempt and `max(120s, per-attempt + 30s)` in total — so a caller asking Overpass for more time is actually waited for. Reading the directive out of the QL covers a value a caller wrote into the query string themselves, which no input schema can reach. Both layers widen only, so a query that fits the flat budget today keeps it exactly. When nothing is left, the call fails with `endpoints_exhausted` rather than submitting. The per-attempt window is what an unanswered attempt now costs a call outright — the host is faulted, so it is never re-asked — which bounds the worst case at one window per configured endpoint; the total budget cuts even that off, so a long list of hanging mirrors cannot multiply one window by its length.
- **The serving endpoint is reported and cached.** `servedBy` is redacted to origin plus path (an operator-configured mirror can carry credentials or a `?key=`) and stored with the cached response, so a cache hit names the endpoint that produced the data rather than the one the reading call would have tried first.

**Radius query (around filter):**
```
[out:json][timeout:25];
(
  node["amenity"="hospital"](around:3000,47.6062,-122.3321);
  way["amenity"="hospital"](around:3000,47.6062,-122.3321);
  relation["amenity"="hospital"](around:3000,47.6062,-122.3321);
);
out center tags;
```

**Bbox query:**
```
[out:json][timeout:25];
(
  node["leisure"="park"](47.60,-122.34,47.62,-122.31);
  way["leisure"="park"](47.60,-122.34,47.62,-122.31);
);
out center tags;
```

**Response shape:**
```json
{
  "version": 0.6,
  "osm3s": { "timestamp_osm_base": "2026-05-23T17:01:31Z" },
  "elements": [
    {
      "type": "way",
      "id": 169511257,
      "center": { "lat": 47.6043096, "lon": -122.3238285 },
      "tags": {
        "name": "Harborview Medical Center",
        "amenity": "hospital",
        "beds": "413",
        "phone": "+1-206-744-3000"
      }
    }
  ]
}
```

Nodes have `lat`/`lon` directly; ways and relations have `center` (from `out center`). Tags are OSM key/value strings — values are always strings, including numbers. Verified with real requests.

---

## Tool Design Details

### `openstreetmap_search_places`

**Input:**

```ts
z.object({
  // Free-form or structured — validated in handler (mutually exclusive)
  query: z.string().optional()
    .describe('Free-form search string (e.g., "Space Needle Seattle" or "1600 Pennsylvania Ave NW, Washington DC"). Cannot be combined with structured address fields.'),
  street: z.string().optional()
    .describe('House number and street name (structured query). Use with city/state/country fields. Cannot be combined with query.'),
  city: z.string().optional()
    .describe('City name (structured query).'),
  county: z.string().optional()
    .describe('County or district (structured query).'),
  state: z.string().optional()
    .describe('State or province (structured query).'),
  country: z.string().optional()
    .describe('Country name or ISO 3166-1 alpha-2 code (structured query).'),
  postalcode: z.string().optional()
    .describe('Postal or ZIP code (structured query).'),
  limit: z.number().int().min(1).max(40).default(5)
    .describe('Maximum results to return. Nominatim may return fewer when additional results do not sufficiently match. Max 40.'),
  // The alpha-2 constraint is advertised as a JSON-Schema pattern rather than prose
  // alone, because Nominatim's failure here is silent: it discards a token it cannot
  // parse and answers HTTP 200 with the search run unfiltered, so an alpha-3 code, a
  // semicolon list, or a country name widened the query to the whole world. Any casing
  // and spaces around the commas are tolerated (Nominatim honors both), and an empty
  // string is paired in so a form client's untouched field is treated as omitted.
  countrycodes: z.union([z.literal(''), z.string().regex(NOMINATIM_COUNTRYCODE_PATTERN)]).optional()
    .describe('Restrict results to one or more countries. Comma-separated ISO 3166-1 alpha-2 codes (e.g., "us,ca"), in any casing and with optional spaces around the commas. Anything else is rejected here rather than by Nominatim; a well-formed code for a country that does not exist is forwarded and matches nothing. Preferred over the structured "country" field when filtering.'),
  // Bias results toward an area. Bias only unless `bounded` is set, and unlike
  // openstreetmap_query_bbox's box this one may not cross the antimeridian.
  viewbox: z.object({
    west: z.number().min(-180).max(180).describe('Western boundary longitude. Must be strictly less than east.'),
    south: z.number().min(-90).max(90).describe('Southern boundary latitude. Must be strictly less than north.'),
    east: z.number().min(-180).max(180).describe('Eastern boundary longitude. Must be strictly greater than west.'),
    north: z.number().min(-90).max(90).describe('Northern boundary latitude. Must be strictly greater than south.'),
  }).optional()
    .describe('Rectangular area to bias results toward, for disambiguating a name that repeats worldwide. Finer-grained than countrycodes and more precise than adding locality words to the query. Bias only by default; set bounded to make it a hard restriction. Unlike openstreetmap_query_bbox, this box may not cross the antimeridian.'),
  bounded: z.boolean().optional()
    .describe('Restrict results to the viewbox instead of merely biasing toward it. Requires viewbox — setting it alone is rejected rather than ignored.'),
  // The documented layer set is advertised as a JSON-Schema pattern rather than prose
  // alone. A comma-separated list rather than a bare enum: Nominatim documents the
  // parameter as one, and openstreetmap_reverse_geocode matches `address,poi` by default.
  // Case-insensitive (Nominatim accepts any casing) and paired with an empty-string
  // literal, so a form client's untouched field is accepted and treated as omitted.
  layer: z.union([z.literal(''), z.string().regex(NOMINATIM_LAYER_PATTERN)]).optional()
    .describe('Filter by data layer. One value or a comma-separated list drawn from: address, poi, railway, natural, manmade, in any casing. An undocumented layer name is rejected here rather than by Nominatim; an empty value is accepted and treated as omitted. Default: no restriction.'),
  featureType: z.enum(['country', 'state', 'city', 'settlement']).optional()
    .describe('Restrict results to a geographic feature type. Automatically implies the address layer.'),
  extratags: z.boolean().default(false)
    .describe('Include the extra OSM tags the matched object carries — contact and metadata tags (phone, website, opening_hours, wikidata) and physical attribute tags alike (surface, tracktype, sac_scale, ele, access). Opportunistic, not selective: it reports whatever the matched object happens to carry, so an absent tag describes that object rather than OpenStreetMap, and no value here can steer which object is matched. Increases response size.'),
  language: z.string().optional()
    .describe('Preferred language for result names (BCP 47 language code or Accept-Language string, e.g., "en", "de", "fr,en"). Defaults to local OSM language if unset.'),
  // Each token is an OSM ref (N/W/R + id) or a bare Nominatim place_id — the two forms
  // this tool's own `nextExcludeIds` emits. Anything else is refused upstream as
  // `Invalid exclude ID: <token>`, so the format is advertised as a pattern. The handler
  // trims each token and uppercases the ref prefix, matching openstreetmap_lookup_objects;
  // a blank entry excludes nothing and is dropped rather than forwarded or rejected.
  exclude_place_ids: z.array(z.union([z.literal(''), z.string().regex(NOMINATIM_EXCLUDE_ID_PATTERN)])).optional()
    .describe('OSM refs (N/W/R + id) or Nominatim place_ids to drop from results, forwarded as the exclude_place_ids parameter. Pass the nextExcludeIds value from a prior full page to page toward further matches.'),
})
```

**Truncation semantics.** Nominatim's `/search` reports no total anywhere — the body is
a bare array, and the headers carry neither `X-Total-Count` nor `Link` — so a page that
exactly fills `limit` cannot be told from a shorter set by size alone. The handler
requests `limit + 1` in the same call and reads the extra row's presence as the signal,
dropping it before returning; the caller never sees more than `limit`. `truncated` is
therefore a confirmed observation rather than an inference from page size. The probe
costs no additional request against the 1 req/sec budget, and is honest at the tool's
own 40-result ceiling: measured on two queries (`q=pharmacy`, `q=school`), a request
for 41 is served in full — the documented 40 maximum is not enforced as a hard clip.

What the probe proves is bounded. It reads Nominatim's own relevance cutoff, not the end
of the matching set: the docs state that excluding ids "would cause the search to return
other, less accurate, matches (if possible)", and `q=pharmacy&limit=11` returns 10 rows
while excluding those 10 ids returns 10 more. So `truncated` means a further match exists
at this query's cutoff, and `nextExcludeIds` is emitted on any page that fills `limit` —
gating the paging token on the probe ended walks that still had results in them.

**Output:**

```ts
z.object({
  results: z.array(z.object({
    place_id: z.number().describe('Nominatim internal place ID. Use osm_type+osm_id for stable cross-server references.'),
    osm_type: z.enum(['node', 'way', 'relation']).optional().describe('OSM object type.'),
    osm_id: z.number().optional().describe('OSM object ID. Combine with osm_type for openstreetmap_lookup_objects.'),
    lat: z.string().describe('Latitude (WGS84, as string from API).'),
    lon: z.string().describe('Longitude (WGS84, as string from API).'),
    display_name: z.string().describe('Full human-readable address string.'),
    name: z.string().optional().describe('Feature name if applicable (e.g., "Space Needle"). Absent for address-only results.'),
    category: z.string().optional().describe('OSM feature category (e.g., "amenity", "man_made", "boundary").'),
    type: z.string().optional().describe('OSM feature type within category (e.g., "hospital", "tower", "administrative").'),
    importance: z.number().optional().describe('Nominatim relevance score (0–1). Higher is more globally prominent.'),
    address: z.record(z.string(), z.string()).optional().describe('Structured address breakdown. Keys vary by feature type and country. Common keys: house_number, road, suburb, city, state, postcode, country, country_code.'),
    boundingbox: z.tuple([z.string(), z.string(), z.string(), z.string()]).optional()
      .describe('Bounding box [south, north, west, east] as strings.'),
    extratags: z.record(z.string(), z.string()).optional().describe('Extra OSM tags this object carries — contact and metadata (phone, website, opening_hours, wikidata) and physical attributes (surface, tracktype, sac_scale, ele, access). Present only when extratags was requested; an absent tag describes this object, not OpenStreetMap.'),
  })).describe('Geocoding results, ordered by Nominatim relevance (importance score descending).'),
  total: z.number().describe('Number of results returned.'),
  attribution: z.string().describe('Required data attribution: Data © OpenStreetMap contributors, ODbL 1.0.'),
})
```

**Errors:**

```ts
errors: [
  {
    reason: 'no_results',
    code: JsonRpcErrorCode.NotFound,
    when: 'No places matched the query on a first page — no exclude_place_ids were supplied. An exhausted paging walk returns success with zero results instead.',
    recovery: 'Drop any intermediate qualifier token (a parent institution or campus between the POI and the city) and retry as "name, city", check spelling, or switch to the structured address fields.',
  },
  {
    reason: 'conflicting_query_mode',
    code: JsonRpcErrorCode.ValidationError,
    when: 'The free-form query and at least one structured address field are both provided — the two modes are mutually exclusive.',
    recovery: 'Send one mode only: keep query and drop every structured address field, or drop query and keep the structured fields (street, city, county, state, country, postalcode).',
  },
  {
    reason: 'missing_query_mode',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Neither the free-form query nor any structured address field is provided.',
    recovery: 'Supply one of the two modes: the query parameter for a free-form search ("Space Needle Seattle"), or at least one structured address field (street, city, county, state, country, postalcode).',
  },
  {
    reason: 'bounded_without_viewbox',
    code: JsonRpcErrorCode.ValidationError,
    when: 'bounded was set to true but no viewbox was supplied — there is no area for it to restrict results to',
    recovery: 'Supply a viewbox with west, south, east and north for bounded to restrict results to, or drop bounded to search without an area restriction.',
  },
  {
    reason: 'invalid_viewbox',
    code: JsonRpcErrorCode.ValidationError,
    when: 'The viewbox is inverted or degenerate on either axis — west at or beyond east, or south at or beyond north',
    recovery: 'Order the corners so west is strictly less than east and south strictly less than north. A box spanning the antimeridian cannot be expressed here — split it into one call east of 180 and one west of it.',
  },
  {
    reason: 'invalid_parameters',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'Nominatim returned HTTP 400 — it refused one of the forwarded parameters. Its own message names the parameter and is carried in this error',
    retryable: false,
    recovery: 'Read the parameter Nominatim named in the message and correct that value before calling again — the identical request is refused identically, so retrying unchanged cannot succeed.',
  },
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Nominatim returned HTTP 429, or answered HTTP 200 with a throttle document instead of JSON — the one request per second usage policy was exceeded',
    retryable: true,
    recovery: 'Wait several seconds before retrying and keep the call rate at or below one request per second, or point OSM_NOMINATIM_BASE_URL at a private Nominatim instance.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Nominatim returned an unexpected non-2xx status other than 429, or answered HTTP 200 with a body that is not JSON and carries no throttle signature',
    retryable: true,
    recovery: 'Retry after a short delay. If it persists, verify OSM_NOMINATIM_BASE_URL points at a working Nominatim endpoint — a 404 usually means the base URL is wrong — and check whether the instance is up.',
  },
]
```

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true`

---

### `openstreetmap_reverse_geocode`

**Input:**

```ts
z.object({
  lat: z.number().min(-90).max(90).describe('Latitude in WGS84 decimal degrees.'),
  lon: z.number().min(-180).max(180).describe('Longitude in WGS84 decimal degrees.'),
  zoom: z.number().int().min(3).max(18).default(18)
    .describe('Address detail level, roughly corresponding to map zoom. 18=building, 16=street, 14=neighbourhood, 12=town, 10=city, 8=county, 5=state, 3=country.'),
  // Same shape and pattern as openstreetmap_search_places' layer field.
  layer: z.union([z.literal(''), z.string().regex(NOMINATIM_LAYER_PATTERN)]).optional()
    .describe('Restrict which OSM layer is matched. One value or a comma-separated list drawn from: address, poi, railway, natural, manmade, in any casing. An undocumented layer name is rejected here rather than by Nominatim; an empty value is accepted and treated as omitted. Default: address,poi.'),
  extratags: z.boolean().default(false)
    .describe('Include the extra OSM tags the matched object carries — contact and metadata tags (phone, website, opening_hours, wikidata) and physical attribute tags alike (surface, tracktype, sac_scale, ele, access). Opportunistic, not selective: it reports whatever the matched object happens to carry, so an absent tag describes that object rather than OpenStreetMap, and no value here can steer which object is matched.'),
  language: z.string().optional()
    .describe('Preferred language for the result (BCP 47 code or Accept-Language string).'),
})
```

**Output:**

```ts
z.object({
  result: z.object({
    place_id: z.number().describe('Nominatim internal place ID.'),
    osm_type: z.enum(['node', 'way', 'relation']).optional(),
    osm_id: z.number().optional(),
    lat: z.string().describe('Latitude of the matched OSM object.'),
    lon: z.string().describe('Longitude of the matched OSM object.'),
    display_name: z.string().describe('Full human-readable address.'),
    name: z.string().optional().describe('Feature name, if the result is a named place.'),
    category: z.string().optional(),
    type: z.string().optional(),
    address: z.record(z.string(), z.string()).optional()
      .describe('Structured address. Keys vary by feature type. Common: house_number, road, suburb, city, state, postcode, country, country_code.'),
    boundingbox: z.tuple([z.string(), z.string(), z.string(), z.string()]).optional()
      .describe('Bounding box [south, north, west, east] as strings.'),
    extratags: z.record(z.string(), z.string()).optional(),
  }).describe('The closest matching OSM object at the given coordinates.'),
  attribution: z.string().describe('Required data attribution.'),
})
```

**Note:** Nominatim reverse geocoding finds the *closest* suitable OSM object, not necessarily the object whose polygon the coordinate falls in. In dense areas the result may differ from the expected address. For building-level accuracy, use zoom=18.

**Implementation note:** When no OSM data covers the given coordinates, Nominatim returns HTTP 200 with body `{"error": "Unable to geocode"}` — not an empty or null response. The handler must detect this `error` key and throw `no_coverage`; it should not return a null result object.

**Errors:**

```ts
errors: [
  {
    reason: 'no_coverage',
    code: JsonRpcErrorCode.NotFound,
    when: 'Nominatim returns {"error": "Unable to geocode"} — no OSM data at the given coordinates (e.g., open ocean or unmapped territory)',
    recovery: 'Verify the coordinates are correct. Try a lower zoom value to match at a coarser level (e.g., zoom=10 for city-level).',
  },
  {
    reason: 'invalid_parameters',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'Nominatim returned HTTP 400 — it refused one of the forwarded parameters. Its own message names the parameter and is carried in this error',
    retryable: false,
    recovery: 'Read the parameter Nominatim named in the message and correct that value before calling again — the identical request is refused identically, so retrying unchanged cannot succeed.',
  },
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Nominatim returned HTTP 429, or answered HTTP 200 with a throttle document instead of JSON — the one request per second usage policy was exceeded',
    retryable: true,
    recovery: 'Wait several seconds before retrying and keep the call rate at or below one request per second, or point OSM_NOMINATIM_BASE_URL at a private Nominatim instance.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Nominatim returned an unexpected non-2xx status other than 429, or answered HTTP 200 with a body that is not JSON and carries no throttle signature',
    retryable: true,
    recovery: 'Retry after a short delay. If it persists, verify OSM_NOMINATIM_BASE_URL points at a working Nominatim endpoint — a 404 usually means the base URL is wrong — and check whether the instance is up.',
  },
]
```

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true`

---

### `openstreetmap_lookup_objects`

**Input:**

```ts
z.object({
  osm_ids: z.array(z.string()).min(1).max(50)
    .describe('OSM IDs to look up, each prefixed with N (node), W (way), or R (relation). Always an array, including for a single ID: ["N240109189"], ["W50637691", "R146656"]. Up to 50 IDs per call.'),
  extratags: z.boolean().default(false)
    .describe('Include the extra OSM tags each looked-up object carries — contact and metadata tags (phone, website, opening_hours, wikidata) and physical attribute tags alike (surface, tracktype, sac_scale, ele, access). Reports whatever the object happens to carry, so an absent tag describes that object rather than OpenStreetMap.'),
  language: z.string().optional()
    .describe('Preferred language for names (BCP 47 code).'),
})
```

**Output:** Same shape as `openstreetmap_search_places` (array of place results), plus `not_found` array for IDs that returned no result.

**Errors:**

```ts
errors: [
  {
    reason: 'invalid_id_format',
    code: JsonRpcErrorCode.ValidationError,
    when: 'An array element is not a single N/W/R-prefixed OSM ID',
    recovery: 'Each array element must be one OSM ID string prefixed with N (node), W (way), or R (relation) — "N12345", not "12345" and not a nested list of IDs in one element.',
  },
  {
    reason: 'invalid_parameters',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'Nominatim returned HTTP 400 — it refused one of the forwarded parameters. Its own message names the parameter and is carried in this error',
    retryable: false,
    recovery: 'Read the parameter Nominatim named in the message and correct that value before calling again — the identical request is refused identically, so retrying unchanged cannot succeed.',
  },
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Nominatim returned HTTP 429, or answered HTTP 200 with a throttle document instead of JSON — the one request per second usage policy was exceeded',
    retryable: true,
    recovery: 'Wait several seconds before retrying and keep the call rate at or below one request per second, or point OSM_NOMINATIM_BASE_URL at a private Nominatim instance.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Nominatim returned an unexpected non-2xx status other than 429, or answered HTTP 200 with a body that is not JSON and carries no throttle signature',
    retryable: true,
    recovery: 'Retry after a short delay. If it persists, verify OSM_NOMINATIM_BASE_URL points at a working Nominatim endpoint — a 404 usually means the base URL is wrong — and check whether the instance is up.',
  },
]
```

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true`

---

### `openstreetmap_query_nearby`

The primary Overpass convenience tool. Generates an Overpass QL `around` filter internally.

**Tag selection.** Choose `amenity` or `tag_key` as the primary mode. A supplied `tag_value` is exact equality; omission is key existence (`tag_key: "shop"` emits `["shop"]`). Up to five additional `filters: [{ key, value? }]` are ANDed in input order. `amenity: "restaurant", filters: [{ key: "cuisine", value: "italian" }, { key: "name" }]` emits `["amenity"="restaurant"]["cuisine"="italian"]["name"]`. Omitted `filters` and `[]` add no conditions.

All keys and values are trimmed before validation. Supplied blank values, blank keys, duplicate trimmed keys anywhere in the chain, and the existing Overpass metacharacters are rejected as `invalid_tag`. Blank unused `tag_key`/`tag_value` fields remain valid in amenity mode; nonblank mixed primary modes fail. The flat fields remain, with typed `anyOf` branches requiring either `amenity` or `tag_key`, attached using `.strict().meta(TAG_MODE_SCHEMA_META)`; runtime mutual exclusion remains in the shared resolver.

**Input:**

```ts
z.object({
  lat: z.number().min(-90).max(90).describe('Center latitude in WGS84 decimal degrees.'),
  lon: z.number().min(-180).max(180).describe('Center longitude in WGS84 decimal degrees.'),
  radius_meters: z.number().positive().max(50000).default(1000)
    .describe('Search radius in meters. Max 50,000m (50km). Larger radii increase query time and result counts — keep under 5,000m for dense urban POI queries.'),
  amenity: z.string().optional()
    .describe('OSM amenity tag value (e.g., "hospital", "pharmacy", "restaurant", "school", "atm"). This is a shortcut for tag_key="amenity" + tag_value. Cannot be combined with tag_key/tag_value.'),
  tag_key: z.string().optional()
    .describe('Primary OSM tag key; omit tag_value for key existence or supply it for exact equality. Cannot be combined with amenity. Additional filters are ANDed with this tag.'),
  tag_value: z.string().optional()
    .describe('Literal exact-match value paired with tag_key. Omit for key existence; an explicitly blank value is invalid.'),
  filters: z.array(z.object({
    key: z.string().describe('Literal nonblank OSM tag key, unique across the primary tag and all filters after trimming.'),
    value: z.string().optional().describe('Literal exact-match value; omit for key existence, never send a blank value.'),
  }).strict()).max(5).optional().describe('Up to five additional AND filters in input order. Omitted or [] adds no conditions.'),
  element_types: z.array(z.enum(['node', 'way', 'relation'])).min(1).default(['node', 'way'])
    .describe('OSM element types to search, at least one. Ways cover most buildings and areas; nodes cover most standalone POIs. Add "relation" for complex structures like large hospital campuses. Omit the field to search nodes and ways; an empty array is rejected because it can only match nothing.'),
  limit: z.number().int().min(1).max(500).default(20)
    .describe('Maximum results to return. Applied after the Overpass query — if the area has more features, they are truncated. Use smaller values to keep responses focused.'),
  offset: z.number().int().min(0).default(0)
    .describe('Features to skip after distance sorting; pass nextOffset from a truncated page.'),
  timeout_seconds: z.number().int().min(5).max(60).default(25)
    .describe('Overpass query timeout in seconds. Increase for large radius or dense areas.'),
}).strict().meta(TAG_MODE_SCHEMA_META)
```

**Output:**

```ts
z.object({
  elements: z.array(z.object({
    osm_type: z.enum(['node', 'way', 'relation']).describe('OSM element type.'),
    osm_id: z.number().describe('OSM element ID. Use with osm_type for Nominatim lookup.'),
    lat: z.number().optional().describe('Latitude (present for nodes and ways/relations with center computed).'),
    lon: z.number().optional().describe('Longitude (same).'),
    distance_meters: z.number().optional().describe('Great-circle distance from the query center, rounded to one decimal. Absent without coordinates.'),
    name: z.string().optional().describe('Feature name from OSM tags.'),
    tags: z.record(z.string(), z.string()).describe('All OSM tags for this feature. Values are always strings.'),
  })).describe('Matching OSM features, up to the limit.'),
  data_timestamp: z.string().optional().describe('OSM data freshness timestamp from the Overpass response. Absent when the endpoint reported no freshness metadata.'),
  attribution: z.string(),
})
```

**Enrichment:** `effectiveTag` reports the complete ordered chain (`amenity=restaurant, cuisine=italian, name`) under the `Tag Filter` trailer label. `totalFound`, `truncated`, and optional `nextOffset` describe the full result set and current page; `servingEndpoint` attributes the response. An empty result or exhausted offset gets `notice` with the full chain and the appropriate recovery. Every field reaches both `structuredContent` and `content[]`.

Results are distance-sorted before paging, with coordinate-less elements last. The complete generated QL, including the entire filter chain, keys the existing 10-minute cache; changing a filter changes the key, while changing only the page reuses the full result set within the cache ceiling.

**Errors:**

```ts
errors: [
  {
    reason: 'invalid_tag',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Primary tag modes conflict or are missing, a tag key or supplied value is blank, keys repeat after trimming, or any filter contains Overpass QL metacharacters.',
    recovery: 'Provide either amenity (e.g., "hospital") or tag_key (e.g., "shop"); omit tag_value for key existence or supply a nonblank literal value for equality. Use at most five additional filters with unique trimmed keys; omit an entry value for existence, never send a blank value. Tag keys and values must be literal text without Overpass QL metacharacters (" \\ [ ] ; ( )); use openstreetmap_query_raw for arbitrary Overpass QL.',
  },
  {
    reason: 'query_timeout',
    code: JsonRpcErrorCode.Timeout,
    when: 'The Overpass query exceeded the timeout',
    retryable: false,
    recovery: 'Reduce radius_meters, add more specific tag filters, or increase timeout_seconds and retry.',
  },
  {
    reason: 'result_too_large',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Overpass ran out of memory — the result set exceeds the server memory limit',
    recovery: 'Narrow the query: reduce radius_meters, add more specific tag filters, or limit element_types.',
  },
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Overpass returns HTTP 429, or an HTML throttle page instead of JSON — no concurrent query slot was free on the endpoint',
    retryable: true,
    recovery: 'Wait a few seconds and retry. Reduce concurrent calls or switch to a private Overpass instance via OSM_OVERPASS_BASE_URL.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Overpass reports a runtime error that is neither a timeout nor memory exhaustion — the message carries the remark verbatim',
    recovery: 'Read the Overpass remark in the message: it names the fault. Retry in a minute when it points at the dispatcher or database being unavailable; otherwise adjust the query it describes.',
  },
  {
    reason: 'overpass_gateway_timeout',
    code: JsonRpcErrorCode.Timeout,
    when: 'Overpass answered HTTP 504 — the query exceeded the time budget the endpoint enforces, not timeout_seconds',
    retryable: true,
    recovery: 'Shrink the work per query: reduce radius_meters, add more specific tag filters, or narrow element_types, then retry. The endpoint budget is fixed, so raising timeout_seconds alone will not clear a 504.',
  },
  {
    reason: 'overpass_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Overpass answered with an HTTP 5xx other than 504 — the endpoint is down, restarting, or shedding load',
    retryable: true,
    recovery: 'The query is fine; the endpoint is not. Wait about 30 seconds and retry unchanged. If it keeps failing, pin a mirror or private instance via OSM_OVERPASS_BASE_URL.',
  },
  {
    reason: 'endpoints_exhausted',
    code: JsonRpcErrorCode.Timeout,
    when: 'Every Overpass endpoint tried was still unanswered — held past its attempt window, or the total budget ran out before another could be tried',
    retryable: true,
    recovery: 'Shrink the work per query, then retry; every endpoint tried was too slow to answer a query this size. Listing a healthy mirror in OSM_OVERPASS_ENDPOINTS gives the retry a second server to reach.',
  },
  {
    reason: 'endpoints_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'No configured endpoint could serve the call — refused, unresolvable, throttled, or an instance fault, in some mix; the message names each endpoint and what it did',
    retryable: true,
    recovery: 'The query is fine; no endpoint would serve it. Read the per-endpoint outcomes in the message: a refused or unresolvable host belongs out of OSM_OVERPASS_ENDPOINTS, while a throttle or instance fault usually clears within a minute.',
  },
]
```

The two 5xx reasons are thrown by manual `McpError` construction rather than `ctx.fail`, so the status-mapped code survives: 504 stays `Timeout` (-32004), every other 5xx (500, 501, 502, 503) stays `ServiceUnavailable` (-32000). `ctx.fail` rewrites the code to the contract's declared one, which would collapse 504 and the rest onto a single value.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `openstreetmap_query_bbox`

Same shape as `openstreetmap_query_nearby` but spatial filter is a bounding box instead of a radius.

**Input:**

```ts
z.object({
  south: z.number().min(-90).max(90).describe('Southern boundary latitude (minimum latitude).'),
  west: z.number().min(-180).max(180).describe('Western boundary longitude (minimum longitude). A west greater than east is valid, not an error: Overpass reads it as an antimeridian-crossing box and returns the union of west..180 and -180..east.'),
  north: z.number().min(-90).max(90).describe('Northern boundary latitude (maximum latitude).'),
  east: z.number().min(-180).max(180).describe('Eastern boundary longitude (maximum longitude). A value below west describes an antimeridian crossing rather than an inverted box.'),
  amenity: z.string().optional().describe('OSM amenity tag value shortcut (e.g., "cafe", "bench"). Cannot be combined with tag_key/tag_value.'),
  tag_key: z.string().optional().describe('Primary OSM tag key; omit tag_value for key existence or supply it for exact equality. Cannot be combined with amenity. Additional filters are ANDed with this tag.'),
  tag_value: z.string().optional().describe('Literal exact-match value paired with tag_key. Omit for key existence; an explicitly blank value is invalid.'),
  filters: z.array(z.object({
    key: z.string().describe('Literal nonblank OSM tag key, unique across the primary tag and all filters after trimming.'),
    value: z.string().optional().describe('Literal exact-match value; omit for key existence, never send a blank value.'),
  }).strict()).max(5).optional().describe('Up to five additional AND filters in input order. Omitted or [] adds no conditions.'),
  element_types: z.array(z.enum(['node', 'way', 'relation'])).min(1).default(['node', 'way'])
    .describe('OSM element types to search, at least one. Ways cover most buildings and areas; nodes cover most standalone POIs. Add "relation" for complex structures. Omit the field to search nodes and ways; an empty array is rejected because it can only match nothing.'),
  limit: z.number().int().min(1).max(500).default(20)
    .describe('Maximum results to return. Applied after the Overpass query — if the area has more features, they are truncated.'),
  offset: z.number().int().min(0).default(0).describe('Features to skip before applying limit; pass nextOffset from a truncated page.'),
  timeout_seconds: z.number().int().min(5).max(60).default(25)
    .describe('Overpass query timeout in seconds. Increase for large bounding boxes or dense areas.'),
}).strict().meta(TAG_MODE_SCHEMA_META)
```

**Output and enrichment:** Same shape as `openstreetmap_query_nearby`, except no `distance_meters`. Bbox results retain upstream order before paging.

**Errors:** Same as `openstreetmap_query_nearby` (invalid_tag, query_timeout, result_too_large, rate_limited, upstream_error, overpass_gateway_timeout, overpass_unavailable, endpoints_exhausted, endpoints_unavailable — the same primary-mode, blank-value, duplicate-key, and metacharacter validation applies; the two 5xx recovery hints name the bounding box instead of the radius), plus:

```ts
{
  reason: 'invalid_bbox',
  code: JsonRpcErrorCode.ValidationError,
  when: 'The bounding box is inverted on the latitude axis — south is greater than north',
  recovery: 'Order the bounds so south is at most north (south is the minimum latitude, north the maximum); a west greater than east is valid and describes an antimeridian-crossing box.',
}
```

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `openstreetmap_query_raw`

Escape hatch for full Overpass QL expressiveness. Use for multi-type queries, union queries, relation membership, historical queries, or any spatial operation the convenience tools don't cover.

**Input:**

```ts
z.object({
  query: z.string()
    .describe('Overpass QL query string. Must include [out:json]. The server sets the endpoint and User-Agent; do not include those. Example: "[out:json][timeout:15];node[\\"natural\\"=\\"peak\\"](47.5,-122.5,47.7,-122.2);out body;"'),
  limit: z.number().int().min(1).max(500).default(20)
    .describe('Maximum elements to return. Applied after the Overpass query — if the query matched more, they are truncated.'),
  offset: z.number().int().min(0).default(0)
    .describe('Number of matching elements to skip before applying limit, for paging through a large result set. ...'),
  max_element_bytes: z.number().int().min(1_000).max(10_000_000).default(20_000)
    .describe('Serialized-byte budget for one element, measured in UTF-8 bytes and applied to each element of the page independently after limit and offset. It bounds what limit cannot: a single relation or geometry-heavy way. An element over budget keeps every scalar and its tags but has its members, nodes and geometry arrays withheld whole ... The withheld_keys disclosure the element gains is not counted back against the budget, so a bounded element runs a fixed ~60 bytes per withheld key above it.'),
  timeout_seconds: z.number().int().min(5).max(180).default(30)
    .describe('Query timeout in seconds, bounding how long Overpass itself spends on the query. The [timeout:N] directive in the query string takes precedence if present. The client waits for what is requested here, up to 180s ...'),
})
```

**Output:**

```ts
z.object({
  elements: z.array(z.record(z.unknown())).describe('Raw Overpass API response elements for this page, up to the limit. Structure varies by query type — nodes have lat/lon, ways have nodes[], relations have members[]. An element over max_element_bytes carries a withheld_keys array instead of the heavy arrays it names, each entry giving the key, its item count, and its serialized byte size.'),
  total_elements: z.number().describe('Number of elements returned on this page. See totalFound for the full match count.'),
  data_timestamp: z.string().optional(),
  attribution: z.string(),
})
```

**Enrichment (per-element bound):**

```ts
{
  withheldElements: z.array(z.object({
    type: z.string(),            // OSM element type of the bounded element
    id: z.number(),              // OSM id of the bounded element
    keys: z.array(z.string()),   // members / nodes / geometry withheld whole
    offset: z.number(),          // absolute offset in the full match set
    maxElementBytes: z.number(), // true UTF-8 byte size — the smallest budget that returns it whole
  })).optional(),
  withheldNotice: z.string().optional(),
}
```

An element over `max_element_bytes` loses its heavy arrays largest-first, and only as many as it takes to fit — a way whose `geometry` alone put it over budget keeps its `nodes`. Nothing is truncated to a prefix, no other key is touched, and an over-budget element carrying no heavy key is returned untouched. Every size here is a UTF-8 byte count, so a CJK or Cyrillic value costs what it costs on the wire. The withheld state, its item counts and byte sizes, and the retrieval recipe are represented identically on `structuredContent` and `content[]`, so the parity contract from #20 holds one level deeper. `withheldNotice` is executable verbatim: the same `query`, `limit: 1`, the element's absolute `offset`, and `maxElementBytes` as the raised budget.

`maxElementBytes` reports the element's true size even when that exceeds the 10000000 ceiling `max_element_bytes` accepts. Such an element cannot be returned whole at any accepted budget, so `withheldNotice` prints no recipe for it: it names the element and its size, states that it exceeds the ceiling, and points at a narrower query instead — `out ids;` or `out tags;` to drop the heavy arrays, or querying that element's members individually. A page mixing under- and over-ceiling elements carries both clauses.

**Errors:**

```ts
errors: [
  {
    reason: 'query_error',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Overpass returned a 400 error with an HTML body indicating malformed query syntax',
    recovery: 'Check Overpass QL syntax. Validate the query at overpass-turbo.eu before using this tool.',
  },
  // The message carries the upstream parse error ("line 1: parse error: ...") because
  // the service captures the whole error document — see the request-path decision below.
  {
    reason: 'query_timeout',
    code: JsonRpcErrorCode.Timeout,
    when: 'The query exceeded its timeout (Overpass runtime error in response body)',
    retryable: false,
    recovery: 'Add [timeout:N] to the query string with a higher value, or simplify the query (smaller bbox, fewer element types, more specific tags).',
  },
  {
    reason: 'result_too_large',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Overpass runtime error: "Query run out of memory" — result set exceeds the server memory limit (typically 512 MB)',
    recovery: 'Narrow the query scope: reduce the bbox or around radius, add more tag filters, limit element types, or add [maxsize:N] to the query.',
  },
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Overpass returns HTTP 429, or an HTML throttle page instead of JSON — no concurrent query slot was free on the endpoint',
    retryable: true,
    recovery: 'Wait a few seconds and retry. Switch to a private Overpass instance via OSM_OVERPASS_BASE_URL for higher concurrency.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Overpass reports a runtime error that is neither a timeout nor memory exhaustion — the message carries the remark verbatim',
    recovery: 'Read the Overpass remark in the message: it names the fault. Retry in a minute when it points at the dispatcher or database being unavailable; otherwise adjust the query it describes.',
  },
  {
    reason: 'overpass_gateway_timeout',
    code: JsonRpcErrorCode.Timeout,
    when: 'Overpass answered HTTP 504 — the query exceeded the time budget the endpoint enforces, not the [timeout:N] directive',
    retryable: true,
    recovery: 'Shrink the work per query: narrow the bbox or around radius, add more tag filters, or split the query into parts, then retry. The endpoint budget is fixed, so raising [timeout:N] alone will not clear a 504.',
  },
  {
    reason: 'overpass_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Overpass answered with an HTTP 5xx other than 504 — the endpoint is down, restarting, or shedding load',
    retryable: true,
    recovery: 'The query is fine; the endpoint is not. Wait about 30 seconds and retry unchanged. If it keeps failing, pin a mirror or private instance via OSM_OVERPASS_BASE_URL.',
  },
  {
    reason: 'endpoints_exhausted',
    code: JsonRpcErrorCode.Timeout,
    when: 'Every Overpass endpoint tried was still unanswered — held past its attempt window, or the total budget ran out before another could be tried',
    retryable: true,
    recovery: 'Shrink the work per query, then retry; every endpoint tried was too slow to answer a query this size. Listing a healthy mirror in OSM_OVERPASS_ENDPOINTS gives the retry a second server to reach.',
  },
  {
    reason: 'endpoints_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'No configured endpoint could serve the call — refused, unresolvable, throttled, or an instance fault, in some mix; the message names each endpoint and what it did',
    retryable: true,
    recovery: 'The query is fine; no endpoint would serve it. Read the per-endpoint outcomes in the message: a refused or unresolvable host belongs out of OSM_OVERPASS_ENDPOINTS, while a throttle or instance fault usually clears within a minute.',
  },
]
```

Both 5xx reasons preserve the status-mapped code (manual `McpError` construction, not `ctx.fail`), and both append the `Error:` cause Overpass states in the 5xx body — the same extraction the 400 path uses, shared with `openstreetmap_query_nearby` and `openstreetmap_query_bbox` via `services/overpass/overpass-error.ts`. The captured body is then dropped from `error.data` either way — extracted or not, it is a server-side working buffer — rather than forwarded under `body` and the legacy `responseBody` alias.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

## Workflow Analysis

### Common agent workflow: place name → NWS weather

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `openstreetmap_search_places` | "Seattle" → `{lat: 47.6062, lon: -122.3321}` |
| 2 | `nws_get_forecast` (NWS server) | coordinates → weather forecast |

### Common agent workflow: reverse geocode + POI search

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `openstreetmap_reverse_geocode` | coordinates → "Belltown, Seattle, WA" |
| 2 | `openstreetmap_query_nearby` | same coordinates, `amenity="pharmacy"`, `radius_meters=500` → nearby pharmacies |

### Common agent workflow: known OSM ID → details

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `openstreetmap_lookup_objects` | `osm_ids=["W169511257"]` → Harborview Medical Center details |

---

## Design Decisions

**Two services, one server.** Nominatim and Overpass are conceptually separate APIs, but they complement each other to form a complete location-resolution story. Splitting into two servers would force every agent to configure two MCP servers for what is essentially one domain. The cohesive 6-tool surface is easy to understand and the unified `openstreetmap_*` prefix makes the domain clear.

**`openstreetmap_search_places` handles both free-form and structured in one tool.** The two modes are mutually exclusive at the Nominatim API level, but they serve the same user goal (forward geocoding). One tool with clear input validation beats two tools that users have to choose between. Handler validates: `query` XOR structured fields.

**No separate special-phrases tool.** The Nominatim search endpoint has a "special phrases" feature (e.g., "restaurants in Berlin") that can return place-type results. This is not distinct enough to warrant a second tool alongside `openstreetmap_search_places` — a free-form query there handles it. For exhaustive POI queries by area, Overpass is the right tool per Nominatim's own documentation.

**`openstreetmap_query_nearby` and `openstreetmap_query_bbox` as separate tools** (not a single tool with a `mode` param). The two spatial filter types have meaningfully different inputs: around requires a center + radius, bbox requires four coordinates. Combining them into one tool would require either awkward mutually-exclusive groups or an opaque `mode` enum. The cognitive cost of two clearly named tools is lower than one opaque tool.

**`amenity` shortcut in Overpass convenience tools.** The `amenity` tag covers common POI queries (hospital, pharmacy, restaurant, cafe, etc.). The flat shortcut stays mutually exclusive with the primary `tag_key` mode. Omitting a value now means key existence; a bounded list of extra literal filters adds AND conditions without exposing raw QL. Blank values and duplicate keys are rejected so an accidental form value or repeated constraint cannot silently change the intended query.

**`out center tags` in generated Overpass queries.** Ways and relations don't have a single lat/lon — they have a set of node references. `out center` computes a centroid and includes it in the response, which is correct for POI purposes. This normalizes the output so all element types have a usable location. The alternative (`out geom`) would include full node arrays and is appropriate for route/area rendering but not for POI queries.

**Session-level caching in `ctx.state`.** Nominatim's usage policy requires caching. Geocoding the same query twice in one session is wasteful and potentially policy-violating. Cache keys should include all query parameters. TTL: 60 minutes (geocoding results change rarely within a session).

**Rate limiting in NominatimService.** The 1 req/sec hard limit must be enforced server-side. A simple token bucket (1 token/sec, max burst 1) is sufficient. Per the usage policy, MCP tools shouldn't generate bursts of automated requests that could resemble bulk geocoding.

**No autocomplete.** The Nominatim usage policy explicitly forbids autocomplete use. The tools do not accept partial inputs in a way that would enable autocomplete patterns — all queries are submitted as complete search strings.

**No geometry output in Nominatim tools.** The `polygon_geojson`, `polygon_svg`, etc. parameters add boundary geometry. This is useful for rendering but would bloat the tool output significantly. Deferred — add as an optional parameter if agents consistently need polygon boundaries.

**`openstreetmap_lookup_objects` included despite lower frequency.** When an agent workflow has an OSM ID from a prior step (e.g., from an Overpass result), lookup is the efficient path to get full Nominatim address details — a single batch request instead of a geocoding round trip. Supports up to 50 IDs per call.

---

## Known Limitations

**Nominatim reverse geocoding is "closest object," not "containing polygon."** The API finds the nearest indexed OSM object, which may not be the building or parcel the coordinate is inside. In dense urban areas, the result can be a neighboring feature. This is inherent to the API — not something the server can fix. Documented in the `openstreetmap_reverse_geocode` tool description.

**Overpass returns element order, not proximity order.** `openstreetmap_query_nearby` computes `distance_meters` and sorts nearest-first before applying `offset` and `limit`, with coordinate-less elements last. `openstreetmap_query_bbox` retains upstream order.

**Nominatim does not return exhaustive POI lists.** The search endpoint returns the best matches for a query, not all matching objects. For exhaustive lists ("all pharmacies in Seattle"), use Overpass. Nominatim's own documentation states this explicitly.

**Nominatim cannot select by OSM attribute tag.** All three Nominatim-backed tools pick their objects by something other than an attribute tag — name and address relevance, coordinate proximity, or an explicit ID list — and `extratags` only decorates whatever objects that pick produced. (`layer` and `featureType` narrow by tag-derived class on two of the three; the constraint is about attribute tags such as `surface` or `sac_scale`, not the whole tag space.) Two consequences: an absent tag describes the returned object rather than OpenStreetMap, and a named feature can resolve to a different OSM object than the one carrying the tags a caller wants (`Fimmvörðuháls` resolves to a `highway=track` way with no `sac_scale`, while the way carrying `sac_scale=hiking` shares the name). Selecting or enumerating by tag is Overpass-only. Post-filtering Nominatim results by a requested tag was rejected — the endpoint returns top-N by relevance, so filtering afterward turns a silent wrong answer into a silent empty one. The constraint reaches the response as a `tagSelectionCaveat` enrichment field: on every successful `openstreetmap_search_places` response, and on `openstreetmap_reverse_geocode` and `openstreetmap_lookup_objects` when the call requested `extratags`.

**Overpass data has a lag of a few minutes** relative to the OSM main database. The `data_timestamp` in tool output surfaces this. The field is omitted when the response carries no `osm3s.timestamp_osm_base` — a non-standard or proxied endpoint reached through `OSM_OVERPASS_BASE_URL` or `OSM_OVERPASS_ENDPOINTS` — so absence means no freshness metadata was reported, never that the data is current.

**Antimeridian bounding boxes depend on the endpoint.** A `west > east` box is Overpass QL for a box crossing 180°, and the default endpoint evaluates it as the union of `west..180` and `-180..east` — verified against `overpass-api.de`, where a crossing box returns exactly the elements its two non-crossing halves return. `openstreetmap_query_bbox` passes such bounds through unchanged rather than splitting them, so a mirror or private instance that does not implement the wrap will answer differently; the deterministic workaround there is two calls, one per half.

**Rate limits are per-instance.** The default Nominatim instance (nominatim.openstreetmap.org) has a 1 req/sec hard limit. The default Overpass instance allows 2 concurrent queries, which `OSM_OVERPASS_MAX_CONCURRENCY` caps client-side so submissions queue locally rather than piling onto the endpoint. The cap bounds what this server sends at once; it does not eliminate HTTP 429, because Overpass keeps a slot reserved for the full `[timeout:N]` after answering — a burst of short queries can free the client's slots while the endpoint's are still held. A 429 then surfaces as `rate_limited` on the first attempt instead of being re-submitted. Both endpoints can be overridden via config to use private or mirror instances when higher throughput is needed.

**A mirror can differ from the primary in coverage and freshness, and neither shows up as an error.** A region-scoped Overpass instance answers a query outside its extract with HTTP 200 and an empty element list, which is indistinguishable from "nothing matched" — so listing one in `OSM_OVERPASS_ENDPOINTS` converts a loud endpoint failure into a silent wrong answer. Mirrors also lag the main instance, sometimes by weeks. Neither is detectable at the protocol level, which is why failover is opt-in and every response reports `servingEndpoint` alongside `data_timestamp`.

**One tool call stops submitting after its time budget**, counting the per-attempt deadline, the slot queue wait, and retry backoff; the call settles one backoff past that at the latest. The budget is at least 120 seconds and grows with the `[timeout:N]` the query carries, so `openstreetmap_query_raw` at `timeout_seconds: 180` gets 210 seconds per attempt inside a 240-second call. The endpoint enforces its own budget independently and may answer HTTP 504 before any of this binds.

**No Overpass history/attic queries in convenience tools.** The raw query tool supports Overpass's `[date:"..."]` and `retro` syntax if users need historical snapshots, but the convenience tools don't expose this.

---

## API Reference

### Nominatim

| Parameter | Notes |
|:----------|:------|
| Base URL | `https://nominatim.openstreetmap.org` |
| Format | Always use `format=jsonv2` (default for `/search` is the web UI, not JSON) |
| Rate limit | 1 req/sec; valid User-Agent required |
| Search limit | Max 40 results per `/search` request |
| Lookup batch | Max 50 OSM IDs per `/lookup` request |
| Address keys | Vary by country/feature type; not normalized across results |
| Importance | 0–1 float; higher = more globally prominent |
| `place_id` | Internal to the Nominatim instance — not portable across deployments. Use `osm_type` + `osm_id` for stable references |

### Overpass QL essentials

```
[out:json][timeout:25];
(
  node["key"="value"](filter);
  way["key"="value"](filter);
  relation["key"="value"](filter);
);
out center tags;
```

**Filters:**
- Tag equality: `["key"="value"]`; key existence: `["key"]`. Adjacent filters are ANDed, e.g. `["amenity"="restaurant"]["cuisine"="italian"]["name"]`
- Around: `(around:radius_meters,lat,lon)` — all three elements in one `around` statement
- Bbox: `(south,west,north,east)` — Overpass bbox order is S,W,N,E (latitude-first)
- Union: wrap multiple statements in `( ... );`

**Output modes:**
- `out body` — element type, id, position, tags
- `out center tags` — adds centroid for ways/relations (use for POI queries)
- `out geom` — full geometry (ways include all node coordinates)

**Rate limits:** 2 concurrent slots; ≤10,000 queries/day; ≤1 GB/day. Each `[timeout:N]` slot held for N seconds even if query finishes early.

**Status endpoint:** `GET /api/status` — returns connected client ID, current time, available slots.

### Common OSM tag taxonomy for POI queries

| Category | Tag key | Example values |
|:---------|:--------|:---------------|
| Medical | `amenity` | `hospital`, `clinic`, `pharmacy`, `dentist`, `doctors` |
| Food/drink | `amenity` | `restaurant`, `cafe`, `fast_food`, `bar`, `pub` |
| Transport | `amenity` | `parking`, `bus_station`, `ferry_terminal`; `public_transport`=`stop_position` |
| Education | `amenity` | `school`, `university`, `college`, `library` |
| Finance | `amenity` | `bank`, `atm` |
| Recreation | `leisure` | `park`, `playground`, `sports_centre`, `swimming_pool` |
| Shops | `shop` | `supermarket`, `pharmacy`, `bakery`, `convenience` |
| Nature | `natural` | `peak`, `water`, `forest`, `beach` |
| Infrastructure | `highway` | `primary`, `residential`; `building`=`yes` |

---

## Decisions Log

| Date | Decision | Rationale |
|:-----|:---------|:----------|
| 2026-09-10 | A per-attempt client deadline faults the endpoint exactly as a connection-level failure does, and `endpoints_exhausted` is re-decided from "the total budget ran out" to "every endpoint tried was still unanswered" | Bun's `fetch` exposes no connect-phase timeout and its socket `timeout` is an idle timer, so a refused connection and a socket held open are indistinguishable at the API — which of the two a blackhole surfaces as depends on whether the host OS connect timeout is shorter than the attempt window. A discriminator keyed on either one alone is a no-op on the platform that produces the other. The decision does not need the distinction: a host re-asked after a full window gets only the budget's remainder, which cannot succeed where the whole window did not. Reusing `endpoints_exhausted` for the fault-driven case keeps its shrink-the-query hint attached to exactly the calls it is true for. |
| 2026-09-10 | The terminal error of an all-faulted call is composed from the recorded faults, under a new `endpoints_unavailable` reason for the mixed and unreachable cases | `withRetry` rethrows the raw last error once the predicate turns it down, so the surfaced error was whichever attempt happened to fail last — and for a refusal or a deadline that error carried no `reason` at all, falling through each tool's catch chain to a bare `ServiceUnavailable`/`Timeout` outside its declared contract. Overloading `rate_limited` or `endpoints_exhausted` was rejected: the first would break the contract that a throttle means every host refused, the second would blame the size of a query no endpoint ever ran. All-throttled and all-dispatcher-fault calls are left untouched rather than composed, because each already ends on a true declared reason whose message carries signal a summary would drop. |
| 2026-09-10 | The `[out:json]` and `[timeout:N]` directives are matched with whitespace-tolerant, case-sensitive patterns in one shared module | Confirmed against the public endpoint: `[out: json]`, `[ out:json ]`, and `[out :json]` all answer HTTP 200, `[OUT:JSON]` answers HTTP 400 `Unknown attribute "OUT"`. Three literal-string checks in the raw tool and a fourth pattern in `deriveQueryBudget` each recognized a different subset, so a valid spaced query was refused by the preflight while a spaced caller-supplied timeout got a second directive injected alongside it and was waited out for the flat budget. The patterns live in a dependency-free leaf module so the tool and the service can share them without either importing the other. |
| 2026-09-10 | Convenience queries accept omitted values as key existence and up to five ordered additional literal filters | This supports broad categories and attribute conjunctions without requiring raw QL. Explicit blanks remain invalid, all trimmed keys must be unique, and legacy primary fields and single-pair query strings remain compatible. |
| 2026-05-23 | Unified `openstreetmap_*` prefix rather than separate `nominatim_*`/`overpass_*` prefixes | Presents a coherent domain-facing API surface under the OpenStreetMap brand. Both underlying APIs (Nominatim, Overpass) are implementation details; the tool names reflect the user's intent (geocoding, spatial queries) rather than the backend service. |
| 2026-05-23 | Include all three Nominatim endpoints as separate tools | Search, reverse, and lookup are genuinely distinct operations with different inputs and use cases. Consolidating them under a mode enum would obscure the required-vs-optional parameter differences (e.g., `lat`/`lon` only for reverse). |
| 2026-05-23 | Overpass convenience tools separate from raw query | Convenience tools for `around` and `bbox` cover 90% of use cases without requiring Overpass QL knowledge. The raw tool is an explicit escape hatch, not the default path. This matches the skill's "shortcut + escape hatch" pattern. |
| 2026-05-23 | No `openstreetmap_details` tool (debug endpoint excluded) | Nominatim's `/details` endpoint is documented as "for debugging only" and its usage is explicitly called out as forbidden in the usage policy ("Scraping of details... may not be downloaded automatically"). Excluded. |
| 2026-05-23 | No polygon output in initial release | GeoJSON/KML polygon output for Nominatim results would add significant output size with unclear benefit in most agent workflows. Deferred until there's a demonstrated need. |
| 2026-05-23 | `out center tags` rather than `out body` for convenience tools | `out center` normalizes the position representation across nodes, ways, and relations. `out body` for ways would return node ID arrays instead of coordinates, requiring a second `out;` step or the caller to discard position. |
| 2026-05-23 | Session-level caching mandatory in NominatimService | The Nominatim usage policy explicitly requires caching. Given MCP servers can receive many tool calls in quick succession (agent loops), caching the same geocode query within a session is both a policy requirement and a performance benefit. |
| 2026-05-23 | `OSM_NOMINATIM_BASE_URL` and `OSM_OVERPASS_BASE_URL` as configurable env vars | Users operating private or mirror instances (needed for high-throughput use) must be able to redirect the server without code changes. Also enables pointing at local test instances. |
| 2026-07-29 | Overpass HTTP 429 and the HTML throttle page fail fast instead of being retried, and concurrent submissions are capped client-side | The public endpoint advertises 2 slots and sends no `Retry-After` on 429, so blind exponential backoff turned one throttled call into four submissions. Polling `/api/status` for slot availability was rejected — it is a human-readable text report, not a machine contract, and adds a second flaky round trip per retry decision. |
| 2026-07-29 | Slot budget enforced with a concurrency gate, not a Nominatim-style start-time throttle | The Overpass constraint is how many queries are in flight, and one query can hold its slot for the full `[timeout:N]` (up to 180s on the raw tool). Spacing request start times does not bound in-flight count. `@cyanheads/mcp-ts-core`'s `RateLimiter` is a per-key sliding-window abuse limiter, not a concurrency primitive, so the gate is local to the service. |
| 2026-07-29 | Timeout remark pattern narrowed to `query timed out\|timed out`, with any other remark surfaced as `upstream_error` | Every Overpass runtime remark opens with `runtime error:`, so matching that prefix claimed the out-of-memory remark and left `result_too_large` unreachable — and served OOM failures the raise-the-timeout hint. Narrowing rather than reordering the two checks also stops area, date-filter, and dispatcher remarks from being read as timeouts; the catch-all keeps them from returning as an empty success. |
| 2026-07-29 | `OverpassService` owns its POST (raw `fetch` + `httpErrorFromResponse` at a 4000-byte body limit) instead of calling `fetchWithTimeout` | `fetchWithTimeout` truncates a non-2xx body at a hard-coded 500 bytes, and the endpoint's error document puts its first `Error:` line at byte 502 — so every malformed query surfaced with the parse error cut off. `httpErrorFromResponse` applies the same status → code table and produces the same `error.data` shape with a caller-set limit, so the retry classifier and the tools' catch blocks read it unchanged. The per-attempt client deadline and the `http.client.request.duration` histogram are replicated locally; the endpoint URL is redacted to origin + path before it enters `error.data`. |
| 2026-07-29 | Overpass 5xx gets two new declared reasons, thrown by manual `McpError` construction rather than `ctx.fail` | A 5xx arrived with no reason and no recovery hint. `upstream_error` could not be reused — it is already declared on all three tools for the JSON-remark case, and a duplicate reason is a hard lint error. Splitting 504 (`overpass_gateway_timeout`) from the rest (`overpass_unavailable`) lets each carry the advice its case needs: a 504 means the query outgrew the endpoint's fixed time budget, a 502/503 means the endpoint is down. `ctx.fail` rewrites the code to the contract's declared one, so it would collapse the 504 `Timeout` and the 5xx `ServiceUnavailable` onto one value; constructing the error preserves the status-mapped code and adds only `reason` and `recovery`. |
| 2026-07-30 | `extractOverpassError` moved to `services/overpass/overpass-error.ts` and the captured non-2xx body is dropped from the error data all three Overpass tools construct | Only `openstreetmap_query_raw` read the `Error:` cause out of an Overpass error document, so `query_nearby` and `query_bbox` callers got the cause as unparsed XHTML in `error.data.body`. Sharing the extractor puts the same sentence in the message on every path; a tool file importing another tool file would invert the leaf-module layering, so the helper sits beside the service that captures the body. With the cause in the message the 4000-character capture is a server-side working buffer only — forwarding it put the same document on the wire twice, under `body` and the legacy `responseBody` alias. |
| 2026-07-30 | Endpoint failover ships as a mechanism that is off by default: `OSM_OVERPASS_ENDPOINTS` defaults to the single FOSSGIS instance rather than seeding a mirror | Vetting the candidate mirrors decided this. `overpass.osm.ch` — the instance the mechanism was first proposed around — carries Switzerland-only data and answers a query outside that extract with HTTP 200 and an empty element list, so defaulting to it would trade a loud 504 for a silent wrong answer; its usage policy is also "ask the operator" rather than a public grant. `overpass.private.coffee`, a global instance whose own terms grant use in any project including commercial use, was serving a `timestamp_osm_base` about seven weeks behind the main instance when checked, which makes availability-versus-freshness an operator's call rather than a library default. The mechanism plus documented vetting criteria fixes the issue for anyone who configures it without volunteering a third party's bandwidth on every operator's behalf. |
| 2026-07-30 | Endpoint rotation keys off the attempt index inside the existing `withRetry` loop instead of a health check or a pre-flight probe | The transient/deterministic split the retry predicate already draws is exactly the rotate/do-not-rotate split, so rotation needs no new classification and a query every mirror would reject identically never costs a second endpoint's slot. Health-checking mirrors before querying would double the request count against endpoints that ask clients to be frugal. |
| 2026-07-30 | One wall-clock budget for the whole call rather than a per-attempt deadline alone, and one slot budget rather than one per endpoint | The per-attempt deadline multiplied by the attempt budget was already a six-minute worst case before failover existed; rotation makes a hanging endpoint likelier by giving each attempt a fresh host. Per-endpoint semaphores would add a queue per endpoint to better utilize a mirror on a path that only runs during an outage. |
| 2026-07-30 | A `west > east` bounding box stays a single pass-through query; the crossing semantics are documented on the longitude bounds instead of being reimplemented as a split | A discriminating experiment against the default endpoint settled what Overpass returns: a crossing box over a latitude band whose complement holds 164,657 `amenity` nodes returned 0, and a crossing box near 180° returned 55 — exactly the 20 + 35 its two non-crossing halves return. So the endpoint implements the wrap rather than silently swapping the bounds, and the reported 504-on-every-crossing-box behavior does not reproduce there. Splitting into two queries would add a merge, a dedupe, a second slot acquisition, and a second cache entry that the deterministic `offset` paging semantics depend on, to guard a failure not reproduced on any endpoint. |
| 2026-08-02 | A throttled or self-diagnosed endpoint is tracked in a per-call faulted set rather than answered by the attempt counter alone | Rotation is a strict round-robin, so "has every endpoint been tried" does reduce to `attempt >= endpoints.length` — but that is a different question from "may this error be re-sent to a host that already refused it". The two answers coincide only when every failure in the call is a throttle; in a mixed sequence (throttle, then a transient 5xx elsewhere) the round-robin wraps back onto the throttled host, which is exactly the re-submission the fail-fast exists to prevent. The set makes rotation skip that host for the rest of the call, and living in the `executeQuery` closure rather than on the service keeps concurrent calls from sharing rotation state. |
| 2026-08-02 | `upstream_error` rotates only on a recognized OSM3S instance signature (`dispatcher`, `too busy`, `open64:`), not on every unmatched remark | The remark bucket mixes instance faults with query-deterministic ones, and rotating the latter spends a second endpoint's slot on a request every mirror rejects identically. The signatures come from the Overpass source: `web_query.cc` renders a `File_Error` as an `open64:` line and adds "The server is probably too busy to handle your request." / "The dispatcher (i.e. the database management system) is turned off.", and every dispatcher fault carries a `Dispatcher_Client::` origin. No query-authored text produces those, so the narrowing is safe in both directions. |
| 2026-08-02 | A non-JSON 2xx body is classified by what it says, replacing the leading-tag regex with a `JSON.parse` guard | The anchored `<!DOCTYPE html\|<html` pattern never matched an OSM3S document, which leads with `<?xml version="1.0"?>` — so such a body reached `JSON.parse` and escaped as a raw `SyntaxError`: no reason, no recovery, no status, and read as transient by `withRetry` because it is not an `McpError`, costing the full attempt budget. Guarding the parse instead of the tag catches every non-JSON shape at once. Overpass emits this document whenever it fails before it can start streaming the payload, which covers throttling and instance faults alike, so the extracted `Error:` line picks between `rate_limited` and `upstream_error` rather than the fact that the body is not JSON. |
| 2026-08-02 | Client deadlines derive from the query's `[timeout:N]`, widening only, instead of capping `timeout_seconds` down to what the flat budget allowed | Capping down would have removed advertised capability to fix a documentation defect. Deriving keeps the 91–180s range usable and reads the directive out of the QL, which is the only surface that also sees a `[timeout:N]` a caller wrote into the query string themselves — the input schema cannot reach that. Both layers keep the flat constant as a floor (`max(90s, N+30s)` per attempt, `max(120s, per-attempt+30s)` total), so no query that succeeds under today's generous flat budget can start failing under a tighter derived one; `query_nearby` and `query_bbox` cap at 60s and are unaffected by construction. The 30s grace is the margin the shipped flat pair already encoded twice, and covers the ~10s transfer measured for a 20 MB / 174k-element response. |
| 2026-08-02 | `query_raw` pages at the tool layer; the service declines to cache a result past 100,000 elements rather than truncating it | A tool-layer slice bounds the response but not the 10-minute retention, since `executeQuery` caches below it — and the default storage provider is in-memory. Truncating in the service would bound both but silently drop elements and change what `totalFound` means for `query_nearby`/`query_bbox`, which read the same result. Declining to cache bounds retention with no capability loss and no sibling change; the cost is that paging past the ceiling re-queries, which the `offset` descriptions state. Ceiling sized from measurement: a parsed Overpass element retains ~250 bytes, so 100,000 caps one cached result near 25 MB while leaving 200 full pages reachable. Residual, unfixed: the parse peak. `JSON.parse` still materializes the whole response before anything can bound it, which no ceiling placed after parsing can address. |
| 2026-08-02 | The tag-mode requirement is advertised as a sibling `anyOf` over required-sets on the existing flat fields, not as a nested `tag` union | A `z.union` on a nested object encodes the rule directly but restructures the argument shape of two shipped tools, and on this SDK path it does worse than break callers: `normalizeObjectSchema` returns `undefined` for a non-object root, so the advertised schema would collapse to an empty object and carry less than it does today. `anyOf` over required-sets reaches the same argument generators while leaving every currently-valid argument set valid. Zod drops `.refine`/`.superRefine` from the emitted schema entirely, so the fragment is attached with `.meta()`, whose keys pass through conversion verbatim; each branch carries its own `type: 'object'` because Gemini rejects an untyped branch. Residual: `anyOf` states "at least one mode", not mutual exclusivity — `amenity` alongside `tag_key`/`tag_value` still satisfies the first branch and is rejected only by `resolveTagInput`, which remains the sole enforcement point. |
| 2026-08-09 | A non-JSON Nominatim 2xx body is classified by what it says, and `upstream_error` joins the Nominatim fail-fast set | The anchored `<!DOCTYPE html\|<html` guard missed a document leading with an XML declaration and a plain-text refusal carrying no markup at all; both reached `JSON.parse`, escaped as a bare `SyntaxError` with no reason, status, or recovery, were read as transient because a `SyntaxError` is not an `McpError`, and surfaced as `ValidationError` after four submissions. Guarding the parse catches every non-JSON shape at once. Nominatim has no OSM3S-style `Error:` line to read a fault out of, so the split is a throttle-vocabulary test over the body, with everything else `upstream_error` — the reason whose recovery hint already names the base-URL misconfiguration that a 200 markup body usually indicates. The classification only short-circuits the loop once `isTransientNominatimError` fails fast on `upstream_error` as well as `rate_limited`, and the three Nominatim-backed tools re-throw it through `ctx.fail` so the hint reaches the wire. |
| 2026-08-09 | `element_types` requires at least one entry, enforced in the schema rather than the handler | An explicit `[]` built an Overpass union with no members, spent an upstream slot, and came back with zero elements — reported as a geographic miss whose notice named a larger radius, a different tag, and the coordinates, none of them the cause. `.min(1)` lands in the advertised `inputSchema` as `minItems: 1`, so an argument generator sees the constraint rather than learning it from a silent empty result; the field keeps its default, so omitting it behaves exactly as before. |
| 2026-08-09 | `invalid_input` on `openstreetmap_search_places` split into `conflicting_query_mode` and `missing_query_mode` | One reason served two opposite mistakes, so a caller who supplied neither mode was told "not both" directly under a message telling them to supply one. Passing a per-call `recovery.hint` on the omission branch would have fixed the text while making that entry the only one in the server whose hint is not resolved from the contract; separate reasons keep `ctx.recoveryFor` the single source of hint text and give each branch its own identifier for observers switching on `data.reason`. |
| 2026-08-09 | The tag-selection caveat rides its own `tagSelectionCaveat` enrichment field on all three Nominatim tools, not `ctx.enrich.notice` | Description text only reaches a model still choosing a tool; the caller that already chose wrong gets a well-formed result and no signal, so the disclosure has to reach the response. `ctx.enrich.notice()` and `ctx.enrich.truncated({ guidance })` both write the single `notice` key last-wins, and `openstreetmap_search_places` already writes it from two branches — routing the caveat there would silently drop one message on a page that is both truncated and tag-relevant. One field name shared verbatim across the three tools so an agent that learns it on one recognizes it on the others; the text names no selection mechanism, because the three differ (name relevance, proximity, explicit IDs) and what they share is that no tag value steers the pick, and it says *attribute* tag because `layer` and `featureType` narrow by tag-derived class on two of the three. |
| 2026-08-09 | The caveat is unconditional on `openstreetmap_search_places` and gated on `extratags` for the other two | `openstreetmap_search_places` is the only one taking a free-form query, so it is the only one a caller can reach for expecting tag-based *selection* — and that caller has no reason to have set `extratags`, which defaults to `false`, so gating there would deliver the signal to roughly the inverse of the population that needs it. Coordinates and explicit OSM IDs leave no selection mistake available on the other two, whose one live hazard is reading an absent tag as absent from OpenStreetMap — which requires having asked for the tag map. Unconditional emission is what forced the text down to 226 characters from 356: it lands twice per response (`structuredContent` plus the `content[]` trailer), and the three Overpass tool names are an irreducible 77 of those characters. |
| 2026-08-09 | The `tagSelectionCaveat` field is optional on all three tools, including where emission is unconditional | The effective output is parsed as `output.extend(enrichment)`, so a required field a later refactor stops writing fails the parse and returns `isError` for the entire call — a total outage in place of a missing advisory sentence. Presence is held by per-tool tests instead, which also assert absence on the two gated tools. |
| 2026-08-09 | The truncation notice on `openstreetmap_search_places` passes an explicit `guidance` naming the `exclude_place_ids` walk | The framework default ("Raise the cap or narrow with filters") names two remedies that cannot reach the rest of the result set: `limit` stops at 40, Nominatim's own ceiling, so raising it fails outright three pages in, and narrowing returns a different set rather than the remainder of this one. The tool's actual retrieval path — `nextExcludeIds` back as `exclude_place_ids` — went unmentioned in the one field an agent reads for what to do next. |
| 2026-08-09 | The query / structured-address requirement is advertised as an `anyOf` over seven required-sets, same mechanism as the tag-mode fragment | Every field is optional, so the published schema said a call with no arguments was valid and the handler's `missing_query_mode` was the only place to learn otherwise. Measured against mcpo 0.0.20 before shipping, since seven required-set branches is a larger surface than the two already shipping: the generated OpenAPI request model is byte-identical to the flat schema's, because that converter reads only `properties`, `required`, and `$defs` from `inputSchema` and has no code path for a root-level `anyOf`. Branch count was never the variable. The same run established the shape's hard constraint — a variant declaring fields *inside* the branches generates no request body at all and drops arguments in flight — so every field definition stays in root `properties` and the branches carry `required` only. As with the tag-mode fragment, `anyOf` states "at least one mode", not mutual exclusivity, and the handler remains the sole enforcement point. |
| 2026-09-09 | Community-edited OSM text is escaped for literal Markdown display at the render boundary only, escaping `\`, `` ` ``, `*`, `[`, `]`, `<`, `>`, `#`, `\|` and `~`, plus `_` at a word boundary, and neutralizing embedded line breaks into literal `\n` / `\r` | Upstream `name`, `display_name`, address and tag text reached `content[]` unescaped on all six tools, so an OSM value could open a heading, forge a bold system notice, or emit a live `<script>` tag inside the server's own response — and an embedded newline could inject whole lines. Escaping preserves every byte (a deletion-based pass such as `Sanitization.sanitizeString` would violate the informational-completeness contract from #20/#21/#23/#28), and it lives in `format()` only, so `structuredContent` stays byte-identical. `(`, `)` and `!` are left readable because a link destination is only read after an unescaped `]`, which the pass already escapes — so ordinary names like `Foo (formerly Bar)` render clean. Numeric upstream scalars (`lat`, `lon`, `place_id`, `importance`, `distance_meters`, `boundingbox`) are left alone: escaping them is pure noise. |
| 2026-09-09 | `_` is escaped at a word boundary only — where it is not flanked by an alphanumeric on at least one side | The two halves of `_` pull in opposite directions, and the flanking rule is the line between them. A `_` that is not flanked by an alphanumeric is exactly where CommonMark lets emphasis open, so ` _word_ ` and ` __FAKE SYSTEM NOTICE__ ` are live markup in upstream data and have to render literally. An intraword `_` cannot open emphasis at all and is pervasive in Nominatim and OSM keys and values (`country_code`, `ISO3166-2-lvl4`, `addr_full`, `man_made`), so escaping it unconditionally would put a visible backslash in nearly every address and tag line on non-rendering clients for no gain. Residual, accepted: a bare URL, a bare `www.` host and a bare email address are left readable and may autolink on a GFM renderer — autolinking needs no upstream metacharacter, so the only defense would be mangling the value. `-`, `.`, `+`, `:`, `/` and `=` stay excluded outright, their block meanings needing a line start that the line-break neutralization already denies them. |
| 2026-09-09 | `openstreetmap_query_raw`'s generic remaining-key fallback escapes the serialized JSON string as a whole, with `[`/`]` swapped out of the escape set for `(`/`)` | Deep-escaping the leaves before `JSON.stringify` does not work: the serializer re-escapes any backslash the leaf pass inserted, so `\*` becomes a literal backslash followed by a live emphasis marker. Escaping the finished string is the only ordering where the rendered text matches the JSON text. Escaping `[`/`]` there would then put a backslash in front of every array delimiter (`nodes: \[1,2,3\]`), so the serialized set escapes the paren instead — a link needs `]` immediately followed by `(`, and `[label]` alone is a shortcut reference that is inert with no link-reference definition, which this server never emits. |
| 2026-09-09 | `openstreetmap_query_raw` bounds each element with a `max_element_bytes` budget (default 20000, range 1000–10000000) that withholds `members` / `nodes` / `geometry` whole, rather than an `outlineOnOverflow` call or a section selector | `limit`/`offset` (#50) bound the element count only; one 1,714-member relation still serialized at ~94 KB on each surface, and Overpass QL has no construct that slices a single element's nested array — `out ids;`/`out tags;` drop it entirely and `out skel;` and above return it whole — so the retrieval path has to be server-side. The framework's `outlineOnOverflow` is built for one document-shaped payload behind a single `kind` discriminator and cannot name *which* element of a list a follow-up targets. Withholding whole arrays with a per-element `withheld_keys` disclosure mirrors #50's own `truncated`/`nextOffset` precedent one level deeper, stays additive to the existing `elements` record schema, and keeps both surfaces identical. Default sized from measurement: members and geometry vertices serialize at roughly 50 bytes each, so 20000 clears an ordinary way or small relation and catches the ones that blow a context window. Every figure — the budget test, `withheld_keys[].serialized_bytes`, and `withheldElements[].maxElementBytes` — is a UTF-8 byte count, not a `String.length` code-unit count, which under-reports a CJK or Cyrillic name by a factor of two or three and would let it through the bound. The `withheld_keys` disclosure an element gains is not counted back against the budget, so a bounded element runs a fixed ~60 bytes per withheld key above it — stated in the `max_element_bytes` description so a caller sizing a budget reads it. |
| 2026-09-09 | `withheldElements[].maxElementBytes` reports the element's true size even above the 10000000 `max_element_bytes` ceiling, and `withheldNotice` then drops the retrieval recipe for that element | Clamping the figure to the ceiling produced a recipe the schema itself rejects: the caller reads `max_element_bytes 10000000`, re-calls, and gets an element still over budget with no way to tell that the number was never the real one. Reporting the true size makes the ceiling visible, and the notice switches for those entries to naming the size and the only path Overpass actually offers — `out ids;` or `out tags;` to drop the heavy arrays, or querying that element's members individually. A page mixing under- and over-ceiling elements carries both clauses, each covering only its own entries. |
| 2026-09-09 | The per-element bound is applied at the tool layer; `OverpassService.executeQuery` keeps caching the full unsliced result | Same call as #50 made for the top-level slice, for the same reason. Bounding in the service would change what `totalFound` means for `query_nearby`/`query_bbox`, which read the same cached result, and would make the raised-budget retrieval call unable to recover data the cache no longer holds — the retrieval path depends on the full element still being there. Cache retention stays bounded by `CACHE_MAX_ELEMENTS` and the 10-minute TTL. |
| 2026-09-09 | `isTransientNominatimError` returns false for `data.status === 400`, mirroring the branch `isTransientOverpassError` already carries | A parameter Nominatim refuses is refused identically on every re-submission, so the retry budget bought four guaranteed 400s and ~16s of wall time per call before surfacing. The error carries no `reason` — `httpErrorFromResponse` classifies a 400 as InvalidParams and nothing more — so it fell through the predicate's default rather than matching any of the reason-keyed fail-fast cases. Keying the branch on status rather than adding a reason keeps the classification where the sibling service already puts it. |
| 2026-09-09 | A Nominatim HTTP 400 gets its own `invalid_parameters` reason (`InvalidParams`, non-retryable) on all three Nominatim tools, carrying Nominatim's own `error.message` | The bare non-429 remap folded a client-input error into `upstream_error` — the same bucket an actual outage lands in — so it arrived marked `retryable: true` with a recovery hint telling the caller to verify `OSM_NOMINATIM_BASE_URL`, advice that cannot fix a bad `layer` value. Nominatim states the cause precisely (`Parameter 'layer' must be a comma-separated list of: …`, `Invalid exclude ID: garbage`) and that text was being discarded. Mirrors the shape `openstreetmap_query_raw`'s `query_error` already provides for Overpass, down to a leaf `nominatim-error.ts` extractor beside the service that captures the body — Nominatim answers with JSON rather than an OSM3S `Error:` line, so the extractor reads the `error.message` field (and the bare-string `error` form `/reverse` uses) instead of scanning for a line. The documented `layer` set and the `exclude_place_ids` token format ship as JSON-Schema `pattern`s in the same change, so the two reproduction cases never leave the process. `layer` stays a regex-validated comma-separated list rather than a bare `z.enum`: Nominatim documents the parameter as a list and `openstreetmap_reverse_geocode` matches `address,poi` by default, so an enum would advertise less than the endpoint accepts. Both patterns are scoped to reject only what Nominatim itself rejects, since a validator that outruns the endpoint refuses working calls: the layer names match in any casing (Nominatim accepts `ADDRESS`), spelled as per-letter character classes because a JSON-Schema `pattern` carries no `i` flag and would otherwise validate looser than it advertises; a blank value matches and the handler drops it, since both fields were bare strings that ignored one before; and `exclude_place_ids` entries are trimmed and their ref prefixes uppercased, matching `openstreetmap_lookup_objects`. Each field pairs its pattern with an explicit `z.literal('')` variant — the optional group inside the pattern already accepts a blank, but only the literal puts it in the advertised schema as a `const`, where an argument generator reads it. |
| 2026-09-09 | `openstreetmap_search_places`'s `viewbox` rejects an inverted or degenerate box, diverging from `openstreetmap_query_bbox`'s antimeridian allowance | The two endpoints do genuinely different things with `west > east`. A discriminating experiment settled the Overpass side in favor of pass-through (2026-07-29 above): the endpoint implements the wrap. Nominatim does not — verified live, `viewbox=170,10,-170,-10&bounded=1` returns no dateline-area results, because Nominatim reads the two longitudes as an unordered min/max pair and searches the ~340°-wide box between them, the opposite of the intended sliver, with no error. Silently searching the complement of what was asked for is worse than a rejection, and there is no antimeridian spelling to accept instead, so the guard rejects rather than splitting: a caller who needs the dateline makes two calls. The error message names the divergence explicitly, since `openstreetmap_query_bbox`'s own field descriptions teach the opposite rule. `bounded` without `viewbox` is likewise rejected rather than ignored, following the `conflicting_query_mode`/`missing_query_mode` precedent — Nominatim drops a `bounded` it cannot apply, so ignoring it would silently return a bias-only result the caller believes was restricted. |
| 2026-09-09 | `truncated` on `openstreetmap_search_places` is set from a same-call `limit + 1` probe rather than page size, and it gates `truncated` alone — `nextExcludeIds` is gated on the page being full | Nominatim's `/search` carries no total anywhere — the body is a bare array and the headers hold neither `X-Total-Count` nor `Link` — so `results.length >= limit` proved only that the page filled, and every result set whose true total equalled `limit` reported truncation. An extra-result probe is the only mechanism available; requesting it in the same call costs nothing against the 1 req/sec budget, where the alternative (a follow-up call with `exclude_place_ids`) costs a second request and has to fold into the exclude-accumulation logic. The probe row is dropped before the page is returned, so it reaches neither `results` nor `nextExcludeIds`. What the probe proves is narrower than exhaustion: it reads Nominatim's relevance cutoff, and the docs say excluding ids "would cause the search to return other, less accurate, matches (if possible)" — verified live, `q=pharmacy&limit=11` returns 10 rows, yet excluding those 10 ids returns 10 more. Gating the paging token on the probe therefore ended walks that still had results in them, so `nextExcludeIds` is offered whenever the page fills `limit` and `truncated` keeps the stricter meaning. The open question was whether Nominatim clips output at the tool's own 40-result input ceiling, which would make the probe a silent false negative at `limit: 40`. Measured against the public instance on two queries: `q=pharmacy` and `q=school` both return 41 rows for `limit=41`, so a request one past the ceiling is served in full and the probe is honest at every `limit` this tool accepts. The row count above 41 is query-dependent rather than a fixed clip — `q=school` returns 47 for `limit=50` and 47 again for `limit=100` — so no claim is made about a ceiling beyond the one the probe needs; the documented 40 maximum is not enforced as a hard clip. |
| 2026-05-23 | No prompts | The domain is pure data lookup — there are no recurring agent interaction patterns that benefit from a structured prompt template. Tool descriptions carry sufficient guidance. |
