# M1 review handoff and remaining evidence

Date: 2026-09-27. **Review preparation is complete; scientific M1 acceptance remains
open.** The user confirmed that no reviewers are available yet and requested the
package and an explicit record of that gap. Zero human reviews have been received.
No model training, accepted ground truth or frozen test set is claimed.

Scope: offline tools/tests in `backend/vision/`, an additive
[review contract](../../../contracts/research/human-review.md), and this research
handoff. Research/annotation coordination is unassigned. The research branch is based
on remote main `99eea09`; earlier research files and results were preserved. No API,
frontend simulator or production contract changes are needed for this work.

## Ready for handoff

Local package: `backend/vision/runs/m1-review-packet/`. Its media are ignored by Git;
[build instructions](../../../backend/vision/README.md) reproduce the editor files.
The [readiness record](results/m1-readiness.json) and
[packet manifest](results/m1-review-packet.json) are retained here without image bytes.

| File | Intended recipient and purpose |
|---|---|
| `reviewer-A/index.html` | First independent human; self-contained RGB editor |
| `reviewer-B/index.html` | Second independent human; same images, separate slot |
| `packet.json` | Coordinator; image hashes, native dimensions and target definitions |
| `coordinator.json` | Coordinator only; source-case mapping, input/code hashes and unassigned slots |
| `README.txt` | Handoff instructions |

Each editor embeds the 25 RGB images selected in the existing M1 audit, with no
publisher masks, thermal images or model predictions. Each reviewer has 50 image
layers: visible flame and smoke separately. Every pixel starts unknown. This is a
pilot diagnostic selection from one incident, including label-area extremes; it is
not a random prevalence sample or an untouched test set. It cannot certify all 992
publisher masks or establish cross-incident accuracy.

## When reviewers become available

1. Assign two different qualified humans. Record stable IDs, experience, assignment
   UTC and any prior exposure to these images/source labels. Distinct software IDs
   cannot verify different humans or actual independence.
2. Give each person only their own reviewer folder and the target definitions in
   the [annotation guide](annotation-guide.md). Keep the other review, source overlays
   and model outputs separate until independent work is complete. Someone already
   shown source labels cannot attest blindness to them.
3. Open `index.html` in a browser. No server or account is required. Select image and
   target, inspect RGB at native resolution or integer zoom, and paint positive,
   negative and unknown pixels. Hide the overlay to inspect original colors. Use
   All negative only after inspection, then restore positive/uncertain regions.
4. Explain unknown/occluded regions in notes. Mark each layer reviewed after
   inspection; editing its mask or notes reopens it. Flame and smoke can overlap.
   Do not infer hidden flame from smoke, heat or the publisher's label.
5. Enter the assigned ID and attest independence only if true. Export JSON frequently;
   work stays in memory, not automatic storage. Confirm the downloaded file exists.
   If downloads are unavailable, expand **Save JSON manually** and save its entire
   text as a UTF-8 `.json` file. Export again after edits: that text is a snapshot.
   Import the same-slot export to resume; the other reviewer slot is rejected.
6. Return both originals to the coordinator. Preserve each export and its hash.
   Revisions retain their originals and reasons; never replace an independent
   annotation with a consensus version without history.

No invitations were sent and no people were assigned by this task.

## Compare and adjudicate

The research owner must predeclare a boundary tolerance in **native image pixels**
and acceptance policy for agreement, unknown coverage and negatives. No values have
been agreed. Do not choose them after observing model test results.

From `backend/vision/`, replace `N` with that predeclared integer (0 through 10):

```sh
python review_packet.py score runs/m1-review-packet/packet.json reviewer-A.json reviewer-B.json --boundary-tolerance-pixels N --output runs/m1-human-review/comparison.json
```

The scorer checks packet/image identity, dimensions, mask encoding, reviewer slots,
IDs, declared method, UTC times and independence attestations. Outputs include
per-image/per-target IoU, Dice, boundary F1, positive area, valid coverage and
disagreement counts, micro IoU/Dice, input/code hashes and an adjudication queue.
Missing/unfinished work stays missing. Unknown in either mask excludes that pixel;
empty positive unions are null, not perfect agreement.

Boundary F1 uses positive-side four-neighbor boundaries, excluding image edges and
pixels adjacent to unknown regions. Matching allows the declared Chebyshev distance.
Both empty boundary sets yield null; one empty set yields zero. Always report
coverage alongside agreement, since excluding uncertainty can hide difficult regions.

The queue includes missing work, label disagreements and any unknown coverage,
including regions both reviewers left unknown. Preserve justified uncertainty
instead of forcing binary labels. Record adjudicator ID, UTC, original hashes,
target, revision, evidence and reason. The tool produces comparisons, not consensus
masks or adjudication decisions. Even perfect agreement leaves
`independent_review_accepted=false` and `benchmark_frozen=false`. Agreement is not accuracy.

## What still prevents full M1 closure

| Dependency | Current evidence | Remaining action |
|---|---|---|
| Two independent qualified reviewers | None assigned; zero human reviews | Assign reviewers and obtain annotations |
| Target-compatible labels | Publisher FLAME2 fire is not verified as RGB-visible flame | Review targets, adjudicate and version accepted labels |
| Separate incident/site groups | FLAME2 and Sycan are pilot; no compatible train/validation/test release | Acquire/verify compatible labels; keep inspected pilot out of untouched testing |
| Hard-negative coverage | Required contexts and prevalence are not established | Record negative categories and incident coverage |
| Acceptance policy | No agreed tolerance, coverage requirement or agreement cutoff | Research owner declares these before final evaluation |
| Frozen benchmark | Split gate remains blocked | Link accepted revisions, hashes, group assignments and leak checks before freeze |

Three train/validation/test groups are the minimum structural requirement, not
evidence that three fires adequately establish generalization. This packet completes
annotation preparation only. M2 training still depends on scientific M1 acceptance.

## Additional public candidate checked

[FireSentry's paper](https://arxiv.org/html/2512.03369v1) describes five regions and
IR-generated masks; its manual verification subset uses IR as primary evidence and
RGB as supporting context. Our inference: those masks cannot directly supply
independent RGB-visible-flame truth. The [repository](https://github.com/Munan222/FireSentry-Benchmark-Dataset)
lists regions A-E and SAM2 masks. Its access table still says B-E are post-acceptance,
although region directories are visible. Actual file coverage, reuse license and
incident independence remain to be verified. No FireSentry media were downloaded or
counted as accepted benchmark data. Its forecasting objective does not change our scope.

FLAME1 account access and Boreal's smoke target/site-split limitations remain as
recorded in [M1 findings](milestone-1.md). Additional downloads cannot resolve the
absent independent reviewers or incompatible label targets.

## Validation and limits

58 Python component tests and five JavaScript tests pass: original M0/M1 checks,
hand-calculated agreement, empty/unknown masks, boundary tolerance, tampering,
duplicate reviewers, missing work and output preservation. Building the real packet
revalidated all 992 inventory triplets. Both pages embed the same 25 original RGB
byte streams and different reviewer slots.

Browser inspection verified painting, undo, separate layers, notes for reviewed
unknowns and review-state restoration. A synthetic browser export was saved from
the manual JSON field, imported into a fresh editor and validated by Python. The
in-app browser did not confirm an automatic download; manual export/resume was
verified. Synthetic fixtures are not human evidence. The real packet stays unreviewed.

Earlier data, baseline parameters and pilot/audit reports were preserved. Changes
remain local to the research branch; no PR or team notification is implied.
