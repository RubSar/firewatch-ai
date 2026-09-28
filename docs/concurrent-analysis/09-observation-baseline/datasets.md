# Public dataset audit

Accessed 2026-09-27. This is a data-readiness audit, not an assertion that dataset
benchmark scores transfer to FireWatch. Sources are publisher or author materials.

## Selected pilot: FLAME 3 Sycan Marsh, release 1

Publisher: Bryce Hopkins. [Dataset page](https://www.kaggle.com/datasets/brycehopkins/flame-3-computer-vision-subset-sycan-marsh).
[Publisher metadata API](https://www.kaggle.com/api/v1/datasets/view/brycehopkins/flame-3-computer-vision-subset-sycan-marsh).

The inspected publisher catalogue contains 2,952 files: 738 quartets. Metadata
describes 622 Fire and 116 No Fire samples, with corrected RGB, raw RGB, thermal
visualization and numeric Celsius TIFF. The full source is about 7.5 GB. The
downloaded pilot is 24 corrected-RGB/TIFF pairs, totaling 33,260,637 bytes. File
selection is equally spaced rank within each class; it is deliberately not claimed
to be an independent random sample. The source declares MIT in its API license field;
raw metadata is retained locally. No dataset assets are committed or redistributed.

Observed directly from the downloaded files/catalogue:

- All selected RGB and numeric thermal arrays have matching 640x512 dimensions.
- Selected thermal TIFFs load as floating-point arrays, not colour palettes.
- Catalogue paths provide image-level labels; this release listing contains no
  independently annotated pixel masks. A thermal array itself is not a fire mask.
- Selected EXIF original dates are 2022-10-25/26/27. The publisher description says
  2023-10-25 through 2023-10-27. None of the inspected original-time offsets establish
  UTC. Preserve raw strings; normalized capture times and relative sequence times
  remain null. Group the whole source as `sycan-marsh-cv`, without asserting a year.
- File ranks are not a verified chronological sequence. No event onset, complete
  negative-flight duration, or geographic reference was established.

The authors describe temperature-based labeling as an option in their processing
workflow and report residual RGB/thermal registration error of approximately up to
20 pixels. We have not established which label method produced each selected image.
This prevents treating thermal-rule agreement as independent detector validation,
and prevents declaring pixel registration verified.
[FLAME 3 paper, processing section](https://arxiv.org/html/2412.02831v1).

Citation: Hopkins et al. (2024), *FLAME 3 Dataset: Unleashing the Power of Radiometric
Thermal UAV Imagery for Wildfire Management*, arXiv:2412.02831.

## Candidate data and M1 follow-up

The subsequent [M1 audit](milestone-1.md) acquired the FLAME2 masks and checked
Boreal catalogue metadata. The table below records the original candidate rationale;
current acquisition results and remaining acceptance criteria are in that audit.

| Source | Relevant evidence | Still required |
|---|---|---|
| [FLAME 1 authors' repository](https://github.com/AlirezaShamsoshoara/Fire-Detection-UAV-Aerial-Image-Classification-Segmentation-UnmannedAerialVehicle) | Links to RGB segmentation imagery/masks through IEEE DataPort | Access, exact data terms, incident/sequence provenance, mask conventions and negative coverage; author code terms are not automatically the data terms |
| [RoboFireFuseNet authors](https://github.com/dimfot3/RoboFireFuseNet) | Acquired 992 annotated triplets and audited the source palette; one incident | Target-specific independent label review, more incidents and source-count discrepancy; all acquired samples stay in pilot |
| [FLAME 3 paper](https://arxiv.org/abs/2412.02831) | Additional burns beyond the public Sycan pilot are described | Availability/access, independent labels, complete sensor metadata and unseen-site split |
| [UAV smoke segmentation study](https://openaccess.thecvf.com/content/WACV2025/html/Pesonen_Detecting_Wildfires_on_UAVs_with_Real-Time_Segmentation_Trained_by_Larger_WACV_2025_paper.html) | Teacher-assisted training of a compact smoke model is a relevant labeling/deployment direction | Dataset access, geographic overlap and the distinction between smoke segmentation and ground fire extent |

This FLAME/Boreal dataset audit did not contact authors, create accounts, download
candidate model weights or incorporate external code. The later, separate
[Prithvi satellite experiment](prithvi-cypress-creek-experiment.md) records its own
checkpoint acquisition and adapter attribution.

## Consequence for the experiment

This public pilot is useful for loading, visualization, thermal-unit handling and
finding failure modes. It cannot support unseen-incident generalization, an operational
false-alert rate, pixel segmentation accuracy, or observed ground spread. Those gaps
are dependencies for the next experiment, not values to estimate from this sample.
