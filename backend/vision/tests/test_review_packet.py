import copy
import contextlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import numpy as np
from PIL import Image

from audit_annotations import audit
from dataset import sha256
from import_flame2 import import_archive
from review_packet import TARGETS, agreement, build_packet, canonical_hash, compare, decode_rle, validate_review


def packet(shape=(5, 5)):
    core = {"schema_version": "firewatch.research.review_packet.v1", "data_kind": "synthetic",
            "targets": list(TARGETS), "mask_codes": {"0": "negative", "1": "positive", "255": "unknown"},
            "evidence": "Synthetic unit test only", "cases": [{"case_id": "case-001", "rgb_sha256": "a" * 64,
                                                                   "dimensions_hw": list(shape)}]}
    return {**core, "packet_id": canonical_hash(core)}


def review(p, slot="A", code=0, reviewed=True):
    case = p["cases"][0]
    size = int(np.prod(case["dimensions_hw"]))
    return {"schema_version": "firewatch.research.human_review.v1", "packet_id": p["packet_id"],
            "reviewer_slot": slot, "reviewer_id": "synthetic-test-" + slot,
            "annotator_type": "human", "method": "manual", "independence_attested": True,
            "exported_at_utc": "2026-09-27T12:00:00Z", "records": [{**case,
                "layers": {t: {"reviewed": reviewed, "modified_at_utc": "2026-09-27T11:00:00Z",
                               "notes": "Synthetic test; not human labels", "mask_rle": [[code, size]]} for t in TARGETS}}]}


class ReviewPacketTests(unittest.TestCase):
    def test_rle_roundtrip_and_reject_malformed_counts(self):
        np.testing.assert_array_equal(decode_rle([[0, 2], [1, 1], [255, 1]], [2, 2]), [[0, 0], [1, 255]])
        for runs in ([], [[0, 3]], [[0, 5]], [[2, 4]], [[True, 4]], [[0, True]], [[0, -1]], [[0, 1.5]]):
            with self.subTest(runs=runs), self.assertRaises(ValueError):
                decode_rle(runs, [2, 2])
        with self.assertRaises(ValueError):
            decode_rle([[0, 100000000]], [10000, 10000])

    def test_joint_valid_metrics_hand_calculated(self):
        a = np.array([[1, 1, 0], [0, 255, 1]], np.uint8)
        b = np.array([[1, 0, 1], [0, 1, 255]], np.uint8)
        scores = agreement(a, b, 0)
        self.assertAlmostEqual(scores["iou"], 1 / 3)
        self.assertEqual(scores["dice"], .5)
        self.assertEqual(scores["joint_valid_pixels"], 4)
        self.assertEqual(scores["disagreement_pixels"], 2)
        self.assertEqual(scores["ignore_disagreement_pixels"], 2)

    def test_empty_and_unknown_have_no_perfect_score(self):
        for code in (0, 255):
            a = np.full((5, 5), code, np.uint8)
            scores = agreement(a, a, 1)
            self.assertIsNone(scores["iou"])
            self.assertIsNone(scores["dice"])
            self.assertIsNone(scores["boundary_f1"])
        self.assertIsNone(scores["disagreement_fraction"])

    def test_boundary_tolerance_and_ignored_neighbor(self):
        a = np.zeros((7, 7), np.uint8)
        b = a.copy()
        a[3, 3] = 1
        b[3, 4] = 1
        self.assertEqual(agreement(a, b, 0)["boundary_f1"], 0)
        self.assertEqual(agreement(a, b, 1)["boundary_f1"], 1)
        b[3, 2] = 255
        self.assertEqual(agreement(a, b, 1)["left_boundary_pixels"], 0)
        edge = np.zeros((7, 7), np.uint8)
        edge[0, 3] = 1
        self.assertIsNone(agreement(edge, edge, 0)["boundary_f1"])

    def test_identical_positive_masks_do_not_auto_accept(self):
        p = packet()
        result = compare(p, review(p, "A", 1), review(p, "B", 1), 0)
        self.assertEqual(result["summary"]["visible_flame"]["micro_iou"], 1)
        self.assertEqual(result["status"], "awaiting_coordinator_acceptance")
        self.assertFalse(result["independent_review_accepted"])
        self.assertFalse(result["benchmark_frozen"])
        self.assertEqual(result["data_kind"], "synthetic")

    def test_missing_and_unfinished_are_not_negative(self):
        p = packet()
        a, b = review(p), review(p, "B")
        b["records"] = []
        result = compare(p, a, b, 1)
        self.assertEqual(len(result["adjudication_queue"]), 2)
        self.assertEqual(result["summary"]["visible_flame"]["compared_cases"], 0)
        self.assertIsNone(result["summary"]["visible_flame"]["micro_iou"])
        b = review(p, "B", reviewed=False)
        self.assertEqual(compare(p, a, b, 1)["records"], [])
        with self.assertRaises(ValueError):
            compare(p, a, b, -1)

    def test_shared_unknown_coverage_requires_adjudication(self):
        p = packet()
        result = compare(p, review(p, "A", 255), review(p, "B", 255), 1)
        self.assertEqual(len(result["adjudication_queue"]), 2)
        self.assertEqual(result["summary"]["smoke"]["joint_valid_pixels"], 0)

    def test_requires_distinct_attested_slots(self):
        p = packet()
        a = review(p)
        for field, value in (("reviewer_id", " SYNTHETIC-TEST-A "), ("reviewer_slot", "A"), ("independence_attested", False)):
            b = review(p, "B")
            b[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                compare(p, a, b, 1)

    def test_reject_tamper_case_identity_and_label_metadata(self):
        p = packet()
        for mutate in (lambda r: r.update(packet_id="b" * 64),
                       lambda r: r["records"][0].update(rgb_sha256="b" * 64),
                       lambda r: r["records"].append(copy.deepcopy(r["records"][0])),
                       lambda r: r["records"][0]["layers"].pop("smoke"),
                       lambda r: r["records"][0]["layers"]["smoke"].update(notes="", mask_rle=[[255, 25]]),
                       lambda r: r["records"][0]["layers"]["smoke"].update(modified_at_utc="2026-09-27")):
            r = review(p)
            mutate(r)
            with self.assertRaises(ValueError):
                validate_review(p, r)
        p["cases"][0]["dimensions_hw"] = [6, 6]
        with self.assertRaisesRegex(ValueError, "integrity"):
            validate_review(p, review(p))

    def test_synthetic_cli_emits_hashes_and_preserves_output(self):
        p = packet()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, data in (("packet", p), ("a", review(p)), ("b", review(p, "B", 1))):
                (root / f"{name}.json").write_text(json.dumps(data), encoding="utf-8")
            args = [sys.executable, "-B", str(Path(__file__).resolve().parents[1] / "review_packet.py"), "score",
                    str(root / "packet.json"), str(root / "a.json"), str(root / "b.json"),
                    "--boundary-tolerance-pixels", "1", "--output", str(root / "score.json")]
            run = subprocess.run(args, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            result = json.loads((root / "score.json").read_text())
            self.assertEqual(result["input_sha256"]["review_a"], sha256(root / "a.json"))
            self.assertEqual(result["summary"]["smoke"]["micro_iou"], 0)
            original = sha256(root / "score.json")
            self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)
            self.assertEqual(original, sha256(root / "score.json"))

    def test_built_pages_embed_only_rgb_and_separate_slots(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive_path = root / "synthetic.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                for kind in ("rgb", "ir", "gt"):
                    pixels = np.full((8, 8, 3), {"rgb": 70, "ir": 90, "gt": 255}[kind], np.uint8)
                    memory = io.BytesIO()
                    Image.fromarray(pixels).save(memory, format="PNG")
                    archive.writestr(f"FLAME2/images/img_{kind}_(1).png", memory.getvalue())
            with patch("import_flame2.EXPECTED_SHA256", sha256(archive_path)), contextlib.redirect_stdout(io.StringIO()):
                inventory = import_archive(archive_path, root / "prepared")
                inventory["data_kind"] = "synthetic"
                inventory_path = root / "prepared/inventory.json"
                inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
                audit(inventory_path, root / "audit")
                built = build_packet(inventory_path, root / "audit/report.json", root / "packet")
            for slot in ("A", "B"):
                html = (root / f"packet/reviewer-{slot}/index.html").read_text(encoding="utf-8")
                payload = json.loads(re.search(r"const INPUT = (.*);\n", html)[1])
                self.assertEqual(payload["slot"], slot)
                self.assertEqual(payload["packet"], built)
                self.assertEqual(set(payload), {"slot", "packet", "images"})
                self.assertEqual(set(payload["images"]), {"case-001"})
                self.assertEqual(set(payload["packet"]["cases"][0]), {"case_id", "rgb_sha256", "dimensions_hw"})
                self.assertNotIn("flame2-rff-1", html)
            coordinator = json.loads((root / "packet/coordinator.json").read_text())
            self.assertEqual(coordinator["human_reviews_received"], 0)
            self.assertIsNone(coordinator["reviewers"]["A"])
            with self.assertRaisesRegex(ValueError, "not empty"):
                build_packet(inventory_path, root / "audit/report.json", root / "packet")


if __name__ == "__main__":
    unittest.main()
