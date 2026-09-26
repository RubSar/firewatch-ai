# Landscape analysis v2

Producer: frontend/visualization/analysis.js (browser RGB screening); consumer: frontend/src/main.js. No backend or LLM is connected.

Breaking change from v1: rectangular selection/buffer replaced by polygon fire and a fixed 28 km study ring. Consumers must migrate `selected` → `interest`, `nearby` → `fire`; the primary score now describes the study ring. The example fixture is a reproducible geometry-only v2 result for a synthetic fire.

- schema_version: "2.0"; analysis_kind: "rgb_color_screening" or "geometry_only" before sampling.
- geometry: fire, outer, interest (GeoJSON Features); buffer_m: 28000; bounds: outer bounding box; areas_km2: {fire,outer,interest}; method: calculation description. Interest = outer minus fire, so its holes must be retained when rendering.
- GeoJSON uses [longitude, latitude] in EPSG:4326 degrees. Bounds order: [west,south,east,north]. Fire input is a non-self-intersecting Polygon, minimum 0.005 km², diagonal at most 300 km, within ±75° latitude and ±179° longitude. No antimeridian or polar support. Drawing produces one exterior ring; multipolygons/import are not yet exposed.
- Coordinates are locally projected by Turf into a spherical azimuthal-equidistant projection. JSTS offsets by 28 km with 64 segments per quadrant. Difference subtracts the fire; Turf computes spherical surface areas. Regional numerical approximation, not exact ellipsoidal geodesy. Spherical versus ellipsoidal ground distances can differ by about 0.5%; do not use survey precision claims.
- bounds: outer bounding box; buffer_m: 28000; area_km2: study ring area.
- generated_at: ISO 8601 UTC analysis time, not imagery acquisition time.
- interest and fire: disjoint sample counts {green,tan,dark,other,total,green_pct}; green_pct is null if no samples. Missing fire samples must not appear as zero. No interest samples fails the analysis.
- source: name, URL, acquired_at (null if unavailable), tile_zoom, tiles_requested, tile_urls.
- method: id, sample_stride_px, description. Fuel index and moisture remain null.
- grid: {lat,lon,category,zone}; zone is interest or fire. Export omits grid and includes sample_count. Geometry-only export contains no color estimates.

Images are clipped to the actual polygons, not their bounding boxes. Sampling every eighth pixel is a coarse regional overview, not a dry-tree detector. Tile zoom lowers until at most 48 tiles are requested; requests run in batches of four. Errors or cancellation never yield partial success. Selection changes invalidate prior results.
