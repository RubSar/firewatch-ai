"""Numerical and provenance checks; synthetic fixtures are not research evidence."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    import satellite_case as sc
except ModuleNotFoundError as exc:
    if exc.name in ('rasterio', 'shapely'):
        raise unittest.SkipTest('Install requirements-satellite.txt for satellite checks') from exc
    raise


class SatelliteTests(unittest.TestCase):
    def test_offset_changes_nbr(self):
        meta = {'scale': .0001, 'offset': -.1, 'nodata': 0}
        nir = sc.reflectance(np.array([[3000]]), meta)
        swir = sc.reflectance(np.array([[2000]]), meta)
        self.assertAlmostEqual(float(sc.nbr(nir, swir)[0, 0]), 1/3)
        self.assertNotAlmostEqual(float(sc.nbr(nir, swir)[0, 0]), .2)

    def test_nodata_is_not_reflectance(self):
        value = sc.reflectance(np.array([[0, 1000, 999]]),
                               {'scale': .0001, 'offset': -.1, 'nodata': 0})
        self.assertTrue(np.isnan(value[0, 0]))
        self.assertAlmostEqual(value[0, 1], 0)
        self.assertLess(value[0, 2], 0)
        self.assertTrue(np.isnan(sc.nbr(value, np.ones((1, 3)))[0, 2]))

    def test_zero_denominator_unknown(self):
        self.assertTrue(np.isnan(sc.nbr(np.zeros((1, 1)), np.zeros((1, 1)))[0, 0]))

    def test_nir_aggregation_preserves_unknown(self):
        values = np.arange(16, dtype=float).reshape(4, 4)
        values[0, 0] = np.nan
        pooled = sc.average_2x2(values)
        self.assertTrue(np.isnan(pooled[0, 0]))
        self.assertEqual(pooled[1, 1], 12.5)
        with self.assertRaises(ValueError):
            sc.average_2x2(np.zeros((3, 4)))

    def test_cloud_buffer_excludes_neighbors_and_edges(self):
        scl = np.full((7, 7), 4)
        scl[3, 3] = 9
        valid = sc.valid_scl(scl, {'valid_scl_classes': [4, 5, 6], 'cloud_buffer_pixels': 1})
        self.assertEqual(int(valid.sum()), 16)
        self.assertFalse(valid[2:5, 2:5].any())
        self.assertFalse(valid[0].any())

    def test_perimeter_holes_islands_and_orientation(self):
        outer = [[0,0],[10,0],[10,10],[0,10],[0,0]]
        hole = [[2,2],[8,2],[8,8],[2,8],[2,2]]
        island = [[4,4],[6,4],[6,6],[4,6],[4,4]]
        separate = [[20,0],[22,0],[22,2],[20,2],[20,0]]
        geometry = sc.perimeter_geometry([outer, hole, island, separate])
        self.assertEqual(geometry.area, 72)
        self.assertTrue(geometry.equals(sc.perimeter_geometry([list(reversed(r)) for r in [hole, separate, outer, island]])))

    def test_bad_geometry_not_repaired(self):
        with self.assertRaises(ValueError):
            sc.perimeter_geometry([[[0,0],[2,2],[0,2],[2,0],[0,0]]])
        with self.assertRaises(ValueError):
            sc.perimeter_geometry([[[0,0],[1,0],[1,1],[0,1]]])

    def test_known_confusion_ignores_unknown(self):
        pred = np.array([1,1,0,0,1], dtype=bool)
        ref = np.array([1,0,1,0,0], dtype=bool)
        valid = np.array([1,1,1,1,0], dtype=bool)
        result = sc.overlap(pred, ref, valid, .04)
        self.assertEqual([result[k] for k in ('tp','fp','fn','tn')], [1,1,1,1])
        self.assertAlmostEqual(result['iou'], 1/3)
        self.assertEqual(result['dice'], .5)
        self.assertEqual(result['area_bias_ha_on_valid'], 0)
        self.assertEqual(result['valid_pixels'], 4)

    def test_empty_metrics_null(self):
        blank = np.zeros((2,2), dtype=bool)
        result = sc.overlap(blank, blank, ~blank, .04)
        for key in ('iou','dice','precision','recall','area_bias_fraction_on_valid'):
            self.assertIsNone(result[key])
        self.assertEqual(result['tn'], 4)
        self.assertEqual(sc.overlap(~blank, ~blank, blank, .04)['valid_pixels'], 0)

    def test_preserve_existing_outputs(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(FileExistsError):
                sc.new_directory(temp)

    def test_checksum_change_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'data.json'
            path.write_text('{}')
            expected = sc.sha(path)
            path.write_text('{"changed":true}')
            with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
                sc.checked(path, expected)

    def test_source_identity_and_crs_checked(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'perimeter.json'
            data = {'spatialReference': {'wkid': 3857}, 'features': []}
            path.write_text(json.dumps(data))
            cfg = {'schema_version': 'firewatch.research.satellite-case.v1',
                   'snapshot_sha256': sc.sha(path)}
            with self.assertRaisesRegex(ValueError, 'WGS84'):
                sc.case_grid(cfg, path)


if __name__ == '__main__':
    unittest.main()
