"""Append NASA historical measurements to intervals.json only.

Run separately from enrichment_run: existing measurements and preview files are preserved.
Earth Engine serves the NASA products; it is not an independent measurement source.
"""
import argparse
import copy
import hashlib
import json
import math
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .enrichment_core import measurement

HLS = ['NASA/HLS/HLSL30/v002', 'NASA/HLS/HLSS30/v002']
IMERG = 'NASA/GPM_L3/IMERG_V07'
SMAP = 'NASA/SMAP/SPL4SMGP/008'
SRTM = 'USGS/SRTMGL1_003'
BURN = 'MODIS/061/MCD64A1'
TAG = 'nasa-enrichment-v1'


def dt(value):
    return datetime.fromisoformat(value).astimezone(UTC)


def smap_window(start):
    t = dt(start)
    a = t.replace(hour=t.hour // 3 * 3, minute=0, second=0, microsecond=0)
    return a.isoformat(), (a + timedelta(hours=3)).isoformat()


def accumulated_rain(rates, expected):
    """Pure counterpart of the half-hour integration, used for validation."""
    if len(rates) != expected or any(v is None or v < 0 for v in rates):
        return None
    return sum(rates) * 0.5


def make_measurement(field, value, unit, source, raw, window, support, method,
                     flags=(), kind='calculated'):
    m = measurement(field, value, unit, kind, source, raw, window, support, method, flags)
    m['processing_version'] = TAG
    m['retrieval_status'] = 'available' if value is not None else 'no_valid_support'
    return m


def build_query(records, products=None):
    import ee

    from .enrichment_ee import geometry, summarize

    def summarize_nasa(image, grid, geom):
        return summarize(image, grid, geom, tile_scale=16)

    features = []
    for r in records:
        start, end = r['interval']['start'], r['interval']['end']
        props = {'interval_id': r['interval_id']}
        supports = {'ignition_point_context': geometry(r['ignition_context']['geometry'])}
        if r['footprint']['geometry'] is not None:
            supports['newly_burned'] = geometry(r['footprint']['geometry'])
        for support, g in supports.items():
            values = {}
            for hours, key in [(1, 'rain'), (24, 'rain24'), (168, 'rain168')]:
                a = start if hours == 1 else (dt(start)-timedelta(hours=hours)).isoformat()
                b = end if hours == 1 else start
                c = ee.ImageCollection(IMERG).filterDate(a, b).filter(
                    ee.Filter.eq('status', 'permanent'))
                grid = ee.Image(c.first()).select('precipitation').projection()
                # Every half-hour must exist AND be valid at a pixel. Never sum through gaps.
                rain = c.select('precipitation')
                valid = rain.count().eq(hours * 2).And(rain.min().gte(0))
                image = rain.sum().multiply(0.5).updateMask(valid).rename('precipitation_mm')
                values[key] = ee.Dictionary({
                    'summary': summarize_nasa(image, grid, g), 'count': c.size(),
                    'granule_ids': c.aggregate_array('system:index'),
                    'timestamps': c.aggregate_array('system:time_start'),
                    'grid': grid, 'start': a, 'end': b,
                })
            a, b = smap_window(start)
            soil = ee.Image(ee.ImageCollection(SMAP).filterDate(a, b).first())
            soil_grid = soil.select('sm_surface').projection()
            values['soil'] = ee.Dictionary({
                'summary': summarize_nasa(soil.select(['sm_surface', 'sm_rootzone']), soil_grid, g),
                'granule_id': soil.get('system:index'), 'timestamp': soil.get('system:time_start'),
                'grid': soil_grid, 'start': a, 'end': b,
            })
            if support == 'newly_burned':
                # GOFER perimeters can contain thousands of vertices. A 30 m maximum
                # deviation keeps HLS reduction geometry close to the product pixel scale.
                hls_geom = g.simplify(30)
                ignition = r['ignition_context']['source_record']['tUTC'].replace(' ', 'T')+'Z'
                candidates = []
                for asset, bands in zip(HLS, [['B5','B4','B6','B7'], ['B8A','B4','B11','B12']]):
                    def prepare(im, bands=bands, asset=asset):
                        return im.select(bands + ['Fmask'],
                                         ['nir','red','swir1','swir2','qa']).set('collection', asset)
                    candidates.append(ee.ImageCollection(asset).filterBounds(hls_geom.bounds()).filterDate(
                        ee.Date(ignition).advance(-30, 'day'), ignition).filter(
                            ee.Filter.lt('CLOUD_COVERAGE', 20)).map(prepare))
                c = candidates[0].merge(candidates[1]).sort('system:time_start', False)
                # Selection is explicit: newest intersecting scene with <20% tile cloud.
                # Pixel QA still controls coverage; no post-fire image or silent gap filling.
                im = ee.Image(c.first())
                qa = im.select('qa')
                mask = qa.bitwiseAnd(63).eq(0).And(qa.rightShift(6).lt(3))
                reflectance = im.select(['nir','red','swir1','swir2'])
                mask = mask.And(reflectance.reduce(ee.Reducer.min()).gte(0))
                indices = []
                for band, name in [('red','ndvi'), ('swir1','ndmi'), ('swir2','nbr')]:
                    n, other = im.select('nir'), im.select(band)
                    denominator = n.add(other)
                    indices.append(n.subtract(other).divide(denominator).updateMask(
                        mask.And(denominator.gt(0))).rename(name))
                image = ee.Image.cat(indices)
                grid = im.select('nir').projection()
                values['hls'] = ee.Algorithms.If(c.size().gt(0), ee.Dictionary({
                    'summary': summarize_nasa(image, grid, hls_geom), 'granule_id': im.get('system:index'),
                    'timestamp': im.get('system:time_start'), 'collection': im.get('collection'),
                    'grid': grid, 'candidate_count': c.size(),
                }), ee.Dictionary({'status': 'no_pre_fire_scene'}))
                dem = ee.Image(SRTM).select('elevation')
                slope = ee.Terrain.slope(dem)
                aspect = ee.Terrain.aspect(dem).updateMask(slope.gt(0)).multiply(math.pi/180)
                terrain = dem.rename('elevation_m').addBands([
                    slope.rename('slope_deg'), aspect.sin().rename('aspect_sin'),
                    aspect.cos().rename('aspect_cos')])
                values['terrain'] = ee.Dictionary({
                    'summary': summarize_nasa(terrain, dem.projection(), g), 'grid': dem.projection()})
                month = dt(start).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
                following = (month.replace(day=28)+timedelta(days=4)).replace(day=1)
                burn = ee.Image(ee.ImageCollection(BURN).filterDate(
                    month.isoformat(), following.isoformat()).first())
                valid = burn.select('QA').bitwiseAnd(3).eq(3)
                dates = burn.select('BurnDate').updateMask(valid)
                burned = dates.gt(0)
                values['burn'] = ee.Dictionary({
                    'summary': summarize_nasa(burn.select('Uncertainty').updateMask(
                        valid.And(burned)), burn.select(0).projection(), g),
                    'burn_date_histogram': dates.reduceRegion(ee.Reducer.frequencyHistogram(),
                        g, crs=burn.select(0).projection(), maxPixels=10000000),
                    'qa_histogram': burn.select('QA').reduceRegion(ee.Reducer.frequencyHistogram(),
                        g, crs=burn.select(0).projection(), maxPixels=10000000),
                    'burned_area_ha': ee.Image.pixelArea().divide(10000).updateMask(
                        valid.And(burned)).rename('area').reduceRegion(ee.Reducer.sum(),
                        g, crs=burn.select(0).projection(), maxPixels=10000000).get('area'),
                    'valid_coverage': valid.unmask(0).reduceRegion(ee.Reducer.mean(),
                        g, crs=burn.select(0).projection(), maxPixels=10000000).get('QA'),
                    'granule_id': burn.get('system:index'), 'start': month.isoformat(),
                    'end': following.isoformat(), 'grid': burn.select(0).projection(),
                })
            props[support] = ee.Dictionary({k: v for k, v in values.items()
                                           if products is None or k in products})
        features.append(ee.Feature(None, props))
    return ee.FeatureCollection(features).getInfo()


def bounded_query(records):
    """Split oversized or failing Earth Engine requests into smaller source queries."""
    import ee

    try:
        split_request = False
        try:
            return build_query(records)
        except ee.EEException as error:
            message = str(error).lower()
            if 'memory limit' not in message and 'internal error' not in message:
                raise
            split_request = True
    except ee.EEException:
        raise
    if split_request:
        if len(records) > 1:
            print('Earth Engine batch memory limit; retrying individual intervals', flush=True)
            return {'type': 'FeatureCollection', 'features': [
                f for record in records for f in bounded_query([record])['features']]}
        print('Earth Engine memory limit; splitting products for one interval', flush=True)
        merged = {'interval_id': records[0]['interval_id']}
        for product in ['rain', 'rain24', 'rain168', 'soil', 'hls', 'terrain', 'burn']:
            print(f'Retrying product {product}', flush=True)
            try:
                result = bounded_query_products(records, {product})['features'][0]['properties']
            except ee.EEException as error:
                print(f'Product {product} unavailable: {error}', flush=True)
                result = {'interval_id': records[0]['interval_id']}
                for support in ['newly_burned', 'ignition_point_context']:
                    result[support] = {product: {'status': 'earth_engine_request_failed'}}
            for support in ['newly_burned', 'ignition_point_context']:
                merged.setdefault(support, {}).update(result.get(support, {}))
        return {'type': 'FeatureCollection', 'features': [{'properties': merged}]}


def bounded_query_products(records, products):
    """Retry transient service errors for a product-split request."""
    import ee

    for attempt in range(3):
        try:
            return build_query(records, products)
        except ee.EEException as error:
            if ('internal error' not in str(error).lower()
                    and 'memory limit' not in str(error).lower()) or attempt == 2:
                raise
            time.sleep(2 ** attempt)


def attach(record, raw, retrieved_at):
    additions = []

    def add(field, unit, product, data, band, window, support, method, flags=(), kind='calculated'):
        summary = data.get('summary', {})
        value = summary.get(band + '_mean')
        quality = list(flags)
        if support == 'newly_burned':
            quality.append('retrospective_footprint')
            if record['footprint']['geometry'] is None:
                quality.append('no_newly_burned_footprint')
        else:
            quality.append('context_only_not_footprint_summary')
        coverage = summary.get('valid_fraction')
        if coverage is not None and coverage < 0.999:
            quality.append('partial_raster_coverage')
        if value is None:
            quality.append(data.get('status', 'no_valid_raster_support'))
        source = {'id': product, 'access_via': 'Google Earth Engine',
                  'retrieved_at': retrieved_at, 'grid': data.get('grid'),
                  'granule_id': data.get('granule_id'),
                  'granule_ids': data.get('granule_ids'), 'independence_group': product}
        item = make_measurement(field, value, unit, source, data, window,
            {'kind': support, 'raster_valid_fraction': coverage,
             'pixel_center_count': summary.get(band+'_count')}, method, quality, kind)
        if data.get('status'):
            item['retrieval_status'] = data['status']
        additions.append(item)

    for support in ['newly_burned', 'ignition_point_context']:
        data = raw.get(support, {})
        for key, field in [('rain','precipitation_mm'),
                           ('rain24','antecedent_precipitation_24h_mm'),
                           ('rain168','antecedent_precipitation_7d_mm')]:
            item = data.get(key, {})
            add(field, 'mm', IMERG, item, 'precipitation_mm',
                {'start': item.get('start'), 'end': item.get('end'),
                 'convention': 'half_open_accumulation_window', 'native_step_minutes': 30}, support,
                'Sum permanent IMERG rates (mm/hour) * 0.5 hours; all half-hours required per pixel.',
                ['coarse_grid_context', 'satellite_gauge_precipitation_estimate'])
        soil = data.get('soil', {})
        for band, field in [('sm_surface','surface_soil_moisture_m3_m3'),
                            ('sm_rootzone','root_zone_soil_moisture_m3_m3')]:
            add(field, 'm3/m3', SMAP, soil, band,
                {'start': soil.get('start'), 'end': soil.get('end'),
                 'source_timestamp_ms': soil.get('timestamp'), 'convention': 'three_hour_average'},
                support, 'Mean on Earth Engine delivery grid; original product 9 km EASE grid.',
                ['coarse_grid_context', 'satellite_assimilating_land_model',
                 'earth_engine_reprojected_grid', 'not_fuel_moisture', 'not_hourly_observation'],
                'reconstructed')
        if support != 'newly_burned':
            continue
        hls = copy.deepcopy(data.get('hls', {}))
        # ImageCollection.merge prefixes system:index with 1_/2_; preserve that alias
        # separately and report the provider's original tile/acquisition identifier.
        merged_id = hls.get('granule_id')
        if merged_id and merged_id[:2] in {'1_', '2_'}:
            hls['earth_engine_merged_index'] = merged_id
            hls['granule_id'] = merged_id[2:]
        stamp = hls.get('timestamp')
        acquired = datetime.fromtimestamp(stamp/1000, UTC).isoformat() if stamp else None
        age = (dt(record['interval']['start'])-dt(acquired)).total_seconds()/86400 if acquired else None
        for field in ['ndvi', 'ndmi', 'nbr']:
            add(field, 'dimensionless', hls.get('collection', 'NASA/HLS/v002'), hls, field,
                {'acquired_at': acquired, 'relationship_to_fire': 'pre_fire',
                 'observation_age_days': age, 'search_lookback_days': 30}, support,
                'Newest intersecting pre-ignition HLS scene with tile cloud <20%; mask cloud, '
                'adjacency, shadow, snow, water, high aerosol, negative reflectance; '
                'mean of per-pixel (NIR-other)/(NIR+other); other=red/SWIR1/SWIR2.',
                ['single_scene_partial_coverage_possible', 'not_direct_fuel_load'])
        terrain = copy.deepcopy(data.get('terrain', {}))
        s, c = (terrain.get('summary', {}).get(b+'_mean') for b in ['aspect_sin','aspect_cos'])
        terrain.setdefault('summary', {})['aspect_deg_mean'] = (
            math.degrees(math.atan2(s,c)) % 360 if s is not None and c is not None
            and math.hypot(s,c) > 1e-6 else None)
        for field, unit in [('elevation_m','m'),('slope_deg','degree'),('aspect_deg','degree')]:
            add(field, unit, SRTM, terrain, field,
                {'start': '2000-02-11T00:00:00Z', 'end': '2000-02-23T00:00:00Z',
                 'convention': 'mission_window_not_pixel_acquisition'}, support,
                'SRTM v3 native-grid mean elevation/slope; circular aspect excluding flat pixels.',
                ['void_fill_pixel_provenance_unverified', 'terrain_may_have_changed_since_2000'],
                'reconstructed' if field == 'elevation_m' else 'calculated')
        burn = data.get('burn', {})
        for field, value, unit in [
            ('burn_date_day_of_year_distribution', burn.get('burn_date_histogram', {}).get('BurnDate'),
             'fraction_weighted_pixel_count_by_day_of_year'),
            ('burn_date_uncertainty_days', burn.get('summary', {}).get('Uncertainty_mean'), 'day'),
            ('monthly_burned_area_within_footprint_ha', burn.get('burned_area_ha'), 'ha'),
        ]:
            additions.append(make_measurement(field, value, unit,
                {'id': BURN, 'granule_id': burn.get('granule_id'), 'grid': burn.get('grid'),
                 'retrieved_at': retrieved_at, 'access_via': 'Google Earth Engine'}, burn,
                {'start': burn.get('start'), 'end': burn.get('end'), 'convention': 'calendar_month'},
                {'kind': support, 'raster_valid_fraction': burn.get('valid_coverage')},
                'Valid land QA bits required; day 0 means unburned; positive dates only for area '
                'and uncertainty. Extent restricted to GOFER footprint, not event-wide IoU.',
                ['retrospective_footprint', 'monthly_product_not_hourly_progression'] +
                (['no_newly_burned_footprint'] if record['footprint']['geometry'] is None else [])))
    additions.append(make_measurement('active_fire_detections', None, None,
        {'id': 'NASA/FIRMS/VIIRS', 'access_url': 'https://firms.modaps.eosdis.nasa.gov/download/'},
        None, dict(record['interval']), {'kind': 'not_evaluated'},
        'Not retrieved: FIRMS_MAP_KEY and Earthdata download credentials unavailable; '
        'no substitute raster detections used.', ['credentials_unavailable'], 'observed'))
    additions[-1]['retrieval_status'] = 'access_not_configured'
    # Re-running cannot silently overwrite reviewed or existing measurements.
    if any(m.get('processing_version') == TAG for m in record['measurements']):
        raise ValueError('NASA enrichment already present; use original backup to rerun')
    record['measurements'].extend(additions)
    pairs = []
    for support in ['newly_burned', 'ignition_point_context']:
        old = next((m for m in record['measurements'] if m['field']=='precipitation_mm'
                    and m['source']['id']=='ECMWF/ERA5_LAND/HOURLY'
                    and m['spatial_support']['kind']==support), None)
        new = next(m for m in additions if m['field']=='precipitation_mm'
                   and m['spatial_support']['kind']==support)
        delta = new['value']-old['value'] if old and old['value'] is not None and new['value'] is not None else None
        pairs.append({'field': 'precipitation_mm', 'spatial_support': support,
                      'source_a': IMERG, 'source_b': 'ECMWF/ERA5_LAND/HOURLY',
                      'difference_a_minus_b_mm': delta,
                      'interpretation': 'Same hour and geometry; different grids and methods, not ground truth.'})
    record['nasa_enrichment'] = {'processing_version': TAG, 'retrieved_at': retrieved_at,
        'comparisons': pairs, 'review_status': 'pending',
        'final_extent_iou': {'value': None, 'status': 'not_computed',
                            'reason': 'Monthly footprint summaries do not define an independent event perimeter.'}}


def run(root, project):
    import ee

    from .enrichment_core import write_json
    ee.Initialize(project=project)
    ee.data.setDeadline(120000)
    paths = sorted(root.glob('gofer-*/intervals.json'))
    if not paths:
        raise ValueError('No interval files found')
    for path in paths:
        records = json.loads(path.read_text())
        if any('nasa_enrichment' in r for r in records):
            print(f'{path.parent.name}: already enriched; skipped', flush=True)
            continue
        if len({r['interval_id'] for r in records}) != len(records):
            raise ValueError('Duplicate interval identity')
        original_bytes = path.read_bytes()
        fingerprint = hashlib.sha256(original_bytes).hexdigest()
        cache = root / 'raw' / 'nasa' / path.parent.name / fingerprint
        cache.mkdir(parents=True, exist_ok=True)
        backup = cache / 'intervals-before.json'
        if not backup.exists():
            backup.write_bytes(original_bytes)
        preview = path.with_name('intervals-simple.json')
        preview_bytes = preview.read_bytes() if preview.exists() else None
        for offset in range(0, len(records), 3):
            batch = records[offset:offset+3]
            raw_path = cache / f'batch-{offset:03d}.json'
            if raw_path.exists():
                raw = json.loads(raw_path.read_text())
            else:
                raw = {'retrieved_at': datetime.now(UTC).isoformat(), 'response': bounded_query(batch)}
                write_json(raw_path, raw)
            props = [f['properties'] for f in raw['response']['features']]
            lookup = {p['interval_id']: p for p in props}
            if len(lookup)!=len(batch) or set(lookup)!={r['interval_id'] for r in batch}:
                raise ValueError('NASA response interval identity mismatch')
            for record in batch:
                attach(record, lookup[record['interval_id']], raw['retrieved_at'])
            print(f'{path.parent.name}: {offset+len(batch)}/{len(records)} NASA intervals', flush=True)
        # Validate the contract and original prefix before replacing a complete event file.
        import jsonschema
        schema = json.loads((Path(__file__).resolve().parents[3] /
                             'contracts/enrichment-sidecar.schema.json').read_text())
        originals = json.loads(original_bytes)
        for old, new in zip(originals, records):
            jsonschema.validate(new, schema)
            for key, value in old.items():
                assert new[key][:len(value)]==value if key=='measurements' else new[key]==value
        if path.read_bytes()!=original_bytes:
            raise RuntimeError('Interval file changed during acquisition; refusing overwrite')
        temp = path.with_suffix('.nasa.tmp')
        write_json(temp, records)
        temp.replace(path)
        assert not preview.exists() if preview_bytes is None else preview.read_bytes()==preview_bytes
        print(f'{path.parent.name}: updated intervals.json; preview unchanged', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--project', required=True)
    args = parser.parse_args()
    run(args.data_dir, args.project)
