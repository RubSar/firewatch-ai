# Fuel index API v1 — experimental

Independent producer: `backend/api/fuel_service`. Consumer: the frontend map now calls `/v1/fire-investigation` through its
same-origin `/api` proxy. See `docs/fuel-index-ui.md` for the consumer handoff.
FastAPI's `/openapi.json` is the machine-readable request/response schema, generated
from API models rather than maintaining a second schema. A checked-in snapshot and
example request/response live in this directory. No LLM or custom inference model is used:
Dynamic World supplies model predictions; Sentinel-2 supplies reflectance data.

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
not a fire-wrapper result. Frontend integration is active: the map supplies the red
fire geometry to the new route and renders the returned wrapper, investigation area
and scored features. The input remains the original fire, not an already buffered region.

## Generic region request

`POST /v1/fuel-index` accepts `region` (GeoJSON Polygon or MultiPolygon geometry,
not Feature), `start_date`, `end_date` (UTC YYYY-MM-DD, inclusive start/exclusive end),
and `cell_size_m` (100–5000, default 5000). Send the frontend's study-area geometry
for the 28 km ring; the service will preserve holes and clip cells to it.
Coordinates are longitude, latitude, EPSG:4326; no extra altitude coordinate.
Limits: valid closed rings, no intersections, at most 5000 vertices, ±75° latitude,
±179° longitude, no date-line crossing, <=300 km bounding diagonal, <=25000 km²,
<=2048 intersecting cells, dates from 2017-03-28, <=31 days, no future observations.
The service uses a local UTM grid and ellipsoidal geographic area calculations.
Grid sizes describe projected metres; source analysis uses the same UTM CRS at 20 m.
Small boundary fragments may have no raster samples and remain unknown.

## Data processing

Filter Dynamic World V1 and harmonized Sentinel-2 SR to region and date window.
Join acquisitions by sensing timestamp and MGRS tile (not processing timestamp).
Use only matched pairs: there is no fallback to an older/outside-window image.
Sentinel-2 B8 is area-averaged to B11's 20 m native grid; NDMI=(B8-B11)/(B8+B11).
Mask zero denominators and SCL 0,1,3,7,8,9,10,11, retain only SCL 4,5,6.
Dynamic World comes with its cloud/shadow mask; additionally mask top-class
probability <0.6, then area-average its nine probabilities to that same grid.
Both sources share a common mask before temporal averaging and cell reduction.
Probability means describe model evidence, NOT measured class area fractions.
NDMI for scoring is weighted by vegetated-class probability, excluding most
water/rock influence. Return common valid coverage and mean paired observation count.
Source metadata lists candidate matched assets and UTC acquisition times within the
region/window; it does not claim every asset contributes to every cell.

## Scoring policy `dw-ndmi-experimental-v1`

Vegetation evidence V = sum of trees, grass, flooded_vegetation, crops,
shrub_and_scrub probabilities. No arbitrary forest-versus-grass severity ordering.
D = clamp((0.4 - vegetation_weighted_NDMI) / 0.6, 0, 1).
Score = round(100 * V * D, 1). D is a heuristic relative dryness proxy, not measured
fuel moisture. The -0.2/0.4 NDMI anchors are explicit unvalidated demo assumptions.
This is not the official Burning Index, FWI, fire probability or spread forecast.

Coverage <0.7 -> null score (`insufficient_coverage`). No pixels -> `no_data`.
Mean built probability >=0.2 -> `unsupported_built_area` (not zero).
V <=0.05 and bare+water+snow probability >=0.9 -> zero (`non_vegetated`).
Otherwise missing vegetation NDMI -> null (`missing_moisture`). Cells with valid
NDMI -> `scored`. Low vegetation support outside the zero rule remains unknown.
Unknown values are never filled with zero. Scores are for observed portions only;
coverage is separate from classification probability and is not called confidence.

## Response and errors

GeoJSON FeatureCollection plus schema_version, generated_at (UTC computation time),
requested window, analysis resolution, grid CRS, model policy, source provenance,
limitations and summary. Each feature includes cell_id, area_m2, score/status,
landcover_probabilities (null if unavailable), vegetation_probability, NDMI,
dryness_proxy, valid_coverage, observation_count_mean. Score/NDMI missing -> null.
Summary mean score weights scored cells by valid observed area; unscored area is
reported separately and not treated as zero. All-empty collections return explicit
unknown features, not a fabricated successful score.

`GET /healthz`: process liveness, configuration and successful-initialization indicator
(`credentials_verified`). It does not trigger an auth check or dataset query.
`GET /v1/method`: complete formula and limitations. `/docs`: interactive API docs.
400 invalid request shape/geometry/dates (422 for Pydantic schema violations),
413 cell/area workload limit, 401 invalid/missing configured token, 429 busy,
503 Earth Engine unconfigured/auth initialization failure, 502 upstream query failure.
Responses use `detail: {code,message}` for application errors; 422 uses FastAPI's
standard validation details. No synthetic data fallback. One live request at a time.
