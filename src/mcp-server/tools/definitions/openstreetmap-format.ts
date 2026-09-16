/**
 * @fileoverview Shared formatting helpers for Nominatim place result rendering.
 * @module mcp-server/tools/definitions/openstreetmap-format
 */

import { escapeMarkdownText } from './openstreetmap-markdown-escape.js';

/**
 * Append formatted lines for the common fields shared across all three Nominatim
 * tool format() functions: OSM ref, category, address breakdown, bounding box, extratags.
 *
 * Every community-edited value is escaped for literal display — address and
 * extratags entries and the category pair. `structuredContent` still carries the
 * raw text; only this rendering changes.
 */
export function appendPlaceLines(
  lines: string[],
  r: {
    osm_type?: 'node' | 'way' | 'relation' | undefined;
    osm_id?: number | undefined;
    category?: string | undefined;
    type?: string | undefined;
    address?: Record<string, string> | undefined;
    boundingbox?: [number, number, number, number] | undefined;
    extratags?: Record<string, string> | undefined;
  },
): void {
  if (r.osm_type && r.osm_id !== undefined) {
    lines.push(`**OSM:** ${r.osm_type.charAt(0).toUpperCase()}${r.osm_id}`);
  }
  if (r.category) {
    const type = r.type ? ` / ${escapeMarkdownText(r.type)}` : '';
    lines.push(`**Category:** ${escapeMarkdownText(r.category)}${type}`);
  }
  if (r.address) {
    const addrParts = Object.entries(r.address)
      .map(([k, v]) => `${escapeMarkdownText(k)}: ${escapeMarkdownText(v)}`)
      .join(', ');
    if (addrParts) lines.push(`**Address details:** ${addrParts}`);
  }
  if (r.boundingbox) {
    lines.push(
      `**Bounding box:** S:${r.boundingbox[0]} N:${r.boundingbox[1]} W:${r.boundingbox[2]} E:${r.boundingbox[3]}`,
    );
  }
  if (r.extratags && Object.keys(r.extratags).length > 0) {
    const extra = Object.entries(r.extratags)
      .map(([k, v]) => `${escapeMarkdownText(k)}: ${escapeMarkdownText(v)}`)
      .join(', ');
    lines.push(`**Extra tags:** ${extra}`);
  }
}
