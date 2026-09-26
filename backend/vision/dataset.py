"""Research-manifest validation and lossless sensor loading. See contracts/research."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def local_path(root, value):
    if not isinstance(value, str) or not value or Path(value).is_absolute():
        raise ValueError("Media paths must be nonempty relative paths")
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Media path escapes the manifest directory")
    if not path.is_file():
        raise ValueError(f"Missing media: {path}")
    return path


def validate_manifest(path):
    path = Path(path)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != "firewatch.research.dataset.v1":
        raise ValueError("Unsupported manifest schema")
    if manifest.get("data_kind") not in ("real", "synthetic"):
        raise ValueError("data_kind must distinguish real and synthetic data")
    for field in ("dataset_id", "source_url", "label_provenance", "sampling"):
        if not isinstance(manifest.get(field), str) or not manifest[field]:
            raise ValueError(f"Missing {field}")
    if not manifest.get("records"):
        raise ValueError("Empty dataset")
    ids, incidents, sequences, hashes = set(), {}, {}, {}
    fields = {"sample_id", "incident_id", "sequence_id", "split", "capture_time_utc", "relative_time_s",
              "presence_label", "rgb_path", "thermal_path", "thermal_unit", "registration",
              "mask_path", "mask_semantics", "sha256"}
    for record in manifest["records"]:
        if fields - record.keys():
            raise ValueError(f"Missing record fields: {sorted(fields - record.keys())}")
        sid = record["sample_id"]
        if not isinstance(sid, str) or not sid or sid in ids:
            raise ValueError("Empty or duplicate sample_id")
        ids.add(sid)
        incident, split = record["incident_id"], record["split"]
        if not isinstance(incident, str) or not incident:
            raise ValueError("Known incident_id required; do not invent independent incidents")
        if split not in ("pilot", "train", "validation", "test"):
            raise ValueError("Unknown split")
        if incidents.setdefault(incident, split) != split:
            raise ValueError("Incident leakage across splits")
        sequence = record["sequence_id"]
        if sequence is not None:
            if not isinstance(sequence, str) or not sequence:
                raise ValueError("sequence_id must be a nonempty string or null")
            if sequences.setdefault(sequence, (incident, split)) != (incident, split):
                raise ValueError("Sequence leakage or inconsistent incident")
        if record["presence_label"] is not None and type(record["presence_label"]) is not bool:
            raise ValueError("presence_label must be boolean or null")
        stamp = record["capture_time_utc"]
        if stamp is not None:
            if not isinstance(stamp, str) or not stamp.endswith("Z"):
                raise ValueError("UTC capture time must end in Z; unknown time is null")
            parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            if "T" not in stamp or parsed.tzinfo is None or parsed.utcoffset().total_seconds() != 0:
                raise ValueError("UTC capture time must be a full datetime with a verified UTC offset")
        relative = record["relative_time_s"]
        if relative is not None:
            if type(relative) not in (float, int) or not np.isfinite(relative) or relative < 0 or sequence is None:
                raise ValueError("Relative seconds require a sequence and a finite nonnegative number")
        if record["registration"] not in ("verified", "provider_corrected_fov_unverified", "unregistered", "not_applicable"):
            raise ValueError("Unknown registration status")
        if record["thermal_path"] is not None and record["thermal_unit"] != "celsius":
            raise ValueError("Convert raw thermal counts using documented calibration before ingestion")
        saturation = record.get("thermal_saturation_c")
        if saturation is not None and (type(saturation) not in (float, int) or not np.isfinite(saturation)):
            raise ValueError("Thermal saturation reference must be finite Celsius or null")
        if record["rgb_path"] is None and record["thermal_path"] is None:
            raise ValueError("At least one modality required")
        if record["mask_path"] is not None and (record["mask_semantics"] != "visible_flame" or record["rgb_path"] is None):
            raise ValueError("This evaluator supports only RGB-coordinate visible_flame ground truth")
        for modality in ("rgb", "thermal", "mask"):
            value = record[modality + "_path"]
            if value is None:
                continue
            media = local_path(path.parent, value)
            actual_hash = sha256(media)
            if record["sha256"].get(modality) != actual_hash:
                raise ValueError(f"SHA-256 mismatch for {sid}/{modality}")
            if modality != "mask" and hashes.setdefault(actual_hash, split) != split:
                raise ValueError("Duplicate media content across splits")
    return manifest


def load_record(root, record):
    rgb, thermal, mask = None, None, None
    if record["rgb_path"]:
        with Image.open(local_path(root, record["rgb_path"])) as image:
            # Do not rotate RGB alone by EXIF: this would change the provider's registration.
            rgb = np.array(image.convert("RGB"))
    if record["thermal_path"]:
        with Image.open(local_path(root, record["thermal_path"])) as image:
            raw = np.array(image)
            if image.format != "TIFF" or raw.ndim != 2 or raw.dtype.kind != "f":
                raise ValueError("Expected floating-point Celsius TIFF; integer counts/palettes need explicit conversion")
            thermal = raw.astype(np.float32)
    if record["registration"] == "verified" and rgb is not None and thermal is not None and rgb.shape[:2] != thermal.shape:
        raise ValueError("Verified pixel registration requires identical raster dimensions")
    if record["mask_path"]:
        with Image.open(local_path(root, record["mask_path"])) as image:
            mask = np.array(image)
    return rgb, thermal, mask


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
