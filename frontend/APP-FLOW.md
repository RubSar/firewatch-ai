# App flow — Ember (FireWatch frontend workspace)

How a run of this application actually proceeds, end to end: what happens on load, where the
fire is computed, what data is fetched, how state reaches the screen, and what a click does.

This describes the **shipped code** under `frontend/`. It is not `ARCHITECTURE.md`,
which specifies a different, unimplemented system (10 m energy-accumulator kernel, GEE fuels,
IR assimilation). Where the two disagree, this document follows `src/`.

## 0. The pieces

| Package | Path | Role in the flow |
|---|---|---|
| `firewatch-frontend` | `frontend/` | The app: React UI, Leaflet map, canvas rendering, browser tile loading |
| `@firewatch/sim` | `frontend/sim/` | The kernel: fire spread, fuels, terrain, weather, classifier. DOM-free — identical code runs in the browser and in Node |
| `@firewatch/contracts` | `frontend/contracts/` | Wire protocol, binary codec, provider ports. Types only, no runtime logic |
| `@firewatch/api` | `frontend/api/` | Fastify server that runs the kernel server-side, resolves real data providers, and streams state |

One npm workspace rooted at `frontend/`. Dependencies point one way: the root app and `api` both
depend on `sim` and `contracts`; `sim` depends on nothing.

## 1. Two modes, one code path

The single environment variable `VITE_API_URL` decides **where the fire runs**:

```
VITE_API_URL unset          →  LocalTransport   →  kernel steps in the browser
VITE_API_URL set            →  RemoteTransport  →  kernel steps on the server, state streams back
```

Both are first-class. Local mode needs no server and no network at all — that is what makes the
app work offline and what the UI smoke test exercises deterministically. If a remote connect
fails, the app logs a warning and falls back to local rather than failing.

The seam is `frontend/src/transport/`. Both transports expose a real `Sim` object;
`RemoteTransport` mirrors wire deltas into it rather than stepping it. Everything downstream
(`MapView`, `fireGeometry`, `paint`) reads `sim.state`, `sim.ignitedAt` and `sim.treatment` and
cannot tell which transport produced them.

## 2. Boot

1. `src/main.tsx` mounts `App`.
2. `App` holds a `Scenario` **value** in state, initialised to `SCENARIOS[0]` (Khosrov Forest
   Reserve). The three Armenian scenarios in `sim/src/terrain.ts` are bookmarks, not the
   available set — every data source is global.
3. `useFireSource(scenario)` (`App.tsx`) owns the whole source lifecycle and runs immediately.
4. A single `requestAnimationFrame` loop starts and runs for the life of the app.

## 3. Acquiring a terrain and a transport — `useFireSource`

This is a deliberate two-stage load, so the map is never blank and the first click is never
swallowed:

```
buildTerrain(scenario)              procedural terrain, synchronous
  └─ new LocalTransport(...)        provisional; staging=true when API_URL is set
       └─ adopt()                   map renders instantly, input is accepted
            │
            ├─ API_URL set:  RemoteTransport.connect(...)  → adopt(remote)
            └─ otherwise:    loadRealTerrain(base)         → adopt(upgraded local)
```

- **Provisional transport.** Procedural terrain from `sim/src/terrain.ts` renders at once. It
  records `userIgnitions` and `userTreatments` as *operations*, so whatever the user does while
  the real source loads is replayed onto the source that wins.
- **`staging` mode.** Against a server the provisional transport accepts input but never steps —
  the server starts its own incident at t=0, so locally accumulated growth would visibly vanish
  at the handoff. Locally it does step, because `transferSimState` carries the whole sim across.
- **Handoff order matters.** Treatments are replayed before ignitions: a control line drawn
  before ignition must already be in place when the fire starts.
- **Adoption retires the old transport immediately**, so a scenario change never leaves two
  clocks running.

### Local path — `loadRealTerrain` (`src/data/realData.ts`)

Fetched straight from the browser, because both services send CORS headers:

- **Elevation** — AWS Terrarium terrain tiles, RGB-encoded height `(R*256 + G + B/256) - 32768` m.
- **Land cover** — Esri World Imagery, classified into fuel models by `sim/src/classify.ts` from
  visible-band greenness, brightness and local texture.

It degrades rather than throws: a partial mosaic is accepted above 60% coverage, holes are grown
over by `fillHoles`, a missing imagery mosaic falls back to topography-driven fuel rules, and a
total failure keeps the procedural terrain. The header data chip reports which happened.

### Remote path — `RemoteTransport.connect`

```
POST /api/incidents        {scenarioId}  or  {lat, lng, spanKm, name, region}
   → IncidentDto           incidentId, grid meta, provenance, params, forecast
WS   /api/incidents/:id/stream
   → hello (JSON)          protocol version + the DTO again
   → terrain frame (bin)   elevation + fuel, once
   → full state frame      the whole grid
   → control (JSON)        playing, speed
   → delta state frames    ~1–3 kB at 10 Hz thereafter
```

A scenario whose `id` starts with `at:` is a custom location and is sent as coordinates;
a bookmark is sent by id so the server keeps its hand-tuned placeholder terrain. Hillshade is
**not** sent — the client recomputes it with `computeShade`, saving 4 bytes per cell.

## 4. Incident creation on the server — `api/src/incident.ts`

`Incident.create` builds the procedural grid, then resolves every provider port that needs only
the grid **concurrently in one `Promise.all`**, so creation costs the slowest fetch (~7 s) rather
than the sum:

```
elevation · fuel · canopy · barriers · valuesAtRisk · observer · burnHistory · weather
```

then, sequentially, `wind` (needs elevation) and the moisture model. Adding an `await` in front
of one of the concurrent ports instead of a slot in the array puts its latency on the critical
path.

`api/src/providers/registry.ts` is the **only** file that names concrete implementations, and
`FIREWATCH_MODE` flips the whole set:

| Port | live | offline |
|---|---|---|
| elevation | `terrarium-dem` | `procedural-dem` |
| fuel | `landfire-fbfm40` (CONUS) → `esa-worldcover` (Sentinel-2 SCL authoritative for water/snow) | `topography-fuel` |
| canopy | `landfire-gbt-canopy` (trees trained on LANDFIRE CBH/CBD) | `assumed-canopy` |
| barriers | `osm-barriers` (Overpass) | `no-barriers` |
| burnHistory | `sentinel2-dnbr` | `no-burn-history` |
| weather | `open-meteo` | `mock-forecast` |
| wind | `open-meteo-windfield` | `uniform-wind` |
| moisture | `nfdrs-1h-timelag` | `rh-fuel-moisture` |
| observer | `firms-perimeter` (NASA FIRMS) | `no-observations` |
| valuesAtRisk | `osm-buildings` | `density-values-at-risk` |

Every provider returns `Provided<T>` = data **plus** `Provenance` (`measured` / `derived` /
`synthetic`, native resolution, observation time, coverage, note). All ten are recorded on
`Incident.provenance`, shipped in the `IncidentDto`, summarised in the header chip and listed in
full by the ⓘ `DataSources` modal. A port missing from that record is a mocked source the UI
never mentions — that is the rule the port design exists to enforce.

What the resolved data becomes:

- elevation + fuel → the `Terrain`; `attachCanopy` wires the canopy layer for crown fire
- barriers → `Incident.blockFrac`, `cols*rows*8` per-edge obstruction fractions
- valuesAtRisk → per-cell building counts, replacing the 3-per-hectare estimate
- burnHistory → graded reduction of `sim.fuelLeft` where a recent scar is measured
- weather → the forecast and the initial `params`
- wind + moisture → per-cell fields, rebuilt by `rebuildFields()` only when the weather signature
  actually moves
- observer → recorded only; §6's assimilation loop does not exist yet

## 5. The clock

Both sides advance the kernel identically — same `DT = 10` sim-seconds, same 90-step ceiling per
tick — because it is the same `@firewatch/sim` code and divergence would show as a fire that
behaves differently depending on where it ran.

**Local** — inside the rAF loop in `App.tsx`:

```
frame(now):
  realDt = min(0.1, elapsed)
  transport.advance(realDt, params)     // accumulate carry, run floor(carry/DT) steps
  drawRef.current?.()                   // canvas redraw, every frame
  every 0.2 s: sample() → setStats/setSimTime   // React state at 5 Hz only
```

**Remote** — `transport.advance()` is a no-op; the server drives the clock. A `setInterval` per
session at `tickMs` (100 ms) calls `Incident.tick()` and broadcasts. The client's rAF loop still
draws every frame and still samples at 5 Hz.

`sample()` must be called: perimeter and containment need a full-grid pass, so stepping without
sampling silently freezes every read-out. Local recomputes; remote returns what the server sent.

## 6. One simulation step — `sim/src/model.ts:step()`

The kernel is Finney (2002) **Minimum Travel Time** over the 8-neighbour lattice, with a
Richards (1990) elliptical spread template.

Per active cell:

1. **Consume fuel** — `fuelLeft -= load/burnDuration * dt`; at zero the cell becomes `Burned`.
2. **Relax outgoing links** (`relax`) — for each of 8 neighbours: skip if already burning, if
   unburnable (`load <= 0`), if dozer-treated, or if fully blocked. Compute the head rate
   `baseRos · moisture damping · temperature · slope · φ_w`, project it onto the ellipse with
   `ellipseShape(e, cos θ)`, scale by `(1 - blockFrac)` and by 0.12 for retardant. Push the
   arrival time `base + dist/ros` onto the heap if it improves.
3. **Byram intensity** `I = H·w·ROS` from the *head* rate (`cellHeadRos`), not the lattice max.
4. **Crown fire** (Van Wagner) — initiation `I ≥ I_0(CBH)`, active crowning `R ≥ 3.0/CBD`. Both
   → `Crown.Active`; initiation alone → `Crown.Passive` (torching), which mainly throws embers.
5. **Spotting** — stochastic, wind-driven, boosted 2–3× under torching/crowning.
6. **Suppression** — probabilistic knock-down, gated on `cellMaxRos` (the fastest edge actually
   leaving the cell, because a crew holds the edge in front of them), not the head rate.
7. **Rain knock-down** — probabilistic, from precipitation.

Then the **search half**: pop every arrival due before `now + dt`, earliest first. Each popped
cell is marked `Burning`, records its true (non-quantised) `ignitedAt`, and immediately relaxes
its own links — so a chain of cells can ignite within one step. Stale heap entries are discarded
by the `arrival[j] !== t` check. Spot fires land last, whole.

Two behaviours worth knowing:

- **The frontier is not reseeded when the weather moves.** MTT assumes a static rate field, but
  reseeding discards queued arrivals and a link slower than one step would restart forever. The
  frontier is only one ring deep, so the error is bounded to one cell and self-corrects.
- **Treatment changes *do* reseed** — `invalidateFront` is called after `clearTreatment`, because
  a control line drawn in front of a fire not stopping it is the one thing this cannot get wrong.

Every relation named here is written out in **Appendix A**, with its source and where it lives.

`recomputeStats()` is the separate O(cells) pass — area, perimeter, containment, structures —
run once per rendered frame, not per step. `burnedCells`, `wuiCells`, `spotFires`, `peakRos` and
`crownCells` are maintained incrementally inside `step()`.

## 7. State on the wire — `contracts/src/codec.ts`

Control is JSON (rare, wants to be readable); fire state is binary (10 Hz, wants to be small).

`Incident.encode(full)` diffs the grid against `shadowState`/`shadowTreatment` — a full 132k-cell
compare is ~0.2 ms and is provably correct. Fire is monotone, so the changed set stays a thin
band at the front rather than growing with the scar. A frame carries:

- header: time, revision, activeCells, peakIntensity, peakRos, 12 stat fields
- changed cells: `u32 index + u8 state + f32 ignitedAt`
- changed treatments: `u32 index + u8 kind`
- flaming cells: `u32 index + u8 intensity` — **only** cells inside their flaming window, the
  only place the renderer reads intensity

`RemoteTransport.applyState` writes those into the mirrored `Sim`, zeroing last frame's lit cells
first so cells that stopped flaming do not keep a hot core, and takes the server's `revision` as
authoritative. Encode and decode must change together; a drift is silent and renders as a
corrupted fire rather than an error.

The server never clears its shadow arrays on reset — leaving them stale is what makes the next
delta emit every burnt cell as unburned.

## 8. Rendering — `src/render/` + `MapView`

Leaflet draws basemap tiles; a canvas positioned **over** the map draws the fire.

```
sim.state / ignitedAt / intensity / treatment
   └─ contour.ts      blur the field, trace with d3-contour, round corners
        └─ fireGeometry.ts   Path2D objects in GRID coordinates
             └─ MapView      canvas transform grid→map, fill the paths
```

- Geometry is rebuilt at ~20 Hz (throttled on `performance.now()`), and skipped entirely when
  neither `sim.time` nor `sim.revision` changed. **Any mutation of the grid outside `step()` must
  bump `sim.revision`** or it is invisible while paused.
- Pan and zoom redraw at full frame rate, because only the transform changes.
- `paint.ts` renders the base raster (one pixel per cell: fuel, elevation, contour lines) and is
  repainted only when the layer key changes — skipped entirely over map tiles unless the fuel
  tint is on.
- **Burning and flaming are separate fields**: a cell smoulders for its whole burnout time but
  flames only for the first minutes.
- Arrival-time isochrone bands are frozen and cached once the clock passes their cutoff.
- `thermal.ts` renders apparent temperature `T_amb + 1050·tanh(I/I_ref)` as a raster, not
  contours, on a fixed ambient→ambient+1050 K scale. It **replaces** the fire graphics rather
  than tinting them; control lines still draw. FIRMS markers reuse the same ramp keyed on
  measured brightness temperature, which is what makes modelled and observed heat comparable.
- The canvas mirrors Leaflet's `zoomanim` with a CSS transform (250 ms, `cubic-bezier(0,0,.25,1)`)
  and clears it on `zoomend`/`viewreset` — without it the tiles glide and the fire snaps.

## 9. What a user action does

| Action | Local | Remote |
|---|---|---|
| Click map with Ignite | `ignite(sim, col, row, 1)`, record the op, start playing | `{type:'ignite', col, row, radius:1}` over the socket |
| Drag with Dozer / Retardant | `paintTreatment(...)`, interpolating cells between drag points so the line has no gaps | `{type:'treat', ...}` per stamped cell |
| Clear lines | `treatment.fill(0)` + `invalidateFront` + `revision++` | `{type:'clearTreatment'}` |
| Weather slider / preset | `setParams` → read on each `advance()` | `{type:'params', patch}` |
| Play / pause / speed | `setControl` | `{type:'control', playing, speed}` |
| Reset (`R`) | fresh `createSim` over the same terrain | `{type:'reset'}`; server re-attaches the canopy layer |
| Pick a location | new `Scenario` value → `useFireSource` re-runs the whole §3 flow | same, plus a new incident |

Controls that are toggled while looking at the map live **on** the map (`MapTools`, `.hud-tl`):
Ignite / Dozer / Retardant are drawing tools, Pan is the absence of one, and Thermal /
Isochrones / Fires are view toggles. The sidebar `ControlPanel` keeps only basemap configuration
and the weather sliders — things you set once. Every map-tool button needs an explicit
`aria-label`, because the visible label is hidden below 1600 px.

`Show current fires` needs the server: FIRMS sends no CORS headers, so the checkbox is disabled
when `VITE_API_URL` is unset. `GET /api/fires` proxies it, caching the ~6 MB global 24 h CSV for
15 minutes and collapsing concurrent misses onto one in-flight request.

Location search goes to Open-Meteo's geocoder — directly from the browser in local mode (it is
CORS-clean), or through `GET /api/geocode` when a server is configured.

## 10. Teardown

`RemoteTransport.dispose` closes the socket **and** sends `DELETE /api/incidents/:id` with
`keepalive`. Closing a socket alone does not release the incident. The server's reaper drops
sessions with no sockets after `IDLE_TIMEOUT_MS` (60 s) as the backstop for a browser that
crashed. Without both, repeated scenario changes walk into `maxIncidents` (32).

## 11. Flows that are not the app

Run from `frontend/`:

| Command | What it exercises |
|---|---|
| `npm run dev` | API on :8787 and Vite on :5173, wired together |
| `npm run dev:web` / `dev:api` | one side only; `FIREWATCH_MODE=offline` makes the API fully procedural and hermetic |
| `npm run smoke` | Playwright drives every UI control in headless Chromium, fails on any console error. Needs a dev server. Both local and remote modes must pass before a transport change lands |
| `npm run smoke:api` | boots the real server, drives an incident, decodes the binary frames with a client-side mirror. Offline by default |
| `npm test` | kernel physics tests on Node's built-in runner |
| `npm run bench` | the kernel against a direct Rothermel (1972) implementation on identical inputs |
| `npm run hindcast` | replays real fires against WFIGS interagency perimeters with Open-Meteo archive weather |
| `npm run watercheck` / `barriercheck` / `scarcheck` | provider diagnostics: the fuel classifier against six hard water bodies, OSM barrier geometry and whether the kernel honours it, burn-scar extraction |

Hindcast numbers are research measurements, not operational accuracy: ignition is the reported
point of origin or the perimeter centroid, the replay is scored against fires that were mostly
fought, and the model does not yet beat an equal-area disc on a suppressed fire.

## 12. Constraints the flow depends on

- **Node runs the backend TypeScript directly** — type-stripping only, no build step. Nothing in
  `api/` or `sim/` may use non-erasable syntax: no `enum`, `namespace`, parameter properties or
  decorators. `erasableSyntaxOnly` makes `tsc` reject them.
- Local imports carry explicit `.ts`/`.tsx`; cross-package imports use subpath exports and carry
  none. A new file in `sim/` or `contracts/` must be added to that package's `exports` map.
- `strict`, `noUnusedLocals` and `noUnusedParameters` are on everywhere.
- `windDir` is the direction the wind blows **from**, clockwise from north. Grid rows increase
  **southward**. Wind field vectors are `u` east, `v` north — so the field and the grid disagree
  by a sign, and a uniform field must reproduce the scalar path bit for bit.
- `DT` is fixed at 10 s; grid size comes from `TARGET_COLS = 400` (~38 m cells, ~130k cells for a
  15 km scenario).

---

# Appendix A — The equations

Every physical relation the model evaluates, what it is, and where it lives. The house rule in
this codebase is that each term in `step()` is a one-or-two-line simplification of a real
relation, kept short, with a comment naming the real thing — being individually defensible is
the point. This appendix is that list made explicit.

Units are stated per formula; they are **not** uniform, because the published constants are not.
Rothermel is imperial internally because that is the form its constants are published in —
converting the constants rather than the inputs is how sign and exponent errors get introduced.

## A.1 Fire spread — the kernel

### Minimum Travel Time (Finney 2002)

The propagation scheme. Arrival time at a cell is the shortest path over the 8-neighbour node
network, solved by Dijkstra with a lazily-deleted binary min-heap.

```
t_j  =  min over neighbours i of  [ t_i + d_ij / R(θ_ij) ]
```

`sim/src/model.ts:610` (`relax`, edge relaxation) and `:523` (`step`, the settle loop);
`sim/src/heap.ts` is the heap. Travel time is a real number, so arrival is not quantised to
`dt` — which is what removed the old `cellSize/dt` ceiling on head-fire rate and the
percolation overshoot of the Bernoulli-draw scheme it replaced (`p = 1 − exp(−R·Δt/d)`).

Stale heap entries are discarded on pop by the `arrival[j] !== t` test; lazy deletion is used
instead of decrease-key so no cell→heap-position index has to be maintained.

### Directional rate — Richards (1990) elliptical propagation

The formulation under FARSITE, FlamMap, Prometheus and Cell2Fire. The ignition point sits at the
**rear focus** of the ellipse:

```
R(θ)  =  R_head · (1 − e) / (1 − e·cos θ)

  θ = 0     →  1            head
  θ = 90°   →  (1 − e)      flank (the semi-latus rectum)
  θ = 180°  →  (1−e)/(1+e)  backing edge
```

`sim/src/model.ts:440` (`ellipseShape`). Integrating it recovers L/B by construction — the
property the earlier cosine-scaled `φ_w` lacked.

### Eccentricity from wind — Anderson (1983)

```
L/B  =  0.936·e^(0.2566·U_mph)  +  0.461·e^(−0.1548·U_mph)  −  0.397
e    =  sqrt(1 − 1/(L/B)²)
```

`sim/src/shape.ts:80` (`andersonLB`), `sim/src/model.ts:421` (`ellipseEccentricity`).
`U_mph` is **midflame** wind. Calm air gives L/B = 1 exactly, hence e = 0 and a circle.
Capped at `MAX_LB = 8`: Anderson's fit is calibrated to ~10 mi/h midflame and diverges above it
(65 km/h would give L/B 56, a backing rate of 1/12,500 of the head), and FARSITE caps it for the
same reason.

### Head-fire rate for a cell

```
R_head  =  baseRos · η_M · η_T · φ_slope · (1 + φ_w)
```

assembled in `relax` (`sim/src/model.ts:610`). Each factor:

| Term | Formula | Source |
|---|---|---|
| `baseRos` | tabulated per fuel, m/s | `sim/src/fuels.ts` — **invented, not measured** |
| moisture damping `η_M` | `1 − 2.59·r + 5.11·r² − 3.52·r³`, `r = min(M/M_x, 1)` — Rothermel's own, exactly zero at extinction | `model.ts` `moistureDamping` |
| temperature `η_T` | `max(0.2, 1 + 0.018·(T − 20))` | `model.ts` |
| slope `φ_slope` | `min(8, exp(0.0693·θ_deg))`, θ clamped to ±25° | `model.ts` |
| wind `1 + φ_w` | Rothermel's own wind coefficient, below | `model.ts:395` |

The slope term is the 10°-per-doubling rule: `exp(0.0693·10) ≈ 2`.

### Rothermel's wind coefficient (1972)

```
φ_w  =  C · (U_ftmin)^B · (β/β_opt)^(−E)

  C     = 7.47 · exp(−0.133·σ^0.55)
  B     = 0.02526 · σ^0.54
  E     = 0.715 · exp(−3.59e−4·σ)
  β     = ρ_b / 32          packing ratio, ρ_b in lb/ft³
  β_opt = 3.348 · σ^(−0.8189)
```

`σ` is the surface-area-to-volume ratio in ft²/ft³. C, B and the packing term depend only on the
fuel bed, so they are precomputed once per fuel in `sim/src/fuels.ts:80` (`WIND_COEFFICIENTS`)
rather than per cell per step.

Two conversions matter: `MIDFLAME_FACTOR = 0.4` converts the 10 m wind the weather feed reports
to flame height (nearer 0.1–0.2 under closed canopy), and `KMH_TO_FT_MIN = 54.6807` gets into the
units the coefficients are defined in. `φ_w` is capped at `MAX_WIND_FACTOR = 1000` (~150 km/h
midflame in fine fuel) — Rothermel's formula is unbounded but BehavePlus limits effective wind
against reaction intensity, because past some speed the flame is blown off the fuel rather than
driven into it.

**This is a heading-fire term and the kernel only ever calls it with `align = 1.`** Feeding it a
reduced wind returns the head rate of a *calmer* fire, not the flank rate of this one. That was
the single largest error in the model: at 40 km/h the 45° direction got 0.59 of full `φ_w` where
the ellipse says 0.065.

### Sub-cell barriers

```
R_effective  =  R(θ) · (1 − blockFrac[i·8 + d])
```

`blockFrac` is per **edge**, not per cell — `cols·rows·8` floats indexed by the direction's
position in `NEIGHBOURS` (`model.ts:444`). It peaks around 0.6 in practice, because a 4–10 m road
inside a 30–50 m cell obstructs part of an edge rather than severing it. Retardant multiplies by
0.12; a dozer line is a hard skip; spotting ignores both, because an ember crosses a road.

## A.2 Combustion and fire behaviour

### Byram (1959) fireline intensity

```
I  =  H · w · R          kW/m,  H = 18,600 kJ/kg
```

`sim/src/model.ts`, inside `step`. `R` here is `cellHeadRos`, the pre-ellipse **head** rate —
not the lattice maximum, because reading intensity off the lattice would make a fire's reported
intensity depend on the wind's bearing relative to the grid.

Under crowning, canopy load joins the heat release: `I = H·(w_surface + w_canopy·share)·R`, with
`share` = 1 for an active crown fire and 0.3 for torching.

### Byram flame length

```
L  =  0.0775 · I^0.46      m
```

`sim/src/model.ts:867` (`recomputeStats`), reported in the stats panel.

### Residence and burnout

```
burnout  =  360 + 900·w        seconds   (model.ts:342)
flaming  =   60 +  60·w        seconds   (fuels.ts:100)
```

Burning and flaming are deliberately different fields: a cell smoulders for its whole burnout
time but flames only for the first minutes. `flamingTime` is also what decides which cells'
intensity is worth putting on the wire.

## A.3 Crown fire — Van Wagner (1977), two criteria

Both must hold for an active crown fire. Initiation alone gives torching.

```
initiation:   I  ≥  I_0  =  [ 0.010 · CBH · (460 + 25.9·M_f) ]^1.5     kW/m
active:       R  ≥  R_0  =  3.0 / CBD                                  m/min
```

`sim/src/model.ts:280` and `:290`. `CBH` is canopy base height (m), `CBD` canopy bulk density
(kg/m³), `M_f` foliar moisture — fixed at 100%, because nothing in the model tracks the seasonal
physiology that drives it. A 5 m base at 100% gives I₀ ≈ 1880 kW/m. `3.0` is the critical mass
flow rate, kg·m⁻²·min⁻¹; sparse canopy needs a faster fire to keep itself alight, which is why
CBD is in the denominator.

Crown fuel burns out on a `residence` of 60 s (active) or 180 s (torching).

**Van Wagner's `R` is now the rate the kernel reports.** This used to be a problem: the front
advanced at 4.45× the nominal rate, so feeding the emergent rate into `R ≥ 3.0/CBD` would have
multiplied in a defect's magnitude, and a test asserted that realistic canopy must *not* crown
actively. Minimum-travel-time propagation closed that gap to a few per cent, so `cellHeadRos` — the
pre-ellipse head rate — is fed directly.

`cellHeadRos` and `cellMaxRos` are deliberately different numbers. Byram intensity, Van Wagner
crowning and the `peakRos` read-out use the head rate; suppression uses the fastest edge actually
leaving the cell, because a crew holds the edge in front of them. Reading intensity off the
lattice maximum instead would make a fire's reported intensity depend on the wind's bearing
relative to the grid, since the eight directions can sit 22.5° off the wind where the ellipse
factor is only 0.6.

## A.4 Spotting — stochastic

Not a physical trajectory model. An ember either starts a fire or it does not; there is no
travel time to accumulate.

```
p_spot  =  spotting_fuel · boost · spotting_param · (U/60) · (Δt/60) · 0.06
range   =  2 + rand·(U · 90 · crownFactor / cellSize)        cells
bearing =  wind bearing ± 34° jitter
```

Gated on `U > 3 m/s` and `I > 1500 kW/m`. `boost` is 3 under active crowning, 2 under torching,
1 otherwise — burning foliage is lofted from the top of the canopy, so it starts higher and
travels further.

## A.5 Suppression and rain — exponential hazards

```
holdable  =  max(0, 1 − R_maxEdge / 0.4)
p_out     =  1 − exp( −effort · holdable · Δt/1800 )

p_quench  =  1 − exp( −0.0004 · precip · Δt )
```

Suppression reads `cellMaxRos` — the fastest edge actually leaving the cell — not the head rate,
because a crew holds the edge in front of them, and on a flank that is far slower than the head.

## A.6 Rothermel (1972) — the external reference

Implemented in full in `sim/src/rothermel.ts:82` as an **independent check**, not as the kernel.
It shares no structure with the kernel: it derives spread from a heat balance where the kernel
multiplies a tabulated base rate by empirical factors, so agreement between them means something.

```
R  =  I_R · ξ · (1 + φ_w + φ_s)  /  (ρ_b · ε · Q_ig)
```

| Term | Formula |
|---|---|
| reaction intensity | `I_R = Γ' · w_n · h · η_M · η_s` |
| optimum reaction velocity | `Γ'_max = σ^1.5 / (495 + 0.0594·σ^1.5)`, `Γ' = Γ'_max·ratio^A·exp(A(1−ratio))`, `A = 133·σ^−0.7913` |
| moisture damping | `η_M = 1 − 2.59·r_m + 5.11·r_m² − 3.52·r_m³`, `r_m = min(M/M_x, 1)` |
| mineral damping | `η_s = min(1, 0.174·S_e^−0.19)`, `S_e = 0.010` |
| net fuel load | `w_n = w_0 / (1 + S_T)`, `S_T = 0.0555` |
| propagating flux ratio | `ξ = exp[(0.792 + 0.681·√σ)(β + 0.1)] / (192 + 0.2595·σ)` |
| wind | `φ_w = C·U^B·(β/β_opt)^−E` (as A.1) |
| slope | `φ_s = 5.275·β^−0.3·tan²φ` |
| effective heating number | `ε = exp(−138/σ)` |
| heat of preignition | `Q_ig = 250 + 1116·M` |

Heat content `h` = 8000 Btu/lb, particle density 32 lb/ft³.

**Single fuel particle only.** Rothermel's full model weights load and SAV across size classes
(1-h, 10-h, 100-h, live) before entering the heat balance; this implementation treats the bed as
one particle. Validated against published BehavePlus output: FM1 (short grass, nearly all 1-h)
agrees to 4% — 26.97 vs 26.0 m/min. FM2, FM8 and FM10 are multi-class and disagree by 2–4×, and
are present only to document that limit. It is sound for exactly the fuels it is used on, because
this kernel's own `FUELS` are also single-load, single-SAV models.

The `fineLoad` vs `load` distinction is load-bearing for the same reason: only the 1-h fraction is
the heat sink in the preignition term. Timber is 5.5 kg/m² total but ~0.9 fine, which is why it
ignites at all — applying `Q_ig` to the whole bed makes heavy fuels non-ignitable.

**Current benchmark** (`npm run bench`): `nominal/Rothermel` is now constant per fuel across wind
speeds (grass 1.14× at 0, 15 and 40 km/h, previously 1.14 / 0.20 / 0.06). That constancy is the
signature of a correct wind response; the residual is a per-fuel offset in the base-rate table,
which is not being "fixed" by matching Rothermel because those beds were invented rather than
measured.

## A.7 Weather, moisture and fire danger

### Equilibrium moisture content — the NFDRS/Simard piecewise fit

```
H < 10:   EMC = 0.03229 + 0.281073·H − 0.000578·H·T_F
10 ≤ H < 50: EMC = 2.22749 + 0.160107·H − 0.014784·T_F
H ≥ 50:   EMC = 21.0606 + 0.005565·H² − 0.00035·H·T_F − 0.483199·H
```

`api/src/providers/tier2.ts:414`. `T_F` is Fahrenheit, `H` relative humidity %.

### 1-hour timelag integration

A first-order relaxation toward equilibrium, integrated hourly over 7 days of Open-Meteo history:

```
M(t+1)  =  M_target + (M(t) − M_target)·exp(−1/τ)

  dry:  τ = 1.0 h,  M_target = EMC(T, H)
  wet:  τ = 0.3 h,  M_target = min(saturation, 10 + 12·rain)
```

Wetting is minutes, drying is hours — hence the asymmetric τ. This is why rain yesterday matters;
the formula it replaced was memoryless. `compute` stays synchronous and kicks off its own history
refresh, and `warmMoistureHistory` is awaited at incident creation so the first field has real
data.

Terrain then adjusts it (aspect, elevation) — stated as an assumption, not an observation.

### Browser-side moisture stand-in

Local mode has no history feed, so it uses a memoryless approximation:

```
M  =  3 + 0.34·H − 0.18·(T − 15)
M *= 1 − 0.25·min(1, daysSinceRain/60)
M += 5·precip,     clamped to [1.5, 60]
```

`sim/src/weather.ts:82`. Explicitly a rough stand-in for the NFDRS calculation above.

### Chandler Burning Index

```
CBI  =  [ (110 − 1.373·H) − 0.54·(10.2 − T) ] · 124 · 10^(−0.0142·H)  / 60
```

`sim/src/weather.ts:90`. Drives the header's fire-danger badge (Low / Moderate / High / Very
high / Extreme at 50 / 75 / 90 / 97.5).

### Gusting — a deterministic function of sim time

```
osc   = 0.55·sin(t/131) + 0.30·sin(t/47 + 1.7) + 0.15·sin(t/17 + 0.4)
U(t)  = U·(1 + 0.55·gustiness·osc)
dir(t)= dir + 18·gustiness·sin(t/89 + 2.3)
```

`sim/src/model.ts:450`. Gusting is a **time** signal, not a place signal, so it rides on top of
the spatial wind field by scaling it (`gustScale`) and veering it (`gustVeer`) rather than
replacing it.

### Synthetic diurnal forecast (offline/local only)

Cosine diurnal cycle peaking at 16:00 for temperature, inverted for humidity, with an overnight
cycle for downslope winds above 40 km/h and a sea-breeze cycle below. `sim/src/weather.ts:116`.
`forecastAt` (`:144`) interpolates linearly between hours, taking wind direction the short way
round the compass.

## A.8 Wind as a field

```
bearing_toward = (windDir + 180) mod 360
u = sin(θ)·U        east component,  m/s
v = cos(θ)·U        north component, m/s

with anomaly:  θ_i = bearing_toward + veerDeg[i],  U_i = U · speedRatio[i]
```

`api/src/providers/tier2.ts` (`windFieldFrom`). The field is fetched as an **anomaly** —
`speedRatio` and `veerDeg` against the domain mean — not as absolute wind: the data supplies
spatial shape while the slider still sets strength and bearing.

Inside `relax`, the local vector is inverted back to a bearing with `atan2(u, v)`, which already
gives the bearing the wind blows *toward*, clockwise from north.

**Sign trap:** grid rows increase southward while `v` is northward, so the two conventions
disagree by a sign. They did disagree silently once, and a uniform field produced a 26% larger
fire than the identical scalar wind. The invariant: a uniform field must reproduce the scalar
path bit for bit.

## A.9 Terrain and geometry

### Web Mercator tiling — `sim/src/geo.ts`

```
x(λ, z)  =  ((λ + 180)/360) · 2^z
y(φ, z)  =  ((1 − ln(tan φ + sec φ)/π) / 2) · 2^z
m/px     =  156543.03392 · cos φ / 2^z
```

Shared by the browser tile loader and the server one, so both address the same tile and sample
the same pixel — drift here would show as a fuel map that disagrees between client and server.

### Terrarium RGB elevation decode

```
h  =  R·256 + G + B/256 − 32768     metres
```

Transparent pixel → NaN, not −32768, or a failed tile wrecks both the hillshade and the
elevation ramp. Everything below −50 m is treated as water.

### Hillshade — standard, sun NW at 45°

```
dz/dx, dz/dy   central differences, ×1.6 vertical exaggeration
slope  = atan(hypot(dz/dx, dz/dy))
aspect = atan2(dz/dy, −dz/dx)
shade  = cos(slope)·sin(alt) + sin(slope)·cos(alt)·cos(az − aspect)
```

`sim/src/terrain.ts:270`, az = 315°, alt = 45°. The remote transport recomputes this client-side
rather than receiving it — 4 bytes per cell saved on a one-off payload.

### Procedural terrain — `sim/src/noise.ts`

Value noise with a smoothstep fade, stacked into fractal Brownian motion (`fbm`, amplitude ×0.5
and frequency ×2.03 per octave) and ridged multifractal (`ridged`, `n = (1 − |2·noise − 1|)²`,
frequency ×2.07) for sharp ridgelines instead of soft blobs. Domain-warped. The seed is derived
from the coordinates, so a location's placeholder terrain is reproducible.

## A.10 Remote sensing

### Visible-band fuel classification (the proxy)

`sim/src/classify.ts`. Per-cell band statistics, then a threshold cascade:

```
GRVI     = (G − R)/(G + R + 1)      green-red vegetation index, a visible-band NDVI stand-in
bright   = mean luminance
texture  = sqrt(E[lum²] − E[lum]²)  local σ: development has hard geometric edges
blueness = B − (R + G)/2            water is the only cover where this goes positive
```

Thresholds were tuned against measured band statistics for the Armenian scenarios via
`calibrate.html` — re-tune with `npm run calibrate`, don't guess. This is explicitly a proxy for
a fuel-model raster, not a measurement, and it fails outside its tuning region: it called the
Great Salt Lake 57% cropland and the Rio Negro 44% urban.

### Normalised Burn Ratio and dNBR

```
NBR   =  (NIR − SWIR2) / (NIR + SWIR2)
dNBR  =  NBR_pre − NBR_post
```

`api/src/providers/burnhistory.ts`. Severity classes break at dNBR 0.1 / 0.27 / 0.44 / 0.66, and
map to remaining surface fuel `[1, 0.6, 0.3, 0.15, 0.05]`. Applied to `fuelLeft` as a graded
reduction, never a mask — it is scarred timber, not suddenly barren ground — with recovery
`min(1, max(0, years/10)^0.5)` fading it out over roughly a decade, and nothing older than
12 years counted.

Two numerical traps recorded in source: **no-data must become NaN, never 0** (a granule-edge 0 in
one band makes NBR exactly ±1 and differences into an invented scar), and Sentinel-2 band DNs
carry the STAC `scale` but **not** the advertised `offset` — applying the offset gives an
impossible ρ ≈ −0.09 for deep water. A pure scale cancels in a normalised difference, so NBR
itself cannot reveal that error; only the absolute values can.

Water and snow come from the Sentinel-2 Scene Classification Layer, which **overrides** the
classifier for those two classes only. RGB cannot do that job: water is turquoise, black, pink or
brown depending on where you are, and only the NIR is consistent.

## A.11 Derived statistics

### Area, perimeter, containment — `sim/src/model.ts:867`

```
area        =  burnedCells · cellSize² / 10,000            ha
perimeter   =  edgeCount · cellSize / 1000                 km
containment =  heldEdges / edgeCount
```

The perimeter is the **4-connected** outline of everything burnt or burning. An edge counts as
held when no active flame touches it, or a control line, retardant or unburnable ground sits on
the far side.

### Length-to-breadth and bearing of a burn mask — `sim/src/shape.ts:26`

Second moments of the cell coordinates, eigenvalues of the 2×2 covariance:

```
λ₁,₂   =  tr/2 ± sqrt(tr²/4 − det)
L/B    =  sqrt(λ₁/λ₂)
bearing=  atan2(dCol, −dRow)  mod 180
```

Two traps, both found by validating against synthetic ellipses of known orientation rather than
by reading the formula: rows grow **southward**, so the compass bearing is `atan2(east, north)` =
`atan2(dCol, −dRow)` and not the math angle (which reads 90° off); and each closed form for the
major eigenvector collapses to (0,0) for a grid-aligned ellipse, so take whichever is longer.

### Dice coefficient — the hindcast score

```
Dice  =  2·|A ∩ B| / (|A| + |B|)
```

`api/src/hindcast.ts:242`. Reported against a null model — an equal-area disc at the same
ignition point — because Dice alone rewards simply getting the area right. The `gap` (model minus
circle) is the only number that says the physics is worth anything.

### Apparent temperature — the thermal view

```
T  =  T_amb + 1050·tanh(I / 2500)        flaming
T  =  T_amb + 0.34·ΔT                    smouldering
T  =  T_amb + (T_peak − T_amb)·exp(−Δt/1800)   burnt, cooling
```

`src/render/thermal.ts:65`. Saturating rather than scaling, because flame temperature is
buffered by radiative loss and entrainment — it does not climb indefinitely with intensity. This
is `ARCHITECTURE.md` §4's `T_f` map; the two must stay in sync. The scale is fixed to
ambient→ambient+1050 K rather than tracking each frame's maximum, so apparent brightness tracks
actual temperature — which is what makes modelled heat comparable against FIRMS brightness
temperature on the same ramp.

The one blur pass before colouring is a **sensor model**, standing in for a thermal camera's
point-spread function, not a smoothing hack. Two passes erase the flanks.

## A.12 Known departures from the physics

Recorded here because every one of them is measured, characterised in source, and deliberately
left in place:

| Defect | Magnitude | Why it is still there |
|---|---|---|
| Fires never stop | sheltered timber carries 189/191 replay hours | Moisture of extinction is the only halt besides rain, and that spring was genuinely dry. `SHELTER_RH_GAIN` was **not** raised to force a pause — nothing here is tuned against a Dice score. This is the largest open defect: shape decays from L/B 3.74 at hour 10 to 1.02 at hour 191 |
| Elongation reaches ~half of Anderson's L/B | flank runs 4–10× nominal, head 0.5–1.0× | Lattice, not the ellipse: an isotropic arrival overshoot (~2.8×) composes with lateral leakage through the diagonals (3.2×); 3.2 × 2.2 = 7.0 against a measured 6.9 |
| `MAX_LB = 8`, `MAX_WIND_FACTOR = 1000` | caps on unbounded formulas | Anderson's fit and Rothermel's `φ_w` both diverge outside their calibration range. The proper wind limit is a function of reaction intensity; the flat ceiling is a backstop |
| Slope is per-direction, not folded into a wind-slope vector | departs from FARSITE | The one deliberate departure from the Richards reference formulation |
| Rothermel reference is single-particle | exact for this kernel's fuels, invalid against real Anderson/Scott & Burgan models | Multi-size-class aggregation is the prerequisite for ever comparing against a real fuel model |
| `depth`, `sav`, `bulkDensity` | invented; timber depth is 0.65 m against FM8's published 0.061 | `mx` has been corrected to published Anderson values, but the bed parameters need multi-size-class Rothermel first — which is why reading operational FBFM40 fuel made the hindcast *worse*, not better. The highest-value work outstanding |
| Foliar moisture fixed at 100% | enters Van Wagner's `I_0` directly | Nothing in the model tracks seasonal plant physiology. First assumption to replace if crown behaviour needs defending |
| Barriers move Dice by < 0.003 | 30,000–46,000 blocked edges | Correct per the sub-cell design: `blockFrac` peaks near 0.6, so roads do not act as firebreaks at this resolution |

`ARCHITECTURE.md` §4 specifies the deterministic energy-accumulator kernel that removes the first
two; it is not implemented. Finney MTT (A.1) was the step before it and is what landed.
