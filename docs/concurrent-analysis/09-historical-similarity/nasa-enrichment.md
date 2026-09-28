# NASA historical enrichment

This separate runner appends NASA-derived measurements to the three pilot
`intervals.json` files. It never regenerates `intervals-simple.json`, event summaries,
the earlier completeness report or the tracked Creek example. Those older artifacts
remain snapshots of the previous enrichment stage.

Follow the [environment setup and acquisition order](../../research-data/reproduce.md)
first. The command below updates existing pilot sidecars; use a fresh research run
directory when testing changed acquisition or enrichment code.

```sh
cd backend/api
./.venv/bin/python -m historical_fire.enrichment_nasa \
  --data-dir .research-data/enrichment-pilot/data \
  --project YOUR_EARTH_ENGINE_PROJECT
```

The existing Earth Engine login accesses NASA products. Another delivery interface
does not constitute an independent source. This is historical enrichment only.

## Added measurements

Each interval receives 20 additional entries in the existing `measurements` array:

| Source | Fields | Spatial support |
| --- | --- | --- |
| HLS v2 | `ndvi`, `ndmi`, `nbr` | Newly burned footprint |
| IMERG V07 permanent products | `precipitation_mm`, `antecedent_precipitation_24h_mm`, `antecedent_precipitation_7d_mm` | Footprint and separately labeled ignition-point context |
| SMAP SPL4SMGP v008 | `surface_soil_moisture_m3_m3`, `root_zone_soil_moisture_m3_m3` | Footprint and ignition-point context |
| SRTMGL1 v003 | `elevation_m`, `slope_deg`, `aspect_deg` | Footprint |
| MODIS MCD64A1 v061 | `burn_date_day_of_year_distribution`, `burn_date_uncertainty_days`, `monthly_burned_area_within_footprint_ha` | Footprint |
| FIRMS VIIRS | `active_fire_detections` | Null access gap; no observations retrieved |

Source ID plus field plus spatial support identifies a measurement: field alone is
not unique. Existing ERA5/3DEP measurements remain unchanged. No averaged blend is
created. `nasa_enrichment.comparisons` records IMERG minus ERA5 rainfall differences
for matching hours and spatial supports; their grids/methods differ.

## Interpretation and quality

- HLS selects the newest intersecting scene in the 30 days preceding the GOFER
  source ignition time, with tile-level cloud coverage below 20%. Per-pixel masking
  excludes cloud, adjacency, shadow, snow, water, high aerosols, negative reflectance
  and nonpositive index denominators. Selection does not guarantee full coverage;
  report the actual valid fraction. No older scene is silently substituted to fill
  missing pixels. NDVI uses red, NDMI SWIR1, NBR SWIR2; Sentinel NIR uses B8A and
  Landsat NIR B5. Indices are per-pixel ratios followed by a spatial mean.
- HLS dates, age at interval start and original scene identifiers remain explicit.
  The same pre-fire image can support several intervals. The spatial footprint is
  retrospective even though the image predates the fire. These are not direct fuel
  load measurements or validated fuel-moisture estimates.
- IMERG integrates mm/hour rates over complete half-hour steps. Current rainfall
  uses `[interval_start, interval_end)`; antecedent totals end at interval start.
  A pixel needs all 2, 48 or 336 valid nonnegative observations. Missing steps must
  not produce artificially small totals. Source granule IDs and timestamps are
  retained in the measurement's original response.
- SMAP uses the three-hour averaging window containing interval start. Its midpoint
  timestamp and true window are retained; no hourly observations are manufactured.
  The original 9 km EASE-grid product is reprojected in Earth Engine. The delivered
  grid is recorded and must not be described as an untouched native EASE grid.
  Soil moisture is model assimilation output, not direct fuel moisture.
- SRTM retains the February 2000 mission window, with void-fill provenance unverified.
  Slope/aspect are derived; aspect uses a circular mean excluding flat pixels.
- MODIS uses valid-land QA. Burn-date distribution includes day 0 (unburned) and
  fraction-weighted counts for positive ordinal dates. Area and mean date uncertainty
  use positive burn dates only. The monthly area is restricted to the hourly GOFER
  footprint; it is neither hourly observed growth nor an independent final event
  perimeter. Final-extent IoU remains explicitly uncomputed. QA histograms remain
  available to inspect shortened mapping periods and contextual relabeling.
- No-growth intervals keep footprint measurements null. Only weather/soil ignition
  context is separately sampled; it never substitutes for a missing footprint.
- FIRMS credentials were not configured for this run. Its detection value remains
  null with `retrieval_status: access_not_configured`. Null does not mean no fire.
  No pixel brightness temperature or radiative power is fabricated from GOFER.
- All new entries remain pending review. Retrieval status describes availability,
  not scientific validation. A zero-pixel-center count can coexist with a weighted
  mean when a footprint overlaps a fraction of a raster cell.

## Preservation and reproducibility

Source queries and exact pre-enrichment files are cached under
`.research-data/enrichment-pilot/data/raw/nasa/<event>/<input-sha256>/`.
The SHA-256 directory binds responses to the complete original interval file.
Successful batches resume from cache. Memory-limited batches retry single intervals
without coarsening resolution. Each event is schema-validated and written atomically
only after all its queries succeed. Concurrent file edits cause a refusal to overwrite.
Previously enriched events are skipped; reviewed measurements are never silently replaced.
All original keys and the existing measurement prefix are checked for equality.
Preview files are checked byte-for-byte. No frontend/API changes are involved.

References:
[HLS Landsat](https://developers.google.com/earth-engine/datasets/catalog/NASA_HLS_HLSL30_v002),
[HLS Sentinel](https://developers.google.com/earth-engine/datasets/catalog/NASA_HLS_HLSS30_v002),
[IMERG](https://developers.google.com/earth-engine/datasets/catalog/NASA_GPM_L3_IMERG_V07),
[SMAP](https://developers.google.com/earth-engine/datasets/catalog/NASA_SMAP_SPL4SMGP_008),
[MODIS burned area](https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MCD64A1),
[SRTM](https://developers.google.com/earth-engine/datasets/catalog/USGS_SRTMGL1_003),
[FIRMS access](https://firms.modaps.eosdis.nasa.gov/download/).
