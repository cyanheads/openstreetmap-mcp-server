# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
