# Historical data quality and enrichment

For the current cache inventory, source attribution, consumer map and contributor
setup, start with the [historical data documentation](../../research-data/README.md).
The experiment results and handoff details below describe their original run.

Current scope (user clarification, 2026-09-26): historical data quality and enrichment
only. See [current phase](data-quality-phase.md). The default runner imports sources
and writes normalized historical records and a quality report, then exits.

The earlier matching implementation and findings are retained as completed research.
They are not acceptance criteria for this phase. The phase does not develop or run
future-fire prediction.

## Previous research run

See [measured findings](findings.md), [data-quality counts](data-quality.json),
[evaluation summary](results-summary.json), and [runtime checksums](runtime-manifest.json).
The [real comparison examples](../../../contracts/examples/historical-comparisons.real.json)
include three held-out query situations and twenty independent-fire matches each.
The [hourly example](../../../contracts/examples/historical-gofer.real.json) uses the
same situation contract with missing environmental measurements explicitly null.

The run imported 82,108 CFSDS situations from 4,164 fires; 76,919 situations were
complete for matching. The held-out test contains 11,995 situations across 546 fires.
All methods selected k=20. Environmental matching reduced macro MAE from 438.36 to
401.89 ha versus state-only matching (8.3%), and from 509.48 ha versus persistence
(21.1%). Ecozones 14 and 9 did worse than state-only matching; the geographic benefit
is not uniform. These remain retrospective results, not validated forecast accuracy.

The GOFER adapter imported 20,273 hourly intervals across 28 fires. The first snapshot
of each fire was excluded because its preceding interval is not observed.

Repository handoff: based on local revision `000db85` in an isolated
`codex/historical-similarity` checkout. Remote revision/overlapping PR checks could
not be completed because GitHub credentials were unavailable. Application and
frontend changes in the original checkout were preserved. The only dependency
changes add the optional `research` extra and its lock entries; existing locked
package versions were not updated.

## Reproduce

From `backend/api/`, using Python 3.11+ and uv:

```sh
uv sync --frozen --extra research
uv run --frozen --extra research python -m historical_fire \
  --download --data-dir .research-data/cfsds-v1.1 \
  --output .research-data/quality --gofer /absolute/path/GOFERC_summary.csv
uv run --frozen --extra research pytest -q tests/historical_fire
uv run --frozen --extra research ruff check historical_fire tests/historical_fire
```

`curl` is required for downloads. Omit `--download` for an offline rerun; archives
are still checksum-verified. Omit `--gofer` if the hourly archive is unavailable;
the daily experiment is independent. GOFER input is the Combined v0.2 summary CSV
from the [versioned archive](https://zenodo.org/records/14642378). Do not supply
East/West variants or another version under this label.

`historical_fire/sources.json` pins all twenty public OSF yearly archives by SHA-256.
The original publication described v1 (3,269 fires, 70,895 days), but the public
repository currently serves **v1.1**, with fires >500 ha, 90 m processing and additional
years. We use only 2002–2021. Published v1 counts are not asserted as v1.1 counts.
The pinned files are the reproduction authority; changed source checksums fail.
Release notes describe beta status and topology fixes. See the saved release notes.

Sources: [CFSDS methods](https://www.nature.com/articles/s41597-024-03436-4),
[data repository](https://osf.io/f48ry/),
[v1.1 release notes](https://osf.io/download/8fe4u/),
[GOFER methods](https://essd.copernicus.org/articles/16/1395/2024/).

To reproduce the earlier comparison study explicitly, add `--run-comparisons` and
use a separate output directory such as `.research-data/comparisons`. Default data-only
runs reject a directory containing old comparison outputs to avoid confusing artifacts.

## Previous experiment design

All three analog methods and persistence use the same complete-case cohort so
differences are paired. First intervals, gaps and missing required environmental
features are excluded from matching, retained in normalized data, and counted.
Missing direction and source-averaged aspect are preserved but not required: aspect
averages cannot reliably reconstruct directional terrain relationships.

Explicit matching groups:

| Group | Features |
|---|---|
| Fire state | log1p(starting hectares), log1p(previous growth hectares) |
| Terrain | elevation, slope, topographic wetness index |
| Fuels | biomass, canopy cover, conifer percentage, peat fraction, nonfuel fraction within 1 km |
| Weather | maximum temperature, humidity, rain, VPD, FFMC, DMC, DC |
| Wind | speed |

Normalize each numerical feature by training mean/standard deviation. Constant
features use scale 1. Each feature contributes equally within its group; groups
have equal total weight. Environmental matching includes all five groups; state-only
matching includes the two state features. There are no outcome-driven group weights.

Choose the nearest row per eligible historical event, then the nearest distinct
events. Random matching samples events uniformly and one row uniformly within each;
its deterministic seed is derived from seed 42 and query identity. Current event
IDs are excluded. Select k from 5/10/20 by lowest validation MAE, with smaller k
breaking ties. Each method selects its own k. Test results never tune parameters.

Training: 2002–2015; validation: 2016–2018; final test: 2019–2021. Every fire stays in
one temporal partition. All test metrics average within fires before across fires.
The persistence estimate is previous-interval growth; it has no empirical analog
range, so its interval metrics are null. All empirical quantiles use NumPy's default
linear interpolation. Variability is measured as p90 minus p10.

Geographic evaluation withholds each test ecozone from the historical library,
removing entire training fires that touch that ecozone. It refits normalization and
selects k on validation-year queries in that region, then evaluates test-year queries
there. Regions without validation data are reported as insufficient. Region-specific
validation informs tuning, so this is not completely unseen-region model selection.

Bootstrap the paired **per-fire mean errors**, with 1,000 whole-fire resamples and
seed 42. Positive improvement means environmental matching has lower error.
The temporal gate requires the 95% improvement interval to be positive against both
state-only matching and persistence. Geographic findings must also be reviewed
before proposing a separate forecast study; no gate activates a live system.

## Outputs and limitations

The default runner writes normalized daily/hourly JSONL, source/runtime manifests,
quality counts and an hourly example when provided. `--run-comparisons` additionally
writes per-query test comparisons, per-fire metrics, validation tuning results,
temporal/geographic evaluations, three real examples and a findings report. Full data stays ignored; small reports and examples are
tracked for review. A run fails visibly if acquisition, checksum or schema checks
fail; it never substitutes synthetic data.

This evaluates **association under reconstructed historical conditions**. Inputs
may describe the realized burn footprint or weather observed during that interval.
Holding out fires prevents event memorization; it does not remove those retrospective
advantages. Suppression, missing wind direction, satellite uncertainty, complete-case
selection and restriction to large Canadian fires remain limitations. More archive
rows do not create more independent fires.

Forecast work requires pre-interval spatial features and weather available at issue
time. GOFER's hourly target coverage is audited separately; no hourly environmental
matching result is claimed until its missing terrain, fuels and weather are enriched.

Tests live in `backend/api/tests/historical_fire/`. Shared contract fixtures live in
`contracts/examples/`. The offline similarity experiment itself needs no Earth Engine
credentials or LLM. The enrichment pilot below requires Earth Engine for raster enrichment
and local Ollama for report extraction.

## GOFER enrichment pilot

The new first-stage enrichment workflow processes the first 72 hourly intervals each for
Creek, Kincade and Bobcat, leaving source archives immutable. See the [pilot procedure](enrichment-pilot.md),
[measured findings](enrichment-findings.md), [sidecar contract](../../../contracts/enrichment-sidecar.schema.json),
and the [real Creek interval](../../../contracts/examples/enriched-creek-2020-hour.json).
Runtime interval sidecars and raw source responses are ignored research data; the tracked
findings summarize coverage and gaps. No prediction endpoint or matching-performance claim
was added.
