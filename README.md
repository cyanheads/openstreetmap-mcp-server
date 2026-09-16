<div align="center">
  <h1>@cyanheads/openstreetmap-mcp-server</h1>
  <p><b>Geocode, reverse geocode, and run Overpass spatial queries on OpenStreetMap data via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.8-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openstreetmap-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openstreetmap-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openstreetmap-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Geocoding, reverse geocoding, and spatial queries over OpenStreetMap data via Nominatim and the Overpass API. Search places, resolve coordinates to addresses, and query nearby or bounded features by tag from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `openstreetmap_search_places` | Convert a place name or address to geographic coordinates and structured place data |
| `openstreetmap_reverse_geocode` | Convert latitude/longitude coordinates to the nearest address or place name |
| `openstreetmap_lookup_objects` | Fetch address details for one or more known OSM objects by their IDs |
| `openstreetmap_query_nearby` | Find OSM features within a radius around a geographic point |
| `openstreetmap_query_bbox` | Find OSM features inside a rectangular bounding box, or inside a named OSM boundary — a city, park, or region |
| `openstreetmap_query_raw` | Execute a raw Overpass QL query for advanced spatial operations |

## Capability reference

### `openstreetmap_search_places` <sub>tool</sub>

- Two input modes: free-form `query` or structured address fields (`street`, `city`, `county`, `state`, `country`, `postalcode`), mutually exclusive; `countrycodes` (ISO 3166-1 alpha-2) and `layer` (address, poi, railway, natural, manmade) narrow results, `featureType` restricts to country/state/city/settlement
- `viewbox` (west/south/east/north) biases results, or with `bounded: true` hard-restricts to the area — finer-grained than `countrycodes`, cannot cross the antimeridian; the effective box and restriction mode are echoed back
- Up to 40 results (`limit`), ordered by Nominatim importance score; `extratags` adds contact/metadata and physical-attribute tags on the matched object, `language` sets a BCP 47 preferred language
- Confirmed truncation via a same-call probe one result past `limit`; a full page carries `nextExcludeIds` to page toward further matches with `exclude_place_ids`
- Results carry coordinates, structured address, bounding box, and OSM type/ID for chaining into `openstreetmap_lookup_objects`
- Matches on name and address relevance only — `extratags` decorates the matched object but never selects it; use the Overpass tools to filter or enumerate by tag

---

### `openstreetmap_reverse_geocode` <sub>tool</sub>

- Zoom-level control for address detail: 18=building, 16=street, 14=neighbourhood, 12=town, 10=city, 8=county, 5=state, 3=country
- Layer filtering for the matched OSM object type
- Optional extra OSM tags (contact, metadata, physical attributes) and language preference
- Returns structured address breakdown, OSM type/ID, and bounding box
- Matches on proximity and layer, never on an OSM attribute tag — `extratags` decorates the matched object and cannot select one

---

### `openstreetmap_lookup_objects` <sub>tool</sub>

- Accepts an array of up to 50 IDs, each prefixed N (node), W (way), or R (relation), e.g. `["N240109189"]`; a single ID is still wrapped in an array
- Efficient alternative to a full geocoding round-trip when OSM IDs are already known (e.g., from an Overpass result)
- Reports a `not_found` list for IDs that returned no result
- Optional extra OSM tags (contact, metadata, physical attributes) and language preference
- Returns exactly the objects named in `osm_ids` — `extratags` decorates them and cannot select them; discover objects by tag with the Overpass tools, then pass their IDs here

---

### `openstreetmap_query_nearby` <sub>tool</sub>

- Primary tool for "what's near X?" spatial queries; the `amenity` shortcut covers common POI types (hospital, pharmacy, restaurant, cafe, school, atm), or use `tag_key` with an optional `tag_value` for other categories — omit `tag_value` to match any feature carrying that key
- Up to five additional `filters: [{ key, value? }]`, ANDed with the primary tag in input order; blank values and duplicate keys are rejected, and tags must be literal text without Overpass QL metacharacters (`"`, `\`, `[`, `]`, `;`, `(`, `)`) — use `openstreetmap_query_raw` for regex, alternation, or negation
- `effectiveTag` echoes the complete filter chain on every response
- Configurable `radius_meters` up to 50km (keep under 5km for dense urban POI queries); `element_types` filters node/way/relation
- Up to 500 results (`limit`) with offset paging and a `truncated` flag
- Returns OSM type/ID, coordinates, name, distance from the center point, and full tag set per feature, sorted nearest-first

---

### `openstreetmap_query_bbox` <sub>tool</sub>

- Useful for area surveys where proximity to a single point isn't the goal
- Two scopes, one per call: the four corner fields, or `within` — a single OSM boundary ref (`R237385` for Seattle, `W13800188` for a park), which is the `osm_type` plus `osm_id` the geocoding tools already return
- A boundary scopes to the boundary itself, where its bounding box overcovers with water and neighbouring places; `effectiveArea` echoes how the ref resolved and `areasTimestamp` reports how stale the Overpass area database is
- A ref that maps to no Overpass area — a nonexistent id, an unclosed way, a relation without an area-forming tag — returns an empty page whose notice names that cause, rather than a bare zero
- Same primary tag, key-existence, and bounded `filters` interface as `openstreetmap_query_nearby`, including trimming, blank-value, and duplicate-key validation
- A `west` greater than `east` is a box crossing the antimeridian, covering `west..180` plus `-180..east`; only `south` greater than `north` is rejected
- Configurable timeout for large bounding boxes or dense areas
- Up to 500 results (`limit`) with a `truncated` flag

---

### `openstreetmap_query_raw` <sub>tool</sub>

- Full Overpass QL expressiveness — multi-type queries, union queries, relation membership, historical queries; the query must include `[out:json]`, and the server injects `[timeout:N]` if absent
- Returns a raw element array — structure varies by query type (nodes carry lat/lon, ways carry `nodes[]`, relations carry `members[]`)
- Up to 500 elements per call (`limit`) with `totalFound`/`truncated`/`nextOffset` disclosure; page the rest with `offset`
- Per-element `max_element_bytes` budget (default 20000 UTF-8 bytes, ceiling 10000000) withholds an over-budget element's `members`/`nodes`/`geometry` arrays whole rather than truncating them, listed under `withheld_keys`
- `withheldElements`/`withheldNotice` give the one-call retrieval path for a withheld element — the same query with `limit: 1`, that element's offset, and a raised `max_element_bytes`
- `timeout_seconds` up to 180 is honored client-side; validate complex queries at [overpass-turbo.eu](https://overpass-turbo.eu) before use

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

OpenStreetMap-specific:

- Configurable `OSM_USER_AGENT` and rate-limit-aware request handling honor Nominatim's usage policy
- Overpass slot budget respected client-side via `OSM_OVERPASS_MAX_CONCURRENCY`; a throttled endpoint is never re-submitted to — the call advances to the next endpoint instead
- Opt-in Overpass endpoint failover via `OSM_OVERPASS_ENDPOINTS` — a failure advances to the next mirror inside the same call, and every response reports the endpoint that served it
- Private instance support — override `OSM_NOMINATIM_BASE_URL` and `OSM_OVERPASS_BASE_URL` for self-hosted or mirror endpoints
- Overpass rejections carry the upstream cause verbatim — a 5xx surfaces its `runtime error: ...` remark, a malformed `openstreetmap_query_raw` query its `line N: parse error: ...` detail

Agent-friendly output:

- Attribution on every response — agents can surface the ODbL license notice as required
- Structured output contracts — coordinates, OSM IDs, address fields, and tag maps in consistent shapes
- Cross-tool chaining — Overpass results carry `osm_type` + `osm_id` that feed directly into `openstreetmap_lookup_objects` for full address records
- Community-edited OSM text is escaped for literal display in the Markdown surface, so a name or tag value cannot open a heading, forge emphasis, or inject a line of its own into a tool's response — the structured surface keeps the raw bytes

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js ≥24.0.0).
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
| `MCP_SESSION_MODE` | HTTP session handling: `stateless`, `stateful`, or `auto` (`auto` resolves to `stateful`). This server holds no per-session state and never asks the client for input, so the published Docker image sets `stateless`. | `auto` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop (ms). Recommended starting point if heap growth is observed: `60000`. | `0` (disabled) |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `OSM_NOMINATIM_BASE_URL` | Nominatim API base URL. Override for a private or mirror instance. A path prefix is supported for instances proxied under a subpath (e.g. `https://maps.example.com/nominatim`), with or without a trailing slash. | `https://nominatim.openstreetmap.org` |
| `OSM_OVERPASS_BASE_URL` | Overpass API endpoint URL. When set, pins every query to this one endpoint and disables mirror failover — what a private-instance deployment wants. Leave unset to use `OSM_OVERPASS_ENDPOINTS`. | unset |
| `OSM_OVERPASS_ENDPOINTS` | Comma-separated ordered list of Overpass endpoints. On a failure the same tool call advances to the next entry, so a degraded endpoint costs latency instead of the answer; the first entry stays the preferred one. A host that refused the call on its own account — a throttle, a refused or unresolvable connection, an instance fault, or no answer inside its attempt window — is skipped for the rest of that call rather than asked again. A single entry means no failover. Ignored when `OSM_OVERPASS_BASE_URL` is set. See [Overpass endpoint failover](#overpass-endpoint-failover). | `https://overpass-api.de/api/interpreter` |
| `OSM_OVERPASS_MAX_CONCURRENCY` | Maximum Overpass queries submitted at once; queries past the cap queue locally. Match the slot budget the endpoint advertises at `/api/status`. The endpoint keeps a slot reserved for the full `[timeout:N]` after answering, so a burst can still draw an HTTP 429 — that endpoint is then skipped for the rest of the call rather than re-submitted to, and `rate_limited` surfaces once every configured endpoint has refused. | `2` |
| `OSM_USER_AGENT` | User-Agent sent to Nominatim and Overpass. Required by usage policy. | `openstreetmap-mcp-server/<package version>` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

### Overpass endpoint failover

Out of the box the server queries one Overpass endpoint, the FOSSGIS-operated main instance. A degraded endpoint therefore fails the call — `openstreetmap_query_nearby`, `openstreetmap_query_bbox`, and `openstreetmap_query_raw` all depend on it.

Listing more than one endpoint in `OSM_OVERPASS_ENDPOINTS` turns on failover: a failure advances to the next entry inside the same tool call, and the list is tried in order so the first entry stays preferred.

An endpoint that refuses the call on its own account is skipped for the rest of that call rather than re-asked, so the query reaches a host that has not already turned it down. Four outcomes count as that kind of refusal: an HTTP 429 or throttle page, a connection that is refused or whose host does not resolve, an OSM3S dispatcher or database fault, and an attempt that went unanswered for its whole window — a host given a full window and no answer would only be re-asked with whatever the budget has left, which cannot succeed where the full window did not. An HTTP 5xx is not one of them: that is the endpoint shedding load, so it stays eligible for a retry.

Once every configured endpoint has refused, the call stops submitting and reports what each one did — `rate_limited` when they all throttled, `endpoints_exhausted` when they all went unanswered, and `endpoints_unavailable` for a refused or unreachable host or any mix, whose message names each endpoint and its outcome so "every host was unavailable" is distinguishable from "every host was too slow for this query".

```sh
OSM_OVERPASS_ENDPOINTS="https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter"
```

Failover is opt-in rather than the default because adding an endpoint sends your queries to a third party, on their terms and their bandwidth. Before listing one:

- **Confirm the operator welcomes general client use.** The [OSM wiki instance list](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances) records each instance's stated usage policy, and they differ sharply — some grant open use, others require an API key or payment, others ask you to contact the operator first. `overpass.private.coffee`, for one, publishes a grant covering any project including commercial use, alongside prohibited-use terms and a request to be told in advance about large-scale use.
- **Check the data coverage.** Region-scoped instances answer a query outside their extract with HTTP 200 and an empty element list — a silent wrong answer rather than an error — so they are unfit as a general-purpose fallback no matter how healthy they are. The wiki list separates global instances from regional ones.
- **Check the freshness.** Mirrors can lag the main instance, sometimes by weeks. Every response reports which endpoint served it in the `servingEndpoint` enrichment field alongside the `data_timestamp` output field, so a stale or unexpected result stays attributable.

`OSM_USER_AGENT` is sent to every endpoint, and its default identifies this server and its version, which is what the main instance's policy asks for. An endpoint you add is governed by its own policy as well.

Two other behaviors bound what a failover can cost. `OSM_OVERPASS_MAX_CONCURRENCY` is one budget across all endpoints, so rotating never raises the number of submissions in flight. And one tool call stops submitting once it has spent its time budget — per-attempt deadline, queue wait, and retry backoff all count against that — so a long endpoint list cannot multiply one attempt window by its length. The budget is at least 120 seconds and widens with the `[timeout:N]` a query carries, so a long `openstreetmap_query_raw` timeout is honored without lengthening every other call.

Setting `OSM_OVERPASS_BASE_URL` pins that single endpoint and disables failover, unchanged from previous releases: a private or self-hosted instance is not interchangeable with a public mirror.

## Running the server

### Docker

Run the published image:

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/openstreetmap-mcp-server:latest
```

Or build and run locally:

```sh
docker build -t openstreetmap-mcp-server .
docker run --rm -p 3010:3010 openstreetmap-mcp-server
```

The image serves HTTP at `0.0.0.0:3010/mcp` with stateless sessions and logs under `/var/log/openstreetmap-mcp-server`. Connect at `http://localhost:3010/mcp`. To use host port 8011, map `-p 8011:3010`; the container port stays 3010.

Builds include the optional telemetry packages by default. Add `--build-arg OTEL_ENABLED=false` to `docker build` to omit them. Runtime telemetry remains controlled separately by the `OTEL_ENABLED` environment variable (default `false`); enable it with `-e OTEL_ENABLED=true` on an image built with those packages.

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

## Data attribution

Map data from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
