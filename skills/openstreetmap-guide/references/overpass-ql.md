# Overpass QL

Use `openstreetmap_query_raw` when the convenience tools cannot express the selection or output. Examples below are QL text; JSON tool arguments require the usual additional string escaping.

## Selection and scope

- Include `[out:json]`. End statements with semicolons.
- Adjacent tag filters are ANDed: `["amenity"="restaurant"]["name"]` requires both equality and key existence. A parenthesized group of statements forms a union.
- Exact equality compares the whole tag value. `["cuisine"~"(^|;) *pizza *(;|$)"]` matches a pizza item in a semicolon list, including `pizza;italian`, without matching `pizzeria`.
- Around scope is `(around:radius_meters,lat,lon)`. Bbox scope is `(south,west,north,east)`. Nominatim's returned bbox tuple is **south,north,west,east**; reorder it explicitly.
- For a boundary, resolve its OSM reference first, then use `rel(ID);map_to_area->.a;` or `way(ID);map_to_area->.a;` and apply `(area.a)` to each selection. A ref without an Overpass area cannot establish the scope. Do not construct a way-area ID by adding 2400000000; that mapping was removed in Overpass 0.7.57.
- Tag regexes are POSIX ERE. QL unescapes the quoted string before compiling the regex: write `\\.` in QL for a literal period, then escape those backslashes again when encoding a JSON argument.

## Output and completeness

`out center tags` returns tags and representative coordinates, including bounding-box centers for ways and relations. These centers are not centroids or boundary geometry. Use `out geom` when the task needs full geometry; use an appropriate body/skeleton output when it needs node references or relation members. Check the raw response for withheld-array retrieval instructions before treating an element as whole.

The tool's page limit is applied after Overpass executes the query. Follow the returned pagination rather than adding an `out` limit and interpreting that limited upstream set as a full survey.

## Boundary-scoped union

After resolving the intended boundary, substitute its relation ID for `RELATION_ID`. This selects both mapped pharmacies and pharmacy shops, including relation features:

```overpass
[out:json][timeout:25];
rel(RELATION_ID);map_to_area->.a;
(
  nwr["amenity"="pharmacy"](area.a);
  nwr["shop"="pharmacy"](area.a);
);
out center tags;
```

For a closed-way boundary, replace the `rel` statement with `way(WAY_ID)`; do not retain the W prefix inside QL.

## Named restaurants serving pizza

This is a bbox query, using S,W,N,E order. The adjacent filters require a restaurant, a name, and a pizza item in its cuisine list:

```overpass
[out:json][timeout:25];
nwr["amenity"="restaurant"]["name"]["cuisine"~"(^|;) *pizza *(;|$)"](47.60,-122.35,47.62,-122.32);
out center tags;
```
