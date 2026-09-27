"""Earth Engine acquisition at native raster grids, with resumable raw responses."""
import json
import math
from datetime import UTC, datetime

import ee
from shapely.geometry import shape

from .enrichment_core import comparison, digest, measurement, write_json

ERA = 'ECMWF/ERA5_LAND/HOURLY'
DEM = 'USGS/3DEP/10m_collection'
MTBS = 'USFS/GTAC/MTBS/burned_area_boundaries/v1'
RAW_BANDS = ['temperature_2m', 'dewpoint_temperature_2m',
             'u_component_of_wind_10m', 'v_component_of_wind_10m']
NATIVE_UNITS = {'temperature_2m': 'K', 'dewpoint_temperature_2m': 'K',
                'total_precipitation_hourly': 'm', 'u_component_of_wind_10m': 'm/s',
                'v_component_of_wind_10m': 'm/s'}


def cached(path, build):
    if path.exists():
        return json.loads(path.read_text())
    data = build()
    write_json(path, data)
    return data


def geometry(value):
    return ee.Geometry(value, proj='EPSG:4326', **({'geodesic': False} if value['type'] not in {'Point', 'MultiPoint'} else {}))


def weather_image(record):
    start, end = record['interval']['start'], record['interval']['end']
    # Instantaneous fields at interval start; hourly precipitation ending at interval end.
    a = ee.Image(ee.ImageCollection(ERA).filterDate(start, end).first())
    b = ee.Image(ee.ImageCollection(ERA).filterDate(ee.Date(end),
                 ee.Date(end).advance(1, 'hour')).first())
    t = a.select('temperature_2m').subtract(273.15)
    td = a.select('dewpoint_temperature_2m').subtract(273.15)
    es = t.multiply(17.625).divide(t.add(243.04)).exp().multiply(0.61094)
    ea = td.multiply(17.625).divide(td.add(243.04)).exp().multiply(0.61094)
    u, v = a.select(RAW_BANDS[2]), a.select(RAW_BANDS[3])
    image = a.select(RAW_BANDS).addBands([
        b.select('total_precipitation_hourly'),
        ea.divide(es).multiply(100).rename('relative_humidity_pct'),
        es.subtract(ea).rename('vpd_kpa'),
        u.pow(2).add(v.pow(2)).sqrt().rename('wind_speed_m_s'),
    ])
    return image, a.select('temperature_2m').projection()


def summarize(image, projection, geom, tile_scale=4):
    reducer = ee.Reducer.mean().combine(ee.Reducer.count(), sharedInputs=True)
    result = image.reduceRegion(reducer, geometry=geom, crs=projection,
                                maxPixels=100000000, tileScale=tile_scale)
    # Counts use pixel centers; means are fraction-weighted. A positive mean may have zero centers.
    coverage = image.mask().reduce(ee.Reducer.min()).rename('valid').unmask(0)
    valid_fraction = coverage.reduceRegion(
        ee.Reducer.mean(), geometry=geom, crs=projection,
        maxPixels=100000000, tileScale=tile_scale).get('valid')
    result = result.set('valid_fraction', ee.Algorithms.If(
        ee.Algorithms.IsEqual(valid_fraction, None), 0, valid_fraction))
    return result


def acquire_event(records, cache_dir):
    event = records[0]['event_id']
    event_dir = cache_dir / event.replace(':', '-')
    final_geom = geometry(records[0]['final_perimeter']['geometry'])
    dem_collection = ee.ImageCollection(DEM).filterBounds(final_geom).sort('system:index')
    projection = ee.Image(dem_collection.first()).select('elevation').projection()
    dem = dem_collection.mosaic().setDefaultProjection(projection)
    slope = ee.Terrain.slope(dem).rename('slope_deg')
    aspect = ee.Terrain.aspect(dem).updateMask(slope.gt(0)).multiply(math.pi / 180)
    terrain = dem.rename('elevation_m').addBands([
        slope, aspect.sin().rename('aspect_sin'), aspect.cos().rename('aspect_cos')])
    metadata = cached(event_dir / 'metadata.json', lambda: {
        'terrain': dem_collection.toList(20).map(lambda i: ee.Image(i).toDictionary(
            ['system:index', 'system:time_start', 'system:time_end'])).getInfo(),
        'terrain_projection': projection.getInfo(),
        'era_projection': weather_image(records[0])[1].getInfo(),
        'mtbs': ee.FeatureCollection(MTBS).filterBounds(final_geom).filter(
            ee.Filter.eq('Incid_Name', event.split(':')[-1].upper())).filter(
            ee.Filter.gte('Ig_Date', ee.Date(f'{event.split(":")[1]}-01-01').millis())).filter(
            ee.Filter.lt('Ig_Date', ee.Date(f'{int(event.split(":")[1])+1}-01-01').millis()))
            .getInfo(),
    })
    for offset in range(0, len(records), 6):
        batch = records[offset:offset + 6]
        cache_key = digest(json.dumps([r['interval_id'] for r in batch]).encode())[:16]
        def compute(batch=batch):
            features = []
            for r in batch:
                image, grid = weather_image(r)
                props = {'interval_id': r['interval_id'], 'context': summarize(
                    image, grid, geometry(r['ignition_context']['geometry']))}
                if r['footprint']['geometry'] is not None:
                    g = geometry(r['footprint']['geometry'])
                    props['weather'] = summarize(image, grid, g)
                    props['terrain'] = summarize(terrain, projection, g)
                features.append(ee.Feature(None, props))
            return ee.FeatureCollection(features).getInfo()
        raw = cached(event_dir / f'batch-{offset:03d}-{cache_key}.json', compute)
        by_id = {f['properties']['interval_id']: f['properties'] for f in raw['features']}
        if len(by_id) != len(batch):
            raise ValueError('Duplicate/missing Earth Engine interval identity')
        for r in batch:
            attach(r, by_id[r['interval_id']], metadata)
        print(f'{event}: {offset + len(batch)}/{len(records)} intervals enriched', flush=True)
    candidates = metadata['mtbs']['features']
    if len(candidates) == 1:
        mtbs = candidates[0]
        extent = comparison(shape(records[0]['final_perimeter']['geometry']),
                            shape(mtbs['geometry']))
        extent.update(source=MTBS, source_properties=mtbs['properties'],
                      source_geometry=mtbs['geometry'], review_status='pending')
    else:
        extent = {'status': 'missing' if not candidates else 'ambiguous',
                  'candidate_count': len(candidates), 'source': MTBS}
    return {'event_id': event, 'metadata': metadata, 'final_extent_comparison': extent}


def attach(record, raw, metadata):
    specs = [
        ('temperature_c', 'temperature_2m', 'degC', lambda x: x - 273.15),
        ('dewpoint_c', 'dewpoint_temperature_2m', 'degC', lambda x: x - 273.15),
        ('precipitation_mm', 'total_precipitation_hourly', 'mm', lambda x: x * 1000),
        ('wind_u_m_s', RAW_BANDS[2], 'm/s', lambda x: x),
        ('wind_v_m_s', RAW_BANDS[3], 'm/s', lambda x: x),
        ('relative_humidity_pct', 'relative_humidity_pct', '%', lambda x: x),
        ('vpd_kpa', 'vpd_kpa', 'kPa', lambda x: x),
        ('wind_speed_m_s', 'wind_speed_m_s', 'm/s', lambda x: x),
    ]
    for support, key in [('newly_burned', 'weather'), ('ignition_point_context', 'context')]:
        data = raw.get(key, {})
        for field, band, unit, convert in specs:
            native = data.get(band + '_mean')
            flags = []
            if support == 'ignition_point_context':
                flags.append('context_only_not_footprint_summary')
            if native is None:
                flags.append('no_newly_burned_footprint' if record['footprint']['geometry'] is None
                             and support == 'newly_burned' else 'no_raster_support')
            if native is not None and band == 'total_precipitation_hourly' and native < 0:
                flags.append('negative_reanalysis_precipitation')
            if data.get('valid_fraction') is not None and data['valid_fraction'] < 0.999:
                flags.append('partial_raster_coverage')
            window = {'start': record['interval']['start'],
                      'end': record['interval']['end'] if field == 'precipitation_mm'
                      else record['interval']['start'],
                      'convention': 'accumulation_ending_at_end' if field == 'precipitation_mm'
                      else 'instantaneous_at_interval_start'}
            derived = band in {'relative_humidity_pct', 'vpd_kpa', 'wind_speed_m_s'}
            source_bands = RAW_BANDS[:2] if band in {'relative_humidity_pct', 'vpd_kpa'} else (
                RAW_BANDS[2:] if band == 'wind_speed_m_s' else [band])
            original = {b: data.get(b + '_mean') for b in source_bands}
            record['measurements'].append(measurement(
                field, None if native is None else convert(native), unit,
                'calculated' if derived or field in {'temperature_c','dewpoint_c','precipitation_mm'}
                else 'reconstructed',
                {'id': ERA, 'version': 'Earth Engine catalog snapshot at retrieval',
                 'independence_group': 'ECMWF_ERA5_LAND', 'band': band,
                 'native_unit': 'formula input bands' if derived else NATIVE_UNITS[band],
                 'native_units': {b: NATIVE_UNITS[b] for b in source_bands},
                 'grid': metadata['era_projection'], 'native_nominal_resolution_m': 11132},
                original, window,
                {'kind': support, 'pixel_center_count': data.get(band + '_count'),
                 'raster_valid_fraction': data.get('valid_fraction')},
                'Native grid fraction-weighted mean; derived humidity/VPD/speed computed per pixel'
                if derived else 'Native grid fraction-weighted mean, deterministic unit conversion',
                flags))
        u, v = data.get(RAW_BANDS[2] + '_mean'), data.get(RAW_BANDS[3] + '_mean')
        from .enrichment_core import wind
        _, direction = wind(u, v)
        record['measurements'].append(measurement(
            'wind_from_direction_deg', direction, 'degree', 'calculated',
            {'id': ERA, 'version': 'Earth Engine catalog snapshot at retrieval',
             'independence_group': 'ECMWF_ERA5_LAND',
             'native_units': {RAW_BANDS[2]: 'm/s', RAW_BANDS[3]: 'm/s'}}, {'u_m_s': u, 'v_m_s': v},
            {'start': record['interval']['start'], 'end': record['interval']['start'],
             'convention': 'instantaneous_at_interval_start'}, {'kind': support},
            'atan2(-mean(u),-mean(v)) modulo 360; meteorological FROM, true north; calm<0.1m/s=null',
            ['direction_of_mean_vector_not_mean_of_angles'] + (
                ['missing_or_calm_wind'] if direction is None else [])))
    data = raw.get('terrain', {})
    event_year = int(record['event_id'].split(':')[1])
    # Collection dates cover source ranges, not pixel-level acquisition dates.
    terrain_flags = ['pixel_acquisition_date_unverified', 'retrospective_terrain_snapshot']
    if any(datetime.fromtimestamp(m['system:time_end']/1000, tz=UTC).year > event_year
           for m in metadata['terrain'] if 'system:time_end' in m):
        terrain_flags.append('source_date_range_extends_after_event')
    for field, unit in [('elevation_m', 'm'), ('slope_deg', 'degree'), ('aspect_deg', 'degree')]:
        value = data.get(field + '_mean')
        if field == 'aspect_deg':
            s, c = data.get('aspect_sin_mean'), data.get('aspect_cos_mean')
            value = math.degrees(math.atan2(s,c)) % 360 if s is not None and c is not None \
                and math.hypot(s,c) > 1e-6 else None
        record['measurements'].append(measurement(
            field, value, unit, 'reconstructed' if field == 'elevation_m' else 'calculated',
            {'id': DEM, 'version': 'Earth Engine catalog snapshot at retrieval',
             'tiles': metadata['terrain'], 'grid': metadata['terrain_projection']},
            data, {'start': None, 'end': None, 'convention': 'acquisition_date_unverified'},
            {'kind': 'newly_burned', 'raster_valid_fraction': data.get('valid_fraction')},
            'Native grid mean; ee.Terrain slope; circular aspect mean excluding flat pixels',
            terrain_flags + ([] if value is not None else ['no_footprint_or_raster_support'])))
