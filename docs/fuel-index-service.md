# Fuel index service: implementation and integration

## Scope / coordination

Task: create an independent Dynamic World + Sentinel-2 NDMI scoring API.
Changes: `backend/api/` Python project/service/tests/lockfile; `contracts/` additive
fuel-index API, schema snapshot and examples; this document. Existing frontend and
its RGB contract are preserved. No API/LLM component owners or Git remote are
configured; no remote PR conflict review was possible. Branch: codex/fuel-index-service.

No LLM integration is needed: Dynamic World is an existing prediction dataset;
Sentinel-2 analysis and scoring are deterministic. Provider and application code
therefore belong in backend/api/, not backend/llm/.

## Architecture

Externally supplied fire geometry -> API validation -> 28 km wrapper minus fire ->
regional UTM grid -> Earth Engine
matched acquisitions -> common-support 20 m composites -> cell evidence -> versioned
score -> GeoJSON FeatureCollection.

- `models.py`: input/output validation; generates `/openapi.json`.
- `spatial.py`: local UTM grid, exact polygon clipping in projection, WGS84 area,
  extent/workload limits, Polygon/MultiPolygon and holes.
- `provider.py`: lazy EE initialization, matched acquisition join, cloud masking,
  native-grid NDMI, common-mask composites, area-weighted reductions and provenance.
- `scoring.py`: pure score function, quality gates, versioned parameters.
- `app.py`: endpoints, optional bearer token, explicit CORS, concurrency gate and errors.

The grid is anchored to UTM easting/northing multiples of cell_size_m. Its identifiers
are stable for the same grid CRS/size, but a different region can choose another UTM
zone. Always keep grid CRS AND cell size with IDs. Ground lengths/areas are subject
to normal projection/raster discretization, and cells at polygon edges are clipped.
Use an equal-area or geodesic method when displaying combined geographic areas.

## Method details

DW top1 >=0.6 is a per-observation reliability filter. S2 SCL retains classes 4,5,6;
cloud/shadow/snow/unclassified pixels are masked. Both sources must be present at
the same sensing timestamp and MGRS tile. This is stricter than independent temporal
composites; missing pairs produce unknowns. A region/date window may still have no
paired usable observations despite each source being available independently.

B8 10 m reflectance is averaged to the B11 20 m projection before NDMI. The common
0.0001 reflectance scale cancels in the ratio. DW probabilities are likewise averaged
to this grid. Each pair is reprojected to the output UTM analysis grid at 20 m before
temporal means. Reprojection does not turn 20 m SWIR into 10 m detail.

For each pixel: V=sum(vegetated probabilities). Composite mean(V*NDMI) and mean(V)
are separately area-integrated; their ratio is the vegetation-weighted NDMI. This
reduces influence from largely nonvegetated surfaces without calling the result
measured fuel moisture. The score uses only common-valid coverage. Pixel-area
weights provide common numerator/denominator support; coverage's denominator spans
the entire clipped cell, including regions outside all scene footprints.

Score and thresholds: see `/v1/method` and `contracts/fuel-index.md`. These are
explicit experimental assumptions, not calibrated scientific risk coefficients.
There is no deadwood, fuel load, weather, slope, or spread prediction in v1.

## Frontend handoff

Call through an API gateway/backend when using a service token. Supply
`fire` using the red fire geometry to `/v1/fire-investigation`. The backend returns
the wrapper and investigation geometry; render those to match the scored region. Render response
features by score, with null-score cells gray. On click, show status, valid_coverage,
vegetation_probability, NDMI and source window. A mean probability is not a measured
area percentage. Keep score separate from evidence quality. No frontend call has
been added in this task; the existing Analyze button still performs RGB screening.

## Verification boundaries

Tests live beside this component under `backend/api/tests/`. Contract examples are
under contracts/examples. Offline test provider exists only in tests, never as a
runtime fallback. The SDK's API-signature fixtures validate graph construction,
not Earth Engine computation. Live end-to-end execution requires server credentials
and the registered project; follow backend/api/README.md.

Project check on 2026-09-26: Cloud Console showed my-project-1487573210777 registered
for noncommercial use on Community Tier, eligibility through 2028-03-26. No local
Earth Engine user credentials, Google ADC file, or ADC environment path existed.
Registration alone does not prove API authentication or successful dataset queries.

## Primary references

- https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1
- https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED
- https://www.usgs.gov/landsat-missions/normalized-difference-moisture-index
- https://developers.google.com/earth-engine/guides/auth

## Checks performed for this implementation

- 24 offline tests passed, including generated OpenAPI and response fixture checks.
- Ruff checks passed. TestClient emits an upstream Starlette/httpx deprecation warning.
- Started the actual service at 127.0.0.1:8001 with the supplied project ID.
- HTTP /healthz returned 200 and configured=true, credentials_verified=false.
- HTTP POST /v1/fuel-index returned the expected structured 503 earth_engine_auth_failed
  because no local credentials exist. Live asset access and satellite results have
  NOT been verified. This is the remaining integration gate after user authentication.
- No frontend changes, credentials, cloud registration changes, commits, or PRs were made.

## Live verification after local authentication (2026-09-26)

Supersedes the earlier authentication block: user completed local Google auth.
Earth Engine initialization and real dataset queries now succeed. The initial Sierra
request hit the per-region pixel guard (reported 134330 versus the original 100000).
Raised that guard to 2000000 while retaining 20 m analysis resolution and all
region/cell/acquisition limits. A successful Sierra provider query matched 8 pairs;
all 9 cells remained unscored because common valid coverage was below 70%.

The running HTTP service was then tested with the Hoh forest example in
`contracts/examples/fuel-index-request-forest.json` (2025-07-01 to 2025-08-01).
HTTP 200: 12 acquisition pairs, 4 clipped grid cells, 3 scored cells and 1 unknown
for insufficient coverage. The example covers ~0.832 km². The observed-area-weighted
experimental score was 0.5; this is NOT a calibrated real-world danger estimate.
The full validated live response is `fuel-index-response.forest.live.json`, with
synthetic=false, source IDs, acquisition timestamps and per-cell evidence.

Health now reports credentials_verified=true after successful initialization;
reading health itself does not contact Google. Added regression coverage for the
initialization-status transition. All 25 tests and Ruff checks passed. No frontend
integration was added, and credential values were not read into output or stored in
this repository.

## Fire-wrapper service alignment (2026-09-26)

## Fire investigation workflow

`POST /v1/fire-investigation` is the primary fire workflow. Send `fire` as a
GeoJSON Polygon/MultiPolygon geometry in longitude, latitude (EPSG:4326), plus
`start_date`, `end_date` and `cell_size_m` (default 5000). See
`contracts/examples/fire-investigation-request.json` from the repository root.

1. Validate the externally supplied fire perimeter. This service does not detect fire.
2. Buffer it outward by 28000 metres in a local WGS84 azimuthal-equidistant projection.
3. Subtract the supplied fire: **investigation area = wrapper − fire**.
4. Clip the UTM grid to that investigation area and query/score those cells only.

The response adds `investigation` with `fire`, `wrapper`, `investigation_area`,
`buffer_m`, `buffer_crs`, `buffer_method`, and geodesic `areas_m2` for all three.
Top-level `features` and `summary` describe only the investigation area. Cells
crossing the fire boundary contain only their outside portion; missing imagery
still yields null scores. The wrapper includes the fire; the investigation area does not.

A distance buffer rounds corners and can close narrow gaps or merge nearby parts;
it is not an enlarged geometrically similar copy. Holes in the supplied fire are
considered outside the fire and are included only where within the buffer distance.
The metric buffer uses 64 segments per quadrant and densified edges. It approximates
regional ground distance; it is not an exact global geodesic offset. A 50 km-radius
circle gives approximately 78 km outer radius. Existing extent, vertex and cell
limits apply to both the fire and the generated region; overly complex/large
wrappers fail explicitly (400/413) rather than silently simplifying the fire.

“Not burned” here means outside the supplied perimeter, not independently verified
unburned land. Use an appropriate imagery date window: the service does not infer
incident time or automatically exclude older burns. This is an experimental fuel
and dryness score, not a spread forecast or probability of ignition.

The generic `POST /v1/fuel-index` endpoint remains available for an already prepared
`region`; it adds no buffer. The existing forest live JSON is a generic-region run,
not a fire-wrapper result. Frontend integration is still pending: supply the red
fire geometry to the new route and render the returned wrapper, investigation area
and scored features rather than sending the frontend's already buffered region.

Verification: 30 offline tests passed, including the 50 km circle, concave fire
with a hole, merging nearby fire parts, provider-input and cell exclusion, area
conservation, and route auth. Ruff checks passed.
The earlier live forest response remains unchanged. Frontend integration is a
separate outstanding task. Changes span backend/api, contracts, and docs.

Live verification of the new route: HTTP 200 using the example fire and July 2025
imagery, 31 matched acquisition pairs, 125 ring cells, 111 scored and 14 withheld.
Fire area: 0.832063 km²; investigation area: 2566.929241 km²; wrapper area:
2567.761304 km². Returned cell area sum differs from the ring by ~4.35 m² due to
projection/clipping discretization. Verified no cell overlaps the supplied fire.
Saved the real response in `contracts/examples/fire-investigation-response.live.json`;
provenance.synthetic=false refers to real satellite evidence. The input fire is a
hypothetical demonstration perimeter, not an independently verified fire incident.
The updated local service is running on port 8001. Frontend remains unconnected.
