"""Audit published Boreal file metadata only; no imagery or masks are downloaded."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path, PurePosixPath
import re

from dataset import sha256, utc_now

CATALOG_URL = ("https://metax-legacy.fairdata.fi/rest/v2/datasets/"
               "1dce1023-493a-4d63-a906-f2a44f831898/files?file_fields=identifier,file_path,byte_size")


def summarize(files):
    grouped = defaultdict(dict)
    site_counts = defaultdict(Counter)
    for item in files:
        if "/Boreal-Forest-Fire-Subset-C/" not in item["file_path"]:
            continue
        relative = item["file_path"].split("/Boreal-Forest-Fire-Subset-C/", 1)[1]
        kind, split, filename = relative.split("/")
        stem = PurePosixPath(filename).stem
        if stem in grouped[kind, split]:
            raise ValueError("Duplicate filename stem in catalogue")
        grouped[kind, split][stem] = item
        if kind == "images":
            match = re.match(r"(evo|heinola|karkkila|ruokolahti)_?DJI_", stem)
            if not match:
                raise ValueError(f"Unmapped site prefix: {stem}")
            site_counts[match[1]][split] += 1
    if not site_counts:
        raise ValueError("No Subset C images")
    counts = {f"{kind}/{split}": len(items) for (kind, split), items in sorted(grouped.items())}
    missing = {}
    for split in ("train", "valid", "test"):
        images = set(grouped["images", split])
        for kind in ("sam_masks", "manual_masks"):
            missing[f"{kind}/{split}"] = sorted(images - set(grouped[kind, split]))
    return {"schema_version": "firewatch.research.catalog_audit.v1", "dataset_id": "boreal-forest-fire",
            "source_url": CATALOG_URL, "acquisition_status": "metadata_only_no_media_downloaded",
            "target": "smoke_only_not_fire_extent", "file_counts": counts,
            "image_counts_by_site_and_publisher_split": dict(site_counts),
            "missing_matching_mask_counts": {key: len(value) for key, value in missing.items()},
            "missing_matching_mask_sample_ids": missing,
            "publisher_split_is_site_disjoint": all(len(counts) == 1 for counts in site_counts.values()),
            "decision": "Candidate smoke sub-study. Regroup by whole site before learning; missing masks remain unknown, never auto-background."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = summarize(json.loads(args.catalog.read_text(encoding="utf-8-sig")))
    result.update(created_at_utc=utc_now(), catalog_sha256=sha256(args.catalog), code_sha256=sha256(__file__))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as output:
        output.write(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ("file_counts", "image_counts_by_site_and_publisher_split", "missing_matching_mask_counts")}))
