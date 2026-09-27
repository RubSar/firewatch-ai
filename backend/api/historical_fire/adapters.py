"""Source adapters. Source-local dates are not invented UTC timestamps."""

import csv
import io
import math
import zipfile
from collections import Counter, defaultdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from .acquire import sha256

# Original column, normalized name, normalized unit, multiplier.
CFSDS_FIELDS = {
    "terrain": [
        ("dem", "elevation_m", "m", 1),
        ("slope", "slope_deg", "degree", 1),
        ("aspect", "aspect_deg", "degree", 1),
        ("twi", "wetness_index", "index", 1),
    ],
    "fuels": [
        ("Biomass", "biomass_t_ha", "t/ha", 1),
        ("Closure", "canopy_cover_pct", "%", 1),
        ("prcC", "conifer_pct", "%", 1),
        ("peatprop", "peat_fraction", "fraction", 1),
        ("nonfuel1k", "nonfuel_fraction_1km", "fraction", 1),
    ],
    "weather": [
        ("tmax", "temperature_max_c", "degC", 1),
        ("rh", "relative_humidity_pct", "%", 1),
        ("prec", "precipitation_mm", "mm", 1),
        ("vpd", "vpd_kpa", "kPa", 0.1),
        ("ffmc", "fine_fuel_moisture_code", "index", 1),
        ("dmc", "duff_moisture_code", "index", 1),
        ("dc", "drought_code", "index", 1),
    ],
    "wind": [("ws", "speed_m_s", "m/s", 1 / 3.6)],
}


def number(value):
    if value is None or str(value).strip().lower() in {"", "na", "nan", "null", "none"}:
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def measurement(value, unit, field, retrospective=True):
    return {"value": value, "unit": unit, "source_field": field, "retrospective": retrospective}


def base_record(dataset, version, event, year, region, interval, raw, filename, digest):
    return {
        "schema_version": "1.0",
        "dataset": dataset,
        "dataset_version": version,
        "event_id": event,
        "year": year,
        "region": region,
        "interval": interval,
        "features": {
            group: {name: measurement(None, unit, None) for _, name, unit, _ in fields}
            for group, fields in CFSDS_FIELDS.items()
        },
        "state": {"starting_area_ha": None, "previous_growth_ha": None},
        "outcome": {"growth_ha": None, "proportional_growth": None},
        "quality_flags": [],
        "provenance": {
            "file": filename,
            "sha256": digest,
            "raw": raw,
            "interpretation": "retrospective_association_only",
        },
    }


def import_cfsds(paths):
    records, excluded, seen = [], Counter(), {}
    for path in sorted(map(Path, paths)):
        digest = sha256(path)
        with zipfile.ZipFile(path) as archive:
            names = [n for n in archive.namelist() if n.endswith(".csv")]
            if len(names) != 1:
                raise ValueError(f"Expected one CSV in {path}")
            with archive.open(names[0]) as stream:
                reader = csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8-sig"))
                required = {"ID", "DOB", "year", "firearea", "cumuarea", "ecozone"}
                if not required.issubset(reader.fieldnames or []):
                    raise ValueError(f"Unsupported CFSDS schema: {path}")
                for raw in reader:
                    try:
                        year, doy = int(raw["year"]), int(raw["DOB"])
                        day = date(year, 1, 1) + timedelta(days=doy - 1)
                        if doy < 1 or day.year != year:
                            raise ValueError("Invalid day of year")
                        event = f"cfsds:{raw['ID']}"
                        key = event, day.isoformat()
                        if key in seen:
                            if seen[key] != raw:
                                raise ValueError(f"Conflicting duplicate {key}")
                            excluded["identical_duplicate"] += 1
                            continue
                        seen[key] = raw
                        growth, cumulative = number(raw["firearea"]), number(raw["cumuarea"])
                        if growth is None or cumulative is None:
                            excluded["missing_area"] += 1
                            continue
                        if growth < 0 or cumulative < growth - 0.01:
                            excluded["invalid_area"] += 1
                            continue
                    except (TypeError, ValueError) as exc:
                        # Conflicting identities must never be silently counted or merged.
                        raise ValueError(f"Invalid CFSDS row in {path}: {exc}") from exc
                    rec = base_record(
                        "CFSDS",
                        "1.1",
                        event,
                        year,
                        str(raw.get("ecozone") or "unknown"),
                        {
                            "start": day.isoformat(),
                            "end": (day + timedelta(days=1)).isoformat(),
                            "resolution": "daily",
                            "time_basis": "source_burning_day",
                        },
                        raw,
                        path.name,
                        digest,
                    )
                    for group, fields in CFSDS_FIELDS.items():
                        for column, name, unit, factor in fields:
                            value = number(raw.get(column))
                            rec["features"][group][name] = measurement(
                                None if value is None else value * factor, unit, column
                            )
                    rec["features"]["wind"]["direction_deg"] = measurement(None, "degree", None)
                    rec["state"]["starting_area_ha"] = max(0, cumulative - growth)
                    rec["outcome"]["growth_ha"] = growth
                    if rec["state"]["starting_area_ha"] > 0:
                        rec["outcome"]["proportional_growth"] = (
                            growth / rec["state"]["starting_area_ha"]
                        )
                    rec["quality_flags"] = [
                        "outcome_footprint_covariates",
                        "reconstructed_progression",
                    ]
                    if growth == 0:
                        rec["quality_flags"].append(
                            "zero_growth_covariates_may_use_future_location"
                        )
                    records.append(rec)
    set_previous(records)
    return records, dict(excluded)


def set_previous(records):
    by_event = defaultdict(list)
    for r in records:
        by_event[r["event_id"]].append(r)
    for event, rows in by_event.items():
        if len({r["year"] for r in rows}) != 1:
            raise ValueError(f"Event spans split years: {event}")
        previous = None
        for r in sorted(rows, key=lambda r: r["interval"]["start"]):
            if previous and previous["interval"]["end"] == r["interval"]["start"]:
                r["state"]["previous_growth_ha"] = previous["outcome"]["growth_ha"]
            else:
                r["quality_flags"].append("missing_previous_interval")
            previous = r


def import_gofer(path):
    path = Path(path)
    digest, events, seen = sha256(path), defaultdict(list), {}
    excluded = Counter()
    with path.open(newline="") as f:
        reader = csv.DictReader(f)
        if not {"fname", "fyear", "tUTC", "farea"}.issubset(reader.fieldnames or []):
            raise ValueError("Unsupported GOFER schema")
        for raw in reader:
            key = raw["fname"], raw["fyear"], raw["tUTC"]
            if key in seen:
                if seen[key] != raw:
                    raise ValueError(f"Conflicting duplicate {key}")
                excluded["identical_duplicate"] += 1
                continue
            seen[key] = raw
            events[key[:2]].append(raw)
    records = []
    for (name, year), rows in events.items():
        previous = None
        for raw in sorted(rows, key=lambda x: x["tUTC"]):
            end = datetime.fromisoformat(raw["tUTC"])
            if end.tzinfo is None:
                # tUTC is explicitly UTC in GOFER; the CSV omits the suffix.

                end = end.replace(tzinfo=UTC)
            area = number(raw["farea"])
            if previous:
                start, start_area = previous
                if (
                    end - start == timedelta(hours=1)
                    and area is not None
                    and start_area is not None
                ):
                    growth = (area - start_area) * 100
                    if growth >= -1e-6:
                        rec = base_record(
                            "GOFER",
                            "0.2",
                            f"gofer:{year}:{name}",
                            int(year),
                            "California",
                            {
                                "start": start.isoformat(),
                                "end": end.isoformat(),
                                "resolution": "hourly",
                                "time_basis": "UTC",
                            },
                            raw,
                            path.name,
                            digest,
                        )
                        rec["state"]["starting_area_ha"] = start_area * 100
                        rec["outcome"]["growth_ha"] = max(0, growth)
                        rec["outcome"]["proportional_growth"] = (
                            max(0, growth) / (start_area * 100) if start_area > 0 else None
                        )
                        rec["quality_flags"] = [
                            "reconstructed_progression",
                            "environment_not_enriched",
                        ]
                        records.append(rec)
                    else:
                        excluded["negative_growth"] += 1
                else:
                    excluded["gap_or_missing_area"] += 1
            else:
                excluded["first_snapshot_no_interval"] += 1
            previous = end, area
    set_previous(records)
    return records, dict(excluded)
