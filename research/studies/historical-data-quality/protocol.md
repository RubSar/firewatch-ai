> Protocol accepted 2026-09-26, with a 2026-09-28 implementation update.
> Migrated 2026-09-28 with the existing update preserved. See the
> [study README](README.md) and [findings](findings.md) for linked audit evidence.

# Historical data quality and enrichment: scope and acceptance

Accepted user direction, 2026-09-26. Build a trustworthy, traceable historical
wildfire dataset. Future prediction, prediction-error optimization and forecast
readiness gates are outside this phase. Earlier matching results remain archived
research, not a quality score for the source data.

Implementation update, 2026-09-28: base and NASA enrichment now exist for three
72-hour GOFER pilots. The complete 28-fire archive is not environmentally enriched.
See the [current inventory](../../../docs/research-data/README.md) for artifact stages and
coverage; the accepted evidence requirements below still apply.

## Functionality

Import historical events and their observed progression; validate identities, units,
chronology and coverage; enrich missing environmental information from documented
historical sources. Every derived or enriched value must preserve the original
value, source/version, method, time window, spatial footprint and quality flags.
Unresolved values stay null. Completeness and measurement accuracy are separate.

## Original import gaps and continuing priorities

The recorded import contains 82,108 CFSDS daily situations from 4,164 fires and
20,273 GOFER hourly intervals from 28 fires.

1. CFSDS: validate the original units, event/date alignment and reported missing
   measurements. Wind direction is absent in all 82,108 rows; individual core
   weather fields and wind speed each have 11 missing values. FFMC and drought
   code each have 930 missing values; DMC has 1,098. These counts overlap and must
   not be summed as distinct incomplete rows.
2. GOFER: the base imported hourly table retains null environmental fields.
   Pilot enrichments live in separate sidecars; they do not imply full-archive
   coverage. Expand only with source, spatial-support and missingness checks.
3. Align enrichment to an explicitly recorded location/geometry and historical
   interval. An ignition-point weather sample does not automatically represent
   conditions along the whole fire perimeter. A daily summary does not become
   an hourly observation through interpolation or division.
4. Distinguish structural absence from a recoverable measurement gap: the first
   situation per fire has no preceding observed interval. Do not invent earlier
   growth. Likewise, do not silently replace a missing fuel-moisture code with a
   vegetation index; they are different quantities.
5. Preserve satellite reconstruction and retrospective-footprint flags. Assess
   enriched values against an independent source where available, reporting
   discrepancies, spatial/temporal resolution and uncertainty.

## Deliverables and acceptance

- A versioned historical JSON contract, raw-source archive checksums and normalized
  records with explicit missing values and units.
- Coverage and missingness reports by source, field, event, year and region;
  duplicate, invalid-range and interval-alignment checks with documented outcomes.
- A documented enrichment method per field, including source identity, input
  geometry, time window and whether a value is observed, reconstructed or derived.
- Before/after enrichment counts and inspectable real event examples. Existing
  records are not overwritten without preserving provenance.
- Focused tests for imports, conversions, temporal/spatial joins, source consistency
  and quality flags. No prediction scores are used to accept an enrichment.

Current implementation includes imports, checksums, normalized records, pilot
sidecars with field-level provenance, quality reports and static preview export.
Full-archive enrichment, independent review and unresolved source gaps remain open.
Passing schema or completeness checks does not complete scientific acceptance.
