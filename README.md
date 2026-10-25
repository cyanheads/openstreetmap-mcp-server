<div align="center">
  <h1>@cyanheads/openstreetmap-mcp-server</h1>
  <p><b>Geocode, reverse geocode, and run Overpass spatial queries on OpenStreetMap data via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.6.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openstreetmap-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openstreetmap-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openstreetmap-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openstreetmap-mcp-server/releases/latest/download/openstreetmap-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openstreetmap-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbnN0cmVldG1hcC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openstreetmap-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopenstreetmap-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://openstreetmap.caseyjhand.com/mcp](https://openstreetmap.caseyjhand.com/mcp)

</div>

---

## Overview

OpenStreetMap data through Nominatim and the Overpass API. Geocode places and addresses, resolve coordinates to the nearest address, look up known OSM objects, and query features by tag around a point, inside a bounding box, or inside an OSM boundary.

### Tools

| Tool | Description |
|:---|:---|
| `openstreetmap_search_places` | Convert a place name or address to coordinates and structured place data |
| `openstreetmap_reverse_geocode` | Convert latitude/longitude to the nearest address or place name |
| `openstreetmap_lookup_objects` | Fetch address records for known OSM objects by ID |
| `openstreetmap_query_nearby` | Find OSM features within a radius of a point |
| `openstreetmap_query_bbox` | Find OSM features inside a bounding box or an OSM boundary such as a city, park, or region |
| `openstreetmap_query_raw` | Run a raw Overpass QL query for anything the other tools cannot express |

## Capability reference

### `openstreetmap_search_places` <sub>tool</sub>

- Free-form `query` or the structured fields `street`, `city`, `county`, `state`, `country`, `postalcode`, never both; up to 40 results (`limit`, default 5; a larger `limit` is served as 40 with a `limitNotice`), narrowed by `countrycodes`, `layer`, `featureType`, and a `viewbox` (restricting with `bounded: true`)
- Results carry coordinates, structured `address`, `boundingbox`, `importance`, and `osm_type` + `osm_id`; `extratags` adds contact and physical-attribute tags; an empty first page fails as `no_results`
- A full page returns `nextExcludeIds` to pass back as `exclude_place_ids`; once results run out you get zero results and a notice, not an error

---

### `openstreetmap_reverse_geocode` <sub>tool</sub>

- `lat` / `lon` plus `zoom` from 3 (country) to 18 (building, the default); `layer` defaults to `address,poi`
- Returns the nearest indexed object with structured `address`, `osm_type` + `osm_id`, and `boundingbox`; coordinates with no OSM data fail as `no_coverage`

---

### `openstreetmap_lookup_objects` <sub>tool</sub>

- Up to 500 `osm_ids` entries, each prefixed `N`, `W`, or `R` (`["N240109189"]`); a malformed ID fails as `invalid_id_format`
- The first 50 unique IDs are looked up; the rest come back as `deferred_ids` for the next call
- Returns address records for the objects found and lists the rest under `not_found` (including objects Nominatim does not index, such as street lamps); a `notice` carries an `openstreetmap_query_raw` query to check which exist

---

### `openstreetmap_query_nearby` <sub>tool</sub>

- `lat` / `lon` with `radius_meters` up to 50,000 (default 1,000); one primary tag, `amenity` or `tag_key` with an optional `tag_value`, plus up to five ANDed `filters`; up to 500 features per page (a larger `limit` is served as 500 with a `limitNotice`)
- A value matches exactly by default; `list_item` mode (`tag_value_match`, or `match` on a filter) matches one item of a semicolon list, so `cuisine` = `pizza` also finds `cuisine=pizza;italian`
- An `amenity` value that OpenStreetMap tags under another key (`amenity: "museum"`; museums are `tourism=museum`) gets a `notice` naming the key to retry with
- Features carry `osm_type` + `osm_id`, coordinates, `distance_meters` (to the feature's nearest point), and the full tag set, sorted nearest-first; `effectiveTag` echoes the filter chain

---

### `openstreetmap_query_bbox` <sub>tool</sub>

- One scope per call: the corners `south`, `west`, `north`, `east`, or `within` and one `R`/`W` boundary ref (`R237385`) built from a geocoding result's `osm_type` + `osm_id`; the same tag filters, list-item matching, stray-`amenity` notice, and 500-per-page cap as `openstreetmap_query_nearby`
- `effectiveArea` echoes how `within` resolved and `areasTimestamp` how old the area data is; a ref that maps to no area returns an empty page with a notice
- A `west` greater than `east` is a box crossing the antimeridian; `south` greater than `north` fails as `invalid_bbox`

---

### `openstreetmap_query_raw` <sub>tool</sub>

- Any Overpass QL containing `[out:json]`; `[timeout:N]` comes from `timeout_seconds` (up to 180, default 30) and `[maxsize:268435456]` (256 MiB) is added when the query sets none; up to 500 elements per page (a larger `limit` is served as 500 with a `limitNotice`)
- Returns raw elements (ways carry `nodes[]`, relations `members[]`), plus `total_elements` and the `effectiveQuery` as sent; malformed QL fails as `query_error` with Overpass's parse error
- `max_element_bytes` (default 20,000, minimum 1,000) withholds an over-budget element's `members`, `nodes`, or `geometry` arrays, listed under `withheld_keys`; `withheldElements` and `withheldNotice` say how to fetch them

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OpenStreetMap-specific:

- Nominatim requests are spaced 1,050 ms apart to respect its one-request-per-second policy; `OSM_USER_AGENT` identifies the server to both upstreams
- Overpass queries are limited per endpoint by `OSM_OVERPASS_MAX_CONCURRENCY`, with opt-in failover across `OSM_OVERPASS_ENDPOINTS` (see [Overpass endpoint failover](#overpass-endpoint-failover))
- Overpass tools page with `limit` and `offset` and report `totalFound`, `truncated`, and `nextOffset`; results are cached for 10 minutes (Nominatim for 60), so re-paging makes no new upstream request
- An Overpass response over 64 MiB fails as `result_too_large`
- `OSM_NOMINATIM_BASE_URL` and `OSM_OVERPASS_BASE_URL` point the server at a self-hosted or mirror instance

Agent-friendly output:

- `effectiveQuery`, `effectiveTag`, and `effectiveArea` echo what was sent; Overpass responses add `data_timestamp` and `servingEndpoint`, and every response carries the ODbL `attribution`
- `osm_type` + `osm_id` from any tool feed `openstreetmap_lookup_objects`, and a geocoded relation or way becomes a `within` ref for `openstreetmap_query_bbox`
- The Nominatim tools never select by tag, and `tagSelectionCaveat` says so; regex, alternation, and negation go through `openstreetmap_query_raw`
- Names and tag values are escaped in the Markdown output; `structuredContent` keeps the raw text

## Getting started

### Public Hosted Instance

A public instance is available at `https://openstreetmap.caseyjhand.com/mcp` — no installation required. It serves Streamable HTTP; each client takes its own config shape.

For Claude Code:

```sh
claude mcp add --transport http openstreetmap-mcp-server https://openstreetmap.caseyjhand.com/mcp
```

For Cline (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "openstreetmap-mcp-server": {
      "type": "streamableHttp",
      "url": "https://openstreetmap.caseyjhand.com/mcp"
    }
  }
}
```

For Cursor (`mcp.json`):

```json
{
  "mcpServers": {
    "openstreetmap-mcp-server": {
      "url": "https://openstreetmap.caseyjhand.com/mcp"
    }
  }
}
```

Claude Desktop adds remote servers under Settings → Connectors.

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

Or with Docker:

```json
{
  "mcpServers": {
    "openstreetmap-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/openstreetmap-mcp-server:latest"
      ]
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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key. Nominatim and Overpass are public services; for heavy use, point `OSM_NOMINATIM_BASE_URL` and `OSM_OVERPASS_BASE_URL` at your own instances.

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

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env to override endpoints or the User-Agent as needed
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `OSM_NOMINATIM_BASE_URL` | Nominatim base URL. A path prefix such as `https://maps.example.com/nominatim` is supported. | `https://nominatim.openstreetmap.org` |
| `OSM_OVERPASS_BASE_URL` | Pins every query to one Overpass endpoint and disables failover. | unset |
| `OSM_OVERPASS_ENDPOINTS` | Comma-separated, ordered Overpass endpoints; more than one enables failover. Ignored when `OSM_OVERPASS_BASE_URL` is set. | `https://overpass-api.de/api/interpreter` |
| `OSM_OVERPASS_MAX_CONCURRENCY` | Max Overpass queries in flight per endpoint. Public instances allow one per user. | `1` |
| `OSM_USER_AGENT` | User-Agent sent to Nominatim and Overpass. Required by usage policy. | `openstreetmap-mcp-server/<package version>` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. The server declares `stateless` in code; an explicit value overrides it. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides. An invalid value for any `OSM_*` variable stops the server at startup with a message naming the variable.

### Overpass endpoint failover

By default every Overpass query goes to one endpoint, the FOSSGIS-operated main instance. List more in `OSM_OVERPASS_ENDPOINTS` and a failed call moves to the next entry in order:

```sh
OSM_OVERPASS_ENDPOINTS="https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter"
```

- Endpoints that fail repeatedly are skipped for a while (30 seconds, doubling up to 10 minutes)
- When every endpoint fails, the call fails with `rate_limited`, `upstream_error`, `overpass_unavailable`, `endpoints_rejected`, `endpoints_exhausted`, or `endpoints_unavailable`, with each endpoint's outcome in the message
- Endpoints are reported by origin only (`https://overpass-api.de`) in `servingEndpoint`, error messages, and logs
- Extra entries are failover only and never add concurrency. For an instance that allows parallel queries, append `|N` to its entry (`https://mirror.example/api/interpreter|4`) for N slots; write a literal `|` in a URL as `%7C`. Never size a public FOSSGIS server
- Calls waiting for a slot fail with `pacer_shed` and a `retryAfter` of at least 30 seconds after 30 seconds in line

Adding an endpoint sends your queries to a third party. Check its usage policy on the [OSM wiki instance list](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances), confirm it holds global data (a regional instance answers out-of-extract queries with an empty HTTP 200), and expect mirrors to lag the main instance; `servingEndpoint` and `data_timestamp` show which host answered and how fresh its data was.

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

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/openstreetmap-mcp-server:latest

# or build locally
docker build -t openstreetmap-mcp-server .
docker run --rm -p 3010:3010 openstreetmap-mcp-server
```

The image serves HTTP at `http://localhost:3010/mcp` in stateless session mode and logs to `/var/log/openstreetmap-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them. Runtime telemetry stays off until you pass `-e OTEL_ENABLED=true`.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and shared input, formatting, and escaping helpers. Six tools across Nominatim and Overpass. |
| `src/services/nominatim` | Nominatim service: paced API client for search, reverse, and lookup, plus error parsing. |
| `src/services/overpass` | Overpass service: query builder, endpoint failover and executor, element normalizer, error parsing. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests for tools, services, and security. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.

Map data from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
