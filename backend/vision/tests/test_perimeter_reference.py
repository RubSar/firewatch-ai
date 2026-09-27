"""Synthetic audit and cohort-selection fixtures; never observational evidence."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
try:
    import perimeter_reference as pr
except ModuleNotFoundError as exc:
    if exc.name in ('rasterio','shapely'):
        raise unittest.SkipTest('Install requirements-satellite.txt') from exc
    raise


ID1='11111111-1111-4111-8111-111111111111'
ID2='22222222-2222-4222-8222-222222222222'
ID3='33333333-3333-4333-8333-333333333333'
START=pr.epoch('2026-02-01T00:00:00Z')


def feature(ident=ID1,lon=-103,lat=36,period=1,stamp=START+1000,acres=1500):
    ring=[[lon-.02,lat-.02],[lon+.02,lat-.02],[lon+.02,lat+.02],[lon-.02,lat+.02],[lon-.02,lat-.02]]
    return {'attributes':{'OBJECTID':period,'attr_IrwinID':ident,'poly_IRWINID':ident,
            'attr_InitialLongitude':lon,'attr_InitialLatitude':lat,'attr_IncidentTypeCategory':'WF',
            'attr_IsCpxChild':0,'attr_CpxID':None,'poly_GISAcres':acres,'poly_MapMethod':'Mixed Methods',
            'poly_IncidentName':'Synthetic fixture','attr_POOState':'US-XX',
            'attr_FireDiscoveryDateTime':START,'attr_ContainmentDateTime':START+pr.DAY_MS,
            'poly_PolygonDateTime':stamp,'BurnPeriod':period},'geometry':{'rings':[ring]}}


def snapshot(path,features):
    pr.sc.write_json(path,{'spatialReference':{'wkid':4326},'features':features})


def policy():
    return {'candidate_window_utc':['2026-01-01T00:00:00Z','2026-06-30T23:59:59Z'],
            'candidate_geography':{'west':-125,'east':-66,'south':24,'north':50},
            'min_reported_polygon_acres':1200,'max_reported_polygon_acres':10000,
            'pre_days':14,'post_days':15,'case_count':2,'min_origin_separation_km':100,
            'algorithm':{'dnbr_threshold':.1,'pre_nbr_floor':.1}}


class ReferenceAuditTests(unittest.TestCase):
    def test_timestamp_reuse_is_not_progression_time(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); a=feature(period=1,acres=1600); b=feature(period=2,lon=-103.01,acres=1500)
            snapshot(root/'daily.json',[b,a]); snapshot(root/'original.json',[b])
            report=pr.audit_history(root/'daily.json',ID1,root/'original.json',root/'audit.json')
            self.assertEqual(report['reused_timestamps_for_distinct_geometries'][0]['distinct_valid_geometries'],2)
            self.assertEqual(report['area_decreases'][0]['change_acres'],-100)
            self.assertTrue(report['records'][1]['equals_original_geometry'])
            self.assertFalse(report['reference_time_verified'])
            self.assertFalse(report['official_progression'])

    def test_invalid_geometry_is_recorded_without_repair(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); bad=feature(period=2,stamp=None)
            bad['geometry']['rings']=[[[0,0],[2,2],[0,2],[2,0],[0,0]]]
            snapshot(root/'daily.json',[feature(),bad]);snapshot(root/'original.json',[feature()])
            report=pr.audit_history(root/'daily.json',ID1,root/'original.json',root/'audit.json')
            self.assertEqual(report['invalid_geometry_records'],1)
            self.assertEqual(report['missing_polygon_times'],1)
            self.assertIsNone(report['records'][1]['equals_original_geometry'])

    def test_duplicate_geometry_order_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);snapshot(root/'daily.json',[feature(),feature()]);snapshot(root/'original.json',[feature()])
            with self.assertRaisesRegex(ValueError,'Duplicate'):
                pr.audit_history(root/'daily.json',ID1,root/'original.json',root/'audit.json')

    def test_mixed_incident_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);snapshot(root/'daily.json',[feature(ident=ID2)]);snapshot(root/'original.json',[feature()])
            with self.assertRaisesRegex(ValueError,'Mixed incident'):
                pr.audit_history(root/'daily.json',ID1,root/'original.json',root/'audit.json')

    def test_incomplete_query_is_not_an_empty_result(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'response.json'
            for value in [{'error':{'code':500}}, {'exceededTransferLimit':True,'features':[]}]:
                pr.sc.write_json(path,value)
                with self.assertRaises(ValueError): pr.response(path)


class CohortTests(unittest.TestCase):
    def test_distance_and_uuid_screen(self):
        self.assertAlmostEqual(pr.distance_km((0,0),(1,0)),111.195,places=3)
        self.assertEqual(pr.distance_km((-100,35),(-100,35)),0)
        self.assertIsNone(pr.candidate_id({'attr_IrwinID':None}))
        self.assertEqual(pr.candidate_id({'attr_IrwinID':'{'+ID1.upper()+'}'}),ID1)

    def test_missing_and_late_timestamps_rejected(self):
        a=feature()['attributes'];a['poly_PolygonDateTime']=None
        self.assertIn('missing_polygon_timestamp',pr.eligibility(a,policy()))
        a['poly_PolygonDateTime']=START+100*pr.DAY_MS
        self.assertIn('polygon_timestamp_outside_declared_window',pr.eligibility(a,policy()))
        a['attr_ContainmentDateTime']=None
        self.assertIn('missing_or_invalid_incident_times',pr.eligibility(a,policy()))

    def test_complex_and_region_exclusions(self):
        a=feature()['attributes'];a['attr_IsCpxChild']=1;a['attr_InitialLongitude']=-140
        reasons=pr.eligibility(a,policy())
        self.assertIn('complex_child_or_unknown',reasons)
        self.assertIn('origin_outside_geography_or_missing',reasons)

    def prepare(self,root,features):
        snapshot(root/'candidates.json',features)
        snapshot(root/'cypress.json',[feature(ident=pr.CYPRESS_ID,lon=-94.35,lat=31.05)])
        pr.sc.write_json(root/'policy.json',policy())
        base={'schema_version':'firewatch.research.satellite-case.v1','resolution_m':20,
              'buffer_m':1000,'max_pixels':400000,'dnbr_threshold':.1,'pre_nbr_floor':.1}
        pr.sc.write_json(root/'base.json',base)

    def test_deterministic_selection_and_duplicate_exclusion(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            self.prepare(root,[feature(ID3,lon=-112,lat=40),feature(ID1),feature(ID1),feature(ID2,lon=-108,lat=39)])
            result=pr.select_cohort(root/'candidates.json',root/'policy.json',root/'base.json',root/'cypress.json',root/'out')
            self.assertEqual([r['incident_id'] for r in result['selected']],[ID2,ID3])
            self.assertTrue(result['selection_complete'])
            self.assertFalse(result['imagery_seen_at_selection'])
            self.assertIn('duplicate_incident_uuid',result['audit'][0]['reasons'])
            for row in result['selected']:
                cfg=pr.sc.read_json(root/'out'/row['folder']/'config.json')
                self.assertFalse(cfg['reference_time_verified'])
                self.assertEqual(cfg['dnbr_threshold'],.1)
            with self.assertRaises(FileExistsError):
                pr.select_cohort(root/'candidates.json',root/'policy.json',root/'base.json',root/'cypress.json',root/'out')

    def test_algorithm_cannot_change_during_selection(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);self.prepare(root,[feature()])
            cfg=pr.sc.read_json(root/'base.json');cfg['dnbr_threshold']=.2;pr.sc.write_json(root/'base.json',cfg)
            with self.assertRaisesRegex(ValueError,'Frozen algorithm'):
                pr.select_cohort(root/'candidates.json',root/'policy.json',root/'base.json',root/'cypress.json',root/'out')

    def test_nearby_case_not_counted_as_independent(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);self.prepare(root,[feature(ID1),feature(ID2,lon=-103.02,lat=36.02)])
            result=pr.select_cohort(root/'candidates.json',root/'policy.json',root/'base.json',root/'cypress.json',root/'out')
            self.assertEqual(len(result['selected']),1)
            self.assertFalse(result['selection_complete'])
            self.assertIn('insufficient_origin_separation',result['audit'][1]['reasons'])


if __name__=='__main__': unittest.main()
