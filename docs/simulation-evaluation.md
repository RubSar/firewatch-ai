# Simulation evaluation and limitations

Reviewed against the repository on 2026-09-28. This page separates software checks,
saved model metrics, and archived replay observations. None establishes operational
forecast accuracy. For implementation and setup, read the [frontend guide](../frontend/README.md)
and [application flow](../frontend/APP-FLOW.md).

## What contributors can verify locally

From `frontend/`, with Node.js 24+ and installed dependencies:

```sh
npm run typecheck
npm test
npm run build
FIREWATCH_MODE=offline npm run smoke:api
npm run bench
```

The environment-variable syntax above is for POSIX shells; see the frontend guide
for PowerShell. The tests check history logic and kernel properties such as
isotropy, wind direction, moisture extinction, seeded reproducibility, fuel accounting,
crowning and treatment handling. The API smoke test checks lifecycle commands and
binary state/reset propagation with synthetic inputs. CI runs these checks except
the benchmark; it does not test live-source availability or forecast accuracy.

The [benchmark](../frontend/sim/bench/rothermel.ts) compares a simplified kernel with a
single-particle [Rothermel reference](../frontend/sim/src/rothermel.ts). Inspect
per-fuel, wind and slope discrepancies in its output; its zero exit status is not
an accuracy threshold. Agreement with the kernel's own nominal spread rate verifies
numerical propagation, not agreement with a measured fire.

A local run on 2026-09-28 with Node 24.19.0 reported nominal/reference ratios of
0.22–1.28 across 14 cases. Emergent/nominal ratios were 0.94–1.00 on the grass,
chaparral and timber flat cases, 1.09 for calm agriculture, and 0.71 for the 30°
grass-slope case. This does not support a universal “within 6%” propagation claim;
retain the short-run flags and slope discrepancy when interpreting the benchmark.

## Saved canopy-model metrics

The committed [model artifact](../frontend/api/src/canopy/model.json) records training
at `2026-09-27T00:24:30+00:00`, 5,499 rows and 13 US regions. Targets are LANDFIRE
LF2023 CBH/CBD/CC/CH at 30 m. The [training code](../frontend/api/src/canopy/train.py)
uses region-grouped cross-validation and fits 250 depth-3 boosting trees per target.
Inputs include visible/NIR/SWIR bands, spectral indices, terrain, texture, fuel ID
and absolute latitude. These saved metrics were read from the artifact, not retrained
for this documentation review.

| Target | Learned RMSE | Assumed baseline RMSE | Recorded reduction |
| --- | ---: | ---: | ---: |
| Canopy base height (m) | 3.575 | 4.141 | 13.7% |
| Canopy bulk density (kg/m³) | 0.0644 | 0.0670 | 4.0% |
| Canopy cover (fraction) | 0.178 | 0.248 | 28.3% |
| Canopy height (m) | 5.930 | 7.212 | 17.8% |

These measure agreement with source raster labels. They do not establish field
accuracy, transfer outside the sampled regions, or improvement in fire forecasts.
Retain per-region errors and source-vintage/coverage information when evaluating a
replacement. A larger model is not a substitute for an independent evaluation set.

## Archived replay results

The following numbers are retained from the former developer pitch notes. They
are **developer-reported historical results**, not a newly reproduced benchmark.
A frozen raw run bundle was not attached to those notes; commit-specific code,
source responses and parameters must be recovered before using them as a baseline.
The old notes remain in Git history at commit `f7ecbb4`, path `docs/pitch.md`.

| Fire | Reported replay hours | Mapped area (ha) | Modelled area (ha) | Dice | Equal-area circle Dice |
| --- | ---: | ---: | ---: | ---: | ---: |
| Anderson Bridge | 191 | 6,972 | 47,546 | 0.253 | 0.332 |
| Pineland Rd | 100 | 12,962 | 51,165 | 0.393 | 0.403 |
| Hwy 82 | 239 | 9,073 | 66,150 | 0.239 | 0.243 |
| Ballard | 41 | 7,464 | 39,558 | 0.308 | 0.321 |
| 113 Incident | 22 | 2,074 | 2,937 | 0.324 | 0.795 |

All five model overlaps were below the equal-area circle comparator. The notes also
reported an approximately zero mean Dice change from learned versus assumed canopy
on these same cases. These exploratory results neither validate a forecast nor
isolate the cause of error.

The [hindcast diagnostic](../frontend/api/src/hindcast.ts) uses reported origin when
available and otherwise a final-perimeter centroid; it also sweeps suppression.
Final-extent-derived origin and outcome-selected parameters leak later information
into a forecast evaluation. Geometry edit times need not be observation times, and
suppression records are incomplete. Preserve these limitations when running
`npm run hindcast` from `frontend/`; it downloads live reference/weather data.

## Current model and application limits

- Simplified fuel classes and assumed bed parameters are not a full Scott & Burgan
  fuel model, even when source FBFM40 classes are available.
- The kernel combines empirical spread factors, an ellipse and an eight-neighbour
  travel-time lattice. Slope is applied per direction; no coupled atmosphere is solved.
- Foliar moisture is fixed at 100%. Spotting, suppression, rain and thermal display
  use simplified parameterizations; the thermal layer is not camera evidence.
- Roads use assumed widths and partial edge blocking. Drawn treatments omit real
  construction delays and resource limits. Reported containment/losses are proxies.
- Live providers may fall back to synthetic values. Inspect resolved incident
  provenance; `/api/health` describes configuration, not successful acquisition.
- The local API stores incidents in memory and has no authentication or per-incident
  authorization. Production persistence and access control remain separate work.

## Evidence required for a forecast benchmark

Declare issue time, horizon, region, outcome and acceptance criteria before tuning.
Freeze source responses, model revision, configuration and seeds; record what was
available at issue time. Use an independently dated later reference and separate
whole incidents for development and evaluation. Compare unchanged simple baselines,
report misses and abstentions, and evaluate spatial boundary error and timing as well
as area overlap. Response-effect claims additionally require intervention evidence
and an appropriate counterfactual evaluation.

See the [contribution backlog](contributor-strategy.md) and the separate
[observation-research protocols](concurrent-analysis/09-observation-baseline/README.md)
for scoped work and unresolved review requirements.
