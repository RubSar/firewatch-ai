"""Check design-package consistency; not a running-system or complete JSON Schema test."""
import copy
import datetime
import json
import math
from pathlib import Path
import re
import unittest
from capacity import calculate
ROOT=Path(__file__).resolve().parent
def read(path):return json.loads((ROOT/path).read_text(encoding='utf-8'))

def validate_subset(value,schema,path='$'):
    """Validate precisely the keyword subset used by the four bundled schemas."""
    known={'$schema','$id','type','properties','required','additionalProperties','items','maxItems','minItems',
           'minLength','maxLength','minimum','maximum','enum','const','pattern','format','anyOf'}
    extra=set(schema)-known
    if extra:raise ValueError('Unsupported schema keywords: '+str(extra))
    if 'anyOf' in schema:
        errors=[]
        for branch in schema['anyOf']:
            try:validate_subset(value,branch,path);return
            except ValueError as e:errors.append(str(e))
        raise ValueError(path+': no anyOf branch matched')
    types=schema.get('type');types=[types] if isinstance(types,str) else types
    def matches(t):
        return {'null':value is None,'object':isinstance(value,dict),'array':isinstance(value,list),
                'string':isinstance(value,str),'boolean':isinstance(value,bool),
                'integer':isinstance(value,int) and not isinstance(value,bool),
                'number':isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)}[t]
    if types and not any(matches(t) for t in types):raise ValueError(path+': wrong type')
    if 'const' in schema and value!=schema['const']:raise ValueError(path+': wrong constant')
    if 'enum' in schema and value not in schema['enum']:raise ValueError(path+': wrong enum')
    if isinstance(value,dict):
        if any(k not in value for k in schema.get('required',[])):raise ValueError(path+': missing required field')
        props=schema.get('properties',{})
        if schema.get('additionalProperties') is False and set(value)-set(props):raise ValueError(path+': unexpected field')
        for k,v in value.items():
            if k in props:validate_subset(v,props[k],path+'.'+k)
    if isinstance(value,list):
        if len(value)>schema.get('maxItems',float('inf')) or len(value)<schema.get('minItems',0):raise ValueError(path+': array length')
        for i,v in enumerate(value):validate_subset(v,schema.get('items',{}),path+f'[{i}]')
    if isinstance(value,str):
        if len(value)<schema.get('minLength',0) or len(value)>schema.get('maxLength',float('inf')):raise ValueError(path+': string length')
        if 'pattern' in schema and re.search(schema['pattern'],value) is None:raise ValueError(path+': pattern')
        if schema.get('format')=='date-time':
            try:
                stamp=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
                if stamp.tzinfo is None:raise ValueError()
            except ValueError:raise ValueError(path+': timestamp must include timezone')
    if isinstance(value,(int,float)) and not isinstance(value,bool):
        if not math.isfinite(value) or value<schema.get('minimum',-math.inf) or value>schema.get('maximum',math.inf):raise ValueError(path+': numeric bounds')

class SpecificationTests(unittest.TestCase):
    def test_service_identifiers_unique(self):
        services=read('service-catalog.json');self.assertEqual(len(services),23)
        self.assertEqual(len({s['id'] for s in services}),len(services))
        for s in services:
            for key in ('interfaces','state','scaling','failure_policy','acceptance','requirements'):self.assertTrue(s[key])
    def test_topic_references_and_producers(self):
        services=read('service-catalog.json');topics=read('topics.json');names={t['logical_name'] for t in topics};ids={s['id'] for s in services}
        self.assertEqual(len(names),len(topics))
        for s in services:self.assertTrue(set(s['inputs']+s['outputs'])<=names)
        for t in topics:
            if t['producer']!='ALL':self.assertTrue(set(t['producer'].split(','))<=ids)
            self.assertTrue(set(t['consumers'])<=ids)
            self.assertGreater(t['initial_partitions'],0)
    def test_all_example_schemas(self):
        files=list((ROOT/'contracts').glob('*.example.json'));self.assertEqual(len(files),4)
        for p in files:
            schema=read('contracts/'+p.name.replace('.example.','.schema.'))
            validate_subset(json.loads(p.read_text()),schema)
    def test_missing_identity_rejected(self):
        x=read('contracts/frame.ready.example.json');del x['tenant_id']
        with self.assertRaises(ValueError):validate_subset(x,read('contracts/frame.ready.schema.json'))
    def test_negative_sequence_rejected(self):
        x=read('contracts/frame.ready.example.json');x['source_sequence']=-1
        with self.assertRaises(ValueError):validate_subset(x,read('contracts/frame.ready.schema.json'))
    def test_wrong_event_type_rejected(self):
        x=read('contracts/frame.ready.example.json');x['event_type']='incident.changed'
        with self.assertRaises(ValueError):validate_subset(x,read('contracts/frame.ready.schema.json'))
    def test_naive_clock_rejected(self):
        x=read('contracts/frame.ready.example.json');x['received_at']='2026-09-26T12:00:00'
        with self.assertRaises(ValueError):validate_subset(x,read('contracts/frame.ready.schema.json'))
    def test_invalid_temperature_type_rejected(self):
        x=read('contracts/grid.updated.example.json');x['payload']['cells'][0]['temperature_c']['max']='hot'
        with self.assertRaises(ValueError):validate_subset(x,read('contracts/grid.updated.schema.json'))
    def test_out_of_range_coverage_rejected(self):
        x=read('contracts/grid.updated.example.json');x['payload']['cells'][0]['coverage_fraction']=1.1
        with self.assertRaises(ValueError):validate_subset(x,read('contracts/grid.updated.schema.json'))
    def test_nan_rejected(self):
        x=read('contracts/grid.updated.example.json');x['payload']['cells'][0]['temperature_c']['max']=float('nan')
        with self.assertRaises(ValueError):validate_subset(x,read('contracts/grid.updated.schema.json'))
    def test_capacity_scales_linearly_for_bytes(self):
        a=read('capacity-assumptions.json');x=calculate(a,10);y=calculate(a,100)
        self.assertAlmostEqual(y['original_data_tb_for_retention'],10*x['original_data_tb_for_retention'])
        self.assertAlmostEqual(y['thermal_payload_mbps_per_drone'],26.2144)
    def test_zone_survival_capacity(self):
        a=read('capacity-assumptions.json');x=calculate(a,100)
        rate=x['hypothetical_fire_gpus_per_zone_with_failure_reserve']*(a['zones']-1)*a['hypothetical_fire_requests_per_gpu_second']*a['target_utilization']
        self.assertGreaterEqual(rate,x['fire_inference_requests_per_second'])
    def test_markdown_local_links_resolve(self):
        for path in ROOT.rglob('*.md'):
            for target in re.findall(r'\]\(([^)]+)\)',path.read_text(encoding='utf-8')):
                if '://' not in target and not target.startswith('#'):
                    self.assertTrue((path.parent/target.split('#')[0]).exists(),f'{path.name}: {target}')

if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(SpecificationTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    (ROOT/'validation-results.json').write_text(json.dumps({'scope':'design_package_only_not_runtime_infrastructure',
       'tests_run':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),
       'schema_validation':'bundled_keyword_subset; not a full standards conformance test',
       'passed':result.wasSuccessful()},indent=2)+'\n')
    raise SystemExit(0 if result.wasSuccessful() else 1)
