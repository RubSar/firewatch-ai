"""Read-only temporal/spatial candidate screening; no pixels or accuracy scores."""
import argparse
from datetime import datetime,timezone
from pathlib import Path

from shapely.geometry import shape
from shapely.ops import unary_union
from audit_ir_reference import read_json,write_json,sha,utc


def groups(catalog,policy):
    if catalog.get('numberMatched',catalog.get('context',{}).get('matched'))!=len(catalog['features']):
        raise ValueError('Incomplete STAC search; no silent truncation')
    ids=set();collected={};excluded=[]
    for item in catalog['features']:
        if item['id'] in ids:raise ValueError('Duplicate scene ID')
        ids.add(item['id']);p=item['properties'];when=utc(p['datetime'])
        if (item['collection']!=policy['collection'] or not utc(policy['window'][0])<=when<=utc(policy['window'][1])
                or p.get('eo:cloud_cover',100)>policy['max_tile_cloud_percent'] or not p.get('s2:datatake_id')
                or not p.get('platform')):
            excluded.append(item['id']);continue
        collected.setdefault((p['platform'],p['s2:datatake_id']),[]).append(item)
    result=[]
    for (platform,datatake),members in collected.items():
        members.sort(key=lambda x:x['id'])
        times=[utc(x['properties']['datetime']) for x in members]
        if (max(times)-min(times)).total_seconds()>policy['max_group_span_seconds']:
            excluded.extend(x['id'] for x in members);continue
        footprints=[shape(x['geometry']) for x in members]
        if any(not x.is_valid for x in footprints):raise ValueError('Invalid scene footprint')
        result.append({'platform':platform,'datatake_id':datatake,'members':members,'start':min(times),
                       'end':max(times),'footprint':unary_union(footprints)})
    return sorted(result,key=lambda x:(x['start'],x['datatake_id'])),excluded


def screen(policy_path,audit_path,geometry_path,catalog_path,output):
    policy=read_json(policy_path);audit=read_json(audit_path)
    if sha(audit_path)!=policy['reference_audit_sha256']:raise ValueError('Reference audit changed')
    if sha(geometry_path)!=audit['geometry_output_sha256']:raise ValueError('Reference geometries changed')
    features=read_json(geometry_path)['features']
    catalog=read_json(catalog_path);overpasses,excluded=groups(catalog,policy)
    matches=[]
    for feature in features:
        props=feature['properties'];time=utc(props['capture_time_utc']);geometry=shape(feature['geometry'])
        choices=[]
        for group in overpasses:
            if not group['footprint'].covers(geometry):continue
            # Conservative maximum endpoint gap, not a favorable average tile time.
            gap=max(abs((group['start']-time).total_seconds()),abs((group['end']-time).total_seconds()))/3600
            choices.append((gap,group))
        choices.sort(key=lambda x:(x[0],x[1]['start'],x[1]['datatake_id']))
        nearest=None
        if choices:
            gap,g=choices[0]
            nearest={'max_capture_gap_hours':gap,'start_utc':g['start'].isoformat(),'end_utc':g['end'].isoformat(),
                     'platform':g['platform'],'datatake_id':g['datatake_id'],'scene_ids':[m['id'] for m in g['members']],
                     'passes_temporal_screen':gap<=policy['max_capture_gap_hours']}
        matches.append({'reference_time_utc':props['capture_time_utc'],'source_path':props['source_path'],
                        'nearest_covering_group':nearest,'time_matched_validation_allowed':False})
    sensitivity={str(hours):sum(r['nearest_covering_group'] is not None and r['nearest_covering_group']['max_capture_gap_hours']<=hours for r in matches)
                 for hours in policy['descriptive_gap_hours']}
    result={'schema_version':'firewatch.research.ir-scene-screen.v1','created_at_utc':datetime.now(timezone.utc).isoformat(),
            'incident_id':audit['incident_id'],'policy':policy,'stac_items':len(catalog['features']),
            'eligible_overpass_groups':len(overpasses),'excluded_scene_ids':excluded,'matches':matches,
            'reference_count_by_gap_hours':sensitivity,'time_matched_validation_allowed':False,'validation_metrics':None,
            'notes':['Counts are reference observations, not unique independent fires or evaluation samples.',
                     'Footprint coverage and tile cloud metadata do not verify local visibility or spectral validity.',
                     'Temporal screen is an experiment constraint, not proof of negligible growth between observations.',
                     'No satellite pixels downloaded; no thresholds fitted or held-out results inspected.'],
            'input_sha256':{'policy':sha(policy_path),'audit':sha(audit_path),'catalog':sha(catalog_path),'code':sha(__file__)}}
    out=Path(output)
    if out.exists():raise FileExistsError(out)
    out.parent.mkdir(parents=True,exist_ok=True);write_json(out,result)
    print({'items':len(catalog['features']),'groups':len(overpasses),'counts_by_gap_hours':sensitivity})
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('policy');p.add_argument('audit');p.add_argument('geometry');p.add_argument('catalog');p.add_argument('--output',required=True)
    a=p.parse_args();screen(a.policy,a.audit,a.geometry,a.catalog,a.output)


if __name__=='__main__':main()
