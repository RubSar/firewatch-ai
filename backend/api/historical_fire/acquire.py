"""Download checksum-pinned public source archives without extracting arbitrary paths."""

import hashlib
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def acquire(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(Path(__file__).with_name("sources.json").read_text())

    def download(item):
        dest = directory / item["name"]
        if not dest.exists() or sha256(dest) != item["sha256"]:
            partial = dest.with_suffix(".partial")
            subprocess.run(
                [
                    "curl",
                    "--fail",
                    "--location",
                    "--silent",
                    "--show-error",
                    "--retry",
                    "3",
                    "--max-time",
                    "240",
                    item["url"],
                    "-o",
                    str(partial),
                ],
                check=True,
            )
            if sha256(partial) != item["sha256"]:
                raise ValueError(f"Source checksum mismatch: {item['name']}")
            partial.replace(dest)
        return dest

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(download, manifest["files"]))
    return manifest
