"""Verify an annotation inventory and produce mask/duplicate review material."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from dataset import local_path, sha256, utc_now
from import_flame2 import rgb_fingerprints


def validate_inventory(path):
    path = Path(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema_version") != "firewatch.research.annotation_inventory.v1":
        raise ValueError("Unsupported annotation inventory")
    if data.get("data_kind") not in ("real", "synthetic") or not data.get("records"):
        raise ValueError("Expected nonempty real/synthetic inventory")
    expected_map = {"0": "publisher_background", "1": "publisher_smoke", "2": "publisher_fire", "255": "ignore"}
    if data.get("label_map") != expected_map:
        raise ValueError("Unsupported label map; implement an explicit adapter")
    ids = set()
    for record in data["records"]:
        sid = record["sample_id"]
        if not isinstance(sid, str) or not sid or sid in ids:
            raise ValueError("Empty or duplicate sample ID")
        ids.add(sid)
        for field in ("incident_id", "site_id", "annotation_revision", "review_status"):
            if not isinstance(record.get(field), str) or not record[field]:
                raise ValueError(f"Missing {field}")
        if record["split"] not in ("pilot", "train", "validation", "test"):
            raise ValueError("Unknown split")
        for kind in ("rgb", "ir_display", "source_mask", "mask"):
            media = local_path(path.parent, record["paths"][kind])
            if sha256(media) != record["sha256"].get(kind):
                raise ValueError(f"SHA-256 mismatch: {sid}/{kind}")
            with Image.open(media) as image:
                if list(image.size[::-1]) != record["dimensions_hw"]:
                    raise ValueError(f"Dimension mismatch: {sid}/{kind}")
                if kind == "mask":
                    mask = np.asarray(image)
                    if mask.ndim != 2 or not np.isin(mask, [0, 1, 2, 255]).all():
                        raise ValueError("Invalid canonical mask")
                    counts = {str(code): int(np.count_nonzero(mask == code)) for code in (0, 1, 2, 255)}
                    if counts != record["label_pixels"]:
                        raise ValueError("Mask pixel counts disagree with inventory")
                if kind == "rgb":
                    decoded, dhash = rgb_fingerprints(image)
                    if (decoded, dhash) != (record["rgb_decoded_sha256"], record["rgb_dhash64"]):
                        raise ValueError("RGB fingerprints disagree with inventory")
    return data


def duplicate_audit(records, threshold=4):
    groups = defaultdict(list)
    for record in records:
        groups[record["rgb_decoded_sha256"]].append(record["sample_id"])
    exact = [group for group in groups.values() if len(group) > 1]
    near = []
    fingerprints = [int(record["rgb_dhash64"], 16) for record in records]
    for i, left in enumerate(records):
        for j in range(i + 1, len(records)):
            right = records[j]
            if left["rgb_decoded_sha256"] == right["rgb_decoded_sha256"]:
                continue
            distance = (fingerprints[i] ^ fingerprints[j]).bit_count()
            if distance <= threshold:
                near.append({"left": left["sample_id"], "right": right["sample_id"], "hamming_distance": distance})
    return {"exact_decoded_rgb_groups": exact, "near_duplicate_candidates": near,
            "method": "64-bit grayscale difference hash, 9x8 Lanczos thumbnail; Hamming distance <=4",
            "interpretation": "Candidates for review, not proof of duplication or independence; no automatic removal."}


def select_review(records):
    """20 evenly spaced ranks plus deterministic class/area extremes; not random."""
    indices = np.linspace(0, len(records) - 1, min(20, len(records)), dtype=int).tolist()
    chosen = [records[index] for index in indices]
    for code in ("1", "2"):
        positives = [r for r in records if r["label_pixels"][code] > 0]
        if positives:
            chosen += [min(positives, key=lambda r: r["label_pixels"][code]),
                       max(positives, key=lambda r: r["label_pixels"][code])]
    for fire, smoke in ((False, False), (False, True), (True, False), (True, True)):
        chosen += next(([r] for r in records if (r["label_pixels"]["2"] > 0, r["label_pixels"]["1"] > 0) == (fire, smoke)), [])
    return list({r["sample_id"]: r for r in chosen}.values())


def contact_sheets(records, root, output):
    selected = select_review(records)
    for offset in range(0, len(selected), 6):
        rows = selected[offset:offset + 6]
        sheet = Image.new("RGB", (960, 70 + len(rows) * 278), "#101820")
        draw = ImageDraw.Draw(sheet)
        draw.text((10, 8), "FLAME2 annotation AUDIT - publisher labels; independent review pending", fill="white")
        draw.text((10, 30), "RGB                         IR display (not Celsius)          RGB + smoke blue / fire orange", fill="white")
        for i, record in enumerate(rows):
            with Image.open(local_path(root, record["paths"]["rgb"])) as image:
                rgb = image.convert("RGB")
            with Image.open(local_path(root, record["paths"]["ir_display"])) as image:
                infrared = image.convert("RGB")
            with Image.open(local_path(root, record["paths"]["mask"])) as image:
                mask = np.asarray(image)
            overlay = np.asarray(rgb).copy()
            for code, color in ((1, [40, 150, 255]), (2, [255, 100, 0]), (255, [220, 0, 220])):
                overlay[mask == code] = (0.45 * overlay[mask == code] + 0.55 * np.array(color)).astype(np.uint8)
            for column, panel in enumerate((rgb, infrared, Image.fromarray(overlay))):
                panel.thumbnail((314, 248))
                sheet.paste(panel, (column * 320 + 3, 70 + i * 278))
            draw.text((8, 70 + i * 278 + 250), record["sample_id"], fill="white")
        sheet.save(output / f"review-{offset // 6 + 1}.png")
    return [r["sample_id"] for r in selected]


def audit(path, output):
    path, output = Path(path), Path(output)
    data = validate_inventory(path)
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output directory is not empty")
    output.mkdir(parents=True, exist_ok=True)
    records = data["records"]
    duplicates = duplicate_audit(records)
    (output / "duplicates.json").write_text(json.dumps(duplicates, indent=2) + "\n", encoding="utf-8")
    review_ids = contact_sheets(records, path.parent, output)
    totals = {code: sum(r["label_pixels"][code] for r in records) for code in ("0", "1", "2", "255")}
    report = {
        "schema_version": "firewatch.research.annotation_audit.v1", "created_at_utc": utc_now(),
        "inventory_sha256": sha256(path), "source_archive_sha256": data.get("source_archive_sha256"),
        "code_sha256": {name: sha256(Path(__file__).with_name(name)) for name in ("audit_annotations.py", "import_flame2.py", "dataset.py")},
        "sample_count": len(records), "incident_count": len({r["incident_id"] for r in records}),
        "dimensions_hw": dict(Counter(str(r["dimensions_hw"]) for r in records)),
        "source_modes": dict(Counter(str(r["source_modes"]) for r in records)),
        "label_pixel_counts": totals,
        "images_with_class": {code: sum(r["label_pixels"][code] > 0 for r in records) for code in totals},
        "images_without_fire_or_smoke": sum(r["label_pixels"]["0"] == sum(r["label_pixels"].values()) for r in records),
        "exact_decoded_rgb_duplicate_groups": len(duplicates["exact_decoded_rgb_groups"]),
        "near_duplicate_candidate_pairs": len(duplicates["near_duplicate_candidates"]),
        "duplicates_sha256": sha256(output / "duplicates.json"), "review_sample_ids": review_ids,
        "review_status": "contact_sheets_prepared_not_independent_human_review",
        "publisher_claim_sample_count": 995, "sample_count_discrepancy": 995 - len(records),
        "split_lists_present_in_archive": False, "all_records_assigned_to": "pilot",
        "visible_flame_evaluation_ready": False, "thermal_celsius_evaluation_ready": False,
        "limitations": ["Publisher fire is not verified equivalent to RGB-visible flame.",
                        "One incident; no unseen-incident train/validation/test evaluation.",
                        "No independent second annotations or inter-annotator agreement.",
                        "No verified timestamps, spatial registration or ground geometry.",
                        "Near-duplicate screening cannot establish independence."]}
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("sample_count", "incident_count", "label_pixel_counts", "images_with_class", "images_without_fire_or_smoke", "exact_decoded_rgb_duplicate_groups", "near_duplicate_candidate_pairs")}))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inventory", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    audit(args.inventory, args.output)
