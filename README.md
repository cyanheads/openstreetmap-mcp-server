<div align="center">
  <h1>@cyanheads/openstreetmap-mcp-server</h1>
  <p><b>Geocode, reverse geocode, and run Overpass spatial queries on OpenStreetMap data via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">



[![Version](https://img.shields.io/badge/Version-0.2.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openstreetmap-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openstreetmap-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openstreetmap-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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
| `openstreetmap_geocode` | Convert a place name or address to geographic coordinates and structured place data |
| `openstreetmap_reverse` | Convert latitude/longitude coordinates to the nearest address or place name |
| `openstreetmap_lookup` | Fetch address details for one or more known OSM objects by their IDs |
| `openstreetmap_query_nearby` | Find OSM features within a radius around a geographic point |
| `openstreetmap_query_bbox` | Find OSM features within a rectangular bounding box |
| `openstreetmap_query_raw` | Execute a raw Overpass QL query for advanced spatial operations |

### `openstreetmap_geocode`

Convert a place name or address to geographic coordinates via Nominatim/OpenStreetMap.

- Two input modes: free-form query string (e.g., `"Space Needle Seattle"`) or structured address fields (street, city, state, country, postal code) — mutually exclusive
- Country filtering via ISO 3166-1 alpha-2 codes (`countrycodes`)
- Data layer filtering: address, poi, railway, natural, manmade
- Feature type restriction: country, state, city, settlement
- Optional extra OSM tags (phone, website, opening_hours, wikidata)
- Preferred language override via BCP 47 code
- Returns results ordered by Nominatim importance score (global prominence)
- Results include coordinates, structured address, bounding box, OSM type/ID for chaining into `openstreetmap_lookup`

---

### `openstreetmap_reverse`

Convert latitude/longitude to the nearest address or named place.

- Zoom-level control for address detail: 18=building, 16=street, 14=neighbourhood, 12=town, 10=city, 8=county, 5=state, 3=country
- Layer filtering for matched OSM object type
- Optional extra OSM tags and language preference
- Returns structured address breakdown, OSM type/ID, and bounding box

---

### `openstreetmap_lookup`

Fetch full Nominatim address records for known OSM object IDs.

- Accepts single ID or array of up to 50 IDs
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
- Configurable timeout for large bounding boxes or dense areas
- Limit up to 500 results with `truncated` flag

---

### `openstreetmap_query_raw`

Execute arbitrary Overpass QL for queries the convenience tools don't cover.

- Full Overpass QL expressiveness: multi-type queries, union queries, relation membership, historical queries
- Query must include `[out:json]`; server injects `[timeout:N]` if absent
- Returns raw element array — structure varies by query type (nodes have lat/lon, ways have nodes[], relations have members[])
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
- OSM attribution on every response (`Data © OpenStreetMap contributors, ODbL 1.0`)
- Private instance support — override `OSM_NOMINATIM_BASE_URL` and `OSM_OVERPASS_BASE_URL` for self-hosted or mirror endpoints
- Structured error contracts: `no_results`, `no_coverage`, `invalid_id_format`, `invalid_tag`, `query_timeout`, `rate_limited`, `query_error`, `result_too_large` — all with actionable recovery hints

Agent-friendly output:

- Attribution on every response — agents can surface the ODbL license notice as required
- Structured output contracts — coordinates, OSM IDs, address fields, and tag maps in consistent shapes
- Cross-tool chaining: Overpass results carry `osm_type` + `osm_id` that feed directly into `openstreetmap_lookup` for full address records

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
| `OSM_NOMINATIM_BASE_URL` | Nominatim API base URL. Override for a private or mirror instance. | `https://nominatim.openstreetmap.org` |
| `OSM_OVERPASS_BASE_URL` | Overpass API endpoint URL. Override for a mirror or private instance. | `https://overpass-api.de/api/interpreter` |
| `OSM_USER_AGENT` | User-Agent sent to Nominatim and Overpass. Required by usage policy. | `openstreetmap-mcp-server/0.1.8` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

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
