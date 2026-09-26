"""Strict, offline import of the pinned RFF FLAME2 release for annotation audit.

The publisher fire class is not asserted to be RGB-visible flame. IR PNG values
are display intensities, not Celsius. This inventory cannot enter run_baseline.py.
"""
import argparse
from collections import defaultdict
import hashlib
import io
import json
from pathlib import Path
import re
import zipfile

import numpy as np
from PIL import Image

from dataset import sha256, utc_now
from download_flame2 import EXPECTED_SHA256, SOURCE_COMMIT

PATTERN = re.compile(r"FLAME2/images/img_(rgb|ir|gt)_\((\d+)\)\.png")
SOURCE_URL = "https://github.com/dimfot3/RoboFireFuseNet"
INCIDENT_ID = "flame2-northern-arizona-2021-11"


def index_archive(archive):
    groups = defaultdict(dict)
    names = set()
    total = 0
    for info in archive.infolist():
        if info.filename in names:
            raise ValueError("Duplicate archive entry")
        names.add(info.filename)
        if info.is_dir() and info.filename in ("FLAME2/", "FLAME2/images/"):
            continue
        match = PATTERN.fullmatch(info.filename)
        if not match or info.file_size > 5_000_000:
            raise ValueError(f"Unexpected or oversized archive member: {info.filename}")
        total += info.file_size
        if total > 300_000_000:
            raise ValueError("Uncompressed archive exceeds limit")
        modality, sid = match.groups()
        if modality in groups[sid]:
            raise ValueError("Duplicate sample modality")
        groups[sid][modality] = info.filename
    if not groups or any(set(item) != {"rgb", "ir", "gt"} for item in groups.values()):
        raise ValueError("Archive has missing sample triplets")
    return groups


def decode_mask(image):
    """Exact palette mapping; white=fire, NOT ignore. Never guess from a maximum."""
    if image.mode not in ("RGB", "RGBA"):
        raise ValueError("Expected publisher RGB/RGBA color mask")
    values = np.array(image)
    if image.mode == "RGBA" and np.any(values[:, :, 3] != 255):
        raise ValueError("Nonopaque mask needs explicit annotation policy")
    colors = values[:, :, :3]
    mask = np.full(colors.shape[:2], 255, dtype=np.uint8)
    for raw, label in ((0, 0), (125, 1), (255, 2)):
        mask[np.all(colors == raw, axis=2)] = label
    if np.any(mask == 255):
        raise ValueError("Unknown mask color; refusing silent background/ignore conversion")
    return mask


def rgb_fingerprints(image):
    rgb = image.convert("RGB")
    # Include dimensions so identical bytes under a different shape cannot collide.
    decoded = hashlib.sha256(str(rgb.size).encode() + rgb.tobytes()).hexdigest()
    small = np.asarray(rgb.convert("L").resize((9, 8), Image.Resampling.LANCZOS))
    bits = (small[:, 1:] > small[:, :-1]).flatten()
    dhash = sum(int(bit) << index for index, bit in enumerate(bits))
    return decoded, f"{dhash:016x}"


def import_archive(archive_path, output):
    archive_path, output = Path(archive_path), Path(output)
    if sha256(archive_path) != EXPECTED_SHA256:
        raise ValueError("Archive checksum differs from audited release")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output directory is not empty")
    records = []
    with zipfile.ZipFile(archive_path) as archive:
        groups = index_archive(archive)
        for folder in ("rgb", "ir_display", "source_masks", "masks"):
            (output / folder).mkdir(parents=True, exist_ok=True)
        for sid in sorted(groups, key=int):
            contents = {key: archive.read(value) for key, value in groups[sid].items()}
            with Image.open(io.BytesIO(contents["gt"])) as image:
                mask = decode_mask(image)
            with Image.open(io.BytesIO(contents["rgb"])) as image:
                if image.size != mask.shape[::-1]:
                    raise ValueError(f"RGB/mask dimension mismatch: {sid}")
                decoded, dhash = rgb_fingerprints(image)
                rgb_mode = image.mode
            with Image.open(io.BytesIO(contents["ir"])) as image:
                if image.size != mask.shape[::-1]:
                    raise ValueError(f"IR/mask dimension mismatch: {sid}")
                ir_mode = image.mode
            paths = {"rgb": f"rgb/{sid}.png", "ir_display": f"ir_display/{sid}.png",
                     "source_mask": f"source_masks/{sid}.png", "mask": f"masks/{sid}.png"}
            for kind, source_kind in (("rgb", "rgb"), ("ir_display", "ir"), ("source_mask", "gt")):
                (output / paths[kind]).write_bytes(contents[source_kind])
            Image.fromarray(mask).save(output / paths["mask"])
            counts = {str(code): int(np.count_nonzero(mask == code)) for code in (0, 1, 2, 255)}
            records.append({
                "sample_id": f"flame2-rff-{sid}", "source_sample_id": sid,
                "incident_id": INCIDENT_ID, "site_id": "flame2-northern-arizona-burn-site",
                "split": "pilot", "source_split": None, "sequence_id": None,
                "capture_time_utc": None, "relative_time_s": None,
                "registration": "publisher_pairing_unverified",
                "paths": paths, "sha256": {key: sha256(output / value) for key, value in paths.items()},
                "source_paths": groups[sid], "rgb_decoded_sha256": decoded, "rgb_dhash64": dhash,
                "dimensions_hw": list(mask.shape), "source_modes": {"rgb": rgb_mode, "ir": ir_mode, "mask": "RGBA"},
                "label_pixels": counts, "annotation_revision": "rff-flame2-" + EXPECTED_SHA256[:12],
                "review_status": "pending_independent_review",
            })
    inventory = {
        "schema_version": "firewatch.research.annotation_inventory.v1", "data_kind": "real",
        "dataset_id": "flame2-rff", "created_at_utc": utc_now(),
        "source_url": SOURCE_URL, "source_commit": SOURCE_COMMIT,
        "source_archive_sha256": EXPECTED_SHA256,
        "code_sha256": {name: sha256(Path(__file__).with_name(name))
                        for name in ("import_flame2.py", "download_flame2.py", "dataset.py")},
        "publisher_license": {"annotations": "MIT", "images": "CC-BY-4.0 (RFF authors' declaration)"},
        "annotation_provenance": {
            "authors": "RoboFireFuseNet authors (Fotiou, Mygdalis, Pitas)",
            "method": "manual_reported_by_paper", "modalities_shown_to_annotator": "not_resolved",
            "annotation_time_utc": None, "individual_annotator_ids": None,
            "independent_second_review": False, "agreement_score": None,
            "semantics": "publisher_multimodal_fire_smoke",
            "overlap_policy": "publisher prioritizes fire over smoke", "visible_flame_equivalence": False,
        },
        "label_map": {"0": "publisher_background", "1": "publisher_smoke", "2": "publisher_fire", "255": "ignore"},
        "source_color_map": {"0,0,0": 0, "125,125,125": 1, "255,255,255": 2},
        "thermal_measurement": "unavailable: IR display PNG is not Celsius",
        "sampling": "All complete triplets in pinned archive; numeric filename sorting is not capture time.",
        "records": records,
    }
    (output / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8")
    print(f"Imported {len(records)} complete triplets into {output}")
    return inventory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    import_archive(args.archive, args.output)


if __name__ == "__main__":
    main()
