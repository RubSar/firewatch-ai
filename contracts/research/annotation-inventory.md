# Annotation inventory and split proposal v1

These additive offline formats do not change `firewatch.research.dataset.v1` or
production API contracts. The original runner accepts only its visible-flame
ground-truth format. It rejects an annotation inventory by schema version.

## Inventory

`firewatch.research.annotation_inventory.v1` is implemented by
`backend/vision/import_flame2.py` and validated by `audit_annotations.py`. This first
adapter supports the publisher's background/smoke/fire target, not arbitrary palettes.

Top-level fields: `data_kind` real/synthetic; dataset/source identifiers; source
commit/archive hash; creation UTC; generating-code hashes; publisher-declared licenses;
annotation provenance; exact label/color maps; modality limitations; sampling; records.
Provenance records the reported method/authors, evidence modalities, annotation time,
individual reviewer IDs, independent-review status and agreement evidence. Unknown
fields remain null or explicitly unresolved, never filled with inferred authors/dates.

Each record has a stable sample ID and source ID, incident/site IDs, pilot/train/
validation/test membership, original split when known, sequence/capture/relative time
when verified, registration status, source filenames, relative paths and SHA-256 hashes
for RGB, IR display, source mask and canonical mask. It also records height/width,
source image modes, decoded RGB hash, difference hash, label pixel counts, annotation
revision and review status. All media paths are confined to the inventory directory.

Coordinates: image origin top-left, x increasing right, y increasing down. Masks and
media have identical dimensions; no silent resizing. Canonical mask: uint8 PNG,
0=publisher background, 1=publisher smoke, 2=publisher fire, 255=ignore. Source RFF mask:
RGB(A) colors 0/125/255 respectively, with opaque alpha. Source white is **not ignore**.
This is not the binary visible-flame mask accepted by the baseline runner.

IR display PNGs have no temperature unit and cannot be used as Celsius arrays.
`publisher_pairing_unverified` says only that source file identifiers pair; it is not
verified spatial alignment. Native fire/smoke overlap is resolved by the publisher's
fire-priority convention, which does not preserve independent overlapping targets.

Audit outputs record counts, hashes, duplicate candidates and contact-sheet sample IDs.
Difference-hash neighbors are review candidates only. Validation is data-integrity
validation, not proof of correct labels, incident identities or independent annotation.

## Split proposal and gate

`firewatch.research.split_plan.v1` contains a target (`visible_flame`, `publisher_fire`
or `publisher_smoke`) and `incident_assignments`, covering exactly all inventory incidents.
Each incident maps to one pilot/train/validation/test value. No per-frame random split
is supported. This version checks one inventory per invocation; multi-source merging
and a smoke-only adapter are not implemented. Existing Sycan data stays in its own
unchanged M0 manifest and must not be silently merged with incompatible RFF labels.

`prepare_benchmark.py` checks required groups, site/sequence separation, pilot exposure,
target compatibility, review status, sensor/decoded RGB duplicates and cross-split
similarity candidates. It writes `firewatch.research.split_gate.v1` with explicit reasons,
input/code hashes and proposed per-sample assignments. Status is `blocked` or
`ready_for_review`; `frozen` remains false. Blocked proposals return a nonzero CLI exit.
The tool does not train, approve a benchmark, decide scientific sample size, or provide
an override for unresolved near-duplicate candidates.

`independent_review_accepted` and `independent_second_review=true` assert external
review evidence described in the annotation guide. The tool cannot authenticate these
assertions. Do not edit flags to make an unreviewed release pass. Training readiness
also requires the scientific checks and target-specific negative coverage in the protocol.
