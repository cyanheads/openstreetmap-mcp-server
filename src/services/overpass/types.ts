/**
 * @fileoverview Types for the Overpass API responses and domain models.
 * @module services/overpass/types
 */

/** A single element from an Overpass query response. */
export type OverpassElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  nodes?: number[];
  members?: unknown[];
};

/** Parsed Overpass API response. */
export type OverpassResponse = {
  version: number;
  osm3s?: {
    timestamp_osm_base?: string;
    timestamp_areas_base?: string;
    copyright?: string;
  };
  elements: OverpassElement[];
};

/**
 * An Overpass response plus the endpoint that served it. Cached as one value so a
 * cache hit stays attributable to the endpoint that produced the data rather than
 * to whichever endpoint the reading call would have tried first.
 */
export type OverpassResult = OverpassResponse & {
  /**
   * Endpoint that served this response, redacted to origin + path. Absent for a
   * cache entry written before attribution shipped.
   */
  servedBy?: string;
};

/** A normalized POI element for convenience tool output. */
export type OverpassPoi = {
  osm_type: 'node' | 'way' | 'relation';
  osm_id: number;
  lat?: number;
  lon?: number;
  name?: string;
  tags: Record<string, string>;
};

/** Parameters for the around-radius query builder. */
export type OverpassAroundParams = {
  lat: number;
  lon: number;
  radiusMeters: number;
  tagKey: string;
  tagValue: string;
  elementTypes: ('node' | 'way' | 'relation')[];
  timeoutSeconds: number;
};

/** Parameters for the bounding box query builder. */
export type OverpassBboxParams = {
  south: number;
  west: number;
  north: number;
  east: number;
  tagKey: string;
  tagValue: string;
  elementTypes: ('node' | 'way' | 'relation')[];
  timeoutSeconds: number;
};
