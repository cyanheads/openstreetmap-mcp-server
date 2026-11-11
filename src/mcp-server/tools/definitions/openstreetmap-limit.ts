/**
 * @fileoverview The `limit` clamp shared by the four paged tools: a value above a tool's
 * per-call maximum is served at that maximum rather than rejected, and the response says so
 * under its own `limitNotice` key. The `limit` schemas set no maximum of their own, since a
 * schema rejection above the clamp would refuse a call the clamp answers.
 * @module mcp-server/tools/definitions/openstreetmap-limit
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * The `limitNotice` enrichment field. Its own key, never `notice`: that one is written by the
 * empty-page, past-the-end, truncation, and stray-amenity paths, last write wins.
 */
export const limitNoticeField = z
  .string()
  .optional()
  .describe(
    "Present when limit exceeded this tool's maximum: the value requested and the one applied.",
  );

/**
 * The limit a call is served at, plus the disclosure when that differs from the request.
 * Every value derived from `limit` — the page slice, `truncated`, `nextOffset`, the
 * past-the-end retry offsets, a probe size — reads the applied value.
 */
export function clampLimit(
  requested: number,
  max: number,
): { limit: number; limitNotice?: string } {
  return requested > max
    ? {
        limit: max,
        limitNotice: `Requested limit ${requested} exceeds this tool's maximum of ${max}, so ${max} was applied.`,
      }
    : { limit: requested };
}
