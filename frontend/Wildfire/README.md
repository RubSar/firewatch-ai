# 🔥 Ember — wildfire spread sandbox

An interactive wildfire simulator on a terrain map. Change the weather, the fuel
dryness and the wind, then watch how the fire behaves — where it runs, how fast,
what it threatens, and whether you can hold it.

**Simulate anywhere on earth.** Search a place name, or pan the map and press
“use this view”. Terrain, land cover and weather are real data pulled at
runtime for wherever you point it; three Armenian regions ship as bookmarks.
Real satellite fire detections can be overlaid on top (see [Data](#data)).

The fire runs either in the browser or on a server, and the UI cannot tell the
difference — see [Where the fire runs](#where-the-fire-runs).

```bash
npm install          # at the repo root: this is an npm workspace
npm run dev:web      # in-browser simulation, no server needed
```

## What you can do

| | |
|---|---|
| **Click the map** | start a fire anywhere — the map starts cold, nothing ignites on its own |
| **Weather presets** | calm morning, red flag warning, Santa Ana event, heatwave, rain band |
| **Wind dial** | drag to set direction; slider for speed and gustiness |
| **Atmosphere & fuel** | temperature, humidity, days since rain, rainfall |
| **Dozer line / retardant** | drag on the map to build control lines and watch containment climb |
| **Suppression effort** | commit crews — effective on a slow flank, near-useless on a wind-driven head |
| **Layers** | real satellite or topographic tiles, or the fuel / elevation rasters; contours, arrival-time isochrones |
| **Anywhere on earth** | search a place, or “use this view”; pick an 8–40 km area |
| **Current fires** | NASA FIRMS satellite detections from the last 24 h — click one to ignite there |
| **Thermal view** | the scene as an infrared camera sees it, on the same kelvin scale FIRMS reports |
| **Bookmarks** | Khosrov Forest Reserve, Dilijan National Park, Kapan & Shikahogh |

Space bar plays/pauses, `R` resets.

## The model

A cellular automaton on a ~38 m grid — 400 columns, so roughly 130,000 cells for
a typical scenario — stepped at 10 simulated seconds. It is not Rothermel, but
every term is the simplified form of something real, so the numbers it reports
land in plausible ranges.

**Spread.** For each burning cell and each of its 8 neighbours, a rate of spread
is computed for the fuel being *entered*:

```
ROS_head(θ=0) = baseROS(fuel) × η_M × heat × slope × (1 + φ_w)
ROS(θ)        = ROS_head × (1 − e) / (1 − e·cos θ)
```

- **Wind** uses Rothermel's own `1 + φ_w` with per-fuel coefficients, evaluated
  once at full alignment. It replaced `exp(0.115 · U)`, which reached 3.6× at
  40 km/h where Rothermel reaches 65× — badly under-predicting the dangerous case.
- **Direction** comes from Richards (1990) elliptical propagation, the
  formulation under FARSITE and FlamMap: the head rate scaled onto a spread
  ellipse whose length-to-breadth follows Anderson (1983). Feeding `φ_w` a
  cosine-reduced wind instead returns the head rate of a *calmer* fire, which
  made every fire come out circular at every wind speed.
- **Slope** doubles the rate of spread per 10° of upslope, `exp(0.0693 · φ)`,
  the standard field rule of thumb. Fires run up canyons.
- **Moisture** uses Rothermel's damping coefficient
  `η_M = 1 − 2.59r + 5.11r² − 3.52r³`, `r = fmc / mx`, which is exactly zero at
  the *moisture of extinction*. Past it that fuel will not carry at all — grass
  quits at 12%, timber holds to 25%.

Arrival is then a **minimum-travel-time** search, Finney (2002): Dijkstra over
the cell graph with link cost `distance / ROS(θ)`. It replaced a per-step
Bernoulli draw, which let the front advance by first-passage percolation over
competing paths at 4.45× the rate the model reported, and capped head-fire speed
at `cellSize / Δt`. Spread is now deterministic and matches the kernel's own
nominal rate to within 6% on every wind case the bench measures.

**Fuels.** Seven simplified models after Anderson's 13, each with a spread rate,
fuel load, moisture of extinction and ember production. Moisture of extinction is
now taken from published Anderson (1982) values — grass 12% (FM1), shrub 20%
(FM4), timber 25% (FM10); `depth`, `sav` and `bulkDensity` are still invented and
need multi-size-class Rothermel before real ones can be used. Real fuel comes
from LANDFIRE or WorldCover; the topographic placement below is the offline
fallback only.

**Fuel moisture** is an NFDRS 1-hour timelag: Simard equilibrium moisture from
temperature and humidity, stepped with a one-hour time constant over seven days
of history, with rain driving fuels toward saturation far faster than drying
returns them. Fuel under a canopy is cooler and sits in more humid air, so it
carries a sheltering correction scaled by canopy cover (Rothermel 1983).

**Spotting.** High-intensity cells loft embers downwind, up to roughly
`90 × windspeed` metres, which is how fires cross the lines you draw.

**Reported metrics.** Byram fireline intensity `I = H · w · ROS` and flame length
`L = 0.0775 · I^0.46`; area, perimeter and containment from the burn-scar
outline; Chandler Burning Index for the danger rating.

Every one of these is in `frontend/sim/` and is a few lines long — easy to point
at, easy to defend, easy to replace. That package is deliberately free of DOM and
Node APIs, so the identical stepping code runs in the browser and on the server.

`ARCHITECTURE.md` describes a different and much larger design — a 10 m energy-
accumulator kernel with crown fire and an ensemble. It is labelled as proposed
and is **not** what this code does. §4 there argues against a probabilistic
arrival formulation and quantifies its `1+√2` front-speed error — that defect is
now fixed, by minimum-travel-time propagation rather than by §4's energy
accumulator, so the front advances at the rate the model reports.

## Data

Terrain and land cover are fetched from open raster tile services when the app
loads, so the fire runs up the actual ridges of the actual place. The header chip
shows what the current scenario is running on.

| Layer | Source | Notes |
|---|---|---|
| Elevation | AWS Terrarium terrain tiles | RGB-encoded height, public, no key |
| Water & snow | **Sentinel-2 L2A Scene Classification**, AWS Open Data | keyless; measured, not inferred from colour |
| Fuel model | **LANDFIRE FBFM40** (CONUS) → **ESA WorldCover v200** (global) → Esri imagery | Scott & Burgan's 40 operational models where they exist, 11-class land cover elsewhere; the visible-band proxy is now only the last fallback |
| Canopy structure | **model trained on LANDFIRE** CBH/CBD/CC/CH | gradient-boosted trees over Sentinel-2 + terrain; predictions, not measurements — see the caveat in `providers/canopy-learned.ts` |
| Weather | real in server mode (Open-Meteo); mocked in browser mode — `frontend/sim/src/weather.ts` | `mockForecast()` and the live feed return the same shape |
| Days since rain | **Open-Meteo** daily precipitation, 61 days back | measured, not carried from the preset; ≥2 mm counts as a wetting rain |
| Barriers | **OpenStreetMap** roads and watercourses, via Overpass | keyless; server-side only. Geometry measured, widths assumed per tag |
| Structures at risk | **OpenStreetMap** building footprints, via Overpass | keyless; server-side only. A count of mapped buildings, not of buildings |
| Observed fire | **NASA FIRMS** detections rasterised onto the grid | the §6 `PerimeterObserver` port — 375 m pixels, two overpasses a day |
| Active fires | **NASA FIRMS** VIIRS (375 m) + MODIS (1 km), last 24 h | keyless; server-side only — FIRMS sends no CORS headers |
| Place search | Open-Meteo geocoding | keyless |
| Ignition point | you click the map, or a FIRMS detection | — |

Both tile services send `Access-Control-Allow-Origin: *`, so the pixels can be
read back out of a canvas. If either is unreachable the app falls back to
procedurally generated terrain and keeps running with no network at all.

### Current fires

`Show current fires` overlays NASA FIRMS active fire detections from the last
24 hours, refreshed as you pan. Marker size follows fire radiative power and
opacity follows the detection's own confidence. Clicking one ignites the model
at that point, which is the §9 `IgnitionSource` port doing its real job rather
than the click-to-ignite stand-in.

Two honest caveats, both surfaced in the UI:

- These are **thermal anomalies, not confirmed fires**. A gas flare, a furnace
  and a burning landfill all register; a cloudy overpass registers nothing.
- The layer needs the server. FIRMS serves no CORS headers, so the browser
  cannot read it directly and the checkbox is disabled in browser-only mode.

The global CSV is ~6 MB and updates about hourly, so the API fetches it once
and caches it for 15 minutes rather than pulling it per pan.

### Where the fire runs

Two transports, one renderer. `src/transport/` decides which:

| | Browser | Server |
|---|---|---|
| Start | `npm run dev:web` | `npm run dev:api`, then `VITE_API_URL=http://127.0.0.1:8787 npm run dev:web` |
| Kernel | steps in a `requestAnimationFrame` loop | steps in the API, 10 Hz |
| Wire | — | one terrain frame, then ~2.5 kB delta frames |
| Weather | mock forecast | Open-Meteo |
| Offline | always works | falls back to browser mode if the server is down |

The remote transport mirrors the wire deltas into a real `Sim` object, so
`MapView`, `fireGeometry` and `paint` are untouched and cannot tell which
transport they were handed. The header chip names what is real and what is
mocked — all ten ports now report `measured` or `derived` in live mode — because a
provider that returns data without saying where it came from is the failure mode
worth designing against.
The chip names the real ports while they fit in a header and falls back to counts
past four; the ⓘ opens the full per-port breakdown, provenance note and all.

Server-side the data sources are formal provider ports (`ARCHITECTURE.md` §9) in
`frontend/api/src/providers/`. **Every port has a real implementation**: Terrarium
DEM, LANDFIRE FBFM40 / ESA WorldCover fuel, a LANDFIRE-trained canopy model,
Open-Meteo weather and wind, NFDRS 1-h moisture, OSM barriers and buildings,
Sentinel-2 dNBR burn history, FIRMS observations. Offline mode swaps each for a
procedural or null one. Swapping any is a line in `registry.ts`.

### Barriers

Roads and watercourses are the one real input that is *geometry* rather than a
raster, and §5 is the reason they are not simply unburnable cells: a 30 m
motorway on a 38 m grid would either vanish into a cell average or eat the whole
cell. Instead each barrier obstructs a fraction of the specific cell-to-cell
edges it crosses — `blockFrac[i * 8 + d]` — and the kernel scales the spread
rate through that edge by what is left open.

Two honest caveats:

- **The block is capped at 0.95.** Embers cross every road ever built, and
  spotting is deliberately unaffected.
- **Widths are assumed per OSM tag** (`width` and `lanes` are used where they
  exist), so the provenance says `derived`, not `measured`. A motorway is taken
  as 30 m including verges, a residential street as 7 m, a stream as 5 m.

Overpass is a shared community endpoint: responses are cached on disk beside the
tiles, a 429 or 504 is retried once and then the box is quartered, and
`OVERPASS_URL` points at a private instance. Dense cities need room — every
building in a 15 km box over Athens is 20-40 s of server-side work — so Overpass
gets its own 60 s budget (`OVERPASS_TIMEOUT_MS`) while callers wait 9 s and move
on, picking the result up from cache on the next incident. If it stays
unreachable the port degrades to `no-barriers` and the chip says so.

### Structures at risk

The same Overpass round trip also counts **building footprints** per cell
(`out center` — one point per building rather than its outline), so "structures
lost" is a count of mapped buildings inside the burn scar instead of
`STRUCTURES_PER_HA = 3` times the burnt area the imagery called developed. Over
Dilijan the two differ by an order of magnitude, mostly because the visible-band
classifier under-detects town.

It can only ever under-count: a building nobody has mapped is not there, and
occupancy is assumed at 2.5 people per structure, which is why the port reports
`derived` rather than `measured`. The stats panel footnote changes with the
source, so the number on screen always says which of the two it is.

### Thermal (infrared) view

`Thermal (infrared) view` renders apparent temperature instead of the fire's own
colours. It is not a filter over the flame graphics — those are switched off and
the temperature field replaces them, because a thermal image is a measurement
and blending it with stylised colours would make it decoration.

Apparent temperature follows the saturating map in `ARCHITECTURE.md` §4:
`T = T_ambient + 1050 K · tanh(I / I_ref)`, where `I` is Byram fireline
intensity. Flame temperature is buffered by radiative loss and entrainment, so
it saturates rather than climbing with intensity. Cells that are burning but
past their flaming window run at a third of that, and burnt ground cools
exponentially back toward ambient with a 30-minute time constant.

Two things the visible view cannot show at all: **smouldering**, and **how long
ago** ground burnt. In infrared a four-hour-old scar is simply cold, which is
what a real IR frame looks like.

The field is blurred once before colouring. That models the sensor's
point-spread function — a real thermal camera never produces single-pixel
speckle — and it is one pass only, because the flanks are barely a cell wide
and a second pass erases them.

With `Show current fires` on at the same time, FIRMS detections are coloured by
their **measured** brightness temperature on the identical scale, so modelled
and observed heat can be compared directly. That comparison is the validation
idea in §6, where `maxTemp` is scored against radiometric IR rather than used
as a driver. The legend says *modelled, not measured* because the raster is the
model's opinion and only the markers are data.

### Why water needs the near-infrared

Water cannot be identified reliably from RGB. It is turquoise at Lake Sevan,
deep blue at Tahoe, pink at the Great Salt Lake, black at the Rio Negro and
brown wherever there is silt. A threshold tuned on one of those is wrong on the
others, and the failure mode is bad: an unrecognised lake is classified as fuel
and **burns**.

Measured, on 15 km squares centred on open water:

| | visible-band only | with Sentinel-2 SCL |
|---|---|---|
| Great Salt Lake | 38.6% water, 56.6% called *cropland* | **99.9%** |
| Rio Negro | 8.3% water, 44% called *urban* | **22.9%** |
| Lake Sevan | 96.0% | **100.0%** |
| Lake Geneva | 63.1% | 68.6% |

The fix is not another threshold — it is the near-infrared, where water is dark
regardless of what colour it looks to a human eye. ESA already runs a
classifier over the full 13-band stack and publishes it as the **Scene
Classification Layer**, so the server reads that instead of re-deriving a worse
version from three visible bands. No key and no Earth Engine account: the L2A
COGs are on AWS Open Data and searchable through a public STAC API.

SCL is treated as **authoritative for water and snow** — the classes it is
unambiguous about — and ignored elsewhere, because it cannot separate timber
from scrub from grass, which is what the fuel model actually needs. Cloud,
shadow and coverage gaps fall through to the visible-band rules, so it can
never make the map worse than it was.

Two limits worth stating. Reading a COG window takes 10–30 seconds cold, so the
lookup runs against a 6-second budget and the area loads on the RGB proxy if it
misses — the result is cached, so the next visit to the same place gets the
measured version. And this only runs server-side; browser-only mode keeps the
proxy, which is fine in Armenia and unreliable elsewhere. The header chip says
which one produced the map.

```bash
npm run watercheck   # classifier accuracy over six hard water bodies
```

### Classifying fuel from imagery

**This is now the last fallback, not the primary path.** Live mode reads LANDFIRE
FBFM40 inside CONUS and ESA WorldCover globally; the visible-band classifier only
runs when both are unavailable, and offline mode uses topographic rules instead.
It is kept because it needs no network beyond a basemap tile, which is what makes
browser-only mode work.

It is a proxy, not a measurement, but the thresholds were tuned against measured
band statistics for these specific regions rather than guessed:

- **Water** is found by *blueness*, not greenness. Lake Sevan is turquoise, so
  green sits far above red and a vegetation index confidently calls the lake
  dense forest. Blue is the weakest band over every vegetated surface in these
  regions and goes positive only over water.
- **Development** is found by local texture: buildings and roads give a variance
  that neither canopy nor bare ground produces.
- **Timber vs. open scrub** is brightness — closed canopy is green *and* dark.
  This is what separates Dilijan's forest from Khosrov's juniper steppe.
- **Forest vs. cropland** is slope. Dark green on flat valley floor is irrigated
  farmland; Armenia's woodland is on the hillsides. The distinction matters
  because timber carries four times the fuel load of a field.

`calibrate.html` renders imagery, the resulting classification and the DEM
hillshade side by side with band percentiles, for retuning those thresholds:

```bash
npm run dev:web                 # from frontend/
npm run calibrate               # from frontend/Wildfire, writes shots/calibrate.png
```

Known simplifications worth naming before anyone asks: no crown fire or
spread/torching distinction, no atmospheric coupling or plume-driven indraft, no
diurnal slope/valley wind reversal, a single global fuel-moisture value rather
than per-cell timelag classes, and a uniform wind field rather than one modelled
over the terrain.

## Layout

Everything lives under `frontend/`, which is the npm workspace root. The repo's
`backend/` and top-level `contracts/` directories are untouched team scaffolds.

```
frontend/                     workspace root — run every script from here
  sim/src/                    @firewatch/sim · DOM-free, runs in browser and Node
    noise.ts                  seeded value noise, fBm, ridged multifractal
    terrain.ts                scenarios, elevation, hillshade, procedural fuel
    fuels.ts                  fuel models
    classify.ts               visible-band fuel classifier (shared both sides)
    geo.ts                    web-Mercator tile math (shared both sides)
    weather.ts                weather, fuel moisture, fire danger, mock forecast
    model.ts                  the kernel: MTT propagation, crown fire, statistics
    heap.ts                   indexed min-heap for the minimum-travel-time front
    rothermel.ts              independent Rothermel (1972) reference for the bench
    shape.ts                  burn length-to-breadth and major-axis bearing
    shelter.ts                canopy sheltering of dead fine fuel moisture

  contracts/src/              @firewatch/contracts · types and codec only
    providers.ts              the §9 provider ports, Provenance / Provided<T>
    wire.ts                   REST DTOs, commands, server events
    codec.ts                  binary encode/decode for the state channel

  api/src/                    @firewatch/api · Fastify, kernel runs server-side
    server.ts                 REST + WebSocket
    incident.ts               one fire: sim, clock, delta vs what clients saw
    providers/                registry.ts is the only file naming implementations
    canopy/                   the canopy model: features, sampler, trainer, trees
    hindcast.ts               replays real fires against mapped WFIGS perimeters
    smoke.ts                  boots the server and decodes the stream

  Wildfire/                   this app
    src/data/realData.ts      DEM + imagery tile fetch in the browser
    src/transport/
      local.ts                steps the kernel in the browser
      remote.ts               mirrors server deltas into a Sim
    src/render/
      paint.ts                base raster layers, one pixel per cell
      contour.ts              marching squares + field blur + corner rounding
      fireGeometry.ts         the fire as fillable paths in grid space
    src/components/
      MapView.tsx             Leaflet map + canvas overlay
      ControlPanel.tsx  WindDial.tsx  StatsPanel.tsx  Legend.tsx
      GrowthChart.tsx   ForecastStrip.tsx
    scripts/
      smoke.mjs               headless browser test driving every control
      calibrate.mjs           renders the fuel-classifier calibration sheet
```

The map is Leaflet. The fire is **not** drawn as a raster: scaling up a grid of
38 m cells turns every cell into a visible square the moment you zoom in. Instead
the burn scar, the flaming front and the isochrone bands are traced into vector
paths with `d3-contour` — blurring the field first and rounding corners after, so
a staircase of cells becomes an organic perimeter that stays crisp at any zoom.

Those paths are built in *grid* coordinates and rebuilt at 20 Hz; each frame only
changes the canvas transform, so panning and zooming stay at full frame rate
while contour tracing runs a third as often.

A cell keeps burning for its whole burnout time — up to an hour in timber — but
only *flames* for the first few minutes. Drawing both the same way gives a
kilometre-deep wall of orange, so the two are separated: a narrow bright front,
graded by fireline intensity, over a broad dark smouldering zone.

Simulation state lives in typed arrays outside React — React re-renders at 5 Hz
for the read-outs only.

## Tests

Two smoke suites, no unit tests and no linter.

```bash
npm run dev:web                     # in one shell, then:
npm run smoke                       # headless Chromium: drives every control,
                                    # fails on any console error

npm run smoke:api                   # boots the API, drives an incident, decodes
                                    # the binary stream. Offline, deterministic
FIREWATCH_MODE=live npm run smoke:api
```

The UI suite honours `APP_URL`, so pointing it at a `VITE_API_URL`-configured
dev server exercises server mode. **Both modes must pass before a transport
change lands** — the two that caught real bugs here were a frozen read-out and a
reset that cleared the statistics while leaving the burn scar on screen, neither
of which the type checker could see.

## Attribution

Topographic tiles © OpenTopoMap (CC-BY-SA), OpenStreetMap contributors.
Satellite imagery © Esri, Maxar, Earthstar Geographics.
Elevation from AWS Terrain Tiles (Mapzen/Nextzen heritage), which credits SRTM,
ASTER and national mapping agencies.
