"""Versioned, uncalibrated heuristic. No model probability is a fire probability."""

from dataclasses import dataclass
from math import isfinite

from .models import CellProperties
from .spatial import Cell

CLASSES = (
    "water",
    "trees",
    "grass",
    "flooded_vegetation",
    "crops",
    "shrub_and_scrub",
    "built",
    "bare",
    "snow_and_ice",
)
VEGETATION = ("trees", "grass", "flooded_vegetation", "crops", "shrub_and_scrub")
LIMITATIONS = [
    "Experimental relative fuel score, not official Burning Index, FWI, burn probability or spread forecast.",
    "NDMI is a spectral vegetation moisture proxy, not measured live/dead fuel moisture.",
    "NDMI anchors and classification/coverage thresholds are unvalidated demo assumptions.",
    "Dynamic World probability means are not measured land-cover area fractions.",
    "Canopy can hide surface fuel; deadwood, wind, weather, slope and fuel load are not modeled.",
    "Temporal averages can hide change. Source acquisitions may be old or partly cloudy.",
    "Cells aggregate 20 m observations; finer output does not create finer source detail.",
]
METHOD = {
    "id": "dw-ndmi-experimental-v1",
    "calibrated": False,
    "vegetation_classes": list(VEGETATION),
    "ndmi_formula": "(B8 - B11) / (B8 + B11)",
    "dryness_formula": "clamp((0.4 - vegetation_weighted_ndmi) / 0.6, 0, 1)",
    "score_formula": "round(100 * vegetation_probability * dryness_proxy, 1)",
    "ndmi_dry_anchor": -0.2,
    "ndmi_wet_anchor": 0.4,
    "minimum_valid_coverage": 0.7,
    "minimum_dw_top1_probability": 0.6,
    "unsupported_built_threshold": 0.2,
    "minimum_vegetation_probability": 0.05,
    "non_vegetated_probability_threshold": 0.9,
    "temporal_reducer": "mean over same-acquisition common-valid observations",
    "spatial_reducer": "pixel-area-weighted mean on common-valid support",
}


@dataclass(frozen=True)
class Evidence:
    probabilities: dict[str, float] | None
    ndmi: float | None
    coverage: float
    observations: float | None


def score_cell(cell: Cell, evidence: Evidence) -> CellProperties:
    coverage = evidence.coverage
    if not isfinite(coverage) or not 0 <= coverage <= 1:
        raise ValueError("Invalid coverage from provider")
    probs = evidence.probabilities
    if probs is not None:
        if set(probs) != set(CLASSES) or any(
            not isfinite(v) or not 0 <= v <= 1 for v in probs.values()
        ):
            raise ValueError("Invalid class probabilities from provider")
        total = sum(probs.values())
        if abs(total - 1) > 0.02:
            raise ValueError("Class probabilities must sum to one")
        probs = {k: v / total for k, v in probs.items()}
    ndmi = evidence.ndmi
    if ndmi is not None and (not isfinite(ndmi) or not -1 <= ndmi <= 1):
        raise ValueError("Invalid NDMI from provider")
    vegetation = sum(probs[k] for k in VEGETATION) if probs else None
    result = CellProperties(
        cell_id=cell.id,
        area_m2=round(cell.area_m2, 3),
        status="no_data",
        valid_coverage=coverage,
        landcover_probabilities=probs,
        vegetation_probability=vegetation,
        ndmi=ndmi,
        observation_count_mean=evidence.observations,
    )
    if not probs or coverage == 0:
        return result
    if coverage < METHOD["minimum_valid_coverage"]:
        return result.model_copy(update={"status": "insufficient_coverage"})
    if probs["built"] >= METHOD["unsupported_built_threshold"]:
        return result.model_copy(update={"status": "unsupported_built_area"})
    if vegetation <= 0.05 and sum(probs[k] for k in ("bare", "water", "snow_and_ice")) >= 0.9:
        return result.model_copy(update={"status": "non_vegetated", "score": 0.0})
    if ndmi is None or vegetation <= 0.05:
        return result.model_copy(update={"status": "missing_moisture"})
    dryness = max(0.0, min(1.0, (0.4 - ndmi) / 0.6))
    return result.model_copy(
        update={
            "status": "scored",
            "score": round(100 * vegetation * dryness, 1),
            "dryness_proxy": dryness,
        }
    )
