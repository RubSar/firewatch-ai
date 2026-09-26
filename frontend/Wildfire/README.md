# 🔥 Ember — wildfire spread sandbox

An interactive wildfire simulator on a terrain map. Change the weather, the fuel
dryness and the wind, then watch how the fire behaves — where it runs, how fast,
what it threatens, and whether you can hold it.

Built as a hackathon demo, on four regions of Armenia. **Terrain and land cover
are real data pulled at runtime**; only the weather is simulated, behind an
interface designed to be swapped for a live feed (see
[Data](#data)).

```bash
npm install
npm run dev
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
| **Scenarios** | Khosrov Forest Reserve, Dilijan National Park, Kapan & Shikahogh |

Space bar plays/pauses, `R` resets.

## The model

A cellular automaton on a ~70 m grid (roughly 40,000 cells), stepped at 10
simulated seconds. It is not Rothermel, but every term is the simplified form of
something real, so the numbers it reports land in plausible ranges.

**Spread.** For each burning cell and each of its 8 neighbours, a rate of spread
is computed for the fuel being *entered*:

```
ROS = baseROS(fuel) × moisture × heat × slope × wind
```

- **Wind** is exponential in the component of wind along the spread direction,
  `exp(0.115 · U · cos θ)`. The head races, the backing edge crawls — at 65 km/h
  the head runs some 20× the backing rate.
- **Slope** doubles the rate of spread per 10° of upslope, `exp(0.0693 · φ)`,
  the standard field rule of thumb. Fires run up canyons.
- **Moisture** damps toward each fuel's *moisture of extinction*. Past it, that
  fuel will not carry fire at all — grass quits long before timber does.

Ignition is then drawn from an exponential arrival process,
`p = 1 − exp(−ROS · Δt / distance)`, which makes spread rate independent of the
step size and keeps fronts organically ragged instead of geometric.

**Fuels.** Seven simplified models after Anderson's 13, each with a spread rate,
fuel load, moisture of extinction and ember production. Vegetation is placed by
topography: cool north-facing slopes and high ground carry timber, hot south
aspects and low ground carry grass and brush, lowlands carry the WUI.

**Fuel moisture** comes from humidity, temperature and drought, in the spirit of
an NFDRS 1-hour timelag calculation. Rain puts it straight back.

**Spotting.** High-intensity cells loft embers downwind, up to roughly
`90 × windspeed` metres, which is how fires cross the lines you draw.

**Reported metrics.** Byram fireline intensity `I = H · w · ROS` and flame length
`L = 0.0775 · I^0.46`; area, perimeter and containment from the burn-scar
outline; Chandler Burning Index for the danger rating.

Every one of these is in `src/sim/` and is a few lines long — easy to point at,
easy to defend, easy to replace.

## Data

Terrain and land cover are fetched from open raster tile services when the app
loads, so the fire runs up the actual ridges of the actual place. The header chip
shows what the current scenario is running on.

| Layer | Source | Notes |
|---|---|---|
| Elevation | AWS Terrarium terrain tiles | RGB-encoded height, public, no key |
| Land cover → fuel model | Esri World Imagery | classified in-browser, see below |
| Weather | **mocked** — `src/sim/weather.ts` | swap `mockForecast()` for the NWS gridpoint API or a RAWS station pull |
| Ignition point | you click the map | in production, VIIRS / GOES active-fire detections |

Both tile services send `Access-Control-Allow-Origin: *`, so the pixels can be
read back out of a canvas. If either is unreachable the app falls back to
procedurally generated terrain and keeps running with no network at all.

### Classifying fuel from imagery

There is no free global fuel-model raster, so fuel is inferred from visible-band
satellite imagery per cell. It is a proxy, not a measurement — a production build
would read a LANDFIRE-equivalent raster instead — but the thresholds were tuned
against measured band statistics for these specific regions rather than guessed:

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
npm run dev
node scripts/calibrate.mjs      # writes shots/calibrate.png
```

Known simplifications worth naming before anyone asks: no crown fire or
spread/torching distinction, no atmospheric coupling or plume-driven indraft, no
diurnal slope/valley wind reversal, a single global fuel-moisture value rather
than per-cell timelag classes, and a uniform wind field rather than one modelled
over the terrain.

## Layout

```
src/
  sim/
    noise.ts      seeded value noise, fBm, ridged multifractal
    terrain.ts    scenarios, elevation, hillshade, fuel classification
    fuels.ts      fuel models
    weather.ts    weather, fuel moisture, fire danger, mock forecast
    model.ts      the fire spread automaton and incident statistics
  data/
    realData.ts   DEM + imagery tile fetch, and the fuel classifier
  render/
    paint.ts      base raster layers, one pixel per cell
    contour.ts    marching squares (d3-contour) + field blur + corner rounding
    fireGeometry.ts  the fire as fillable paths in grid space
  components/
    MapView.tsx   Leaflet map + canvas overlay
    ControlPanel.tsx  WindDial.tsx  StatsPanel.tsx  Legend.tsx
    GrowthChart.tsx   ForecastStrip.tsx
scripts/
  smoke.mjs       headless browser test that drives every control
  calibrate.mjs   renders the fuel-classifier calibration sheet
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

```bash
npm run dev            # in one shell
npm run smoke          # headless Chromium: drives every control, fails on any console error
```

## Attribution

Topographic tiles © OpenTopoMap (CC-BY-SA), OpenStreetMap contributors.
Satellite imagery © Esri, Maxar, Earthstar Geographics.
Elevation from AWS Terrain Tiles (Mapzen/Nextzen heritage), which credits SRTM,
ASTER and national mapping agencies.
