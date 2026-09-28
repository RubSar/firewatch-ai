# GOFER historical-data enrichment pilot

This is a research-only data-quality pilot. It enriches the first 72 one-hour GOFER intervals for Creek (2020), Kincade (2019), and Bobcat (2020). It does not predict future fire growth or alter the GOFER source archive.

These instructions describe the original base enrichment. For a fresh contribution,
use the [current reproduction guide](../../research-data/reproduce.md), which preserves
the ordering of base and NASA enrichment and uses new output directories.

## Run

Install the API research extra, set up Earth Engine authentication, and run from `backend/api`:

```sh
uv sync --frozen --extra research
uv run --frozen --extra research python -m historical_fire.enrichment_run \
  --archive /path/to/GOFER-v0.2.zip \
  --summary .research-data/GOFERC_summary.csv \
  --output .research-data/enrichment-pilot/data \
  --project YOUR_EARTH_ENGINE_PROJECT
```

Repeat with `--event gofer:2020:Creek` to run the Creek-only first deliverable, then repeat for the other IDs. Raw API responses are checksum-keyed/cacheable under the output folder. The immutable GOFER archive and summary are identified by SHA-256.

The interval footprint is the EPSG:4326 difference between the two successive GOFER perimeters, with area checks in EPSG:3310. A zero-growth or geometrically empty interval retains a null footprint and a separate ignition-point context. ERA5-Land instantaneous fields are sampled at the interval start; its documented hourly precipitation band is sampled at the interval end. Raw bands and native projection metadata remain alongside deterministic derived values. ERA5-Land is one reanalysis source, not independent corroboration.

USGS 3DEP 10 m elevation and terrain derivatives are summarized on their source grid. The service collection does not provide an acquisition date for every returned pixel, so these are flagged as potentially retrospective. LANDFIRE LF2016 Remap is queried at 30 m through the official USGS image service. It predates the three events but is several years old; raw encodings are preserved and only documented conversions are applied (CH/CBH meters ×10, CBD kg/m³ ×100). Categorical fuel and vegetation layers use up to 1,000 point samples per interval footprint because the image-service histogram is too coarse to preserve their class codes exactly. Their output is explicitly a sample distribution, not a complete pixel census. The GeoJSON footprint is simplified by 15 m for LANDFIRE service requests and that operation is retained in each measurement’s spatial-support record.

MTBS is compared to the final GOFER perimeter only. This is a final-extent check, not hourly-progression validation. The comparison is left missing when event identity is ambiguous or the boundary is unavailable.

## Coverage and gaps

The pinned GOFER summary has 72 source-hour intervals per fire. The first 72 have different spatial completeness because unchanged/zero-growth intervals have no newly burned footprint. Weather context at the GOFER ignition point is separately labeled and must not be interpreted as a burned-footprint summary.

RAWS USA Climate Archive station data are not included unless records can be acquired with accessible archive credentials. The WRCC archive request documents a password requirement for historical station downloads. Do not replace this point observation with another ERA5 interface and call it independent validation. Record station proximity/elevation/time conventions only when station metadata and observations are obtained.

The Forest Service Creek Fire investigation report URL returned HTTP 403 to the local acquisition client. An exact titled report copy was obtained from a secondary mirror at <https://dig.abclocal.go.com/kfsn/PDF/Creek-Fire-Report-of-Investigation.pdf>; its SHA-256 is recorded in the ignored pilot extraction output. Treat the mirror as retrieval provenance, not as the publisher. The local extraction harness keeps candidates pending and requires an exact supporting passage and page. No candidate is accepted as measured data, and the 100-example human-reviewed benchmark remains a separate gate before broader automation.

## Sidecars and quality review

Each event folder also contains `intervals-simple.json`, a smaller preview of `intervals.json`
with GeoJSON `coordinates` and ArcGIS sample-point positions (`x`/`y`, plus `z`/`m` when present)
omitted recursively. All intervals, measurements, units and provenance remain. The full
`intervals.json` is unchanged; use it for spatial processing because the preview has incomplete geometry.

`contracts/enrichment-sidecar.schema.json` describes the append-only evidence layer. Measurements identify their source/version, source value, units, temporal window, spatial support, method, flags, evidence, pending review state, and conflicts. Keep source values, point context, and footprint summaries distinct. Do not average conflicts or overwrite GOFER fields.

Generated pilot manifest, per-event interval JSON, raw Earth Engine/USGS responses, and quality report belong in ignored `backend/api/.research-data/enrichment-pilot/`; they are reproducible research outputs, not checked-in source data. One inspected real interval is retained in `contracts/examples/enriched-creek-2020-hour.json` as an earlier-stage snapshot; it is not automatically regenerated by NASA enrichment.

The 100-record document benchmark remains a gate: separate development and evaluation documents; include absent facts, ranges, and ambiguous timestamps; report precision, recall, unit/time correctness, and unsupported claims. Broader automation requires at least 95% precision and complete evidence linkage, and every accepted pilot extraction still receives human review.
