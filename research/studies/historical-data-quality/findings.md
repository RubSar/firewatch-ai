# Historical-data findings and review record

Status: awaiting review. This page organizes existing evidence; establishing the
research directory did not rerun acquisitions, models or experiments.

## Evidence available

The [2026-09-28 audit](../../../docs/research-data/audit-2026-09-28.json) records
source hashes, the audited code revision, local inventory and interval checks.
Its [human-readable report](../../../docs/research-data/README.md) explains usage,
coverage definitions and the byte-identical offline preview rebuild.

| Finding | Audited result |
| --- | --- |
| Local cache | 2,319 files; 762,688,169 bytes, including source downloads and generated artifacts |
| CFSDS v1.1 imported situations | 82,108 daily situations across 4,164 fires |
| GOFER imported situations | 20,273 hourly intervals across 28 fires |
| GOFER enrichment pilot | 216 contiguous hours across Creek, Kincade and Bobcat; no internal gaps in those 72-hour windows |
| Pilot spatial support | 111 newly burned footprints; 105 intervals without one |
| Viewer completeness | 64 pilot hours with all eight displayed parameters; not all fields or review complete |
| Viewer export | 218 records: 216 GOFER hours and two NIFC snapshots with unknown growth |

Counts are a dated local snapshot, not a worldwide dataset-size estimate. CFSDS daily
and GOFER hourly outcomes are separate. Additional source-specific findings remain
in the [base enrichment report](../../../docs/concurrent-analysis/09-historical-similarity/enrichment-findings.md),
[NASA report](../../../docs/concurrent-analysis/09-historical-similarity/nasa-enrichment.md)
and [NIFC report](../../../docs/concurrent-analysis/09-historical-similarity/nifc-pilot.md).

## Gaps and interpretation

RAWS observations and pilot FIRMS detections were not acquired. Coordinate-free
previews and base completeness reports predate NASA additions to the full sidecars.
Missing source slots and post-event/unverified source dates remain explicit.
Non-null values and matching checksums do not establish measurement accuracy.

Observed growth can include suppression. Unknown intervention timing prevents
claiming an untreated cohort, and realized-footprint covariates are retrospective.
These findings do not establish unsuppressed simulator or forecast accuracy.
Dataset redistribution terms and independent review remain unresolved.

## Reproduce or review

Use the [current commands](../../../docs/research-data/reproduce.md), preserve the
original audit, and add a dated run record for a reproduction. Record code revision,
source versions/hashes, commands actually run and differences from these counts.
Live catalogs may change; an unavailable source is a result to report, not to fill in.
No independent reviewer has accepted these findings. Record future review scope,
reviewer/date, evidence link and remaining limitations here.
