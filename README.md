<div align="center">
  <h1>@cyanheads/openstreetmap-mcp-server</h1>
  <p><b>Geocode, reverse geocode, and run Overpass spatial queries on OpenStreetMap data via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openstreetmap-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openstreetmap-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openstreetmap-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

OpenStreetMap data through Nominatim and the Overpass API. Geocode places and addresses, resolve coordinates to the nearest address, look up known OSM objects, and query features by tag around a point, inside a bounding box, or inside an OSM boundary. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

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

- Free-form `query` or the structured fields `street`, `city`, `county`, `state`, `country`, `postalcode`, never both; up to 40 results (`limit`, default 5), narrowed by `countrycodes`, `layer`, `featureType`, and a `viewbox` that biases ranking or, with `bounded: true`, restricts it
- Results carry coordinates, structured `address`, `boundingbox`, `importance`, and `osm_type` + `osm_id`; `extratags` adds the object's contact and physical-attribute tags; an empty first page fails as `no_results`
- `truncated` is confirmed by a same-call probe past `limit`, and any full page returns `nextExcludeIds` to pass back as `exclude_place_ids`; an exhausted walk returns zero results with a notice, not an error

---

### `openstreetmap_reverse_geocode` <sub>tool</sub>

- `lat` / `lon` plus `zoom` from 3 (country) to 18 (building, the default); `layer` defaults to `address,poi`
- Returns the nearest indexed object with structured `address`, `osm_type` + `osm_id`, and `boundingbox`; coordinates with no OSM data fail as `no_coverage`

---

### `openstreetmap_lookup_objects` <sub>tool</sub>

- Up to 50 `osm_ids` per call, each prefixed `N`, `W`, or `R` (`["N240109189"]`); a malformed ID fails as `invalid_id_format`
- Returns address records for the objects found and lists the rest under `not_found`

---

### `openstreetmap_query_nearby` <sub>tool</sub>

- `lat` / `lon` with `radius_meters` up to 50,000 (default 1,000); one primary tag, `amenity` or `tag_key` with an optional `tag_value`, plus up to five ANDed `filters`; up to 500 features per page
- Features carry `osm_type` + `osm_id`, coordinates, `distance_meters`, and the full tag set, sorted nearest-first; `effectiveTag` echoes the whole filter chain

---

### `openstreetmap_query_bbox` <sub>tool</sub>

- One scope per call: the corners `south`, `west`, `north`, `east`, or `within` and one `R`/`W` boundary ref (`R237385`) built from a geocoding result's `osm_type` + `osm_id`; the same tag filters and 500-per-page cap as `openstreetmap_query_nearby`
- `effectiveArea` echoes how `within` resolved and `areasTimestamp` how old the Overpass area data is; a ref that maps to no area returns an empty page whose notice names the cause
- A `west` greater than `east` is a box crossing the antimeridian; only `south` greater than `north` fails, as `invalid_bbox`

---

### `openstreetmap_query_raw` <sub>tool</sub>

- Any Overpass QL containing `[out:json]`, with `[timeout:N]` injected from `timeout_seconds` (up to 180, default 30) when the query has none; up to 500 elements per page
- Returns raw elements whose shape varies by type (ways carry `nodes[]`, relations `members[]`), plus `total_elements` and the `effectiveQuery` as sent; malformed QL fails as `query_error` with the parse error Overpass reported
- `max_element_bytes` (default 20,000, ceiling 10,000,000) withholds an over-budget element's `members`, `nodes`, or `geometry` arrays whole, listed under `withheld_keys`; `withheldElements` and `withheldNotice` give the offset and budget that fetch it back

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OpenStreetMap-specific:

- Nominatim request starts are spaced 1,050 ms apart to respect its one-request-per-second policy, and `OSM_USER_AGENT` identifies the server to both upstreams
- Overpass submissions are capped per endpoint by `OSM_OVERPASS_MAX_CONCURRENCY` or an entry's `|N`, with opt-in failover across `OSM_OVERPASS_ENDPOINTS` (see [Overpass endpoint failover](#overpass-endpoint-failover))
- The Overpass tools page with `limit` and `offset` and report `totalFound`, `truncated`, and `nextOffset`; a match set of up to 100,000 elements is cached for 10 minutes, so re-paging makes no new upstream request (Nominatim responses are cached for 60), and identical queries in flight at once share one submission
- Upstream rejections keep their cause: an Overpass 5xx carries its `runtime error` remark, a Nominatim 400 fails as `invalid_parameters` naming the rejected parameter
- `OSM_NOMINATIM_BASE_URL` and `OSM_OVERPASS_BASE_URL` point the server at a self-hosted or mirror instance

Agent-friendly output:

- Provenance: `effectiveQuery`, `effectiveTag`, and `effectiveArea` echo what was sent, Overpass responses add `data_timestamp` and `servingEndpoint`, and every response carries the ODbL `attribution`
- Cross-tool chaining: `osm_type` + `osm_id` from any tool feed `openstreetmap_lookup_objects`, and a geocoded relation or way becomes a `within` ref for `openstreetmap_query_bbox`
- Tag semantics stated outright: the Nominatim tools pick objects by name, address, proximity, or ID, never by tag, and `tagSelectionCaveat` says so (on every `openstreetmap_search_places` response, and on the other two when `extratags` is set). Overpass filters take literal text; regex, alternation, and negation go through `openstreetmap_query_raw`
- Community-edited names and tag values are escaped in the Markdown surface so they cannot inject headings or formatting; `structuredContent` keeps the raw text

## Getting started

### Public Hosted Instance

A public instance is available at `https://openstreetmap.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "openstreetmap-mcp-server": {
      "type": "streamable-http",
      "url": "https://openstreetmap.caseyjhand.com/mcp"
    }
  }
}
```

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
| `OSM_OVERPASS_BASE_URL` | Pins every query to one Overpass endpoint and disables failover, for a private instance. Sized by `OSM_OVERPASS_MAX_CONCURRENCY`. | unset |
| `OSM_OVERPASS_ENDPOINTS` | Comma-separated, ordered Overpass endpoints; more than one enables failover. Append `\|N` to an entry to give it N slots and add capacity (see below). Ignored when `OSM_OVERPASS_BASE_URL` is set. | `https://overpass-api.de/api/interpreter` |
| `OSM_OVERPASS_MAX_CONCURRENCY` | Max Overpass queries in flight per endpoint, for the pin and every entry without `\|N`. Match the slot budget the endpoint reports at `/api/status`. | `2` |
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

By default every Overpass query goes to one endpoint, the FOSSGIS-operated main instance, so a degraded endpoint fails the call. Listing more in `OSM_OVERPASS_ENDPOINTS` lets a failure advance to the next entry inside the same call, in list order:

```sh
OSM_OVERPASS_ENDPOINTS="https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter"
```

- An endpoint that throttles, answers 401/403/404/501 or a redirect, refuses the connection or fails DNS, reports an instance fault, or never answers is skipped for the rest of the call. Redirects are never followed. Any other 5xx, a 408, or a 425 stays eligible for a retry.
- A host that cannot be connected to, or stays silent through a full attempt window, is also skipped by later calls while it cools down: 30 seconds, doubling with each repeat up to 10 minutes, after which one call tries it again. Any HTTP response from it ends the cooldown. Error messages name a skipped host's last outcome with `(cooling down)`, and when every endpoint is cooling a call still tries the one cooling longest.
- When every endpoint has refused, the call fails with their shared error if they all failed the same way (`rate_limited` for throttling, `upstream_error` for an instance fault, `endpoints_rejected` for an HTTP refusal such as a wrong path or a missing key), `endpoints_exhausted` if none answered, or `endpoints_unavailable` if none could be reached or they failed in a mix of ways, with each endpoint's outcome in the message.
- Endpoints are reported by origin alone (`https://overpass-api.de`) in `servingEndpoint`, error messages, and logs. Where an endpoint's own error text quotes an entry's whole path, query string, or userinfo verbatim, the server repeats each as `…`, so a key in the URL path or query reaches a response or a log only if the endpoint echoes it in another form, such as the key alone or re-encoded. Two entries on one origin read as `(entry 1)`, `(entry 2)` by list position.
- A failure moves to an entry the call has not tried at once; a return to one it already tried waits out a backoff. One call gets a time budget of at least 120 seconds, widened by the query's `[timeout:N]`.
- A listed mirror is failover only, so a longer list never adds queries in flight: calls run on the first entry, `OSM_OVERPASS_MAX_CONCURRENCY` at a time. To add capacity, size a mirror with `|N` — `https://mirror.example/api/interpreter|4` gives it four slots of its own, and new calls take the first entry with a free slot. Write a `|` inside a URL as `%7C`.
- Calls past the slots wait in line in arrival order, for at most 30 seconds in total; a call still waiting then fails with `pacer_shed` and a `retryAfter` of at least 30 seconds.

Adding an endpoint sends your queries to a third party. Before listing one, check its usage policy on the [OSM wiki instance list](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances), confirm it holds global data (a regional instance answers a query outside its extract with an empty HTTP 200), and expect mirrors to lag the main instance; `servingEndpoint` and `data_timestamp` on every response show which host answered and how fresh its data was.

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
