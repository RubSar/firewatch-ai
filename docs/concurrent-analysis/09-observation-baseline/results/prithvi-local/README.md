# Local Prithvi execution evidence

Recorded 2026-09-27. Task scope: offline `backend/vision/` research and these
summary artifacts; no frontend/API/simulator integration or training.

The selected NASA/IBM Prithvi-EO-1.0-100M burn-scar checkpoint successfully ran
on the local NVIDIA GeForce RTX 3050 Laptop GPU (4 GB). The publisher's 2018 HLS
demo was processed in 1.69 seconds, with 671,573,504 bytes peak PyTorch allocation
and 868,220,928 bytes reserved. One measurement does not establish general latency.
The resulting map is a candidate burn-scar output, not an accepted fire perimeter.

Retained files:

- `workshop-source-audit.json`: inspected workflow revision and configuration
  hash documenting the separate 300M checkpoint; it was not substituted.
- `local-demo-report.json`: model/data/code hashes, strict checkpoint load,
  environment, inference settings, measured timing/memory and output hashes.
- `adapter-compatibility.json`: original extracted inference calculations versus
  adapter calculations on one 224x224 real demo crop. Maximum observed absolute
  difference was zero for the checked backbone, neck, Conv/BN/ReLU and head.
  This is not an end-to-end legacy training-stack test.
- `catalog.json` and four `*-cmr.json` pages: public Cypress HLS discovery.
  Ten granules found; all remain unaccepted, with null quality coverage.
- `config-at-discovery.json`: the exact configuration used by that query, retained
  before the live config was updated with model pins and execution status.
  Its relative paths are relative to the original `backend/vision/` location.

The 1.2 GB checkpoint, public demo TIFF and georeferenced candidate mask are kept
in ignored `backend/vision/data/` and `backend/vision/runs/prithvi-demo-v2/`.
The initial `prithvi-demo-v1` attempt failed on NumPy scalar training metadata in
the old checkpoint. It was preserved; the fix allowlists only that representation
after hash/global inspection and retains PyTorch's `weights_only=True` loader.

From `backend/vision/`, in the documented local environment:

```powershell
.\.venv\Scripts\python.exe download_prithvi_assets.py
.\.venv\Scripts\python.exe prithvi_local.py --output runs/prithvi-demo-replay
.\.venv\Scripts\python.exe download_prithvi_assets.py --reference-sources
.\.venv\Scripts\python.exe verify_prithvi_adapter.py --output runs/prithvi-demo-replay/adapter-compatibility.json
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -v
```

Use new output paths. Asset downloads reuse only matching checksums. All 118
Python component tests passed, including eight new tests for overlap averaging,
edges, band normalization, invalid pixels, checkpoint checksums, complete
catalogue pagination and exact-time grouping. The preview was visually inspected.

No accuracy scores were computed: no independent labels/Fmask accompany the demo,
and it may overlap model development data. Cypress HLS v2 imagery acquisition,
quality screening, selection and evaluation remain pending Earthdata setup and
the case-specific runner. The drone M1 review gap is unchanged. See the
[protocol](../../prithvi-cypress-creek-experiment.md) for the next steps.
