/**
 * @fileoverview CommonMark parsing for assertions on rendered MCP text.
 * @module tests/helpers/markdown
 */

import MarkdownIt from 'markdown-it';
import { expect } from 'vitest';

export const commonmark = new MarkdownIt('commonmark');

/** The inline tokens a notice quote may hold: anything else is live Markdown or HTML. */
const NOTICE_INLINE = new Set(['text', 'softbreak', 'hardbreak', 'code_inline']);

/**
 * The notice blockquote in rendered `content[]` text, read back through a CommonMark parse.
 * Fails the calling test unless the quote is one paragraph of text, line breaks, and code
 * spans: `markdownText` joins an `html_inline` token back in as text, so it cannot see raw
 * HTML or live Markdown inside the quote.
 */
export function quotedNotice(markdown: string): string {
  const tokens = commonmark.parse(markdown, {});
  const inner = tokens.slice(
    tokens.findIndex((token) => token.type === 'blockquote_open') + 1,
    tokens.findIndex((token) => token.type === 'blockquote_close'),
  );
  expect(inner.map((token) => token.type)).toEqual(['paragraph_open', 'inline', 'paragraph_close']);
  const children = inner[1]?.children ?? [];
  expect(children.map((child) => child.type).filter((type) => !NOTICE_INLINE.has(type))).toEqual(
    [],
  );
  return children.map((child) => (child.type.endsWith('break') ? '\n' : child.content)).join('');
}

/** The content of every code span inside a block quote, in order: where a notice renders. */
export function quotedCodeSpans(markdown: string): string[] {
  let depth = 0;
  return commonmark.parse(markdown, {}).flatMap((token) => {
    if (token.type === 'blockquote_open') depth++;
    if (token.type === 'blockquote_close') depth--;
    return depth > 0 && token.children
      ? token.children.flatMap((child) => (child.type === 'code_inline' ? [child.content] : []))
      : [];
  });
}

/** Returns visible text after parsing Markdown, preserving hard and soft line breaks. */
export function markdownText(markdown: string): string {
  return commonmark
    .parse(markdown, {})
    .flatMap((token) => {
      if (token.children) {
        return [
          token.children
            .map((child) =>
              child.type === 'hardbreak' || child.type === 'softbreak' ? '\n' : child.content,
            )
            .join(''),
        ];
      }
      return token.type === 'code_block' || token.type === 'fence' ? [token.content] : [];
    })
    .join('\n');
}
