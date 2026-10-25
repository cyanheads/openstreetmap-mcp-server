/**
 * @fileoverview Serializes raw Overpass values for literal Markdown display.
 * @module mcp-server/tools/definitions/openstreetmap-markdown-escape
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/** Serializes objects before escaping so nested text and backslashes survive rendering. */
export function escapeMarkdownValue(value: unknown): string {
  return escapeMarkdownInline(
    typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value),
  );
}
