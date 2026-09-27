"""Synthetic bookkeeping tests; no accuracy claims and no network downloads."""
import unittest
from pathlib import Path
import sys
import tempfile
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    import numpy as np
    import torch
    import rasterio
    from rasterio.transform import from_origin
    from prithvi_legacy import MEANS, normalize, predict, window_starts, load_model
    from prithvi_local import read_reflectance
    from prithvi_hls_catalog import fetch_all, group_items
    AVAILABLE = True
except ImportError:
    AVAILABLE = False


@unittest.skipUnless(AVAILABLE, "optional Prithvi environment not installed")
class PrithviTests(unittest.TestCase):
    def test_windows_cover_edges_with_published_stride(self):
        self.assertEqual(window_starts(512), [0, 112, 224, 288])
        self.assertEqual(window_starts(224), [0])
        with self.assertRaises(ValueError):
            window_starts(223)

    def test_overlap_average_preserves_logits_and_unknowns(self):
        class PixelModel(torch.nn.Module):
            def forward(self, x):
                return x[:, :2]
        values = np.zeros((6, 257, 319), np.float32)
        values[1, :, 160:] = 3
        valid = np.ones((257, 319), bool)
        valid[0, 0] = False
        labels, logits = predict(PixelModel(), values, valid, "cpu")
        np.testing.assert_allclose(logits, values[:2], rtol=0, atol=0)
        self.assertEqual(labels[0, 0], -1)
        self.assertTrue((labels[:, 160:] == 1).all())
        self.assertEqual(labels[-1, -1], 1)

    def test_band_order_and_invalid_fill(self):
        values = np.broadcast_to(np.array(MEANS, np.float32)[:, None, None], (6, 2, 2)).copy()
        values[:, 0, 0] = -9999
        valid = np.ones((2, 2), bool)
        valid[0, 0] = False
        normalized = normalize(values, valid)
        np.testing.assert_allclose(normalized, 0, atol=1e-7)
        values[5, 1, 1] = np.nan
        with self.assertRaises(ValueError):
            normalize(values, valid)

    def test_any_invalid_band_makes_pixel_unknown(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "example.tif"
            values = np.full((6, 2, 2), 0.1, np.float32)
            values[5, 0, 0] = -9999
            values[3, 1, 1] = np.nan
            with rasterio.open(file, "w", driver="GTiff", height=2, width=2, count=6,
                               dtype="float32", nodata=-9999, crs="EPSG:32615",
                               transform=from_origin(300000, 3500000, 30, 30)) as dst:
                dst.write(values)
            _, valid, _ = read_reflectance(file)
            np.testing.assert_array_equal(valid, [[False, True], [True, False]])

    def test_wrong_checkpoint_rejected_before_deserialization(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "bad.pth"
            file.write_bytes(b"not a model")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                load_model(file, "cpu")

    def test_catalogue_follows_all_pages(self):
        session = Mock()
        first, second = Mock(), Mock()
        first.headers = {"CMR-Hits": "2", "CMR-Search-After": "token1"}
        second.headers = {"CMR-Hits": "2"}
        first.json.return_value = {"items": [{"meta": {"concept-id": "G1"}}]}
        second.json.return_value = {"items": [{"meta": {"concept-id": "G2"}}]}
        session.get.side_effect = [first, second]
        items, pages = fetch_all(session, {"page_size": 1})
        self.assertEqual(len(items), 2)
        self.assertEqual(len(pages), 2)
        self.assertEqual(session.get.call_args.kwargs["headers"]["CMR-Search-After"], "token1")

    def test_catalogue_incomplete_results_are_not_accepted(self):
        session, response = Mock(), Mock()
        response.headers = {"CMR-Hits": "2"}
        response.json.return_value = {"items": [{"meta": {"concept-id": "G1"}}]}
        session.get.return_value = response
        with self.assertRaisesRegex(ValueError, "pagination"):
            fetch_all(session, {})

    def test_catalogue_groups_exact_times_without_accepting_scenes(self):
        def item(name, time):
            return {"meta": {"concept-id": name, "revision-id": 1},
                    "umm": {"GranuleUR": name, "TemporalExtent": {"SingleDateTime": time}}}
        groups = group_items([item("B", "2026-03-10T10:00:00Z"),
                              item("A", "2026-03-10T10:00:00.000Z"),
                              item("C", "2026-03-10T10:00:01Z")], "HLSS30", "post")
        self.assertEqual(len(groups), 2)
        self.assertEqual([g["granule_id"] for g in groups[0]["granules"]], ["A", "B"])
        self.assertFalse(groups[0]["accepted"])
        self.assertIsNone(groups[0]["fmask_valid_fraction"])


if __name__ == "__main__":
    unittest.main()
