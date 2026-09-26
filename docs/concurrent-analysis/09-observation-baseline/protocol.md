# R01: Observed fire from recorded drone imagery

Started: 2026-09-27. User authorized beginning the research objective and selected
public wildfire datasets. Status: first fixed-rule pilot executed; learned-model
comparison and unseen-incident validation remain open. M1 acquisition/audit has
now run; the [benchmark acceptance gate remains blocked](milestone-1.md).

## Objective and falsifiable claim

Produce traceable fire observations from recorded drone imagery. Establish whether
a learned RGB model, then a quality-aware RGB/thermal model, improves recognition
over transparent rules on held-out incidents at an agreed recall/false-alert tradeoff.
An outcome in which a simple thermal rule wins is a valid research result.

The initial target is observable evidence: visible flame, smoke and thermal anomalies
must remain separate. RGB visible-flame masks cannot reveal all active fire beneath
smoke. Human-reviewed multimodal fire labels require an explicit definition of what
counts as active fire, residual heat and uncertain/occluded ground. No complete
perimeter, ground area or observed spread is inferred from image masks alone.

## Scope and placement

- `backend/vision/`: dataset loading, rules, later model adapters and component tests.
- `contracts/research/`: offline data/result semantics. No production route changes.
- This research directory: protocol, dataset audit, evidence and decisions.
- Existing frontend simulator remains a separate product demonstration.
- Downstream integration dependencies: timestamp and quality semantics in API/shared
  contracts; distinct observed/modelled layers in visualization; calibration/terrain
  for geolocation. No integration is claimed in this milestone.
- Vision, contract and API/frontend responsibility is by component; named owners
  remain unassigned. No teammate notification or PR integration has occurred.

## M0: Fixed-rule pilot (implemented)

Select 12 equally spaced filename ranks in each publisher Fire/No Fire class from
FLAME 3 Sycan Marsh v1, before evaluating. Keep all 24 samples in `pilot`; do not
randomly split this burn into train/test. Preserve publisher paths, version and
SHA-256 values. Keep media out of Git. Input-specific audit is in datasets.md.

Frozen first-run parameters: RGB red >=150, red-green >=15, green>blue, saturation
>=0.2; thermal >=80 C; retain 4-connected components >=8 pixels; image positive at
>=16 surviving pixels. These are deliberately simple engineering baselines, not
validated physical ignition rules. They were fixed before the first run, and were
not adjusted after observing the pilot labels/results.

Compare RGB, thermal, and image-level OR. No alignment-dependent pixel fusion is
performed. No frame persistence is inferred from rank ordering. Missing modalities
and invalid numeric pixels carry explicit unknown states. Record algorithm timings
separately from loading/rendering; no end-to-end real-time claim.

Deliverables: executable baseline, input manifest, per-image observations, confusion
counts, visual audit sheets, integrity/split/metric tests, and unavailable-metric reasons.

## M1: Make a scientifically usable segmentation benchmark (audit executed; acceptance open)

Current evidence: 992 complete FLAME2 triplets acquired; source palette decoded,
all checksums/dimensions/counts validated, 25 samples inspected and incident split
proposal checked. These are development data. The masks' publisher fire semantics
are not verified as RGB-visible flame, and independent review is pending. Follow
the [annotation guide](annotation-guide.md); see [M1 results](milestone-1.md).
The [review package and scoring tools](review-handoff.md) are prepared. The user
confirmed no human reviewers are available, so no review acceptance or freeze occurred.

1. Acquire independent incidents with pixel annotations. Start by auditing FLAME 1
   visible-flame masks and the RoboFireFuseNet authors' FLAME 2 flame/smoke annotations.
   FLAME2 assets are now downloaded but not accepted for this benchmark; its archive
   has no split-list files. FLAME1 acquisition still requires access. FLAME 3 additional burns are
   another candidate; do not assume unrestricted access or labels.
2. Define an annotation guide: visible flame, smoke, thermal anomaly and unknown.
   Treat ambiguous/occluded pixels as ignore for the relevant target. Record label
   author, modality used, timestamp, revision and adjudication of disagreements.
3. Independently review masks; a temperature-derived mask is a weak label, never an
   independent ground truth for evaluating the same temperature rule. Pixel boundary
   review and inter-annotator agreement are necessary before model comparison.
4. Resolve incident IDs, overlap between dataset releases, duplicates, sensor details,
   spatial registration errors and clock provenance. Split by complete incident/site,
   preserving sequences. All pilot imagery is development data and cannot later
   serve as an untouched test set. Separate train, validation and frozen test groups.
5. Include no-fire hard negatives: brown vegetation, sunlit bare ground, glare,
   non-fire hot objects, cloud/fog and residual heat. Sample deployment conditions,
   rather than reporting an artificially balanced subset as operational prevalence.

## M2: First learned comparison

Train/fine-tune a compact RGB segmentation baseline with a pretrained image encoder.
Architecture selection is pending dataset/hardware audit; no checkpoint is selected
or installed. Use the same spatial resolution, labels and evaluator as fixed rules.
Record source/license, weight hash, training seed, optimizer, augmentation, label
version and the full split manifest. Fit preprocessing only on training data.

Choose operating thresholds and the target recall on validation data, then freeze
them before testing. Report both the precision/recall curve and the fixed operating
point. Compare against thermal where modalities/targets permit a fair comparison;
do not mistake thermal anomaly segmentation for visible-flame segmentation.

## M3: Fusion and temporal experiments

Only after M1/M2, test independent modality outputs versus learned fusion. Ablate
RGB-only, thermal-only, combined, and combined with temporal evidence. Include missing
thermal, saturation, smoke, illumination change and intentional registration offsets.
Never interpret mere equality of image dimensions as verified spatial registration.

Temporal persistence is a separate baseline before a learned video model. Use a
verified capture timeline; compensate camera motion before comparing pixel location.
Geometric ground projection and comparable coverage are separate validation stages.

## Measurements and decision rule

| Measurement | Evidence needed | M0 status |
|---|---|---|
| Image precision/recall and confusion counts | Image labels; explicit abstention counts | Implemented, publisher-label pilot only |
| Pixel IoU/Dice | Independent same-coordinate target masks | Implemented for RGB visible flame; unavailable on selected data |
| Boundary F1 | Reviewed masks, fixed pixel tolerance and ignore policy | Implemented in M1 reviewer comparison; real human scores unavailable |
| False alerts/flight-hour | Continuous negative and positive recordings; defined alert episode/cooldown | Unavailable |
| Time to detection | Reviewed onset and verified capture clock; report misses separately | Unavailable |
| Algorithm latency | Identified device/resolution and repeatable benchmark | Single CPU pilot timing only |
| Capture-to-result latency | Instrumented capture, transfer, queues and inference | Unavailable |
| Ground position/spread error | Pose/calibration/terrain and independent geographic reference | Later stage |

Frame and pixel accuracy alone are insufficient under severe class imbalance.
Report modality availability, ignored pixels and source-frame coverage. For later
multi-incident results, show per-incident outcomes and uncertainty resampled by
incident, not a confidence interval pretending adjacent frames are independent.
Calibrate probabilities on validation data if probabilistic outputs are exposed.

Advance a learned approach only if it improves the frozen target metric on independent
incidents without unacceptable availability/latency loss. Operational thresholds and
minimum acceptable evidence remain open product decisions. No universal target is
invented from this 24-image pilot.

## Current outcome and open inputs

M0 runs and exposes RGB false candidates plus metadata problems. It does not establish
that AI improves the chosen task. M1 data acceptance is the remaining scientific dependency. Target drone,
hardware, geography, operational delay and acceptable false-alert rate remain unresolved.
