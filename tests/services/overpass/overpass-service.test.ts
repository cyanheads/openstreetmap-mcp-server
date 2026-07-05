/**
 * @fileoverview Tests for overpass-service retry classification and error handling.
 * @module tests/services/overpass/overpass-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { describe, expect, it } from 'vitest';
import { isTransientOverpassError, OverpassService } from '@/services/overpass/overpass-service.js';

describe('isTransientOverpassError', () => {
  describe('deterministic failures — should NOT retry (returns false)', () => {
    it('returns false for query_timeout reason', () => {
      const err = new McpError(JsonRpcErrorCode.Timeout, 'Overpass query timed out', {
        reason: 'query_timeout',
      });
      expect(isTransientOverpassError(err)).toBe(false);
    });

    it('returns false for result_too_large reason', () => {
      const err = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Overpass ran out of memory', {
        reason: 'result_too_large',
      });
      expect(isTransientOverpassError(err)).toBe(false);
    });

    it('returns false for HTTP 400 (fetchWithTimeout FetchHttpError — malformed query)', () => {
      // fetchWithTimeout throws InvalidParams with statusCode in data, no reason field
      const err = new McpError(JsonRpcErrorCode.InvalidParams, 'Fetch failed. Status: 400', {
        statusCode: 400,
        errorSource: 'FetchHttpError',
      });
      expect(isTransientOverpassError(err)).toBe(false);
    });
  });

  describe('transient failures — should retry (returns true)', () => {
    it('returns true for rate_limited reason', () => {
      const err = new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Overpass API returned HTTP 429',
        { reason: 'rate_limited' },
      );
      expect(isTransientOverpassError(err)).toBe(true);
    });

    it('returns true for ServiceUnavailable without a reason (generic 5xx)', () => {
      const err = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Overpass unavailable');
      expect(isTransientOverpassError(err)).toBe(true);
    });

    it('returns true for plain Error (network error, DNS failure, etc.)', () => {
      expect(isTransientOverpassError(new Error('ECONNREFUSED'))).toBe(true);
    });

    it('returns true for ValidationError with query_error reason (service-layer path)', () => {
      // If a ValidationError with reason 'query_error' reaches withRetry, withRetry's
      // own code check (ValidationError is not in TRANSIENT_CODES) stops the retry.
      // isTransientOverpassError doesn't need to exclude it.
      const err = new McpError(JsonRpcErrorCode.ValidationError, 'Malformed query', {
        reason: 'query_error',
      });
      expect(isTransientOverpassError(err)).toBe(true);
    });

    it('returns true for non-McpError values', () => {
      expect(isTransientOverpassError('string error')).toBe(true);
      expect(isTransientOverpassError(null)).toBe(true);
      expect(isTransientOverpassError(undefined)).toBe(true);
      expect(isTransientOverpassError(42)).toBe(true);
    });
  });
});

describe('OverpassService query builders', () => {
  // The builders trust already-validated input — resolveTagInput rejects Overpass QL
  // metacharacters upstream (see openstreetmap-tag-input) — so these assert the QL shape
  // for a normal tag rather than any in-builder sanitization. Constructor deps are unused.
  const service = new OverpassService({} as AppConfig, {} as StorageService);

  describe('buildAroundQuery', () => {
    it('builds around-filter QL for a normal tag across element types', () => {
      const ql = service.buildAroundQuery({
        lat: 47.6,
        lon: -122.3,
        radiusMeters: 1000,
        tagKey: 'amenity',
        tagValue: 'cafe',
        elementTypes: ['node', 'way'],
        timeoutSeconds: 25,
      });
      expect(ql).toBe(
        [
          '[out:json][timeout:25];',
          '(',
          '  node["amenity"="cafe"](around:1000,47.6,-122.3);',
          '  way["amenity"="cafe"](around:1000,47.6,-122.3);',
          ');',
          'out center tags;',
        ].join('\n'),
      );
    });
  });

  describe('buildBboxQuery', () => {
    it('builds bbox-filter QL in south,west,north,east order for a normal tag', () => {
      const ql = service.buildBboxQuery({
        south: 47.5,
        west: -122.5,
        north: 47.7,
        east: -122.2,
        tagKey: 'leisure',
        tagValue: 'park',
        elementTypes: ['node', 'way'],
        timeoutSeconds: 30,
      });
      expect(ql).toBe(
        [
          '[out:json][timeout:30];',
          '(',
          '  node["leisure"="park"](47.5,-122.5,47.7,-122.2);',
          '  way["leisure"="park"](47.5,-122.5,47.7,-122.2);',
          ');',
          'out center tags;',
        ].join('\n'),
      );
    });
  });
});
