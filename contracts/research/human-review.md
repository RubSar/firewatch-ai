# Independent RGB review formats, version 1

Offline research only. Producer: `backend/vision/review_packet.py build` and its
browser editor. Consumer: `review_packet.py score`. No production interface changes.
Targets are separate `visible_flame` and `smoke` binary layers, not a conversion of
the publisher's 0/1/2 multiclass inventory into accepted ground truth.

## Packet

`firewatch.research.review_packet.v1` contains `data_kind` real/synthetic, ordered
targets, mask-code meanings, evidence description and ordered cases. Each case has
`case_id`, original RGB file `rgb_sha256` and `dimensions_hw` [height, width].
`packet_id` is SHA-256 of UTF-8 Python canonical JSON (sorted keys, compact separators,
ASCII escaping), excluding `packet_id`. Preserve the generated packet and its ID.

Case mapping, incident/site provenance and code hashes live separately in
`coordinator.json`. Reviewer pages receive only the public packet and original RGB
PNG data URLs. Image hashes identify source file bytes, not overlays or screenshots.
HTML hashes are recorded separately in readiness evidence; packet identity describes
the cases and targets, not the rendering implementation.

## Human review export

`firewatch.research.human_review.v1` fields:

| Field | Meaning |
|---|---|
| `packet_id` | Exact packet being annotated |
| `reviewer_slot` | `A` or `B`; editor imports only its own slot |
| `reviewer_id` | Stable nonempty ID; compare case-insensitively after trimming |
| `annotator_type`, `method` | Declared `human`, `manual`; not authentication |
| `independence_attested` | Boolean; drafts may use false; comparison requires both true |
| `exported_at_utc` | Full ISO-8601 UTC timestamp ending `Z`, not capture time |
| `records` | Unique known cases; omitted cases remain missing |

Each record repeats case ID, hash and native dimensions, and has `layers` containing
both targets. Each layer has `mask_rle`, `reviewed` boolean, `notes` string and
`modified_at_utc` (null before work; otherwise full UTC timestamp). Reviewed layers
require a timestamp and, if any unknown pixels remain, explanatory notes.

Masks use row-major uint8 values; top-left origin, x rightward, y downward.
`mask_rle` contains `[value, count]` pairs: 0 negative, 1 positive, 255 unknown or
unannotated. Positive integer counts sum exactly to height times width, up to
16 million pixels per image. For a 2 x 3 mask, `[[0,2],[1,1],[255,3]]` decodes to
rows `[0,0,1]`, `[255,255,255]`. Unknown is never negative. Targets can overlap;
no implicit resizing, interpolation or missing-target conversion is allowed.

Mask/notes edits reopen the layer. Exports are snapshots with annotation timestamps;
unique download filenames help preserve originals. They are not an authenticated
revision ledger. Coordinators retain hashes/previous exports and record adjudication
as a new revision with reasons.

## Comparison

`firewatch.research.review_comparison.v1` contains packet/data identity, reviewer IDs,
per-case/per-target scores, target summaries, boundary policy/tolerance and a queue.
CLI results add input/code hashes and creation UTC. Boundary tolerance is an explicit
integer 0..10 native pixels; no default scientific tolerance is supplied.

IoU/Dice use jointly valid pixels. Empty union/positive denominators are null;
empty joint coverage also makes disagreement fraction null. Missing/unreviewed
layers produce no scores and stay in the queue. Summary expected pixels include
unfinished cases. Per-review positive counts include each reviewer's own positives;
joint-positive counts restrict to shared validity. Boundary policy is documented in
the [handoff](../../docs/concurrent-analysis/09-observation-baseline/review-handoff.md).

Status is `awaiting_completion_or_adjudication` or `awaiting_coordinator_acceptance`.
`independent_review_accepted` and `benchmark_frozen` always stay false. No acceptance
threshold or consensus is inferred. Invalid hashes, dimensions, encoding, metadata,
duplicate reviewer/slot or missing attestations cause errors and nonzero CLI exit.
A valid comparison can exit zero while awaiting adjudication: inspect its status.
Existing output evidence is never overwritten.
