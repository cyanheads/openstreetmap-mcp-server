---
name: openstreetmap-guide
description: Use openstreetmap_* tools for OSM feature surveys, boundary-scoped searches, tag-based discovery, or Overpass QL. Resolve object references and check scope, coverage, and pagination before drawing absence or completeness conclusions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.2"
---

## Scope

Use OpenStreetMap to resolve locations and investigate mapped features. Nominatim ranks place/address matches; Overpass selects features by tags and geography. A survey describes mapped objects matching the query, not a complete inventory of real-world facilities.

## Identifiers

- Geocoding tools return `osm_type` and `osm_id` when available. Combine them as N + node ID, W + way ID, or R + relation ID (`N240109189`) for `openstreetmap_lookup_objects`, which also reads `node/240109189` and the openstreetmap.org URL; `within` takes the same forms for ways and relations. One malformed entry fails the whole lookup, and no OSM id exceeds 9223372036854775807. Raw Overpass elements use `type` and `id` for the same identity.
- Nominatim `place_id` is internal to its instance; never use it as an OSM object ID or carry it between deployments.
- Boundary references come from the selected object's OSM identity. Only a relation or closed way can supply area scope; a node cannot. A W/R prefix alone does not establish that Overpass has an area for the object.

## Gates

1. **Establish the intended scope.** Inspect the resolved name, address, and object type before using its coordinates or boundary. Reverse geocoding selects a nearby indexed object; it does not establish which polygon contains the point. A place's bounding box can extend beyond its boundary polygon.
2. **Select tag-bearing objects before interpreting attributes.** Nominatim can resolve a same-name object different from the one carrying the desired tags. An absent attribute in returned `extratags` describes that object, not all of OpenStreetMap. Discover by attribute with Overpass, then enrich those exact IDs if addresses are needed. A tag missing from a feature under `tag_keys` says nothing about OpenStreetMap: the page was cut to the listed keys, and `effectiveTagKeys` names them.
3. **Check the filter's meaning.** `amenity` is one OSM key, not a generic category. Museums use `tourism=museum`, parks `leisure=park`, and supermarkets `shop=supermarket`. Read a category warning before concluding that a sparse result reflects sparse mapping. Tags match exactly, and primary feature values are lowercase with underscores (`amenity=fast_food`, not `Fast Food`), so read a spelling hint in `notice` before concluding a zero means no features; free-text keys such as `name` and `brand` are case-sensitive and never draw the hint. Exact equality differs from membership in a semicolon list such as `cuisine=pizza;italian`.
4. **Check coverage before claiming absence.** An empty boundary query can mean the ref mapped to no Overpass area; read its notice. An endpoint can serve only a regional extract and return an empty success outside it. Check the serving endpoint and reported freshness when results are unexpectedly empty or stale; if coverage is unknown, qualify the conclusion. An omitted timestamp supplies no evidence of freshness.
5. **Finish retrieval before calling the query complete.** Convenience tools search nodes, ways, and relations by default; an `element_types` without `relation` also leaves out the large parks, lakes, and boundaries mapped as relations. Follow `nextOffset` while more results remain, keeping the query unchanged. `openstreetmap_query_bbox` pages arrive nodes, then ways, then relations, each by ascending id, so a first page is no likelier than any other to hold the best or largest feature; to find the highest or most populous, pass `sort_by` and read `unrankedCount`, since values with units, ranges, or lists and features without the tag follow the ranked ones. Resolve deferred lookup IDs on subsequent calls. For raw results with withheld arrays, follow the returned retrieval recipe before analyzing geometry or relation membership.
6. **Distinguish a lookup miss from a missing OSM object.** `not_found` means no Nominatim record. Use the raw existence query in the response notice when existence matters, and apply the same coverage/freshness checks before interpreting its result.

## Core chain

For a named-region survey:

1. Resolve the region with `openstreetmap_search_places` and select the intended boundary object.
2. Use its W/R reference with `openstreetmap_query_bbox` to survey the polygon. Check that `effectiveArea` names the intended boundary — a mistyped ref resolves to another one — and inspect any area-resolution notice before interpreting the match set.
3. Retrieve remaining pages. Pass discovered object references to `openstreetmap_lookup_objects` only when Nominatim address details add information the task needs.

If the geocoder returned only a point, do not invent a boundary ID or silently substitute a radius for an administrative area. Resolve the boundary separately, or state that the chosen scope is a radius or bounding box.

## Workflows

**Near an address.** Resolve the address, then use `openstreetmap_query_nearby` around that point. Its feature distances are not travel distances. Nodes use their own coordinates; way/relation output coordinates are bounding-box centers. An area containing the point, such as the park or city it lies in, reads 0 m whatever the radius. Read a center-distance warning before treating the ranking as distance to the feature itself, and a notice that areas containing the point were not checked before concluding the point lies in no such area: that endpoint lists one only where its outline falls within the radius.

**Investigate a named feature's attributes.** Resolve the location to constrain the search, then use Overpass to find objects carrying the requested tag. Compare their names and identities before associating a tag-bearing path, building, or relation with the named place. Do not post-filter Nominatim's top matches and call an empty result evidence of no tagged feature.

**Queries beyond the convenience tools.** Use `openstreetmap_query_raw` for unions, regex, relation membership, history, or geometry. Read the [Overpass QL reference](references/overpass-ql.md) before composing these queries; it covers boundary mapping, coordinate order, list matching, and output modes. A `[date:]`, `[diff:]`, or `[adiff:]` query needs an endpoint holding attic data, and `out meta` needs metadata; overpass-api.de holds both, and a `query_unsupported` error means no configured endpoint does.

## References

- [Overpass QL](references/overpass-ql.md): syntax and examples for raw queries.
