"""Import two NIFC perimeter snapshots, preserving raw evidence and unknown growth.

Run with --project to add Earth Engine context. No GOFER source files are edited.
"""
import argparse
import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

import jsonschema
from shapely.geometry import shape

from .enrichment_core import measurement, wind, write_json

SERVICE = ('https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/'
           'WFIGS_Interagency_Perimeters/FeatureServer/0')
TARGETS = {'2026-TXTXF-000138': ('Cypress Creek', 'US-TX'),
           '2026-COELX-000171': ('County Rd 169', 'US-CO')}
ACRE_HA = 0.40468564224
CONTRACT = Path(__file__).resolve().parents[3] / 'contracts/nifc-snapshot.schema.json'


def iso(milliseconds):
    return None if milliseconds is None else datetime.fromtimestamp(
        milliseconds / 1000, UTC).isoformat()


def hectares(acres):
    return None if acres is None else acres * ACRE_HA


def normalize(collection, provenance):
    if collection.get('error') or collection.get('exceededTransferLimit'):
        raise ValueError('NIFC error or truncated response; refusing partial import')
    records, seen, seen_events = [], set(), set()
    for feature in collection.get('features', []):
        p = feature['properties']
        identity = p.get('attr_UniqueFireIdentifier')
        if identity not in TARGETS:
            raise ValueError(f'Unexpected event: {identity}')
        expected_name, expected_state = TARGETS[identity]
        if (p.get('poly_IncidentName'), p.get('attr_POOState')) != (expected_name, expected_state):
            raise ValueError('Incident identity/name/state mismatch')
        observed = iso(p.get('poly_PolygonDateTime'))
        geometry = shape(feature['geometry'])
        if geometry.geom_type not in {'Polygon', 'MultiPolygon'} or geometry.is_empty or not geometry.is_valid:
            raise ValueError('Invalid perimeter; explicit geometry review required')
        xmin, ymin, xmax, ymax = geometry.bounds
        if not (-180 <= xmin <= xmax <= 180 and -90 <= ymin <= ymax <= 90):
            raise ValueError('Geometry is not longitude/latitude EPSG:4326')
        key = (identity, p.get('GlobalID') or p.get('poly_SourceGlobalID'))
        if not key[1] or key in seen:
            raise ValueError('Missing or duplicate source feature identity')
        if identity in seen_events:
            raise ValueError('Multiple perimeters for one event require explicit progression review')
        seen.add(key)
        seen_events.add(identity)
        flags = ['growth_history_unavailable', 'perimeter_context_not_newly_burned',
                 'perimeter_not_assumed_final', 'pending_review']
        if observed is None:
            flags.append('perimeter_observation_time_missing')
        polygon_acres, reported_acres = p.get('poly_GISAcres'), p.get('attr_IncidentSize')
        if polygon_acres is not None and reported_acres is not None and abs(polygon_acres - reported_acres) > 1:
            flags.append('reported_and_polygon_area_disagree')
        record = {
            'schema_version': '1.0', 'kind': 'perimeter_snapshot',
            'id': f'nifc:{identity}:{key[1]}', 'event_id': f'nifc:{identity}',
            'name': expected_name, 'year': int(identity[:4]),
            'region': f"{p.get('attr_POOCounty')} County, {'Texas' if expected_state == 'US-TX' else 'Colorado'}, USA",
            'observed_at': observed, 'source_updated_at': iso(p.get('poly_DateCurrent')),
            'discovered_at': iso(p.get('attr_FireDiscoveryDateTime')),
            'contained_at': iso(p.get('attr_ContainmentDateTime')),
            'reported_area_ha': hectares(reported_acres),
            'polygon_area_ha': hectares(polygon_acres),
            'growth_ha': None, 'newly_burned': None, 'perimeter': feature['geometry'],
            'source': provenance, 'original': feature, 'measurements': [], 'flags': flags,
        }
        for field, source_field, unit in [
            ('reported_fuel', 'attr_PrimaryFuelModel', None),
            ('reported_fire_behavior', 'attr_FireBehaviorGeneral', None),
            ('reported_area_ha', 'attr_IncidentSize', 'ha'),
            ('polygon_area_ha', 'poly_GISAcres', 'ha'),
        ]:
            native = p.get(source_field)
            record['measurements'].append(measurement(
                field, hectares(native) if unit == 'ha' else native, unit,
                'calculated' if unit == 'ha' else 'observed',
                {'id': 'NIFC/WFIGS', 'url': SERVICE, 'field': source_field}, native,
                {'observed_at': observed if source_field == 'poly_GISAcres' else None,
                 'record_updated_at': iso(p.get('attr_ModifiedOnDateTime_dt')),
                 'convention': 'source_report_no_assumed_hourly_validity'},
                {'kind': 'incident_report'}, 'Source field; acres × 0.40468564224 when applicable',
                ['report_not_hourly_measurement']))
        records.append(record)
    if {r['event_id'].removeprefix('nifc:') for r in records} != set(TARGETS):
        raise ValueError('One or more requested incidents missing')
    return records


def enrich(record, raw_dir):
    """Weather at the preceding whole hour; terrain/HLS over the cumulative polygon.

    The reusable NASA reducer takes a footprint geometry. Its output is explicitly
    stored as cumulative-perimeter context here, never as newly burned support.
    """
    import ee

    from .enrichment_ee import DEM, ERA, cached, geometry, summarize, weather_image
    from .enrichment_nasa import build_query

    if record['observed_at'] is None:
        record['flags'].append('enrichment_skipped_unknown_observation_time')
        return
    t = datetime.fromisoformat(record['observed_at']).replace(minute=0, second=0, microsecond=0)
    start, end = t.isoformat(), (t + timedelta(hours=1)).isoformat()
    g = geometry(record['perimeter'])
    p = record['original']['properties']
    proxy = {'interval_id': record['id'], 'interval': {'start': start, 'end': end},
             'footprint': {'geometry': record['perimeter']},
             'ignition_context': {'geometry': {'type': 'Point', 'coordinates':
                 [p['attr_InitialLongitude'], p['attr_InitialLatitude']]},
                 'source_record': {'tUTC': datetime.fromisoformat(record['discovered_at']).strftime('%Y-%m-%d %H:%M:%S')}}}
    support = {'kind': 'cumulative_perimeter_context', 'geometry_ref': record['id']}

    def add(field, value, unit, source, original, window, method, flags=(), **metadata):
        coverage = None
        if isinstance(original, dict):
            coverage = original.get('summary', original).get('valid_fraction')
        record['measurements'].append(measurement(
            field, value, unit, 'calculated', {'id': source, **metadata}, original,
            window, {**support, 'raster_valid_fraction': coverage}, method,
            ['context_only_not_growth_input', *flags,
                *(['partial_raster_coverage'] if coverage is not None and coverage < 0.999 else []),
                *(['no_valid_raster_support'] if value is None else [])]))

    def weather():
        image, grid = weather_image(proxy)
        return {'summary': summarize(image, grid, g).getInfo(), 'grid': grid.getInfo()}

    try:
        raw = cached(raw_dir / 'weather.json', weather)
        data = raw['summary']
        specs = [('temperature_c', 'temperature_2m', 'degC', lambda v: v - 273.15),
                 ('dewpoint_c', 'dewpoint_temperature_2m', 'degC', lambda v: v - 273.15),
                 ('relative_humidity_pct', 'relative_humidity_pct', '%', lambda v: v),
                 ('vpd_kpa', 'vpd_kpa', 'kPa', lambda v: v),
                 ('wind_speed_m_s', 'wind_speed_m_s', 'm/s', lambda v: v),
                 ('precipitation_mm', 'total_precipitation_hourly', 'mm', lambda v: v * 1000)]
        for field, band, unit, convert in specs:
            native = data.get(band + '_mean')
            window = {'start': start, 'end': end if field == 'precipitation_mm' else start,
                      'convention': 'accumulation_ending_at_end' if field == 'precipitation_mm'
                      else 'instantaneous_at_preceding_whole_hour'}
            add(field, convert(native) if native is not None else None, unit, ERA, data, window,
                'Native grid fraction-weighted mean; per-pixel humidity/VPD/speed; deterministic unit conversion',
                ['weather_context_not_interval_growth'], grid=raw['grid'],
                native_nominal_resolution_m=11132)
        _, direction = wind(data.get('u_component_of_wind_10m_mean'), data.get('v_component_of_wind_10m_mean'))
        add('wind_from_direction_deg', direction, 'degree', ERA, data,
            {'start': start, 'end': start}, 'Direction of mean wind vector, meteorological FROM true north')
    except (ee.EEException, OSError) as exc:
        record['flags'].append('weather_request_failed')
        write_json(raw_dir / 'weather-error.json', {'error': str(exc)})
        for field, unit in [('temperature_c', 'degC'), ('dewpoint_c', 'degC'),
                            ('relative_humidity_pct', '%'), ('vpd_kpa', 'kPa'),
                            ('wind_speed_m_s', 'm/s'), ('precipitation_mm', 'mm'),
                            ('wind_from_direction_deg', 'degree')]:
            add(field, None, unit, ERA, None, {'start': start, 'end': end},
                'Acquisition failed; no value substituted', ['source_request_failed'])

    def terrain():
        images = ee.ImageCollection(DEM).filterBounds(g).sort('system:index')
        grid = ee.Image(images.first()).select('elevation').projection()
        dem = images.mosaic().setDefaultProjection(grid)
        image = dem.rename('elevation_m').addBands(ee.Terrain.slope(dem).rename('slope_deg'))
        return {'summary': summarize(image, grid, g).getInfo(), 'grid': grid.getInfo(),
                'tiles': images.toList(100).map(lambda i: ee.Image(i).toDictionary(
                    ['system:index', 'system:time_start', 'system:time_end'])).getInfo()}

    try:
        raw = cached(raw_dir / 'terrain.json', terrain)
        for field, unit in [('elevation_m', 'm'), ('slope_deg', 'degree')]:
            flags = ['pixel_acquisition_date_unverified', 'retrospective_terrain_snapshot']
            if any(tile.get('system:time_end', 0) > datetime.fromisoformat(record['discovered_at']).timestamp() * 1000 for tile in raw['tiles']):
                flags.append('source_date_range_extends_after_event')
            add(field, raw['summary'].get(field + '_mean'), unit, DEM, raw,
                {'start': None, 'end': None, 'convention': 'acquisition_date_unverified'},
                'Native grid fraction-weighted mean; ee.Terrain slope', flags,
                grid=raw['grid'], tiles=raw['tiles'])
    except (ee.EEException, OSError) as exc:
        record['flags'].append('terrain_request_failed')
        write_json(raw_dir / 'terrain-error.json', {'error': str(exc)})
        for field, unit in [('elevation_m', 'm'), ('slope_deg', 'degree')]:
            add(field, None, unit, DEM, None, {'start': None, 'end': None},
                'Acquisition failed; no value substituted', ['source_request_failed'])

    try:
        raw = cached(raw_dir / 'hls.json', lambda: build_query([proxy], {'hls'}))
        hls = raw['features'][0]['properties']['newly_burned']['hls']
        for field in ['ndvi', 'ndmi', 'nbr']:
            add(field, hls.get('summary', {}).get(field + '_mean'), 'dimensionless',
                hls.get('collection', 'NASA/HLS/unavailable'), hls,
                {'acquired_at': iso(hls.get('timestamp')), 'convention': 'prefire_scene'},
                'Newest intersecting HLS scene in 30 days before discovery, tile cloud <20%; pixel QA; 30 m geometry simplification',
                [hls.get('status', 'scene_coverage_requires_review')], granule_id=hls.get('granule_id'),
                native_resolution_m=30)
    except (ee.EEException, OSError) as exc:
        record['flags'].append('hls_request_failed')
        write_json(raw_dir / 'hls-error.json', {'error': str(exc)})
        for field in ['ndvi', 'ndmi', 'nbr']:
            add(field, None, 'dimensionless', 'NASA/HLS/unavailable', None,
                {'start': None, 'end': None}, 'Acquisition failed; no value substituted',
                ['source_request_failed'])

    # Never substitute an old pilot fuel layer or convert a narrative fuel label to FBFM40.
    add('fuel_model_40', None, 'LANDFIRE FBFM40 code', 'LANDFIRE/unavailable', None,
        {'start': None, 'end': None}, 'Pre-event fuel-layer selection pending verification',
        ['historical_fuel_layer_not_verified'])


def run(root, project=None):
    where = 'attr_UniqueFireIdentifier IN (' + ','.join(f"'{key}'" for key in TARGETS) + ')'
    url = SERVICE + '/query?' + urlencode({'f': 'geojson', 'where': where, 'outFields': '*',
                                         'returnGeometry': 'true', 'outSR': 4326})
    raw_path = root / 'raw/source.geojson'
    meta_path = root / 'raw/retrieval.json'
    if raw_path.exists():
        raw_bytes, provenance = raw_path.read_bytes(), json.loads(meta_path.read_text())
        if hashlib.sha256(raw_bytes).hexdigest() != provenance['sha256']:
            raise ValueError('Raw source checksum mismatch')
    else:
        raw_bytes = urlopen(url, timeout=60).read()
        provenance = {'id': 'NIFC/WFIGS', 'url': url, 'retrieved_at': datetime.now(UTC).isoformat(),
                      'sha256': hashlib.sha256(raw_bytes).hexdigest()}
        normalize(json.loads(raw_bytes), provenance)  # Validate before caching.
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        raw_path.write_bytes(raw_bytes)
        write_json(meta_path, provenance)
    records = normalize(json.loads(raw_bytes), provenance)
    if project:
        import ee
        ee.Initialize(project=project)
    schema = json.loads(CONTRACT.read_text())
    for record in records:
        folder = root / record['event_id'].replace(':', '-')
        saved_path = folder / 'snapshot.json'
        if not project and saved_path.exists():
            existing = json.loads(saved_path.read_text())
            if existing['source']['sha256'] != provenance['sha256']:
                raise ValueError('Existing snapshot source differs from acquisition cache')
            record.update(existing)  # A metadata-only rerun must not erase enrichment.
        if project:
            enrich(record, folder / 'raw')
        elif not saved_path.exists():
            record['flags'].append('environmental_enrichment_not_requested')
        jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).validate(record)
        write_json(folder / 'snapshot.json', record)
        print(f"{record['name']}: {len(record['measurements'])} attributable measurements; growth unknown", flush=True)
    write_json(root / 'quality-report.json', {
        'source': provenance, 'records': len(records), 'distinct_fires': len(TARGETS),
        'hourly_growth_observations': 0,
        'interpretation': 'One service query, not an exhaustive search of all progression archives.',
        'events': [{'event_id': r['event_id'], 'observed_at': r['observed_at'],
                    'reported_area_ha': r['reported_area_ha'], 'polygon_area_ha': r['polygon_area_ha'],
                    'nonnull_measurements': sum(m['value'] is not None for m in r['measurements']),
                    'measurement_count': len(r['measurements']), 'flags': r['flags']} for r in records]})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--project')
    args = parser.parse_args()
    run(args.data_dir, args.project)
