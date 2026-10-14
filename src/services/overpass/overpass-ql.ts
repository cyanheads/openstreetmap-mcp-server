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

/**
 * The memory a query declares with `[maxsize:N]` (#106): 256 MiB. Overpass reserves a
 * query's declared maxsize and timeout, not what it uses, and its dispatcher admits a
 * query only while each fits in half of what no other query has claimed. Omitted, the
 * maxsize is 536870912 bytes, so under load a small query is refused as "probably too
 * busy" for memory it never touches. Output is not charged against it, only the sets a
 * query holds; 256 MiB covers every convenience call measured up to ~860k matched
 * elements (a 50 km `highway` survey needs 170–192 MiB), and a larger one fails fast as
 * out of memory rather than waiting for an admission it may never get.
 */
export const OVERPASS_QL_DEFAULT_MAXSIZE_BYTES = 268_435_456;

/**
 * A `[maxsize:` settings directive, by its key alone. Overpass reads the value as free
 * tokens — `strtoll` in base 0, so decimal, hex, or octal, then an optional `ki`, `Mi`,
 * `Gi`, `k`, `M`, or `G` suffix with or without a space (`[ maxsize : 1Gi ]`,
 * `[maxsize:2 Gi]`) — and applies the last maxsize it parses, so this check never reads
 * the value. Same spacing and case rule as the other directives. It misses a line or
 * block comment inside the brackets, which Overpass reads as whitespace; that is why the
 * default goes at the head of the query, where a directive it missed still overrides it.
 * A `[maxsize:` written inside a string literal also counts, which only ever leaves a
 * query on Overpass's own default.
 */
export const OVERPASS_QL_MAXSIZE_PATTERN = /\[\s*maxsize\s*:/;
