# FireWatch investigation map

Requires Node 20.19+ (or a supported newer Node version). Run `npm install`, then
`npm run dev` in `frontend/`. `npm run build` produces the static app; `npm test`
checks geometry and the API consumer against the shared live-response fixture.

## Connect the fuel service

Start the authenticated backend using [its setup guide](../backend/api/README.md).
The Vite development server proxies `/api/*` to `http://127.0.0.1:8001/*`.
The browser sends the fire geometry to `/api/v1/fire-investigation` with imagery
start/end dates (UTC, exclusive end, 1–31 days) and nominal cell size in metres.
No Earth Engine credentials are sent to or stored in the browser.

Optional server-side variables in `frontend/.env.local`:

- `FIREWATCH_API_URL`: backend origin, default `http://127.0.0.1:8001`.
- `FIREWATCH_API_TOKEN`: backend bearer token if configured; injected by the Vite
  proxy only. Never prefix service credentials with `VITE_` or commit `.env.local`.

Restart Vite after changing proxy settings. The proxy also works with Vite preview;
a deployed static build needs a same-origin server gateway for `/api` with equivalent
routing and server-side auth. The dev proxy is not a production authentication layer.

## Flow

Choose a hypothetical preset or draw a fire polygon. The yellow 28 km ring initially
uses a local Turf preview. Choose an imagery window and cell size; press **Analyze
fuel index**. The backend creates its wrapper, subtracts the fire and scores cells
only in the investigation ring. Successful responses replace preview geometry and
area measurements with the returned WGS84 geometry and areas.

The Hoh forest default uses the same small hypothetical perimeter as the verified
service example, July 2025 imagery, and 5000 m nominal cells. The 50 km-radius circle
and irregular Sierra/Mojave examples remain available. Large regions with small
cells may exceed backend workload limits; errors are shown without a fake fallback.

Map cells use the experimental fuel score; gray means unknown, distinct from zero.
Click a cell for score/status, clipped area, coverage, vegetation evidence, NDMI,
dryness and observations. Evidence includes source collection IDs, acquisition
records, attribution and quality counts. Method shows the formula and limitations.
Export downloads the complete backend JSON, including every cell. Before analysis,
export is explicitly a local geometry preview.

Changing the polygon, dates or grid size invalidates old scores. Stop waiting aborts
the browser request and ignores late responses; Earth Engine work may still finish
on the server. The UI shows indeterminate progress because no progress API exists.

## Maps and limitations

Leaflet, Lucide and Turf provide the map UI and geometry preview. Esri satellite
tiles and OpenStreetMap are basemaps only; they do not produce analytical scores.
Map tiles require internet and may have different acquisition dates from the analysis.
Google Maps remains an optional selector configured with a restricted browser key
through settings or `VITE_GOOGLE_MAPS_API_KEY`; it is not the satellite analysis source.

The former browser RGB implementation remains in visualization/analysis.js for
reference and regression tests; the Analyze button now calls the fuel service.
Scores are unvalidated vegetation × dryness proxies, not spread forecasts or
probabilities. See [the contract](../contracts/fuel-index.md).
