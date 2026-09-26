# M1: Annotation acquisition and benchmark readiness

Date: 2026-09-27. **Acquisition and technical audit completed; M1's full benchmark
acceptance criteria are not yet satisfied. No learned model was trained.**

Follow-up: [review preparation is complete](review-handoff.md), with two separate
25-image editors and an agreement scorer. The user confirmed no human reviewers
are available; zero human reviews and the remaining evidence gaps are recorded.

We acquired and decoded an actual public pixel-label release, built a reproducible
audit, and tested a proposed incident split. The result is a documented no-go for
an unseen-incident visible-flame comparison with the currently acquired data.
This prevents a misleading performance result from an easy random frame split.

Scope: `backend/vision/` tools/tests, `contracts/research/` offline formats, and this
research directory. No API or simulator integration. Responsibility is by component;
the research/annotation owner remains unassigned. Work continues on
`codex/fire-observation-research`. The initial acquisition used remote HEAD
`bdd0dde5f43a557823825cc5b898aa477a927e20`; the branch was subsequently fast-forwarded
to `99eea09` for review preparation, preserving the earlier research evidence.

## What was acquired and measured

The public [RoboFireFuseNet release](https://github.com/dimfot3/RoboFireFuseNet/tree/f7fffecd9088b907698147eb9be1beca30da0014)
links the [FLAME2 archive](https://drive.google.com/file/d/1_ryJ9S9Hi-RwcFzVG1ASyEORA-gr5BAy/view).
The publisher declares MIT for masks and CC BY 4.0 for source imagery. We retain
that distinction and the pinned source documentation locally. No external training
code or weights were executed. The [paper](https://doi.org/10.1016/j.patrec.2026.04.024)
describes manual annotation and gives fire priority where flame and smoke overlap.

These are **our direct measurements of the downloaded archive**, not paper results:

| Audit item | Result |
|---|---:|
| Archive bytes | 247,348,835 |
| Complete RGB / IR display / source-mask triplets | 992 |
| Raster dimensions of all three modalities | 254 x 254 |
| Images containing publisher fire | 755 |
| Images containing publisher smoke | 720 |
| Images containing neither fire nor smoke | 237 |
| Images containing smoke without publisher fire | 0 |
| Background / smoke / fire pixels | 35,859,807 / 22,365,360 / 5,774,705 |
| Ignore pixels | 0 |
| Identical decoded RGB groups | 0 |
| Similar RGB pairs flagged by difference hash | 1,165 |
| Samples prepared and visually inspected in contact sheets | 25 |
| Incident groups | 1 |
| Split-list files inside archive | 0 |

Archive SHA-256:
`0e9eab6e477ff1b784e5ab7115c1e922ed14a31a60cd926d51976bf04869e043`.
The paper reports 995 annotated pairs and processing at 256 x 256; our archive has
992 triplets at 254 x 254. We preserve the actual files and record the discrepancy.
We cannot identify three missing sample IDs without the original split lists.

Every source mask is RGBA with opaque alpha. Its exact colors are black=background,
gray 125=smoke, white 255=fire. The canonical audit mask uses 0/1/2 for those classes
and reserves 255 for ignore. Simply loading the source white pixels as ignore would
erase the fire labels. Unknown colors, transparency and shape mismatches raise errors.

IR files are RGB palette PNGs, not radiometric temperatures. They cannot enter the
80 C evaluator. Equal dimensions and publisher pairing do not establish calibrated
spatial registration. Capture times, sequence IDs and relative seconds stay unknown.

The [original FLAME 2 dataset description](https://open.clemson.edu/all_data/3250/)
identifies one Northern Arizona prescribed burn in November 2021. We group the
whole release as `flame2-northern-arizona-2021-11`; multiple videos are not treated
as multiple independent fires. All 992 samples stay in `pilot`.

## What visual review established

Codex inspected all five contact sheets: 20 evenly spaced numeric filename ranks,
class-area extremes, and available label combinations, deduplicated to 25 samples.
This was a preliminary qualitative audit, not expert adjudication or independent
pixel annotation. Individual human annotator IDs, annotation dates and agreement
scores are unavailable. The masks have not been approved for final evaluation.

Examples `flame2-rff-20504`, `35347` and `31874` contain publisher fire regions in
areas heavily obscured by smoke in RGB. Labels may support a multimodal target,
but their equivalence to **RGB-visible flame** is unverified. No conversion to the
M0 `visible_flame` ground-truth format was made. The sample `116` shows why palette
brightness should not be interpreted as Celsius: bright IR colors cover terrain
whose supplied annotation contains no fire.

The 1,165 similar pairs are screening candidates using 64-bit grayscale difference
hashes with Hamming distance <=4. They are not 1,165 proven duplicates. No frame was
removed automatically. Zero exact RGB duplicates does not imply independent scenes.
The 237 background masks are source labels, not independently certified hard negatives
or a measurement of operational no-fire prevalence. The lack of smoke-only samples
also limits testing whether smoke alone causes false fire predictions.

## Split decision and remaining acceptance criteria

The [explicit split proposal](flame2-split-plan.json) keeps this inspected incident
in pilot. The executed [split gate](results/flame2-split-gate.json) reports `blocked`:

1. No whole incident is assigned to training, validation or untouched testing.
2. Independent annotation review and agreement evidence are absent.
3. Publisher fire has not been verified equivalent to RGB-visible flame.

The guard also rejects site/sequence leakage, identical sensor data across splits,
unreviewed validation/test masks, cross-split similarity candidates, and promotion
of inspected pilot data into an untouched test set. A mechanical pass would yield
`ready_for_review`, never automatic scientific acceptance or a frozen benchmark.

Follow the [annotation guide](annotation-guide.md). To close M1, obtain compatible
labels on distinct incidents/sites, independently review validation/test masks,
adjudicate boundary disagreements, document negative coverage and freeze the
sample hashes/incident assignments. Three groups are the minimum structure for
train/validation/test, not a claim that three fires adequately establish generalization.
M2 training remains after these checks; no performance score is fabricated here.

## Other public data checked

**FLAME 1:** the [authors' repository](https://github.com/AlirezaShamsoshoara/Fire-Detection-UAV-Aerial-Image-Classification-Segmentation-UnmannedAerialVehicle)
directs users to IEEE DataPort segmentation items 9/10. The public page was reachable,
but its download flow presented sign-in/account requirements. No account was created
and no FLAME 1 assets were downloaded. This is still a candidate for visible-flame
annotations after authorized access and provenance review.

**Boreal Forest Fire:** [the authors' dataset](https://doi.org/10.23729/fd-72c6cf74-b8eb-3687-860d-bf93a1ab94c9)
has four Finnish sites, with smoke labels. Its [paper](https://www.nature.com/articles/s41597-025-05634-0)
distinguishes SAM-generated masks from a 40-image manual test subset. This can support
a separate smoke study; smoke extent must not be substituted for fire extent.

We fetched only its public file catalogue, not media. The reproducible
[catalogue audit](results/boreal-catalog-audit.json) found:

| Site prefix | Publisher train | Publisher validation | Publisher test |
|---|---:|---:|---:|
| Evo | 278 | 21 | 15 |
| Heinola | 291 | 84 | 7 |
| Karkkila | 269 | 38 | 12 |
| Ruokolahti | 346 | 105 | 6 |

All four sites span all three publisher splits. For our unseen-site question these
must be regrouped by site. The listing has 1,184 training images but 1,150 matching
SAM masks, and 248 validation images but 227 matching SAM masks. Thus 34 and 21 images,
respectively, lack a matching mask in the catalogue. Their labels remain unknown;
we have not inferred empty masks. All 40 test images have manual-mask filenames.
The catalogue audit is not verification of downloaded mask contents or mask quality.

## Reproduce and retained evidence

Commands are in the [vision README](../../../backend/vision/README.md). Acquisition
is capped, archive checksums are pinned, original media stay in ignored `data/`,
and output runs refuse to overwrite existing results. The existing M0 files/results
were preserved. Its code hashes still describe the unchanged M0 implementation.

- [FLAME2 audit summary](results/flame2-annotation-audit.json)
- [Complete annotation inventory](results/flame2-inventory.json), copied for provenance;
  its paths resolve under `backend/vision/data/flame2-rff/prepared/`, not this folder.
- [Similar-pair review list](results/flame2-duplicates.json)
- [Split gate](results/flame2-split-gate.json)
- [Boreal metadata audit](results/boreal-catalog-audit.json)

Validation: the complete acquired release passed checksum, palette, dimensions and
pixel-count validation; all five contact sheets were inspected; **47 component tests
passed**, covering both
the earlier baseline and new annotation/split guards. No learned inference, pixel
accuracy claim, independent human review or operational readiness is implied.
