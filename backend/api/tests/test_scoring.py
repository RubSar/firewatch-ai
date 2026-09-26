import pytest

from fuel_service.provider import parse_evidence
from fuel_service.scoring import CLASSES, Evidence, score_cell
from fuel_service.spatial import Cell

CELL = Cell("test", {}, 10000)


def evidence(cover, ndmi=0.1, coverage=1):
    return Evidence({k: cover.get(k, 0) for k in CLASSES}, ndmi, coverage, 3)


def test_dry_vegetation_scores_above_wet_and_bounds_are_clamped():
    assert score_cell(CELL, evidence({"trees": 1}, -0.8)).score == 100
    assert score_cell(CELL, evidence({"trees": 1}, 0.9)).score == 0
    assert score_cell(CELL, evidence({"grass": 0.8, "bare": 0.2}, 0.1)).score == 40
    assert score_cell(CELL, evidence({"trees": 1}, 0.1)).score == 50


def test_bare_zero_is_distinct_from_unknown_and_built():
    assert score_cell(CELL, evidence({"bare": 1}, None)).status == "non_vegetated"
    assert score_cell(CELL, evidence({"bare": 1}, None)).score == 0
    for ev, status in [
        (Evidence(None, None, 0, None), "no_data"),
        (evidence({"trees": 1}, None), "missing_moisture"),
        (evidence({"bare": 1}, coverage=0.69), "insufficient_coverage"),
        (evidence({"built": 0.3, "trees": 0.7}), "unsupported_built_area"),
    ]:
        result = score_cell(CELL, ev)
        assert result.score is None
        assert result.status == status


@pytest.mark.parametrize(
    "ev",
    [
        Evidence({"trees": 1}, 0.1, 1, 1),
        evidence({"trees": 0.5}),
        evidence({"trees": 1}, float("nan")),
        evidence({"trees": 1}, coverage=1.1),
    ],
)
def test_invalid_provider_evidence_rejected(ev):
    with pytest.raises(ValueError):
        score_cell(CELL, ev)


def test_zero_ndmi_is_retained_and_weighted_by_vegetation():
    row = {k: 0 for k in CLASSES}
    row.update(
        trees=300,
        bare=300,
        vegetation=300,
        vegetation_ndmi=0,
        valid_area=600,
        total_area=1000,
        observations_area=1800,
    )
    result = parse_evidence(row)
    assert result.ndmi == 0
    assert result.coverage == 0.6
    assert result.probabilities["trees"] == 0.5
    assert result.observations == 3


def test_no_pixels_never_becomes_zero_ndmi():
    assert parse_evidence({"total_area": 1000}).ndmi is None
    assert parse_evidence({"total_area": 1000}).probabilities is None
