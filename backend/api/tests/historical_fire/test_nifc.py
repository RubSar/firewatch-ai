import copy
import json

import jsonschema
import pytest

from historical_fire.nifc import CONTRACT, TARGETS, hectares, iso, normalize


def source():
    return {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [[
            [-95, 31], [-94, 31], [-94, 32], [-95, 31]]]}, 'properties': {
                'attr_UniqueFireIdentifier': key, 'poly_IncidentName': name,
                'attr_POOState': state, 'GlobalID': key, 'poly_GISAcres': 100,
                'attr_IncidentSize': 110, 'poly_PolygonDateTime': 1772191200000,
                'poly_DateCurrent': 1772403653000,
            }} for key, (name, state) in TARGETS.items()]}


def provenance():
    return {'id': 'test-fixture', 'url': 'https://example.invalid',
            'retrieved_at': '2026-09-27T00:00:00Z', 'sha256': 'a' * 64}


def test_conversion_preserves_unknown_and_source_time():
    assert hectares(None) is None
    assert hectares(0) == 0
    assert hectares(6754) == pytest.approx(2733.24682768896)
    assert iso(1772191200000) == '2026-02-27T11:20:00+00:00'
    raw = source()
    original = copy.deepcopy(raw)
    records = normalize(raw, provenance())
    assert raw == original
    r = records[0]
    assert r['growth_ha'] is None and r['newly_burned'] is None
    assert r['observed_at'] != r['source_updated_at']
    assert 'reported_and_polygon_area_disagree' in r['flags']
    assert all(m['spatial_support']['kind'] == 'incident_report' for m in r['measurements'])
    schema = json.loads(CONTRACT.read_text())
    for record in records:
        jsonschema.validate(record, schema)
    r['growth_ha'] = 0
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(r, schema)


def test_unknown_observation_date_never_uses_edit_date():
    raw = source()
    raw['features'][0]['properties']['poly_PolygonDateTime'] = None
    r = normalize(raw, provenance())[0]
    assert r['observed_at'] is None
    assert 'perimeter_observation_time_missing' in r['flags']


@pytest.mark.parametrize('failure', ['duplicate', 'multiple_perimeters', 'missing', 'truncated', 'identity', 'geometry'])
def test_reject_invalid_or_ambiguous_import(failure):
    raw = source()
    if failure == 'duplicate':
        raw['features'].append(copy.deepcopy(raw['features'][0]))
    elif failure == 'multiple_perimeters':
        another = copy.deepcopy(raw['features'][0])
        another['properties']['GlobalID'] = 'another-perimeter'
        raw['features'].append(another)
    elif failure == 'missing':
        raw['features'].pop()
    elif failure == 'truncated':
        raw['exceededTransferLimit'] = True
    elif failure == 'identity':
        raw['features'][0]['properties']['attr_POOState'] = 'US-CA'
    else:
        raw['features'][0]['geometry']['coordinates'][0][0][0] = -1000
    with pytest.raises(ValueError):
        normalize(raw, provenance())
