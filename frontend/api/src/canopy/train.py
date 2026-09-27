"""
Trains the canopy-structure model and exports it for TypeScript inference.

    npm run canopy:train --workspace=@firewatch/api

Reads training.jsonl from sample.ts, writes model.json next to it.

THREE THINGS HERE ARE NOT OPTIONAL.

1. Cross-validation is blocked BY REGION, never random. Two 30 m pixels 100 m
   apart are nearly the same observation, so a random split puts near-duplicates
   on both sides and reports a score that measures interpolation within a forest
   this model has already seen. The question that matters is whether LANDFIRE's
   relationship carries to a forest it has not seen — which is exactly what the
   app does every time someone simulates outside the US. GroupKFold on region is
   the cheapest honest answer.

2. Every metric is reported against the baseline it has to beat: the per-class
   constants in `assumedCanopy`. A model that is worse than a constant is not a
   feature, and "RMSE 0.08" means nothing without knowing the constant scores
   0.09.

3. The export is verified against sklearn's own predict() before it is written.
   A tree ensemble re-implemented in another language is trivially easy to get
   subtly wrong — an off-by-one on child indices, a <= where sklearn uses <, a
   missed learning-rate scaling — and all of those produce plausible numbers.
"""
import json
import pathlib
import sys
from datetime import datetime, timezone

import numpy as np
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.model_selection import GroupKFold

HERE = pathlib.Path(__file__).parent
TABLE = HERE / "training.jsonl"
OUT = HERE / "model.json"

TARGETS = ["cbh", "cbd", "cover", "height"]

# Physical ranges, from the LANDFIRE service's own advertised min/max. Applied
# at inference too: a tree ensemble extrapolates flat, not absurdly, but it can
# still emit a small negative from the additive init term.
CLIP = {"cbh": (0.0, 10.0), "cbd": (0.0, 0.45), "cover": (0.0, 1.0), "height": (0.0, 51.0)}

# `assumedCanopy` in providers/tier1.ts, by fuel id. This is the thing to beat.
FUEL_TIMBER, FUEL_SHRUB = 4, 3
ASSUMED = {
    FUEL_TIMBER: {"cbh": 5.0, "cbd": 0.10, "cover": 0.70, "height": 20.0},
    FUEL_SHRUB: {"cbh": 1.0, "cbd": 0.05, "cover": 0.35, "height": 3.0},
}

PARAMS = dict(
    n_estimators=250,
    max_depth=3,
    learning_rate=0.06,
    subsample=0.8,
    random_state=7,
)


def load():
    if not TABLE.exists():
        sys.exit(f"no training table at {TABLE} — run `npm run canopy:sample` first")
    feats, ys, groups, names = [], {t: [] for t in TARGETS}, [], None
    with TABLE.open() as fh:
        for line in fh:
            if not line.strip():
                continue
            r = json.loads(line)
            feats.append(r["features"])
            for t in TARGETS:
                ys[t].append(r[t])
            groups.append(r["region"])
    X = np.asarray(feats, dtype=np.float64)
    Y = {t: np.asarray(ys[t], dtype=np.float64) for t in TARGETS}
    return X, Y, np.asarray(groups), names


def assumed_pred(X, target, fuel_col):
    """The per-class constant, per row, for whatever fuel that row actually is."""
    out = np.empty(len(X))
    for i, f in enumerate(X[:, fuel_col]):
        out[i] = ASSUMED.get(int(round(f)), ASSUMED[FUEL_TIMBER])[target]
    return out


def metrics(true, pred):
    err = pred - true
    return {
        "mae": float(np.mean(np.abs(err))),
        "rmse": float(np.sqrt(np.mean(err**2))),
        "bias": float(np.mean(err)),
    }


def export_tree(t):
    """sklearn's tree arrays, trimmed to what a tree walk needs."""
    return {
        "f": [int(v) for v in t.feature],
        "t": [round(float(v), 6) for v in t.threshold],
        "l": [int(v) for v in t.children_left],
        "r": [int(v) for v in t.children_right],
        "v": [round(float(v[0][0]), 8) for v in t.value],
    }


def walk(tree, x):
    """Reference tree walk. Must match the TypeScript one exactly."""
    node = 0
    while tree["l"][node] != -1:
        # sklearn splits on `x[feature] <= threshold` -> left.
        node = tree["l"][node] if x[tree["f"][node]] <= tree["t"][node] else tree["r"][node]
    return tree["v"][node]


def main():
    X, Y, groups, _ = load()
    fuel_col = 14  # FEATURE_NAMES.indexOf('fuelId')
    regions = sorted(set(groups.tolist()))
    print(f"{len(X)} rows, {X.shape[1]} features, {len(regions)} regions")
    print(f"CV: GroupKFold by region (never random — neighbouring pixels leak)\n")

    n_splits = min(5, len(regions))
    report = {}

    print(f"{'target':8} {'model MAE':>10} {'assumed MAE':>12} {'model RMSE':>11} "
          f"{'assumed RMSE':>13} {'improvement':>12}")
    for t in TARGETS:
        y = Y[t]
        oof = np.zeros(len(y))
        for tr, te in GroupKFold(n_splits=n_splits).split(X, y, groups):
            m = GradientBoostingRegressor(**PARAMS).fit(X[tr], y[tr])
            oof[te] = m.predict(X[te])
        lo, hi = CLIP[t]
        oof = np.clip(oof, lo, hi)

        mm = metrics(y, oof)
        am = metrics(y, assumed_pred(X, t, fuel_col))
        gain = (1 - mm["rmse"] / am["rmse"]) * 100
        report[t] = {"model": mm, "assumed": am, "rmseImprovementPct": round(gain, 1)}
        print(f"{t:8} {mm['mae']:10.4f} {am['mae']:12.4f} {mm['rmse']:11.4f} "
              f"{am['rmse']:13.4f} {gain:11.1f}%")

    print("\nper-region held-out RMSE (each region predicted by a model that never saw it)")
    print(f"{'region':18} " + " ".join(f"{t:>9}" for t in TARGETS))
    per_region = {}
    for t in TARGETS:
        y = Y[t]
        oof = np.zeros(len(y))
        for tr, te in GroupKFold(n_splits=n_splits).split(X, y, groups):
            oof[te] = GradientBoostingRegressor(**PARAMS).fit(X[tr], y[tr]).predict(X[te])
        oof = np.clip(oof, *CLIP[t])
        for rg in regions:
            sel = groups == rg
            per_region.setdefault(rg, {})[t] = float(np.sqrt(np.mean((oof[sel] - y[sel]) ** 2)))
    for rg in regions:
        print(f"{rg:18} " + " ".join(f"{per_region[rg][t]:9.4f}" for t in TARGETS))

    # Final models on everything, for export.
    print("\nfitting final models on all rows")
    payload = {
        "featureNames": json.loads((HERE / "feature-names.json").read_text()),
        "targets": {},
        "clip": {t: list(CLIP[t]) for t in TARGETS},
        "trainedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rows": int(len(X)),
        "regions": regions,
        "labelSource": "LANDFIRE LF2023 CBH/CBD/CC/CH, 30 m, CONUS",
        "params": PARAMS,
        "metrics": report,
        "perRegionRmse": per_region,
    }
    for t in TARGETS:
        m = GradientBoostingRegressor(**PARAMS).fit(X, Y[t])
        trees = [export_tree(e[0].tree_) for e in m.estimators_]
        init = float(np.mean(Y[t]))
        payload["targets"][t] = {"init": init, "lr": float(m.learning_rate), "trees": trees}

        # VERIFY the export reproduces sklearn, on real rows.
        idx = np.linspace(0, len(X) - 1, 200).astype(int)
        mine = np.array([
            init + m.learning_rate * sum(walk(tr, X[i]) for tr in trees) for i in idx
        ])
        theirs = m.predict(X[idx])
        drift = float(np.max(np.abs(mine - theirs)))
        if drift > 1e-5:
            sys.exit(f"EXPORT MISMATCH for {t}: max |mine - sklearn| = {drift:.2e}")
        print(f"  {t:8} {len(trees)} trees, export verified to {drift:.1e}")

    OUT.write_text(json.dumps(payload, separators=(",", ":")))

    # Fixture for the TypeScript parity check. sklearn's own predictions on real
    # rows, clipped the way inference clips, so `npm run canopy:check` can prove
    # the TS tree walk reproduces them rather than merely looking reasonable.
    idx = np.linspace(0, len(X) - 1, 120).astype(int)
    fixture = {
        "note": "sklearn predictions on real rows; api/src/canopy/check.ts must reproduce these",
        "featureNames": payload["featureNames"],
        "rows": [[round(float(v), 8) for v in X[i]] for i in idx],
        "expect": {},
    }
    for t in TARGETS:
        m = GradientBoostingRegressor(**PARAMS).fit(X, Y[t])
        fixture["expect"][t] = [
            round(float(v), 8) for v in np.clip(m.predict(X[idx]), *CLIP[t])
        ]
    (HERE / "parity.json").write_text(json.dumps(fixture, separators=(",", ":")))
    print(f"wrote {HERE / 'parity.json'} ({len(idx)} rows)")
    print(f"\nwrote {OUT} ({OUT.stat().st_size / 1024:.0f} kB)")


if __name__ == "__main__":
    main()