# Contribute historical data and evidence

The current milestone is historical data quality and enrichment. Useful contributions
make a measurement easier to reproduce, interpret or challenge. Broader acquisition
and automated extraction should follow evidence review, not precede it.

Start with the [general guide](../../CONTRIBUTING.md), [source register](sources.md)
and [usage map](README.md). You can audit bundled examples and documentation without
Earth Engine, a GPU, a local model or downloading the complete cache.

## Choose a bounded contribution

These are starter proposals, not already assigned or published GitHub issues.

| Task | Helpful experience | A reviewable result |
| --- | --- | --- |
| Audit one interval's units and provenance | Python, GIS or fire science | Trace each chosen value to its raw response; show conversions, time/footprint support and unresolved disagreements using a small permitted fixture |
| Make completeness reports reflect NASA enrichment | Python/data engineering | Report field/source/support counts from full current sidecars; distinguish null footprint from missing hours; demonstrate consistent totals for base-only and NASA-enriched examples |
| Verify dataset redistribution terms | Data stewardship/research | Record exact version, license/terms URL, attribution and affected raw/derived artifacts; keep unresolved rights explicit |
| Add one RAWS station cross-check | Meteorology/data APIs | Permitted historical retrieval, station identity/distance/elevation, UTC conversion and measurement conventions; compare with ERA5 without claiming firewide representativeness |
| Investigate suppression timing for one pilot | Emergency response/document research | Official source passages and page/time references; retain uncertain dates and partial spatial coverage; do not label undocumented hours “no intervention” |
| Review incident-document candidates | Domain review | Independently checked field, exact passage/page, value/range, time ambiguity, unit and review decision; preserve absent facts as absent |
| Improve historical viewer data explanations | React/accessibility | Clear source, support and missingness labels; screenshots and relevant tests; no conversion of snapshots into hourly observations |

For a first PR, choose one event, source or failure mode. Describe expected inputs,
outputs and acceptance criteria in an issue before a large acquisition or schema
change. Scope implementation to `backend/api/historical_fire/`, extraction to
`backend/llm/`, shared formats to `contracts/`, and explanations to this documentation.

## Required evidence for a data PR

1. Identify the event and interval using stable IDs. Include dataset version, original
   URL, actual access route, retrieval time, checksum and redistribution evidence.
2. Preserve raw values. Explain every conversion, missing value and derived quantity;
   keep units, UTC/local conventions, CRS and native resolution explicit.
3. State time and spatial support: newly burned footprint, ignition-point context,
   cumulative perimeter, station or final extent. Never silently substitute them.
4. Keep differing sources separate. Measurement identity includes source and support,
   not just a field name; two precipitation or elevation estimates may both be valid.
5. Include before/after completeness, exclusions, source discrepancies and a small
   evidence-linked example. Zero-growth hours must not disappear from a quality report.
6. Validate the applicable [sidecar](../../contracts/enrichment-sidecar.schema.json),
   [situation](../../contracts/historical-situation.schema.json),
   [snapshot](../../contracts/nifc-snapshot.schema.json) or
   [preview](../../contracts/historical-preview.schema.json) contract and relevant
   component tests. Keep producer and consumer changes together.
7. Mark review status honestly. For document extraction, retain exact evidence,
   document hash, model digest/revision and prompt configuration. Every accepted
   pilot extraction needs human review; broader automation requires the separate
   100-reviewed-example evaluation and at least 95% precision with full linkage.

Do not upload `.research-data`, model weights, credentials, personal incident
information or large rasters as ordinary PR files. Prefer acquisition manifests,
checksums and permitted minimal fixtures. Tracked examples and derived preview
bundles also need a source-rights review; stripping coordinates does not clear rights.

## Scientific claims and review

Record missing suppression information as unknown. Similar environments need not
produce equal growth, and observed growth reflects intervention and measurement
error. Retrospective footprint covariates cannot be presented as inputs available
before the interval. Daily, hourly, snapshot and monthly records require different
interpretations and must not be pooled as equivalent targets.

A maintainer should review code/contracts and a suitable domain reviewer should
assess interpretation when possible. Component owners and domain reviewers are not
yet formally assigned; describe that gap in the PR instead of claiming approval.
No automatic merge, response-time commitment or operational deployment is implied.
