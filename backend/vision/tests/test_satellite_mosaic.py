"""Synthetic geometry/quality fixtures, not observational validation."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
try:
    import satellite_mosaic as sm
except ModuleNotFoundError as exc:
    if exc.name in ('rasterio','shapely'):
        raise unittest.SkipTest('Install requirements-satellite.txt') from exc
    raise
import numpy as np
from shapely.geometry import box, mapping


def tile(name, bounds, datatake='one', when='2026-02-01T12:00:00Z'):
    return {'id':name,'collection':'sentinel','geometry':mapping(box(*bounds)),
            'properties':{'platform':'sentinel-2a','s2:datatake_id':datatake,
                          'datetime':when,'proj:epsg':32613,'eo:cloud_cover':0},
            'assets':{b:{} for b in sm.sc.BANDS}}


class MosaicTests(unittest.TestCase):
    def setUp(self):
        self.cfg={'collection':'sentinel','pre_window':['2026-02-01T00:00:00Z','2026-02-02T00:00:00Z'],
                  'epsg':32613,'max_scene_cloud_percent':60,'max_candidates_per_window':4}
        self.grid={'aoi_wgs84':mapping(box(0,0,2,1))}
        self.items=[tile('left',(0,0,1,1)),tile('right',(1,0,2,1),when='2026-02-01T12:00:02Z')]

    def test_complete_same_overpass_retains_times(self):
        groups=sm.group_items(self.items,self.cfg,self.grid,'pre')
        self.assertEqual(len(groups),1)
        self.assertEqual(groups[0]['members'],['left','right'])
        self.assertEqual(groups[0]['time_end_utc'],'2026-02-01T12:00:02Z')

    def test_incomplete_union_rejected(self):
        self.assertEqual(sm.group_items(self.items[:1],self.cfg,self.grid,'pre'),[])

    def test_different_datatakes_never_combined(self):
        self.items[1]['properties']['s2:datatake_id']='two'
        self.assertEqual(sm.group_items(self.items,self.cfg,self.grid,'pre'),[])

    def test_different_platforms_never_combined(self):
        self.items[1]['properties']['platform']='sentinel-2b'
        self.assertEqual(sm.group_items(self.items,self.cfg,self.grid,'pre'),[])

    def test_capture_span_capped(self):
        self.items[1]['properties']['datetime']='2026-02-01T12:05:01Z'
        self.assertEqual(sm.group_items(self.items,self.cfg,self.grid,'pre'),[])

    def test_cloudy_required_tile_rejects_group(self):
        self.items[1]['properties']['eo:cloud_cover']=61
        self.assertEqual(sm.group_items(self.items,self.cfg,self.grid,'pre'),[])

    def test_first_usable_choice_and_unknown(self):
        first=np.array([[0,8,5,9,0]],dtype=np.uint8)
        second=np.array([[4,4,6,10,0]],dtype=np.uint8)
        scl,choice=sm.mosaic_scl([first,second],[4,5,6])
        np.testing.assert_array_equal(scl,[[4,4,5,9,0]])
        np.testing.assert_array_equal(choice,[[1,1,0,0,-1]])

    def test_single_tile_identity(self):
        src=np.array([[0,4,5,6,8,10]],dtype=np.uint8)
        scl,_=sm.mosaic_scl([src],[4,5,6])
        np.testing.assert_array_equal(scl,src)

    def test_shape_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            sm.mosaic_scl([np.zeros((2,2)),np.zeros((1,2))],[4,5,6])


if __name__=='__main__': unittest.main()
