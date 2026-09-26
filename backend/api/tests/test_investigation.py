import pytest
from fastapi.testclient import TestClient
from shapely.geometry import Polygon, mapping, shape
from shapely.ops import unary_union
from test_api import SyntheticProvider

from fuel_service.app import create_app
from fuel_service.models import FireInvestigationResponse
from fuel_service.models import Polygon as PolygonModel
from fuel_service.spatial import GEOD, make_investigation


def test_circle_50km_has_wrapper_radius_78km():
    points = [GEOD.fwd(-120, 40, angle, 50000)[:2] for angle in range(360)]
    points.append(points[0])
    result = make_investigation(PolygonModel(type="Polygon", coordinates=[points]))
    outer = shape(result.wrapper.model_dump())
    distances = [GEOD.inv(-120, 40, x, y)[2] for x, y in outer.exterior.coords]
    # Circle polygon chord approximation + regional projection approximation.
    assert min(distances) == pytest.approx(78000, abs=15)
    assert max(distances) == pytest.approx(78000, abs=15)
    assert result.areas_m2["wrapper"] - result.areas_m2["fire"] == pytest.approx(
        result.areas_m2["investigation"], abs=0.1
    )


def test_concave_fire_and_holes_are_excluded_exactly():
    fire = Polygon(
        [(-120, 40), (-119.9, 40), (-119.9, 40.1), (-119.95, 40.05), (-120, 40.1), (-120, 40)],
        [
            [
                (-119.99, 40.01),
                (-119.98, 40.01),
                (-119.98, 40.02),
                (-119.99, 40.02),
                (-119.99, 40.01),
            ]
        ],
    )
    result = make_investigation(PolygonModel.model_validate(mapping(fire)))
    interest = shape(result.investigation_area.model_dump())
    outer = shape(result.wrapper.model_dump())
    assert interest.intersection(fire).area == 0
    assert interest.union(fire).symmetric_difference(outer).area < 1e-12
    assert interest.contains(Polygon(fire.interiors[0]))


def test_api_only_queries_and_scores_investigation_ring(payload):
    fire = shape(payload.pop("region"))
    payload.update(fire=mapping(fire), cell_size_m=5000)

    class InspectProvider(SyntheticProvider):
        def collect(self, request, crs, cells):
            region = shape(request.region.model_dump())
            assert region.intersection(fire).area == 0
            assert all(shape(c.geometry).intersection(fire).area < 1e-12 for c in cells)
            union = unary_union([shape(c.geometry) for c in cells])
            # UTM straight cell edges introduce tiny reprojection approximation.
            assert union.symmetric_difference(region).area / region.area < 0.0001
            return super().collect(request, crs, cells)

    response = TestClient(create_app(InspectProvider(), api_token="")).post(
        "/v1/fire-investigation", json=payload
    )
    assert response.status_code == 200, response.text
    result = FireInvestigationResponse.model_validate(response.json())
    assert result.investigation.buffer_m == 28000
    assert result.summary.mean_score == 50
    assert result.summary.total_area_m2 == pytest.approx(
        result.investigation.areas_m2["investigation"], rel=0.0001
    )


def test_fire_route_requires_auth_and_rejects_bad_fire_before_provider(payload):
    class NeverProvider:
        def collect(self, *args):
            raise AssertionError("invalid request must not reach Earth Engine")

    payload["fire"] = payload.pop("region")
    client = TestClient(create_app(NeverProvider(), api_token="test"))
    assert client.post("/v1/fire-investigation", json=payload).status_code == 401
    payload["fire"]["coordinates"] = [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]]
    assert (
        client.post(
            "/v1/fire-investigation", json=payload, headers={"Authorization": "Bearer test"}
        ).status_code
        == 400
    )


def test_nearby_fire_parts_share_wrapper_without_scoring_either_part():
    from fuel_service.models import MultiPolygon

    parts = [
        [[[-120, 40], [-119.99, 40], [-119.99, 40.01], [-120, 40.01], [-120, 40]]],
        [[[-119.9, 40], [-119.89, 40], [-119.89, 40.01], [-119.9, 40.01], [-119.9, 40]]],
    ]
    fire = MultiPolygon(type="MultiPolygon", coordinates=parts)
    result = make_investigation(fire)
    assert result.wrapper.type == "Polygon"
    assert (
        shape(result.investigation_area.model_dump()).intersection(shape(fire.model_dump())).area
        == 0
    )
