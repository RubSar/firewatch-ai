"""Earth Engine adapter. No network calls at import; no mock/live fallback."""

import os
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from .errors import ServiceError
from .models import AnalysisRequest
from .scoring import CLASSES, METHOD, VEGETATION, Evidence
from .spatial import Cell

DW = "GOOGLE/DYNAMICWORLD/V1"
S2 = "COPERNICUS/S2_SR_HARMONIZED"
RESOLUTION = 20


@dataclass
class ProviderResult:
    cells: dict[str, Evidence]
    provenance: dict


class Provider(Protocol):
    def collect(self, request: AnalysisRequest, crs: str, cells: list[Cell]) -> ProviderResult: ...


def join_key(ee, image):
    image = ee.Image(image)
    tile = ee.String(image.get("system:index")).split("_").get(-1)
    key = ee.Number(image.get("system:time_start")).format("%.0f").cat("_").cat(ee.String(tile))
    return image.set("acquisition_tile", key)


def prepare_pair(ee, pair, crs):
    """Keep both sources on the same support before temporal aggregation."""
    pair = ee.Feature(pair)
    dw = ee.Image(pair.get("primary"))
    s2 = ee.Image(pair.get("secondary"))
    projection = s2.select("B11").projection()
    scl = s2.select("SCL")
    clear = scl.eq(4).Or(scl.eq(5)).Or(scl.eq(6))
    nir = (
        s2.select("B8")
        .updateMask(clear)
        .reduceResolution(reducer=ee.Reducer.mean(), maxPixels=64)
        .reproject(projection)
    )
    swir = s2.select("B11").updateMask(clear)
    denominator = nir.add(swir)
    ndmi = nir.subtract(swir).divide(denominator).updateMask(denominator.gt(0)).rename("ndmi")
    probabilities = dw.select(list(CLASSES))
    confident = probabilities.reduce(ee.Reducer.max()).gte(METHOD["minimum_dw_top1_probability"])
    probabilities = (
        probabilities.updateMask(confident)
        .reduceResolution(reducer=ee.Reducer.mean(), maxPixels=64)
        .reproject(projection)
    )
    common = probabilities.mask().reduce(ee.Reducer.min()).And(ndmi.mask()).And(clear)
    probabilities = probabilities.updateMask(common)
    vegetation = (
        probabilities.select(list(VEGETATION)).reduce(ee.Reducer.sum()).rename("vegetation")
    )
    weighted_ndmi = vegetation.multiply(ndmi).rename("vegetation_ndmi")
    return (
        probabilities.addBands(vegetation)
        .addBands(weighted_ndmi)
        .addBands(ndmi.updateMask(common))
        .reproject(crs=crs, scale=RESOLUTION)
        .copyProperties(s2, ["system:time_start"])
    )


def build_graph(ee, request, crs, cells):
    region = ee.Geometry(request.region.model_dump(mode="json"), geodesic=False)
    dw = (
        ee.ImageCollection(DW)
        .filterBounds(region)
        .filterDate(str(request.start_date), str(request.end_date))
        .map(lambda im: join_key(ee, im))
    )
    s2 = (
        ee.ImageCollection(S2)
        .filterBounds(region)
        .filterDate(str(request.start_date), str(request.end_date))
        .filter(ee.Filter.lte("CLOUDY_PIXEL_PERCENTAGE", 35))
        .map(lambda im: join_key(ee, im))
    )
    pairs = ee.Join.inner().apply(
        dw, s2, ee.Filter.equals(leftField="acquisition_tile", rightField="acquisition_tile")
    )
    count = pairs.size()
    # IDs and timestamps are metadata for all candidate pairs, not per-cell contributors.
    metadata = ee.Dictionary(
        {
            "pair_count": count,
            "pairs": pairs.toList(257).map(
                lambda f: ee.Dictionary(
                    {
                        "dynamic_world_id": ee.Image(ee.Feature(f).get("primary")).id(),
                        "sentinel2_id": ee.Image(ee.Feature(f).get("secondary")).id(),
                        "acquired_at": ee.Date(
                            ee.Image(ee.Feature(f).get("primary")).get("system:time_start")
                        ).format("YYYY-MM-dd'T'HH:mm:ss'Z'", "UTC"),
                    }
                )
            ),
        }
    )
    images = ee.ImageCollection(pairs.map(lambda f: prepare_pair(ee, f, crs)))
    means = images.mean()
    area = ee.Image.pixelArea().reproject(crs=crs, scale=RESOLUTION)
    bands = list(CLASSES) + ["vegetation", "vegetation_ndmi"]
    weighted = means.select(bands).multiply(area)
    valid_area = area.updateMask(means.select("trees").mask()).rename("valid_area")
    observations = images.select("ndmi").count().multiply(valid_area).rename("observations_area")
    # All-pixel denominator uses the same raster grid and clipping as the valid-area numerator.
    metrics = (
        area.rename("total_area").addBands(weighted).addBands(valid_area).addBands(observations)
    )
    features = ee.FeatureCollection(
        [ee.Feature(ee.Geometry(c.geometry, geodesic=False), {"cell_id": c.id}) for c in cells]
    )
    reductions = metrics.reduceRegions(
        collection=features,
        reducer=ee.Reducer.sum(),
        crs=crs,
        scale=RESOLUTION,
        tileScale=4,
        maxPixelsPerRegion=2_000_000,
    )
    # Return only properties; geometry already exists locally.
    rows = reductions.toList(len(cells)).map(lambda f: ee.Feature(f).toDictionary())
    return metadata, rows


def parse_evidence(row: dict) -> Evidence:
    valid = row.get("valid_area") or 0
    total = row.get("total_area") or 0
    if valid <= 0 or total <= 0:
        return Evidence(None, None, 0, None)
    coverage = min(1.0, max(0.0, valid / total))
    probs = {k: row[k] / valid for k in CLASSES}
    vegetation_area = row.get("vegetation") or 0
    weighted = row.get("vegetation_ndmi")
    ndmi = weighted / vegetation_area if vegetation_area > 0 and weighted is not None else None
    if ndmi is not None:
        # Clamp only floating point rounding at the ratio limits.
        if ndmi < -1 - 1e-6 or ndmi > 1 + 1e-6:
            raise ValueError("NDMI outside its physical range")
        ndmi = max(-1.0, min(1.0, ndmi))
    return Evidence(probs, ndmi, coverage, (row.get("observations_area") or 0) / valid)


class EarthEngineProvider:
    def __init__(self, project: str | None = None, timeout_seconds: int = 120):
        self.project = project if project is not None else os.getenv("FIREWATCH_EE_PROJECT", "")
        self.timeout_seconds = timeout_seconds
        self._ee = None
        self._init_lock = threading.Lock()

    @property
    def credentials_verified(self):
        """True only after Earth Engine initialization succeeds in this process."""
        return self._ee is not None

    def initialize(self):
        if not self.project:
            raise ServiceError(
                503,
                "earth_engine_not_configured",
                "Set FIREWATCH_EE_PROJECT and authenticate Earth Engine on the server",
            )
        with self._init_lock:
            if self._ee is None:
                try:
                    import ee

                    ee.Initialize(project=self.project)
                    ee.data.setDeadline(self.timeout_seconds * 1000)
                    ee.data.setMaxRetries(0)
                    self._ee = ee
                except Exception as exc:
                    raise ServiceError(
                        503,
                        "earth_engine_auth_failed",
                        "Earth Engine initialization failed; check server credentials, project registration and API access",
                    ) from exc
        return self._ee

    def collect(self, request, crs, cells):
        ee = self.initialize()
        try:
            metadata, rows = build_graph(ee, request, crs, cells)
            info = metadata.getInfo()
            if info["pair_count"] > 256:
                raise ServiceError(
                    413,
                    "too_many_acquisitions",
                    "More than 256 acquisition pairs; shorten the date window or reduce the region",
                )
            provenance = {
                "provider": "google_earth_engine",
                "synthetic": False,
                "dynamic_world_collection": DW,
                "sentinel2_collection": S2,
                "dynamic_world_native_resolution_m": 10,
                "ndmi_effective_resolution_m": 20,
                "acquisition_pairs": info["pairs"],
                "pair_count": info["pair_count"],
                "retrieved_at": datetime.now(UTC).isoformat(),
                "attribution": "This dataset is produced for the Dynamic World Project by Google in partnership with National Geographic Society and the World Resources Institute. Contains modified Copernicus Sentinel data.",
                "sources": [
                    "https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1",
                    "https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED",
                ],
                "asset_scope": "Candidate matched acquisitions across the request region; not all assets contribute to every cell",
            }
            if info["pair_count"] == 0:
                return ProviderResult(
                    {c.id: Evidence(None, None, 0, None) for c in cells}, provenance
                )
            evidence = {r["cell_id"]: parse_evidence(r) for r in rows.getInfo()}
            if set(evidence) != {c.id for c in cells}:
                raise ValueError("Earth Engine returned an incomplete cell collection")
            return ProviderResult(evidence, provenance)
        except ServiceError:
            raise
        except Exception as exc:
            # Credential paths, tokens and upstream query internals never reach clients.
            raise ServiceError(
                502,
                "earth_engine_query_failed",
                "Satellite query failed or timed out; try a smaller region/date window and check server access",
            ) from exc
