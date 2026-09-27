"""Run the pinned 100M burn-scar model on the publisher's public HLS demo.

This is a local execution check, not Cypress Creek evaluation or a benchmark.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import time

import numpy as np
import rasterio
import torch

from prithvi_legacy import (CHECKPOINT_SHA256, MEANS, STDS, load_model,
                            normalize, predict, sha256)

HERE = Path(__file__).resolve().parent


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def read_reflectance(path):
    with rasterio.open(path) as src:
        if src.count != 6 or not all(dtype.startswith("float") for dtype in src.dtypes):
            raise ValueError("Expected six floating-point reflectance bands; raw HLS needs preparation")
        masked = src.read(masked=True)
        values = masked.data.astype(np.float32)
        valid = (~np.ma.getmaskarray(masked) & np.isfinite(values)).all(axis=0)
        # The publisher HLS example uses -9999 as fill, even if metadata is absent.
        valid &= (values != -9999).all(axis=0)
        if not valid.any():
            raise ValueError("No valid reflectance pixels")
        if np.abs(values[:, valid]).max() > 2:
            raise ValueError("Values do not look like reflectance units; no automatic rescaling")
        return values, valid, src.profile.copy()


def preview(values, labels, output):
    os.environ.setdefault("MPLCONFIGDIR", str(HERE / ".venv" / ".matplotlib"))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap
    fig, axes = plt.subplots(1, 2, figsize=(10, 5), constrained_layout=True)
    rgb = np.clip(values[[2, 1, 0]].transpose(1, 2, 0) / 0.3, 0, 1)
    rgb[labels < 0] = 0.6
    axes[0].imshow(rgb)
    axes[0].set_title("Publisher HLS demo (2018) | RGB")
    axes[1].imshow(labels, cmap=ListedColormap(["#999999", "#e5ecde", "#d75632"]), vmin=-1, vmax=1)
    axes[1].set_title("100M model | candidate burn scar")
    for ax in axes:
        ax.axis("off")
    fig.suptitle("Local execution check - not Cypress Creek or validated fire extent")
    fig.text(0.5, -0.025, "Orange: predicted burn scar   Pale: predicted unburnt   Gray: unknown. No Fmask supplied.", ha="center")
    fig.savefig(output, dpi=140, bbox_inches="tight")
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, default=HERE / "data" / "prithvi-100m")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    args = parser.parse_args()
    pins = json.loads((HERE / "prithvi-assets.json").read_text(encoding="utf-8"))
    for asset in pins["assets"]:
        if sha256(args.assets / asset["filename"]) != asset["sha256"]:
            raise ValueError("Asset checksum mismatch: " + asset["filename"])
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable; CPU requires explicit --device cpu")
    args.output.mkdir(parents=True, exist_ok=False)
    report = {"schema_version": "firewatch.research.prithvi-local-smoke.v1",
              "created_at_utc": datetime.now(timezone.utc).isoformat(), "status": "started",
              "purpose": "hardware/adapter execution check on publisher demo, not an accuracy evaluation",
              "model": pins["model"], "checkpoint_sha256": CHECKPOINT_SHA256,
              "assets": pins["assets"], "device": args.device, "python": platform.python_version(),
              "torch": torch.__version__, "cuda_runtime": torch.version.cuda,
              "numpy": np.__version__, "rasterio": rasterio.__version__,
              "model_code_sha256": sha256(HERE / "prithvi_legacy.py"),
              "runner_sha256": sha256(Path(__file__)),
              "accuracy_metrics": None, "cypress_creek_evaluation_completed": False,
              "limitations": ["No reference labels scored", "No Fmask supplied with demo",
                              "No held-out claim; sample may overlap model development data",
                              "Unknown input context is filled at the training mean"]}
    torch.set_num_threads(4)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False
    try:
        if args.device == "cuda":
            report["gpu"] = torch.cuda.get_device_name(0)
            report["gpu_total_bytes"] = torch.cuda.get_device_properties(0).total_memory
            torch.cuda.reset_peak_memory_stats()
        started = time.perf_counter()
        model = load_model(args.assets / pins["assets"][0]["filename"], args.device)
        report["parameters_including_unused_auxiliary_head"] = sum(p.numel() for p in model.parameters())
        report["checkpoint_load"] = "weights_only=True; strict=True; all keys matched"
        print("Pinned checkpoint loaded; running 512x512 demo with 224px windows", flush=True)
        values, valid, profile = read_reflectance(args.assets / pins["assets"][1]["filename"])
        if values.shape != (6, 512, 512):
            raise ValueError("Publisher demo shape changed")
        normalized = normalize(values, valid)
        inference_start = time.perf_counter()
        labels, logits = predict(model, normalized, valid, args.device)
        if args.device == "cuda":
            torch.cuda.synchronize()
            report["gpu_peak_allocated_bytes"] = torch.cuda.max_memory_allocated()
            report["gpu_peak_reserved_bytes"] = torch.cuda.max_memory_reserved()
        report["inference_seconds"] = time.perf_counter() - inference_start
        report["load_and_inference_seconds"] = time.perf_counter() - started
        report["input_shape"] = list(values.shape)
        report["reflectance_range"] = [float(values[:, valid].min()), float(values[:, valid].max())]
        report["reflectance_values_outside_0_1"] = int(((values[:, valid] < 0) | (values[:, valid] > 1)).sum())
        report["normalization"] = {"means": MEANS, "stds": STDS, "clipping": False}
        report["inference"] = {"precision": "float32; TF32 disabled", "crop": 224,
                               "stride": 112, "batch_size": 1, "windows": 16,
                               "aggregation": "arithmetic mean of overlapping logits; argmax"}
        report["class_counts"] = {str(v): int((labels == v).sum()) for v in (-1, 0, 1)}
        report["nodata_valid_fraction"] = float(valid.mean())
        report["fmask_quality_verified"] = False
        profile.update(count=1, dtype="int16", nodata=-1, compress="lzw")
        with rasterio.open(args.output / "candidate-burn-scar.tif", "w", **profile) as dst:
            dst.write(labels, 1)
        preview(values, labels, args.output / "preview.png")
        report["outputs"] = {name: sha256(args.output / name)
                             for name in ("candidate-burn-scar.tif", "preview.png")}
        report["status"] = "passed_execution_check_only"
    except Exception as exc:
        report["status"] = "failed"
        report["error_type"] = type(exc).__name__
        report["error"] = str(exc)
        raise
    finally:
        write_json(args.output / "report.json", report)
    print(json.dumps({k: report[k] for k in ("status", "inference_seconds", "class_counts")}, indent=2))


if __name__ == "__main__":
    main()
