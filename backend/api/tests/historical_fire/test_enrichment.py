import json
from pathlib import Path

import pytest
from shapely.geometry import Polygon, shape

from historical_fire.enrichment_core import (
    humidity,
    newly_burned,
    precipitation_mm,
    utc,
    wind,
)
from historical_fire.landfire import arcgis_geometry


def test_time_conversion_utc_and_ambiguous_daylight_saving():
    assert utc("2020-09-05T00:00:00", "America/Los_Angeles") == "2020-09-05T07:00:00+00:00"
    with pytest.raises(ValueError, match="Ambiguous"):
        utc("2020-11-01T01:30:00", "America/Los_Angeles")
    assert utc("2020-11-01T01:30:00", "America/Los_Angeles", fold=1) == \
        "2020-11-01T09:30:00+00:00"


def test_wind_from_convention_and_calm():
    assert wind(0, -5) == pytest.approx((5, 0))  # wind blowing toward north, from south
    assert wind(-5, 0) == pytest.approx((5, 90))
    assert wind(0, 0) == (0, None)
    assert wind(None, 1) == (None, None)


def test_temperature_humidity_vpd_and_precipitation_units():
    rh, vpd = humidity(303.15, 293.15)
    assert rh == pytest.approx(55.1, abs=0.3)
    assert vpd == pytest.approx(1.90, abs=0.03)
    assert precipitation_mm(0.001) == 1
    assert precipitation_mm(None) is None
    assert precipitation_mm(-0.0001) == pytest.approx(-0.1)  # preserve reanalysis artifact


def test_reconstructed_footprint_and_zero_growth_missingness():
    start = Polygon([(0, 0), (0.1, 0), (0.1, 0.1), (0, 0.1)])
    end = Polygon([(0, 0), (0.2, 0), (0.2, 0.1), (0, 0.1)])
    geo, flags = newly_burned(start, end, 1000)
    assert shape(geo).area > 0
    assert "geometry_vs_reported_area_disagreement" in flags
    geo, flags = newly_burned(start, end, 0)
    assert geo is None
    assert "zero_reported_growth_with_geometry_change" in flags


def test_landfire_geometry_join_uses_polygon_ring_and_30m_source_grid():
    polygon = Polygon([( -120, 37), (-119.99, 37), (-119.99, 37.01), (-120, 37.01)])
    result = arcgis_geometry(json.loads(json.dumps({"type": "Polygon", "coordinates":
        [[list(p) for p in polygon.exterior.coords]]})) )
    assert result["spatialReference"]["wkid"] == 5070
    assert len(result["rings"]) == 1
    assert result["rings"][0][0] == result["rings"][0][-1]


def test_landfire_dispatches_each_task_to_its_own_source_layer(tmp_path, monkeypatch):
    from historical_fire import landfire

    record = {
        "event_id": "gofer:2020:Creek", "interval_id": "interval-1", "measurements": [],
        "footprint": {"geometry": {"type": "Polygon", "coordinates": [[
            [-120, 37], [-119.99, 37], [-119.99, 37.01], [-120, 37.01], [-120, 37]
        ]]}},
    }
    requested = []

    def fake_query(layer, geometry):
        requested.append(layer)
        kind = next(spec[1] for spec in landfire.LAYERS.values() if spec[0] == layer)
        if kind == "categorical":
            return {"samples": [{"value": layer}]}
        return {"statistics": [{"count": 1, "mean": 20}], "histograms": []}

    monkeypatch.setattr(landfire, "query", fake_query)
    result = landfire.enrich([record], tmp_path, workers=4)
    assert result["completed"] == len(landfire.LAYERS)
    assert set(requested) == {spec[0] for spec in landfire.LAYERS.values()}
    by_field = {m["field"]: m for m in record["measurements"]}
    for field, spec in landfire.LAYERS.items():
        assert by_field[field]["source"]["id"].endswith(spec[0])
        if spec[1] == "categorical":
            assert list(by_field[field]["value"]["class_sample_counts"]) == [spec[0]]
    assert by_field["canopy_height_m"]["value"] == 2
    assert by_field["canopy_bulk_density_kg_m3"]["value"] == pytest.approx(0.2)


def test_sidecar_schema_accepts_null_measurements_and_provenance():
    import jsonschema
    root = Path(__file__).parents[4]
    schema = json.loads((root / "contracts/enrichment-sidecar.schema.json").read_text())
    example = {
        "schema_version": "1.0", "event_id": "gofer:2020:Creek", "interval_id": "hour-1",
        "footprint": {"kind": "newly_burned", "crs": "EPSG:4326", "geometry": None,
                       "area_ha": None, "method": "perimeter difference"},
        "measurements": [{"field": "temperature_c", "value": None, "unit": "degC",
                           "kind": "reconstructed", "source": {"id": "ERA5-Land"},
                           "original": {}, "time_window": {}, "spatial_support": {"kind": "newly_burned"},
                           "method": "native-grid mean", "quality_flags": ["no_raster_support"],
                           "evidence": [], "review_status": "pending", "conflicts": []}],
        "quality_flags": []
    }
    jsonschema.validate(example, schema)


def test_document_extraction_requires_verbatim_evidence_and_stays_pending(tmp_path, monkeypatch):
    import sys

    root = Path(__file__).parents[4]
    sys.path.insert(0, str(root / "backend/llm"))
    import historical_documents

    pdf = tmp_path / "report.pdf"
    pdf.write_bytes(b"fixture bytes")
    monkeypatch.setattr(historical_documents, "pages", lambda _: [{
        "page": 3, "text": "Official report states: Temperature was approximately 80 F. "
        + "Additional verified source context. " * 8
    }])

    def transport(model, messages):
        return json.dumps({"facts": [
            {"field": "temperature", "supporting_quote": "approximately 80 F.",
             "value_as_written": "approximately 80", "unit_as_written": "F"},
            {"field": "wind_speed", "supporting_quote": "wind speed was 500 mph",
             "value_as_written": "500", "unit_as_written": "mph"}
        ]}), model, "2026-01-01T00:00:00Z"

    result = historical_documents.extract(pdf, tmp_path / "candidate.json", transport=transport)
    facts = result["document_extraction_candidates"]
    assert facts[0]["evidence_valid"] is True
    assert facts[0]["review_status"] == "pending"
    assert facts[1]["evidence_valid"] is False and facts[1]["candidate_value"] is None
    mapped = historical_documents.pending_measurement(
        facts[0], result["source"], "gofer:2020:Creek", "interval-1", {"page_bbox": None}
    )
    assert mapped["value"] == "approximately 80"
    assert mapped["review_status"] == "pending"
    assert mapped["source"]["event_id"] == "gofer:2020:Creek"


def test_document_evidence_allows_pdf_line_wraps_only():
    import sys

    root = Path(__file__).parents[4]
    sys.path.insert(0, str(root / "backend/llm"))
    import historical_documents

    assert historical_documents.evidence_matches(
        "wind direction was north",
        "The wind direction was north. Temperature was 80 F.",
    )
    assert historical_documents.evidence_matches(
        "The wind direc-\ntion was north", "The wind direction was north."
    )
    assert not historical_documents.evidence_matches(
        "wind direction was south", "The wind direction was north."
    )


def test_document_evaluation_requires_100_separate_review_cases(tmp_path, monkeypatch):
    import sys

    root = Path(__file__).parents[4]
    sys.path.insert(0, str(root / "backend/llm"))
    import historical_document_eval

    gold_path, candidates_path = tmp_path / "gold.json", tmp_path / "candidates.json"
    cases = [{"source_document": "eval.pdf", "page": 1, "field": "temperature",
              "present": True, "case_type": "range", "value_as_written": "80 to 90",
              "quote": "Temperature was 80 to 90 F.", "unit_as_written": "F",
              "time_as_written": "at 2 pm"}]
    cases += [{"source_document": "eval.pdf", "page": i + 2, "field": "wind_speed",
               "present": False, "case_type": kind}
              for i, kind in enumerate(["absent_fact", "ambiguous_timestamp"] + ["absent_fact"] * 97)]
    gold_path.write_text(json.dumps({"document_set": "eval-only", "cases": cases}))
    candidate = {"source_document": "eval.pdf", "page": 1, "field": "temperature",
                 "candidate_value": "80 to 90", "supporting_quote": "Temperature was 80 to 90 F.",
                 "evidence_valid": True, "unit_as_written": "F", "time_as_written": "at 2 pm"}
    candidates_path.write_text(json.dumps({"development_document_set": "dev-only",
                                           "document_extraction_candidates": [candidate]}))
    result = historical_document_eval.evaluate(gold_path, candidates_path)
    assert result["reviewed_field_cases"] == 100
    assert result["precision"] == result["recall"] == 1
    assert result["evidence_linkage_complete"] is True
    assert result["automation_gate_passed"] is True

    cases.pop()
    gold_path.write_text(json.dumps({"document_set": "eval-only", "cases": cases}))
    with pytest.raises(ValueError, match="at least 100"):
        historical_document_eval.evaluate(gold_path, candidates_path)
