"""Transparent candidate generators, not trained fire detectors."""
from dataclasses import asdict, dataclass

import numpy as np


@dataclass(frozen=True)
class Config:
    rgb_red_min: int = 150
    rgb_red_green_gap: int = 15
    rgb_saturation_min: float = 0.2
    thermal_threshold_c: float = 80.0
    min_component_pixels: int = 8
    min_presence_pixels: int = 16

    def __post_init__(self):
        if not 0 <= self.rgb_red_min <= 255 or not 0 <= self.rgb_red_green_gap <= 255:
            raise ValueError("RGB thresholds must be in [0, 255]")
        if not 0 <= self.rgb_saturation_min <= 1:
            raise ValueError("Saturation threshold must be in [0, 1]")
        if not np.isfinite(self.thermal_threshold_c):
            raise ValueError("Thermal threshold must be finite")
        if self.min_component_pixels < 1 or self.min_presence_pixels < 1:
            raise ValueError("Pixel counts must be positive")

    def to_dict(self):
        return asdict(self)


def remove_small_components(mask, minimum):
    """Keep 4-connected components with at least minimum pixels; no dilation."""
    mask = np.asarray(mask, dtype=bool)
    if mask.ndim != 2 or minimum < 1:
        raise ValueError("Expected a 2D mask and positive minimum")
    if minimum == 1:
        return mask.copy()
    height, width = mask.shape
    remaining = mask.copy()
    result = np.zeros_like(mask)
    for y, x in zip(*np.nonzero(mask)):
        if not remaining[y, x]:
            continue
        remaining[y, x] = False
        stack, component = [(int(y), int(x))], []
        while stack:
            row, col = stack.pop()
            component.append((row, col))
            for nr, nc in ((row-1, col), (row+1, col), (row, col-1), (row, col+1)):
                if 0 <= nr < height and 0 <= nc < width and remaining[nr, nc]:
                    remaining[nr, nc] = False
                    stack.append((nr, nc))
        if len(component) >= minimum:
            rr, cc = zip(*component)
            result[rr, cc] = True
    return result


def rgb_candidates(rgb, config):
    if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8:
        raise ValueError("RGB must be an HxWx3 uint8 array")
    r, g, b = rgb.astype(np.float32).transpose(2, 0, 1)
    high = np.maximum.reduce([r, g, b])
    low = np.minimum.reduce([r, g, b])
    saturation = (high - low) / np.maximum(high, 1)
    mask = ((r >= config.rgb_red_min) & (r - g >= config.rgb_red_green_gap)
            & (g > b) & (saturation >= config.rgb_saturation_min))
    return remove_small_components(mask, config.min_component_pixels)


def thermal_candidates(temperature, unit, config):
    if unit != "celsius" or temperature.ndim != 2:
        raise ValueError("Thermal input must be numeric 2D Celsius, never a colour palette")
    valid = np.isfinite(temperature)
    mask = valid & (temperature >= config.thermal_threshold_c)
    return remove_small_components(mask, config.min_component_pixels), valid


def presence(mask, minimum):
    return bool(np.count_nonzero(mask) >= minimum)


def combine_presence(rgb, thermal):
    """Three-valued OR: missing evidence cannot silently become negative."""
    if rgb is True or thermal is True:
        return True
    if rgb is False and thermal is False:
        return False
    return None


def confusion(truth, predicted):
    if len(truth) != len(predicted):
        raise ValueError("Truth/prediction length mismatch")
    result = dict(tp=0, fp=0, tn=0, fn=0, unavailable=0, unlabeled=0)
    for actual, guess in zip(truth, predicted):
        if actual is None:
            result["unlabeled"] += 1
        elif guess is None:
            result["unavailable"] += 1
        else:
            result["tp" if actual and guess else "fn" if actual else "fp" if guess else "tn"] += 1
    tp, fp, tn, fn = (result[k] for k in ("tp", "fp", "tn", "fn"))
    ratio = lambda a, b: a / b if b else None
    result.update(precision=ratio(tp, tp+fp), recall=ratio(tp, tp+fn),
                  negative_image_false_positive_rate=ratio(fp, fp+tn),
                  f1=ratio(2*tp, 2*tp+fp+fn),
                  evaluated=tp+fp+tn+fn)
    return result


def mask_counts(predicted, target):
    """Target is 0=background, 1=visible flame, 255=unannotated/ignore."""
    if predicted.shape != target.shape or target.ndim != 2:
        raise ValueError("Prediction/ground-truth mask shape mismatch")
    if not np.isin(target, [0, 1, 255]).all():
        raise ValueError("Mask must contain only 0, 1 and 255")
    valid = target != 255
    actual = target == 1
    return {
        "tp": int(np.count_nonzero(valid & actual & predicted)),
        "fp": int(np.count_nonzero(valid & ~actual & predicted)),
        "fn": int(np.count_nonzero(valid & actual & ~predicted)),
        "valid_pixels": int(np.count_nonzero(valid)),
    }


def mask_scores(counts):
    tp, fp, fn = (counts[k] for k in ("tp", "fp", "fn"))
    return {**counts, "iou": tp/(tp+fp+fn) if tp+fp+fn else None,
            "dice": 2*tp/(2*tp+fp+fn) if 2*tp+fp+fn else None}
