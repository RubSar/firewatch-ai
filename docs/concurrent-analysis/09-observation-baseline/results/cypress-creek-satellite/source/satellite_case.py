"""Dated satellite development case: bounded catalogue, native crops, offline scoring.

This is a fixed-rule burned-area experiment, not flame truth or a trained model.
No production providers are imported. Every stage preserves its inputs and refuses
to replace an existing output directory. See contracts/research/satellite-case.md.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import platform
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image, ImageDraw
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import transform, transform_geom
from rasterio.windows import Window
import shapely
from shapely.geometry import Polygon, box, mapping, shape

STAC = 'https://earth-search.aws.element84.com/v1'
BANDS = ('nir', 'swir22', 'scl')


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + '\n', encoding='utf-8')


def new_directory(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=False)
    return path


def json_download(url):
    with urlopen(Request(url, headers={'User-Agent': 'FireWatch-research/0.1'}), timeout=45) as r:
        data = r.read(20_000_001)
    if len(data) > 20_000_000:
        raise ValueError('Catalogue exceeds 20 MB response budget')
    parsed = json.loads(data)
    if 'error' in parsed:
        raise ValueError(f'Provider error: {parsed["error"]}')
    return data, parsed


def epoch_iso(value):
    return None if value is None else datetime.fromtimestamp(value / 1000, timezone.utc).isoformat().replace('+00:00', 'Z')


def perimeter_geometry(rings):
    """Even-odd ring topology: handles holes, islands and separate outer rings."""
    result = Polygon()
    for ring in rings:
        if len(ring) < 4 or ring[0] != ring[-1]:
            raise ValueError('Unclosed/short perimeter ring')
        polygon = Polygon(ring)
        if polygon.is_empty or not polygon.is_valid:
            raise ValueError('Invalid perimeter ring; no silent repair')
        result = result.symmetric_difference(polygon)
    if result.is_empty or not result.is_valid:
        raise ValueError('Invalid perimeter geometry')
    return result


def case_grid(config, snapshot):
    if config['schema_version'] != 'firewatch.research.satellite-case.v1':
        raise ValueError('Unknown config schema')
    if sha(snapshot) != config['snapshot_sha256']:
        raise ValueError('Frozen perimeter snapshot hash mismatch')
    data = read_json(snapshot)
    if data.get('spatialReference', {}).get('wkid') != 4326 or len(data['features']) != 1:
        raise ValueError('Expected one WGS84 perimeter feature')
    feature = data['features'][0]
    attrs = feature['attributes']
    if attrs['attr_IrwinID'].strip('{}').lower() != config['incident_id']:
        raise ValueError('Wrong incident')
    wgs = perimeter_geometry(feature['geometry']['rings'])
    crs = f'EPSG:{config["epsg"]}'
    projected = shape(transform_geom('EPSG:4326', crs, mapping(wgs)))
    res, pad = config['resolution_m'], config['buffer_m']
    if res != 20 or pad < 0 or config['epsg'] != 32615:
        raise ValueError('This version supports the frozen 20 m UTM 15N Cypress case')
    x0, y0, x1, y1 = projected.bounds
    bounds = [math.floor((x0-pad)/res)*res, math.floor((y0-pad)/res)*res,
              math.ceil((x1+pad)/res)*res, math.ceil((y1+pad)/res)*res]
    width, height = int((bounds[2]-bounds[0])/res), int((bounds[3]-bounds[1])/res)
    if not 0 < width*height <= config['max_pixels']:
        raise ValueError('Grid exceeds pixel budget')
    affine = from_origin(bounds[0], bounds[3], res, res)
    aoi_wgs = shape(transform_geom(crs, 'EPSG:4326', mapping(box(*bounds))))
    return attrs, projected, {
        'crs': crs, 'bounds': bounds, 'width': width, 'height': height,
        'transform': list(affine)[:6], 'resolution_m': res,
        'aoi_wgs84': mapping(aoi_wgs), 'bbox_wgs84': list(aoi_wgs.bounds),
        'coordinate_order': 'longitude, latitude for WGS84; easting, northing metres for UTM',
    }


def catalog(config_path, snapshot, output):
    cfg = read_json(config_path)
    attrs, geometry, grid = case_grid(cfg, snapshot)
    out = new_directory(output)
    (out/'config.json').write_bytes(Path(config_path).read_bytes())
    (out/'perimeter.json').write_bytes(Path(snapshot).read_bytes())
    write_json(out/'grid.json', grid)
    records, requests = {}, []
    aoi = shape(grid['aoi_wgs84'])
    for phase in ('pre', 'post'):
        query = {'collections': cfg['collection'], 'bbox': ','.join(map(str, grid['bbox_wgs84'])),
                 'datetime': '/'.join(cfg[phase+'_window']), 'limit': 100}
        url = STAC+'/search?'+urlencode(query)
        body, result = json_download(url)
        (out/f'{phase}-catalog.json').write_bytes(body)
        requests.append({'url': url, 'retrieved_at_utc': utc_now(), 'path': f'{phase}-catalog.json',
                         'sha256': sha(out/f'{phase}-catalog.json')})
        matched = result.get('numberMatched', result.get('context', {}).get('matched'))
        # Earth Search advertises a next link even on a complete short page.
        if matched != len(result['features']):
            raise ValueError('More than 100 scenes: narrow the fixed window; no silent truncation')
        candidates = []
        for item in result['features']:
            p, assets = item['properties'], item['assets']
            if item['collection'] != cfg['collection']:
                raise ValueError('Unexpected collection')
            dt = p['datetime']
            instant = datetime.fromisoformat(dt)
            in_window = (datetime.fromisoformat(cfg[phase+'_window'][0]) <= instant
                         <= datetime.fromisoformat(cfg[phase+'_window'][1]))
            eligible = (in_window and p.get('eo:cloud_cover', 100) <= cfg['max_scene_cloud_percent']
                        and all(b in assets for b in BANDS) and shape(item['geometry']).covers(aoi))
            candidates.append({'id': item['id'], 'datetime': dt, 'cloud_percent': p.get('eo:cloud_cover'),
                               'eligible': eligible})
        eligible = [v for v in candidates if v['eligible']]
        eligible.sort(key=lambda v: v['id'])
        eligible.sort(key=lambda v: v['datetime'], reverse=phase == 'pre')
        records[phase] = {'all_scenes': candidates,
                          'shortlist': [v['id'] for v in eligible[:cfg['max_candidates_per_window']]]}
        if not records[phase]['shortlist']:
            raise ValueError(f'No eligible {phase} scenes; inspect preserved catalogue')
        print(f'{phase}: {len(candidates)} scenes, shortlist {records[phase]["shortlist"]}', flush=True)
    write_json(out/'catalog-manifest.json', {
        'schema_version': 'firewatch.research.satellite-catalog.v1', 'created_at_utc': utc_now(),
        'config_sha256': sha(out/'config.json'), 'grid_sha256': sha(out/'grid.json'),
        'snapshot_sha256': sha(out/'perimeter.json'), 'requests': requests, 'selection': records,
        'projected_reference_area_ha': geometry.area/10000,
        'times': {key: epoch_iso(attrs.get(key)) for key in (
            'attr_FireDiscoveryDateTime', 'poly_PolygonDateTime', 'poly_DateCurrent',
            'attr_ContainmentDateTime', 'attr_FireOutDateTime')},
        'code_sha256': sha(__file__),
    })


def checked(path, expected):
    if sha(path) != expected:
        raise ValueError(f'Checksum mismatch: {path}')


def load_catalog(folder):
    folder = Path(folder)
    manifest = read_json(folder/'catalog-manifest.json')
    for name, key in [('config.json','config_sha256'), ('grid.json','grid_sha256'),
                      ('perimeter.json','snapshot_sha256')]:
        checked(folder/name, manifest[key])
    items = {}
    for request in manifest['requests']:
        checked(folder/request['path'], request['sha256'])
        for item in read_json(folder/request['path'])['features']:
            if item['id'] in items:
                raise ValueError('Duplicate scene IDs across catalogue windows')
            items[item['id']] = item
    return read_json(folder/'config.json'), read_json(folder/'grid.json'), manifest, items


def native_crop(item, band, grid, output):
    asset = item['assets'][band]
    url = asset['href']
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or not parsed.hostname.endswith('.amazonaws.com'):
        raise ValueError('Expected public HTTPS AWS COG asset')
    metadata = asset.get('raster:bands', [{}])[0]
    if band != 'scl' and not all(k in metadata for k in ('scale', 'offset', 'nodata')):
        raise ValueError('Missing radiometric metadata; do not assume a scale/offset')
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',
                      GDAL_HTTP_TIMEOUT=45, GDAL_HTTP_MAX_RETRY=2, GDAL_HTTP_RETRY_DELAY=1):
        with rasterio.open(url) as src:
            if str(src.crs) != grid['crs'] or src.transform.b or src.transform.d:
                raise ValueError('Unexpected CRS/rotation; no implicit reprojection')
            expected = 10 if band == 'nir' else 20
            if src.res != (expected, expected):
                raise ValueError('Unexpected native resolution')
            x0,y0,x1,y1 = grid['bounds']
            col, row = (~src.transform)*(x0,y1)
            if abs(col-round(col)) > 1e-5 or abs(row-round(row)) > 1e-5:
                raise ValueError('Grid is not aligned with source pixels')
            w,h = int((x1-x0)/expected), int((y1-y0)/expected)
            if col < 0 or row < 0 or col+w > src.width or row+h > src.height:
                raise ValueError('AOI extends outside raster')
            window = Window(round(col), round(row), w, h)
            pixels = src.read(1, window=window)
            profile = {'driver':'GTiff','height':h,'width':w,'count':1,'dtype':str(pixels.dtype),
                       'crs':src.crs,'transform':src.window_transform(window),'nodata':src.nodata,
                       'compress':'deflate'}
            if metadata.get('nodata') != src.nodata:
                raise ValueError('STAC/GeoTIFF nodata conflict')
            info = {'path':output.name, 'source_url':url, 'retrieved_at_utc':utc_now(),
                    'source_published_multihash':asset.get('file:checksum'),
                    'source_published_size_bytes':asset.get('file:size'),
                    'complete_source_checksum_verified':False,
                    'native_resolution_m':expected, 'native_window':[int(col),int(row),w,h],
                    'source_shape':[src.height,src.width], 'source_transform':list(src.transform)[:6],
                    'scale':metadata.get('scale'), 'offset':metadata.get('offset'),
                    'nodata':src.nodata, 'source_scales':list(src.scales), 'source_offsets':list(src.offsets),
                    'checksum_scope':'local losslessly saved native pixel crop, not complete remote COG'}
    with rasterio.open(output, 'w', **profile) as dst:
        dst.write(pixels,1)
    info['sha256'] = sha(output)
    return pixels, info


def valid_scl(scl, cfg):
    valid = np.isin(scl, cfg['valid_scl_classes'])
    radius = cfg['cloud_buffer_pixels']
    # Exclude neighbors of unusable classes; outside AOI is unknown too.
    padded = np.pad(~valid, radius, constant_values=True)
    result = valid.copy()
    for dy in range(2*radius+1):
        for dx in range(2*radius+1):
            result &= ~padded[dy:dy+valid.shape[0], dx:dx+valid.shape[1]]
    return result


def acquire(catalog_path, output):
    cfg, grid, manifest, items = load_catalog(catalog_path)
    out = new_directory(output)
    arrays, crops, failures = {}, {}, []
    for phase in ('pre','post'):
        for number, sid in enumerate(manifest['selection'][phase]['shortlist']):
            key = f'{phase}-{number}'
            try:
                pixels, info = native_crop(items[sid], 'scl', grid, out/f'{key}-scl.tif')
                arrays[sid] = valid_scl(pixels,cfg)
                crops[sid] = {'scl':info}
                print(f'{phase} {sid}: SCL-valid {arrays[sid].mean():.2%}',flush=True)
            except (OSError, ValueError, rasterio.errors.RasterioError) as error:
                failures.append({'scene_id':sid,'error':str(error)})
                write_json(out/'failures.json', failures)
                print(f'{sid}: failed {error}',flush=True)
    pairs = []
    for pre in manifest['selection']['pre']['shortlist']:
        for post in manifest['selection']['post']['shortlist']:
            if pre in arrays and post in arrays:
                pairs.append((int((arrays[pre]&arrays[post]).sum()),pre,post))
    if not pairs:
        raise ValueError('No readable scene pair; failures retained')
    # Stable sort preserves temporal shortlist order for equal coverage.
    _, pre, post = sorted(pairs,key=lambda row:-row[0])[0]
    selected = {'pre':pre,'post':post}
    for phase,sid in selected.items():
        write_json(out/f'{phase}-item.json',items[sid])
        for band in ('nir','swir22'):
            _, info = native_crop(items[sid],band,grid,out/f'{phase}-{band}.tif')
            crops[sid][band] = info
            print(f'Acquired {phase} {band}',flush=True)
    write_json(out/'acquisition.json', {
        'schema_version':'firewatch.research.satellite-acquisition.v1','created_at_utc':utc_now(),
        'catalog_manifest_sha256':sha(Path(catalog_path)/'catalog-manifest.json'),
        'selected':selected, 'crops':crops,'failures':failures,
        'pair_scl_coverage':[{'pre':a,'post':b,'valid_pixels':n,'fraction':n/(grid['width']*grid['height'])}
                             for n,a,b in pairs],
        'item_sha256':{phase:sha(out/f'{phase}-item.json') for phase in selected},
        'code_sha256':sha(__file__),
    })


def reflectance(dn, meta):
    valid = np.isfinite(dn) & (dn != meta['nodata'])
    result = dn.astype(np.float64)*meta['scale']+meta['offset']
    return np.where(valid,result,np.nan)


def average_2x2(values):
    h,w = values.shape
    if h%2 or w%2:
        raise ValueError('NIR crop must be aligned even dimensions')
    # Ordinary mean propagates unknown if ANY contributing native pixel is missing.
    return values.reshape(h//2,2,w//2,2).mean(axis=(1,3))


def nbr(nir,swir):
    den = nir+swir
    valid = np.isfinite(nir)&np.isfinite(swir)&(nir>=0)&(swir>=0)&(den>1e-6)
    result = np.full(nir.shape,np.nan)
    np.divide(nir-swir,den,out=result,where=valid)
    return result


def overlap(pred, reference, valid, cell_area_ha):
    tp = int((pred&reference&valid).sum())
    fp = int((pred&~reference&valid).sum())
    fn = int((~pred&reference&valid).sum())
    tn = int((~pred&~reference&valid).sum())
    def ratio(a,b):
        return a/b if b else None
    return {'tp':tp,'fp':fp,'fn':fn,'tn':tn,'valid_pixels':int(valid.sum()),
            'iou':ratio(tp,tp+fp+fn),'dice':ratio(2*tp,2*tp+fp+fn),
            'precision':ratio(tp,tp+fp),'recall':ratio(tp,tp+fn),
            'candidate_area_ha_on_valid':(tp+fp)*cell_area_ha,
            'reference_area_ha_on_valid':(tp+fn)*cell_area_ha,
            'area_bias_ha_on_valid':(fp-fn)*cell_area_ha,
            'area_bias_fraction_on_valid':ratio(fp-fn,tp+fn)}


def preview(path,pre,post,difference,pred,reference,valid):
    tiles = []
    for values,title in [(pre,'Pre-fire NBR'),(post,'Post-containment NBR'),(difference,'dNBR (pre minus post)')]:
        finite = np.nan_to_num(values,nan=0)
        intensity = np.clip((finite+1)/2,0,1)
        rgb = np.stack([255*(1-intensity),180*intensity,65*intensity],axis=-1).astype('uint8')
        rgb[~valid] = (135,135,135)
        tiles.append((rgb,title))
    agreement = np.zeros((*pred.shape,3),dtype='uint8')+235
    agreement[reference&pred]=(215,75,35)
    agreement[reference&~pred]=(40,95,190)
    agreement[~reference&pred]=(230,175,35)
    agreement[~valid]=(135,135,135)
    tiles.append((agreement,'Gated rule vs mapped reference'))
    canvas=Image.new('RGB',(1100,810),'white')
    draw=ImageDraw.Draw(canvas)
    draw.text((24,12),'Cypress Creek - exploratory satellite overlap; reference time unresolved',fill='black',font_size=22)
    for i,(rgb,title) in enumerate(tiles):
        x,y=24+(i%2)*540,55+(i//2)*335
        tile=Image.fromarray(rgb)
        tile.thumbnail((510,292),Image.Resampling.NEAREST)
        canvas.paste(tile,(x,y+28))
        draw.text((x,y),title,fill='black',font_size=18)
    draw.text((24,740),'NBR/dNBR fixed scale: -1 red, 0 ochre, +1 green (display clipped). Grey = excluded.',fill='black',font_size=16)
    draw.text((24,765),'Overlap: red both | blue reference only | gold rule only | white neither. North up; 20 m cells.',fill='black',font_size=16)
    canvas.save(path)


def evaluate(catalog_path,acquisition_path,output):
    cfg,grid,catalog_manifest,items = load_catalog(catalog_path)
    inputs=Path(acquisition_path)
    acquired=read_json(inputs/'acquisition.json')
    checked(Path(catalog_path)/'catalog-manifest.json',acquired['catalog_manifest_sha256'])
    arrays,selected={},{}
    for phase,sid in acquired['selected'].items():
        if sid not in catalog_manifest['selection'][phase]['shortlist']:
            raise ValueError('Selected scene outside frozen shortlist')
        checked(inputs/f'{phase}-item.json',acquired['item_sha256'][phase])
        scene={}
        for band,info in acquired['crops'][sid].items():
            path=inputs/info['path']
            checked(path,info['sha256'])
            with rasterio.open(path) as source:
                raw=source.read(1)
            if band=='scl':
                scene['valid']=valid_scl(raw,cfg)
            else:
                vals=reflectance(raw,info)
                scene[band]=average_2x2(vals) if band=='nir' else vals
        arrays[phase]=nbr(scene['nir'],scene['swir22'])
        arrays[phase+'_valid']=scene['valid']&np.isfinite(arrays[phase])
        item=items[sid]
        selected[phase]={'id':sid,'datetime':item['properties']['datetime'],
                         'processing_baseline':item['properties'].get('s2:processing_baseline'),
                         'cloud_percent':item['properties'].get('eo:cloud_cover'),
                         'radiometry':{b:{k:acquired['crops'][sid][b][k] for k in ('scale','offset','nodata')}
                                       for b in ('nir','swir22')}}
    valid=arrays['pre_valid']&arrays['post_valid']
    difference=arrays['pre']-arrays['post']
    plain=difference>=cfg['dnbr_threshold']
    pred=plain&(arrays['pre']>=cfg['pre_nbr_floor'])
    attrs,geometry,_=case_grid(cfg,Path(catalog_path)/'perimeter.json')
    affine=rasterio.Affine(*grid['transform'])
    ref=rasterize([(mapping(geometry),1)],out_shape=valid.shape,transform=affine,all_touched=False).astype(bool)
    ox,oy=transform('EPSG:4326',grid['crs'],[attrs['attr_InitialLongitude']],[attrs['attr_InitialLatitude']])
    xx=grid['bounds'][0]+(np.arange(grid['width'])+.5)*grid['resolution_m']
    yy=grid['bounds'][3]-(np.arange(grid['height'])+.5)*grid['resolution_m']
    disc=(xx[None,:]-ox[0])**2+(yy[:,None]-oy[0])**2<=geometry.area/math.pi
    cell_ha=grid['resolution_m']**2/10000
    coverage={'aoi_fraction':float(valid.mean()),'reference_fraction':float(valid[ref].mean()),
              'reference_pixels':int(ref.sum()),'excluded_reference_pixels':int((ref&~valid).sum()),
              'aoi_pixels':int(valid.size),'excluded_aoi_pixels':int((~valid).sum())}
    quality_ok=min(coverage['aoi_fraction'],coverage['reference_fraction'])>=cfg['min_joint_valid_fraction']
    models={'dnbr_only':plain,'dnbr_with_pre_nbr_floor':pred,
            'all_negative':np.zeros_like(pred),'oracle_area_origin_disc':disc}
    scores={name:overlap(mask,ref,valid,cell_ha) for name,mask in models.items()}
    out=new_directory(output)
    for name,values,nodata,dtype in [
        ('pre-nbr',arrays['pre'],np.nan,'float32'),('post-nbr',arrays['post'],np.nan,'float32'),
        ('dnbr',np.where(valid,difference,np.nan),np.nan,'float32'),
        ('candidate',np.where(valid,pred,255),255,'uint8'),
        ('reference',ref,255,'uint8'),('valid',valid,255,'uint8')]:
        with rasterio.open(out/f'{name}.tif','w',driver='GTiff',height=grid['height'],width=grid['width'],
                           count=1,dtype=dtype,crs=grid['crs'],transform=affine,nodata=nodata,compress='deflate') as dst:
            dst.write(values.astype(dtype),1)
    preview(out/'overview.png',arrays['pre'],arrays['post'],difference,pred,ref,valid)
    report={
        'schema_version':'firewatch.research.satellite-result.v1','created_at_utc':utc_now(),
        'case_id':cfg['case_id'],'role':'development; single inspected incident',
        'target':'spectral burned-area candidate vs mapped incident extent; not active flame',
        'config':cfg,'grid':grid,'selected':selected,'times':catalog_manifest['times'],'coverage':coverage,
        'quality_gate_passed':quality_ok,'time_matched_validation_allowed':False,
        'time_matched_metrics':None,'time_matched_metrics_reason':cfg['reference_time_note'],
        'exploratory_overlap':scores,
        'reference_area_ha_projected':geometry.area/10000,'reference_area_ha_raster':int(ref.sum())*cell_ha,
        'aoi_area_ha':valid.size*cell_ha,
        'baseline_note':'Oracle-area disc uses mapped reference area and reported origin. It is a descriptive geometric comparator, not an operational predictor.',
        'limitations':['One development case; no independent incidents or threshold optimization.',
                       'SCL cloud screening is automatic; residual thin cloud, smoke, shadows or misregistration remain possible.',
                       'Mapped perimeter interiors can include unburned islands; overlap is not burn-pixel accuracy.',
                       'Time mismatch, vegetation phenology, nearby burns and non-fire changes are unresolved confounders.',
                       'No human drone reviews, M1 acceptance, trained model or simulator calibration are implied.'],
        'input_sha256':{'catalog_manifest':sha(Path(catalog_path)/'catalog-manifest.json'),
                        'acquisition_manifest':sha(inputs/'acquisition.json'),'code':sha(__file__)},
        'environment':{'python':platform.python_version(),'numpy':np.__version__,'rasterio':rasterio.__version__,
                       'gdal':rasterio.__gdal_version__,'shapely':shapely.__version__},
        'outputs':{p.name:sha(p) for p in sorted(out.iterdir())},
    }
    write_json(out/'report.json',report)
    print(json.dumps({'selected':selected,'coverage':coverage,'exploratory_overlap':scores},indent=2),flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    cat=sub.add_parser('catalog')
    cat.add_argument('config',type=Path)
    cat.add_argument('snapshot',type=Path)
    cat.add_argument('--output',type=Path,required=True)
    acq=sub.add_parser('acquire')
    acq.add_argument('catalog',type=Path)
    acq.add_argument('--output',type=Path,required=True)
    eva=sub.add_parser('evaluate')
    eva.add_argument('catalog',type=Path)
    eva.add_argument('acquisition',type=Path)
    eva.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.command=='catalog': catalog(args.config,args.snapshot,args.output)
    elif args.command=='acquire': acquire(args.catalog,args.output)
    else: evaluate(args.catalog,args.acquisition,args.output)


if __name__=='__main__':
    main()
