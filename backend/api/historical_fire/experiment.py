"""Event-separated analog comparisons with training-only normalization."""

import hashlib
from collections import defaultdict

import numpy as np

GROUPS = {
    "state": ["starting_area_ha", "previous_growth_ha"],
    "terrain": ["elevation_m", "slope_deg", "wetness_index"],
    "fuels": [
        "biomass_t_ha",
        "canopy_cover_pct",
        "conifer_pct",
        "peat_fraction",
        "nonfuel_fraction_1km",
    ],
    "weather": [
        "temperature_max_c",
        "relative_humidity_pct",
        "precipitation_mm",
        "vpd_kpa",
        "fine_fuel_moisture_code",
        "duff_moisture_code",
        "drought_code",
    ],
    "wind": ["speed_m_s"],
}
METHODS = ("random", "state", "environment")
KS = (5, 10, 20)


def vector(record, groups=GROUPS):
    values = []
    for group, names in groups.items():
        for name in names:
            if group == "state":
                value = record["state"].get(name)
                value = np.log1p(value) if value is not None and value >= 0 else np.nan
            else:
                value = record["features"].get(group, {}).get(name, {}).get("value")
            values.append(np.nan if value is None else value)
    return np.array(values, dtype=float)


def eligible(record):
    return bool(np.isfinite(vector(record)).all())


def split(records):
    result = {"train": [], "validation": [], "test": []}
    identities = {}
    for r in records:
        if r["dataset"] != "CFSDS" or r["interval"]["resolution"] != "daily":
            raise ValueError("Daily experiment accepts CFSDS daily records only")
        year = r["year"]
        part = (
            "train"
            if 2002 <= year <= 2015
            else "validation"
            if 2016 <= year <= 2018
            else "test"
            if 2019 <= year <= 2021
            else None
        )
        if part is None:
            continue
        if r["event_id"] in identities and identities[r["event_id"]] != part:
            raise ValueError("Event crosses evaluation partitions")
        identities[r["event_id"]] = part
        result[part].append(r)
    return result


class Library:
    def __init__(self, records):
        if not records:
            raise ValueError("Empty matching library")
        kinds = {(r["dataset"], r["interval"]["resolution"]) for r in records}
        if len(kinds) != 1:
            raise ValueError("Cannot mix sources or temporal resolutions")
        if not all(eligible(r) for r in records):
            raise ValueError("Library requires complete matching features")
        self.kind = next(iter(kinds))
        self.rows = sorted(records, key=lambda r: (r["event_id"], r["interval"]["start"]))
        self.ids = np.array([r["event_id"] for r in self.rows])
        self.events, self.starts = np.unique(self.ids, return_index=True)
        self.ends = np.r_[self.starts[1:], len(self.rows)]
        raw = np.stack([vector(r) for r in self.rows])
        self.mean = raw.mean(axis=0)
        self.scale = raw.std(axis=0)
        self.scale[self.scale < 1e-12] = 1
        self.weights = np.concatenate(
            [
                np.full(len(names), 1 / np.sqrt(len(names) * len(GROUPS)))
                for names in GROUPS.values()
            ]
        )
        self.matrix = (raw - self.mean) / self.scale * self.weights
        self.squared = np.einsum("ij,ij->i", self.matrix, self.matrix)
        self.state_matrix = (raw[:, :2] - self.mean[:2]) / self.scale[:2] / np.sqrt(2)
        self.state_squared = np.einsum("ij,ij->i", self.state_matrix, self.state_matrix)

    def neighbors(self, query, method, k=20):
        if (query["dataset"], query["interval"]["resolution"]) != self.kind:
            raise ValueError("Query and library must have the same source and interval")
        available = np.flatnonzero(self.events != query["event_id"])
        if method == "random":
            key = f"42:{query['event_id']}:{query['interval']['start']}".encode()
            seed = int.from_bytes(hashlib.sha256(key).digest()[:8], "big")
            rng = np.random.default_rng(seed)
            chosen = rng.choice(available, size=min(k, len(available)), replace=False)
            return [(self.rows[rng.integers(self.starts[i], self.ends[i])], None) for i in chosen]
        q = vector(query)
        if not np.isfinite(q).all():
            return []
        if method == "state":
            q = (q[:2] - self.mean[:2]) / self.scale[:2] / np.sqrt(2)
            distance = self.state_squared - 2 * (self.state_matrix @ q) + q @ q
        elif method == "environment":
            q = (q - self.mean) / self.scale * self.weights
            distance = self.squared - 2 * (self.matrix @ q) + q @ q
        else:
            raise ValueError(f"Unknown matching method {method}")
        distance = np.maximum(distance, 0)
        event_min = np.minimum.reduceat(distance, self.starts)
        # Sorting event minima, not all rows, also gives deterministic event-ID ties.
        chosen = available[np.argsort(event_min[available], kind="stable")[:k]]
        output = []
        for i in chosen:
            idx = self.starts[i] + np.argmin(distance[self.starts[i] : self.ends[i]])
            output.append((self.rows[idx], float(np.sqrt(distance[idx]))))
        return output


def comparison(query, neighbors, k, include_examples=False):
    chosen = neighbors[:k]
    if len(chosen) < k:
        return {"event_id": query["event_id"], "adequate": False}
    growth = np.array([r["outcome"]["growth_ha"] for r, _ in chosen])
    low, median, high = map(float, np.quantile(growth, [0.1, 0.5, 0.9]))
    actual = query["outcome"]["growth_ha"]
    start = query["state"]["starting_area_ha"]
    out = {
        "event_id": query["event_id"],
        "interval": query["interval"],
        "adequate": True,
        "supporting_fires": len(chosen),
        "actual_growth_ha": actual,
        "median_growth_ha": median,
        "historical_p10_ha": low,
        "historical_p90_ha": high,
        "absolute_error_ha": abs(median - actual),
        "range_width_ha": high - low,
        "covered": float(low <= actual <= high),
        "actual_proportional_growth": actual / start if start > 0 else None,
        "estimated_proportional_growth": median / start if start > 0 else None,
        "interpretation": "retrospective_association_only",
        "range_label": "empirical_historical_variability_not_calibrated_confidence",
    }
    if include_examples:
        out["query"] = query
        out["matches"] = [{"distance": d, "situation": r} for r, d in chosen]
    return out


def event_metrics(rows):
    events = defaultdict(list)
    for row in rows:
        events[row["event_id"]].append(row)
    result = {}
    for event, observations in events.items():
        valid = [r for r in observations if r["adequate"]]
        result[event] = {"adequate_fraction": len(valid) / len(observations)}
        for field in ("absolute_error_ha", "range_width_ha", "covered"):
            vals = [r[field] for r in valid if field in r]
            result[event][field] = float(np.mean(vals)) if vals else None
    return result


def summarize(rows):
    metrics = event_metrics(rows)
    result = {"queries": len(rows), "fires": len(metrics)}
    for key in ("absolute_error_ha", "range_width_ha", "covered", "adequate_fraction"):
        values = [v[key] for v in metrics.values() if v[key] is not None]
        result[key] = float(np.mean(values)) if values else None
    return result


def bootstrap_improvement(environment, baseline, repetitions=1000):
    a, b = event_metrics(environment), event_metrics(baseline)
    differences = np.array(
        [
            b[e]["absolute_error_ha"] - a[e]["absolute_error_ha"]
            for e in sorted(a.keys() & b.keys())
            if a[e]["absolute_error_ha"] is not None and b[e]["absolute_error_ha"] is not None
        ]
    )
    if not len(differences):
        return {"paired_fires": 0, "mean_improvement_ha": None, "ci95_ha": None}
    rng = np.random.default_rng(42)
    means = [
        float(rng.choice(differences, len(differences), replace=True).mean())
        for _ in range(repetitions)
    ]
    return {
        "paired_fires": len(differences),
        "mean_improvement_ha": float(differences.mean()),
        "ci95_ha": list(map(float, np.quantile(means, [0.025, 0.975]))),
        "positive_means_environment_better": True,
        "bootstrap_unit": "whole_fire",
    }


def evaluate(train, validation, test, examples=3):
    library = Library(train)
    tuning = {m: {k: [] for k in KS} for m in METHODS}
    for q in validation:
        for method in METHODS:
            neighbors = library.neighbors(q, method)
            for k in KS:
                tuning[method][k].append(comparison(q, neighbors, k))
    validation_scores = {
        m: {k: summarize(rows) for k, rows in options.items()} for m, options in tuning.items()
    }
    selected = {}
    for method in METHODS:
        scores = validation_scores[method]
        valid = [k for k in KS if scores[k]["absolute_error_ha"] is not None]
        if not valid:
            raise ValueError("No validation matches; need at least five distinct training fires")
        selected[method] = min(valid, key=lambda k: (scores[k]["absolute_error_ha"], k))
    results = {m: [] for m in (*METHODS, "persistence")}
    example_rows = []
    example_events = set()
    for q in test:
        include = len(example_events) < examples and q["event_id"] not in example_events
        for method in METHODS:
            neighbors = library.neighbors(q, method, selected[method])
            result = comparison(q, neighbors, selected[method], include and method == "environment")
            if include and method == "environment" and result["adequate"]:
                example_rows.append(result.copy())
                example_events.add(q["event_id"])
                result = {k: v for k, v in result.items() if k not in {"matches", "query"}}
            results[method].append(result)
        results["persistence"].append(
            {
                "event_id": q["event_id"],
                "adequate": True,
                "absolute_error_ha": abs(
                    q["outcome"]["growth_ha"] - q["state"]["previous_growth_ha"]
                ),
            }
        )
    report = {
        "selected_k": selected,
        "validation": validation_scores,
        "test": {m: summarize(rows) for m, rows in results.items()},
        "improvement_vs": {
            m: bootstrap_improvement(results["environment"], results[m])
            for m in ("random", "state", "persistence")
        },
        "per_fire": {m: event_metrics(rows) for m, rows in results.items()},
    }
    return report, example_rows, results


def geographic_evaluation(parts, raw_records):
    # A fire touching the withheld ecozone is removed in its entirety, including
    # rows assigned to other ecozones; normalization and k are re-fitted.
    regions_by_event = defaultdict(set)
    for r in raw_records:
        regions_by_event[r["event_id"]].add(r["region"])
    reports = {}
    regions = sorted({r["region"] for r in raw_records if r["region"] != "unknown"})
    for region in regions:
        train = [r for r in parts["train"] if region not in regions_by_event[r["event_id"]]]
        validation = [r for r in parts["validation"] if r["region"] == region]
        test = [r for r in parts["test"] if r["region"] == region]
        if len({r["event_id"] for r in train}) < 5 or not validation or not test:
            reports[region] = {"status": "insufficient_data", "test_queries": len(test)}
            continue
        report, _, _ = evaluate(train, validation, test, examples=0)
        report.pop("per_fire")
        reports[region] = {
            "status": "evaluated",
            "training_fires": len({r["event_id"] for r in train}),
            **report,
        }
    return reports
