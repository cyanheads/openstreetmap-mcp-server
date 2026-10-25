/**
 * @fileoverview CommonMark parsing for assertions on rendered MCP text.
 * @module tests/helpers/markdown
 */

import MarkdownIt from 'markdown-it';

export const commonmark = new MarkdownIt('commonmark');

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
