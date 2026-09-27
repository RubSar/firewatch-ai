# Current phase: historical data quality and enrichment

Accepted user direction, 2026-09-26. Build a trustworthy, traceable historical
wildfire dataset. Future prediction, prediction-error optimization and forecast
readiness gates are outside this phase. Earlier matching results remain archived
research, not a quality score for the source data.

## Functionality

Import historical events and their observed progression; validate identities, units,
chronology and coverage; enrich missing environmental information from documented
historical sources. Every derived or enriched value must preserve the original
value, source/version, method, time window, spatial footprint and quality flags.
Unresolved values stay null. Completeness and measurement accuracy are separate.

## Verified gaps and priorities

The current import contains 82,108 CFSDS daily situations from 4,164 fires and
20,273 GOFER hourly intervals from 28 fires.

1. CFSDS: validate the original units, event/date alignment and reported missing
   measurements. Wind direction is absent in all 82,108 rows; individual core
   weather fields and wind speed each have 11 missing values. FFMC and drought
   code each have 930 missing values; DMC has 1,098. These counts overlap and must
   not be summed as distinct incomplete rows.
2. GOFER: the current imported hourly table has no environmental enrichment.
   Enrich historical weather and wind first, then terrain and pre-fire fuels.
   The previously explored Creek Fire weather example is a pilot, not enrichment
   of the complete GOFER dataset.
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

Current implementation: imports, checksum verification, normalized records and
basic missingness/coverage auditing exist. Field-level enrichment provenance,
additional physical-range/spatial checks and full GOFER environmental enrichment
remain work to implement; this scope update does not claim they are complete.
