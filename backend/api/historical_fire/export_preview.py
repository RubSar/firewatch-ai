"""Export the real GOFER pilot as a compact, static historical map library."""
import argparse
import hashlib
import io
import json
import zipfile
from pathlib import Path

import shapefile
from pyproj import Transformer
from shapely.geometry import mapping, shape
from shapely.ops import transform

from .enrichment_core import utc

TO_METERS = Transformer.from_crs(4326, 3310, always_xy=True).transform
TO_WGS84 = Transformer.from_crs(3310, 4326, always_xy=True).transform


def display_geometry(value):
    if value is None:
        return None
    simplified = transform(TO_METERS, shape(value)).simplify(20, preserve_topology=True)
    return mapping(transform(TO_WGS84, simplified))


def export(data_dir, archive_path, output, nifc_dir=None):
    paths = sorted(data_dir.glob('gofer-*/intervals.json'))
    if not paths:
        raise ValueError('No enriched interval files found')
    events = [(p, json.loads(p.read_text())) for p in paths]
    wanted = {(r['event_id'], r['interval']['end']) for _, rows in events for r in rows}
    perimeters = {}
    archive_hash = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    with zipfile.ZipFile(archive_path) as archive:
        base = 'GOFER/GOFER_Combined/GOFERC_fireProg'
        reader = shapefile.Reader(**{ext: io.BytesIO(archive.read(f'{base}.{ext}'))
                                   for ext in ('shp', 'shx', 'dbf')})
        for feature in reader.iterShapeRecords():
            attributes = feature.record.as_dict()
            key = (f"gofer:{int(attributes['fyear'])}:{attributes['fname']}",
                   utc(attributes['tUTC'], 'UTC'))
            if key in wanted:
                if key in perimeters:
                    raise ValueError(f'Duplicate perimeter: {key}')
                perimeters[key] = display_geometry(feature.shape.__geo_interface__)
    if set(perimeters) != wanted:
        raise ValueError('Missing source perimeters; do not reconstruct by accumulating growth')
    result = {'schema_version': '1.1', 'geometry_simplification_m': 20,
              'archive_sha256': archive_hash, 'events': []}
    for path, rows in events:
        rows.sort(key=lambda r: r['interval']['start'])
        intervals = []
        for row in rows:
            if row['original']['archive_sha256'] != archive_hash:
                raise ValueError('Enrichment and perimeter archive hashes differ')
            area = float(row['original']['summary_raw']['farea']) * 100
            measurements = [{
                'field': m['field'], 'value': m['value'], 'unit': m['unit'],
                'source': m['source']['id'], 'support': m['spatial_support']['kind'],
                'kind': m['kind'], 'time_window': m['time_window'],
                'flags': m['quality_flags'], 'review_status': m['review_status'],
                'retrieval_status': m.get('retrieval_status'),
            } for m in row['measurements']]
            intervals.append({
                'id': row['interval_id'], 'event_id': row['event_id'],
                'start': row['interval']['start'], 'end': row['interval']['end'],
                'area_ha': area, 'growth_ha': row['original']['growth_ha'],
                'perimeter': perimeters[row['event_id'], row['interval']['end']],
                'newly_burned': display_geometry(row['footprint']['geometry']),
                'measurements': measurements, 'flags': row['quality_flags'],
            })
        bounds = [shape(r['perimeter']).bounds for r in intervals]
        extent = [min(b[0] for b in bounds), min(b[1] for b in bounds),
                  max(b[2] for b in bounds), max(b[3] for b in bounds)]
        result['events'].append({
            'id': rows[0]['event_id'], 'name': rows[0]['event_id'].split(':')[-1],
            'year': int(rows[0]['event_id'].split(':')[1]), 'region': 'California, USA',
            'bounds': extent, 'intervals': intervals,
            'source_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        })
    if nifc_dir is not None:
        import jsonschema

        from .nifc import CONTRACT
        snapshot_schema = json.loads(CONTRACT.read_text())
        snapshot_paths = sorted(nifc_dir.glob('nifc-*/snapshot.json'))
        if not snapshot_paths:
            raise ValueError('No NIFC snapshots found in requested directory')
        to_meters = Transformer.from_crs(4326, 5070, always_xy=True).transform
        to_wgs84 = Transformer.from_crs(5070, 4326, always_xy=True).transform
        for path in snapshot_paths:
            snapshot = json.loads(path.read_text())
            jsonschema.validate(snapshot, snapshot_schema)
            # Preserve unknown observation dates as null; no fabricated timeline bounds.
            geometry = shape(snapshot['perimeter'])
            perimeter = mapping(transform(to_wgs84, transform(to_meters, geometry).simplify(
                20, preserve_topology=True)))
            result['events'].append({
                'id': snapshot['event_id'], 'name': snapshot['name'], 'year': snapshot['year'],
                'region': snapshot['region'], 'bounds': list(geometry.bounds),
                'source_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'intervals': [{
                    'id': snapshot['id'], 'event_id': snapshot['event_id'],
                    'kind': 'perimeter_snapshot', 'source_label': 'NIFC/WFIGS',
                    'start': None, 'end': snapshot['observed_at'],
                    'area_ha': snapshot['polygon_area_ha'], 'growth_ha': None,
                    'perimeter': perimeter, 'newly_burned': None,
                    'flags': snapshot['flags'],
                    'incident': {k: snapshot[k] for k in ['discovered_at', 'contained_at',
                        'reported_area_ha', 'source_updated_at', 'source']},
                    'measurements': [{
                        'field': m['field'], 'value': m['value'], 'unit': m['unit'],
                        'source': m['source']['id'], 'support': m['spatial_support']['kind'],
                        'kind': m['kind'], 'time_window': m['time_window'],
                        'flags': m['quality_flags'], 'review_status': m['review_status'],
                        'retrieval_status': 'available' if m['value'] is not None else 'unavailable',
                    } for m in snapshot['measurements']],
                }],
            })
    event_ids = [e['id'] for e in result['events']]
    if len(event_ids) != len(set(event_ids)):
        raise ValueError('Duplicate event IDs')
    ids = [r['id'] for e in result['events'] for r in e['intervals']]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate interval IDs')
    import jsonschema
    schema = json.loads((Path(__file__).resolve().parents[3] /
                         'contracts/historical-preview.schema.json').read_text())
    jsonschema.validate(result, schema)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, separators=(',', ':'), allow_nan=False) + '\n')
    print(f'Exported {len(ids)} historical records / {len(result["events"])} fires / {output.stat().st_size:,} bytes')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--nifc-dir', type=Path)
    args = parser.parse_args()
    export(args.data_dir, args.archive, args.output, args.nifc_dir)
