import ast,json,hashlib
from pathlib import Path
from datetime import datetime,timezone

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
source=Path('discovery/c001_caldor_config.py')
tree=ast.parse(source.read_text())
times=None
for node in tree.body:
    if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='PERIMETER_TIMES' for t in node.targets):
        times=ast.literal_eval(node.value)
assert isinstance(times,list) and len(times)==21
folder=Path('data/caldor-ir-v2026.2');manifest=json.loads((folder/'source-manifest.json').read_text())
kmldata={x['path']:x for x in manifest['files'] if x['path'].endswith('.kml')}
rows=[]
for time in times:
    path='kml/Caldor_'+time.replace('-','_').replace(':','_')+'.kml'
    assert path in kmldata
    rows.append({'path':path,'publisher_time':time,'sha256':kmldata[path]['sha256']})
record={'schema_version':'firewatch.research.ir-reference-registry.v1','created_at_utc':datetime.now(timezone.utc).isoformat(),
        'incident_id':'CA-ENF-024030-2021-Caldor','split':'reference-development','source_record_id':20279621,
        'source_manifest_sha256':sha(folder/'source-manifest.json'),
        'timestamp_basis':'Explicit timezone-bearing PERIMETER_TIMES list in pinned FireBench configuration; publisher documents extraction from Imagery Date/Time in NIROPS reports. Original reports unavailable to this run.',
        'timestamp_source':{'url':'https://github.com/wirc-sjsu/firebench/blob/82c233cff702699335c6b8e88fb79596b98775de/src/firebench/benchmarks/c001_caldor_config.py',
                            'sha256':sha(source),'commit':'82c233cff702699335c6b8e88fb79596b98775de',
                            'read_method':'Python AST literal only, external code never imported or executed'},
        'perimeters':rows,'original_flight_reports_verified':False,
        'prior_development_incidents':['8432b888-2a01-4825-8eb6-c74589de24fc','d05cf942-a3e3-425d-bfe1-0c994ec8956a','84284851-f0f8-4253-b5bc-da7771e0150d']}
Path('timestamp-registry.json').write_text(json.dumps(record,indent=2)+'\n')
