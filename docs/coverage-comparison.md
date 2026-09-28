# Investigation area coverage comparison

> Archived report from 2026-09-26 about the former fuel-index/investigation service.
> That implementation and the referenced `contracts/examples/` receipts are absent
> from the current checkout. Results and check counts below are historical claims,
> not verification of the current app. Recover the original code and receipts from
> repository history before reproducing them; use [current setup](../CONTRIBUTING.md)
> for the maintained application.

Measured on 2026-09-26 using the same hypothetical Sierra fire, its 28 km
investigation ring (fire excluded), and the UTC imagery window 2025-07-01 through
2025-08-01 exclusive. Both requests used the same 77 matched Dynamic World and
Sentinel-2 acquisitions, 20 m processing resolution, and scoring policy. The 70%
valid-coverage gate and all other quality rules were unchanged.

## Results

| Measure | 5 km cells | 2 km cells |
| --- | ---: | ---: |
| Investigation area receiving a score | 8.40% | 9.65% |
| Area assigned a score | 549.08 km² | 630.33 km² |
| Area in unknown cells | 5,985.15 km² | 5,903.89 km² |
| Unknown area percentage | 91.60% | 90.35% |
| Valid observed area within scored cells / ring | 6.60% | 7.86% |
| Scored cells / total cells | 29 / 318 | 178 / 1,779 |
| Unknown cell count | 289 | 1,601 |

Smaller cells increased scored area by a net **81.25 km²**, or **1.24 percentage
points** (14.8% relative increase). Unknown cell count rose because the grid contains
many more cells; unknown area declined. This is a modest coverage improvement, not
a solution to the underlying observation gaps or evidence of prediction accuracy.

The 2 km unknown cells comprise 1,588 below the 70% coverage requirement, 11 with
no usable data, and 2 excluded for built cover. Per-filter loss diagnostics are not
currently returned, so these results alone cannot determine whether clouds, shadows,
snow, uncertain land cover or another mask explains a particular gap. Investigating
those masks is the next step before changing source or quality policy. A 1 km grid
for this entire polygon exceeds the then-current 2,048-cell service limit.

## Metric definitions

- Scored area percentage = `100 * summary.scored_cell_area_m2 / summary.total_area_m2`.
- Unknown area percentage = `100 * summary.unscored_cell_area_m2 / summary.total_area_m2`.
- Observed area within scored cells = `100 * summary.observed_scored_area_m2 / summary.total_area_m2`.

Use clipped cell areas, not the percentage of cell count. A score applies to an
accepted cell, which may still have up to 30% missing observations. The observed-area
metric distinguishes that from the area assigned a score. It excludes valid pixels
in cells that fail the scoring gates; it is not overall satellite data availability.
Zero total area is displayed as unknown. No API schema change is needed.

`summary.total_area_m2` sums clipped projected cell areas. It differs slightly from
the geodesic investigation area; the two grid runs differ by about 9 m² in that sum.
Each percentage uses its own summary denominator consistently.

## Reproducible receipts and verification

- 5 km receipt — historical path `contracts/examples/fire-investigation-response.sierra.live.json` (not bundled)
- 2 km receipt — historical path `contracts/examples/fire-investigation-response.sierra-2km.live.json` (not bundled)

Verified identical fire/wrapper/ring geometries, method and acquisition records;
synthetic=false; all scored cells have at least 70% valid coverage. The 2 km receipt
passes FireInvestigationResponse validation, and scored/observed area totals agree
with the feature properties. The UI showed the real 2 km result after a live query.
Nine frontend tests and the production build pass (existing bundle-size warning).

Affected components: frontend API helpers and results UI, contracts/example receipts,
and documentation. The backend scoring implementation and shared response schema
are unchanged. Remote overlap review remains unavailable due to GitHub authentication.
