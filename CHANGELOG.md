# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.3.3](changelog/0.3.x/0.3.3.md) — 2026-07-29

Overpass 5xx causes now reach query_bbox and query_nearby, data_timestamp is omitted rather than fabricated when absent, and two field descriptions are corrected (#39, #40, #43, #46)

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-07-29

Overpass 5xx failures had no error contract entry and malformed-query parse errors were truncated before reaching the caller (#38, #45)

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-07-29

Overpass HTML throttle pages and OOM remarks were misclassified, retried, or dropped as silent successes; concurrent submissions are now capped client-side (#41, #42, #44)

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-07-26 · ⚠️ Breaking

Nominatim tools renamed to explicit three-token names and osm_ids is array-only (#30, #29); openstreetmap_query_raw surfaces the Overpass parse error from HTTP 400 bodies (#33)

## [0.2.15](changelog/0.2.x/0.2.15.md) — 2026-07-26

openstreetmap_query_nearby/bbox and openstreetmap_geocode distinguish an exhausted page from a real empty result (#27, #35); geocode content[] importance no longer loses precision (#28); tag_key/tag_value are trimmed before Overpass interpolation (#36)

## [0.2.14](changelog/0.2.x/0.2.14.md) — 2026-07-26

Nominatim throttle now reserves request slots synchronously so concurrent callers can't bypass the 1 req/s limit (#26); featureType search filter fixed (#31); geocode/reverse/lookup gain rate_limited and upstream_error error contracts (#32); OSM_NOMINATIM_BASE_URL path prefix preserved for subpath-hosted mirrors (#34)

## [0.2.13](changelog/0.2.x/0.2.13.md) — 2026-07-09

openstreetmap_query_raw content[] now renders every raw element field for full structuredContent parity (#20); openstreetmap_geocode nextExcludeIds emits stable OSM refs instead of volatile place_ids (#25)

## [0.2.12](changelog/0.2.x/0.2.12.md) — 2026-07-06

openstreetmap_query_bbox/query_nearby gain offset paging with nextOffset (#24); openstreetmap_geocode gains exclude_place_ids/nextExcludeIds (#24); openstreetmap_query_bbox rejects inverted bounding boxes with invalid_bbox (#22)

## [0.2.11](changelog/0.2.x/0.2.11.md) — 2026-07-06

openstreetmap_query_raw content output includes coordinates and all elements (#20); Nominatim content output includes country_code/ISO3166-2-lvl4 (#21); mcp-ts-core ^0.10.14

## [0.2.10](changelog/0.2.x/0.2.10.md) — 2026-07-05

openstreetmap_query_nearby/query_bbox reject Overpass QL metacharacters in tag inputs instead of interpolating them; query_raw's missing-[out:json] error now carries its recovery hint

## [0.2.9](changelog/0.2.x/0.2.9.md) — 2026-07-05

Nominatim language param fix (accept-language), geocode truncation guard, free-form query guidance for parent-institution tokens, mcp-ts-core ^0.10.11

## [0.2.8](changelog/0.2.x/0.2.8.md) — 2026-06-20

@cyanheads/mcp-ts-core ^0.10.6 → ^0.10.9: dependency-specifier and plugin-manifest devcheck guards, fresh-scaffold/worktree script guards, framework skill re-sync

## [0.2.7](changelog/0.2.x/0.2.7.md) — 2026-06-15

Build tooling: run release:github under bun, drop the unused tsx devDependency

## [0.2.6](changelog/0.2.x/0.2.6.md) — 2026-06-12

@cyanheads/mcp-ts-core ^0.9.21 → ^0.10.6: geocode truncation disclosure, explicit server identity, MCPB bundle cleaner, Docker healthcheck

## [0.2.5](changelog/0.2.x/0.2.5.md) — 2026-06-02

@cyanheads/mcp-ts-core ^0.9.16 → ^0.9.21: per-request log context fix, secret scrubbing from error messages, withRetry fail-fast on non-retryable errors

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-05-30

Overpass fail-fast on deterministic failures, recovery hints populated, HTTP 400 as ValidationError, geocode effectiveQuery enrichment

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-05-30

enrichment adoption: geocode/query tools surface tag echoes, true totals, truncation, and empty-result guidance via structuredContent and content[]

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-05-28

mcp-ts-core ^0.9.13: 413 body cap, HTTP session-init gate, quieter error logs, GET /mcp keywords

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-05-28

query_nearby results now sorted nearest-first with distance_meters; extratags scope clarified for Overpass tools

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-05-24 · ⚠️ Breaking

Breaking rename: repo/package nominatim → openstreetmap; tool prefixes nominatim_*/overpass_* → openstreetmap_*; env vars NOMINATIM_*/OVERPASS_* → OSM_*

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-05-24

Code simplification: shared format/tag helpers, flatMap, Set; error codes ValidationError; mcp-ts-core ^0.9.7 → ^0.9.9

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-05-24

Fix HTTP 406 on all Overpass tools: add missing User-Agent header; read version dynamically from package.json

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-23

Adds hosted server endpoint metadata: remotes block in server.json and public URL in README

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-23

Dockerfile build stage restored to oven/bun:1.3; package.json scripts migrated from tsx to bun run; manifest.json description and metadata fields aligned; server.json runtimeHint corrected to bun

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-23

Sync tagline across README, package.json, server.json, manifest.json, and GitHub repo description

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-23

Validate [out:json] in overpass_query_raw before sending query; sync package metadata to gold standard

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-23

Fix ctx.state cache keys in NominatimService and OverpassService — SHA-256 hash replaces raw JSON/QL embedding, resolving all 6 tools being broken

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-23

OpenStreetMap geocoding, reverse geocoding, and Overpass spatial queries via 6 tool definitions

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-23

Initial scaffold from @cyanheads/mcp-ts-core
