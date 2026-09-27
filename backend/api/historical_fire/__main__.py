"""Reproducible offline runner: python -m historical_fire --help."""

import argparse
import json
import os
import platform
from collections import Counter
from pathlib import Path

# Small matrix/vector queries are slower with many BLAS worker threads.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")

import numpy as np

from .acquire import acquire, sha256
from .adapters import import_cfsds, import_gofer
from .experiment import eligible, evaluate, geographic_evaluation, split


def write_json(path, obj):
    path.write_text(json.dumps(obj, indent=2, allow_nan=False) + "\n")


def runtime_manifest():
    directory = Path(__file__).parent
    return {
        "python": platform.python_version(),
        "numpy": np.__version__,
        "source_hashes": {p.name: sha256(p) for p in sorted(directory.glob("*.py"))},
        "uv_lock_sha256": sha256(directory.parent / "uv.lock"),
        "seed": 42,
    }


def coverage(rows):
    return {
        "situations": len(rows),
        "distinct_fires": len({r["event_id"] for r in rows}),
        "by_year": dict(sorted(Counter(str(r["year"]) for r in rows).items())),
        "by_region": dict(sorted(Counter(r["region"] for r in rows).items())),
    }


def quality_report(records, excluded):
    usable = [r for r in records if eligible(r)]
    missing = Counter()
    for r in records:
        for group, fields in r["features"].items():
            for name, m in fields.items():
                if m["value"] is None:
                    missing[f"{group}.{name}"] += 1
        for name, value in r["state"].items():
            if value is None:
                missing[f"state.{name}"] += 1
    return {
        "imported": coverage(records),
        "complete_matching_cohort": coverage(usable),
        "import_exclusions": excluded,
        "incomplete_matching_rows": len(records) - len(usable),
        "missing_fields": dict(missing),
        "flags": dict(Counter(flag for r in records for flag in r["quality_flags"])),
        "zero_growth_rows": sum(r["outcome"]["growth_ha"] == 0 for r in records),
    }


def findings(report, quality):
    q = quality["cfsds"]
    lines = [
        "# Historical fire similarity: measured findings",
        "",
        "Retrospective association experiment; these are not operational forecast scores.",
        "",
        (
            f"Source: CFSDS v1.1, 2002–2021. Imported {q['imported']['situations']:,} situations "
            f"from {q['imported']['distinct_fires']:,} fires; "
            f"{q['complete_matching_cohort']['situations']:,} complete matching situations."
        ),
        "",
        (
            "All methods use the same complete-case query and training cohort. "
            "Scores first average within each fire, then across fires."
        ),
        "",
        "| Method | Mean absolute error (ha) | Historical range width (ha) | Range coverage |",
        "|---|---:|---:|---:|",
    ]
    for method, s in report["temporal"]["test"].items():
        width = f"{s['range_width_ha']:.2f}" if s["range_width_ha"] is not None else "—"
        covered = f"{s['covered']:.1%}" if s["covered"] is not None else "—"
        error = (
            f"{s['absolute_error_ha']:.2f}" if s["absolute_error_ha"] is not None else "unavailable"
        )
        lines.append(f"| {method} | {error} | {width} | {covered} |")
    lines += ["", "## Paired whole-fire bootstrap", ""]
    for method, s in report["temporal"]["improvement_vs"].items():
        if s["ci95_ha"] is not None:
            lo, hi = s["ci95_ha"]
            lines.append(
                f"- Versus {method}: {s['mean_improvement_ha']:.2f} ha improvement; "
                f"95% bootstrap interval [{lo:.2f}, {hi:.2f}] ha. Positive favors environmental matching."
            )
    lines += [
        "",
        "## Geographic transfer",
        "",
        "| Withheld ecozone | Environmental MAE (ha) | State-only MAE (ha) | Persistence MAE (ha) |",
        "|---|---:|---:|---:|",
    ]
    for region, s in report["geographic"].items():
        if s["status"] == "evaluated":
            vals = [
                s["test"][m]["absolute_error_ha"] for m in ("environment", "state", "persistence")
            ]
            lines.append(f"| {region} | " + " | ".join(f"{x:.2f}" for x in vals) + " |")
        else:
            lines.append(f"| {region} | Insufficient validation/test data | — | — |")
    lines += [
        "",
        "## Decision",
        "",
        report["decision"],
        "",
        "## Limitations",
        "",
        (
            "- Covariates summarize the area that actually burned, including future-location information "
            "on some zero-growth days. Weather is reanalysis. Outcomes are reconstructed satellite progressions."
        ),
        (
            "- v1.1 changed the original cohort to fires over 500 ha and 90 m processing. "
            "The published original count is not the count expected for this release. "
            "The release notes label it beta and mention topology fixes; checksums pin the actual input files."
        ),
        (
            "- Complete-case selection, suppression, missing wind direction and fire-size selection limit interpretation. "
            "The empirical 10–90% range is not a calibrated prediction interval."
        ),
        (
            "- Adequate support means enough distinct matching fires; it does not certify physical similarity "
            "or establish an out-of-distribution threshold."
        ),
        (
            "- GOFER is a separate hourly import and quality audit. Its missing environmental features "
            "must be enriched before an environmental matching experiment."
        ),
        "",
    ]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--gofer", type=Path, help="GOFER-Combined v0.2 summary CSV")
    parser.add_argument(
        "--run-comparisons",
        action="store_true",
        help="Explicitly rerun the earlier retrospective matching experiment (outside current phase)",
    )
    args = parser.parse_args()
    if not args.run_comparisons and any(
        (args.output / name).exists()
        for name in (
            "results.json",
            "temporal-results.json",
            "comparison-examples.json",
            "findings.md",
        )
    ):
        parser.error(
            "Choose a separate output directory for data quality; comparison outputs exist here"
        )
    manifest = (
        acquire(args.data_dir)
        if args.download
        else json.loads(Path(__file__).with_name("sources.json").read_text())
    )
    paths = []
    for item in manifest["files"]:
        path = args.data_dir / item["name"]
        if not path.exists() or sha256(path) != item["sha256"]:
            raise ValueError(f"Missing or mismatched source {path}; use --download")
        paths.append(path)
    records, excluded = import_cfsds(paths)
    quality = {"cfsds": quality_report(records, excluded)}
    args.output.mkdir(parents=True, exist_ok=True)
    write_json(args.output / "runtime-manifest.json", runtime_manifest())
    write_json(args.output / "source-manifest.json", manifest)
    with (args.output / "cfsds-situations.jsonl").open("w") as f:
        for r in records:
            f.write(json.dumps(r, allow_nan=False) + "\n")
    if args.gofer:
        if sha256(args.gofer) != manifest["gofer"]["summary_sha256"]:
            raise ValueError("GOFER input is not the pinned Combined v0.2 summary CSV")
        hourly, exclusions = import_gofer(args.gofer)
        quality["gofer"] = quality_report(hourly, exclusions)
        with (args.output / "gofer-situations.jsonl").open("w") as f:
            for r in hourly:
                f.write(json.dumps(r, allow_nan=False) + "\n")
        write_json(args.output / "gofer-example.json", hourly[0] if hourly else None)
    write_json(args.output / "data-quality.json", quality)
    if not args.run_comparisons:
        print(
            "Historical data import and quality audit complete. No comparisons were run.",
            flush=True,
        )
        return
    parts = split(records)
    quality["splits"] = {
        part: {"all": coverage(rows), "complete": coverage([r for r in rows if eligible(r)])}
        for part, rows in parts.items()
    }
    write_json(args.output / "data-quality.json", quality)
    parts = {part: [r for r in rows if eligible(r)] for part, rows in parts.items()}
    print("Running temporal evaluation", flush=True)
    temporal, examples, comparisons = evaluate(**parts)
    write_json(args.output / "temporal-results.json", temporal)
    write_json(args.output / "comparison-examples.json", examples)
    with (args.output / "test-comparisons.jsonl").open("w") as f:
        for method, rows in comparisons.items():
            for row in rows:
                f.write(json.dumps({"method": method, **row}, allow_nan=False) + "\n")
    print("Running withheld-ecozone evaluation", flush=True)
    geography = geographic_evaluation(parts, records)
    improvements = temporal["improvement_vs"]
    passes = all(
        improvements[m]["ci95_ha"] and improvements[m]["ci95_ha"][0] > 0
        for m in ("state", "persistence")
    )
    decision = (
        "Temporal research gate passed: environmental matching improves on state-only matching "
        "and persistence with positive whole-fire bootstrap intervals. Inspect geographic results "
        "before a separate, leakage-safe forecast prototype."
        if passes
        else "Research gate not passed: environmental matching does not demonstrate an improvement "
        "over both state-only matching and persistence with positive whole-fire bootstrap intervals. "
        "Do not advance this method to a forecast prototype on these results."
    )
    report = {
        "interpretation": "retrospective_association_only",
        "seed": 42,
        "temporal": temporal,
        "geographic": geography,
        "decision": decision,
    }
    write_json(args.output / "results.json", report)
    (args.output / "findings.md").write_text(findings(report, quality))
    print(decision, flush=True)


if __name__ == "__main__":
    main()
