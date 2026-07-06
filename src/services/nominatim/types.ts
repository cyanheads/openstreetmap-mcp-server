/**
 * @fileoverview Types for the Nominatim API responses and domain models.
 * @module services/nominatim/types
 */

/** Raw Nominatim place result (jsonv2 format). Fields vary by feature type. */
export type NominatimPlace = {
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
  error?: string;
};

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
