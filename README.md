<div align="center">
  <h1>@cyanheads/openstreetmap-mcp-server</h1>
  <p><b>Geocode, reverse geocode, and run Overpass spatial queries on OpenStreetMap data via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">



[![Version](https://img.shields.io/badge/Version-0.3.6-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openstreetmap-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openstreetmap-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openstreetmap-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openstreetmap-mcp-server/releases/latest/download/openstreetmap-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openstreetmap-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbnN0cmVldG1hcC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openstreetmap-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopenstreetmap-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://openstreetmap.caseyjhand.com/mcp](https://openstreetmap.caseyjhand.com/mcp)

</div>

---

## Tools

6 tools for geocoding and spatial queries against OpenStreetMap data:

| Tool | Description |
|:---|:---|
| `openstreetmap_search_places` | Convert a place name or address to geographic coordinates and structured place data |
| `openstreetmap_reverse_geocode` | Convert latitude/longitude coordinates to the nearest address or place name |
| `openstreetmap_lookup_objects` | Fetch address details for one or more known OSM objects by their IDs |
| `openstreetmap_query_nearby` | Find OSM features within a radius around a geographic point |
| `openstreetmap_query_bbox` | Find OSM features within a rectangular bounding box |
| `openstreetmap_query_raw` | Execute a raw Overpass QL query for advanced spatial operations |

### `openstreetmap_search_places`

Convert a place name or address to geographic coordinates via Nominatim/OpenStreetMap.

- Two input modes: free-form query string (e.g., `"Space Needle Seattle"`) or structured address fields (street, city, state, country, postal code) — mutually exclusive
- Country filtering via ISO 3166-1 alpha-2 codes (`countrycodes`)
- Data layer filtering: address, poi, railway, natural, manmade
- Feature type restriction: country, state, city, settlement
- Optional extra OSM tags (phone, website, opening_hours, wikidata)
- Preferred language override via BCP 47 code
- Returns results ordered by Nominatim importance score (global prominence)
- Results include coordinates, structured address, bounding box, OSM type/ID for chaining into `openstreetmap_lookup_objects`

---

### `openstreetmap_reverse_geocode`

Convert latitude/longitude to the nearest address or named place.

- Zoom-level control for address detail: 18=building, 16=street, 14=neighbourhood, 12=town, 10=city, 8=county, 5=state, 3=country
- Layer filtering for matched OSM object type
- Optional extra OSM tags and language preference
- Returns structured address breakdown, OSM type/ID, and bounding box

---

### `openstreetmap_lookup_objects`

Fetch full Nominatim address records for known OSM object IDs.

- Accepts an array of up to 50 IDs; a single ID is passed wrapped, e.g. `["N240109189"]`
- IDs must be prefixed with N (node), W (way), or R (relation): e.g., `"N240109189"`, `"W50637691"`, `"R146656"`
- Efficient alternative to a full geocoding round-trip when OSM IDs are already known (e.g., from an Overpass result)
- Reports `not_found` list for IDs that returned no result
- Optional extra OSM tags and language preference

---

### `openstreetmap_query_nearby`

Find OSM features within a radius around a point via the Overpass API.

- Primary tool for "what's near X?" spatial queries
- Supports `amenity` shortcut for common POI types (hospital, pharmacy, restaurant, cafe, school, atm) or `tag_key` + `tag_value` for any OSM category (leisure=park, shop=supermarket, natural=peak)
- Configurable radius up to 50km; keep under 5km for dense urban POI queries
- Element type filtering: node (standalone POIs), way (buildings/areas), relation (complex structures)
- Limit up to 500 results; `truncated` flag signals when more exist
- Returns OSM type/ID, coordinates, name, and full tag set for each feature

---

### `openstreetmap_query_bbox`

Find OSM features within a rectangular geographic bounding box.

- Useful for area surveys where proximity to a single point isn't the goal
- Same `amenity` / `tag_key` + `tag_value` interface as `openstreetmap_query_nearby`
- A `west` greater than `east` is a box crossing the antimeridian, covering `west..180` plus `-180..east`; only `south` greater than `north` is rejected
- Configurable timeout for large bounding boxes or dense areas
- Limit up to 500 results with `truncated` flag

---

### `openstreetmap_query_raw`

Execute arbitrary Overpass QL for queries the convenience tools don't cover.

- Full Overpass QL expressiveness: multi-type queries, union queries, relation membership, historical queries
- Query must include `[out:json]`; server injects `[timeout:N]` if absent
- Returns raw element array — structure varies by query type (nodes have lat/lon, ways have nodes[], relations have members[])
- Limit up to 500 elements per call with `totalFound` / `truncated` / `nextOffset` disclosure; page the rest with `offset`
- `timeout_seconds` up to 180 is honored client-side, so a long-running query is not cut off early
- Validate complex queries at [overpass-turbo.eu](https://overpass-turbo.eu) before use

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or on Cloudflare Workers from the same codebase

Nominatim/Overpass-specific:

- Nominatim usage policy compliance: configurable `User-Agent` via `OSM_USER_AGENT`, rate-limit-aware request handling
- Overpass slot budget respected client-side: concurrent submissions capped by `OSM_OVERPASS_MAX_CONCURRENCY`, and a throttled endpoint is never re-submitted to — the call advances to the next endpoint instead, and fails only once every one has refused it
- Opt-in Overpass endpoint failover: list mirrors in `OSM_OVERPASS_ENDPOINTS` and a transient failure advances to the next one inside the same call. Deterministic failures (malformed query, result too large) stay on one endpoint, and every response reports the endpoint that served it
- OSM attribution on every response (`Data © OpenStreetMap contributors, ODbL 1.0`)
- Private instance support — override `OSM_NOMINATIM_BASE_URL` and `OSM_OVERPASS_BASE_URL` for self-hosted or mirror endpoints
- Structured error contracts: `no_results`, `no_coverage`, `invalid_input`, `invalid_id_format`, `invalid_tag`, `invalid_bbox`, `query_timeout`, `rate_limited`, `upstream_error`, `query_error`, `result_too_large`, `overpass_gateway_timeout`, `overpass_unavailable`, `endpoints_exhausted` — all with actionable recovery hints
- Overpass rejections carry the upstream cause: the whole error document is captured, so an Overpass 5xx surfaces its `runtime error: ...` remark on every Overpass tool, and a malformed `openstreetmap_query_raw` query its `line N: parse error: ...` detail, instead of a bare status

Agent-friendly output:

- Attribution on every response — agents can surface the ODbL license notice as required
- Structured output contracts — coordinates, OSM IDs, address fields, and tag maps in consistent shapes
- Cross-tool chaining: Overpass results carry `osm_type` + `osm_id` that feed directly into `openstreetmap_lookup_objects` for full address records

## Getting started

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "openstreetmap-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/openstreetmap-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "openstreetmap-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/openstreetmap-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js ≥24.0.0).
- No API key required — Nominatim and Overpass are public APIs. For heavy use, consider pointing `OSM_NOMINATIM_BASE_URL` and `OSM_OVERPASS_BASE_URL` at self-hosted or mirror instances.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/openstreetmap-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd openstreetmap-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop (ms). Recommended starting point if heap growth is observed: `60000`. | `0` (disabled) |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `OSM_NOMINATIM_BASE_URL` | Nominatim API base URL. Override for a private or mirror instance. A path prefix is supported for instances proxied under a subpath (e.g. `https://maps.example.com/nominatim`), with or without a trailing slash. | `https://nominatim.openstreetmap.org` |
| `OSM_OVERPASS_BASE_URL` | Overpass API endpoint URL. When set, pins every query to this one endpoint and disables mirror failover — what a private-instance deployment wants. Leave unset to use `OSM_OVERPASS_ENDPOINTS`. | unset |
| `OSM_OVERPASS_ENDPOINTS` | Comma-separated ordered list of Overpass endpoints. On a transient failure (5xx, HTML throttle page, connection timeout) the same tool call advances to the next entry, so a degraded endpoint costs latency instead of the answer; the first entry stays the preferred one. A single entry means no failover. Ignored when `OSM_OVERPASS_BASE_URL` is set. See [Overpass endpoint failover](#overpass-endpoint-failover). | `https://overpass-api.de/api/interpreter` |
| `OSM_OVERPASS_MAX_CONCURRENCY` | Maximum Overpass queries submitted at once; queries past the cap queue locally. Match the slot budget the endpoint advertises at `/api/status`. The endpoint keeps a slot reserved for the full `[timeout:N]` after answering, so a burst can still draw an HTTP 429 — that endpoint is then skipped for the rest of the call rather than re-submitted to, and `rate_limited` surfaces once every configured endpoint has refused. | `2` |
| `OSM_USER_AGENT` | User-Agent sent to Nominatim and Overpass. Required by usage policy. | `openstreetmap-mcp-server/<package version>` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

### Overpass endpoint failover

Out of the box the server queries one Overpass endpoint, the FOSSGIS-operated main instance. A degraded endpoint therefore fails the call — `openstreetmap_query_nearby`, `openstreetmap_query_bbox`, and `openstreetmap_query_raw` all depend on it.

Listing more than one endpoint in `OSM_OVERPASS_ENDPOINTS` turns on failover: a transient failure advances to the next entry inside the same tool call, and the list is tried in order so the first entry stays preferred. Throttling counts — an endpoint that answers HTTP 429 or a throttle page is skipped for the rest of the call rather than re-asked, so the query reaches a mirror with a free slot.

```sh
OSM_OVERPASS_ENDPOINTS="https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter"
```

Failover is opt-in rather than the default because adding an endpoint sends your queries to a third party, on their terms and their bandwidth. Before listing one:

- **Confirm the operator welcomes general client use.** The [OSM wiki instance list](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances) records each instance's stated usage policy, and they differ sharply — some grant open use, others require an API key or payment, others ask you to contact the operator first. `overpass.private.coffee`, for one, publishes a grant covering any project including commercial use, alongside prohibited-use terms and a request to be told in advance about large-scale use.
- **Check the data coverage.** Region-scoped instances answer a query outside their extract with HTTP 200 and an empty element list — a silent wrong answer rather than an error — so they are unfit as a general-purpose fallback no matter how healthy they are. The wiki list separates global instances from regional ones.
- **Check the freshness.** Mirrors can lag the main instance, sometimes by weeks. Every response reports which endpoint served it in the `servingEndpoint` enrichment field alongside the `data_timestamp` output field, so a stale or unexpected result stays attributable.

`OSM_USER_AGENT` is sent to every endpoint, and its default identifies this server and its version, which is what the main instance's policy asks for. An endpoint you add is governed by its own policy as well.

Two other behaviors bound what a failover can cost. `OSM_OVERPASS_MAX_CONCURRENCY` is one budget across all endpoints, so rotating never raises the number of submissions in flight. And one tool call stops submitting once it has spent its time budget — per-attempt deadline, queue wait, and retry backoff all count against that — surfacing `endpoints_exhausted` rather than multiplying a per-attempt deadline by the retry budget. The budget is at least 120 seconds and widens with the `[timeout:N]` a query carries, so a long `openstreetmap_query_raw` timeout is honored without lengthening every other call.

Setting `OSM_OVERPASS_BASE_URL` pins that single endpoint and disables failover, unchanged from previous releases: a private or self-hosted instance is not interchangeable with a public mirror.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Six tools across Nominatim and Overpass. |
| `src/services/nominatim` | Nominatim service layer — API client, search, reverse, lookup. |
| `src/services/overpass` | Overpass service layer — query builder, executor, element normalizer. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

Map data from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
