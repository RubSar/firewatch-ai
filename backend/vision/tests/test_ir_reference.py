"""Synthetic provenance/geometry fixtures; not scientific ground truth."""
import copy,json
from pathlib import Path
import sys,tempfile,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
try:
    import audit_ir_reference as ir
    import match_ir_scenes as ms
except ModuleNotFoundError as exc:
    if exc.name in ('shapely','rasterio'):raise unittest.SkipTest('Install requirements-satellite.txt') from exc
    raise
from shapely.geometry import box,mapping


def kml(outer='0,0 2,0 2,2 0,2 0,0',inner=''):
    hole=f'<innerBoundaryIs><LinearRing><coordinates>{inner}</coordinates></LinearRing></innerBoundaryIs>' if inner else ''
    return '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>'+outer+'</coordinates></LinearRing></outerBoundaryIs>'+hole+'</Polygon></Placemark></kml>'


class GeometryTests(unittest.TestCase):
    def parse(self,text):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'fixture.kml';path.write_text(text);return ir.read_kml(path)
    def test_hole_preserved(self):
        geometry,count=self.parse(kml(inner='.5,.5 .5,1.5 1.5,1.5 1.5,.5 .5,.5'))
        self.assertEqual(count,1);self.assertAlmostEqual(geometry.area,3)
    def test_invalid_ring_not_repaired(self):
        with self.assertRaisesRegex(ValueError,'no repair'):self.parse(kml('0,0 2,2 0,2 2,0 0,0'))
    def test_unclosed_ring_rejected(self):
        with self.assertRaisesRegex(ValueError,'closed'):self.parse(kml('0,0 2,0 2,2 0,2'))
    def test_nonfinite_coordinates_rejected(self):
        with self.assertRaises(ValueError):self.parse(kml('0,0 nan,0 2,2 0,2 0,0'))
    def test_external_links_and_entities_rejected(self):
        with self.assertRaises(ValueError):self.parse('<!DOCTYPE kml>'+kml())
        with self.assertRaises(ValueError):self.parse(kml().replace('<Placemark>','<NetworkLink/><Placemark>'))
    def test_timezone_preserved_as_instant(self):
        self.assertEqual(ir.utc('2021-08-26T03:30-06:00').isoformat(),'2021-08-26T09:30:00+00:00')
        self.assertEqual(ir.utc('2021-08-26T02:30-07:00'),ir.utc('2021-08-26T03:30-06:00'))
        with self.assertRaises(ValueError):ir.utc('2021-08-26T03:30')
    def test_path_escape_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):ir.safe_file(d,'../outside.kml')


class AuditTests(unittest.TestCase):
    def fixture(self,folder):
        source=folder/'source';source.mkdir();(source/'one.kml').write_text(kml('-121,38 -120.9,38 -120.9,38.1 -121,38.1 -121,38'))
        manifest={'source_record_id':1,'source_doi':'synthetic','files':[{'path':'one.kml','sha256':ir.sha(source/'one.kml')}]}
        ir.write_json(source/'source-manifest.json',manifest)
        registry={'incident_id':'synthetic','source_record_id':1,'source_manifest_sha256':ir.sha(source/'source-manifest.json'),
                  'timestamp_basis':'synthetic fixture','perimeters':[{'path':'one.kml','sha256':manifest['files'][0]['sha256'],'publisher_time':'2021-08-01T03:00Z'}]}
        ir.write_json(folder/'registry.json',registry);return source,registry
    def test_valid_input_never_auto_certifies_reference(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source,_=self.fixture(root)
            report=ir.audit(source,root/'registry.json',root/'output')
            self.assertEqual(report['counts']['valid_geometries'],1)
            self.assertFalse(report['time_matched_validation_allowed']);self.assertIsNone(report['validation_metrics'])
    def test_source_tampering_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source,_=self.fixture(root);(source/'one.kml').write_text(kml())
            with self.assertRaisesRegex(ValueError,'bytes changed'):ir.audit(source,root/'registry.json',root/'output')
    def test_missing_registry_record_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source,registry=self.fixture(root);registry['perimeters']=[];ir.write_json(root/'registry.json',registry)
            with self.assertRaisesRegex(ValueError,'exactly once'):ir.audit(source,root/'registry.json',root/'output')


def item(name,bounds=(0,0,2,2),time='2021-08-01T10:00Z',datatake='one'):
    return {'id':name,'collection':'sentinel','geometry':mapping(box(*bounds)),
            'properties':{'datetime':time,'platform':'sentinel-2a','s2:datatake_id':datatake,'eo:cloud_cover':0}}


def policy():
    return {'collection':'sentinel','window':['2021-08-01T00:00Z','2021-08-02T00:00Z'],
            'max_tile_cloud_percent':60,'max_group_span_seconds':300,'max_capture_gap_hours':6,
            'descriptive_gap_hours':[6,12]}


class TimingTests(unittest.TestCase):
    def test_truncated_catalogue_rejected(self):
        with self.assertRaisesRegex(ValueError,'Incomplete'):ms.groups({'features':[],'numberMatched':1},policy())
    def test_different_datatakes_never_combined(self):
        groups,_=ms.groups({'features':[item('a',datatake='one'),item('b',datatake='two')],'numberMatched':2},policy())
        self.assertEqual(len(groups),2)
    def test_excessive_capture_span_rejected(self):
        groups,excluded=ms.groups({'features':[item('a'),item('b',time='2021-08-01T10:06Z')],'numberMatched':2},policy())
        self.assertEqual(groups,[]);self.assertEqual(len(excluded),2)
    def test_duplicate_scene_rejected(self):
        with self.assertRaisesRegex(ValueError,'Duplicate'):ms.groups({'features':[item('a'),item('a')],'numberMatched':2},policy())
    def test_max_member_gap_not_midpoint_and_coverage_required(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);p=policy()
            geometry={'type':'FeatureCollection','features':[{'type':'Feature','geometry':mapping(box(0,0,2,2)),
                       'properties':{'capture_time_utc':'2021-08-01T04:00Z','source_path':'fixture.kml'}}]}
            ir.write_json(root/'geometry.json',geometry)
            audit={'incident_id':'synthetic','geometry_output_sha256':ir.sha(root/'geometry.json')}
            ir.write_json(root/'audit.json',audit);p['reference_audit_sha256']=ir.sha(root/'audit.json');ir.write_json(root/'policy.json',p)
            scenes=[item('a',(0,0,1,2),'2021-08-01T09:59Z'),item('b',(1,0,2,2),'2021-08-01T10:01Z')]
            ir.write_json(root/'catalog.json',{'features':scenes,'numberMatched':2})
            r=ms.screen(root/'policy.json',root/'audit.json',root/'geometry.json',root/'catalog.json',root/'result.json')
            self.assertEqual(r['reference_count_by_gap_hours']['6'],0)
            self.assertGreater(r['matches'][0]['nearest_covering_group']['max_capture_gap_hours'],6)
            self.assertFalse(r['time_matched_validation_allowed'])
            scenes.pop();ir.write_json(root/'catalog.json',{'features':scenes,'numberMatched':1})
            r=ms.screen(root/'policy.json',root/'audit.json',root/'geometry.json',root/'catalog.json',root/'partial.json')
            self.assertIsNone(r['matches'][0]['nearest_covering_group'])


if __name__=='__main__':unittest.main()
