import copy
import csv
import io
import json
import zipfile
from pathlib import Path

import pytest

np = pytest.importorskip("numpy", reason="Install the research extra to run historical tests")
jsonschema = pytest.importorskip("jsonschema", reason="Install the research extra")

from historical_fire.adapters import CFSDS_FIELDS, import_cfsds, import_gofer
from historical_fire.experiment import (
    Library,
    bootstrap_improvement,
    comparison,
    eligible,
    event_metrics,
    split,
    vector,
)


def raw_row(event="2002_1", doy=100, growth=10, cumulative=30):
    row = {
        "ID": event,
        "DOB": str(doy),
        "year": "2002",
        "firearea": str(growth),
        "cumuarea": str(cumulative),
        "ecozone": "6",
    }
    for fields in CFSDS_FIELDS.values():
        for column, *_ in fields:
            row[column] = "10"
    return row


def archive(tmp_path, rows):
    path = tmp_path / "source.zip"
    text = io.StringIO()
    writer = csv.DictWriter(text, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("data.csv", text.getvalue())
    return path


def sample(tmp_path):
    rows, _ = import_cfsds([archive(tmp_path, [raw_row(), raw_row(doy=101, cumulative=40)])])
    return rows[1]


def test_cfsds_units_alignment_missing_and_schema(tmp_path):
    one = raw_row()
    one["ws"], one["vpd"], one["aspect"] = "36", "20", "NA"
    rows, _ = import_cfsds(
        [archive(tmp_path, [one, raw_row(doy=101, cumulative=40), raw_row(doy=103, cumulative=50)])]
    )
    assert rows[0]["features"]["wind"]["speed_m_s"]["value"] == 10
    assert rows[0]["features"]["weather"]["vpd_kpa"]["value"] == 2
    assert rows[0]["features"]["terrain"]["aspect_deg"]["value"] is None
    assert rows[0]["state"] == {"starting_area_ha": 20, "previous_growth_ha": None}
    assert rows[1]["state"]["previous_growth_ha"] == 10
    assert rows[2]["state"]["previous_growth_ha"] is None
    assert rows[0]["interval"]["start"] == "2002-04-10"
    assert rows[0]["interval"]["time_basis"] == "source_burning_day"
    schema = json.loads(
        (Path(__file__).parents[4] / "contracts/historical-situation.schema.json").read_text()
    )
    validator = jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker())
    for row in rows:
        validator.validate(row)


def test_duplicate_and_conflicting_identity(tmp_path):
    rows, excluded = import_cfsds([archive(tmp_path, [raw_row(), raw_row()])])
    assert len(rows) == 1 and excluded["identical_duplicate"] == 1
    with pytest.raises(ValueError, match="Conflicting duplicate"):
        import_cfsds([archive(tmp_path, [raw_row(), raw_row(growth=9)])])


def test_zero_growth_not_missing(tmp_path):
    row = raw_row(growth=0)
    rows, _ = import_cfsds([archive(tmp_path, [row])])
    assert rows[0]["outcome"]["growth_ha"] == 0
    assert "zero_growth_covariates_may_use_future_location" in rows[0]["quality_flags"]


def test_gofer_hourly_conversion_gaps_and_no_retrospective_line_predictor(tmp_path):
    path = tmp_path / "gofer.csv"
    path.write_text(
        "fname,fyear,tUTC,farea,rflinelen\n"
        "Creek,2020,2020-09-06 00:00:00,151.615,16.068\n"
        "Creek,2020,2020-09-06 01:00:00,159.651,20\n"
        "Creek,2020,2020-09-06 02:00:00,160,20\n"
        "Creek,2020,2020-09-06 04:00:00,161,20\n"
    )
    rows, excluded = import_gofer(path)
    assert rows[0]["outcome"]["growth_ha"] == pytest.approx(803.6)
    assert rows[0]["state"]["starting_area_ha"] == pytest.approx(15161.5)
    assert rows[1]["state"]["previous_growth_ha"] == pytest.approx(803.6)
    assert rows[0]["interval"]["start"] == "2020-09-06T00:00:00+00:00"
    assert not eligible(rows[0])
    assert excluded["gap_or_missing_area"] == 1
    assert "rflinelen" not in rows[0]["features"]


def test_feature_vector_cannot_use_outcomes_or_raw_fields(tmp_path):
    r = sample(tmp_path)
    altered = copy.deepcopy(r)
    altered["outcome"]["growth_ha"] = 999999
    altered["provenance"]["raw"]["sprdistm"] = 999999
    np.testing.assert_equal(vector(r), vector(altered))
    altered["features"]["wind"]["speed_m_s"]["value"] = None
    assert not eligible(altered)


def test_unique_events_query_exclusion_and_normalization(tmp_path):
    q = sample(tmp_path)
    training = []
    for i in range(25):
        r = copy.deepcopy(q)
        r["event_id"] = f"fire{i:02}"
        r["state"]["starting_area_ha"] += i
        training.extend([r, copy.deepcopy(r)])
    q["event_id"] = "fire00"
    lib = Library(training)
    before = lib.mean.copy()
    for method in ("random", "state", "environment"):
        neighbors = lib.neighbors(q, method)
        assert len(neighbors) == 20
        ids = [r["event_id"] for r, _ in neighbors]
        assert len(set(ids)) == 20 and "fire00" not in ids
        assert comparison(q, neighbors, 20)["supporting_fires"] == 20
    q["state"]["starting_area_ha"] = 1e12
    lib.neighbors(q, "environment")
    np.testing.assert_equal(before, lib.mean)
    assert comparison(q, [], 5) == {"event_id": "fire00", "adequate": False}


def test_mixed_interval_rejected(tmp_path):
    q = sample(tmp_path)
    other = copy.deepcopy(q)
    other["interval"]["resolution"] = "hourly"
    with pytest.raises(ValueError, match="mix"):
        Library([q, other])
    with pytest.raises(ValueError, match="same source"):
        Library([q]).neighbors(other, "state")


def test_split_entire_events_and_boundaries(tmp_path):
    q = sample(tmp_path)
    rows = []
    for year in [2002, 2015, 2016, 2018, 2019, 2021]:
        r = copy.deepcopy(q)
        r["year"], r["event_id"] = year, str(year)
        rows.append(r)
    parts = split(rows)
    assert [r["year"] for r in parts["validation"]] == [2016, 2018]
    rows[-1]["event_id"] = rows[0]["event_id"]
    with pytest.raises(ValueError, match="crosses"):
        split(rows)


def test_fire_weighting_and_paired_bootstrap():
    a = [{"event_id": "big", "adequate": True, "absolute_error_ha": 1}] * 100
    a += [{"event_id": "small", "adequate": True, "absolute_error_ha": 9}]
    b = [{**r, "absolute_error_ha": r["absolute_error_ha"] + 2} for r in a]
    metrics = event_metrics(a)
    assert np.mean([m["absolute_error_ha"] for m in metrics.values()]) == 5
    result = bootstrap_improvement(a, b)
    assert result["paired_fires"] == 2
    assert result["ci95_ha"] == [2, 2]


def test_geographic_holdout_removes_whole_multiregion_events(tmp_path, monkeypatch):
    from historical_fire import experiment

    template = sample(tmp_path)
    train = []
    for i in range(6):
        r = copy.deepcopy(template)
        r["event_id"], r["region"] = f"train{i}", "5"
        train.append(r)
    crossing = copy.deepcopy(train[0])
    crossing["region"] = "6"
    train.append(crossing)
    q = copy.deepcopy(template)
    q["region"], q["event_id"] = "6", "query"
    calls = []

    def fake_evaluate(training, validation, test, examples):
        calls.append(training)
        return {"per_fire": {}}, [], {}

    monkeypatch.setattr(experiment, "evaluate", fake_evaluate)
    reports = experiment.geographic_evaluation(
        {"train": train, "validation": [q], "test": [q]}, train + [q]
    )
    assert reports["6"]["status"] == "evaluated"
    assert reports["5"]["status"] == "insufficient_data"
    assert len(calls) == 1
    assert {r["event_id"] for r in calls[0]} == {f"train{i}" for i in range(1, 6)}


def test_small_end_to_end_is_deterministic_and_tunes_on_validation(tmp_path):
    from historical_fire.experiment import evaluate

    q = sample(tmp_path)
    training = []
    for i in range(6):
        r = copy.deepcopy(q)
        r["event_id"] = f"training{i}"
        r["outcome"]["growth_ha"] = i
        training.append(r)
    q["event_id"] = "validation"
    test = copy.deepcopy(q)
    test["event_id"] = "test"
    a, examples, _ = evaluate(training, [q], [test])
    test["outcome"]["growth_ha"] = 1e8
    b, _, _ = evaluate(training, [q], [test])
    assert (
        a["selected_k"] == b["selected_k"] == dict.fromkeys(["random", "state", "environment"], 5)
    )
    assert a["validation"] == b["validation"]
    assert examples[0]["interpretation"] == "retrospective_association_only"
    assert examples[0]["supporting_fires"] == 5


def test_real_contract_examples():
    root = Path(__file__).parents[4]
    schema = json.loads((root / "contracts/historical-situation.schema.json").read_text())
    validator = jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker())
    examples = json.loads(
        (root / "contracts/examples/historical-comparisons.real.json").read_text()
    )
    assert len(examples) == 3
    for example in examples:
        validator.validate(example["query"])
        ids = []
        for match in example["matches"]:
            validator.validate(match["situation"])
            ids.append(match["situation"]["event_id"])
        assert len(set(ids)) == example["supporting_fires"]
        assert example["event_id"] not in ids
    hourly = json.loads((root / "contracts/examples/historical-gofer.real.json").read_text())
    validator.validate(hourly)
    assert hourly["features"]["weather"]["temperature_max_c"]["value"] is None


def test_default_cli_only_imports_and_audits(tmp_path, monkeypatch):
    from historical_fire import __main__ as cli
    from historical_fire.acquire import sha256

    source = archive(tmp_path, [raw_row(), raw_row(doy=101, cumulative=40)])
    output = tmp_path / "quality"
    manifest = {"files": [{"name": source.name, "sha256": sha256(source)}]}
    monkeypatch.setattr(cli, "acquire", lambda _: manifest)
    monkeypatch.setattr(
        "sys.argv",
        ["historical_fire", "--data-dir", str(tmp_path), "--output", str(output), "--download"],
    )

    def forbidden(*args, **kwargs):
        pytest.fail("Data quality must not run model evaluation or temporal splits")

    monkeypatch.setattr(cli, "evaluate", forbidden)
    monkeypatch.setattr(cli, "geographic_evaluation", forbidden)
    monkeypatch.setattr(cli, "split", forbidden)
    cli.main()
    quality = json.loads((output / "data-quality.json").read_text())
    assert quality["cfsds"]["imported"]["situations"] == 2
    assert (output / "cfsds-situations.jsonl").exists()
    assert not (output / "results.json").exists()
    assert "splits" not in quality


def test_data_only_output_does_not_mix_previous_comparisons(tmp_path, monkeypatch):
    from historical_fire import __main__ as cli

    (tmp_path / "results.json").write_text("{}")
    monkeypatch.setattr(
        "sys.argv", ["historical_fire", "--data-dir", str(tmp_path), "--output", str(tmp_path)]
    )
    with pytest.raises(SystemExit) as exc:
        cli.main()
    assert exc.value.code == 2
