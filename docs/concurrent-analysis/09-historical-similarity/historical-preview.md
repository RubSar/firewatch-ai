# Historical single-event viewer

The frontend's `/history` route shows one historical fire at a time on a full-width
map. Select an event, step through timestamps or play its recorded progression.
Environmental measurements, source evidence and selected-record JSON export remain
available. The current library contains 216 hourly GOFER pilot intervals and two NIFC
perimeter snapshots. Snapshot growth remains null and playback is disabled.

The event dropdown orders by **complete hourly record count**, then average availability
of the eight displayed parameters, then loaded record count, name, year and ID.
A complete hour requires a one-hour start/end interval, area and growth values, and
all eight valid displayed parameters. Snapshots cannot count as complete hours.
Options display total records and complete-hour counts; snapshots show field coverage.
This is measurement availability, not review status or completeness of every enrichment
field. Zero-growth records without new-footprint measurements remain in the library.

The first sorted event is selected on load (currently Creek: 51 complete hours out of
72). Selecting an event resets to its first timestamp, stops playback and fits extent.
Counts refer to loaded data, not the entire 28-fire archive. Missing values stay null.

The compact heading, controls and parameter strip bring the full-width map higher
on screen. Desktop map height adapts to the viewport (at least 400 px); mobile uses
60% of viewport height (at least 380 px). **Focus map** hides the introductory heading,
parameter strip and expanded snapshot note and increases map height; **Show details**
restores them. Timestamp controls and source labeling remain available in either mode.
Detailed measurement evidence remains in the source table.

Cross-event ranking, parameter group selection, combined-difference percentages and
the second map were removed from the screen at the user's request on 2026-09-27.
Historical suppression effects are not separated; the screen is an observation viewer,
not an unsuppressed simulation benchmark. The old scoring functions and research are
retained separately; the viewer neither computes nor exports similarity scores.

## Displayed data

`backend/api/historical_fire/export_preview.py` joins enriched `intervals.json`
records to the **end timestamp** in the GOFER v0.2 Combined fire-progression shapefile.
The cumulative perimeter comes directly from the archive rather than a union of
incremental growth. The orange layer is the existing newly burned footprint; null
footprints are retained. Reported cumulative area is the source `farea` in km² × 100;
reported growth is the original hectares. Display geometry alone is simplified by
20 m in EPSG:3310 and returned to GeoJSON longitude/latitude EPSG:4326. Both maps
have scale bars; linked zoom does not imply equal ground scale across latitudes.
Basemap imagery is current service imagery, not historical evidence.

GOFER top cards use **newly burned footprint** measurements: HLS NDVI/NDMI/NBR,
LANDFIRE FBFM40 sampled distributions, 3DEP slope, and ERA5-Land temperature,
humidity and wind speed (m/s × 3.6 to km/h). They never silently substitute
ignition-point weather or SRTM slope. All source measurements, including the
separately labeled ignition context and NASA additions, can be inspected below.
The full raw sidecars and coordinate-free previews are not modified by the exporter.

The static frontend file is `frontend/Wildfire/public/data/historical-pilot.json`.
It contains actual values, measurement provenance, flags, source timestamps and
checksums; there are no synthetic demonstration values. It is approximately 5.7 MB
before compression and is fetched only on the historical route. The contract is
`contracts/historical-preview.schema.json`. The exporter validates it, verifies the
source archive checksum, and rejects missing/duplicate perimeter joins.

## Archived comparison method (not used by the current screen)

This is an exploratory descriptive distance, not forecast accuracy, a probability,
or a claim that equal environmental conditions cause equal fire growth.

| Group | Field | Difference in [0, 1] |
|---|---|---|
| Vegetation | NDVI, NDMI, NBR | absolute difference / 2, capped at 1 |
| Fuels | All FBFM40 class proportions | total variation: ½ × sum of absolute differences |
| Terrain | Slope in degrees | absolute difference / 90, capped at 1 |
| Wind | Speed in km/h | absolute difference / 100, capped at 1 |
| Weather | Temperature in °C | absolute difference / 60, capped at 1 |
| Weather | Relative humidity in % | absolute difference / 100, capped at 1 |

Average the fields within each enabled group, then average the groups equally and
multiply by 100. The spans are fixed, explicitly chosen display scales; they are
not estimated from a train/test split or calibrated against outcomes. Fuel values
are normalized sampled class distributions; the label shows the dominant full
class, but matching uses every class, including nonburnable classes. The group
names follow [LANDFIRE FBFM40](https://landfire.gov/fuel/fbfm40) and the
[NWCG reference table](https://training.nwcg.gov/dl/rx300/fbfm40-reference-guide.pdf).

At least three groups must be enabled. **Every enabled parameter must be available
in both records**. Missing data never contributes zero distance. The screen shows
coverage and withholds the combined score when incomplete. Disabling a group changes
the comparison definition for every candidate; percentages across different group
selections should not be compared. Only one closest interval per other fire is
returned, with deterministic ID tie-breaking. The query fire is excluded entirely.
Area, growth, latitude, longitude and year do not enter the score.

This UI does not run the earlier normalized analog experiment or claim its validation
results apply here. Retrospective footprint selection, differing source dates and
resolutions, unreviewed measurements, and the three-fire sample remain limitations.
More groups/fields and validated scales can be introduced after review.

## Run and refresh

From `frontend`, use the existing workspace commands (Node 20+):

```sh
npm ci
npm run dev:web
# Open http://localhost:5173/history
npm run build --workspace=wildfire-sim
```

Production hosts must serve `index.html` for the `/history` SPA route.
To refresh the static library from local historical data, from `backend/api`:

```sh
./.venv/bin/python -m historical_fire.export_preview \
  --data-dir .research-data/enrichment-pilot/data \
  --archive .research-data/GOFER-v02.zip \
  --nifc-dir .research-data/nifc-pilot \
  --output ../../frontend/Wildfire/public/data/historical-pilot.json
```

Checks, from `frontend/Wildfire`, with Node 24 (native TypeScript type stripping):

```sh
node --test scripts/history.test.mjs
# With dev server running; uses installed Chrome in a temporary browser profile:
node scripts/history-smoke.mjs
```

The numerical checks cover known weighted distances, units, zero/missing values,
spatial-support separation, group eligibility, same-fire exclusion and independence
from observed growth. Browser checks cover the single map, sorted event options and counts, timestamps,
playback, snapshot null growth, record downloads, source inspection, mobile width and
load errors. Screenshots default to `/tmp/firewatch-history-single`.

The new `@firewatch/visualization` workspace makes the existing visualization folder
usable by the app. It reuses React 18 and Leaflet 1.9 already selected by the project;
the lockfile changes primarily relocate shared dependencies. No historical-data API
or model-provider integration is needed for this static research screen.
