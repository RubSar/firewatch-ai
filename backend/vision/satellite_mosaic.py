"""Same-datatake Sentinel-2 tile mosaics for a fixed dated case.

Acquisition support only: NBR, dNBR, thresholds, AOI and cloud policy are unchanged.
Tile priority is lexical ID, choosing a usable SCL cell before looking at spectra.
"""
import argparse
from datetime import datetime
import json
from pathlib import Path
from urllib.parse import urlencode,urlparse

import numpy as np
import rasterio
from rasterio.windows import Window
from shapely.ops import unary_union

import satellite_case as sc


def group_items(items,cfg,grid,phase):
    groups={}
    aoi=sc.shape(grid['aoi_wgs84'])
    start,end=map(datetime.fromisoformat,cfg[phase+'_window'])
    for item in items:
        p=item['properties']
        when=datetime.fromisoformat(p['datetime'])
        if (item['collection']!=cfg['collection'] or not start<=when<=end
                or p.get('eo:cloud_cover',100)>cfg['max_scene_cloud_percent']
                or p.get('proj:epsg')!=cfg['epsg'] or not all(b in item['assets'] for b in sc.BANDS)
                or not sc.shape(item['geometry']).intersects(aoi)):
            continue
        datatake=p.get('s2:datatake_id')
        if not datatake: continue
        groups.setdefault((p['platform'],datatake),[]).append(item)
    eligible=[]
    for (platform,datatake),members in groups.items():
        members.sort(key=lambda m:m['id'])
        times=sorted(datetime.fromisoformat(m['properties']['datetime']) for m in members)
        if (times[-1]-times[0]).total_seconds()>300 or len(members)>4:
            continue
        if not unary_union([sc.shape(m['geometry']) for m in members]).covers(aoi):
            continue
        eligible.append({'platform':platform,'datatake_id':datatake,
                         'time_start_utc':times[0].isoformat().replace('+00:00','Z'),
                         'time_end_utc':times[-1].isoformat().replace('+00:00','Z'),
                         'members':[m['id'] for m in members]})
    eligible.sort(key=lambda g:g['datatake_id'])
    eligible.sort(key=lambda g:g['time_start_utc'],reverse=phase=='pre')
    return eligible[:cfg['max_candidates_per_window']]


def catalog(config,snapshot,output):
    cfg=sc.read_json(config);_,_,grid=sc.case_grid(cfg,snapshot)
    out=sc.new_directory(output)
    (out/'config.json').write_bytes(Path(config).read_bytes())
    (out/'perimeter.json').write_bytes(Path(snapshot).read_bytes())
    sc.write_json(out/'grid.json',grid)
    groups,requests={},[]
    for phase in ('pre','post'):
        url=sc.STAC+'/search?'+urlencode({'collections':cfg['collection'],'bbox':','.join(map(str,grid['bbox_wgs84'])),
                                        'datetime':'/'.join(cfg[phase+'_window']),'limit':100})
        body,result=sc.json_download(url)
        (out/f'{phase}-catalog.json').write_bytes(body)
        if result.get('numberMatched',result.get('context',{}).get('matched'))!=len(result['features']):
            raise ValueError('Incomplete mosaic catalogue')
        groups[phase]=group_items(result['features'],cfg,grid,phase)
        if not groups[phase]: raise ValueError('No complete overpass coverage: '+phase)
        requests.append({'url':url,'retrieved_at_utc':sc.utc_now(),'path':f'{phase}-catalog.json','sha256':sc.sha(out/f'{phase}-catalog.json')})
        print(phase,[(g['time_start_utc'],g['members']) for g in groups[phase]],flush=True)
    sc.write_json(out/'mosaic-catalog.json',{'schema_version':'firewatch.research.mosaic-catalog.v1',
                  'config_sha256':sc.sha(out/'config.json'),'snapshot_sha256':sc.sha(out/'perimeter.json'),
                  'grid_sha256':sc.sha(out/'grid.json'),'requests':requests,'groups':groups,
                  'created_at_utc':sc.utc_now(),'code_sha256':sc.sha(__file__),'baseline_code_sha256':sc.sha(sc.__file__)})


def load_catalog(path):
    folder=Path(path);m=sc.read_json(folder/'mosaic-catalog.json')
    for name,key in [('config.json','config_sha256'),('perimeter.json','snapshot_sha256'),('grid.json','grid_sha256')]:
        sc.checked(folder/name,m[key])
    items={}
    for req in m['requests']:
        sc.checked(folder/req['path'],req['sha256'])
        for item in sc.read_json(folder/req['path'])['features']:
            if item['id'] in items: raise ValueError('Duplicate item ID')
            items[item['id']]=item
    return sc.read_json(folder/'config.json'),sc.read_json(folder/'grid.json'),m,items


def partial_crop(item,band,grid,path):
    asset=item['assets'][band];url=asset['href'];host=urlparse(url)
    if host.scheme!='https' or not host.hostname or not host.hostname.endswith('.amazonaws.com'):
        raise ValueError('Expected AWS HTTPS COG')
    meta=asset.get('raster:bands',[{}])[0]
    if 'nodata' not in meta or (band!='scl' and not all(k in meta for k in ('scale','offset'))):
        raise ValueError('Missing radiometric metadata')
    res=10 if band=='nir' else 20
    x0,y0,x1,y1=grid['bounds'];w,h=int((x1-x0)/res),int((y1-y0)/res)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',
                      GDAL_HTTP_TIMEOUT=45,GDAL_HTTP_MAX_RETRY=2,GDAL_HTTP_RETRY_DELAY=1):
        with rasterio.open(url) as src:
            if str(src.crs)!=grid['crs'] or src.transform.b or src.transform.d or src.res!=(res,res):
                raise ValueError('Unexpected native grid')
            if src.nodata!=meta['nodata']: raise ValueError('Conflicting no-data metadata')
            if band!='scl' and (src.scales[0]!=meta['scale'] or src.offsets[0]!=meta['offset']):
                raise ValueError('Conflicting STAC/GeoTIFF radiometry')
            col,row=(~src.transform)*(x0,y1)
            if abs(col-round(col))>1e-5 or abs(row-round(row))>1e-5: raise ValueError('Unaligned source')
            col,row=round(col),round(row)
            cx0,cy0,cx1,cy1=max(0,col),max(0,row),min(src.width,col+w),min(src.height,row+h)
            if cx0>=cx1 or cy0>=cy1: raise ValueError('No raster intersection')
            values=np.full((h,w),src.nodata,dtype=src.dtypes[0])
            values[cy0-row:cy1-row,cx0-col:cx1-col]=src.read(1,window=Window(cx0,cy0,cx1-cx0,cy1-cy0))
            info={'path':path.name,'scene_id':item['id'],'source_url':url,'retrieved_at_utc':sc.utc_now(),
                  'source_shape':[src.height,src.width],'source_transform':list(src.transform)[:6],
                  'read_window':[cx0,cy0,cx1-cx0,cy1-cy0],'requested_window':[col,row,w,h],
                  'native_resolution_m':res,'scale':meta.get('scale'),'offset':meta.get('offset'),'nodata':src.nodata,
                  'source_scales':list(src.scales),'source_offsets':list(src.offsets),
                  'source_published_multihash':asset.get('file:checksum'),'complete_source_checksum_verified':False}
            profile={'driver':'GTiff','height':h,'width':w,'count':1,'dtype':src.dtypes[0],'crs':src.crs,
                     'transform':src.window_transform(Window(col,row,w,h)),'nodata':src.nodata,'compress':'deflate'}
    with rasterio.open(path,'w',**profile) as dst: dst.write(values,1)
    info['sha256']=sc.sha(path)
    return values,info


def mosaic_scl(layers,valid_classes):
    if not layers: raise ValueError('No tiles')
    result=np.zeros_like(layers[0]);chosen=np.full(layers[0].shape,-1,dtype=np.int16)
    usable=np.zeros(layers[0].shape,dtype=bool)
    for index,layer in enumerate(layers):
        if layer.shape!=result.shape: raise ValueError('Tile shape mismatch')
        good=np.isin(layer,valid_classes)
        # Keep first non-no-data for diagnostics, but replace it with first usable.
        take=((chosen<0)&(layer!=0)) | (~usable&good)
        result[take]=layer[take];chosen[take]=index
        usable|=good
    return result,chosen


def acquire(catalog_path,output):
    cfg,grid,manifest,items=load_catalog(catalog_path)
    out=sc.new_directory(output);crops={};groups={};failures=[]
    for phase in ('pre','post'):
        for gi,group in enumerate(manifest['groups'][phase]):
            key=f'{phase}-{gi}';layers=[]
            try:
                for ti,sid in enumerate(group['members']):
                    if sid not in crops:
                        pixels,info=partial_crop(items[sid],'scl',grid,out/f'{key}-{ti}-scl.tif')
                        crops[sid]={'scl':info}
                    else:
                        with rasterio.open(out/crops[sid]['scl']['path']) as src: pixels=src.read(1)
                    layers.append(pixels)
                scl,chosen=mosaic_scl(layers,cfg['valid_scl_classes'])
                groups[key]={'group':group,'scl':scl,'chosen':chosen,'valid':sc.valid_scl(scl,cfg)}
                print(key,'joint tile SCL coverage',float(groups[key]['valid'].mean()),flush=True)
            except (ValueError,OSError,rasterio.errors.RasterioError) as error:
                failures.append({'group':key,'error':str(error)})
                sc.write_json(out/'failures.json',failures)
    pairs=[]
    for pre in groups:
        if not pre.startswith('pre-'): continue
        for post in groups:
            if post.startswith('post-'):
                pairs.append((int((groups[pre]['valid']&groups[post]['valid']).sum()),pre,post))
    if not pairs: raise ValueError('No readable overpass pair')
    _,pre,post=sorted(pairs,key=lambda t:-t[0])[0]
    selected={'pre':pre,'post':post};selections={}
    for phase,key in selected.items():
        group=groups[key]['group']
        selections[phase]=group
        for ti,sid in enumerate(group['members']):
            for band in ('nir','swir22'):
                _,info=partial_crop(items[sid],band,grid,out/f'{phase}-{ti}-{band}.tif')
                crops[sid][band]=info
                print('Acquired',phase,sid,band,flush=True)
    sc.write_json(out/'mosaic-acquisition.json',{'schema_version':'firewatch.research.mosaic-acquisition.v1',
                  'created_at_utc':sc.utc_now(),'catalog_sha256':sc.sha(Path(catalog_path)/'mosaic-catalog.json'),
                  'selected':selections,'crops':crops,'failures':failures,
                  'pair_coverage':[{'valid_pixels':n,'pre':a,'post':b} for n,a,b in pairs],
                  'selection_method':'maximum joint SCL-valid area, fixed temporal/group priority ties; first usable lexical tile within overpass',
                  'code_sha256':sc.sha(__file__),'baseline_code_sha256':sc.sha(sc.__file__)})


def evaluate(catalog_path,acquisition_path,output):
    cfg,grid,manifest,items=load_catalog(catalog_path)
    folder=Path(acquisition_path);acq=sc.read_json(folder/'mosaic-acquisition.json')
    sc.checked(Path(catalog_path)/'mosaic-catalog.json',acq['catalog_sha256'])
    values={};selected_info={}
    for phase,group in acq['selected'].items():
        if group not in manifest['groups'][phase]: raise ValueError('Group outside frozen shortlist')
        layers={};infos=[]
        for sid in group['members']:
            layers[sid]={}
            for band in sc.BANDS:
                info=acq['crops'][sid][band];sc.checked(folder/info['path'],info['sha256'])
                with rasterio.open(folder/info['path']) as src: raw=src.read(1)
                if band=='scl': layers[sid][band]=raw
                else:
                    converted=sc.reflectance(raw,info)
                    layers[sid][band]=sc.average_2x2(converted) if band=='nir' else converted
            infos.append({'id':sid,'datetime':items[sid]['properties']['datetime'],
                          'processing_baseline':items[sid]['properties'].get('s2:processing_baseline')})
        scl,choice=mosaic_scl([layers[sid]['scl'] for sid in group['members']],cfg['valid_scl_classes'])
        merged={band:np.full(scl.shape,np.nan) for band in ('nir','swir22')}
        for ti,sid in enumerate(group['members']):
            for band in merged: merged[band][choice==ti]=layers[sid][band][choice==ti]
        values[phase]=sc.nbr(merged['nir'],merged['swir22'])
        values[phase+'_valid']=sc.valid_scl(scl,cfg)&np.isfinite(values[phase])
        values[phase+'_tile_choice']=choice
        selected_info[phase]={'time_start_utc':group['time_start_utc'],'time_end_utc':group['time_end_utc'],
                              'datatake_id':group['datatake_id'],'members':infos}
    valid=values['pre_valid']&values['post_valid'];difference=values['pre']-values['post']
    plain=difference>=cfg['dnbr_threshold'];pred=plain&(values['pre']>=cfg['pre_nbr_floor'])
    attrs,geometry,_=sc.case_grid(cfg,Path(catalog_path)/'perimeter.json')
    affine=rasterio.Affine(*grid['transform'])
    reference=sc.rasterize([(sc.mapping(geometry),1)],out_shape=valid.shape,transform=affine,all_touched=False).astype(bool)
    if not reference.any(): raise ValueError('Empty raster reference')
    ox,oy=sc.transform('EPSG:4326',grid['crs'],[attrs['attr_InitialLongitude']],[attrs['attr_InitialLatitude']])
    xx=grid['bounds'][0]+(np.arange(grid['width'])+.5)*20
    yy=grid['bounds'][3]-(np.arange(grid['height'])+.5)*20
    disc=(xx[None,:]-ox[0])**2+(yy[:,None]-oy[0])**2<=geometry.area/np.pi
    coverage={'aoi_fraction':float(valid.mean()),'reference_fraction':float(valid[reference].mean()),
              'reference_pixels':int(reference.sum()),'excluded_reference_pixels':int((reference&~valid).sum()),
              'aoi_pixels':valid.size,'excluded_aoi_pixels':int((~valid).sum())}
    models={'dnbr_only':plain,'dnbr_with_pre_nbr_floor':pred,'all_negative':np.zeros_like(pred),'oracle_area_origin_disc':disc}
    scores={key:sc.overlap(mask,reference,valid,.04) for key,mask in models.items()}
    out=sc.new_directory(output)
    outputs=[('pre-nbr',values['pre'],np.nan,'float32'),('post-nbr',values['post'],np.nan,'float32'),
             ('dnbr',np.where(valid,difference,np.nan),np.nan,'float32'),('candidate',np.where(valid,pred,255),255,'uint8'),
             ('reference',reference,255,'uint8'),('valid',valid,255,'uint8'),
             ('pre-tile-choice',values['pre_tile_choice'],-1,'int16'),('post-tile-choice',values['post_tile_choice'],-1,'int16')]
    for name,array,nodata,dtype in outputs:
        with rasterio.open(out/f'{name}.tif','w',driver='GTiff',height=grid['height'],width=grid['width'],count=1,
                           dtype=dtype,crs=grid['crs'],transform=affine,nodata=nodata,compress='deflate') as dst:
            dst.write(array.astype(dtype),1)
    sc.preview(out/'overview.png',values['pre'],values['post'],difference,pred,reference,valid,cfg['case_name'])
    report={'schema_version':'firewatch.research.mosaic-result.v1','created_at_utc':sc.utc_now(),'case_id':cfg['case_id'],
            'role':cfg['research_role'],'config':cfg,'grid':grid,'selected':selected_info,'coverage':coverage,
            'quality_gate_passed':min(coverage['aoi_fraction'],coverage['reference_fraction'])>=cfg['min_joint_valid_fraction'],
            'time_matched_validation_allowed':False,'time_matched_metrics':None,
            'time_matched_metrics_reason':cfg['reference_time_note'],'exploratory_overlap':scores,
            'reference_area_ha_projected':geometry.area/10000,'reference_area_ha_raster':int(reference.sum())*.04,
            'times':{key:sc.epoch_iso(attrs.get(key)) for key in ('attr_FireDiscoveryDateTime','poly_PolygonDateTime','poly_DateCurrent','attr_ContainmentDateTime','attr_FireOutDateTime')},
            'limitations':['Conditional overlap with an operational perimeter; not pixel-level truth.',
                           'Same-overpass tiles have distinct capture UTCs within a 300 second cap; no temporal mixing across datatakes.',
                           'Automatic cloud screening can miss residual thin cloud, haze or smoke.',
                           'Cohort selected by metadata, not a random sample. No training or threshold tuning.',
                           'Oracle-area disc uses reference area and is clipped to the evaluation AOI.'],
            'input_sha256':{'catalog':sc.sha(Path(catalog_path)/'mosaic-catalog.json'),
                            'acquisition':sc.sha(folder/'mosaic-acquisition.json'),'mosaic_code':sc.sha(__file__),
                            'baseline_code':sc.sha(sc.__file__)},
            'environment':{'numpy':np.__version__,'rasterio':rasterio.__version__,'gdal':rasterio.__gdal_version__},
            'outputs':{p.name:sc.sha(p) for p in sorted(out.iterdir())}}
    sc.write_json(out/'report.json',report)
    print(json.dumps({'coverage':coverage,'exploratory_overlap':scores},indent=2),flush=True)


def main():
    p=argparse.ArgumentParser(description=__doc__);s=p.add_subparsers(dest='command',required=True)
    c=s.add_parser('catalog');c.add_argument('config');c.add_argument('snapshot');c.add_argument('--output',required=True)
    a=s.add_parser('acquire');a.add_argument('catalog');a.add_argument('--output',required=True)
    e=s.add_parser('evaluate');e.add_argument('catalog');e.add_argument('acquisition');e.add_argument('--output',required=True)
    args=p.parse_args()
    if args.command=='catalog': catalog(args.config,args.snapshot,args.output)
    elif args.command=='acquire': acquire(args.catalog,args.output)
    else: evaluate(args.catalog,args.acquisition,args.output)


if __name__=='__main__': main()
