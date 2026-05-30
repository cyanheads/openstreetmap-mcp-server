/**
 * @fileoverview Unit tests for the haversineMeters distance function.
 * @module tests/services/overpass/haversine.test
 */

import { describe, expect, it } from 'vitest';
import { haversineMeters } from '@/services/overpass/overpass-service.js';

describe('haversineMeters', () => {
  it('returns 0 for identical coordinates', () => {
    expect(haversineMeters(47.6062, -122.3321, 47.6062, -122.3321)).toBe(0);
  });

  it('returns roughly 111195m per degree of latitude (near equator)', () => {
    const dist = haversineMeters(0, 0, 1, 0);
    expect(dist).toBeGreaterThan(110000);
    expect(dist).toBeLessThan(112000);
  });

  it('is symmetric — d(A,B) === d(B,A)', () => {
    const d1 = haversineMeters(47.6062, -122.3321, 47.6205, -122.3493);
    const d2 = haversineMeters(47.6205, -122.3493, 47.6062, -122.3321);
    expect(d1).toBeCloseTo(d2, 6);
  });

  it('returns approximately 1000m for points ~1km apart', () => {
    // ~0.009 degrees latitude ≈ 1km
    const dist = haversineMeters(47.6062, -122.3321, 47.6152, -122.3321);
    expect(dist).toBeGreaterThan(900);
    expect(dist).toBeLessThan(1100);
  });

  it('handles coordinates that cross the antimeridian', () => {
    // Points near 180/-180 boundary
    const dist = haversineMeters(0, 179.9, 0, -179.9);
    // Should be a short distance (~22km), not a large wraparound
    expect(dist).toBeLessThan(25000);
  });

  it('correctly handles negative latitudes (southern hemisphere)', () => {
    const dist = haversineMeters(-33.8688, 151.2093, -33.8688, 151.2193);
    expect(dist).toBeGreaterThan(0);
    expect(dist).toBeLessThan(2000);
  });

  it('returns positive distance for all pole-to-equator measurements', () => {
    const dist = haversineMeters(90, 0, 0, 0);
    expect(dist).toBeGreaterThan(0);
  });

  it('produces sub-meter precision for very close points', () => {
    // Points 1m apart (approx 0.000009 degrees lat)
    const dist = haversineMeters(47.6062, -122.3321, 47.60621, -122.3321);
    expect(dist).toBeGreaterThan(0);
    expect(dist).toBeLessThan(2);
  });
});
