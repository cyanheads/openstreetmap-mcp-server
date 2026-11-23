/**
 * @fileoverview Literal Markdown for text the server did not author: raw Overpass values, and
 * notices that quote the caller's input.
 * @module mcp-server/tools/definitions/openstreetmap-markdown-escape
 */

import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';

/** A notice line that is a call to hand back to a tool: Overpass QL, or a JSON argument object. */
const HAND_BACK_LINE = /^(?:\[out:json\]|\{")/;

/**
 * Pieces the walk gathers before joining them into one chunk of the result, so the list of
 * pieces stays short however many scalars a value holds.
 */
const CHUNK_PIECES = 8192;

/**
 * Renders a raw Overpass value for `content[]`: an object or array as its JSON, any other value
 * as its string, escaped so a CommonMark parse reads it back as that text.
 *
 * Objects and arrays are walked down to their scalars, and only strings and keys go through the
 * framework escaper, one JSON string at a time (#141), so no call is given more than one string,
 * and each distinct key is escaped once per value. Brackets (as `\[` and `\]`), braces, colons,
 * commas, and every number, boolean, and null are written as they stand: the escaper changes none
 * of their characters away from a line start, and none starts one here. The walk keeps its own
 * stack, so no nesting depth the JSON parser accepts can overflow it.
 *
 * The result is the text escaping the whole JSON yields, with one exception: the framework
 * escapes a `<` that a later `@…>` could close as an email autolink, and each string is escaped
 * without sight of the strings after it. No autolink spans two strings, since an address holds
 * no quote, so that `<` stays as written and the JSON still reads back whole.
 */
export function escapeMarkdownValue(value: unknown): string {
  return typeof value === 'object' && value !== null
    ? escapeJsonValue(value)
    : escapeMarkdownInline(String(value));
}

/** An open array or object in the walk, and the position of its next entry. */
type Frame =
  | { readonly kind: 'array'; readonly items: readonly unknown[]; next: number }
  | {
      readonly kind: 'object';
      readonly entries: Readonly<Record<string, unknown>>;
      readonly keys: readonly string[];
      next: number;
    };

/** The JSON of `root`, each string and key escaped on its own. */
function escapeJsonValue(root: object): string {
  const chunks: string[] = [];
  const pieces: string[] = [];
  const frames: Frame[] = [];
  const escapedKeys = new Map<string, string>();
  let value: unknown = root;
  for (;;) {
    if (Array.isArray(value)) {
      pieces.push('\\[');
      frames.push({ kind: 'array', items: value, next: 0 });
    } else if (typeof value === 'object' && value !== null) {
      const entries = value as Record<string, unknown>;
      pieces.push('{');
      frames.push({ kind: 'object', entries, keys: Object.keys(entries), next: 0 });
    } else {
      const json = JSON.stringify(value);
      pieces.push(typeof value === 'string' ? escapeMarkdownInline(json) : json);
    }
    if (pieces.length >= CHUNK_PIECES) {
      chunks.push(pieces.join(''));
      pieces.length = 0;
    }

    let frame = frames.at(-1);
    while (
      frame !== undefined &&
      frame.next === (frame.kind === 'array' ? frame.items.length : frame.keys.length)
    ) {
      pieces.push(frame.kind === 'array' ? '\\]' : '}');
      frames.pop();
      frame = frames.at(-1);
    }
    if (frame === undefined) {
      chunks.push(pieces.join(''));
      return chunks.join('');
    }
    if (frame.next > 0) pieces.push(',');
    if (frame.kind === 'array') {
      value = frame.items[frame.next];
    } else {
      const key = frame.keys[frame.next] as string;
      let escaped = escapedKeys.get(key);
      if (escaped === undefined) {
        escaped = escapeMarkdownInline(JSON.stringify(key));
        escapedKeys.set(key, escaped);
      }
      pieces.push(escaped, ':');
      value = frame.entries[key];
    }
    frame.next++;
  }
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
