"""Download only checksum-pinned public model/demo or compatibility source files."""
import argparse
import json
from pathlib import Path
import time

import requests

from prithvi_hls_catalog import digest

HERE = Path(__file__).resolve().parent


def download(asset, directory):
    name = asset["filename"]
    if Path(name).name != name:
        raise ValueError("Asset filename must be a single path component")
    path = directory / name
    if path.exists():
        if digest(path) != asset["sha256"]:
            raise ValueError("Existing asset checksum mismatch: " + name)
        print("Verified cached " + name, flush=True)
        return
    partial = path.with_suffix(path.suffix + ".partial")
    size = asset.get("size_bytes")
    limit = size if size is not None else 20_000_000
    written, last = 0, time.monotonic()
    # Exclusive creation retains failures instead of overwriting them on retry.
    with partial.open("xb") as stream:
        with requests.get(asset["url"], stream=True, timeout=(30, 120)) as response:
            response.raise_for_status()
            for chunk in response.iter_content(4 * 1024 * 1024):
                written += len(chunk)
                if written > limit:
                    raise ValueError("Asset exceeds pinned size or source-file cap")
                stream.write(chunk)
                if time.monotonic() - last > 10:
                    print(f"{name}: {written / 1_000_000:.1f} MB", flush=True)
                    last = time.monotonic()
    if (size is not None and size != written) or digest(partial) != asset["sha256"]:
        raise ValueError("Downloaded asset failed size/checksum verification: " + name)
    partial.rename(path)
    print("Verified downloaded " + name, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference-sources", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    filename = "prithvi-reference-sources.json" if args.reference_sources else "prithvi-assets.json"
    default_directory = "prithvi-upstream" if args.reference_sources else "prithvi-100m"
    directory = args.output or HERE / "data" / default_directory
    directory.mkdir(parents=True, exist_ok=True)
    pins = json.loads((HERE / filename).read_text(encoding="utf-8"))
    for asset in pins["assets"]:
        download(asset, directory)


if __name__ == "__main__":
    main()
