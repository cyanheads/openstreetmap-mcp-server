/**
 * @fileoverview Types for the Overpass API responses and domain models.
 * @module services/overpass/types
 */

/** The OSM element types that carry geometry and become POIs. */
export type OverpassPoiType = 'node' | 'way' | 'relation';

/**
 * A single element from an Overpass query response.
 *
 * `area` and `count` are not OSM features. Overpass emits an `area` element for an area
 * set printed with `out ids;` — for a relation-derived area; a way-derived one prints as
 * `type: 'way'` carrying the underlying way's own id — and a `count` element for any set
 * printed with `out count;`. The `within` scope on openstreetmap_query_bbox uses the
 * latter as its boundary-resolution sentinel, and a raw query can produce either, so both
 * are members of the union rather than casts at the one place that reads them.
 */
export type OverpassElement = {
  type: OverpassPoiType | 'area' | 'count';
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
  osm_type: OverpassPoiType;
  osm_id: number;
  lat?: number;
  lon?: number;
  name?: string;
  tags: Record<string, string>;
};

/** A literal OSM tag filter; an omitted value requires only the key's existence. */
export type OverpassTagFilter = {
  tagKey: string;
  tagValue?: string | undefined;
};

/** What every convenience-tool query builder takes besides its own spatial filter. */
export type OverpassQueryParams = OverpassTagFilter & {
  filters?: OverpassTagFilter[] | undefined;
  elementTypes: OverpassPoiType[];
  timeoutSeconds: number;
};

/** Parameters for the around-radius query builder. */
export type OverpassAroundParams = OverpassQueryParams & {
  lat: number;
  lon: number;
  radiusMeters: number;
};

/** Parameters for the bounding box query builder. */
export type OverpassBboxParams = OverpassQueryParams & {
  south: number;
  west: number;
  north: number;
  east: number;
};

/**
 * An OSM boundary to scope a search to, as one element Overpass maps to an area.
 *
 * Held as the element rather than a computed area id: the relation formula
 * (`3600000000 + id`) is stable, but the way formula (`2400000000 + id`) was removed in
 * Overpass 0.7.57 and now resolves to nothing, so `map_to_area` is the one spelling that
 * works for both and carries no constant.
 */
export type OverpassAreaRef = {
  kind: 'relation' | 'way';
  osmId: number;
};

/** Parameters for the boundary-area query builder. */
export type OverpassAreaParams = OverpassQueryParams & {
  areaRef: OverpassAreaRef;
};

/** A `within`-scoped response split into its boundary sentinel and its matches. */
export type OverpassAreaScope = {
  /** False when the ref mapped to no area at all — not the same as matching nothing. */
  resolved: boolean;
  /** The matching features, with the `out count;` sentinel removed. */
  elements: OverpassElement[];
};
