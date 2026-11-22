/**
 * @fileoverview Literal Markdown for text the server did not author: raw Overpass values, and
 * notices that quote the caller's input.
 * @module mcp-server/tools/definitions/openstreetmap-markdown-escape
 */

import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';

/** A notice line that is a call to hand back to a tool: Overpass QL, or a JSON argument object. */
const HAND_BACK_LINE = /^(?:\[out:json\]|\{")/;

/**
 * Serializes objects before escaping so nested text and backslashes survive rendering.
 *
 * An array is escaped one item at a time and reassembled, and a CommonMark parse reads the
 * result back as the array's JSON. It is the text escaping the serialized array whole yields,
 * with one exception: the framework escapes a `<` that a later `@…>` could close as an email
 * autolink, and an item is escaped without sight of the items after it. No autolink spans two
 * items, since an address holds neither the quote nor the comma between them, so that `<` stays
 * as written. The framework escaper's working memory grows with the text one call is given,
 * about 45 bytes per character, so a relation's `members` with full geometry (tens of megabytes
 * as JSON) cost gigabytes in one call and one member's worth here.
 */
export function escapeMarkdownValue(value: unknown): string {
  if (Array.isArray(value)) return `\\[${value.map(escapeArrayItem).join(',')}\\]`;
  return escapeMarkdownInline(
    typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value),
  );
}

/**
 * One array item as it reads inside the serialized array. A number, boolean, or null is its
 * JSON token as it stands: the escaper changes none of their characters away from a line
 * start, and an item never starts a line.
 */
function escapeArrayItem(item: unknown): string {
  const json = JSON.stringify(item);
  return typeof item === 'string' || (typeof item === 'object' && item !== null)
    ? escapeMarkdownInline(json)
    : json;
}

/**
 * Renders a `notice` as a Markdown blockquote that a CommonMark parse reads back as the notice
 * itself, CR and CRLF line breaks as LF. Declared as a tool's `enrichmentTrailer.notice.render`,
 * which shapes `content[]` only: `structuredContent.notice` keeps the text as composed.
 *
 * Each line is quoted on its own. A line that is a call to hand back to a tool (it starts with
 * `[out:json]` or `{"`) renders as one code span, so a reader copies it out with no backslash;
 * every other line goes through `escapeMarkdownInline`. Lines join with hard breaks, keeping the
 * quote one paragraph; a final line break is `&#10;`, since a hard break cannot end a paragraph.
 * Every rendered line opens with `>`, which is what lets the framework close the quote before
 * the next trailer field.
 */
export function renderNoticeMarkdown(notice: string): string {
  const lines = notice.split(/\r\n?|\n/);
  return lines
    .map((line, i) => {
      if (i === 0) return `> ${renderNoticeLine(line)}`;
      return i === lines.length - 1 && line === '' ? '&#10;' : `\\\n> ${renderNoticeLine(line)}`;
    })
    .join('');
}

function renderNoticeLine(line: string): string {
  return HAND_BACK_LINE.test(line)
    ? markdown().inlineCode(line).build()
    : escapeMarkdownInline(line);
}
