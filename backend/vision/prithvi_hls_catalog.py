"""Public CMR discovery for the frozen Cypress experiment; no imagery/login.

No candidate is accepted until pixel-level Fmask and joint-coverage screening.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import requests

CMR_URL = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def fetch_all(session, params):
    items, pages, seen = [], [], set()
    headers = {}
    expected = None
    while True:
        response = session.get(CMR_URL, params=params, headers=headers, timeout=90)
        response.raise_for_status()
        hits = int(response.headers["CMR-Hits"])
        if expected is None:
            expected = hits
        if hits != expected:
            raise ValueError("Catalogue changed during pagination; use a new output directory")
        body = response.json()
        batch = body["items"]
        pages.append(body)
        items.extend(batch)
        if len(items) == expected:
            break
        token = response.headers.get("CMR-Search-After")
        if len(items) > expected or not batch or not token or token in seen:
            raise ValueError("Incomplete or inconsistent CMR pagination")
        seen.add(token)
        headers["CMR-Search-After"] = token
    identities = [item["meta"]["concept-id"] for item in items]
    if len(set(identities)) != len(items):
        raise ValueError("Duplicate CMR granule identities")
    return items, pages


def group_items(items, product, phase):
    groups = {}
    for item in items:
        umm = item["umm"]
        temporal = umm["TemporalExtent"]
        sensing = (temporal.get("RangeDateTime", {}).get("BeginningDateTime")
                   or temporal.get("SingleDateTime"))
        if not sensing:
            raise ValueError("Granule has no sensing time")
        # Normalize equivalent UTC strings before exact-time grouping.
        dt = datetime.fromisoformat(sensing.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            raise ValueError("Granule sensing time has no timezone")
        sensing = dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        groups.setdefault(sensing, []).append({
            "granule_id": umm["GranuleUR"], "concept_id": item["meta"]["concept-id"],
            "cmr_revision_id": item["meta"]["revision-id"],
        })
    return [{"product": product, "phase": phase, "sensing_utc": sensing,
             "granules": sorted(granules, key=lambda x: x["granule_id"]),
             "fmask_valid_fraction": None, "accepted": False}
            for sensing, granules in sorted(groups.items())]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8-sig"))
    incident = config["incident"]
    snapshot = args.config.parent / incident["source_snapshot"]
    if digest(snapshot) != incident["source_snapshot_sha256"]:
        raise ValueError("Frozen WFIGS snapshot hash mismatch")
    report_path = args.config.parent / incident["aoi_source_report"]
    report = json.loads(report_path.read_text(encoding="utf-8-sig"))
    if report["config"]["incident_id"] != incident["incident_id"]:
        raise ValueError("AOI source belongs to a different incident")
    bbox = report["grid"]["bbox_wgs84"]
    args.output.mkdir(parents=True, exist_ok=False)
    session = requests.Session()
    session.headers["User-Agent"] = "FireWatch-research/0.1"
    queries, groups = [], []
    for phase in ("pre", "post"):
        for product in config["imagery"]["product_candidates"]:
            params = {"short_name": product, "version": "2.0", "page_size": 2000,
                      "bounding_box": ",".join(map(str, bbox)),
                      "temporal": ",".join(config["imagery"][phase + "_window_utc"])}
            items, pages = fetch_all(session, params)
            file = args.output / f"{phase}-{product}-cmr.json"
            write_json(file, pages)
            groups.extend(group_items(items, product, phase))
            queries.append({"params": params, "granule_count": len(items),
                            "file": file.name, "sha256": digest(file)})
            print(f"{phase} {product}: {len(items)} granules", flush=True)
    result = {"schema_version": "firewatch.research.prithvi-hls-catalog.v1",
              "created_at_utc": datetime.now(timezone.utc).isoformat(),
              "experiment_id": config["experiment_id"], "endpoint": CMR_URL,
              "config_sha256": digest(args.config), "aoi_source_sha256": digest(report_path),
              "bbox_wgs84": bbox, "queries": queries, "groups": groups,
              "status": "metadata_only_pending_authenticated_acquisition_and_quality_screen",
              "selected_pair": None, "imagery_downloaded": False,
              "coverage_gate_passed": False}
    write_json(args.output / "catalog.json", result)


if __name__ == "__main__":
    main()
