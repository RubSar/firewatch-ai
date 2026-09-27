# NIFC historical perimeter pilot

Implemented on main for the two incidents discussed on 2026-09-27. Cornea's County
Rd 169 URL describes a Colorado fire; the supplied Cypress Creek table describes a
different Texas fire. Both are imported from the public NIFC source, without scraping
Cornea's narrative or treating it as independent confirmation.

## Sources and findings

- [NIFC WFIGS public perimeter service](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters/FeatureServer/0)
- [Cornea source documentation](https://fires.cornea.is/about)
- Existing Earth Engine ERA5-Land, USGS 3DEP and NASA HLS adapters.

| Event | NIFC incident ID | Perimeter observation UTC | Reported area ha | Polygon area ha |
|---|---|---|---:|---:|
| County Rd 169 | 2026-COELX-000171 | 2026-02-18 19:34:00.593 | 2260.5740 | 2265.6384 |
| Cypress Creek | 2026-TXTXF-000138 | 2026-02-27 11:20:00 | 2733.2468 | 2733.2234 |

The bounded query returns two features, one per event. This is not proof that no
additional perimeters exist in other archives. Neither record establishes hourly
growth or final burned extent. Reported area, polygon GIS acreage, automated polygon
acreage and source geometry remain separately available in the original response.
County Rd 169's reported/polygon difference is flagged rather than reconciled.

## Enrichment and remaining gaps

Each snapshot begins with four attributable report measurements (fuel description,
behavior description and the two acreage values). Enrichment adds 12 non-null
measurements: temperature, dewpoint, humidity, VPD, wind speed and direction,
hourly precipitation, elevation, slope, NDVI, NDMI and NBR. A 17th measurement,
LANDFIRE FBFM40 distribution, is explicitly null. All remain pending human review.
This is a completeness increase, not independent validation of measurement accuracy.

- Weather uses ERA5-Land at the whole hour preceding the perimeter timestamp,
  averaged over the cumulative polygon at its native grid. RH, VPD and wind speed
  are calculated per pixel before averaging. Wind direction is the direction of
  the mean vector, meteorological FROM true north. Precipitation uses the native
  hourly accumulation ending one hour after the selected timestamp. This weather
  is context at the observation, not the conditions under which all ground burned.
- Terrain uses the existing 3DEP collection and native grid. Source tile date
  ranges and raster coverage are retained; pixel acquisition dates are unverified.
  Date ranges extending beyond discovery receive an explicit flag.
- HLS uses the existing bounded query helper: newest intersecting scene within
  30 days before discovery with tile cloud <20%, followed by pixel QA and
  fraction-weighted reduction. Scene IDs, acquisition times, native grid and
  valid fraction are preserved. A chosen scene is not guaranteed to cover every
  pixel; nulls and coverage flags are retained. It is pre-fire imagery, not hourly imagery.
- Narrative fuel descriptions are **not** converted into FBFM40 codes. The 2016
  California pilot layer is not silently reused for these 2026 incidents.
  A suitable pre-event LANDFIRE layer remains to be verified.
- No newly burned geometry, hourly growth, RAWS, MTBS comparison, or FIRMS detections
  were acquired for these two snapshots. Missing growth is null, never zero.

## Data contracts and evidence

`contracts/nifc-snapshot.schema.json` defines snapshots separately from the GOFER
interval sidecars. Source geometry and the original feature are retained. Units are
hectares (acres × 0.40468564224); coordinates are longitude,latitude EPSG:4326;
timestamps are UTC. `observed_at` is strictly `poly_PolygonDateTime`; a missing
observation timestamp is never replaced with an edit, discovery or retrieval time.

Raw downloads and retrieval metadata (URL, retrieval time, SHA-256) live in
`backend/api/.research-data/nifc-pilot/raw/`. Each event has `snapshot.json` and raw
Earth Engine response caches. `quality-report.json` records completeness and gaps.
Real examples are checked into the working tree under `contracts/examples/nifc/`.
No GOFER `intervals.json` or `intervals-simple.json` is changed.

Preview schema 1.1 adds `kind: perimeter_snapshot`, a source label, nullable start,
end, area and growth. Snapshot start/growth/newly_burned are always null. Existing
hourly records retain non-null interval timestamps and outcomes. Consumers must
recognize the snapshot kind before interpreting time or growth. The frontend accepts
1.0 and 1.1; it labels source and support and suppresses snapshot comparisons.
The preview retains the existing `intervals` array name for transport compatibility.
NIFC display geometry is simplified 20 m in EPSG:5070, independently of the
California GOFER display simplification in EPSG:3310. Source geometries stay intact.

## Reproduce

From `backend/api`, using the existing authenticated Earth Engine project:

```sh
./.venv/bin/python -m historical_fire.nifc \
  --data-dir .research-data/nifc-pilot --project YOUR_EARTH_ENGINE_PROJECT
./.venv/bin/python -m historical_fire.export_preview \
  --data-dir .research-data/enrichment-pilot/data \
  --archive .research-data/GOFER-v02.zip \
  --nifc-dir .research-data/nifc-pilot \
  --output ../../frontend/public/data/historical-pilot.json
./.venv/bin/python -m pytest tests/historical_fire/test_nifc.py -q
```

The acquisition is cached and reproducible. Use a new data directory for a new
source snapshot; the importer does not overwrite its raw download. Cached source
checksums are verified. Omitting `--project` imports only incident evidence, or
preserves enrichment when replaying an existing snapshot. Source errors and
truncated, duplicate, missing, mismatched or invalid-geometry records are rejected.
Export with `--nifc-dir` to retain these additions when refreshing the preview.
