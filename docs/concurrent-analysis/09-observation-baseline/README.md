# First fire-observation experiment

Date: 2026-09-27. Status: fixed-rule pilot completed; M1 mask acquisition/audit
executed, with full benchmark acceptance still blocked. No learned model trained
or evaluated. This starts R01, it does not complete its generalization claim.

Latest: [review handoff and recorded gaps](review-handoff.md). Prepared two independent
RGB annotation files for 25 pilot images and agreement-scoring tools. No human reviewers
are available yet; the benchmark remains unfrozen.

Additional sources: [ELMFIRE, Cell2Fire, Sentinel-2 and the verified Cypress Creek
case](external-models-cypress-creek.md). These support separate satellite/spread
evaluation work; they do not replace M1's independent drone mask review.

Executed next step: [dated Cypress Creek satellite experiment](cypress-creek-experiment.md).
Real February 16 / March 13 Sentinel-2 crops, fixed NBR/dNBR rules, cloud exclusions,
and an offline reproducible report. Exploratory Dice 0.766 and 97.89% valid AOI
coverage do not establish time-matched accuracy: reference timing/target uncertainty
remains. This separate development case does not close M1 or start M2 training.

Next step executed: [perimeter audit and two-incident satellite transfer pilot](satellite-transfer.md).
Daily Cypress geometries do not establish observed spread times. Rawlins fails the
coverage gate; County Rd 169 passes coverage but the unchanged pre-NBR floor reduces
exploratory Dice to 0.007. Preserve both attempts as development evidence and obtain
independent dated references before claiming accuracy or tuning a new benchmark.

Reference acquisition executed: [Caldor infrared reference readiness](reference-readiness.md).
Acquired 21 independently sourced NIROPS perimeter KMLs from the pinned FireBench
release; 16 pass geometry validation. A metadata-only Sentinel screen finds zero
covering matches within six hours. Original survey verification, target semantics
and temporal uncertainty remain open; no thresholds were tuned or models trained.

[M1 findings and remaining acceptance criteria](milestone-1.md): acquired
992 FLAME2 image/mask triplets, checked label encoding and similarity, and executed
the incident split gate. One incident and unresolved target/review evidence prevent
an unseen-incident visible-flame benchmark.

We downloaded and processed 24 paired RGB/radiometric images from the publisher's
FLAME 3 Sycan Marsh v1 subset (12 Fire and 12 No Fire). One prescribed burn, no
independent pixel masks, no verified flight timeline. Media stays local and ignored
by Git. [Dataset audit and sources](datasets.md).

## First result

| Fixed method | Fire-labeled images flagged / 12 | No-Fire images flagged / 12 |
|---|---:|---:|
| RGB colour rules | 8 | 9 |
| Thermal >=80 C with component filtering | 12 | 0 |
| Image-level RGB OR thermal | 12 | 9 |

These counts compare candidates against publisher image labels. They are not mask
accuracy, false alerts per flight-hour, or evidence of operational reliability. The
80 C threshold and RGB parameters were fixed before evaluation; no post-result tuning
was used. The thermal row is a small-sample agreement result, not proof of perfect
detection. Publisher-label independence from thermal thresholds remains unverified.

Visual inspection of contact sheets shows RGB candidates on brown vegetation/bare
ground in several No Fire images. Smoke obscures visible evidence in some Fire
images while thermal candidates remain. These are qualitative observations, not
new ground-truth annotations. Simple OR inherits RGB false positives; the pilot
does not demonstrate that fusion improves the stronger individual baseline.

An additional finding is a clock-provenance discrepancy: image EXIF dates are in
2022 while the publisher description says 2023; original timezone offsets are
unavailable. Capture UTC and elapsed sequence time remain null instead of guessing.

## Reproduce and review

- [Runnable component](../../../backend/vision/README.md): dependencies, download/run commands and output descriptions.
- [Experiment protocol](protocol.md): objective, baselines, frozen-split rules and milestones.
- [Offline contract](../../../contracts/research/README.md): units, coordinates, unknown states and validation.
- [Recorded machine-readable result](results/pilot-report.json): exact parameters, counts, timing scope, code/input hashes.
- [Selected file manifest](results/pilot-manifest.json): provenance/checksums only; paths are relative to the downloaded data folder, not this copied report folder.

The original run also creates local `observations.jsonl`, PNG candidate masks and
four visual contact sheets under `backend/vision/runs/`. Those generated media are
not source-controlled. A report manifest copied here is an audit record; execute
against `backend/vision/data/flame3-pilot/manifest.json` after downloading.

## Next research dependency

Finish M1 by establishing independently reviewed target-compatible masks and
multiple incident groups, then train a compact RGB segmentation model. Keep
Sycan pilot images in development data. Use another incident for untouched testing;
do not manufacture a train/test result by randomly splitting related images from
this one burn. Thermal/temporal fusion follows only after data and registration checks.

The present baseline includes no learned model, motion tracking, calibrated ground
mapping or simulator integration. Component tests validate computation and data
integrity, not the scientific hypothesis. Named component ownership is still unassigned.

Verification performed: 27 component tests passed; the 24 real image pairs completed
the final fixed-rule run with the counts above; RGB/thermal contact sheets were
visually inspected. Input/code hashes and missing-metric reasons are retained.
