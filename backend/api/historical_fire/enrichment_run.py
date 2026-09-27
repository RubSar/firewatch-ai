"""Run the documented three-fire GOFER enrichment pilot; writes only derived sidecars."""
import argparse
import json
from collections import Counter
from pathlib import Path

from .enrichment_core import load_pilot, without_coordinates, write_json
from .enrichment_ee import acquire_event
from .landfire import enrich as enrich_landfire


def run(archive: Path, summary: Path, output: Path, project: str, events=None):
    import ee

    ee.Initialize(project=project)
    rows = load_pilot(archive, summary, 72)
    if events:
        allowed = set(events)
        rows = [r for r in rows if r["event_id"] in allowed]
        found = {r["event_id"] for r in rows}
        if found != allowed:
            raise ValueError(f"Unknown pilot event(s): {sorted(allowed - found)}")
    outputs = []
    for event, group in _groups(rows):
        enriched = acquire_event(group, output / "raw")
        landfire = enrich_landfire(group, output / "raw" / "landfire" / event.replace(":", "-"))
        enriched["landfire"] = landfire
        enriched["raws_cross_check"] = {
            "status": "not_acquired",
            "source": "https://raws.dri.edu/ (WRCC RAWS USA Climate Archive)",
            "reason": "Historical station downloads require archive access; no station credential was supplied.",
            "station": None, "distance_km": None, "elevation_m": None,
            "observation_time": None, "measurement_conventions": None,
            "firewide_representative": False,
        }
        event_dir = output / event.replace(":", "-")
        for record in group:
            record["measurements"].sort(
                key=lambda m: (m["field"], m["spatial_support"]["kind"])
            )
        # Event-constant final extent is stored once; the original GOFER perimeters remain
        # available in the immutable source archive, identified by its checksum.
        final_perimeter = group[0].pop("final_perimeter")
        for row in group:
            row.pop("final_perimeter", None)
            row["final_perimeter_reference"] = final_perimeter["timestamp"]
        write_json(event_dir / "intervals.json", group)
        write_json(event_dir / "intervals-simple.json", without_coordinates(group))
        quality = _quality_report(group)
        write_json(event_dir / "before-after-completeness.json", quality)
        write_json(event_dir / "event-enrichment.json", enriched)
        outputs.append({
            "event_id": event,
            "intervals": len(group),
            "footprint_intervals": sum(r["footprint"]["geometry"] is not None for r in group),
            "zero_growth_intervals": sum(r["footprint"]["geometry"] is None for r in group),
            "quality_flags": dict(Counter(flag for r in group for flag in r["quality_flags"])),
            "final_extent": enriched["final_extent_comparison"],
            "landfire": landfire,
            "quality_report": quality,
        })
        print(f"{event}: wrote {len(group)} intervals", flush=True)
    report = {
        "scope": "GOFER first 72 source-hour intervals; enrichment only; no prediction",
        "source_archive": {"path": str(archive), "sha256": rows[0]["original"]["archive_sha256"]},
        "source_summary": {"path": str(summary), "sha256": rows[0]["original"]["summary_sha256"]},
        "events": outputs,
    }
    manifest_path = output / "pilot-manifest.json"
    if events and manifest_path.exists():
        old = json.loads(manifest_path.read_text())
        merged = {event["event_id"]: event for event in old["events"]}
        merged.update({event["event_id"]: event for event in report["events"]})
        report["events"] = list(merged.values())
    write_json(manifest_path, report)
    return report


def _groups(rows):
    for event in sorted({r["event_id"] for r in rows}):
        yield event, [r for r in rows if r["event_id"] == event]


def _quality_report(records):
    from collections import Counter, defaultdict

    values = defaultdict(Counter)
    flags = Counter(flag for r in records for flag in r["quality_flags"])
    for record in records:
        flags.update(flag for m in record["measurements"] for flag in m["quality_flags"])
        for m in record["measurements"]:
            key = f"{m['field']}|{m['spatial_support']['kind']}"
            values[key]["total"] += 1
            values[key]["present" if m["value"] is not None else "missing"] += 1
    count = len(records)
    footprints = sum(r["footprint"]["geometry"] is not None for r in records)
    return {
        "event_id": records[0]["event_id"], "intervals": count,
        "source_environment_measurements_before_enrichment": 0,
        "intervals_with_newly_burned_footprint": footprints,
        "intervals_without_newly_burned_footprint": count - footprints,
        "measurements_by_field_and_spatial_support": {
            key: dict(sorted(value.items())) for key, value in sorted(values.items())
        },
        "quality_flags": dict(sorted(flags.items())),
        "raws_status": "historical station observations not acquired; archive access gap",
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--archive", type=Path, required=True)
    p.add_argument("--summary", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--project", required=True)
    p.add_argument("--event", action="append", help="Repeat for one or more gofer:YEAR:Name ids")
    a = p.parse_args()
    report = run(a.archive, a.summary, a.output, a.project, a.event)
    print(json.dumps({"events": len(report["events"]), "output": str(a.output)}))


if __name__ == "__main__":
    main()
