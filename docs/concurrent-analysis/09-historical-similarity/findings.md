# Historical fire similarity: measured findings

Retrospective association experiment; these are not operational forecast scores.

Source: CFSDS v1.1, 2002–2021. Imported 82,108 situations from 4,164 fires; 76,919 complete matching situations.

All methods use the same complete-case query and training cohort. Scores first average within each fire, then across fires.

| Method | Mean absolute error (ha) | Historical range width (ha) | Range coverage |
|---|---:|---:|---:|
| random | 508.92 | 1912.57 | 90.8% |
| state | 438.36 | 1478.21 | 87.9% |
| environment | 401.89 | 1347.48 | 89.4% |
| persistence | 509.48 | — | — |

## Paired whole-fire bootstrap

- Versus random: 107.03 ha improvement; 95% bootstrap interval [91.02, 124.78] ha. Positive favors environmental matching.
- Versus state: 36.47 ha improvement; 95% bootstrap interval [20.98, 53.44] ha. Positive favors environmental matching.
- Versus persistence: 107.59 ha improvement; 95% bootstrap interval [76.18, 141.03] ha. Positive favors environmental matching.

## Geographic transfer

| Withheld ecozone | Environmental MAE (ha) | State-only MAE (ha) | Persistence MAE (ha) |
|---|---:|---:|---:|
| 10 | Insufficient validation/test data | — | — |
| 11 | 426.43 | 460.25 | 440.58 |
| 12 | 250.83 | 314.58 | 335.46 |
| 13 | Insufficient validation/test data | — | — |
| 14 | 226.63 | 217.90 | 218.19 |
| 15 | 266.17 | 269.98 | 301.51 |
| 25 | 415.24 | 602.92 | 614.09 |
| 26 | 1691.93 | 1883.39 | 2318.40 |
| 3 | Insufficient validation/test data | — | — |
| 4 | 449.76 | 516.43 | 608.21 |
| 5 | 249.78 | 277.13 | 301.29 |
| 6 | 492.41 | 539.11 | 622.58 |
| 7 | Insufficient validation/test data | — | — |
| 9 | 489.33 | 479.91 | 580.48 |

## Decision

Temporal research gate passed: environmental matching improves on state-only matching and persistence with positive whole-fire bootstrap intervals. Inspect geographic results before a separate, leakage-safe forecast prototype.

## Limitations

- Covariates summarize the area that actually burned, including future-location information on some zero-growth days. Weather is reanalysis. Outcomes are reconstructed satellite progressions.
- v1.1 changed the original cohort to fires over 500 ha and 90 m processing. The published original count is not the count expected for this release. The release notes label it beta and mention topology fixes; checksums pin the actual input files.
- Complete-case selection, suppression, missing wind direction and fire-size selection limit interpretation. The empirical 10–90% range is not a calibrated prediction interval.
- Adequate support means enough distinct matching fires; it does not certify physical similarity or establish an out-of-distribution threshold.
- GOFER is a separate hourly import and quality audit. Its missing environmental features must be enriched before an environmental matching experiment.
