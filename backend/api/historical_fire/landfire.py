"""Extract polygon-specific statistics from the public LANDFIRE image services."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from json import dumps, loads
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform

from .enrichment_core import digest, measurement, write_json

BASE = "https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2016"
# LF2016 Remap is the most recent explicitly pre-fire release available before all three events.
LAYERS = {
    "fuel_model_40": ("LF2016_FBFM40_CONUS", "categorical", "LANDFIRE FBFM40 code", 1, "class code"),
    "canopy_cover_pct": ("LF2016_CC_CONUS", "continuous", "%", 1, "percent"),
    "canopy_height_m": ("LF2016_CH_CONUS", "continuous", "m", 0.1, "meters * 10"),
    "canopy_base_height_m": ("LF2016_CBH_CONUS", "continuous", "m", 0.1, "meters * 10"),
    "canopy_bulk_density_kg_m3": ("LF2016_CBD_CONUS", "continuous", "kg/m3", 0.01, "kg/m3 * 100"),
    "vegetation_type_code": ("LF2016_EVT_CONUS", "categorical", "LANDFIRE EVT code", 1, "class code"),
    "vegetation_cover_class_codes": ("LF2016_EVC_CONUS", "categorical", "LANDFIRE EVC code", 1, "class code"),
    "vegetation_height_class_codes": ("LF2016_EVH_CONUS", "categorical", "LANDFIRE EVH code", 1, "class code"),
}
TO_5070 = Transformer.from_crs(4326, 5070, always_xy=True).transform


def arcgis_geometry(geojson):
    g = transform(TO_5070, shape(geojson)).simplify(15, preserve_topology=True)
    polygons = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    rings = []
    for polygon in polygons:
        rings.append([list(p) for p in polygon.exterior.coords])
        rings.extend([list(p) for p in ring.coords] for ring in polygon.interiors)
    return {"rings": rings, "spatialReference": {"wkid": 5070}}


def query(layer, geometry, timeout=180):
    categorical = any(layer == spec[0] and spec[1] == "categorical"
                      for spec in LAYERS.values())
    operation = "getSamples" if categorical else "computeStatisticsHistograms"
    url = f"{BASE}/{layer}/ImageServer/{operation}"
    params = {
        "geometry": dumps(geometry, separators=(",", ":")),
        "geometryType": "esriGeometryPolygon",
        "pixelSize": dumps({"x": 30, "y": 30, "spatialReference": {"wkid": 5070}}),
        "f": "json",
    }
    if categorical:
        params.update(sampleCount="1000", returnFirstValueOnly="true")
    req = Request(url, data=urlencode(params).encode(),
                  headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urlopen(req, timeout=timeout) as response:
        data = loads(response.read())
    if "error" in data:
        raise RuntimeError(data["error"])
    return data


def enrich(records, cache_dir: Path, workers=8):
    """Attach categorical distributions and continuous pixel summaries, never to null footprints."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    tasks = []
    for record in records:
        if record["footprint"]["geometry"] is None:
            for field, spec in LAYERS.items():
                record["measurements"].append(measurement(
                    field, None, spec[2], "reconstructed",
                    {"id": f"LANDFIRE LF2016 Remap/{spec[0]}", "version": "LF2016"}, {},
                    {"start": None, "end": None, "convention": "static prefiresnapshot"},
                    {"kind": "newly_burned"}, "No newly burned footprint in this GOFER interval",
                    ["no_newly_burned_footprint"]))
            continue
        geom = arcgis_geometry(record["footprint"]["geometry"])
        for field, (layer, kind, unit, factor, native_unit) in LAYERS.items():
            category = kind == "categorical"
            cache_key = digest((record["interval_id"] + layer +
                                ("samples-v3" if category else "stats-v3")).encode())[:20]
            path = cache_dir / f"{cache_key}.json"
            tasks.append((record, field, layer, kind, unit, geom, path, factor, native_unit))

    def fetch(task):
        _, _, layer, _, _, geom, path, *_ = task
        if path.exists():
            return task, loads(path.read_text())
        data = query(layer, geom)
        write_json(path, data)
        return task, data

    by_id = {record["interval_id"]: record for record in records}
    errors = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch, task): task for task in tasks}
        for future in as_completed(futures):
            source_task = futures[future]
            try:
                task = future.result()
                data = task[1]
            except (OSError, ValueError, RuntimeError) as exc:  # Explicit source gap.
                record, field, layer, kind, unit, geom, path, factor, native_unit = source_task
                errors.append({"interval_id": record["interval_id"], "layer": layer,
                               "error": str(exc)[:500]})
                record["measurements"].append(measurement(
                    field, None, unit, "reconstructed",
                    {"id": f"LANDFIRE LF2016 Remap/{layer}", "version": "LF2016 Remap"}, {},
                    {"start": None, "end": None, "convention": "static_layer_representing_2016"},
                    {"kind": "newly_burned", "simplification_tolerance_m": 15,
                     "query_crs": "EPSG:5070"},
                    "LANDFIRE ImageServer request failed; value left missing",
                    ["source_request_failed"]))
                continue
            record, field, layer, kind, unit, geom, path, factor, native_unit = task[0]
            stats = (data.get("statistics") or [{}])[0]
            if kind == "categorical":
                samples = data.get("samples", [])
                counts = {}
                nodata_count = 0
                for sample in samples:
                    code = str(sample.get("value"))
                    if code in {"None", "-9999"}:
                        nodata_count += 1
                        continue
                    counts[code] = counts.get(code, 0) + 1
                valid_samples = sum(counts.values())
                value = {"class_sample_counts": counts,
                         "class_sample_proportions": {k: v / valid_samples
                                                      for k, v in counts.items()} if valid_samples else {},
                         "mode": max(counts, key=counts.get) if counts else None,
                         "sample_count": len(samples), "nodata_sample_count": nodata_count} if samples else None
                original, flags = data, ([] if samples else ["no_raster_support"])
                if nodata_count:
                    flags.append("nodata_samples_excluded")
            elif not stats.get("count"):
                value, original, flags = None, data, ["no_raster_support"]
            else:
                value, original, flags = stats.get("mean"), data, []
                if value is not None:
                    value *= factor
            record["measurements"].append(measurement(
                field, value, unit, "reconstructed",
                {"id": f"LANDFIRE LF2016 Remap/{layer}", "version": "LF2016 Remap",
                 "independence_group": "LANDFIRE_LF2016",
                 "url": f"{BASE}/{layer}/ImageServer", "native_resolution_m": 30,
                 "source_date": "2016", "pixel_size": 30, "native_unit": native_unit,
                 "unit_conversion_factor": factor}, original,
                {"start": None, "end": None, "convention": "static_layer_representing_2016"},
                {"kind": "newly_burned", "pixel_count": stats.get("count"),
                 "sample_count": value.get("sample_count") if isinstance(value, dict) else None,
                 "simplification_tolerance_m": 15, "query_crs": "EPSG:5070"},
                "LANDFIRE 30 m ImageServer spatial sample (up to 1,000 raster pixel centers)"
                if kind == "categorical" else
                "LANDFIRE ImageServer computeStatisticsHistograms over interval footprint",
                flags + (["sample_not_exhaustive_full_pixel_distribution"] if kind == "categorical"
                         else []) + ["prefire_snapshot_older_than_event"] if record["event_id"] in
                {"gofer:2019:Kincade", "gofer:2020:Creek", "gofer:2020:Bobcat"} else flags))
            by_id[record["interval_id"]] = record
    return {"queries": len(tasks), "completed": len(tasks) - len(errors), "errors": errors,
            "layer_source_date": 2016, "layer_is_prefire": True}
