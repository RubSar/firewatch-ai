"""Check explicit incident assignments; never invent train/test independence."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path

from audit_annotations import duplicate_audit, validate_inventory
from dataset import sha256, utc_now


def check_plan(inventory, plan):
    if plan.get("schema_version") != "firewatch.research.split_plan.v1":
        raise ValueError("Unsupported split plan")
    target = plan.get("target")
    if target not in ("visible_flame", "publisher_fire", "publisher_smoke"):
        raise ValueError("Unknown segmentation target")
    assignments = plan["incident_assignments"]
    records = inventory["records"]
    incidents = {r["incident_id"] for r in records}
    if set(assignments) != incidents:
        raise ValueError("Assignments must cover exactly the inventory incidents")
    if any(s not in ("pilot", "train", "validation", "test") for s in assignments.values()):
        raise ValueError("Unknown assigned split")
    reasons = []
    if inventory["data_kind"] != "real":
        reasons.append("Synthetic fixtures cannot establish a real benchmark.")
    used = set(assignments.values())
    for split in ("train", "validation", "test"):
        if split not in used:
            reasons.append(f"No complete incident assigned to {split}.")
    by_site = defaultdict(set)
    by_sequence = defaultdict(set)
    for record in records:
        assigned = assignments[record["incident_id"]]
        by_site[record["site_id"]].add(assigned)
        if record.get("sequence_id"):
            by_sequence[record["sequence_id"]].add(assigned)
        if record["split"] == "pilot" and assigned == "test":
            reasons.append("Previously inspected pilot imagery cannot become an untouched test set.")
        if assigned in ("validation", "test") and record["review_status"] != "independent_review_accepted":
            reasons.append("Validation/test annotations lack accepted independent review.")
    if any(len(splits) > 1 for splits in by_site.values()):
        reasons.append("Site crosses split boundaries.")
    if any(len(splits) > 1 for splits in by_sequence.values()):
        reasons.append("Sequence crosses split boundaries.")
    provenance = inventory["annotation_provenance"]
    if target == "visible_flame" and provenance.get("visible_flame_equivalence") is not True:
        reasons.append("Publisher fire class is not verified equivalent to RGB-visible flame.")
    if provenance.get("independent_second_review") is not True:
        reasons.append("Independent annotation review and agreement evidence are absent.")
    # Detect identical bytes in either sensor, and identical RGB after decoding.
    hashes = defaultdict(set)
    for record in records:
        split = assignments[record["incident_id"]]
        for key in ("rgb", "ir_display"):
            hashes[record["sha256"][key]].add(split)
        hashes[record["rgb_decoded_sha256"]].add(split)
    if any(len(splits) > 1 for splits in hashes.values()):
        reasons.append("Identical media crosses split boundaries.")
    duplicates = duplicate_audit(records)
    split_for = {r["sample_id"]: assignments[r["incident_id"]] for r in records}
    cross_near = [p for p in duplicates["near_duplicate_candidates"] if split_for[p["left"]] != split_for[p["right"]]]
    if cross_near:
        reasons.append("Cross-split near-duplicate candidates need review; no automatic override is supported.")
    reasons = sorted(set(reasons))
    return {"schema_version": "firewatch.research.split_gate.v1", "target": target,
            "status": "blocked" if reasons else "ready_for_review", "frozen": False,
            "reasons": reasons, "incident_assignments": assignments,
            "sample_counts": dict(Counter(assignments[r["incident_id"]] for r in records)),
            "cross_split_near_duplicate_count": len(cross_near),
            "samples": [{"sample_id": r["sample_id"], "incident_id": r["incident_id"],
                         "site_id": r["site_id"], "proposed_split": assignments[r["incident_id"]]} for r in records],
            "limitations": "A passing mechanical check is not scientific approval, adequate sample size, or a frozen test release."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inventory", type=Path)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    data = validate_inventory(args.inventory)
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    result = check_plan(data, plan)
    result.update(created_at_utc=utc_now(), inventory_sha256=sha256(args.inventory),
                  plan_sha256=sha256(args.plan), code_sha256={name: sha256(Path(__file__).with_name(name))
                  for name in ("prepare_benchmark.py", "audit_annotations.py", "import_flame2.py", "dataset.py")})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as output:
        output.write(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"status": result["status"], "reasons": result["reasons"]}))
    raise SystemExit(2 if result["status"] == "blocked" else 0)


if __name__ == "__main__":
    main()
