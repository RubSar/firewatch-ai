# FireWatch Fuel Index Service

Standalone FastAPI service: **Dynamic World + Sentinel-2 NDMI + an experimental
relative fuel score**. Produces geographic cells as GeoJSON. The frontend map calls the fire-investigation endpoint through a local API proxy. No VLM or trained risk model runs here.

## Install and run

Python 3.11+ and [uv](https://docs.astral.sh/uv/) are required. From this directory:

```sh
uv sync --frozen
uv run uvicorn fuel_service.app:app --host 127.0.0.1 --port 8001
```

Open http://127.0.0.1:8001/docs for interactive request/response documentation.
Without Earth Engine configuration, health/method/docs work; analysis returns an
explicit 503. There is no fixture mode in the running service.

## Connect Earth Engine

The project supplied in this chat is `my-project-1487573210777`. Its Cloud Console
showed noncommercial Community Tier registration on 2026-09-26. Registration is
separate from local backend credentials. No private keys belong in this repository.

For local development, run authentication yourself and approve Google's login flow:

```sh
uv run earthengine authenticate --auth_mode=localhost
export FIREWATCH_EE_PROJECT=my-project-1487573210777
uv run uvicorn fuel_service.app:app --host 127.0.0.1 --port 8001
```

This stores Earth Engine credentials in the user's configuration directory outside
this repo. Unattended deployments can use Google Application Default Credentials
(e.g. an attached service account); register the project, enable Earth Engine API,
and grant only the required Earth Engine and service usage permissions. The provider
uses `ee.Initialize(project=...)`; it never accepts credentials through the API.
See [official authentication](https://developers.google.com/earth-engine/guides/auth)
and [service-account guidance](https://developers.google.com/earth-engine/guides/service_account).

Variables are listed in `.env.example`; this service does not automatically load a
`.env` file. Export variables into the process environment and restart the server.

## Fire investigation request

From the repository root:

```sh
curl --fail-with-body http://127.0.0.1:8001/v1/fire-investigation \
  -H 'Content-Type: application/json' \
  --data-binary @contracts/examples/fire-investigation-request.json
```

Send `fire` as a GeoJSON Polygon/MultiPolygon geometry. The service creates a 28 km
wrapper, subtracts the supplied fire, then scores only the investigation ring.
The response includes all three geometries in `investigation`; `features` and
`summary` cover only the ring. Use 5000 m cells initially for this larger area.
See the [contract](../../contracts/fuel-index.md) for geometry approximations and limits.
The example polygon is a demonstration input, not a verified historical fire.

For arbitrary regions, `POST /v1/fuel-index` still accepts `region` and adds no buffer.
Both routes take a UTC date window of 1–31 days and cell_size_m 100–5000 (default 5000).

Routes: GET `/healthz`, GET `/v1/method`, POST `/v1/fire-investigation`,
POST `/v1/fuel-index`, GET `/openapi.json`.
Health does not trigger authentication. `credentials_verified` becomes true after
Earth Engine initializes successfully in the running process; it does not promise
that every subsequent dataset query will succeed.

## Scoring and provenance

See [contract](../../contracts/fuel-index.md) and [design](../../docs/fuel-index-service.md).
Unknown or insufficiently covered cells receive null scores. Built areas are unsupported,
not treated as fuel-free. Probability vectors, vegetation-weighted NDMI, observation
counts, raster coverage, imagery IDs/dates, and formula version accompany the output.

NDMI anchors (-0.2 dry, +0.4 wet) and thresholds are unvalidated prototype assumptions.
The number is NOT a probability, official Burning Index, or predicted spread rate.

## Limits and deployment

Synchronous local prototype; one analysis at a time per process, up to 2048 cells,
256 paired acquisitions, 25000 km², 300 km diagonal and 5000 vertices. Provider calls
have a 120-second deadline each, configurable using FIREWATCH_EE_TIMEOUT_SECONDS;
a full request makes metadata and reduction calls and can exceed 120 seconds total.
Errors do not silently fall back to old imagery or fake data.

Bind to loopback for development. Before exposing it beyond localhost, configure
FIREWATCH_API_TOKEN and a TLS gateway with request-size limits and rate limiting.
For browser integration, allow specific origins through FIREWATCH_CORS_ORIGINS;
no wildcard CORS is enabled. Keep a deployment token in your server/API gateway,
not in a public browser bundle. Multiple workers require a shared job queue to
coordinate Earth Engine load; this prototype uses one worker.

## Verify

```sh
uv run pytest -q
uv run ruff check fuel_service tests
```

Tests exercise scoring, unknown semantics, spatial clipping/holes, API validation and
auth, and Earth Engine graph serialization using the SDK's bundled API signatures.
They do NOT establish satellite classification accuracy or prove live EE execution.
Synthetic contract response is visibly labeled with provenance.synthetic=true.
The generated `contracts/fuel-index.openapi.json` snapshot is checked against runtime
OpenAPI in the contract test; update it whenever API models change.

## Verified live example

After local authentication, the forest example returned HTTP 200 with 12 matched
acquisitions, 3 scored cells and 1 cell withheld for insufficient coverage.
`contracts/examples/fuel-index-request-forest.json` and
`contracts/examples/fuel-index-response.forest.live.json` record that run.
The existing synthetic fixture remains explicitly synthetic for offline tests.
The provider pixel guard is 2000000 per region; 20 m analysis resolution and the
other request limits remain unchanged.

The new fire workflow was also verified live: the demonstration fire produced
125 investigation cells (111 scored, 14 withheld) and 31 matched acquisition pairs.
See `contracts/examples/fire-investigation-response.live.json` for the full output.
Its fire perimeter is hypothetical; its satellite evidence is real. The frontend now calls `/v1/fire-investigation`; see `docs/fuel-index-ui.md` from the
repository root for the integration handoff.

## API component responsibility

Endpoints, request validation, and application logic belong here.

Keep shared API schemas and example responses in `../../contracts/`.
