# FireWatch AI

**See where wildfire could spread. Explore how to respond.**

FireWatch AI is a research prototype for exploring wildfire spread on an interactive
map and inspecting historical fire progression. It combines terrain, vegetation and
weather inputs with a physics-based simulation, alongside a historical atlas with
source evidence and explicit data gaps.

## What you can do

- **Simulate a location:** select an area, place an ignition and explore potential
  spread over terrain. Inspect simulated burned area, perimeter and fire behavior.
- **Explore response scenarios:** change weather and fuel conditions, draw
  containment lines and adjust suppression effort to compare simulated outcomes.
- **Explore historical fires:** open the historical atlas, select an event and replay
  available recorded progression. Inspect environmental measurements, timestamps,
  source evidence and missing values. Single perimeter snapshots have no playback.

The simulator is at `/`; the historical atlas is at `/history`. The atlas displays
observations from the loaded pilot library; it does not run the spread simulator.

## Demo

Two screen recordings of the simulator running locally (no audio). Both show
exploratory scenarios, not validated forecasts.

| Recording | What it shows |
| --- | --- |
| [Weather scenarios and containment](assets/simulator-weather-and-containment.mp4) (1:29) | Placing an ignition on mountainous terrain with live DEM and imagery, switching between weather scenario presets, adjusting wind and fuel-moisture inputs, and running the fire out to roughly six simulated hours while containment and isochrones update. |
| [Live inputs and map layers](assets/simulator-live-inputs-and-layers.mp4) (1:10) | A run over mixed agricultural and wildland–urban terrain with live providers reporting, switching among the fuel, terrain and satellite layers, and tinting the grid by fuel model while spotting and crown-fire counts develop. |

GitHub shows these as file links; open one to play it inline.

## How it works

The React/Leaflet app uses a shared TypeScript simulation kernel, running either in
the browser or through a Fastify API that streams state over WebSockets. The kernel
uses simplified published fire-behavior relationships and minimum-travel-time
propagation to explore spread across a terrain grid.

**Machine learning estimates forest canopy structure; the physics model calculates
fire spread.** The API's canopy provider uses gradient-boosted trees trained on
LANDFIRE data. This is an input estimate, not an independently validated wildfire
forecast.

Data integrations include terrain tiles, LANDFIRE, ESA WorldCover, Sentinel-2,
weather services, OpenStreetMap and NASA FIRMS. Coverage and available providers
vary by location and runtime mode. Inputs may be measured, derived, assumed or
synthetic fallbacks; inspect the displayed source and quality information.

## Run locally

Use **Node.js 24+ and npm**. From the repository root:

```sh
cd frontend
npm install
npm run dev
```

This starts the web app at **http://localhost:5173** and the simulation API at
**http://127.0.0.1:8787**. Open **http://localhost:5173/history** for the historical
atlas. Live data retrieval requires internet access.

For a browser-only simulation, run `npm run dev:web` instead, with `VITE_API_URL`
unset. To run the API separately, use `npm run dev:api`; point the web app at it
with `VITE_API_URL=http://127.0.0.1:8787`. Browser-only mode uses a different data
loading path from the API, so input availability can differ.

The API also supports procedural inputs via
`FIREWATCH_MODE=offline npm run dev:api`. This changes the API's input providers;
it does not make external browser map tiles available offline.

## Status and limitations

- **Experimental scenarios:** operational forecast accuracy and suppression
  effectiveness remain unvalidated. These outputs are not ready to guide emergency
  response decisions.
- **Validation is unfinished:** physics tests and retrospective comparisons exist,
  but passing software checks or replaying a historical fire does not establish
  forecast accuracy on new incidents.
- **Historical fires include intervention:** firefighting effects must be separated
  from natural spread when evaluating simulations that exclude intervention.
  Missing intervention records do not mean no firefighting occurred.
- **Data quality matters:** source dates, resolution, geographic coverage and
  fallback assumptions can affect results. Applying a canopy model elsewhere does
  not establish its accuracy in that region.
- **Ecological assessment is a future direction:** comprehensive habitat, soil,
  water, smoke exposure and recovery impacts are not calculated by the current app.

## Repository guide

| Path | Purpose |
| --- | --- |
| [`frontend/src/`](frontend/src/) | Web app, simulator controls, historical atlas and map components |
| [`frontend/sim/`](frontend/sim/) | Shared fire simulation kernel and physics checks |
| [`frontend/api/`](frontend/api/) | Running simulation API, data providers and canopy inference |
| [`frontend/contracts/`](frontend/contracts/) | Shared TypeScript provider and simulation protocol types |
| [`backend/api/`](backend/api/) | Historical data acquisition, normalization and export tooling |
| [`backend/llm/`](backend/llm/README.md) | Historical incident-document extraction and evaluations |
| [`backend/vision/`](backend/vision/README.md) | Separate experimental RGB/thermal and satellite observation research |
| [`contracts/`](contracts/README.md) | Language-neutral historical and research data schemas |
| [`docs/`](docs/) | Research, design documents and presentation materials |
| [`assets/`](assets/) | Screen recordings and media used by the documentation |

The Python research and enrichment tools have their own setup instructions; they
are not required to launch the web app with its bundled historical library.

## Checks

Run from `frontend/`:

```sh
npm run typecheck   # App and workspace type checks
npm test            # Historical-viewer logic and simulation tests
npm run build       # Web app and workspace builds
npm run bench       # Simulation benchmark harness
```

Browser and API smoke checks, live-provider diagnostics and historical comparisons
are documented in the component READMEs below. Benchmark results describe the
configured test cases; they are not operational accuracy guarantees.

## Documentation

- [Application setup and controls](frontend/README.md)
- [Current application flow and model details](frontend/APP-FLOW.md)
- [Simulation API, providers and diagnostics](frontend/api/README.md)
- [Historical atlas behavior and data refresh](docs/concurrent-analysis/09-historical-similarity/historical-preview.md)
- [Historical data research and reproduction](docs/concurrent-analysis/09-historical-similarity/README.md)
- [Observation research and its validation gaps](docs/concurrent-analysis/09-observation-baseline/README.md)
- [Technical and pitch reference](pitch.md) — detailed claims and measurements;
  some sections still need reconciliation with the current implementation.
- [Proposed architecture](frontend/ARCHITECTURE.md) — a target design, not a
  description of every implemented feature.
- [Contribution guide](CONTRIBUTING.md)
- [Repository instructions](AGENTS.md)

Our direction is open collaboration with researchers and analysts: inspect model
assumptions, contribute regional data and strengthen reproducible validation. Wider
collaboration can improve the evidence; accuracy must still be demonstrated.

## Contributing

Start with the [contribution guide](CONTRIBUTING.md), choose a bounded task from
[open issues](https://github.com/RubSar/firewatch-ai/issues), or ask a question in
[Discussions](https://github.com/RubSar/firewatch-ai/discussions). Contributions
can include code, data audits, documentation and practitioner review.

## License

Original FireWatch AI code and documentation are available under the
[MIT License](LICENSE). Third-party code, data, imagery and model assets retain
their own terms; see [third-party notices](THIRD_PARTY_NOTICES.md).
