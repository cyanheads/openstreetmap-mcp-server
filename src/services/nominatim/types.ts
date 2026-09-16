/**
 * @fileoverview Types for the Nominatim API responses and domain models.
 * @module services/nominatim/types
 */

/**
 * Raw Nominatim place result, exactly as jsonv2 puts it on the wire. Fields vary by
 * feature type, and every coordinate arrives as a decimal string padded to seven
 * decimal places (`"0.0000000"`, `"-180.0000000"`). The service parses those to
 * numbers at the response boundary, so this shape never leaves `nominatim-service`.
 */
export type RawNominatimPlace = {
  place_id: number;
  osm_type?: 'node' | 'way' | 'relation';
  osm_id?: number;
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  category?: string;
  type?: string;
  place_rank?: number;
  importance?: number;
  addresstype?: string;
  address?: Record<string, string>;
  boundingbox?: [string, string, string, string];
  extratags?: Record<string, string>;
};

/**
 * A Nominatim place with coordinates in WGS84 decimal degrees. The domain shape every
 * tool sees: `lat`, `lon` and `boundingbox` are numbers, so a value read off one tool's
 * result satisfies the numeric inputs of openstreetmap_query_nearby,
 * openstreetmap_query_bbox and openstreetmap_reverse_geocode without a conversion step.
 */
export type NominatimPlace = Omit<RawNominatimPlace, 'lat' | 'lon' | 'boundingbox'> & {
  lat: number;
  lon: number;
  boundingbox?: [number, number, number, number];
};

/**
 * What Nominatim serves with HTTP 200 when /reverse finds no OSM data at a coordinate:
 * an error string and none of the place fields. Only /reverse produces it — /search and
 * /lookup answer an empty array.
 */
export type NominatimErrorBody = { error: string };

/** Parameters for the Nominatim /search endpoint. */
export type NominatimSearchParams = {
  q?: string;
  street?: string;
  city?: string;
  county?: string;
  state?: string;
  country?: string;
  postalcode?: string;
  limit?: number;
  countrycodes?: string;
  layer?: string;
  featureType?: string;
  extratags?: boolean;
  language?: string;
  /** place_ids (or `<osm_type><osm_id>` refs) to drop from results — forwarded as `exclude_place_ids`. */
  excludePlaceIds?: string[];
  /**
   * Area to bias results toward, pre-joined as the two opposite corners Nominatim
   * takes, each written longitude then latitude: `<west>,<north>,<east>,<south>` is
   * the north-west and south-east pair. Bias only unless {@link bounded} is set.
   */
  viewbox?: string;
  /** Forwarded as `bounded=1`, turning {@link viewbox} into a hard filter. */
  bounded?: boolean;
};

/** Parameters for the Nominatim /reverse endpoint. */
export type NominatimReverseParams = {
  lat: number;
  lon: number;
  zoom?: number;
  layer?: string;
  extratags?: boolean;
  language?: string;
};

/** Parameters for the Nominatim /lookup endpoint. */
export type NominatimLookupParams = {
  osm_ids: string[];
  extratags?: boolean;
  language?: string;
};
