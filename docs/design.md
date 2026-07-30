# openstreetmap-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `openstreetmap_search_places` | Forward geocoding: convert a place name or address to coordinates and structured place data. Supports free-form and structured address input. | `query` (free-form) OR structured fields (`street`, `city`, `state`, `country`, `postalcode`); `limit`, `countrycodes`, `layer`, `featureType` | `readOnlyHint: true` |
| `openstreetmap_reverse_geocode` | Reverse geocoding: convert lat/lon to the nearest address or place. Returns the closest OSM object with full address breakdown. | `lat`, `lon`, `zoom` (detail level 3–18), `layer` | `readOnlyHint: true` |
| `openstreetmap_lookup_objects` | Look up address details for specific OSM objects by their IDs. Useful when an OSM node/way/relation ID is already known. | `osm_ids` (up to 50, prefixed with N/W/R) | `readOnlyHint: true` |
| `openstreetmap_query_nearby` | Find OSM features within a radius around a point. The primary convenience tool for "what's near X?" spatial queries. Covers nodes, ways, and relations. | `lat`, `lon`, `radius_meters`, `amenity` (or `tag_key` + `tag_value`), `limit` | `readOnlyHint: true` |
| `openstreetmap_query_bbox` | Find OSM features within a bounding box. Useful for area surveys, not proximity searches. | `south`, `west`, `north`, `east`; `amenity` (or `tag_key` + `tag_value`), `limit` | `readOnlyHint: true` |
| `openstreetmap_query_raw` | Execute a raw Overpass QL query for advanced spatial queries the convenience tools don't cover. | `query` (Overpass QL string), `timeout` | `readOnlyHint: true` |

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
| `OSM_OVERPASS_BASE_URL` | No | Override the Overpass endpoint (default: `https://overpass-api.de/api/interpreter`). Supports mirror instances. |
| `OSM_OVERPASS_MAX_CONCURRENCY` | No | Cap on Overpass queries in flight at once (default: `2`, the public endpoint's slot budget). Submissions past the cap queue locally. |
| `OSM_USER_AGENT` | No | Identifies the application to Nominatim (default: `openstreetmap-mcp-server/<version>`). Must be set if the default violates the operator's policy. |

---

## Implementation Order

1. Config and server setup (`server-config.ts` with the three optional env vars)
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
    .describe('Maximum results to return. Nominatim may return fewer if additional results do not sufficiently match the query. Max 40.'),
  countrycodes: z.string().optional()
    .describe('Restrict results to one or more countries. Comma-separated ISO 3166-1 alpha-2 codes (e.g., "us,ca"). Preferred over the structured "country" field when filtering.'),
  layer: z.string().optional()
    .describe('Filter by data layer. Comma-separated values: address, poi, railway, natural, manmade. Default: no restriction.'),
  featureType: z.enum(['country', 'state', 'city', 'settlement']).optional()
    .describe('Restrict results to a geographic feature type. Automatically implies the address layer.'),
  extratags: z.boolean().default(false)
    .describe('Include extra OSM tags when available (e.g., phone, website, opening_hours, wikidata). Increases response size.'),
  language: z.string().optional()
    .describe('Preferred language for result names (BCP 47 language code or Accept-Language string, e.g., "en", "de", "fr,en"). Defaults to local OSM language if unset.'),
})
```

**Output:**

```ts
z.object({
  results: z.array(z.object({
    place_id: z.number().describe('Nominatim internal place ID. Use osm_type+osm_id for stable cross-server references.'),
    osm_type: z.enum(['node', 'way', 'relation']).optional().describe('OSM object type.'),
    osm_id: z.number().optional().describe('OSM object ID. Combine with osm_type for lookup.'),
    lat: z.string().describe('Latitude (WGS84, as string from API).'),
    lon: z.string().describe('Longitude (WGS84, as string from API).'),
    display_name: z.string().describe('Full human-readable address string.'),
    name: z.string().optional().describe('Feature name if applicable (e.g., "Space Needle"). Absent for address-only results.'),
    category: z.string().optional().describe('OSM feature category (e.g., "amenity", "man_made", "boundary").'),
    type: z.string().optional().describe('OSM feature type within category (e.g., "hospital", "tower", "administrative").'),
    importance: z.number().optional().describe('Nominatim relevance score (0–1). Higher is more prominent globally.'),
    address: z.record(z.string()).optional().describe('Structured address breakdown. Keys vary by feature type and country. Common keys: house_number, road, suburb, city, state, postcode, country, country_code.'),
    boundingbox: z.tuple([z.string(), z.string(), z.string(), z.string()]).optional()
      .describe('Bounding box [south, north, west, east] as strings.'),
    extratags: z.record(z.string()).optional().describe('Additional OSM tags (phone, website, opening_hours, wikidata, etc.). Present only when extratags=true was requested.'),
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
    reason: 'invalid_input',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Both query and structured fields are provided, or neither is provided',
    recovery: 'Provide either the query parameter (free-form) or structured address fields (street, city, etc.), not both.',
  },
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Nominatim returned HTTP 429 or an HTML throttle page — the one request per second usage policy was exceeded',
    retryable: true,
    recovery: 'Wait several seconds before retrying and keep the call rate at or below one request per second, or point OSM_NOMINATIM_BASE_URL at a private Nominatim instance.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Nominatim returned an unexpected non-2xx status other than 429',
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
  layer: z.string().optional()
    .describe('Restrict which OSM layer is matched. Comma-separated: address, poi, railway, natural, manmade. Default: address,poi.'),
  extratags: z.boolean().default(false)
    .describe('Include extra OSM tags when available (phone, website, opening_hours, wikidata, etc.).'),
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
    address: z.record(z.string()).optional()
      .describe('Structured address. Keys vary by feature type. Common: house_number, road, suburb, city, state, postcode, country, country_code.'),
    boundingbox: z.tuple([z.string(), z.string(), z.string(), z.string()]).optional()
      .describe('Bounding box [south, north, west, east] as strings.'),
    extratags: z.record(z.string()).optional(),
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
    reason: 'rate_limited',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Nominatim returned HTTP 429 or an HTML throttle page — the one request per second usage policy was exceeded',
    retryable: true,
    recovery: 'Wait several seconds before retrying and keep the call rate at or below one request per second, or point OSM_NOMINATIM_BASE_URL at a private Nominatim instance.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Nominatim returned an unexpected non-2xx status other than 429',
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
    .describe('Include extra OSM tags (phone, website, wikidata, etc.).'),
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
    reason: 'rate_limited',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Nominatim returned HTTP 429 or an HTML throttle page — the one request per second usage policy was exceeded',
    retryable: true,
    recovery: 'Wait several seconds before retrying and keep the call rate at or below one request per second, or point OSM_NOMINATIM_BASE_URL at a private Nominatim instance.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Nominatim returned an unexpected non-2xx status other than 429',
    retryable: true,
    recovery: 'Retry after a short delay. If it persists, verify OSM_NOMINATIM_BASE_URL points at a working Nominatim endpoint — a 404 usually means the base URL is wrong — and check whether the instance is up.',
  },
]
```

**Annotations:** `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true`

---

### `openstreetmap_query_nearby`

The primary Overpass convenience tool. Generates an Overpass QL `around` filter internally.

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
    .describe('OSM tag key for non-amenity queries (e.g., "leisure", "shop", "highway", "natural"). Use with tag_value. Cannot be combined with amenity.'),
  tag_value: z.string().optional()
    .describe('OSM tag value paired with tag_key (e.g., "park", "supermarket", "primary", "peak").'),
  element_types: z.array(z.enum(['node', 'way', 'relation'])).default(['node', 'way'])
    .describe('OSM element types to search. Ways cover most buildings and areas; nodes cover most standalone POIs. Add "relation" for complex structures like large hospital campuses.'),
  limit: z.number().int().min(1).max(500).default(20)
    .describe('Maximum results to return. Applied after the Overpass query — if the area has more features, they are truncated. Use smaller values to keep responses focused.'),
  timeout_seconds: z.number().int().min(5).max(60).default(25)
    .describe('Overpass query timeout in seconds. Increase for large radius or dense areas.'),
})
```

**Output:**

```ts
z.object({
  elements: z.array(z.object({
    osm_type: z.enum(['node', 'way', 'relation']).describe('OSM element type.'),
    osm_id: z.number().describe('OSM element ID. Use with osm_type for Nominatim lookup.'),
    lat: z.number().optional().describe('Latitude (present for nodes and ways/relations with center computed).'),
    lon: z.number().optional().describe('Longitude (same).'),
    name: z.string().optional().describe('Feature name from OSM tags.'),
    tags: z.record(z.string()).describe('All OSM tags for this feature. Values are always strings.'),
  })).describe('Matching OSM features, up to the limit.'),
  total_found: z.number().describe('Total features returned before limit truncation.'),
  truncated: z.boolean().describe('True if results were cut at the limit. Reduce radius or add more specific tags to narrow the result set.'),
  data_timestamp: z.string().optional().describe('OSM data freshness timestamp from the Overpass response. Absent when the endpoint reported no freshness metadata.'),
  attribution: z.string(),
})
```

**Errors:**

```ts
errors: [
  {
    reason: 'invalid_tag',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Both amenity and tag_key/tag_value are provided, neither is provided, or a tag key/value contains Overpass QL metacharacters',
    recovery: 'Provide either amenity (e.g., "hospital") or both tag_key and tag_value (e.g., tag_key="leisure", tag_value="park"); tag_key without tag_value is not valid. Tag keys and values must be literal text without Overpass QL metacharacters (" \\ [ ] ; ( )); use openstreetmap_query_raw for arbitrary Overpass QL.',
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
    recovery: 'Shrink the work per query: reduce radius_meters, add more specific tag filters, or drop element_types, then retry. The endpoint budget is fixed, so raising timeout_seconds alone will not clear a 504.',
  },
  {
    reason: 'overpass_unavailable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Overpass answered with an HTTP 5xx other than 504 — the endpoint is down, restarting, or shedding load',
    retryable: true,
    recovery: 'The query is fine; the endpoint is not. Wait about 30 seconds and retry unchanged. If it keeps failing, pin a mirror or private instance via OSM_OVERPASS_BASE_URL.',
  },
]
```

The two 5xx reasons are thrown by manual `McpError` construction rather than `ctx.fail`, so the status-mapped code survives: 504 stays `Timeout` (-32004), 502/503 and other 5xx stay `ServiceUnavailable` (-32000), 500/501 stay `InternalError` (-32603). `ctx.fail` rewrites the code to the contract's declared one, which would collapse all of them onto a single value.

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
  tag_key: z.string().optional().describe('OSM tag key for non-amenity queries (e.g., "leisure", "shop", "natural"). Use with tag_value. Cannot be combined with amenity.'),
  tag_value: z.string().optional().describe('OSM tag value paired with tag_key (e.g., "park", "supermarket", "peak").'),
  element_types: z.array(z.enum(['node', 'way', 'relation'])).default(['node', 'way'])
    .describe('OSM element types to search. Ways cover most buildings and areas; nodes cover most standalone POIs. Add "relation" for complex structures.'),
  limit: z.number().int().min(1).max(500).default(20)
    .describe('Maximum results to return. Applied after the Overpass query — if the area has more features, they are truncated.'),
  timeout_seconds: z.number().int().min(5).max(60).default(25)
    .describe('Overpass query timeout in seconds. Increase for large bounding boxes or dense areas.'),
})
```

**Output:** Same shape as `openstreetmap_query_nearby`.

**Errors:** Same as `openstreetmap_query_nearby` (invalid_tag, query_timeout, result_too_large, rate_limited, upstream_error, overpass_gateway_timeout, overpass_unavailable — the same amenity/tag_key mutual-exclusion, both-required, and metacharacter validation applies; the two 5xx recovery hints name the bounding box instead of the radius), plus:

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
  timeout_seconds: z.number().int().min(5).max(180).default(30)
    .describe('Query timeout in seconds. The [timeout:N] directive in the query string takes precedence if present. Max 180s.'),
})
```

**Output:**

```ts
z.object({
  elements: z.array(z.record(z.unknown())).describe('Raw Overpass API response elements. Structure varies by query type — nodes have lat/lon, ways have nodes[], relations have members[].'),
  total_elements: z.number(),
  data_timestamp: z.string().optional(),
  attribution: z.string(),
})
```

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

**`amenity` shortcut in Overpass convenience tools.** The `amenity` tag covers the vast majority of "what's near me?" POI queries (hospital, pharmacy, restaurant, cafe, etc.). Providing it as a dedicated parameter with a clear description avoids forcing users to learn Overpass's `tag_key`/`tag_value` pattern for the most common case. Both parameters are optional; handler validates that exactly one is provided — both-provided and neither-provided both error with `invalid_tag`.

**`out center tags` in generated Overpass queries.** Ways and relations don't have a single lat/lon — they have a set of node references. `out center` computes a centroid and includes it in the response, which is correct for POI purposes. This normalizes the output so all element types have a usable location. The alternative (`out geom`) would include full node arrays and is appropriate for route/area rendering but not for POI queries.

**Session-level caching in `ctx.state`.** Nominatim's usage policy requires caching. Geocoding the same query twice in one session is wasteful and potentially policy-violating. Cache keys should include all query parameters. TTL: 60 minutes (geocoding results change rarely within a session).

**Rate limiting in NominatimService.** The 1 req/sec hard limit must be enforced server-side. A simple token bucket (1 token/sec, max burst 1) is sufficient. Per the usage policy, MCP tools shouldn't generate bursts of automated requests that could resemble bulk geocoding.

**No autocomplete.** The Nominatim usage policy explicitly forbids autocomplete use. The tools do not accept partial inputs in a way that would enable autocomplete patterns — all queries are submitted as complete search strings.

**No geometry output in Nominatim tools.** The `polygon_geojson`, `polygon_svg`, etc. parameters add boundary geometry. This is useful for rendering but would bloat the tool output significantly. Deferred — add as an optional parameter if agents consistently need polygon boundaries.

**`openstreetmap_lookup_objects` included despite lower frequency.** When an agent workflow has an OSM ID from a prior step (e.g., from an Overpass result), lookup is the efficient path to get full Nominatim address details — a single batch request instead of a geocoding round trip. Supports up to 50 IDs per call.

---

## Known Limitations

**Nominatim reverse geocoding is "closest object," not "containing polygon."** The API finds the nearest indexed OSM object, which may not be the building or parcel the coordinate is inside. In dense urban areas, the result can be a neighboring feature. This is inherent to the API — not something the server can fix. Documented in the `openstreetmap_reverse_geocode` tool description.

**Overpass results are not sorted by distance.** The `around` filter returns all features within the radius but the order is arbitrary (OSM element ID order). Agents that need nearest-first ordering must sort themselves using the returned coordinates.

**Nominatim does not return exhaustive POI lists.** The search endpoint returns the best matches for a query, not all matching objects. For exhaustive lists ("all pharmacies in Seattle"), use Overpass. Nominatim's own documentation states this explicitly.

**Overpass data has a lag of a few minutes** relative to the OSM main database. The `data_timestamp` in tool output surfaces this. The field is omitted when the response carries no `osm3s.timestamp_osm_base` — a non-standard or proxied endpoint reached through `OSM_OVERPASS_BASE_URL` — so absence means no freshness metadata was reported, never that the data is current.

**Antimeridian bounding boxes depend on the endpoint.** A `west > east` box is Overpass QL for a box crossing 180°, and the default endpoint evaluates it as the union of `west..180` and `-180..east` — verified against `overpass-api.de`, where a crossing box returns exactly the elements its two non-crossing halves return. `openstreetmap_query_bbox` passes such bounds through unchanged rather than splitting them, so a mirror or private instance that does not implement the wrap will answer differently; the deterministic workaround there is two calls, one per half.

**Rate limits are per-instance.** The default Nominatim instance (nominatim.openstreetmap.org) has a 1 req/sec hard limit. The default Overpass instance allows 2 concurrent queries, which `OSM_OVERPASS_MAX_CONCURRENCY` caps client-side so submissions queue locally rather than piling onto the endpoint. The cap bounds what this server sends at once; it does not eliminate HTTP 429, because Overpass keeps a slot reserved for the full `[timeout:N]` after answering — a burst of short queries can free the client's slots while the endpoint's are still held. A 429 then surfaces as `rate_limited` on the first attempt instead of being re-submitted. Both endpoints can be overridden via config to use private or mirror instances when higher throughput is needed.

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
| 2026-07-30 | A `west > east` bounding box stays a single pass-through query; the crossing semantics are documented on the longitude bounds instead of being reimplemented as a split | A discriminating experiment against the default endpoint settled what Overpass returns: a crossing box over a latitude band whose complement holds 164,657 `amenity` nodes returned 0, and a crossing box near 180° returned 55 — exactly the 20 + 35 its two non-crossing halves return. So the endpoint implements the wrap rather than silently swapping the bounds, and the reported 504-on-every-crossing-box behavior does not reproduce there. Splitting into two queries would add a merge, a dedupe, a second slot acquisition, and a second cache entry that the deterministic `offset` paging semantics depend on, to guard a failure not reproduced on any endpoint. |
| 2026-05-23 | No prompts | The domain is pure data lookup — there are no recurring agent interaction patterns that benefit from a structured prompt template. Tool descriptions carry sufficient guidance. |
