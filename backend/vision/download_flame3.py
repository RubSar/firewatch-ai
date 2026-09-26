"""Download a bounded, reproducible pilot from the publisher's FLAME 3 listing.

No credentials, model downloads, automatic train/test split, or archive extraction.
Original media stays in the gitignored output directory.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import zipfile

from PIL import Image

DATASET = "brycehopkins/flame-3-computer-vision-subset-sycan-marsh"
API = "https://www.kaggle.com/api/v1/datasets/"
VERSION = 1
MAX_FILE_BYTES = 5_000_000


def get(url, limit):
    with urlopen(Request(url, headers={"User-Agent": "FireWatch-research/0.1"}), timeout=30) as response:
        size = response.headers.get("Content-Length")
        if size and int(size) > limit:
            raise ValueError(f"Response exceeds {limit} bytes: {url}")
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError("Response size limit exceeded")
        return body


def get_json(url):
    return json.loads(get(url, 5_000_000))


def save_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def catalog(output):
    meta = get_json(API + "view/" + DATASET)
    if meta["currentVersionNumber"] != VERSION:
        raise ValueError("Publisher version changed; review and pin the new dataset before continuing")
    save_json(output / "publisher-metadata.json", meta)
    files, token = [], None
    for page in range(30):
        query = {"pageSize": 200, "datasetVersionNumber": VERSION}
        if token:
            query["pageToken"] = token
        result = get_json(API + "list/" + DATASET + "?" + urlencode(query))
        files.extend({"name": item["name"], "bytes": item["totalBytes"]} for item in result["datasetFiles"])
        token = result.get("nextPageToken")
        print(f"Catalog page {page + 1}: {len(files)} files", flush=True)
        if not token:
            break
    else:
        raise ValueError("Catalog exceeded the bounded page budget")
    if len({item["name"] for item in files}) != len(files):
        raise ValueError("Duplicate catalog names; pagination may have changed")
    save_json(output / "catalog.json", files)
    return meta, files


def select_pairs(files, label, count):
    rgb = {PurePosixPath(f["name"]).stem: f for f in files if f"/{label}/RGB/Corrected FOV/" in f["name"]}
    thermal = {PurePosixPath(f["name"]).stem: f for f in files
               if f"/{label}/Thermal/" in f["name"] and f["name"].lower().endswith((".tif", ".tiff"))}
    names = sorted(rgb.keys() & thermal.keys())
    if len(names) < count:
        raise ValueError(f"Only {len(names)} paired samples for {label}; inspect catalog.json")
    # Equally spaced file ranks are an audit sample, not random independent observations.
    indices = [round(i * (len(names) - 1) / (count - 1)) for i in range(count)]
    return [(rgb[names[i]], thermal[names[i]]) for i in indices]


def download_file(item, destination):
    if item["bytes"] > MAX_FILE_BYTES:
        raise ValueError("Unexpectedly large selected file")
    if destination.exists():
        body = destination.read_bytes()
    else:
        query = urlencode({"fileName": item["name"], "datasetVersionNumber": VERSION})
        body = get(API + "download/" + DATASET + "?" + query, MAX_FILE_BYTES)
        # Kaggle wraps some single TIFF downloads in a ZIP. Never extract paths.
        if body.startswith(b"PK\x03\x04"):
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                members = archive.infolist()
                if (len(members) != 1 or members[0].file_size != item["bytes"]
                        or PurePosixPath(members[0].filename).name != PurePosixPath(item["name"]).name):
                    raise ValueError("Unexpected single-file download archive")
                body = archive.read(members[0])
        if len(body) != item["bytes"]:
            raise ValueError(f"Size differs from publisher listing: {item['name']}")
        destination.write_bytes(body)
    if len(body) != item["bytes"]:
        raise ValueError(f"Cached file size mismatch: {destination}")
    return hashlib.sha256(body).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("data/flame3-pilot"))
    parser.add_argument("--per-class", type=int, default=12)
    parser.add_argument("--catalog-only", action="store_true")
    args = parser.parse_args()
    if not 2 <= args.per_class <= 24:
        parser.error("--per-class must be between 2 and 24")
    args.output.mkdir(parents=True, exist_ok=True)
    if (args.output / "catalog.json").exists() and (args.output / "publisher-metadata.json").exists():
        meta = json.loads((args.output / "publisher-metadata.json").read_text(encoding="utf-8"))
        files = json.loads((args.output / "catalog.json").read_text(encoding="utf-8"))
        if meta["currentVersionNumber"] != VERSION:
            raise ValueError("Cached metadata has a different version")
    else:
        meta, files = catalog(args.output)
    if args.catalog_only:
        print(json.dumps(sorted({str(PurePosixPath(f["name"]).parent) for f in files}), indent=2))
        return
    selected = {label: select_pairs(files, label, args.per_class) for label in ("Fire", "No Fire")}
    if sum(item["bytes"] for pairs in selected.values() for pair in pairs for item in pair) > 40_000_000:
        raise ValueError("Selected media exceeds the 40 MB pilot budget; reduce --per-class")
    records = []
    for label in ("Fire", "No Fire"):
        for rgb, thermal in selected[label]:
            sample_id = label.lower().replace(" ", "-") + "-" + PurePosixPath(rgb["name"]).stem
            record = {
                "sample_id": sample_id, "incident_id": "sycan-marsh-cv", "sequence_id": None,
                "split": "pilot", "capture_time_utc": None, "relative_time_s": None,
                "presence_label": label == "Fire", "mask_path": None,
                "mask_semantics": None, "thermal_unit": "celsius",
                "thermal_saturation_c": 500.0,
                "registration": "provider_corrected_fov_unverified",
                "source_paths": {"rgb": rgb["name"], "thermal": thermal["name"]},
                "sha256": {},
            }
            for modality, item, suffix in (("rgb", rgb, ".jpg"), ("thermal", thermal, ".tiff")):
                folder = args.output / modality
                folder.mkdir(exist_ok=True)
                destination = folder / (sample_id + suffix)
                record[modality + "_path"] = destination.relative_to(args.output).as_posix()
                record["sha256"][modality] = download_file(item, destination)
            with Image.open(args.output / record["rgb_path"]) as image:
                exif = image.getexif()
                record["source_capture_time_raw"] = {
                    "datetime_original": exif.get_ifd(34665).get(36867),
                    "offset_time_original": exif.get_ifd(34665).get(36881),
                    "status": "unresolved_clock_and_publisher_date_discrepancy",
                }
            records.append(record)
            print(f"Downloaded paired sample {len(records)}: {sample_id}", flush=True)
    manifest = {
        "schema_version": "firewatch.research.dataset.v1", "data_kind": "real",
        "dataset_id": "flame3-sycan-marsh-v1", "dataset_version": VERSION,
        "source_url": "https://www.kaggle.com/datasets/" + DATASET,
        "publisher_license": meta.get("licenseName"),
        "sampling": "Equal file-rank spacing within each publisher class; selected before running baselines",
        "label_provenance": "Publisher Fire/No Fire image folders; pixel masks and independent label audit unavailable",
        "records": records,
    }
    save_json(args.output / "manifest.json", manifest)
    print(f"Saved {len(records)} records to {args.output / 'manifest.json'}", flush=True)


if __name__ == "__main__":
    main()
