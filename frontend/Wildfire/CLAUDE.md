# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Ember** — an interactive wildfire spread sandbox (Vite + React 18 + TypeScript + Leaflet) that
runs **anywhere on earth**: terrain, land cover and weather are fetched at runtime for whatever
area the user picks. The three Armenian `SCENARIOS` are bookmarks, not the available set —
`scenarioAt(lat, lng, spanKm)` builds a domain around any point, and every data source is global.

The repo is an **npm workspace** rooted two levels up at `firewatch-ai/`. This app is one of four
packages, and the simulation no longer lives here:

| Package | Path | What it is |
|---|---|---|
| `wildfire-sim` | `frontend/Wildfire/` | this app — UI, rendering, browser tile loading |
| `@firewatch/sim` | `frontend/sim/` | the kernel, fuels, terrain, weather, classifier, tile math. **DOM-free**, runs in browser and Node |
| `@firewatch/contracts` | `contracts/` | wire protocol, binary codec, §9 provider ports. No runtime logic |
| `@firewatch/api` | `frontend/api/` | Fastify server that runs the kernel and streams state |

Run everything from the repo root: `npm run dev` (both), `npm run dev:web`, `npm run dev:api`,
`npm run build`, `npm run typecheck`, `npm run smoke`, `npm run smoke:api`.

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
npm install                 # in frontend/ — the workspace root, not here

# in-browser sim (no server needed)
npm run dev:web             # Vite on :5173
npm run dev:web -- --port 5174

# server-side sim
npm run dev:api             # Fastify on :8787, mode=live
FIREWATCH_MODE=offline npm run dev:api     # fully procedural, no network
VITE_API_URL=http://127.0.0.1:8787 npm run dev:web   # UI talks to the server

npm run build               # every workspace
npm run typecheck           # every workspace
npm run smoke               # UI: Playwright drives every control (needs dev:web running)
npm run smoke:api           # API: boots the server, decodes the binary stream
FIREWATCH_MODE=live npm run smoke:api

# provider diagnostics, from frontend/api/ or with --workspace=@firewatch/api
npm run watercheck          # fuel classifier vs. six hard water bodies
npm run barriercheck        # OSM barrier geometry + whether the kernel honours it
FIREWATCH_MODE=offline npm run barriercheck   # geometry and kernel only, no Overpass
```

From inside `frontend/Wildfire/`: `npm run calibrate` renders `calibrate.html` to
`shots/calibrate.png` with band percentiles (needs a dev server).

There is **no linter and no unit-test runner**. Two smoke tests are the whole suite, both linear
scripts with no filtering — to run one case, comment the others out:

- `scripts/smoke.mjs` (UI) drives every control in headless Chromium and fails on any console
  error. It waits on the app's own ready signal, **not** `networkidle` — in server mode the page
  holds a socket streaming at 10 Hz, so the network is never idle and that wait passes only by
  luck of timing. Needs a dev server. Honours `APP_URL` and `SHOT_DIR` (default `shots/`, gitignored).
  Point `APP_URL` at a `VITE_API_URL`-configured server to exercise remote mode — **both modes
  must pass before any transport change lands.**
- `frontend/api/src/smoke.ts` boots the real server, drives an incident, and decodes the binary
  frames. Defaults to offline so it needs no network.

`strict`, `noUnusedLocals` and `noUnusedParameters` are on everywhere, so an unused import fails
the build.

**Node runs the backend's TypeScript directly** — no build step, no `tsx`. That means
type-stripping only, so nothing in `frontend/api/` or `frontend/sim/` may use non-erasable syntax:
no TS `enum`, no `namespace`, no parameter properties, no decorators. `erasableSyntaxOnly` is set
in `frontend/api/tsconfig.json` so `tsc` rejects them rather than Node failing at runtime. Use
`const X = {...} as const` for enum-like values, as `fuels.ts` does.

Local imports carry explicit `.ts` / `.tsx` extensions; cross-package imports use the subpath
exports (`@firewatch/sim/model`, `@firewatch/contracts/codec`) and carry none. Adding a file to
`frontend/sim/` or `contracts/` means adding it to that package's `exports` map — otherwise the
frontend gets `TS2307: cannot find module`.

## Architecture

Three layers, one direction: `@firewatch/sim` knows nothing about rendering, `render/` knows
nothing about React, `components/` wires them to the DOM.

### The transport seam

`src/transport/` decides **where the fire runs**, and it is the thing to understand before
touching `App.tsx`:

- `LocalTransport` steps the kernel in the browser — the original behaviour, and a first-class
  configuration rather than a fallback. It is what makes the app work offline.
- `RemoteTransport` opens a WebSocket, receives a one-off terrain frame plus ~1–3 kB delta frames
  at 10 Hz, and **mirrors them into a real `Sim` object**.

That mirroring is the whole trick: `MapView`, `fireGeometry` and `paint` read `sim.state`,
`sim.ignitedAt` and `sim.treatment` exactly as before and cannot tell which transport they got.
Keep it that way — a renderer that branches on transport kind defeats the design.

`VITE_API_URL` selects remote; unset is local. A failed connect falls back to local with a
console warning, because a server being down must not take the demo with it.

Two non-obvious invariants:

- **`sample()` must be called to refresh stats.** Perimeter and containment need a full-grid pass,
  so it runs at the host's 5 Hz read-out cadence, not per step. Local recomputes; remote returns
  what the server sent. Stepping without sampling silently freezes every read-out — that exact
  regression got caught by the smoke test, not by types.
- **Never clear the server's shadow arrays on reset.** `Incident` diffs the grid against
  `shadowState`/`shadowTreatment` to build deltas. Clearing them makes the post-reset delta empty,
  so the stats zero while every client keeps rendering the burn scar. Leaving them stale is what
  makes the diff emit each burnt cell as unburned. `npm run smoke:api` has a client-side mirror
  that catches this; a stats-only assertion does not.
- **Intensity is only sent for cells inside their flaming window** (`flamingTime` in
  `@firewatch/sim/fuels`), quantised to u8 against the frame peak. That is the only place the
  renderer reads it; sending it for every burning cell would be ~5x the traffic for bands that are
  never drawn. `RemoteTransport` must zero last frame's lit cells before writing the new ones or
  cells that stopped flaming keep a hot core forever.
- **The server must be told to release an incident.** Closing a socket does not: `RemoteTransport
  .dispose` sends `DELETE` with `keepalive`, and the server reaps sockets-less incidents after
  `IDLE_TIMEOUT_MS` as the backstop for a browser that crashed. Without both, repeated scenario
  changes walk into `maxIncidents`.
- **Both transports show a procedural terrain immediately**, then swap in the real one. Remote has
  tiles to fetch, so without this a scenario change leaves the map blank for seconds and silently
  swallows the first click. `LocalTransport` records `userIgnitions` and `userTreatments` as operations so
  they can be replayed onto whichever source finishes loading. Against a server the provisional
  transport runs in `staging` mode — it accepts input but never steps, because the server starts
  its own incident at t=0 and any growth accumulated locally would visibly vanish at the handoff.
  Locally it does step, because `transferSimState` carries the whole sim across.

### Simulation state lives outside React

`Sim` (`frontend/sim/src/model.ts`) is a bag of typed arrays held in a `useRef` in `App.tsx`. It is
mutated in place; it is never React state. A single `requestAnimationFrame` loop in `App.tsx`:

1. advances the sim by fixed `DT = 10` sim-seconds per `step()`, as many steps as the chosen
   speed demands (capped at `MAX_STEPS_PER_FRAME`),
2. calls the draw callback `MapView` registered via `registerDraw`,
3. pushes React state (stats, clock) only at **5 Hz** — the canvas is the real-time surface,
   the DOM is a read-out.

Consequences worth internalising before editing:

- `simRef` is repointed at `transport.sim` on each render rather than owning a sim, so swapping
  transports never re-creates `MapView`.
- Anything that mutates the grid **outside** `step()` must bump `sim.revision`. The renderer
  skips geometry rebuilds when neither `sim.time` nor `sim.revision` changed, so a mutation
  without the bump is invisible while paused (see `clearLines`, `paintTreatment`).
- `sim.active` is the work list of burning cell indices, rebuilt each `step()`. Extinguishing
  a cell from outside a step requires filtering `active` (`paintTreatment` only does so when
  it actually knocked something down).
- `burnedCells`, `wuiCells`, `spotFires`, `peakRos` are maintained incrementally inside
  `step()`. `recomputeStats()` is the O(cells) pass — perimeter and containment — and runs once
  per rendered frame, not per step.

### Terrain swaps are handled by the transport, not App

`useFireSource(scenario)` in `App.tsx` owns the whole lifecycle: adopt a provisional procedural
transport, resolve the real source, adopt that, dispose the old one. Adopting a new transport
carries the user's fire across — `state`, `ignitedAt`, `treatment`, `active`, `burnedCells` — so
the real terrain arriving a second later does not wipe what they lit.

### Location is a value, not an id

`App` holds a `Scenario` object in state, not an index into `SCENARIOS`. `scenarioAt()` synthesises
one for any point, deriving the seed from the coordinates so a location's placeholder terrain is
reproducible. A scenario whose `id` starts with `at:` is a custom location — `RemoteTransport`
branches on that to send `{lat, lng, spanKm}` instead of `{scenarioId}`, so bookmarks keep their
hand-tuned placeholder terrain while everywhere else goes by coordinates.

`MapView` sets **no `maxBounds`** and a world-level `minZoom`: the simulated square is one area of
interest on a global map, and the user has to be able to roam off it to pick somewhere else. The
domain is drawn as a dashed rectangle so it stays findable.

### Active fire detections

`Show current fires` is the §9 `IgnitionSource` port implemented for real, in
`frontend/api/src/providers/firms.ts`. Three things about it are non-obvious:

- **It must be proxied.** FIRMS sends no CORS headers, so the browser cannot fetch it. The
  checkbox is disabled when `VITE_API_URL` is unset, with a title explaining why.
- **It uses `node:https`, not `fetch`.** Node's undici reliably fails against that host with
  `UND_ERR_CONNECT_TIMEOUT` at its fixed, non-configurable 10 s connect limit, while curl and
  `node:https` connect in under 200 ms. That is a real quirk of the host, not a workaround to
  remove later. Tile fetching elsewhere still uses `fetch` because those hosts are fine.
- **The global CSV is ~6 MB and refreshes hourly**, so it is cached for 15 minutes and concurrent
  misses are collapsed onto one in-flight request. A map pan must not cost 6 MB.

### Map controls live on the map

`MapTools.tsx` sits over the map (`.hud-tl`), not in the sidebar, and it is the **only**
home for those controls — `ControlPanel` no longer holds them. Two controls in two places
is how they drift.

The grouping carries meaning and the dividers are not decoration: Ignite / Dozer /
Retardant are drawing tools; **Pan is the absence of one**; Thermal, Isochrones and Fires
are view toggles. Pan was originally the fourth cell of a 2x2 grid styled identically to
the three brushes, which is precisely why it was unfindable. The sidebar keeps only
basemap *configuration* (which raster, which tile style, contours) — things you set once
— while anything toggled while looking at the map lives on the map.

**Every button needs an explicit `aria-label`.** `.mt-label` is hidden below 1600px, so
the visible text cannot serve as the accessible name; without the label the buttons
become unnamed icons for screen readers, and the smoke test's `getByRole(name:)` lookups
break. That regression happened once already — the test caught it.

### Canvas must follow Leaflet's zoom animation

`MapView` mirrors `zoomanim` onto the fire canvas with a CSS transform, then clears it on
`zoomend`/`viewreset`. This is required, not polish: the canvas is positioned *over* the
map rather than inside Leaflet's transformed panes, and `latLngToContainerPoint` reports
pre-animation geometry for the whole animation. Without the mirror the tiles glide and
the fire sits still, then snaps.

The transform is `translate(size/2 - s·p0) scale(s)` where `p0` is the incoming centre's
current container point, and the transition matches Leaflet's own 250 ms
`cubic-bezier(0,0,0.25,1)` — a different easing is more visible than no animation.
The per-frame redraw during the animation is harmless: it keeps painting the pre-zoom
geometry, which is exactly what the transform expects.

### Thermal view

`render/thermal.ts` renders apparent temperature as a raster, not contours — temperature
is a continuous field and banding it into paths would invent edges. Three rules:

- **It replaces the fire graphics, it does not tint them.** `MapView` skips the scar,
  isochrones and flame bands when `layers.thermal` is on (`irOnly`). Control lines still
  draw — a dozer line is a feature of the incident, not a fire colour.
- **The temperature map is the one in ARCHITECTURE.md §4**: `T_amb + 1050·tanh(I/I_ref)`,
  saturating. Keep them in sync; if §4's `T_f` changes, this changes.
- **The blur is a sensor model, not a smoothing hack.** One `smoothField` pass stands in
  for a thermal camera's point-spread function. Without it the raster is single-pixel
  speckle and reads as noise. Two passes erase the flanks, same as the flame contours.

The scale is fixed to ambient → ambient+1050 K rather than tracking each frame's maximum,
so the fire's apparent brightness tracks its actual temperature. FIRMS markers reuse the
same ramp via `thermalColour()` keyed on measured brightness temperature, which is what
makes modelled and observed heat comparable (§6).

### Per-cell wind and moisture

`StepInput` takes optional `windField` and `moisture` alongside `blockFrac`. All three follow
the same rule: **omitted means the scalar path**, which is what browser-only mode passes, so
the kernel stays usable without a server.

- **Wind vectors are `u` east, `v` north** — the meteorological convention, pinned in
  `contracts/src/providers.ts`. Grid rows increase *southward*, so the two disagree by a sign.
  They did disagree, silently, and a uniform field produced a 26% larger fire than the
  identical scalar wind. The invariant worth keeping: a uniform field must reproduce the
  scalar path **bit for bit**.
- **Wind is fetched as an anomaly, not absolute** — `speedRatio` and `veerDeg` against the
  domain mean. The data supplies spatial shape; the wind slider still sets strength and
  bearing. A real field that overrode the slider would break the control the sandbox is
  built around.
- **Gusting rides on top of the field**, scaled by `gustScale` and veered by `gustVeer`:
  gusting is a time signal, not a place signal.
- **Moisture is an NFDRS 1-h timelag** integrated over 7 days of Open-Meteo history, so rain
  yesterday matters — the formula it replaced was memoryless. `FuelMoistureModel.compute`
  stays synchronous and kicks off its own history refresh; `warmMoistureHistory` is awaited at
  incident creation so the first field already has real data.
- `Incident.rebuildFields()` runs before each step batch but early-returns on an unchanged
  weather signature, so it costs nothing while the weather is still.

### Water comes from Sentinel-2, not from colour

`frontend/api/src/providers/sentinel.ts` reads the Sentinel-2 L2A **Scene
Classification Layer** from AWS Open Data (keyless STAC + COG range reads) and it is
**authoritative for water and snow**. This exists because the visible-band classifier is
tuned for Armenia and fails elsewhere — it called the Great Salt Lake 57% cropland and the
Rio Negro 44% urban, so lakes burned. RGB cannot do this job: water is turquoise, black,
pink or brown depending on where you are, and only the NIR is consistent.

Rules to preserve:

- **SCL overrides only Water and Snow.** It cannot separate timber from scrub from grass,
  so everything else falls through to `classifyFuel`. Cloud, shadow and no-data fall
  through too — the layer must never punch holes in the fuel map.
- **The lookup has a 6 s deadline** (`DEADLINE_MS`) because a cold COG read takes 10–30 s
  and incident creation cannot block on it. Missing the deadline is normal: the caller
  proceeds on the RGB proxy while the lookup finishes in the background and fills the
  cache. In-flight requests for the same area are deduped.
- **Never swallow the failure silently.** An earlier version returned `null` on error,
  which made a plain HTTP 400 (bare `yyyy-mm-dd` — earth-search needs full RFC3339) look
  identical to "no satellite coverage". It logs now.
- `npm run watercheck` is the regression test — six water bodies chosen to break a
  colour-based classifier. Run it after touching `classify.ts` or `sentinel.ts`.

The model itself has always been correct: `step()` skips any cell with `load <= 0`, and a
shoreline-ignition stress test burns zero water cells. The bug was never in the kernel.

### Fuel is an index, in two places

`terrain.fuel` is a `Uint8Array` of `Fuel` ids indexing `FUELS` in `frontend/sim/src/fuels.ts`.
Adding or reordering a fuel means touching the `Fuel` const object, the `FUELS` array (same
order), `FUEL_LEGEND`, and `frontend/sim/src/classify.ts`. Cells with `load <= 0` (water, barren)
are the universal "unburnable" test.

`fineLoad` is **not** a duplicate of `load`: it is the 1-h fraction, and it is the heat sink in
Rothermel's preignition term. Timber is 5.5 kg/m² total but only ~0.9 fine, which is why it
ignites at all. See ARCHITECTURE.md §4 "Ignition threshold" — applying `Q_ig` to the whole bed
is a real bug that makes heavy fuels non-ignitable.

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

### A real port has to reach the kernel, or it is decoration

Three ports were fetched and thrown away before they were made real: `barriers`, `valuesAtRisk`
and `observer`. Wiring the provider is the easy half — check the data actually arrives somewhere
that changes what the user sees, and that the UI stops claiming the old estimate:

- `blockFrac` scales the spread rate through each cell edge in `step()`.
- `structures` is summed over burnt cells in `recomputeStats(sim, structures?)`, replacing
  `STRUCTURES_PER_HA` — and `StatsPanel`'s footnote switches wording on
  `provenance.valuesAtRisk.kind`, because "3 per hectare" under a counted number is a lie.
- `observer` genuinely has no consumer yet: §6's assimilation loop does not exist. It is wired and
  labelled so a drone IR feed is one line in `registry.ts`, and the note says a FIRMS pixel is
  375 m, not a perimeter. Do not let it grow a consumer that pretends otherwise.

Ports whose data the kernel ignores are still recorded in `Incident.provenance` — all ten of them.
A port missing from that record is a mocked source the UI never mentions.

### Incident creation is one Promise.all, deliberately

Every port that needs only the grid is resolved concurrently in `Incident.create`. Adding an
`await` in front of one instead of a slot in that array puts its latency on the critical path:
FIRMS alone is a 6 s deadline (`OBSERVER_DEADLINE_MS`) on a cold cache, which costs nothing behind
the tile fetches and 6 s in front of them. Incident creation is ~7 s; keep it there.

The FIRMS observer degrades to `no-observations` when it loses that race and the global 24 h CSV is
still downloading, then reports `measured` on the next incident. That is the cache warming, not a
bug — but it does mean the first incident after a server start shows one more mocked port.

### Barriers are per-edge, and the edge order is a contract

`BarrierField.blockFrac` is `cols * rows * 8` floats, indexed `blockFrac[i * 8 + d]` where `d`
indexes **`NEIGHBOURS` in `frontend/sim/src/model.ts`** — that array is exported for exactly this
reason. Rasterise onto a different ordering and the fire is slowed in the wrong directions with
nothing failing loudly, which is why `npm run barriercheck` asserts the rule directly: a barrier
lying along a cell boundary must block the flux *across* it and leave the flux *along* it open.
`osmBarriers` gets that right by testing whether the centre-to-centre flux path intersects the
barrier segment; marking the edges a line "passes through" gets it exactly backwards.

Three things to preserve when touching this path:

- **`blockFrac` lives on `Incident`, not on `Sim`.** `reset` builds a fresh sim over the same
  terrain, so a field held on the sim would silently vanish on the first reset. It is
  terrain-derived and immutable for the incident's life, like `terrain` itself.
- **Browser-only mode has no barriers.** Overpass is fetched server-side and `StepInput.blockFrac`
  is optional; local mode simply omits it. Do not make the kernel require it.
- **The block is capped below 1 and spotting ignores it.** A road stops a creeping flank, not an
  ember, and `barriercheck` disables spotting precisely because spotting is meant to cross.

### Deliberate mock seams

These are the interfaces designed to be swapped for real feeds, each marked `MOCK:` in source:

| Seam | File | Replace with |
|---|---|---|
| `mockForecast()` / `Weather` | `src/sim/weather.ts` | NWS gridpoint or RAWS pull — same shape, same units |
| `classifyFuel()` visible-band | `frontend/sim/src/classify.ts` | a LANDFIRE-equivalent fuel raster |
| Procedural terrain | `frontend/sim/src/terrain.ts` | superseded at runtime by real tiles; kept as the offline fallback |
| Click-to-ignite | `App.tsx` | VIIRS / GOES active-fire detections |

Server-side the same seams are formal §9 ports in `frontend/api/src/providers/`. `registry.ts` is
the **only** file that names concrete implementations. Real today: Terrarium DEM, Esri imagery
fuel, Open-Meteo weather, OSM barriers, OSM buildings, FIRMS observations. Mocked: canopy, burn
history, wind field, fuel moisture. Every provider returns `Provided<T>` carrying `Provenance`, and the UI header chip
lists which is which — "mock data presented as live" is meant to be a type error, so do not add a
provider that returns bare data.

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
- The binary codec in `frontend/contracts/src/codec.ts` must agree byte for byte on both sides; a drift
  there is silent and renders as a corrupted fire rather than an error. Change encode and decode
  together and re-run `npm run smoke:api`, which round-trips them.

## Repo context

The root `AGENTS.md` is the cross-team guide for `firewatch-ai` (backend/api, backend/llm,
frontend, contracts, docs) and the authoritative decision log. Everything here lives under
`frontend/`, so `backend/` and the repo-root `contracts/` remain untouched scaffolds. It asks for short-lived
`codex/<task>` branches, separate worktrees for concurrent agents, and contract-first changes to
shared payloads. Note that it nominates `frontend/visualization/` for map and chart work — this
app predates that split and is self-contained under `frontend/Wildfire/`; flag rather than
silently relocate.

`dist/`, `node_modules/`, `shots/` and `*.tsbuildinfo` are gitignored.

`frontend/sim`, `frontend/contracts` and `frontend/api` are siblings of `frontend/Wildfire` under
the `frontend/` workspace root. Nothing outside `frontend/` is modified.
