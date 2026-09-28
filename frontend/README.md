# Frontend and simulation workspace

The React/TypeScript application runs at `/`; the historical atlas runs at `/history`.
The simulator is an experimental scenario tool. The atlas displays recorded geometry
and source measurements from a bundled pilot library; it does not run the simulator.
Neither software tests nor retrospective overlap establish operational forecast accuracy.

## Requirements and first run

Use Node.js 24+ and npm. From the repository root:

```sh
cd frontend
npm ci
npm run dev:web
```

Open http://localhost:5173. Leave `VITE_API_URL` unset for browser-only simulation.
Browser mode attempts terrain and imagery downloads and falls back to procedural
terrain. Weather is synthetic in this mode. Place search and external map tiles
need connectivity; fallback simulation does not imply that every UI feature is offline.

### Run the simulation API

On macOS/Linux, `npm run dev` starts the web app and API together. The API listens
on `127.0.0.1:8787`; the combined command sets `VITE_API_URL` for the web process.
It uses POSIX shell syntax. For Windows or separate terminals, start each process:

```sh
# Terminal 1, from frontend/
npm run dev:api
# Terminal 2, from frontend/ (macOS/Linux)
VITE_API_URL=http://127.0.0.1:8787 npm run dev:web
```

PowerShell equivalent for terminal 2:

```powershell
$env:VITE_API_URL = 'http://127.0.0.1:8787'
npm run dev:web
```

Set `FIREWATCH_MODE=offline` in the API process to use procedural/null providers.
In PowerShell: `$env:FIREWATCH_MODE = 'offline'` before `npm run dev:api`.
Remove `VITE_API_URL` from the web process environment to return to browser mode.
Vite reads this variable at startup/build time; restart it after changing the value.
See [API configuration](api/README.md) for provider timeouts, caching and limits.

## Layout and contribution boundaries

| Path | Responsibility |
| --- | --- |
| `src/main.tsx`, `src/App.tsx` | Route selection and simulator lifecycle |
| `src/components/` | Controls, statistics and simulation map |
| `src/history/` | Historical atlas UI and measurement/comparison utilities |
| `src/visualization/` | Shared map setup/basemaps and historical geometry renderer |
| `src/render/` | Canvas layers, contours and modelled thermal display |
| `src/transport/` | Browser kernel and API stream adapters |
| `src/data/` | Browser terrain and imagery loading |
| `sim/` | Shared DOM-free simulation kernel, tests and benchmark |
| `contracts/` | Shared TypeScript types and binary codec |
| `api/` | Fastify simulation API, providers and diagnostics |
| `public/data/` | Bundled historical pilot library |
| `scripts/` | Browser checks, history tests and calibration capture |

There is one web-app manifest and Vite config at this directory's root. `api`, `sim`
and `contracts` are child npm workspaces shared by browser/server code. They are
separate from the Python research tools and language-neutral schemas at repository root.
Read [CONTRIBUTING](../CONTRIBUTING.md) before changing shared interfaces. Keep
encode/decode changes together and document units and missing values.

## Controls and model interpretation

- Select a bookmark, search a location or use the current map view; click to ignite.
- Change wind, weather, fuel-moisture inputs and simulation speed.
- Draw dozer/retardant treatments and compare the resulting simulated state.
- Switch imagery, terrain, fuel, thermal and arrival-time layers.
- Inspect the source panel to distinguish measured, derived and synthetic inputs.
- Space toggles playback; `R` resets. The historical atlas has separate recorded-time controls.

The kernel uses a fixed 10-second simulated step and an approximately 400-column
terrain grid. Cell size and row count depend on the selected domain. Minimum-travel-time
propagation uses simplified fuel models, wind/slope response and moisture damping.
Crown-fire and spotting calculations exist; they are simplified and unvalidated
against independent incident sequences. The API may supply spatial wind/moisture
fields and canopy estimates; browser mode has fewer inputs.

Thermal colours are modelled apparent temperature, not camera measurements.
FIRMS markers are thermal anomalies, not confirmed fires or a surveyed perimeter.
Reported structures and containment are model-derived proxies, not observed losses
or incident-command assessments. See [current flow and equations](APP-FLOW.md),
[evaluation limitations](../docs/simulation-evaluation.md) and the
[proposed design](ARCHITECTURE.md) for distinct levels of evidence.

## Build and checks

Run these commands from `frontend/`:

| Command | What it checks or produces | Requirements |
| --- | --- | --- |
| `npm run typecheck` | Root app and workspace TypeScript checks | Installed dependencies |
| `npm test` | History logic and simulation tests | Node 24+, no external data |
| `npm run build` | TypeScript app check and production bundle in `dist/` | Installed dependencies |
| `npm run preview` | Serves the production bundle, normally port 4173 | Run build first; this is not a production deployment |
| `npm run smoke:api` | API lifecycle and binary-stream round trip | Binds a local port; offline by default |
| `npm run smoke:history` | Atlas playback, exports, missing-data states and desktop/mobile layout | Running web server; installed Chrome by default |
| `npm run smoke` | Simulator controls, reset and rendering | Running web server; installed Chrome by default; external services used |
| `npm run bench` | Numerical comparison with the Rothermel reference | Reports discrepancies; a zero exit code is not an accuracy gate |

For browser checks, set `APP_URL` to the server URL. Defaults differ:
`smoke` uses `http://localhost:5173/`, `smoke:history` uses `http://127.0.0.1:5173`.
Both accept `PLAYWRIGHT_CHANNEL` and `SHOT_DIR`. If Chrome is unavailable, install
Playwright Chromium with `npx playwright install chromium` and set
`PLAYWRIGHT_CHANNEL=chromium`. API-mode UI checks require a web server started with
`VITE_API_URL`; a browser-only run does not test the remote transport.

The [CI workflow](../.github/workflows/frontend.yml) runs installation, type checks,
history/kernel tests, build and offline API smoke checks. It does not run browser
checks, network-dependent provider diagnostics or Python research tests.

### Optional diagnostics and data refresh

Provider checks and canopy training are listed in [api/README.md](api/README.md).
`npm run calibrate` captures the dev-only `calibrate.html` imagery/fuel comparison.
It needs a dev server and Playwright's default Chromium binary
(`npx playwright install chromium`); unlike the smoke scripts, it does not select
installed Chrome. Its `APP_URL` must end in `/`. The calibration HTML is not included
in the default production build.

To refresh `public/data/historical-pilot.json`, follow the
[historical export instructions](../docs/concurrent-analysis/09-historical-similarity/historical-preview.md).
Keep source provenance, nulls and timestamps; do not replace missing measurements
with estimates merely to populate the UI.

## Troubleshooting

- Native TypeScript errors: confirm `node --version` is 24+ in the same terminal.
- Missing platform packages: use the committed lockfile and `npm ci`. When updating
  dependencies, preserve optional Linux/macOS/Windows entries; a working existing
  `node_modules` tree is not evidence that a clean install works on CI.
- Port conflict: `npm run dev:web -- --port 5174`; set `APP_URL` for browser checks.
- Provider failure: inspect per-incident provenance and API logs. `/api/health`
  describes configured providers, not successful source acquisition.
- Production `/history` returns 404: configure the host to serve `index.html` for
  SPA routes while serving `/data/` and built assets normally.

## Attribution

Satellite basemap: Sentinel-2 cloudless 2020 by EOX IT Services, containing modified
Copernicus Sentinel data. Topographic tiles: OpenTopoMap and OpenStreetMap contributors.
Terrain: AWS Terrain Tiles with upstream DEM attribution. Preserve the map's rendered
attribution and consult [third-party notices](../THIRD_PARTY_NOTICES.md) before
redistributing source data or changing providers.
