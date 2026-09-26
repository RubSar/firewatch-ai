"""Download the authors' FLAME2 annotation archive; never execute its contents."""
import argparse
import hashlib
from pathlib import Path
import urllib.request

SOURCE_COMMIT = "f7fffecd9088b907698147eb9be1beca30da0014"
ARCHIVE_URL = ("https://drive.usercontent.google.com/download?"
               "id=1_ryJ9S9Hi-RwcFzVG1ASyEORA-gr5BAy&export=download&confirm=t")
EXPECTED_SIZE = 247348835
EXPECTED_SHA256 = "0e9eab6e477ff1b784e5ab7115c1e922ed14a31a60cd926d51976bf04869e043"


def download(url, destination, limit, expected_hash=None, expected_size=None):
    if destination.exists():
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        if expected_hash and digest == expected_hash:
            return digest
        raise ValueError(f"Existing file not independently verified: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    digest = hashlib.sha256()
    total = 0
    request = urllib.request.Request(url, headers={"User-Agent": "FireWatch-research/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        if int(response.headers.get("Content-Length", "0")) > limit:
            raise ValueError("Download exceeds byte limit")
        with temporary.open("xb") as output:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > limit:
                    raise ValueError("Download exceeds byte limit")
                output.write(chunk)
                digest.update(chunk)
    if expected_size is not None and total != expected_size:
        raise ValueError(f"Unexpected size {total}; expected {expected_size}")
    actual_hash = digest.hexdigest()
    if expected_hash and actual_hash != expected_hash:
        raise ValueError("Publisher archive changed; checksum mismatch")
    temporary.rename(destination)
    return actual_hash


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("data/flame2-rff"))
    args = parser.parse_args()
    digest = download(ARCHIVE_URL, args.output / "FLAME2.zip", 300_000_000,
                      EXPECTED_SHA256, EXPECTED_SIZE)
    print(f"FLAME2.zip bytes={EXPECTED_SIZE} sha256={digest}", flush=True)


if __name__ == "__main__":
    main()
