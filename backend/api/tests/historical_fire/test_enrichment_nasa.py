import copy
import json
from pathlib import Path

import pytest

from historical_fire.enrichment_nasa import accumulated_rain, attach, smap_window


def test_rain_requires_complete_nonnegative_half_hour_rates():
    assert accumulated_rain([2, 6], 2) == 4
    assert accumulated_rain([0, 0], 2) == 0
    assert accumulated_rain([2], 2) is None
    assert accumulated_rain([2, None], 2) is None
    assert accumulated_rain([2, -1], 2) is None


def test_smap_window_converts_timezone_and_keeps_three_hours():
    assert smap_window('2020-09-05T05:00:00-07:00') == (
        '2020-09-05T12:00:00+00:00', '2020-09-05T15:00:00+00:00')
    assert smap_window('2020-09-05T23:00:00Z') == (
        '2020-09-05T21:00:00+00:00', '2020-09-06T00:00:00+00:00')


def test_missing_footprints_and_sources_do_not_become_zero_or_overwrite():
    record = {'interval': {'start': '2020-09-05T01:00:00Z',
                           'end': '2020-09-05T02:00:00Z'},
              'footprint': {'geometry': None}, 'original': {'growth_ha': 0},
              'measurements': [{'field': 'precipitation_mm', 'value': 2,
                                'source': {'id': 'ECMWF/ERA5_LAND/HOURLY'},
                                'spatial_support': {'kind': 'ignition_point_context'}}]}
    old = copy.deepcopy(record)
    attach(record, {}, '2026-09-27T00:00:00Z')
    assert record['measurements'][0] == old['measurements'][0]
    assert record['original'] == old['original']
    assert len(record['measurements']) == 21
    assert all(m['value'] is None for m in record['measurements'][1:])
    assert record['measurements'][-1]['retrieval_status'] == 'access_not_configured'
    assert all(p['difference_a_minus_b_mm'] is None for p in record['nasa_enrichment']['comparisons'])
    with pytest.raises(ValueError, match='already present'):
        attach(record, {}, '2026-09-27T00:00:00Z')


def test_runner_preserves_preview_and_original_fields_and_skips_rerun(tmp_path, monkeypatch):
    import ee

    from historical_fire import enrichment_nasa

    fixture = Path(__file__).resolve().parents[4] / 'contracts/examples/enriched-creek-2020-hour.json'
    old = json.loads(fixture.read_text())
    folder = tmp_path / 'gofer-2020-Creek'
    folder.mkdir()
    target = folder / 'intervals.json'
    target.write_text(json.dumps([old]))
    original_bytes = target.read_bytes()
    preview = folder / 'intervals-simple.json'
    preview.write_bytes(b'preview must stay byte-identical\n')
    monkeypatch.setattr(ee, 'Initialize', lambda **kwargs: None)
    monkeypatch.setattr(ee.data, 'setDeadline', lambda deadline: None)
    monkeypatch.setattr(enrichment_nasa, 'bounded_query', lambda rows: {
        'features': [{'properties': {'interval_id': r['interval_id']}} for r in rows]})
    enrichment_nasa.run(tmp_path, 'offline-test')
    enriched = json.loads(target.read_text())[0]
    assert enriched['measurements'][:len(old['measurements'])] == old['measurements']
    assert enriched['original'] == old['original']
    assert preview.read_bytes() == b'preview must stay byte-identical\n'
    assert next((tmp_path / 'raw').rglob('intervals-before.json')).read_bytes() == original_bytes
    completed = target.read_bytes()
    enrichment_nasa.run(tmp_path, 'offline-test')
    assert target.read_bytes() == completed
