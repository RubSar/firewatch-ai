# Prithvi burn-scar experiment: Cypress Creek

Date: 2026-09-27. Status: **local 100M model inference verified on a public demo;
Cypress imagery acquisition and evaluation pending**. This is a satellite burned-area experiment, separate from
drone M1. It uses an existing NASA/IBM Prithvi-EO burn-scar checkpoint; it does not
train or fine-tune a FireWatch model.

Task scope: `backend/vision/` local inference adapter, public catalogue, tests,
research configuration and evidence under this protocol. No API,
frontend, simulator, or shared contract changes. The experiment preserves the
existing Cypress Creek Sentinel-2/dNBR result. See the machine-readable
[configuration](../../../backend/vision/prithvi-cypress-creek-config.json).

## Question and model

Can the pretrained Prithvi-EO burn-scar model identify a burned-area mask on a
post-containment HLS scene for the Cypress Creek development case, and how does
its descriptive overlap with the retained WFIGS polygon compare with a fixed dNBR
baseline?

The selected model is
[`ibm-nasa-geospatial/Prithvi-EO-1.0-100M-burn-scar`](https://huggingface.co/ibm-nasa-geospatial/Prithvi-EO-1.0-100M-burn-scar).
It is already fine-tuned for burn-scar segmentation on HLS. Its inputs are six
reflectance bands, in order: blue, green, red, narrow NIR, SWIR1, SWIR2. The
published checkpoint card describes values in reflectance units from 0 to 1 and
provides an HLS inference implementation. The NASA-IMPACT
[2026 workshop workflow](https://github.com/NASA-IMPACT/HLS-workshop-2026-Prithvi-Applications)
demonstrates HLS scene discovery/mosaicking, Prithvi tiled inference, Fmask
exclusions, and pixel-mask scoring. Inspection found that workshop uses a separate
`prithvi_eo_v2_300` UperNet checkpoint with different normalization. It is not a
drop-in loader for our chosen 100M model. We retain the 100M checkpoint and adapt
the original [HLS foundation implementation](https://github.com/NASA-IMPACT/hls-foundation-os/tree/3b6d401f3b4527059af0e44bd640225285e1933d)
in `prithvi_legacy.py`; the workshop remains a workflow reference only.

The model revision is `0e9e0dba1045e9c4e05a4d68c7b8de2fc6768a7b` and checkpoint
SHA-256 is `9285c40cc6005c1bafb40c3d245aafd445f37ba2d89b6ec5af7b21316e0fc284`.
It loads with strict state-dictionary matching and `weights_only=True`; only the
inspected NumPy float64 scalar metadata representation is allowlisted. No model
config Python is executed. `prithvi-assets.json` pins the checkpoint and public
demo; `THIRD_PARTY_PRITHVI.md` documents the architecture adaptation and license.

This model predicts a burn scar from a single satellite date. It does not predict
active flames or future spread. The WFIGS record's geometry time is unresolved;
the existing Sentinel-2 experiment documents a material gap between its polygon
time and post-containment image. Therefore, any score here is exploratory overlap,
not time-matched accuracy or evidence of unseen-fire generalization. The WFIGS
polygon is an incident perimeter, not pixel-level burn-scar truth; reported precision
and recall are proxy overlap against that perimeter.

## Frozen case and input selection

Use the existing Cypress Creek incident UUID, frozen WFIGS source snapshot and
AOI. Search NASA HLS for `HLSS30` and `HLSL30` surface-reflectance scenes within
the existing pre-fire window (2026-02-10 through 2026-02-24 18:29:59 UTC) and
post-containment window (2026-03-09 19:18 through 2026-03-24 23:59:59 UTC).
Record all returned granules and acquisition times. Group granules only by product
family and exact sensing time; do not mix `HLSS30` with `HLSL30` in a mosaic. Sort
post groups by acquisition UTC ascending, then product and granule IDs. Select the
first post group that has at least 95% Fmask-valid AOI coverage and a same-product
pre group in the pre-fire window whose joint valid AOI coverage with that post
group is at least 95%. For that post group, pair the latest eligible pre group;
break timestamp ties by product and granule IDs. If no pair passes, record the
failed gate rather than broadening dates or lowering coverage after seeing results.
This metadata/Fmask-only selection never uses model outputs or reference agreement.

Use the six model bands in the exact order above and the product's reflectance
scale/offset. Mask cloud, cloud shadow, snow, water and no-data with HLS Fmask;
preserve those pixels as unknown. Mosaic overlapping HLS tiles on a recorded
common 30 m grid. Re-rasterize the retained WFIGS geometry directly on that grid;
do not resize the existing 20 m Sentinel-2 reference raster. Record grid origin,
CRS, transform, HLS scene IDs, acquisition UTCs, band provenance, masks, scale and
offset, local SHA-256 hashes, processing code commit, model revision, checkpoint
hash and software/GPU environment.

## Evaluation

Run the published checkpoint without fine-tuning or custom score thresholds.
Preserve its published 224x224 inference crops and 112-pixel stride. Process one
crop at a time in float32 and average overlapping logits before class argmax.
512x512 is the publisher's example image size, not this model's forward crop size.
Invalid input pixels use the normalization mean (zero normalized); retain their
output as unknown and record that their effect on nearby valid pixels is unverified.
Compare its burn-scar class with the WFIGS geometry only on common valid pixels.
Report IoU, Dice/F1, precision, recall, valid and unknown coverage, predicted area
in hectares, area bias, confusion counts, exact scene/reference times and the
comparison map. Unknown pixels must not count as negatives.

Compute the dNBR baseline from the paired HLS scenes on the same grid and valid
mask, retaining the existing fixed rules `dNBR >= 0.1` and
`dNBR >= 0.1 AND pre-fire NBR >= 0.1`. These are frozen exploratory comparators,
not thresholds validated for HLS. The existing Sentinel-2 scores are context only;
they use different imagery, resolution and processing. Do not tune the model,
thresholds, dates, or candidate scene selection against Cypress Creek. One incident
cannot support a transfer or generalization claim. A better reference with known
observation time and later independent incidents would be needed for stronger
validation.

## Portable execution

The model and workflow are kept outside the production application. At execution,
use the pinned 100M adapter in a clean environment, record its exact
commit and resolved Python/PyTorch/CUDA/TerraTorch versions, and save model/data
hashes with the report. If using an NVIDIA server or a Lepton Dev Pod/Batch Job
later, resolve and record that platform's environment separately; the Windows
lockfile below is not portable to Linux. The analysis does not depend on
Lepton-specific APIs. The upstream workflow describes an Earthdata login for HLS
downloads. Credentials must be entered into the approved runtime secret
mechanism, never committed to this repository. Keep downloaded scenes,
checkpoints, masks and run outputs in ignored local/cloud storage; commit only
sanitized config and summary evidence.

Local setup was completed on 2026-09-27 in the ignored
`backend/vision/.venv/` environment using Python 3.12.14, PyTorch 2.11.0+cu128
(CUDA 12.8), TerraTorch 1.2.13, JupyterLab 4.6.4 and the NASA workflow's
HLS/geospatial dependencies.
The recorded environment registered a `FireWatch Prithvi (CUDA)` Jupyter kernel.
Its device was an NVIDIA GeForce RTX 3050 Laptop GPU with 4 GB VRAM. PyTorch
reported CUDA available, identified that GPU and completed a CUDA tensor smoke
test; required-library imports passed and `pip check` found no broken requirements.
The exact package freeze is `backend/vision/requirements-prithvi-local-lock.txt`.
The subsequent public-demo run completed on this GPU. It processed a 512x512
six-band HLS image through 16 overlapping crops in **1.69 seconds**, with
**641 MiB allocated / 828 MiB reserved** peak PyTorch GPU memory. Loading plus
inference took 5.76 seconds. These are one-run measurements, not a throughput
benchmark or total system/GPU memory usage. No mixed precision or resizing was
used. An extracted-source comparison on one real 224x224 crop matched the original
backbone, neck and FCN calculations exactly on this environment. It does not test
an entire legacy MMSegmentation installation or its training/augmentation paths.

The [retained evidence](results/prithvi-local/README.md) records the asset hashes,
environment, numerical compatibility check, public catalogue and reproduction
commands. All 118 component Python tests passed. The demo image is a publisher
HLS S30 v1.4 example from 2018; Cypress candidates are HLS v2.0. The demo has no
Fmask or independently scored labels, and may overlap model development data.
No accuracy, unseen-fire transfer or Cypress result is inferred from this test.

Expected artifacts: HLS acquisition manifest; band-stack provenance; Fmask/valid
mask; tiled Prithvi class output; the paired HLS dNBR mask; common-grid WFIGS
reference; a metric JSON report; and a comparison overview. Write to a new run
directory and preserve partial failures for diagnosis. The experiment status is
`local_demo_verified_cypress_imagery_pending`; a public demo does not complete the
Cypress experiment.

## Current blockers and limits

- Public CMR metadata returned ten granules: three S30 and two L30 before the
  fire, and three S30 and two L30 after containment. No Cypress image pixels or
  Fmask layers have been acquired; metadata alone cannot pass the 95% coverage
  gate. The first catalogue and original config hash are retained in the evidence.
- The user needs to create an Earthdata account. Register at the official
  [Earthdata page](https://urs.earthdata.nasa.gov/users/new), verify the email and
  sign in locally. In Python/Jupyter, use `earthaccess.login(strategy="interactive",
  persist=False)` and keep downloads in that same process. Never put credentials
  in chat, notebook cells or tracked files.
- Public discovery and a pinned-demo runner are implemented. The authenticated
  Cypress acquisition, Fmask screening, pairing, common-grid processing and
  comparison runner remain to be completed before calling this an experiment run.
- The recorded RTX 3050 run demonstrates local execution feasibility; a new
  contributor must supply and verify their own environment. No cloud allocation
  is part of this repository.
- The WFIGS geometry's observation time is unresolved, so this case cannot
  establish time-matched burn-scar accuracy.
- A burn-scar mask is not an active-fire perimeter. This result cannot be shown
  as a confirmed live boundary in the product.

Next: finish Earthdata registration/login, implement and execute the authenticated
acquisition/screening stages using the saved catalogue, then run the unchanged
model and dNBR rules on an accepted pair. Preserve the original dates and coverage
gate. Do not substitute the public demo or older Sentinel-2 crops for Cypress HLS.
