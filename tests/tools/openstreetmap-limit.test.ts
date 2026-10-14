/**
 * @fileoverview Unit tests for the `limit` clamp shared by the four paged tools (#105).
 * @module tests/tools/openstreetmap-limit.test
 */

import { describe, expect, it } from 'vitest';
import {
  clampLimit,
  LIMIT_SCHEMA_MAX,
} from '@/mcp-server/tools/definitions/openstreetmap-limit.js';

describe('clampLimit', () => {
  it.each([
    [1, 500],
    [499, 500],
    [500, 500],
    [40, 40],
  ])('serves %i as asked under a maximum of %i, with no notice', (requested, max) => {
    expect(clampLimit(requested, max)).toEqual({ limit: requested });
  });

  it.each([
    [501, 500, "Requested limit 501 exceeds this tool's maximum of 500, so 500 was applied."],
    [41, 40, "Requested limit 41 exceeds this tool's maximum of 40, so 40 was applied."],
    [
      LIMIT_SCHEMA_MAX,
      500,
      "Requested limit 10000 exceeds this tool's maximum of 500, so 500 was applied.",
    ],
  ])('clamps %i to the maximum %i and says so', (requested, max, limitNotice) => {
    expect(clampLimit(requested, max)).toEqual({ limit: max, limitNotice });
  });
});
