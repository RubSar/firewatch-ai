from copy import deepcopy

import pytest
from shapely.geometry import shape
from shapely.ops import unary_union

from fuel_service.errors import ServiceError
from fuel_service.models import AnalysisRequest
from fuel_service.spatial import make_grid, surface_area


def test_cells_preserve_hole_and_account_for_region_area(payload):
    payload["region"]["coordinates"].append(
        [[-119.78, 37.72], [-119.78, 37.73], [-119.77, 37.73], [-119.77, 37.72], [-119.78, 37.72]]
    )
    request = AnalysisRequest(**payload)
    crs, cells = make_grid(request)
    assert crs == "EPSG:32611"
    assert len(cells) > 1
    hole = shape({"type": "Polygon", "coordinates": [payload["region"]["coordinates"][1]]})
    combined = unary_union([shape(c.geometry) for c in cells])
    # Inverse projection of split edges introduces very small interpolation differences.
    assert combined.intersection(hole).area < hole.area * 0.001
    expected = surface_area(shape(payload["region"]))
    assert sum(c.area_m2 for c in cells) == pytest.approx(expected, rel=1e-4)
    assert len({c.id for c in cells}) == len(cells)


def test_multipolygon_is_clipped_not_filled_between_components(payload):
    first = payload["region"]["coordinates"]
    second = deepcopy(first)
    for p in second[0]:
        p[0] += 0.1
    payload["region"] = {"type": "MultiPolygon", "coordinates": [first, second]}
    _, cells = make_grid(AnalysisRequest(**payload))
    assert sum(c.area_m2 for c in cells) == pytest.approx(
        surface_area(shape(payload["region"])), rel=1e-4
    )


@pytest.mark.parametrize(
    "ring",
    [
        [[0, 0], [0.1, 0.1], [0, 0.1], [0.1, 0], [0, 0]],
        [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]],
        [[179, 0], [-179, 0], [-179, 1], [179, 1], [179, 0]],
        [[0, 80], [0.1, 80], [0.1, 80.1], [0, 80.1], [0, 80]],
    ],
)
def test_invalid_and_unsupported_shapes_fail_before_provider(payload, ring):
    payload["region"]["coordinates"] = [ring]
    with pytest.raises(ServiceError):
        make_grid(AnalysisRequest(**payload))


def test_workload_limit_rejects_dense_grid(payload):
    payload["region"]["coordinates"] = [
        [[-120, 37], [-119.8, 37], [-119.8, 37.2], [-120, 37.2], [-120, 37]]
    ]
    payload["cell_size_m"] = 100
    with pytest.raises(ServiceError) as error:
        make_grid(AnalysisRequest(**payload))
    assert error.value.status == 413
