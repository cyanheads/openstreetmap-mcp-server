/**
 * @fileoverview Shared formatting helpers for Nominatim place result rendering.
 * @module mcp-server/tools/definitions/openstreetmap-format
 */

/**
 * Append formatted lines for the common fields shared across all three Nominatim
 * tool format() functions: OSM ref, category, address breakdown, bounding box, extratags.
 */
export function appendPlaceLines(
  lines: string[],
  r: {
    osm_type?: 'node' | 'way' | 'relation' | undefined;
    osm_id?: number | undefined;
    category?: string | undefined;
    type?: string | undefined;
    address?: Record<string, string> | undefined;
    boundingbox?: [string, string, string, string] | undefined;
    extratags?: Record<string, string> | undefined;
  },
): void {
  if (r.osm_type && r.osm_id !== undefined) {
    lines.push(`**OSM:** ${r.osm_type.charAt(0).toUpperCase()}${r.osm_id}`);
  }
  if (r.category) {
    lines.push(`**Category:** ${r.category}${r.type ? ` / ${r.type}` : ''}`);
  }
  if (r.address) {
    const addrParts = Object.entries(r.address)
      .map(([k, v]) => `${k}: ${v}`)
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
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    lines.push(`**Extra tags:** ${extra}`);
  }
}
