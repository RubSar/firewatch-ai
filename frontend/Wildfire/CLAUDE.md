# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Ember** — an interactive wildfire spread sandbox (Vite + React 18 + TypeScript + Leaflet),
one of the three Armenian scenarios at a time, with real elevation and land cover fetched at runtime
and simulated weather. It lives at `frontend/Wildfire/` inside the larger `firewatch-ai`
repo (git root is two levels up).

`README.md` documents the model and the data sources; it and some source comments still say "four
regions" and mention Lake Sevan, but `SCENARIOS` in `src/sim/terrain.ts` holds three (Khosrov,
Dilijan, Kapan). **`ARCHITECTURE.md` describes a
different, future system** — a 10 m energy-accumulator kernel on GPU with GEE-derived fuel and
IR assimilation. None of that is implemented here. Do not treat it as a description of
`src/`; the shipped model is the probabilistic CA that `ARCHITECTURE.md` §4 argues against, and the
`1+√2` front-speed error §4 quantifies is live in `src/sim/model.ts:230`. The doc carries a status
banner saying so.

`ARCHITECTURE.md` §9 is the exception worth acting on: it specifies a provider/port interface per
component (`FuelProvider`, `WeatherProvider`, `SpreadKernel`, …) with a `Provided<T>` +
`Provenance` return type, an implementation matrix mapping each port to what exists in `src/` today,
and a four-step migration that ends with `SpreadKernel` wrapping `model.ts` **unchanged**. Prefer
that shape over adding new free functions to `sim/`.

## Commands

```bash
npm install
npm run dev        # Vite on :5173, opens a browser
npm run build      # tsc -b && vite build  — the only typecheck gate
npm run preview

npm run dev        # in one shell, then:
npm run smoke      # Playwright/Chromium: drives every control, exits 1 on any console error
npm run calibrate  # renders calibrate.html to shots/calibrate.png + band percentiles
```

There is **no linter and no unit-test runner**. `scripts/smoke.mjs` is the whole test suite:
a linear script of `step(...)` blocks against the running dev server. To run one case, comment
out the other steps — there is no filtering mechanism. Both scripts honour `APP_URL` and
`SHOT_DIR` (default `shots/`, gitignored).

Typecheck alone: `npx tsc -b`. `strict`, `noUnusedLocals` and `noUnusedParameters` are on, so
an unused import fails the build.

Imports carry explicit `.ts` / `.tsx` extensions (`allowImportingTsExtensions`). Match that.

## Architecture

Three layers, one direction: `sim/` knows nothing about rendering, `render/` knows nothing
about React, `components/` wires them to the DOM.

### Simulation state lives outside React

`Sim` (`src/sim/model.ts`) is a bag of typed arrays held in a `useRef` in `App.tsx`. It is
mutated in place; it is never React state. A single `requestAnimationFrame` loop in `App.tsx`:

1. advances the sim by fixed `DT = 10` sim-seconds per `step()`, as many steps as the chosen
   speed demands (capped at `MAX_STEPS_PER_FRAME`),
2. calls the draw callback `MapView` registered via `registerDraw`,
3. pushes React state (stats, clock) only at **5 Hz** — the canvas is the real-time surface,
   the DOM is a read-out.

Consequences worth internalising before editing:

- `simRef` is built lazily (`if (simRef.current === null)`) because the component re-renders
  five times a second and `createSim` allocates five 130k-element arrays.
- Anything that mutates the grid **outside** `step()` must bump `sim.revision`. The renderer
  skips geometry rebuilds when neither `sim.time` nor `sim.revision` changed, so a mutation
  without the bump is invisible while paused (see `clearLines`, `paintTreatment`).
- `sim.active` is the work list of burning cell indices, rebuilt each `step()`. Extinguishing
  a cell from outside a step requires filtering `active` (`paintTreatment` only does so when
  it actually knocked something down).
- `burnedCells`, `wuiCells`, `spotFires`, `peakRos` are maintained incrementally inside
  `step()`. `recomputeStats()` is the O(cells) pass — perimeter and containment — and runs once
  per rendered frame, not per step.

### Terrain identity is the reset key

`buildTerrain(scenario)` generates procedural terrain synchronously so the map is never blank;
`loadRealTerrain()` then fetches DEM + imagery tiles and **replaces the `Terrain` object**.
`App.tsx` has an effect keyed on `[terrain]` that rebuilds the whole `Sim` — so a new `Terrain`
identity restarts everything downstream. Two refs exist purely to survive that swap:

- `ignitionsRef` — the cells the user lit, replayed onto the new sim.
- `carryTreatment` — control lines carry across a *data* swap but never a *scenario* change.

`baseTerrain` is memoised on `scenario` for the same reason: an incidentally-equal new object
would wipe the user's fire.

### Fuel is an index, in two places

`terrain.fuel` is a `Uint8Array` of `Fuel` ids indexing the `FUELS` array in `src/sim/fuels.ts`.
Adding or reordering a fuel means touching the `Fuel` const object, the `FUELS` array (same
order), `FUEL_LEGEND`, and the classifier in `src/data/realData.ts`. Cells with `load <= 0`
(water, barren) are the universal "unburnable" test.

### The fire is vectors, not pixels

`render/fireGeometry.ts` traces the burn scar, flaming front, isochrone bands and control lines
into `Path2D` objects **in grid coordinates** via `d3-contour` (`render/contour.ts` blurs the
field first and rounds corners after). `MapView` sets a canvas transform from grid space to the
map and fills those paths. So:

- geometry is rebuilt at ~20 Hz (throttled on `performance.now()`), but pan/zoom redraws at
  full frame rate because only the transform changes;
- the `render/paint.ts` base raster (one pixel per cell: fuel, elevation, contour lines) is
  repainted only when the layer key changes, and is skipped entirely over map tiles unless the
  fuel tint is on (`baseIsEmpty`);
- burning and *flaming* are separate fields — a cell smoulders for its whole burnout time but
  flames only for the first minutes, and drawing them alike gives a kilometre-deep orange blob;
- arrival-time bands are frozen and cached once the clock passes their cutoff (`isoCache`),
  because re-tracing every band per rebuild halved the frame rate.

### Deliberate mock seams

These are the interfaces designed to be swapped for real feeds, each marked `MOCK:` in source:

| Seam | File | Replace with |
|---|---|---|
| `mockForecast()` / `Weather` | `src/sim/weather.ts` | NWS gridpoint or RAWS pull — same shape, same units |
| `classify()` visible-band fuel | `src/data/realData.ts` | a LANDFIRE-equivalent fuel raster |
| Procedural terrain | `src/sim/terrain.ts` | already superseded at runtime by `loadRealTerrain`; kept as the offline fallback |
| Click-to-ignite | `App.tsx` | VIIRS / GOES active-fire detections |

Tile fetching in `realData.ts` degrades rather than throws: a partial mosaic is accepted above
60 % coverage, holes are grown over by `fillHoles`, a missing imagery mosaic falls back to the
topography-driven fuel rules, and a total failure keeps the procedural terrain. The header
"data chip" reports which of those happened — keep it honest when changing this path.

`calibrate.html` + `src/calibrate.ts` are a second Vite entry point, dev-only: imagery,
resulting classification and DEM hillshade side by side with band percentiles, for retuning the
`classify()` thresholds. Those thresholds were tuned against measured band statistics for these
specific Armenian regions (blueness for water because Sevan is turquoise; texture for
development; brightness for timber vs. scrub; slope for forest vs. cropland) — re-tune via
`npm run calibrate`, don't guess.

## Model conventions

- `windDir` is the direction wind blows **from**, degrees clockwise from north; `windToBearing`
  flips it for spread math. Grid rows increase **southward**.
- Every physical term in `step()` is a one-or-two-line simplification of a real relation
  (Byram intensity, the 10°-per-doubling slope rule, exponential wind, moisture of extinction,
  exponential arrival `p = 1 − exp(−ROS·Δt/d)`). Keep them that short and keep the comment that
  names the real thing — being individually defensible is the point of this codebase.
- `DT` is fixed at 10 s and the arrival formula makes spread rate step-size-independent. If you
  change `DT`, verify spread rates are unchanged rather than assuming it.
- Grid size comes from `TARGET_COLS = 400` in `terrain.ts` (~38 m cells, ~130k cells for a
  typical scenario). README prose that says ~70 m / 40,000 cells is stale; trust the code.

## Repo context

The root `AGENTS.md` is the cross-team guide for `firewatch-ai` (backend/api, backend/llm,
frontend, contracts, docs) and the authoritative decision log. It asks for short-lived
`codex/<task>` branches, separate worktrees for concurrent agents, and contract-first changes to
shared payloads. Note that it nominates `frontend/visualization/` for map and chart work — this
app predates that split and is self-contained under `frontend/Wildfire/`; flag rather than
silently relocate.

`dist/`, `node_modules/` and `shots/` are gitignored. `tsconfig.tsbuildinfo` is currently
tracked and should not be.
