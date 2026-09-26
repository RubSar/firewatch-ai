# Offline observation research manifest v1

This contract is only for research files. It does not change production API events
or `frontend/contracts/`. Canonical format: this document. Executable validation:
`backend/vision/dataset.py`. A compact example is in `manifest.example.json`;
example paths/hashes are illustrative and do not describe downloadable assets.

M1 adds a separate [annotation inventory and split proposal](annotation-inventory.md).
It preserves the publisher's multiclass fire/smoke target and display-only IR without
weakening this runner's visible-flame/Celsius requirements.

## Dataset fields

| Field | Meaning |
|---|---|
| `schema_version` | Exact string `firewatch.research.dataset.v1` |
| `data_kind` | `real` or `synthetic`; never combine simulated examples with real evaluation counts |
| `dataset_id`, `dataset_version` | Stable source identity and source release/version |
| `source_url`, `publisher_license` | Source page and publisher-declared terms, not an independent legal interpretation |
| `sampling` | Explicit sampling procedure; include selection before/after analysis |
| `label_provenance` | Who/what produced labels; distinguish manual, model and threshold labels |
| `records` | Nonempty list of the records below |

## Per-record fields

| Field | Meaning |
|---|---|
| `sample_id` | Unique nonempty sample identifier |
| `incident_id` | Known incident grouping; all imagery of one burn stays in one split |
| `sequence_id` | Known sequence ID or null; the pilot does not infer sequences from renamed filenames |
| `split` | `pilot`, `train`, `validation`, or `test` |
| `capture_time_utc` | ISO 8601 UTC ending in Z, or null when unverified; never substituted with download/processing time |
| `relative_time_s` | Finite, nonnegative capture seconds from a documented sequence origin; requires sequence_id; otherwise null |
| `source_capture_time_raw` | Optional raw EXIF datetime/offset and unresolved-status note; not a normalized timestamp |
| `presence_label` | Publisher/reviewer image-level Fire/No Fire boolean, or null; not a complete perimeter label |
| `rgb_path` | Relative RGB image path, or null |
| `thermal_path`, `thermal_unit` | Relative floating-point 2D TIFF in `celsius`, or null input; raw counts/palette images unsupported |
| `thermal_saturation_c` | Optional finite publisher/calibration saturation reference in Celsius, otherwise null/absent; 500 C is specific to this FLAME 3 pilot, not universal |
| `registration` | `verified`, `provider_corrected_fov_unverified`, `unregistered`, `not_applicable` |
| `mask_path`, `mask_semantics` | Optional ground truth; this milestone supports `visible_flame` in RGB coordinates only |
| `sha256` | Lowercase hexadecimal byte hashes for every present `rgb`, `thermal`, `mask` file |
| `source_paths` | Optional original publisher filenames for provenance |

All paths resolve relative to the manifest, must remain inside that directory and
must exist. Images use top-left origin, x=column increasing right and y=row
increasing down; dimensions are height x width. Masks must match RGB dimensions;
no silent resizing. Ground-truth mask values: 0=background, 1=visible flame,
255=unannotated/ignore. Absence of a mask is null, never an all-background mask.
An entirely unannotated mask contributes no valid pixels. No CRS, square metres or
ground spread speed can be inferred from this image-space format.

Validation rejects duplicate sample IDs, unknown units, path escapes, checksum
mismatches, incident/sequence leakage and byte-identical media across splits.
Hash checks cannot detect all near-duplicates; incident grouping remains mandatory.
Validating a manifest does not prove that its label provenance or incident IDs are true.

## Result format v1

`firewatch.research.result.v1` records the input manifest SHA-256, algorithm config,
code hashes, dependency versions, sample/incident counts and evaluated split.
Confusion counts use only labeled samples with available predictions; unavailable
and unlabeled denominators are explicitly counted. Zero-denominator precision/recall
is null. Pixel IoU/Dice aggregate valid pixels, with empty union reported as null.
No confusion rate is labeled "false alerts per hour" without a continuous flight timeline.

Observation JSONL records preserve the sample identity, raw/verified capture time,
processing UTC, mask paths and separate semantics for RGB flame candidates and
thermal anomalies. Predictions are boolean or null. Three-valued OR is true if
either available modality is positive, false only if both are negative, otherwise
null. Scores are rules, not calibrated probabilities. No confirmed-fire state or
live notification follows from these observations.

## Additional M1 formats

[Annotation inventory and split proposal](annotation-inventory.md) preserve publisher
multimodal label semantics. [Independent human review](human-review.md) defines separate
RGB-visible flame/smoke masks and agreement outputs. Neither format automatically
approves labels or freezes a benchmark; the original M0 contract remains unchanged.
