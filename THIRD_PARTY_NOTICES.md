# License scope and third-party material

The root [MIT License](LICENSE) applies to original FireWatch AI code and
documentation, except where a file or component identifies different terms.
It does not relicense third-party code, datasets, imagery, map tiles, model
checkpoints or quoted publisher material. Retain their original notices.

## Included notices

- The [Prithvi inference adapter attribution](backend/vision/THIRD_PARTY_PRITHVI.md)
  identifies adapted NASA-IMPACT, Meta, OpenMMLab and timm code. Its
  [Apache-2.0 license](backend/vision/licenses/prithvi-Apache-2.0.txt) and upstream
  copyright notices remain applicable. Model sources and revisions are recorded
  separately in [prithvi-assets.json](backend/vision/prithvi-assets.json); weights
  are not redistributed in Git.
- The retained FireBench reference publisher bundle includes its own
  [license](docs/concurrent-analysis/09-observation-baseline/results/reference-readiness/publisher/LICENSE),
  [data terms](docs/concurrent-analysis/09-observation-baseline/results/reference-readiness/publisher/data_term_of_use.md)
  and [NIFC notice](docs/concurrent-analysis/09-observation-baseline/results/reference-readiness/publisher/NIFC.txt).
  These remain attached to that source material.
- Installed npm/Python dependencies retain their own licenses and notices. The
  root MIT license does not replace dependency terms.

## Data, imagery and services

Historical records and examples may incorporate third-party measurements or
geometries. Consult each record's provenance and the relevant research protocol
for the source/version and publisher terms. Public download access alone does not
establish permission to redistribute or relicense a dataset.

Map imagery attribution and provider terms still apply when displaying maps.
External APIs and hosted model services may have access or usage requirements
independent of the code license. Preserve any supplied attribution, license and
processing metadata when exporting examples or derived products.

This document lists known included notices, not an exhaustive legal audit of every
external source. If a source's terms are missing or unclear, open an issue naming
the source and affected files before adding or redistributing that material.
