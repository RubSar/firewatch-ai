"""Run fixed, offline RGB/thermal rules; record observations and auditable metrics."""
import argparse
import json
from pathlib import Path
import platform
import time

import numpy as np
from PIL import Image, ImageDraw, __version__ as pillow_version

from baselines import Config, combine_presence, confusion, mask_counts, mask_scores, presence, rgb_candidates, thermal_candidates
from dataset import load_record, sha256, utc_now, validate_manifest


METHODS = ("rgb_rules", "thermal_threshold", "presence_or")


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def overlay(image, mask):
    pixels = image.astype(np.float32).copy()
    if mask is not None:
        pixels[mask] = pixels[mask] * 0.45 + np.array([255, 70, 0]) * 0.55
    return Image.fromarray(pixels.astype(np.uint8)).resize((320, 256))


def preview(rgb, thermal, rgb_mask, thermal_mask, record):
    panel = Image.new("RGB", (640, 296), "white")
    draw = ImageDraw.Draw(panel)
    label = record["presence_label"]
    draw.text((5, 4), f"{record['sample_id']} | publisher Fire label: {label}", fill="black")
    draw.text((5, 20), "RGB: orange = rule candidate", fill="black")
    draw.text((325, 20), "Thermal: orange = anomaly candidate", fill="black")
    if rgb is not None:
        panel.paste(overlay(rgb, rgb_mask), (0, 40))
    if thermal is not None and np.isfinite(thermal).any():
        valid = np.isfinite(thermal)
        low, high = np.percentile(thermal[valid], [1, 99])
        normalized = np.nan_to_num((thermal - low) / max(1, high-low), nan=0, posinf=1, neginf=0)
        gray = (np.clip(normalized, 0, 1) * 255).astype(np.uint8)
        panel.paste(overlay(np.repeat(gray[:, :, None], 3, axis=2), thermal_mask), (320, 40))
    return panel


def run(manifest_path, output, config, split):
    manifest = validate_manifest(manifest_path)
    records = [r for r in manifest["records"] if r["split"] == split]
    if not records:
        raise ValueError(f"No records in {split} split")
    if output.resolve() == manifest_path.parent.resolve():
        raise ValueError("Output must not be the input dataset directory")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output directory is not empty; use a new run directory to preserve prior results")
    output.mkdir(parents=True, exist_ok=True)
    (output / "masks").mkdir(exist_ok=True)
    observations, timings, panels = [], {m: [] for m in METHODS}, []
    pixel_counts = dict(tp=0, fp=0, fn=0, valid_pixels=0)
    labeled_masks = 0
    for index, record in enumerate(records):
        rgb, thermal, target = load_record(manifest_path.parent, record)
        masks, predictions = {"rgb_rules": None, "thermal_threshold": None}, {}
        flags = ["image_space_only", "visibility_not_assessed"]
        if record["capture_time_utc"] is None:
            flags.append("capture_clock_unknown")
        if record["registration"] != "verified":
            flags.append("pixel_registration_unverified")
        start = time.perf_counter()
        predictions["rgb_rules"] = None
        if rgb is not None:
            masks["rgb_rules"] = rgb_candidates(rgb, config)
            predictions["rgb_rules"] = presence(masks["rgb_rules"], config.min_presence_pixels)
            timings["rgb_rules"].append((time.perf_counter()-start)*1000)
        else:
            flags.append("rgb_unavailable")
        start = time.perf_counter()
        predictions["thermal_threshold"] = None
        thermal_stats = None
        if thermal is not None:
            masks["thermal_threshold"], valid = thermal_candidates(thermal, record["thermal_unit"], config)
            found = presence(masks["thermal_threshold"], config.min_presence_pixels)
            # A positive has evidence; a negative requires the complete thermal raster.
            predictions["thermal_threshold"] = found if found or valid.all() else None
            timings["thermal_threshold"].append((time.perf_counter()-start)*1000)
            values = thermal[valid]
            saturation_reference = record.get("thermal_saturation_c")
            saturated = bool(saturation_reference is not None and values.size and np.any(values >= saturation_reference))
            if saturation_reference is None:
                flags.append("thermal_saturation_limit_unknown")
            if not valid.all():
                flags.append("thermal_invalid_pixels")
            if saturated:
                flags.append("thermal_at_publisher_saturation_bound")
            thermal_stats = {
                "valid_fraction": float(valid.mean()), "saturation_reference_c": saturation_reference,
                "at_saturation_bound": saturated,
                "finite_min_c": float(values.min()) if values.size else None,
                "finite_max_c": float(values.max()) if values.size and not saturated else None,
                "max_lower_bound_c": saturation_reference if saturated else None,
            }
        else:
            flags.append("thermal_unavailable")
        predictions["presence_or"] = combine_presence(predictions["rgb_rules"], predictions["thermal_threshold"])
        counts = None
        if target is not None:
            counts = mask_counts(masks["rgb_rules"], target)
            for key, value in counts.items():
                pixel_counts[key] += value
            labeled_masks += 1
        # Safe generated filenames avoid treating a provider sample_id as a path.
        mask_paths = {}
        for method, mask in masks.items():
            if mask is not None:
                path = Path("masks") / f"{index:04d}-{method}.png"
                Image.fromarray(mask.astype(np.uint8)).save(output / path)
                mask_paths[method] = path.as_posix()
        observations.append({
            "sample_id": record["sample_id"], "incident_id": record["incident_id"],
            "capture_time_utc": record["capture_time_utc"], "relative_time_s": record["relative_time_s"],
            "source_capture_time_raw": record.get("source_capture_time_raw"),
            "processed_at_utc": utc_now(), "publisher_presence_label": record["presence_label"],
            "candidate_presence": predictions, "masks": mask_paths,
            "mask_encoding": {"background": 0, "candidate": 1},
            "mask_semantics": {"rgb_rules": "visible_flame_candidate", "thermal_threshold": "thermal_anomaly"},
            "thermal_stats": thermal_stats, "quality_flags": flags,
            "ground_geometry": None, "rgb_mask_metrics": mask_scores(counts) if counts else None,
        })
        panels.append(preview(rgb, thermal, masks["rgb_rules"], masks["thermal_threshold"], record))
        print(f"Processed {index+1}/{len(records)}: {record['sample_id']}", flush=True)
    truth = [r["presence_label"] for r in records]
    scores = {method: confusion(truth, [o["candidate_presence"][method] for o in observations]) for method in METHODS}
    report = {
        "schema_version": "firewatch.research.result.v1", "created_at_utc": utc_now(),
        "dataset_id": manifest["dataset_id"], "dataset_version": manifest.get("dataset_version"),
        "data_kind": manifest["data_kind"], "split": split,
        "evidence_level": "single_incident_pilot" if len({r["incident_id"] for r in records}) == 1 else "multi_incident_experiment",
        "manifest_sha256": sha256(manifest_path), "config": config.to_dict(),
        "code_sha256": {name: sha256(Path(__file__).parent / name) for name in ("baselines.py", "dataset.py", "run_baseline.py")},
        "environment": {"python": platform.python_version(), "numpy": np.__version__, "pillow": pillow_version,
                        "platform": platform.platform(), "processor": platform.processor()},
        "samples": len(records), "incidents": len({r["incident_id"] for r in records}),
        "image_presence": scores,
        "rgb_pixel_segmentation": mask_scores(pixel_counts) if labeled_masks else None,
        "labeled_masks": labeled_masks,
        "algorithm_wall_time_ms": {
            method: {"median": float(np.median(values)), "p95": float(np.percentile(values, 95)), "n": len(values)}
            for method, values in timings.items() if values
        },
        "unavailable_metrics": {
            "boundary_error": "Not implemented in this milestone; requires independently reviewed pixel masks",
            "false_alerts_per_flight_hour": "No continuous, fully labeled flight timeline evaluated",
            "time_to_detection": "No verified event onset and continuous timeline evaluated",
            "capture_to_result_latency": "Offline processing; capture/receipt clocks not instrumented",
            "geolocation_and_spread_error": "Image-space pilot; no calibrated ground projection evaluated",
        },
        "limitations": [
            "No learned model trained or evaluated; no evidence yet of improvement over these rules.",
            "Publisher image labels are not pixel masks; label generation was not independently audited.",
            "Thermal anomalies and visible flame are different targets; presence comparison is exploratory.",
            "Case-balanced rank sampling does not estimate operational prevalence or false alerts/hour.",
            "Algorithm timing excludes loading, networking, visualization and queueing; not drone latency.",
            "The image-level OR does not perform pixel fusion, geolocation or temporal tracking.",
            "No unseen-incident generalization claim is supported by a single-incident pilot.",
        ],
    }
    write_json(output / "report.json", report)
    with (output / "observations.jsonl").open("w", encoding="utf-8") as stream:
        for observation in observations:
            stream.write(json.dumps(observation, allow_nan=False) + "\n")
    for start in range(0, len(panels), 6):
        page = Image.new("RGB", (640, 296*len(panels[start:start+6])), "white")
        for i, panel in enumerate(panels[start:start+6]):
            page.paste(panel, (0, i*296))
        page.save(output / f"contact-sheet-{start//6+1}.png")
    def fmt(value):
        return "unavailable" if value is None else f"{value:.3f}"
    lines = ["# Fixed-rule pilot results", "", f"Dataset: {report['dataset_id']}; split: {split}.",
             f"Samples: {report['samples']}; incidents: {report['incidents']}; pixel masks: {labeled_masks}.", "",
             "Image-level comparisons against publisher labels; not an independent fire-detection benchmark.", "",
             "| Method | TP | FN | FP | TN | Unavailable | Precision | Recall | Negative-image FPR |",
             "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for method, score in scores.items():
        lines.append(f"| {method} | {score['tp']} | {score['fn']} | {score['fp']} | {score['tn']} | {score['unavailable']} | "
                     f"{fmt(score['precision'])} | {fmt(score['recall'])} | {fmt(score['negative_image_false_positive_rate'])} |")
    lines += ["", "## Limits", ""] + ["- " + value for value in report["limitations"]]
    lines += ["", "Unavailable metrics are listed with reasons in report.json.",
              "Contact sheets normalize thermal contrast separately per image; orange shows fixed-rule candidates.",
              "Configuration and input/code hashes are recorded. Threshold-selection history belongs in the experiment protocol."]
    (output / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--split", choices=("pilot", "train", "validation", "test"), default="pilot")
    parser.add_argument("--thermal-threshold-c", type=float, default=80.0)
    args = parser.parse_args()
    report = run(args.manifest, args.output, Config(thermal_threshold_c=args.thermal_threshold_c), args.split)
    print(json.dumps(report["image_presence"], indent=2))


if __name__ == "__main__":
    main()
