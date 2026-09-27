"""Audit a checksummed, publisher-curated IR perimeter subset without scoring.

No source scripts are imported, no geometry is repaired and no time is inferred
from a filename. Publisher times must explicitly bind every source KML checksum.
"""
import argparse
from datetime import datetime,timezone
import hashlib
import json
import math
from pathlib import Path
from xml.etree import ElementTree as ET

import shapely
from shapely.geometry import Polygon,mapping,shape
from shapely.ops import unary_union
from shapely.validation import explain_validity
from rasterio.warp import transform_geom

NS={'k':'http://www.opengis.net/kml/2.2'}


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_json(path): return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path,data):
    Path(path).write_text(json.dumps(data,indent=2,allow_nan=False)+'\n',encoding='utf-8')


def utc(value):
    parsed=datetime.fromisoformat(value)
    if parsed.tzinfo is None: raise ValueError('Explicit timezone required')
    return parsed.astimezone(timezone.utc)


def safe_file(root,relative):
    root=Path(root).resolve();path=(root/relative).resolve()
    if not path.is_relative_to(root) or path==root:raise ValueError('Source path escapes dataset')
    return path


def ring(element):
    if element is None or not element.text:raise ValueError('Missing coordinate ring')
    result=[]
    for token in element.text.split():
        values=list(map(float,token.split(',')))
        if len(values) not in (2,3) or not all(math.isfinite(v) for v in values):
            raise ValueError('Invalid coordinate tuple')
        lon,lat=values[:2]
        if not -180<=lon<=180 or not -90<=lat<=90:raise ValueError('Outside WGS84 bounds')
        result.append((lon,lat))
    if len(result)<4 or result[0]!=result[-1]:raise ValueError('Ring must be explicitly closed')
    return result


def read_kml(path):
    body=Path(path).read_bytes()
    if len(body)>2_000_000:raise ValueError('KML exceeds bounded size')
    if b'<!DOCTYPE' in body.upper() or b'<!ENTITY' in body.upper():raise ValueError('DTD/entities not allowed')
    root=ET.fromstring(body)
    if root.findall('.//k:NetworkLink',NS):raise ValueError('External KML links not allowed')
    polygons=[]
    for index,element in enumerate(root.findall('.//k:Polygon',NS)):
        outer=ring(element.find('k:outerBoundaryIs/k:LinearRing/k:coordinates',NS))
        holes=[ring(e) for e in element.findall('k:innerBoundaryIs/k:LinearRing/k:coordinates',NS)]
        polygon=Polygon(outer,holes)
        if polygon.is_empty or not polygon.is_valid or polygon.area<=0:
            raise ValueError(f'Invalid source polygon {index}: {explain_validity(polygon)}; no repair')
        polygons.append(polygon)
    if not polygons:raise ValueError('No polygon geometry')
    geometry=unary_union(polygons) # set union of valid parts; not buffer(0)/make_valid
    if geometry.is_empty or not geometry.is_valid or geometry.geom_type not in ('Polygon','MultiPolygon'):
        raise ValueError('Invalid combined perimeter')
    return geometry,len(polygons)


def audit(folder,registry_path,output):
    root=Path(folder);registry=read_json(registry_path);manifest=read_json(root/'source-manifest.json')
    if sha(root/'source-manifest.json')!=registry['source_manifest_sha256']:
        raise ValueError('Source manifest mismatch')
    if registry['source_record_id']!=manifest['source_record_id']:raise ValueError('Publisher release mismatch')
    expected={x['path']:x for x in manifest['files']}
    if len(expected)!=len(manifest['files']):raise ValueError('Duplicate source file')
    kmllist={x for x in expected if x.endswith('.kml')}
    rows=registry['perimeters'];paths=[r['path'] for r in rows]
    if len(paths)!=len(set(paths)) or set(paths)!=kmllist:raise ValueError('Registry must bind each KML exactly once')
    for name,meta in expected.items():
        if sha(safe_file(root,name))!=meta['sha256']:raise ValueError('Source bytes changed: '+name)
    times=[utc(r['publisher_time']) for r in rows]
    if len(times)!=len(set(times)):raise ValueError('Duplicate capture UTC requires review')
    out=Path(output)
    if out.exists():raise FileExistsError(out)
    out.mkdir(parents=True)
    features=[];records=[];projected=[]
    for row in sorted(rows,key=lambda r:utc(r['publisher_time'])):
        if row['sha256']!=expected[row['path']]['sha256']:raise ValueError('Registry KML hash mismatch')
        when=utc(row['publisher_time']).isoformat().replace('+00:00','Z')
        record={'source_path':row['path'],'source_sha256':row['sha256'],'publisher_time':row['publisher_time'],
                'capture_time_utc':when,'timestamp_basis':registry['timestamp_basis'],
                'original_flight_report_verified':False,'geometry_valid':False}
        try:
            geometry,count=read_kml(safe_file(root,row['path']))
            metric=shape(transform_geom('EPSG:4326','EPSG:5070',mapping(geometry)))
            if not metric.is_valid:raise ValueError('Invalid projected geometry')
            record.update(geometry_valid=True,source_polygon_count=count,area_ha=metric.area/10000,
                          bbox_wgs84=list(geometry.bounds),geometry_sha256=hashlib.sha256(shapely.to_wkb(shapely.normalize(geometry))).hexdigest())
            features.append({'type':'Feature','properties':record.copy(),'geometry':mapping(geometry)})
            projected.append((when,metric))
        except (ValueError,ET.ParseError) as error:
            record['geometry_error']=str(error)
        records.append(record)
    changes=[]
    for (start,a),(end,b) in zip(projected,projected[1:]):
        changes.append({'from_utc':start,'to_utc':end,'elapsed_hours':(utc(end)-utc(start)).total_seconds()/3600,
                        'added_ha':b.difference(a).area/10000,'removed_ha':a.difference(b).area/10000,
                        'stable_intersection_ha':a.intersection(b).area/10000,
                        'interpretation':'Endpoint geometry differences; neither fire spread rate nor intermediate-time ground truth.'})
    write_json(out/'perimeters.geojson',{'type':'FeatureCollection','features':features})
    report={'schema_version':'firewatch.research.ir-reference-audit.v1',
            'created_at_utc':datetime.now(timezone.utc).isoformat(),'incident_id':registry['incident_id'],
            'source_record_id':registry['source_record_id'],'source_doi':manifest['source_doi'],
            'perimeters':records,'endpoint_changes':changes,
            'counts':{'source_perimeters':len(rows),'valid_geometries':len(features),
                      'original_flight_reports_verified':0,'independent_incidents':1},
            'reference_sensor_lineage':'Publisher states NIROPS aerial infrared interpreted by humans; independent sensor modality from Sentinel-2 NBR.',
            'time_matched_validation_allowed':False,'validation_metrics':None,
            'remaining_gaps':['Original flight reports not acquired; UTCs are publisher-curated.',
                              'IR extent is not an exhaustive burned/unburned pixel label or an active-flame mask.',
                              'No satellite capture/visibility match accepted by this audit.',
                              'One incident cannot establish cross-incident generalization.'],
            'input_sha256':{'manifest':sha(root/'source-manifest.json'),'registry':sha(registry_path),'code':sha(__file__)},
            'geometry_output_sha256':sha(out/'perimeters.geojson')}
    write_json(out/'report.json',report)
    print(json.dumps(report['counts'],indent=2))
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('source_folder');p.add_argument('registry');p.add_argument('--output',required=True)
    a=p.parse_args();audit(a.source_folder,a.registry,a.output)


if __name__=='__main__':main()
