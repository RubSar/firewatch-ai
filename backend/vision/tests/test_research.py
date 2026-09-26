"""Synthetic fixtures verify scientific bookkeeping, not real-world accuracy."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

from baselines import Config, combine_presence, confusion, mask_counts, mask_scores, remove_small_components, rgb_candidates, thermal_candidates
from dataset import load_record, sha256, validate_manifest
from download_flame3 import select_pairs
from run_baseline import run


class BaselineTests(unittest.TestCase):
    def test_rgb_rule_rejects_white_and_green(self):
        image = np.array([[[255, 255, 255], [255, 120, 10], [10, 200, 50]]], dtype=np.uint8)
        result = rgb_candidates(image, Config(min_component_pixels=1))
        np.testing.assert_array_equal(result, [[False, True, False]])

    def test_four_connected_components_do_not_join_diagonally(self):
        mask = np.eye(3, dtype=bool)
        self.assertFalse(remove_small_components(mask, 2).any())

    def test_component_removal_preserves_large_region(self):
        mask = np.array([[1, 1, 0, 0], [0, 1, 0, 1]], dtype=bool)
        self.assertEqual(int(remove_small_components(mask, 3).sum()), 3)

    def test_thermal_invalid_is_not_cold(self):
        values = np.array([[np.nan, 100], [np.inf, -np.inf]], dtype=np.float32)
        mask, valid = thermal_candidates(values, "celsius", Config(min_component_pixels=1))
        self.assertEqual(int(mask.sum()), 1)
        self.assertEqual(int(valid.sum()), 1)

    def test_non_celsius_rejected(self):
        with self.assertRaises(ValueError):
            thermal_candidates(np.ones((2, 2)), "kelvin", Config())

    def test_missing_modality_is_not_negative(self):
        self.assertIsNone(combine_presence(False, None))
        self.assertIsNone(combine_presence(None, None))
        self.assertTrue(combine_presence(True, None))
        self.assertFalse(combine_presence(False, False))

    def test_confusion_hand_computed(self):
        result = confusion([True, True, False, False, True, None], [True, False, True, False, None, True])
        self.assertEqual([result[k] for k in ("tp", "fn", "fp", "tn", "unavailable", "unlabeled")], [1]*6)
        self.assertEqual(result["precision"], 0.5)
        self.assertEqual(result["recall"], 0.5)

    def test_zero_denominators_are_unavailable(self):
        result = confusion([False], [False])
        self.assertIsNone(result["recall"])
        self.assertIsNone(result["precision"])
        self.assertEqual(result["negative_image_false_positive_rate"], 0)

    def test_mask_ignore_and_overlap(self):
        scores = mask_scores(mask_counts(np.array([[1, 1], [0, 1]], dtype=bool), np.array([[1, 0], [1, 255]])))
        self.assertEqual(scores["valid_pixels"], 3)
        self.assertAlmostEqual(scores["iou"], 1/3)
        self.assertAlmostEqual(scores["dice"], 0.5)

    def test_empty_masks_do_not_inflate_mean_iou(self):
        self.assertIsNone(mask_scores(mask_counts(np.zeros((2, 2), bool), np.zeros((2, 2), np.uint8)))["iou"])

    def test_unknown_mask_codes_rejected(self):
        with self.assertRaises(ValueError):
            mask_counts(np.ones((1, 1), bool), np.array([[2]]))

    def test_nonfinite_threshold_rejected(self):
        with self.assertRaises(ValueError):
            Config(thermal_threshold_c=float("nan"))


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        Image.fromarray(np.full((8, 8, 3), [255, 120, 10], dtype=np.uint8)).save(self.root / "rgb.png")
        Image.fromarray(np.full((8, 8), 100, dtype=np.float32)).save(self.root / "thermal.tiff")
        self.record = {
            "sample_id": "synthetic-a", "incident_id": "synthetic-incident", "sequence_id": None,
            "split": "pilot", "capture_time_utc": None, "relative_time_s": None,
            "presence_label": True, "rgb_path": "rgb.png", "thermal_path": "thermal.tiff",
            "thermal_unit": "celsius", "registration": "verified", "mask_path": None, "mask_semantics": None,
            "sha256": {"rgb": sha256(self.root / "rgb.png"), "thermal": sha256(self.root / "thermal.tiff")},
        }
        self.manifest = {"schema_version": "firewatch.research.dataset.v1", "data_kind": "synthetic",
                         "dataset_id": "unit-test", "source_url": "synthetic:test", "label_provenance": "test construction",
                         "sampling": "synthetic unit fixture", "records": [self.record]}

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        path = self.root / "manifest.json"
        path.write_text(json.dumps(self.manifest), encoding="utf-8")
        return path

    def test_valid_manifest(self):
        self.assertEqual(len(validate_manifest(self.save())["records"]), 1)

    def test_incident_split_leakage(self):
        other = copy.deepcopy(self.record)
        other.update(sample_id="synthetic-b", split="test")
        self.manifest["records"].append(other)
        with self.assertRaisesRegex(ValueError, "Incident leakage"):
            validate_manifest(self.save())

    def test_duplicate_bytes_across_incidents_rejected(self):
        other = copy.deepcopy(self.record)
        other.update(sample_id="synthetic-b", incident_id="different", split="test")
        self.manifest["records"].append(other)
        with self.assertRaisesRegex(ValueError, "Duplicate media"):
            validate_manifest(self.save())

    def test_media_tamper_rejected(self):
        (self.root / "rgb.png").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            validate_manifest(self.save())

    def test_path_traversal_rejected(self):
        self.record["rgb_path"] = "../outside.png"
        with self.assertRaisesRegex(ValueError, "escapes"):
            validate_manifest(self.save())

    def test_relative_time_requires_sequence(self):
        self.record["relative_time_s"] = 0
        with self.assertRaisesRegex(ValueError, "Relative seconds"):
            validate_manifest(self.save())

    def test_unknown_timezone_not_invented(self):
        self.record["capture_time_utc"] = "2023-10-25T12:00:00"
        with self.assertRaisesRegex(ValueError, "UTC"):
            validate_manifest(self.save())

    def test_date_only_cannot_be_capture_datetime(self):
        self.record["capture_time_utc"] = "2023-10-25Z"
        with self.assertRaisesRegex(ValueError, "UTC"):
            validate_manifest(self.save())

    def test_nonfinite_saturation_rejected(self):
        self.record["thermal_saturation_c"] = float("nan")
        with self.assertRaisesRegex(ValueError, "saturation"):
            validate_manifest(self.save())

    def test_sensor_specific_saturation_does_not_claim_exact_max(self):
        self.record["thermal_saturation_c"] = 95.0
        with contextlib.redirect_stdout(io.StringIO()):
            run(self.save(), self.root / "run", Config(), "pilot")
        stats = json.loads((self.root / "run/observations.jsonl").read_text())["thermal_stats"]
        self.assertTrue(stats["at_saturation_bound"])
        self.assertIsNone(stats["finite_max_c"])
        self.assertEqual(stats["max_lower_bound_c"], 95.0)

    def test_palette_thermal_rejected(self):
        Image.fromarray(np.zeros((8, 8, 3), dtype=np.uint8)).save(self.root / "thermal.tiff")
        with self.assertRaisesRegex(ValueError, "Celsius TIFF"):
            load_record(self.root, self.record)

    def test_registered_shape_mismatch(self):
        Image.fromarray(np.full((4, 4), 100, dtype=np.float32)).save(self.root / "thermal.tiff")
        with self.assertRaisesRegex(ValueError, "dimensions"):
            load_record(self.root, self.record)

    def test_end_to_end_preserves_unknown_metrics_and_masks(self):
        with contextlib.redirect_stdout(io.StringIO()):
            report = run(self.save(), self.root / "run", Config(), "pilot")
        self.assertEqual(report["image_presence"]["thermal_threshold"]["tp"], 1)
        self.assertIsNone(report["rgb_pixel_segmentation"])
        observation = json.loads((self.root / "run/observations.jsonl").read_text())
        self.assertIsNone(observation["capture_time_utc"])
        self.assertIsNone(observation["ground_geometry"])
        self.assertTrue((self.root / "run/contact-sheet-1.png").exists())
        self.assertIn("time_to_detection", report["unavailable_metrics"])
        with self.assertRaisesRegex(ValueError, "not empty"):
            run(self.save(), self.root / "run", Config(), "pilot")

    def test_all_invalid_thermal_abstains(self):
        Image.fromarray(np.full((8, 8), np.nan, dtype=np.float32)).save(self.root / "thermal.tiff")
        self.record["sha256"]["thermal"] = sha256(self.root / "thermal.tiff")
        self.record["rgb_path"] = None
        with contextlib.redirect_stdout(io.StringIO()):
            report = run(self.save(), self.root / "run", Config(), "pilot")
        self.assertEqual(report["image_presence"]["presence_or"]["unavailable"], 1)


class SamplingTests(unittest.TestCase):
    def test_selection_spans_available_ranks_and_pairs_by_stem(self):
        files = [{"name": f"dataset/Fire/{modality}/{i:05d}.{ext}", "bytes": 10}
                 for i in range(1, 6) for modality, ext in (("RGB/Corrected FOV", "JPG"), ("Thermal/Celsius TIFF", "TIFF"))]
        pairs = select_pairs(files, "Fire", 3)
        self.assertEqual([Path(pair[0]["name"]).stem for pair in pairs], ["00001", "00003", "00005"])


if __name__ == "__main__":
    unittest.main()
