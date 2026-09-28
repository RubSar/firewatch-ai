# Dated infrared reference acquisition and timing screen

Date: 2026-09-27 (local; evidence timestamps are UTC).
Status: reference acquisition and readiness audit executed. Acquired 21 Caldor
infrared perimeter files; 16 pass strict geometry checks. None of those 16 has a
covering Sentinel-2 acquisition within the provisional six-hour screen. This is
data-readiness evidence, not an accuracy result or a completed ML benchmark.

Scope: `backend/vision/` acquisition/audit tools, `contracts/research/` formats, and
this research directory. The recorded run used `codex/cypress-creek-case` with
remote main at `3f7ca27`; these are historical provenance, not current checkout
instructions. Existing Cypress/transfer outputs were preserved. Vision/research ownership is unassigned. No API/UI interface changes.

## Source search and the 2026 reference gap

[NIFC's file-share notice](https://ftp.wildfire.gov/) explains that incident data
moved from `/public/incident_specific_data` to an authenticated path on May 4,
2026. Its public map area remains available. We checked the 2026 Rocky Mountain and
Southern index pages; neither listed a matching folder for Rawlins Co TP, County
Rd 169 or Cypress Creek. This bounded search does not establish absence from every
archive. No authenticated data were accessed and no access request was sent.

[MTBS methods](https://www.mtbs.gov/mapping-methods) use reflectance and NBR-family
images to draw boundaries. MTBS is therefore a useful comparison source, but it
cannot automatically establish independent truth for an NBR-based method. Its
[availability page](https://www.mtbs.gov/data-availability) currently describes
mapping the 2023–2025 fire seasons. No 2026 MTBS reference was acquired.

An alternative [2020–2024 NIROPS collection](https://doi.org/10.17632/95rj5d379g.1)
is a potential future multi-incident source. Its publisher describes estimated
timestamps for some records and geometry repair. It needs record-level provenance
screening before admission; we did not download or score that collection.

For a tractable public reference audit, we selected **Caldor 2021**, distinct from
all three previously inspected incidents. This is a reference-development case,
not a replacement for a failed 2026 case and not a held-out evaluation result.

## What was acquired

Source: [FireBench Caldor data release 2026.2](https://doi.org/10.5281/zenodo.20279621),
curated by the Wildfire Interdisciplinary Research Center at San Jose State
University. [The publisher's methods](https://firebench.readthedocs.io/en/0.8.0/benchmarks/California/01_Caldor.html#infrared-fire-perimeters)
describe manual extraction of aerial NIROPS perimeters and timestamps from flight
reports. This provides an independent sensor lineage relative to Sentinel-2
reflectance, while retaining human interpretation and survey-coverage limitations.

Downloaded all 21 dated IR KML files and four terms/license/changelog files using
2,769,335 response bytes in HTTP range reads. The archive is 696,606,018 bytes.
Each selected member passed ZIP CRC-32 checks and has a saved SHA-256. The whole
archive MD5 was **not** verified. The unrelated HDF5, MTBS boundary and executable
benchmark were not downloaded. Attribution and the NIFC data notice are retained.

The explicit timezone-bearing timestamp list was read as a Python AST literal from
[FireBench configuration at commit 82c233c](https://github.com/wirc-sjsu/firebench/blob/82c233cff702699335c6b8e88fb79596b98775de/src/firebench/benchmarks/c001_caldor_config.py).
No external code was executed. A registry binds each supplied timestamp to one KML
SHA-256. Four timestamps use UTC−06:00; the other 17 use UTC−07:00. Preserve those
explicit offsets when normalizing UTC, rather than assigning one assumed timezone.
The original flight-report documents and HDF5 metadata were not independently
verified in this run. Thus times remain **publisher-curated**, not certified by us.

## Geometry audit

All source polygon rings must be closed, finite, within WGS84 bounds, and valid.
Preserve holes; combine valid parts by set union. Do not call `buffer(0)` or repair
a self-intersection. If any polygon in a dated file is invalid, exclude the entire
file from the usable geometry set and retain its error. This conservative rule does
not assert that every part of the rejected observation is scientifically unusable.

| Rejected capture UTC | First detected defect |
|---|---|
| 2021-08-20 03:45 | Ring self-intersection, polygon 38 |
| 2021-08-26 09:30 | Ring self-intersection, polygon 4 |
| 2021-08-27 04:15 | Ring self-intersection, polygon 4 |
| 2021-08-27 06:22 | Ring self-intersection, polygon 0 |
| 2021-08-29 03:30 | Ring self-intersection, polygon 0 |

The [audit report](results/reference-readiness/reference-audit.json) records defect
coordinates, normalized geometry hashes, source component counts, and EPSG:5070
areas. The 16 valid observations span Aug 18 03:20 through Sep 11 06:34 UTC.
Consecutive valid geometries are not perfectly nested: endpoint removals range
from about 1.5 to 128.6 ha. Mapping differences cannot be interpreted automatically
as fire retreat. Missing/rejected dates are explicit; elapsed gaps are retained.
Endpoint differences are neither interpolated perimeters nor observed spread rates.

An IR outline represents mapped extent at a survey time. It does not establish
that every interior cell burned or contains active flame. A future evaluation must
declare its target and treatment of unburned islands, survey coverage and uncertainty.

## Satellite timing screen, before any pixel acquisition

The [policy](results/reference-readiness/timing-policy.json) was saved before the
Sentinel catalogue query. It uses all 16 valid references, the fixed surrounding
date window, tile cloud <=60%, and same-platform/datatake footprint unions with
capture spans <=300 seconds. For each reference choose the nearest group that
covers its whole geometry. The gap is the **largest** absolute time difference
among that group's first/last tile captures, not a favorable average time.

The complete query returned 66 Sentinel-2 Collection 1 items, grouped into 11
eligible overpasses. Nearest covering gaps range from **8.27 to 35.59 hours**.

| Maximum capture gap | Reference observations within limit / 16 |
|---|---:|
| 1 hour | 0 |
| 3 hours | 0 |
| 6 hours — provisional primary screen | **0** |
| 12 hours — descriptive sensitivity | 7 |
| 24 hours — descriptive sensitivity | 13 |

These counts are repeated observations of one fire, not independent incidents.
Six hours is a research screening choice, not a validated physical bound on fire
change. Do not widen it after seeing these results and call the outcome a pass.
Footprints and tile cloud percentages cannot establish local visibility; no satellite
pixels or local SCL masks were acquired. See [the exact timing results](results/reference-readiness/timing-screen.json).

## Decision and concrete next experiment

Keep the existing dNBR and pre-NBR rules unchanged. Do not tune them to these
perimeters or replace the three earlier failed/unresolved cases. Caldor is now part
of reference development; any future learned or tuned method needs new incidents.

The next useful executable experiment is an **interval-based extent comparison**:
for each satellite capture, identify independently documented valid surveys before
and after it, retain the elapsed interval, and mark disagreements between their
geometries as temporally uncertain. The endpoint intersection/union may be reported
as a sensitivity envelope, but must not be relabeled as observed intermediate-time
truth. Temporal stability, survey completeness and target compatibility still need
evidence before scoring burned-pixel accuracy. This protocol is proposed, not run.

Before that experiment, resolve the five invalid geometries against original reports
or record a separately reviewed correction; acquire survey logs through an authorized
source; and define a bounded tiling strategy. Caldor's final mapped area alone spans
about 2.22 million 20 m cells, exceeding the existing single-case 400,000-cell cap.
Do not silently lower resolution or truncate the AOI to fit.

For eventual spectral development, the
[Relativized Burn Ratio paper](https://doi.org/10.3390/rs6031827) provides a candidate
comparison to investigate for varying pre-fire vegetation. Its burn-severity results
do not validate current fire extent or supply a universal threshold. No RBR threshold,
ML model, or improvement claim is introduced here. M1 still awaits independent human
reviewers and accepted target-compatible drone masks.

## Reproduction and validation

The [evidence bundle](results/reference-readiness/README.md) includes immutable source
IDs, manifests, publisher timestamp configuration and license, policies, audit and
timing results. Native KMLs and derived GeoJSON stay under ignored component data/run
directories. Four small Python tools provide checksummed re-acquisition, geometry
audit and offline timing checks. They use existing optional satellite dependencies.

Synthetic tests cover topology, holes, explicit timezone offsets, path containment,
source changes, incomplete catalogues, group separation, conservative temporal gaps,
bounded HTTP ranges and checksum requirements. These validate computation and
provenance handling, not scientific truth. Final check results are recorded in the
bundle's verification file.

Final checks: **110 Python tests passed**, including 20 new reference/archive tests.
A fresh download matched all 25 source-file SHA-256 values; offline replay reproduced
the geometry bytes and audit/timing results. All 43 checked local documentation links
resolved. `git diff --check` passed; earlier baseline code and transfer-report hashes
were unchanged. Work is local and uncommitted on the research branch; main remains
clean. No PR, notification or external data-access request was sent.
