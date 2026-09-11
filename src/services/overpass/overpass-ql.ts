/**
 * @fileoverview Patterns for the Overpass QL settings directives the server reads
 * and rewrites, spelled the way Overpass itself parses them.
 * @module services/overpass/overpass-ql
 */

/**
 * The `[out:json]` settings directive. Overpass permits whitespace anywhere
 * inside the brackets — `[out: json]`, `[ out:json ]`, and `[out :json]` all
 * answer HTTP 200 — but the keywords are case-sensitive: `[OUT:JSON]` is
 * rejected with `Unknown attribute "OUT"`. Matching that exact tolerance keeps a
 * valid query from being refused by the preflight, and keeps a spelling Overpass
 * rejects from being accepted.
 */
export const OVERPASS_QL_OUT_JSON_PATTERN = /\[\s*out\s*:\s*json\s*\]/;

/**
 * The `[timeout:N]` settings directive, capturing the requested seconds. Same
 * spacing rule as the output directive; any digit width, since Overpass accepts
 * one — whether the value is worth waiting for is the budget's call, not the
 * pattern's.
 *
 * One pattern serves both readers of this directive — the tool's presence check,
 * which decides whether to inject a timeout, and the service's budget derivation,
 * which decides how long to wait for the answer. Two patterns that disagreed on
 * spacing put the two decisions out of step: a spelling one recognized and the
 * other did not either injected a second directive alongside the caller's or
 * waited out the flat budget for a query asking for longer.
 *
 * Dependency-free and in its own module so both readers can import it without
 * either pulling in the other.
 */
export const OVERPASS_QL_TIMEOUT_PATTERN = /\[\s*timeout\s*:\s*(\d+)\s*\]/;
