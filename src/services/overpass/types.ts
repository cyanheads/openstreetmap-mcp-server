/**
 * @fileoverview Types for the Overpass API responses and domain models.
 * @module services/overpass/types
 */

/** The OSM element types that carry geometry and become POIs. */
export type OverpassPoiType = 'node' | 'way' | 'relation';

/**
 * A single element from an Overpass query response.
 *
 * `area`, `count`, and `scope` are not OSM features. Overpass emits an `area` element for an
 * area set printed with `out ids;` — for a relation-derived area; a way-derived one prints as
 * `type: 'way'` carrying the underlying way's own id — a `count` element for any set
 * printed with `out count;`, and an element of whatever type a `convert` names. The `within`
 * scope on openstreetmap_query_bbox prints a `count` as its boundary-resolution sentinel and
 * a `scope` carrying the boundary's own tags (#117), and a raw query can produce any of them,
 * so all three are members of the union rather than casts at the one place that reads them.
 */
export type OverpassElement = {
  type: OverpassPoiType | 'area' | 'count' | 'scope';
  id: number;
  lat?: number;
  lon?: number;
  center?: OverpassLatLon;
  tags?: Record<string, string>;
  nodes?: number[];
  members?: unknown[];
  /**
   * A way's vertices under an `out … geom` print, in way order. A way print clipped to a box
   * (`geom(s,w,n,e)`) keeps both ends of every segment that touches the box and writes
   * `null` for every other vertex, so two adjacent points are always a real segment.
   */
  geometry?: (OverpassLatLon | null)[];
  /**
   * Meters from an around query's point to the element's nearest point, 0 inside an area —
   * or to a way's or relation's center on a result marked `rankedByCenter`. Never sent by
   * Overpass: `OverpassService.query` sets it when asked to rank (#103).
   */
  distanceMeters?: number;
};

/** A WGS84 coordinate as Overpass prints it. */
export type OverpassLatLon = { lat: number; lon: number };

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
   * Endpoint that served this response, named by origin alone through
   * `endpointLabel` — never the path or query a provider's key rides in. Absent
   * for a cache entry written before attribution shipped.
   */
  servedBy?: string;
  /**
   * Set on a ranked around result whose ways and relations were measured to their
   * bounding-box center: the response carrying their geometry passed the read ceiling, so
   * the center-only query answered instead.
   */
  rankedByCenter?: true;
  /**
   * Set on an around result answered without the containment arm (#113): an endpoint refused
   * the arm's area lookup, so only areas whose outline lies inside the radius were matched.
   */
  containmentUnchecked?: true;
};

/**
 * The point an around query is ranked from (#103), the center-only query its geometry read
 * falls back to when that response passes the read ceiling, and the same two queries without
 * the containment arm (#113), which answer when an endpoint refuses the arm's area lookup.
 */
export type OverpassRankFrom = OverpassLatLon & {
  centerQuery?: string;
  uncontained?: { query: string; centerQuery?: string };
};

/** A normalized POI element for convenience tool output. */
export type OverpassPoi = {
  osm_type: OverpassPoiType;
  osm_id: number;
  lat?: number;
  lon?: number;
  /** Unrounded {@link OverpassElement.distanceMeters}, present only on a ranked result. */
  distance_meters?: number;
  name?: string;
  tags: Record<string, string>;
};

/**
 * A literal OSM tag filter; an omitted value requires only the key's existence.
 *
 * `match: 'list_item'` matches the value as one item of a semicolon list
 * (`cuisine=pizza;italian`) instead of the whole value. Absent means exact equality, and
 * the resolver never sets `'exact'`, so an exact filter is the same object — and emits the
 * same tag clause — as one written before list-item matching existed.
 */
export type OverpassTagFilter = {
  tagKey: string;
  tagValue?: string | undefined;
  match?: 'list_item' | undefined;
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

/** The boundary's own tags a `within` query reads off the area it scoped to (#117). */
export type OverpassBoundaryTags = Partial<Record<'name' | 'boundary' | 'admin_level', string>>;

/** A `within`-scoped response split into its boundary sentinel, the boundary, and its matches. */
export type OverpassAreaScope = {
  /** False when the ref mapped to no area at all — not the same as matching nothing. */
  resolved: boolean;
  /**
   * Those of the three tags the boundary carries; empty for a boundary carrying none of them
   * and for a ref that mapped to no area.
   */
  boundary: OverpassBoundaryTags;
  /** The matching features, with the `out count;` sentinel and the `scope` print removed. */
  elements: OverpassElement[];
};
