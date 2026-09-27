# Water scoring correction — 2026-09-26

## Reproduced defect

User-reported cell: `32610-78-1050`, nominal 5 km grid, actual clipped area
25.012904 km². Queried that grid square through `/v1/fuel-index` using the current
2025-07-01 to 2025-08-01 exclusive window. The v1 live result matched the user's
6.5 score, 18.5% raw vegetation probability, NDMI 0.188, full coverage and mean
3.6 observations. Four acquisition pairs were candidates for this square.

V1 incorrectly treated residual class probabilities on water as fuel. Its formula
was 100 × 0.1849878535 × 0.3538024927 = 6.5 after rounding. Class probability is
uncertainty over class identity, not observed vegetation area. The former very
strict non-vegetated cell threshold did not catch this case.

## Correction

Method `dw-ndmi-experimental-v2` admits fuel only from Dynamic World native 10 m
vegetation labels (1–5), before averaging to 20 m. Water, bare, built and snow labels
contribute zero fuel. Sentinel-2 SCL water (6) additionally vetoes fuel. These known
water observations remain in coverage and the score denominator, and cannot
contribute to vegetation-weighted NDMI. The 70% quality gate stays unchanged.

The NDMI anchors and remaining scoring policy are still experimental. This fixes
a demonstrated water contribution bug; it does not validate wildfire risk accuracy.
Mixed shoreline cells can score for their vegetation. Satellite misclassification
and mixed reflectance within 20 m pixels remain possible.

## Live before/after, same cell and acquisitions

| Field | v1 | v2 |
| --- | ---: | ---: |
| Score | 6.5 | **0.0** |
| Status | scored | non_vegetated |
| Valid coverage | 100% | 100% |
| Raw vegetation probability | 18.5% | 18.5% |
| Eligible fuel evidence | not available | 0% |
| Vegetation observation support | not available | 0% |
| Water observation support | not available | 100% |
| Vegetation NDMI | 0.1877185 | null (no vegetation) |

Confirmed identical geometry, acquisition metadata and observation count (within
floating point precision). Both receipts validate against AnalysisResponse.

- [Request](../contracts/examples/fuel-index-request-water.json)
- [Actual v1 receipt](../contracts/examples/fuel-index-response.water.v1.live.json)
- [Actual v2 receipt](../contracts/examples/fuel-index-response.water.v2.live.json)

The receipts preserve the full HTTP response, including any near-zero-area edge
fragments from projection roundoff. The table selects the reported cell by ID.
They are real satellite observations for a test region, not a verified fire incident.

## Contract, UI, and verification

The v2 contract adds nullable eligible fuel evidence and water/vegetation support
fields. Raw probability remains diagnostic. Method ID distinguishes the changed
NDMI/fuel semantics. Old v1 receipts are preserved; they cannot be corrected without
pixel data. Overview warns on legacy live results; Method distinguishes v1/v2;
cell popups and Evidence show the new inputs separately.

Scope: backend API/provider/scoring/tests, shared contract/schema/example receipts,
frontend result/popups/method, and docs. No named component owners are recorded.
Existing changes were preserved on codex/mock-polygons. No commit/push or remote
overlap review; remote authentication was unavailable in this session.

Verification: 35 backend tests (including water residual probability, shoreline
mixing, missing coverage, invalid support and old evidence), Ruff, 10 frontend tests
and production build pass. Existing frontend bundle-size and upstream test-client
deprecation warnings remain. Live before/after check passed on the reported cell.

## Primary sources

- [Dynamic World bands and labels](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1)
- [Sentinel-2 surface reflectance and SCL classes](https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED)

## Full map verification

The 1,779-cell Sierra investigation was queried with v2. Its first query hit the
240-second upstream deadline; one retry succeeded. Scored area remains 630.33 km²
(9.65%): 178 scored and 1,601 unknown cells. Mean score changed from 18.7 to 18.2.
The UI displayed the completed real result. Opening its multi-megabyte JSON preview
stalled the browser, so on-screen previews are now capped at 20,000 characters with
an explicit truncation message. Copy and Download still use the full JSON string.
The full map export is not included as a new receipt; the exact reported water-cell
before/after receipts above are saved and validated.
