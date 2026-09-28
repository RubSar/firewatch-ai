# Historical data quality and enrichment

| Field | Value |
| --- | --- |
| Status | awaiting review |
| Original direction / latest audit | 2026-09-26 / 2026-09-28 |
| Research home established | 2026-09-28 |
| Contributors | Existing repository contributors; see Git history |
| Review | Independent measurement/domain review pending; reviewer unassigned |

## Question and scope

How complete and traceable are the acquired historical wildfire records, and can
structured-source enrichment improve them without hiding missingness or disagreement?
This study concerns data quality. Future predictions and matching performance are
outside this phase; historical suppression effects remain unmeasured.

## Evidence and reproduction

- [Dated protocol](protocol.md): migrated from the historical research docs with
  its original scope and 2026-09-28 implementation update preserved.
- [Findings and open review](findings.md): points to existing audit evidence.
- [Current inventory and consumer map](../../../docs/research-data/README.md)
- [Source register](../../../docs/research-data/sources.md) and
  [reproduction commands](../../../docs/research-data/reproduce.md)
- [Shared sidecar contract](../../../contracts/enrichment-sidecar.schema.json)
- [Reusable acquisition/enrichment implementation](../../../backend/api/historical_fire/)

The three enriched GOFER pilots cover 216 hours. Full source measurements, nulls,
footprints and provenance remain in ignored local sidecars; the viewer uses a compact
export. No raw dataset or processing code was moved for this documentation migration.

## Next contributions

Refresh completeness reports after NASA enrichment, verify source redistribution
terms, acquire a documented RAWS cross-check, and independently review sampled
measurements. See the [data task guide](../../../docs/research-data/contributing.md).

## Review history

A code/cache audit is recorded on 2026-09-28. It is not independent scientific review
or validation of each measurement. No domain review or accepted intervention-free
cohort is claimed. This study remains awaiting review.
