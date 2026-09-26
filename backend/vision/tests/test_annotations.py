import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import sys
import zipfile

import numpy as np
from PIL import Image

from audit_annotations import audit, duplicate_audit, validate_inventory
from audit_boreal_catalog import summarize
from dataset import sha256
from import_flame2 import decode_mask, import_archive, index_archive, rgb_fingerprints
from prepare_benchmark import check_plan


class AnnotationTests(unittest.TestCase):
    def test_offline_import_audit_and_blocked_cli_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive_path = root / "synthetic.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                for kind in ("rgb", "ir", "gt"):
                    pixels = np.full((8, 8, 3), 255 if kind == "gt" else 100, np.uint8)
                    memory = io.BytesIO()
                    Image.fromarray(pixels).save(memory, format="PNG")
                    archive.writestr(f"FLAME2/images/img_{kind}_(1).png", memory.getvalue())
            with patch("import_flame2.EXPECTED_SHA256", sha256(archive_path)), contextlib.redirect_stdout(io.StringIO()):
                inventory = import_archive(archive_path, root / "prepared")
            inventory["data_kind"] = "synthetic"
            inventory_path = root / "prepared/inventory.json"
            inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                result = audit(inventory_path, root / "audit")
            self.assertEqual(result["label_pixel_counts"]["2"], 64)
            self.assertTrue((root / "audit/review-1.png").exists())
            plan = {"schema_version": "firewatch.research.split_plan.v1", "target": "visible_flame",
                    "incident_assignments": {inventory["records"][0]["incident_id"]: "pilot"}}
            (root / "plan.json").write_text(json.dumps(plan), encoding="utf-8")
            cli = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve().parents[1] / "prepare_benchmark.py"),
                                  str(inventory_path), str(root / "plan.json"), "--output", str(root / "gate.json")],
                                 capture_output=True, text=True)
            self.assertEqual(cli.returncode, 2, cli.stderr)
            self.assertEqual(json.loads((root / "gate.json").read_text())["status"], "blocked")
            inventory["records"][0]["label_pixels"]["2"] = 63
            inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "pixel counts"):
                validate_inventory(inventory_path)

    def test_white_is_fire_not_ignore_and_gray_is_smoke(self):
        values = np.array([[[0, 0, 0, 255], [125, 125, 125, 255], [255, 255, 255, 255]]], dtype=np.uint8)
        np.testing.assert_array_equal(decode_mask(Image.fromarray(values)), [[0, 1, 2]])

    def test_unknown_color_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unknown mask color"):
            decode_mask(Image.fromarray(np.array([[[124, 124, 124]]], dtype=np.uint8)))

    def test_transparent_mask_rejected(self):
        with self.assertRaisesRegex(ValueError, "Nonopaque"):
            decode_mask(Image.fromarray(np.array([[[255, 255, 255, 0]]], dtype=np.uint8)))

    def test_archive_incomplete_triplet_rejected(self):
        memory = io.BytesIO()
        with zipfile.ZipFile(memory, "w") as archive:
            archive.writestr("FLAME2/images/img_rgb_(1).png", b"image")
        with zipfile.ZipFile(memory) as archive, self.assertRaisesRegex(ValueError, "missing"):
            index_archive(archive)

    def test_archive_traversal_rejected(self):
        memory = io.BytesIO()
        with zipfile.ZipFile(memory, "w") as archive:
            archive.writestr("../escape.png", b"image")
        with zipfile.ZipFile(memory) as archive, self.assertRaisesRegex(ValueError, "Unexpected"):
            index_archive(archive)

    def test_decoded_duplicates_ignore_png_encoding(self):
        image = Image.fromarray(np.arange(192, dtype=np.uint8).reshape(8, 8, 3))
        decoded, dhash = rgb_fingerprints(image)
        other = image.copy()
        other.putpixel((0, 0), (1, 1, 1))
        changed, _ = rgb_fingerprints(other)
        records = [{"sample_id": "a", "rgb_decoded_sha256": decoded, "rgb_dhash64": dhash},
                   {"sample_id": "b", "rgb_decoded_sha256": decoded, "rgb_dhash64": dhash},
                   {"sample_id": "c", "rgb_decoded_sha256": changed, "rgb_dhash64": dhash}]
        result = duplicate_audit(records)
        self.assertEqual(result["exact_decoded_rgb_groups"], [["a", "b"]])
        self.assertEqual(len(result["near_duplicate_candidates"]), 2)

    def test_mask_and_rgb_dimensions_must_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("rgb", "ir_display", "source_mask", "mask"):
                Image.fromarray(np.zeros((2, 3) if name == "mask" else (3, 3), dtype=np.uint8)).save(root / f"{name}.png")
            decoded, dhash = rgb_fingerprints(Image.open(root / "rgb.png"))
            record = {"sample_id": "a", "incident_id": "i", "site_id": "s", "split": "pilot",
                      "annotation_revision": "test", "review_status": "pending", "dimensions_hw": [3, 3],
                      "paths": {n: f"{n}.png" for n in ("rgb", "ir_display", "source_mask", "mask")},
                      "rgb_decoded_sha256": decoded, "rgb_dhash64": dhash}
            record["sha256"] = {n: sha256(root / p) for n, p in record["paths"].items()}
            inventory = {"schema_version": "firewatch.research.annotation_inventory.v1", "data_kind": "synthetic",
                         "label_map": {"0": "publisher_background", "1": "publisher_smoke", "2": "publisher_fire", "255": "ignore"},
                         "records": [record]}
            (root / "inventory.json").write_text(json.dumps(inventory), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Dimension mismatch"):
                validate_inventory(root / "inventory.json")


class SplitTests(unittest.TestCase):
    def setUp(self):
        self.data = {"data_kind": "real", "annotation_provenance": {"visible_flame_equivalence": True,
                     "independent_second_review": True}, "records": []}
        for i, (split, dhash) in enumerate((("train", "0000000000000000"), ("validation", "ffffffffffffffff"), ("test", "aaaaaaaaaaaaaaaa"))):
            self.data["records"].append({"sample_id": str(i), "incident_id": f"incident-{i}", "site_id": f"site-{i}",
                "sequence_id": None, "split": split, "review_status": "independent_review_accepted",
                "rgb_decoded_sha256": f"decoded-{i}", "rgb_dhash64": dhash,
                "sha256": {"rgb": f"rgb-{i}", "ir_display": f"ir-{i}"}})
        self.plan = {"schema_version": "firewatch.research.split_plan.v1", "target": "visible_flame",
                     "incident_assignments": {r["incident_id"]: r["split"] for r in self.data["records"]}}

    def test_complete_incident_proposal_is_never_automatically_frozen(self):
        result = check_plan(self.data, self.plan)
        self.assertEqual(result["status"], "ready_for_review")
        self.assertFalse(result["frozen"])

    def test_one_incident_cannot_supply_three_splits(self):
        self.data["records"] = self.data["records"][:1]
        self.plan["incident_assignments"] = {"incident-0": "train"}
        result = check_plan(self.data, self.plan)
        self.assertEqual(result["status"], "blocked")
        self.assertTrue(any("validation" in r for r in result["reasons"]))

    def test_inspected_pilot_cannot_become_test(self):
        self.data["records"][2]["split"] = "pilot"
        self.assertTrue(any("pilot" in r for r in check_plan(self.data, self.plan)["reasons"]))

    def test_shared_site_blocks_even_with_different_incident_names(self):
        self.data["records"][2]["site_id"] = "site-0"
        self.assertIn("Site crosses split boundaries.", check_plan(self.data, self.plan)["reasons"])

    def test_ir_duplicate_blocks(self):
        self.data["records"][2]["sha256"]["ir_display"] = "ir-0"
        self.assertIn("Identical media crosses split boundaries.", check_plan(self.data, self.plan)["reasons"])

    def test_cross_split_near_duplicates_block(self):
        self.data["records"][2]["rgb_dhash64"] = "0000000000000001"
        self.assertEqual(check_plan(self.data, self.plan)["cross_split_near_duplicate_count"], 1)

    def test_publisher_multimodal_fire_not_visible_flame(self):
        self.data["annotation_provenance"]["visible_flame_equivalence"] = False
        self.assertTrue(any("RGB-visible" in r for r in check_plan(self.data, self.plan)["reasons"]))

    def test_independent_review_required(self):
        self.data["records"][2]["review_status"] = "pending"
        self.data["annotation_provenance"]["independent_second_review"] = False
        self.assertTrue(any("review" in r for r in check_plan(self.data, self.plan)["reasons"]))

    def test_missing_incident_assignment_rejected(self):
        self.plan["incident_assignments"].pop("incident-2")
        with self.assertRaisesRegex(ValueError, "exactly"):
            check_plan(self.data, self.plan)

    def test_synthetic_fixture_never_approved_as_real_benchmark(self):
        self.data["data_kind"] = "synthetic"
        self.assertEqual(check_plan(self.data, self.plan)["status"], "blocked")


class CatalogTests(unittest.TestCase):
    def test_missing_mask_remains_missing_and_same_site_crosses_splits(self):
        paths = ["images/train/evoDJI_0001_frame1.jpg", "images/test/evoDJI_0002_frame2.jpg",
                 "manual_masks/test/evoDJI_0002_frame2.png"]
        files = [{"file_path": "/Boreal-Forest-Fire-Subset-C/" + p, "identifier": str(i), "byte_size": 10}
                 for i, p in enumerate(paths)]
        result = summarize(files)
        self.assertEqual(result["missing_matching_mask_counts"]["sam_masks/train"], 1)
        self.assertEqual(result["missing_matching_mask_counts"]["manual_masks/test"], 0)
        self.assertFalse(result["publisher_split_is_site_disjoint"])

    def test_unknown_site_not_silently_invented(self):
        with self.assertRaisesRegex(ValueError, "Unmapped"):
            summarize([{"file_path": "/Boreal-Forest-Fire-Subset-C/images/train/unknown_1.jpg"}])


if __name__ == "__main__":
    unittest.main()
