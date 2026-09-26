# Fire observation research

Offline research: reproducible RGB/thermal rules (M0), followed by acquired
segmentation masks, annotation audits and incident split checks (M1). No trained
model or live API is included. The M1 benchmark acceptance gate remains blocked;
see the [measured findings](../../docs/concurrent-analysis/09-observation-baseline/milestone-1.md).

Scope: this new `backend/vision/` component holds perception research and its tests.
`contracts/research/` defines the offline manifest; research decisions/results live
in `docs/concurrent-analysis/09-observation-baseline/`. The simulator and its shared
TypeScript contracts are unaffected. API/frontend integration is a later interface
change. A vision/research component owner has not been assigned.

## Setup

Python 3.11+; tested on Python 3.12.14 with the pinned NumPy/Pillow versions.
Run these commands from `backend/vision/` in a Python environment with the dependencies:

```sh
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python download_flame3.py --per-class 12
python run_baseline.py data/flame3-pilot/manifest.json --output runs/flame3-pilot
```

Use a new output directory on each run; existing reports are preserved. On this
Windows host, the ordinary Python launcher is broken. The initial pilot used the
Codex-bundled Python runtime; its packages were not modified. The repository does
not require Codex, and ordinary Python environments can run the commands above.

The downloader requests publisher metadata and the complete filename catalogue,
then selects 12 evenly spaced filename ranks per class. It downloads only corrected
RGB and Celsius TIFF files, never the full 7.5 GB archive. Total selected media is
capped at 40 MB. Dataset version 1 is pinned; a changed publisher version requires
review. Original media and generated runs are ignored by Git. Download caching
reuses same-size local files; preserve the recorded SHA-256 manifest to independently
detect subsequent changes. Do not treat a regenerated manifest as an original checksum.

## What runs

- RGB: red >=150; red-green >=15; green>blue; saturation >=0.2.
- Thermal: finite Celsius samples >=80 C. This is an experimental anomaly threshold,
  not a universal ignition temperature or validated fire detector.
- Both remove 4-connected components below 8 pixels and require 16 remaining
  candidate pixels for an image-level positive.
- `presence_or` combines image-level decisions; there is no pixel-level fusion.
- Missing/entirely invalid thermal evidence produces null, not a negative.
  Partly invalid thermal evidence can support a positive, but cannot establish a negative.

RGB and thermal masks have distinct meanings. Numeric Celsius is read only from
floating-point TIFFs; integer sensor counts require an explicit calibrated converter.
Thermal values at/above the publisher's approximate 500 C saturation reference are
flagged and do not yield a falsely precise maximum. Visibility and sensor calibration
have not been independently assessed.

## Outputs and interpretation

- `report.json`: configuration, environment, input/code hashes, confusion counts,
  conditional metrics and reasons for unavailable metrics.
- `observations.jsonl`: sample IDs, raw/known capture times, separate processing time,
  candidate presence/masks, sensor quality flags. Ground geometry is null.
- `masks/`: PNG candidate masks, values 0=background and 1=candidate.
- `contact-sheet-*.png`: RGB candidate overlays and thermal anomaly overlays.
  Thermal contrast is normalized per image for visualization, not measurement.
- `report.md`: readable summary.

Image presence uses publisher labels. RGB IoU/Dice require independently supplied
`visible_flame` masks in RGB coordinates; without these, segmentation metrics are
null. No temporal persistence/tracking, learned inference or georeferencing is
implemented. M1 adds a separate annotation editor and human agreement scorer;
their results do not change the original M0 report.

Tests use generated synthetic fixtures solely to validate bookkeeping, missing
modalities, hash/split guards and metrics. They are not scientific performance data.

Read the [protocol](../../docs/concurrent-analysis/09-observation-baseline/protocol.md),
[dataset audit](../../docs/concurrent-analysis/09-observation-baseline/datasets.md),
and [first findings](../../docs/concurrent-analysis/09-observation-baseline/README.md).

## M1: Public mask acquisition and audit

From this directory, using the same NumPy/Pillow environment:

```sh
python download_flame2.py
python import_flame2.py data/flame2-rff/FLAME2.zip --output data/flame2-rff/prepared
python audit_annotations.py data/flame2-rff/prepared/inventory.json --output runs/flame2-annotation-audit
python prepare_benchmark.py data/flame2-rff/prepared/inventory.json ../../docs/concurrent-analysis/09-observation-baseline/flame2-split-plan.json --output runs/flame2-annotation-audit/split-gate.json
```

The last command deliberately returns nonzero for the current data and records why.
It creates a proposal report, not a frozen training manifest. Use fresh output paths
for repeated import/audit runs. The downloader reuses only an archive matching the
pinned SHA-256; download changes require review. Failed downloads leave `.partial`
files for inspection; use a new output directory when retrying. Download cap: 300 MB.
The full archive is 247 MB, and prepared images/masks need about another 250 MB.

The acquired release has 992 complete triplets, all in one pilot incident. Its source
mask colors map explicitly to background/smoke/publisher fire. These labels are not
asserted to be RGB-visible flame, and palette IR is not Celsius. The separate
[inventory contract](../../contracts/research/annotation-inventory.md) prevents
feeding this data into the M0 evaluator as if those targets/units were equivalent.

Audit outputs: checksummed inventory, `report.json`, `duplicates.json`, and five
`review-*.png` contact sheets. Original source masks are retained beside canonical
masks. Similarity is a screening heuristic; it never deletes frames or proves independence.
Review status remains pending after automatic validation and assistant visual inspection.

`audit_boreal_catalog.py` separately audits a downloaded public JSON file catalogue:

```sh
python audit_boreal_catalog.py data/flame2-rff/provenance/boreal-files.json --output runs/boreal-catalog-audit/report.json
```

Obtain that catalogue from the public `CATALOG_URL` in the script; it contains only
filenames, file IDs and sizes. This step downloads no Boreal imagery or masks and
cannot verify their pixel quality. No external code, ML frameworks or model weights
have been installed.

## M1: Independent annotation preparation

The user has no reviewers yet. The package is ready, with zero human reviews and no
accepted/frozen benchmark. From this directory:

```sh
python review_packet.py build data/flame2-rff/prepared/inventory.json runs/flame2-annotation-audit/report.json --output runs/m1-review-packet
python -B -m unittest discover -s tests -v
node --test tests/review_ui.test.cjs
```

Use a fresh output directory if the packet exists. The builder verifies the inventory
and audit hash, reuses the existing 25-case pilot selection, and emits self-contained
reviewer-A/B HTML with RGB only. No extra Python dependency, web server, account or ML
framework is required. Node is needed only for helper tests (tested with 24.19.0).

Open each reviewer's `index.html` locally. Pixels start unknown; review visible flame
and smoke separately. Export JSON frequently and import to resume. A manual JSON
field supports browsers without downloads. Share only each assigned folder; keep
coordinator mapping, source masks and the other review separate. Media stay ignored.

After receiving human exports, replace `N` with the tolerance predeclared by the
research owner (0..10 native pixels; no accepted value yet):

```sh
python review_packet.py score runs/m1-review-packet/packet.json reviewer-A.json reviewer-B.json --boundary-tolerance-pixels N --output runs/m1-human-review/comparison.json
```

Outputs include IoU/Dice, boundary F1, valid/unknown coverage and an adjudication queue.
Missing annotations never become negatives, and agreement never automatically accepts
labels or freezes a benchmark. See the [handoff](../../docs/concurrent-analysis/09-observation-baseline/review-handoff.md)
and [review contract](../../contracts/research/human-review.md).
