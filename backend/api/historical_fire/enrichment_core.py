"""Deterministic historical enrichment primitives; no prediction or imputation."""
import hashlib
import io
import json
import math
import zipfile
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import shapefile
from pyproj import Transformer
from shapely.geometry import mapping, shape
from shapely.ops import transform

PILOT = (("Creek", 2020), ("Kincade", 2019), ("Bobcat", 2020))
AREA_TRANSFORM = Transformer.from_crs(4326, 3310, always_xy=True).transform


def digest(data):
    return hashlib.sha256(data).hexdigest()


def utc(value, zone=None, fold=None):
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        if zone is None:
            raise ValueError("A naive timestamp requires an explicit time zone")
        tz = ZoneInfo(zone)
        a, b = dt.replace(tzinfo=tz, fold=0), dt.replace(tzinfo=tz, fold=1)
        if a.utcoffset() != b.utcoffset() and fold is None:
            raise ValueError("Ambiguous or nonexistent local time requires review")
        dt = dt.replace(tzinfo=tz, fold=fold or 0)
        if dt.astimezone(UTC).astimezone(tz).replace(tzinfo=None) != dt.replace(tzinfo=None):
            raise ValueError("Nonexistent local time")
    return dt.astimezone(UTC).isoformat()


def wind(u, v):
    if u is None or v is None:
        return None, None
    speed = math.hypot(u, v)
    return speed, (math.degrees(math.atan2(-u, -v)) % 360 if speed >= 0.1 else None)


def humidity(temperature_k, dewpoint_k):
    if temperature_k is None or dewpoint_k is None:
        return None, None
    t, td = temperature_k - 273.15, dewpoint_k - 273.15
    es = 0.61094 * math.exp(17.625 * t / (243.04 + t))
    ea = 0.61094 * math.exp(17.625 * td / (243.04 + td))
    return 100 * ea / es, es - ea


def precipitation_mm(hourly_m):
    # Do not clamp negative reanalysis artefacts or difference this hourly band twice.
    return None if hourly_m is None else hourly_m * 1000


def area_ha(geometry):
    return transform(AREA_TRANSFORM, geometry).area / 10000


def newly_burned(start, end, growth_ha):
    if not start.is_valid or not end.is_valid:
        raise ValueError("Invalid GOFER geometry; requires explicit repair and provenance")
    difference = end.difference(start)
    flags = []
    removed = area_ha(start.difference(end))
    if removed > 0.01:
        flags.append("non_nested_perimeters")
    if growth_ha == 0:
        if area_ha(difference) > 0.01:
            flags.append("zero_reported_growth_with_geometry_change")
        return None, flags
    if difference.is_empty:
        return None, flags + ["positive_reported_growth_without_footprint"]
    if abs(area_ha(difference) - growth_ha) > max(1, 0.05 * growth_ha):
        flags.append("geometry_vs_reported_area_disagreement")
    return mapping(difference), flags


def load_pilot(archive_path, summary_path, limit=72):
    from .adapters import import_gofer
    records, _ = import_gofer(summary_path)
    records = [r for r in records if (r['event_id'].split(':')[-1], r['year']) in PILOT]
    archive_bytes = archive_path.read_bytes()
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        def reader(name):
            base = f"GOFER/GOFER_Combined/GOFERC_{name}"
            return shapefile.Reader(**{ext: io.BytesIO(archive.read(f'{base}.{ext}'))
                                       for ext in ('shp', 'shx', 'dbf')})
        progress, ignitions = {}, {}
        for sr in reader('fireProg').iterShapeRecords():
            raw = sr.record.as_dict()
            name, year = raw['fname'], int(raw['fyear'])
            if (name, year) not in PILOT:
                continue
            key = f'gofer:{year}:{name}', utc(raw['tUTC'], 'UTC')
            if key in progress:
                raise ValueError(f'Duplicate perimeter identity: {key}')
            progress[key] = (shape(sr.shape.__geo_interface__), raw)
        for sr in reader('fireIg').iterShapeRecords():
            raw = sr.record.as_dict()
            if (raw['fname'], int(raw['fyear'])) in PILOT:
                key = f"gofer:{int(raw['fyear'])}:{raw['fname']}"
                candidate = (float(raw['timestep']), sr.shape.__geo_interface__, raw)
                if key not in ignitions or candidate[0] < ignitions[key][0]:
                    ignitions[key] = candidate
    output = []
    for name, year in PILOT:
        event = f'gofer:{year}:{name}'
        selected = sorted((r for r in records if r['event_id'] == event),
                          key=lambda r: r['interval']['start'])[:limit]
        if len(selected) != limit:
            raise ValueError(f'{event}: expected {limit} available intervals')
        final_key = max((k for k in progress if k[0] == event), key=lambda k: k[1])
        for r in selected:
            start, end = r['interval']['start'], r['interval']['end']
            if datetime.fromisoformat(end) - datetime.fromisoformat(start) != timedelta(hours=1):
                raise ValueError('GOFER interval is not exactly one hour')
            a, b = progress[event, start], progress[event, end]
            if abs(float(b[1]['farea']) * 100 - r['state']['starting_area_ha']
                   - r['outcome']['growth_ha']) > 0.11:
                raise ValueError('Summary and geometry attributes disagree')
            geom, flags = newly_burned(a[0], b[0], r['outcome']['growth_ha'])
            output.append({
                'schema_version': '1.0', 'event_id': event,
                'interval_id': f'{event}/{start}/{end}', 'interval': r['interval'],
                'original': {'summary_sha256': r['provenance']['sha256'],
                             'archive_sha256': digest(archive_bytes),
                             'summary_raw': r['provenance']['raw'],
                             'growth_ha': r['outcome']['growth_ha']},
                'footprint': {'kind': 'newly_burned', 'crs': 'EPSG:4326',
                              'geometry': geom, 'area_ha': area_ha(shape(geom)) if geom else None,
                              'method': 'GOFERC P_end minus P_start; EPSG:3310 areas'},
                'ignition_context': {'geometry': ignitions[event][1],
                                     'source_record': ignitions[event][2]},
                'measurements': [], 'quality_flags': flags,
            'final_perimeter': {'timestamp': final_key[1],
                                    'geometry': mapping(progress[final_key][0])},
            })
    return output


def measurement(field, value, unit, kind, source, original, window, footprint, method,
                flags=(), evidence=None):
    if value is not None and isinstance(value, float) and not math.isfinite(value):
        raise ValueError('Non-finite measurement')
    return {'field': field, 'value': value, 'unit': unit, 'kind': kind,
            'source': source, 'original': original, 'time_window': window,
            'spatial_support': footprint, 'method': method, 'quality_flags': list(flags),
            'evidence': evidence or [], 'review_status': 'pending', 'conflicts': []}


def comparison(a, b):
    aa, bb = area_ha(a), area_ha(b)
    intersection, union = area_ha(a.intersection(b)), area_ha(a.union(b))
    return {'gofer_area_ha': aa, 'mtbs_area_ha': bb,
            'intersection_ha': intersection, 'union_ha': union,
            'intersection_over_union': intersection / union if union else None,
            'gofer_only_ha': aa - intersection, 'mtbs_only_ha': bb - intersection,
            'interpretation': 'Final extent only; not hourly progression validation'}


def without_coordinates(value):
    """Copy JSON for preview, omitting GeoJSON coordinates and ArcGIS point positions."""
    if isinstance(value, dict):
        omitted = {"coordinates"}
        if {"x", "y", "spatialReference"} <= value.keys():
            omitted.update({"x", "y", "z", "m"})
        return {key: without_coordinates(item)
                for key, item in value.items() if key not in omitted}
    if isinstance(value, list):
        return [without_coordinates(item) for item in value]
    return value


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')
