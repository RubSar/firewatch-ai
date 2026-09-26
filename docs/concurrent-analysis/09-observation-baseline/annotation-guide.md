# R01 annotation guide, revision 2

Status: protocol and tooling prepared, 2026-09-27. No independently reviewed FireWatch
masks have been produced yet. Publisher masks retain their source semantics. The user
confirmed no reviewers are available; see the [handoff](review-handoff.md).

## Separate the targets

| Target | Positive evidence | Unknown/ignore |
|---|---|---|
| RGB-visible flame | Flame directly visible in RGB at native resolution | Smoke/canopy occlusion, ambiguous glow or unresolved boundary |
| Visible smoke | Visible plume with smoke evidence in RGB | Indistinguishable fog/cloud/dust and ambiguous translucent edge |
| Thermal anomaly | Sensor measurement satisfying a declared calibrated thermal criterion | Invalid/saturated data, missing calibration or uncertain registration |
| Multimodal active fire | Separate expert definition using available RGB/IR evidence | Residual heat vs active combustion unresolved; unobserved ground |

Do not infer hidden visible flame from an IR hotspot. A thermal anomaly is not
automatically active combustion. A smoke polygon is not a fire perimeter. These
targets may overlap and should be independent mask layers. For each binary target:
0=reviewed negative, 1=reviewed positive, 255=unknown/unannotated. A missing mask is
null, not negative. The imported RFF multiclass palette is a different format with
fire priority; preserve it unchanged until a reviewed target-specific conversion exists.

## Annotation and review procedure

1. Record the sample/source hashes, native dimensions, incident/site and verified
   capture metadata before labeling. Preserve unknown values. Document camera,
   modality alignment and any crop/resize; use nearest-neighbor for discrete masks.
2. Show the annotator only evidence appropriate to the target. For RGB-visible flame,
   create the initial mask using RGB without a model overlay or thermal-derived label.
   If video context is used, record its frame IDs and clock provenance.
3. Mark ambiguous pixels ignore. Inspect thin flames, small isolated regions,
   boundaries, smoke occlusion, glare, sunlit brown ground, cloud/fog and residual heat.
   Never interpolate a full ground perimeter across unobserved areas.
4. Have a second qualified reviewer independently label the evaluation subset,
   blind to the first annotation and model predictions. Include positive, negative
   and ambiguous examples per incident, with deliberate boundary/occlusion coverage.
5. Compare masks only on their jointly valid pixels. Report per-class IoU/Dice,
   each annotator's positive area, valid/ignore coverage and disagreement fraction.
   Empty positive unions produce unavailable IoU rather than a perfect score.
   Record boundary tolerance in native pixels before boundary-F1 calculation.
6. Adjudicate disagreements with a reason and preserve both originals. Do not
   overwrite them with a consensus mask without revision history. Record reviewer,
   adjudicator, UTC annotation/review time and evidence modality. A timestamp is
   annotation time, not camera capture time.

No universal agreement cutoff or pixel tolerance is accepted yet. Set these with
the research owner before evaluating a model; do not tune acceptance after seeing
test predictions. `backend/vision/review_packet.py` now calculates agreement and
boundary F1 with explicit tolerance/ignore handling. It does not decide scientific
acceptance. No real human agreement scores are available yet.

## Review record

Each reviewed mask must have sample ID; target; file hash; label author/reviewer IDs;
method (manual, model-assisted, threshold-derived); modalities viewed; created UTC;
revision; prior revision; review status; per-target ignore reason; disagreement metrics;
and adjudication notes. Unknown publisher fields remain null. Model-assisted labels
record model/checkpoint hash and prompts/settings. Threshold-derived labels record
the rule and calibration. Neither is independent truth for the same generating method.

The imported inventory's `pending_independent_review` status must not be changed
merely because code validation passed or an AI assistant inspected a contact sheet.
`independent_review_accepted` requires a linked review record and adjudication evidence.

## Sampling and split freeze

Choose incidents/sites before training. Keep every video/frame/derivative of each
incident in its assigned group and keep a site out of multiple groups. Reconcile
aliases across dataset releases. Use byte/decoded-image hashes and similarity review
as additional checks. Hash similarity cannot replace event provenance.

Keep all previously inspected pilot data outside an untouched test release. An
independent custodian may inspect and annotate prospective test data under a documented
protocol; this is different from model developers examining test failures and tuning.
Freeze test selection, label revision, hashes, target, metrics, model settings and
validation-selected operating point before the final comparison. Later changes require
a new benchmark revision and disclosure of any test exposure.

Count negatives by context and incident, including smoke without visible flame,
brown vegetation, bare ground, reflection/glare, clouds/fog and non-fire heat sources.
No source currently establishes all these categories or their deployment prevalence.
Continuous recordings, onset labels and a verified clock are additional requirements
for false alerts per flight-hour and detection delay.
