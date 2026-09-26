"""Build blinded RGB review packets and compare independent human annotations."""
import argparse
import base64
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re

import numpy as np

from audit_annotations import validate_inventory
from dataset import local_path, sha256, utc_now

TARGETS = ("visible_flame", "smoke")


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def build_packet(inventory_path, audit_path, output):
    inventory_path, audit_path, output = map(Path, (inventory_path, audit_path, output))
    inventory = validate_inventory(inventory_path)
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    if audit["inventory_sha256"] != sha256(inventory_path):
        raise ValueError("Audit does not describe this inventory")
    selected = audit["review_sample_ids"]
    if not selected or len(set(selected)) != len(selected):
        raise ValueError("Review selection is empty or duplicated")
    source = {r["sample_id"]: r for r in inventory["records"]}
    cases, image_urls, private_map = [], {}, []
    for index, sid in enumerate(selected, 1):
        if sid not in source:
            raise ValueError("Review selection contains unknown sample")
        record = source[sid]
        cid = f"case-{index:03d}"
        image_bytes = local_path(inventory_path.parent, record["paths"]["rgb"]).read_bytes()
        cases.append({"case_id": cid, "rgb_sha256": record["sha256"]["rgb"],
                      "dimensions_hw": record["dimensions_hw"]})
        image_urls[cid] = "data:image/png;base64," + base64.b64encode(image_bytes).decode()
        private_map.append({"case_id": cid, "sample_id": sid, "incident_id": record["incident_id"],
                            "site_id": record["site_id"], "split": record["split"]})
    core = {"schema_version": "firewatch.research.review_packet.v1", "data_kind": inventory["data_kind"],
            "targets": list(TARGETS), "mask_codes": {"0": "negative", "1": "positive", "255": "unknown"},
            "evidence": "RGB only; no source masks, thermal or predictions", "cases": cases}
    packet = {**core, "packet_id": canonical_hash(core)}
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output directory is not empty")
    output.mkdir(parents=True, exist_ok=True)
    template = Path(__file__).with_name("review_ui.html").read_text(encoding="utf-8")
    code = Path(__file__).with_name("review_ui.js").read_text(encoding="utf-8")
    for slot in ("A", "B"):
        folder = output / f"reviewer-{slot}"
        folder.mkdir()
        payload = json.dumps({"packet": packet, "slot": slot, "images": image_urls}, separators=(",", ":")).replace("<", "\\u003c")
        page = template.replace("/*PACKET_DATA*/", "const INPUT = " + payload + ";").replace("/*REVIEW_CODE*/", code)
        (folder / "index.html").write_text(page, encoding="utf-8")
    (output / "packet.json").write_text(json.dumps(packet, indent=2) + "\n", encoding="utf-8")
    coordinator = {"packet_id": packet["packet_id"], "created_at_utc": utc_now(),
                   "inventory_sha256": sha256(inventory_path), "audit_sha256": sha256(audit_path),
                   "code_sha256": {name: sha256(Path(__file__).with_name(name))
                                   for name in ("review_packet.py", "review_ui.html", "review_ui.js")},
                   "sampling": "Existing M1 pilot audit selection; not a representative held-out evaluation set.",
                   "reviewers": {"A": None, "B": None}, "human_reviews_received": 0,
                   "status": "awaiting_two_independent_human_reviewers", "benchmark_frozen": False,
                   "case_mapping": private_map}
    (output / "coordinator.json").write_text(json.dumps(coordinator, indent=2) + "\n", encoding="utf-8")
    (output / "README.txt").write_text(
        "FireWatch M1 pilot review packet\n\n"
        "Give reviewer-A/index.html and reviewer-B/index.html to two different qualified humans.\n"
        "Open each file in a browser. No server, account, model or upload is used.\n"
        "Share only the assigned reviewer folder; keep coordinator.json and earlier overlays separate.\n"
        "Review visible flame and smoke independently using RGB only. Every pixel starts unknown.\n"
        "Enter reviewer ID, paint labels, write notes, and mark each layer reviewed.\n"
        "Export JSON frequently. Work is held in memory until exported; import your own export to resume.\n"
        "Do not inspect the other review or publisher masks before completing your independent review.\n"
        "Return the JSON exports to the coordinator. Different IDs cannot prove different humans.\n"
        "Compare with review_packet.py score and adjudicate disagreements before approving labels.\n"
        "No reviewers are assigned yet. This package does not complete M1 or freeze a test set.\n",
        encoding="utf-8")
    print(json.dumps({"cases": len(cases), "packet_id": packet["packet_id"], "status": coordinator["status"]}))
    return packet


def decode_rle(runs, shape):
    if (not isinstance(shape, list) or len(shape) != 2
            or any(type(n) is not int or n <= 0 for n in shape)):
        raise ValueError("Invalid mask dimensions")
    total = shape[0] * shape[1]
    if total > 16_000_000 or not isinstance(runs, list) or len(runs) > total or not runs:
        raise ValueError("Invalid or oversized mask encoding")
    count = 0
    for run in runs:
        if (not isinstance(run, list) or len(run) != 2 or type(run[0]) is not int
                or run[0] not in (0, 1, 255) or type(run[1]) is not int or run[1] <= 0):
            raise ValueError("Invalid mask run")
        count += run[1]
        if count > total:
            raise ValueError("Mask runs exceed dimensions")
    if count != total:
        raise ValueError("Mask runs do not cover dimensions")
    return np.repeat(np.array([r[0] for r in runs], np.uint8), [r[1] for r in runs]).reshape(shape)


def validate_packet(packet):
    if packet.get("schema_version") != "firewatch.research.review_packet.v1":
        raise ValueError("Unsupported review packet")
    if packet.get("targets") != list(TARGETS) or packet.get("data_kind") not in ("real", "synthetic"):
        raise ValueError("Invalid packet targets or data kind")
    core = {k: v for k, v in packet.items() if k != "packet_id"}
    if canonical_hash(core) != packet.get("packet_id"):
        raise ValueError("Packet integrity mismatch")
    ids = [c["case_id"] for c in packet["cases"]]
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("Empty or duplicate packet cases")
    if packet.get("mask_codes") != {"0": "negative", "1": "positive", "255": "unknown"}:
        raise ValueError("Invalid mask codes")
    for case in packet["cases"]:
        if not isinstance(case["case_id"], str) or not case["case_id"].strip():
            raise ValueError("Invalid case ID")
        if not isinstance(case["rgb_sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", case["rgb_sha256"]):
            raise ValueError("Invalid image hash")
        shape = case["dimensions_hw"]
        if (not isinstance(shape, list) or len(shape) != 2
                or any(type(n) is not int or n <= 0 for n in shape) or shape[0] * shape[1] > 16_000_000):
            raise ValueError("Invalid mask dimensions")


def require_utc(stamp):
    if not isinstance(stamp, str) or "T" not in stamp or not stamp.endswith("Z"):
        raise ValueError("Full UTC annotation time required")
    value = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    if value.utcoffset().total_seconds() != 0:
        raise ValueError("UTC annotation time required")


def validate_review(packet, review):
    validate_packet(packet)
    if review.get("schema_version") != "firewatch.research.human_review.v1" or review.get("packet_id") != packet["packet_id"]:
        raise ValueError("Review belongs to a different packet or schema")
    if review.get("reviewer_slot") not in ("A", "B"):
        raise ValueError("Unknown reviewer slot")
    if not isinstance(review.get("reviewer_id"), str) or not review["reviewer_id"].strip():
        raise ValueError("Reviewer ID required")
    if review.get("annotator_type") != "human" or review.get("method") != "manual":
        raise ValueError("This comparison requires declared manual human review")
    if type(review.get("independence_attested")) is not bool:
        raise ValueError("Independence attestation must be boolean")
    require_utc(review["exported_at_utc"])
    expected = {c["case_id"]: c for c in packet["cases"]}
    result = {}
    for row in review["records"]:
        cid = row["case_id"]
        if cid not in expected or cid in result:
            raise ValueError("Unknown or duplicate review case")
        case = expected[cid]
        if row["rgb_sha256"] != case["rgb_sha256"] or row["dimensions_hw"] != case["dimensions_hw"]:
            raise ValueError("Review image identity or dimensions mismatch")
        if set(row["layers"]) != set(TARGETS):
            raise ValueError("Both target layers must be explicit")
        layers = {}
        for target in TARGETS:
            layer = row["layers"][target]
            if type(layer["reviewed"]) is not bool or not isinstance(layer["notes"], str):
                raise ValueError("Invalid review state or notes")
            if layer["modified_at_utc"] is not None:
                require_utc(layer["modified_at_utc"])
            mask = decode_rle(layer["mask_rle"], case["dimensions_hw"])
            if layer["reviewed"]:
                require_utc(layer["modified_at_utc"])
                if np.any(mask == 255) and not layer["notes"].strip():
                    raise ValueError("Reviewed unknown pixels require an explanation")
            layers[target] = {"mask": mask, **{k: layer[k] for k in ("reviewed", "notes", "modified_at_utc")}}
        result[cid] = layers
    # Missing cases stay missing, never turn into background masks.
    return result


def boundaries(mask, valid):
    safe = np.zeros_like(valid)
    safe[1:-1, 1:-1] = (valid[1:-1, 1:-1] & valid[:-2, 1:-1] & valid[2:, 1:-1]
                        & valid[1:-1, :-2] & valid[1:-1, 2:])
    interior = np.zeros_like(valid)
    interior[1:-1, 1:-1] = (mask[:-2, 1:-1] & mask[2:, 1:-1]
                            & mask[1:-1, :-2] & mask[1:-1, 2:])
    return mask & ~interior & safe


def dilate(mask, radius):
    padded = np.pad(mask, radius)
    h, w = mask.shape
    out = np.zeros_like(mask)
    for y in range(2 * radius + 1):
        for x in range(2 * radius + 1):
            out |= padded[y:y+h, x:x+w]
    return out


def agreement(left, right, tolerance):
    if left.shape != right.shape or left.ndim != 2 or not np.isin(left, [0, 1, 255]).all() or not np.isin(right, [0, 1, 255]).all():
        raise ValueError("Invalid pair of masks")
    if type(tolerance) is not int or not 0 <= tolerance <= 10:
        raise ValueError("Boundary tolerance must be 0..10 native pixels")
    valid = (left != 255) & (right != 255)
    a, b = left == 1, right == 1
    intersection = int(np.count_nonzero(valid & a & b))
    union = int(np.count_nonzero(valid & (a | b)))
    aa, bb = int(np.count_nonzero(valid & a)), int(np.count_nonzero(valid & b))
    joint = int(valid.sum())
    ba, bbnd = boundaries(a, valid), boundaries(b, valid)
    count_a, count_b = int(ba.sum()), int(bbnd.sum())
    matched_a = int(np.count_nonzero(ba & dilate(bbnd, tolerance)))
    matched_b = int(np.count_nonzero(bbnd & dilate(ba, tolerance)))
    precision = matched_a / count_a if count_a else None
    recall = matched_b / count_b if count_b else None
    boundary_f1 = (2 * precision * recall / (precision + recall) if precision + recall else 0.0) if precision is not None and recall is not None else (0.0 if count_a or count_b else None)
    return {"total_pixels": int(left.size), "joint_valid_pixels": joint,
            "left_valid_pixels": int(np.count_nonzero(left != 255)), "right_valid_pixels": int(np.count_nonzero(right != 255)),
            "left_positive_pixels": int(a.sum()), "right_positive_pixels": int(b.sum()),
            "ignore_disagreement_pixels": int(np.count_nonzero((left == 255) != (right == 255))),
            "disagreement_pixels": int(np.count_nonzero(valid & (left != right))),
            "intersection_pixels": intersection, "union_pixels": union,
            "joint_left_positive_pixels": aa, "joint_right_positive_pixels": bb,
            "iou": intersection / union if union else None,
            "dice": 2 * intersection / (aa + bb) if aa + bb else None,
            "disagreement_fraction": float(np.count_nonzero(valid & (left != right)) / joint) if joint else None,
            "joint_valid_fraction": joint / left.size,
            "boundary_tolerance_pixels": tolerance, "boundary_f1": boundary_f1,
            "left_boundary_pixels": count_a, "right_boundary_pixels": count_b}


def compare(packet, review_a, review_b, tolerance):
    if type(tolerance) is not int or not 0 <= tolerance <= 10:
        raise ValueError("Boundary tolerance must be 0..10 native pixels")
    left, right = validate_review(packet, review_a), validate_review(packet, review_b)
    if review_a["reviewer_id"].strip().casefold() == review_b["reviewer_id"].strip().casefold():
        raise ValueError("Two distinct reviewers required")
    if {review_a["reviewer_slot"], review_b["reviewer_slot"]} != {"A", "B"}:
        raise ValueError("Both reviewer slots required")
    if review_a["independence_attested"] is not True or review_b["independence_attested"] is not True:
        raise ValueError("Both reviewers must attest independent work")
    records, queue = [], []
    for case in packet["cases"]:
        cid = case["case_id"]
        for target in TARGETS:
            a, b = left.get(cid, {}).get(target), right.get(cid, {}).get(target)
            if a is None or b is None or not a["reviewed"] or not b["reviewed"]:
                queue.append({"case_id": cid, "target": target, "reason": "missing_or_unfinished_review"})
                continue
            scores = agreement(a["mask"], b["mask"], tolerance)
            records.append({"case_id": cid, "target": target, **scores})
            if scores["joint_valid_pixels"] < scores["total_pixels"] or scores["disagreement_pixels"]:
                queue.append({"case_id": cid, "target": target, "reason": "adjudication_required"})
    summary = {}
    for target in TARGETS:
        rows = [r for r in records if r["target"] == target]
        intersection = sum(r["intersection_pixels"] for r in rows)
        union = sum(r["union_pixels"] for r in rows)
        positives = sum(r["joint_left_positive_pixels"] + r["joint_right_positive_pixels"] for r in rows)
        summary[target] = {"compared_cases": len(rows), "expected_cases": len(packet["cases"]),
                           "micro_iou": intersection / union if union else None,
                           "micro_dice": 2 * intersection / positives if positives else None,
                           "joint_valid_pixels": sum(r["joint_valid_pixels"] for r in rows),
                           "total_expected_pixels": sum(c["dimensions_hw"][0] * c["dimensions_hw"][1] for c in packet["cases"])}
    return {"schema_version": "firewatch.research.review_comparison.v1", "packet_id": packet["packet_id"],
            "data_kind": packet["data_kind"], "reviewer_ids": [review_a["reviewer_id"], review_b["reviewer_id"]],
            "status": "awaiting_completion_or_adjudication" if queue else "awaiting_coordinator_acceptance",
            "independent_review_accepted": False, "benchmark_frozen": False,
            "boundary_tolerance_pixels": tolerance,
            "summary": summary, "records": records, "adjudication_queue": queue,
            "boundary_policy": "Positive-side 4-neighbor boundaries, excluding image edges and pixels adjacent to ignore; Chebyshev matching tolerance.",
            "limitations": "Agreement is not accuracy. Identity and independence are declarations, not authenticated facts. No universal acceptance threshold is applied."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("inventory", type=Path)
    build.add_argument("audit", type=Path)
    build.add_argument("--output", type=Path, required=True)
    score = commands.add_parser("score")
    score.add_argument("packet", type=Path)
    score.add_argument("review_a", type=Path)
    score.add_argument("review_b", type=Path)
    score.add_argument("--boundary-tolerance-pixels", type=int, required=True)
    score.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "build":
        build_packet(args.inventory, args.audit, args.output)
    else:
        inputs = [json.loads(p.read_text(encoding="utf-8")) for p in (args.packet, args.review_a, args.review_b)]
        result = compare(*inputs, args.boundary_tolerance_pixels)
        result.update(created_at_utc=utc_now(), code_sha256=sha256(__file__),
                      input_sha256={k: sha256(p) for k, p in (("packet", args.packet), ("review_a", args.review_a), ("review_b", args.review_b))})
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as out:
            out.write(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"status": result["status"], "summary": result["summary"]}))


if __name__ == "__main__":
    main()
