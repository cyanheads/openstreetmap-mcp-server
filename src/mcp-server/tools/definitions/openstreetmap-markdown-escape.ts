/**
 * @fileoverview Literal-Markdown escaping for community-edited OpenStreetMap text
 *   rendered into a tool's `content[]`.
 * @module mcp-server/tools/definitions/openstreetmap-markdown-escape
 */

/**
 * CommonMark-significant characters that alter the structure of the surrounding
 * response when they arrive inside an upstream scalar.
 *
 * `\` leads so an upstream backslash cannot forge an escape of its own. `[` and
 * `]` are enough to disarm links and images — a destination is only read after an
 * unescaped `]` — so `(`, `)` and `!` stay readable in the common OSM name
 * (`Foo (formerly Bar)`) at no cost.
 *
 * `_` is escaped at a word boundary only — where it is not flanked by an
 * alphanumeric on at least one side. That is exactly where CommonMark's flanking
 * rules let it open emphasis, so ` _word_ ` and ` __FAKE SYSTEM NOTICE__ ` render
 * literally, while the intraword `_` that is pervasive in Nominatim and OSM keys
 * (`country_code`, `ISO3166-2-lvl4`, `addr_full`, `man_made`) carries no emphasis
 * meaning and stays clean — an unconditional escape would put a backslash in
 * nearly every address and tag line for no gain.
 *
 * Deliberately excluded: `-`, `.`, `+`, `:`, `/` and `=` — block-construct markers
 * that must sit at the start of a line to mean anything, which neutralizing line
 * breaks already prevents, and each is common in ordinary values (`US-WA`,
 * `+1-206-555-1234`, `https://example.com`).
 *
 * Accepted residual: a bare URL, a bare `www.` host and a bare email address are
 * left readable and may autolink on a GFM renderer. Autolinking needs no upstream
 * metacharacter, so the only defense would be mangling the value itself.
 */
const SCALAR_METACHARACTERS = /[\\`*[\]<>#|~\n\r]|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g;

/**
 * The same set with the roles of the bracket and paren pairs swapped, for text
 * that has already been serialized to JSON.
 *
 * `[`, `]`, `{` and `}` are JSON structure there, so escaping them would put a
 * backslash in front of every array in the rendering. A link still cannot form,
 * because it needs `]` immediately followed by `(` and this set escapes the paren
 * instead; `[label]` left alone is a shortcut reference, inert without a matching
 * link-reference definition, and none is ever emitted.
 *
 * `_` carries the same word-boundary rule as the scalar set: the JSON quotes around
 * a leaf are non-alphanumeric, so a leading or trailing `_` inside one is escaped,
 * while `country_code` in a key or value stays clean.
 */
const SERIALIZED_METACHARACTERS = /[\\`*()<>#|~\n\r]|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g;

function escapeWith(pattern: RegExp, value: string): string {
  return value.replace(pattern, (char) =>
    char === '\n' ? '\\n' : char === '\r' ? '\\r' : `\\${char}`,
  );
}

/**
 * Escapes an upstream scalar for literal display inside Markdown `content[]`.
 *
 * Nothing is deleted and nothing is truncated: every character survives, and the
 * significant ones gain a leading backslash that renders away. Embedded line breaks
 * become the literal two-character sequences `\n` and `\r`, so upstream text can
 * never open a line of its own inside the server's own response.
 *
 * `structuredContent` carries the raw value — this is a rendering concern only.
 */
export function escapeMarkdownText(value: string): string {
  return escapeWith(SCALAR_METACHARACTERS, value);
}

/**
 * Escapes a value of unknown type for Markdown display, serializing objects and
 * arrays to JSON first so nested free text (a relation member's `role`) is covered
 * too.
 *
 * The escape runs **after** `JSON.stringify`, never on the leaves before it:
 * `JSON.stringify` re-escapes any backslash a leaf pass inserted, which turns `\*`
 * back into a literal backslash followed by a live emphasis marker. Escaping the
 * finished string is the only ordering where the rendered text matches the JSON
 * text.
 */
export function escapeMarkdownValue(value: unknown): string {
  return typeof value === 'object' && value !== null
    ? escapeWith(SERIALIZED_METACHARACTERS, JSON.stringify(value))
    : escapeMarkdownText(String(value));
}
