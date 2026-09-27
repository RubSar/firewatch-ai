"""Audit dated geometry histories and freeze a metadata-only transfer cohort.

No network, threshold optimization, time certification or training occurs here.
Input ArcGIS snapshots and their request provenance must be retained by the caller.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import tempfile

import shapely
import satellite_case as sc

CYPRESS_ID='8432b888-2a01-4825-8eb6-c74589de24fc'
DAY_MS=86400000


def uuid(value):
    import uuid as uuid_module
    return str(uuid_module.UUID(str(value).strip('{}')))


def candidate_id(attributes):
    try:
        return uuid(attributes.get('attr_IrwinID'))
    except ValueError:
        return None


def epoch(iso):
    dt=datetime.fromisoformat(iso)
    if dt.tzinfo is None:
        raise ValueError('UTC timezone required')
    return dt.timestamp()*1000


def iso(value):
    return datetime.fromtimestamp(value/1000,timezone.utc).isoformat().replace('+00:00','Z')


def response(path):
    data=sc.read_json(path)
    if data.get('error') or data.get('exceededTransferLimit'):
        raise ValueError('Failed/truncated source response')
    if data.get('spatialReference',{}).get('wkid')!=4326:
        raise ValueError('WGS84 response required')
    if not isinstance(data.get('features'),list):
        raise ValueError('Missing features')
    return data


def geometry_hash(geometry):
    return hashlib.sha256(shapely.to_wkb(shapely.normalize(geometry))).hexdigest()


def audit_history(daily_path, expected_id, original_path, output):
    daily=response(daily_path)
    original=response(original_path)
    if len(original['features'])!=1:
        raise ValueError('Expected one original reference')
    original_feature=original['features'][0]
    if uuid(original_feature['attributes']['poly_IRWINID'])!=expected_id:
        raise ValueError('Original incident ID mismatch')
    original_geometry=sc.perimeter_geometry(original_feature['geometry']['rings'])
    rows=[]
    periods=[]
    for feature in daily['features']:
        a=feature['attributes']
        if uuid(a['poly_IRWINID'])!=expected_id:
            raise ValueError('Mixed incident IDs in history')
        period=a.get('BurnPeriod')
        if not isinstance(period,int) or period<=0:
            raise ValueError('Missing/invalid geometry order')
        periods.append(period)
        geometry_error=None
        try:
            geometry=sc.perimeter_geometry(feature['geometry']['rings'])
        except ValueError as error:
            geometry=None
            geometry_error=str(error)
        rows.append({'burn_period':period,'object_id':a.get('OBJECTID'),
                     'polygon_datetime_utc':sc.epoch_iso(a.get('poly_PolygonDateTime')),
                     'date_current_utc':sc.epoch_iso(a.get('poly_DateCurrent')),
                     'create_date_utc':sc.epoch_iso(a.get('poly_CreateDate')),
                     'reported_gis_acres':a.get('poly_GISAcres'),'map_method':a.get('poly_MapMethod'),
                     'geometry_sha256_normalized_wgs84_wkb':geometry_hash(geometry) if geometry is not None else None,
                     'source_rings_sha256':hashlib.sha256(json.dumps(feature['geometry']['rings'],separators=(',',':')).encode()).hexdigest(),
                     'geometry_error':geometry_error,
                     'equals_original_geometry':geometry.equals(original_geometry) if geometry is not None else None})
    if len(periods)!=len(set(periods)):
        raise ValueError('Duplicate geometry order requires source review')
    rows.sort(key=lambda r:r['burn_period'])
    groups=defaultdict(list)
    for row in rows:
        if row['polygon_datetime_utc']:
            groups[row['polygon_datetime_utc']].append(row)
    reused=[{'polygon_datetime_utc':key,'burn_periods':[r['burn_period'] for r in values],
             'distinct_valid_geometries':len({r['geometry_sha256_normalized_wgs84_wkb'] for r in values if r['geometry_sha256_normalized_wgs84_wkb']})}
            for key,values in groups.items() if len({r['geometry_sha256_normalized_wgs84_wkb'] for r in values if r['geometry_sha256_normalized_wgs84_wkb']})>1]
    decreases=[]
    for a,b in zip(rows,rows[1:]):
        if a['reported_gis_acres'] is not None and b['reported_gis_acres'] is not None and b['reported_gis_acres']<a['reported_gis_acres']:
            decreases.append({'from_burn_period':a['burn_period'],'to_burn_period':b['burn_period'],
                              'change_acres':b['reported_gis_acres']-a['reported_gis_acres']})
    report={'schema_version':'firewatch.research.perimeter-audit.v1','incident_id':expected_id,
            'created_at_utc':sc.utc_now(),'records':rows,'missing_polygon_times':sum(r['polygon_datetime_utc'] is None for r in rows),
            'reused_timestamps_for_distinct_geometries':reused,'area_decreases':decreases,
            'invalid_geometry_records':sum(r['geometry_error'] is not None for r in rows),
            'reference_time_verified':False,'official_progression':False,
            'interpretation':'BurnPeriod orders captured geometry changes, not elapsed time. Missing/reused timestamps and mapping revisions must not be turned into observed spread rates.',
            'input_sha256':{'daily_response':sc.sha(daily_path),'original_response':sc.sha(original_path),'audit_code':sc.sha(__file__)}}
    path=Path(output)
    if path.exists(): raise FileExistsError(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    sc.write_json(path,report)
    return report


def distance_km(a,b):
    # Haversine on mean-radius sphere; only a conservative 100 km screening rule.
    lon1,lat1,lon2,lat2=map(math.radians,(*a,*b))
    h=math.sin((lat2-lat1)/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 6371.0088*2*math.asin(min(1,math.sqrt(h)))


def eligibility(a,policy):
    reasons=[]
    if a.get('attr_IncidentTypeCategory')!='WF': reasons.append('not_wildfire')
    if a.get('attr_IsCpxChild') not in (0,False): reasons.append('complex_child_or_unknown')
    if a.get('attr_CpxID'): reasons.append('complex_membership')
    start,end,mapped=(a.get(k) for k in ('attr_FireDiscoveryDateTime','attr_ContainmentDateTime','poly_PolygonDateTime'))
    if not start or not end or end<start: reasons.append('missing_or_invalid_incident_times')
    if mapped is None: reasons.append('missing_polygon_timestamp')
    elif start and end and not start<=mapped<=end+policy['post_days']*DAY_MS:
        reasons.append('polygon_timestamp_outside_declared_window')
    if not start or not epoch(policy['candidate_window_utc'][0])<=start<=epoch(policy['candidate_window_utc'][1]):
        reasons.append('outside_discovery_window')
    lon,lat=a.get('attr_InitialLongitude'),a.get('attr_InitialLatitude')
    region=policy['candidate_geography']
    if lon is None or lat is None or not (region['west']<=lon<=region['east'] and region['south']<=lat<=region['north']):
        reasons.append('origin_outside_geography_or_missing')
    acres=a.get('poly_GISAcres')
    if acres is None or not policy['min_reported_polygon_acres']<=acres<=policy['max_reported_polygon_acres']:
        reasons.append('outside_area_range')
    return reasons


def select_cohort(candidate_path,policy_path,base_config_path,cypress_path,output):
    data=response(candidate_path)
    policy=sc.read_json(policy_path)
    base=sc.read_json(base_config_path)
    for key,value in policy['algorithm'].items():
        if base.get(key)!=value: raise ValueError('Frozen algorithm differs: '+key)
    source=response(cypress_path)['features'][0]
    cyp_a=source['attributes']
    origins=[(cyp_a['attr_InitialLongitude'],cyp_a['attr_InitialLatitude'])]
    geometries=[sc.perimeter_geometry(source['geometry']['rings'])]
    counts=Counter(candidate_id(f['attributes']) for f in data['features'])
    ordered=sorted(data['features'],key=lambda f:(f['attributes'].get('attr_FireDiscoveryDateTime') or 0,candidate_id(f['attributes']) or ''))
    out=sc.new_directory(output)
    rows,selected=[],[]
    for feature in ordered:
        a=feature['attributes']; ident=candidate_id(a)
        reasons=eligibility(a,policy)
        if ident is None: reasons.append('missing_or_invalid_incident_uuid')
        if ident==CYPRESS_ID: reasons.append('inspected_cypress_pilot')
        if counts[ident]!=1: reasons.append('duplicate_incident_uuid')
        distances=[]
        geometry=None
        if not reasons:
            try:
                geometry=sc.perimeter_geometry(feature['geometry']['rings'])
                point=(a['attr_InitialLongitude'],a['attr_InitialLatitude'])
                distances=[distance_km(point,p) for p in origins]
                if min(distances)<policy['min_origin_separation_km']: reasons.append('insufficient_origin_separation')
                if any(geometry.intersects(g) for g in geometries): reasons.append('overlapping_incident_geometry')
            except (KeyError,ValueError) as error:
                reasons.append('geometry_invalid: '+str(error))
        config=None
        if not reasons:
            snapshot={'spatialReference':{'wkid':4326},'features':[feature]}
            config=dict(base)
            config.update(case_id=ident+'-transfer-v1',case_name=a['poly_IncidentName'],incident_id=ident,
                          research_role='fixed-rule transfer pilot; not an untouched ML test set',
                          epsg=32600+int((a['attr_InitialLongitude']+180)//6)+1,
                          pre_window=[iso(a['attr_FireDiscoveryDateTime']-policy['pre_days']*DAY_MS),iso(a['attr_FireDiscoveryDateTime']-1000)],
                          post_window=[iso(a['attr_ContainmentDateTime']),iso(a['attr_ContainmentDateTime']+policy['post_days']*DAY_MS)],
                          reference_time_verified=False,
                          reference_time_note='Operational mapped extent; timestamp fields and mapping method do not independently verify observation time or burned-pixel target. Transfer overlap remains exploratory.',
                          threshold_rationale='Unchanged Cypress thresholds frozen before transfer imagery. No post-result tuning or case replacement.')
            with tempfile.TemporaryDirectory() as temp:
                path=Path(temp)/'snapshot.json'; sc.write_json(path,snapshot)
                config['snapshot_sha256']=sc.sha(path)
                try: _,_,grid=sc.case_grid(config,path)
                except ValueError as error: reasons.append('unsupported_grid: '+str(error))
        if not reasons and len(selected)<policy['case_count']:
            folder=out/ident; folder.mkdir()
            sc.write_json(folder/'snapshot.json',snapshot)
            sc.write_json(folder/'config.json',config)
            origins.append(point); geometries.append(geometry)
            selected.append({'incident_id':ident,'name':a['poly_IncidentName'],'state':a.get('attr_POOState'),
                             'folder':ident,'config_sha256':sc.sha(folder/'config.json'),
                             'snapshot_sha256':sc.sha(folder/'snapshot.json'),'origin_distances_km':distances,
                             'grid_pixels':grid['width']*grid['height'],'epsg':config['epsg']})
            status='selected'
        elif not reasons: status='eligible_but_cohort_full'
        else: status='excluded'
        rows.append({'incident_id':ident,'name':a['poly_IncidentName'],'status':status,'reasons':reasons})
    report={'schema_version':'firewatch.research.transfer-selection.v1','created_at_utc':sc.utc_now(),
            'policy':policy,'selected':selected,'candidate_count':len(rows),'audit':rows,
            'selection_complete':len(selected)==policy['case_count'],'imagery_seen_at_selection':False,
            'input_sha256':{'candidates':sc.sha(candidate_path),'policy':sc.sha(policy_path),'base_config':sc.sha(base_config_path),
                            'cypress_snapshot':sc.sha(cypress_path),'selection_code':sc.sha(__file__),'satellite_code':sc.sha(sc.__file__)}}
    sc.write_json(out/'selection.json',report)
    print(json.dumps(selected,indent=2))
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    s=p.add_subparsers(dest='command',required=True)
    a=s.add_parser('audit'); a.add_argument('daily'); a.add_argument('incident_id'); a.add_argument('original'); a.add_argument('--output',required=True)
    c=s.add_parser('select'); c.add_argument('candidates'); c.add_argument('policy'); c.add_argument('base_config'); c.add_argument('cypress_snapshot'); c.add_argument('--output',required=True)
    args=p.parse_args()
    if args.command=='audit': audit_history(args.daily,args.incident_id,args.original,args.output)
    else: select_cohort(args.candidates,args.policy,args.base_config,args.cypress_snapshot,args.output)


if __name__=='__main__': main()
