# Historical source register

This register identifies actual local inputs, implemented queries and explicit gaps
as of 2026-09-28. Earth Engine is the access platform for several products, not an
independent observational source. Exact asset IDs, selected image times, grids,
raw responses, processing methods and null flags live in each full sidecar.

## Acquired sources and their use

| Source and version | Authoritative reference / access | Collected material and application use |
| --- | --- | --- |
| Canadian Fire Spread Dataset (CFSDS), v1.1, selected 2002–2021 | [OSF](https://osf.io/f48ry/), [methods](https://www.nature.com/articles/s41597-024-03436-4), [release notes](https://osf.io/download/8fe4u/); exact download URLs and SHA-256 in [sources.json](../../backend/api/historical_fire/sources.json) | 20 annual ZIPs; daily area growth and environmental covariates for normalized historical situations and earlier offline analog experiment. Not loaded in the browser atlas. Source day boundaries are preserved; burned-footprint covariates and some zero-growth locations are retrospective. |
| GOFER Combined v0.2 | [Versioned Zenodo record](https://zenodo.org/records/14642378), [methods](https://essd.copernicus.org/articles/16/1395/2024/) | Publisher `GOFER.zip`, locally named `GOFER-v02.zip`; `GOFER/GOFER_Combined/GOFERC_summary.csv`, `GOFERC_fireProg` and `GOFERC_fireIg` shapefile components. Hourly reconstructed progression, ignition context, growth and display perimeters. Do not substitute East/West variants. |
| ECMWF ERA5-Land hourly | [Catalog and terms](https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_LAND_HOURLY); `ECMWF/ERA5_LAND/HOURLY` | Temperature/dew point, 10 m u/v wind and hourly precipitation. Deterministic RH, VPD, wind speed and meteorological from-direction. Reanalysis, not a station reading. Preserve native grid; instantaneous fields use interval start and hourly precipitation uses its accumulation window. |
| USGS 3DEP 10 m collection | [Catalog and terms](https://developers.google.com/earth-engine/datasets/catalog/USGS_3DEP_10m_collection); `USGS/3DEP/10m_collection` | Elevation and calculated slope/circular aspect. Tile date ranges retained; pixel acquisition date is unverified and ranges can extend beyond fire dates. Do not call this a verified pre-event terrain snapshot. |
| LANDFIRE LF2016 Remap | [Publisher](https://landfire.gov/data), [queried services](https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2016) | Eight CONUS layers: FBFM40, CC, CH, CBH, CBD, EVT, EVC, EVH. Fuel/vegetation categories and canopy attributes, with 2016 age. Categorical proportions use up to 1,000 sampled cell centers; not an exhaustive polygon census. Height/base-height native values divide by 10; density by 100. |
| MTBS boundaries v1 | [Catalog and terms](https://developers.google.com/earth-engine/datasets/catalog/USFS_GTAC_MTBS_burned_area_boundaries_v1), [publisher](https://www.mtbs.gov/); `USFS/GTAC/MTBS/burned_area_boundaries/v1` | Event-level comparison against final GOFER extent in `event-enrichment.json`. Retains match/coverage failures and boundary disagreement; not an hourly progression reference. |
| NASA HLS v002, L30 and S30 | [L30 catalog](https://developers.google.com/earth-engine/datasets/catalog/NASA_HLS_HLSL30_v002), [S30 catalog](https://developers.google.com/earth-engine/datasets/catalog/NASA_HLS_HLSS30_v002); `NASA/HLS/HLSL30/v002`, `NASA/HLS/HLSS30/v002` | Pre-fire reflectance used to calculate NDVI, NDMI and NBR; latest intersecting eligible scene in the 30-day lookback, with scene and pixel quality screening. Retain scene age and masked coverage. This is not hourly imagery. |
| NASA GPM IMERG V07 | [Catalog and terms](https://developers.google.com/earth-engine/datasets/catalog/NASA_GPM_L3_IMERG_V07); `NASA/GPM_L3/IMERG_V07` | Half-hour precipitation rates integrated over the hour and antecedent 24-hour/7-day windows. Missing expected slots remain explicit. A separate precipitation estimate from ERA5, not a replacement for it. |
| NASA SMAP L4 v008 | [Catalog and terms](https://developers.google.com/earth-engine/datasets/catalog/NASA_SMAP_SPL4SMGP_008); `NASA/SMAP/SPL4SMGP/008` | Surface and root-zone soil moisture, m³/m³, with 3-hour time support. Model/data-assimilation product; preserve source projection/resolution rather than implying hourly fine-scale measurements. |
| NASA/USGS SRTM v3 | [Catalog and terms](https://developers.google.com/earth-engine/datasets/catalog/USGS_SRTMGL1_003); `USGS/SRTMGL1_003` | Alternative elevation, slope and aspect, separately attributable from 3DEP. |
| MODIS MCD64A1 collection 6.1 | [Catalog and terms](https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MCD64A1); `MODIS/061/MCD64A1` | Monthly burn-date distribution, uncertainty and mapped burned area inside the GOFER footprint. Not an independent hourly growth measurement. |
| NIFC/WFIGS interagency perimeters | [Queried FeatureServer layer](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters/FeatureServer/0) | Frozen GeoJSON query for `2026-TXTXF-000138` (Cypress Creek) and `2026-COELX-000171` (County Rd 169), retrieved 2026-09-26. One snapshot each; incident metadata, reported area and geometry. ERA5/3DEP/HLS add cumulative-perimeter context. Historical fuel selection remains unverified. Cornea was a discovery lead, not the downloaded data source. |
| US Forest Service Creek Fire investigation report | [Publisher PDF](https://www.fs.usda.gov/sites/default/files/2021-08/Creek%20Fire%20Final%20ROI%20No%20Exhibits_redacted.pdf); [retrieved mirror](https://dig.abclocal.go.com/kfsn/PDF/Creek-Fire-Report-of-Investigation.pdf) | PDF in `enrichment-pilot/docs/`; local extraction candidates in `documents/`. The publisher endpoint was unavailable during acquisition; preserve mirror provenance. Exact passages/page references and human review are required. Candidates are not accepted measurements or automatically exported. |

## Gaps and tools that are not measurement sources

- **RAWS:** [WRCC archive](https://raws.dri.edu/) is planned for independent station
  checks, but all three event sidecars record `not_acquired`. Station distance,
  elevation, time and conventions are unknown; no RAWS validation is claimed.
- **FIRMS/VIIRS:** [archive access](https://firms.modaps.eosdis.nasa.gov/download/)
  is represented by null `active_fire_detections` slots. No detections were retrieved
  by this historical pilot. Separate live frontend providers do not fill these slots.
- **Local models:** [Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B) and
  [Granite Docling](https://huggingface.co/ibm-granite/granite-docling-258M) are extraction
  tools. Their output is not an independent source. The implementation uses Ollama
  tags; record the actual installed digest/revision, prompts and document checksum
  when reproducing. The 100-reviewed-field acceptance benchmark remains open.
- No acquired suppression timeline supports a general “before intervention” filter.
  No official Kincade/Bobcat document-extraction collection is established by this cache.

## Attribution and redistribution status

Use the dataset's versioned record and recommended citation, not only the Earth
Engine homepage. The catalog links above include source terms/citations. Record
license text or a permanent terms reference alongside each proposed distributable
artifact; a working download URL is not sufficient evidence of redistribution rights.

This audit did not resolve all dataset rights. In particular, verify the GOFER
release license, CFSDS dataset license (distinct from the paper's license), LANDFIRE
service notices, NIFC item restrictions and report/mirror rights before packaging
raw or derived data. The Zenodo landing page and catalog pages were accessible;
OSF and Zenodo metadata API checks were unavailable through the research browser.
This is not evidence that the existing pinned downloads are corrupt.

The [audit snapshot](audit-2026-09-28.json) records measured local hashes, including
GOFER archive and extracted summary. [sources.json](../../backend/api/historical_fire/sources.json)
is the acquisition authority for CFSDS URLs/hashes and the GOFER summary hash.
Original FireWatch code's MIT license does not change these source terms.
