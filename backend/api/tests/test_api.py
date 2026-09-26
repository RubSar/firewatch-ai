from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from fuel_service.app import create_app
from fuel_service.models import AnalysisResponse
from fuel_service.provider import EarthEngineProvider, ProviderResult
from fuel_service.scoring import CLASSES, Evidence


class SyntheticProvider:
    def collect(self, request, crs, cells):
        assert crs.startswith("EPSG:")
        return ProviderResult(
            {c.id: Evidence({k: float(k == "trees") for k in CLASSES}, 0.1, 0.9, 2) for c in cells},
            {"provider": "test_fixture", "synthetic": True},
        )


def test_complete_geojson_response_and_synthetic_provenance(payload):
    client = TestClient(create_app(SyntheticProvider(), api_token=""))
    response = client.post("/v1/fuel-index", json=payload)
    assert response.status_code == 200, response.text
    data = response.json()
    AnalysisResponse.model_validate(data)
    assert data["provenance"]["synthetic"] is True
    assert data["summary"]["mean_score"] == 50
    assert data["summary"]["scored_cell_count"] == len(data["features"])
    assert data["features"][0]["properties"]["valid_coverage"] == 0.9
    assert data["analysis_resolution_m"] == 20


def test_unknown_cells_are_not_in_summary_average(payload):
    class PartialProvider:
        def collect(self, request, crs, cells):
            return ProviderResult(
                {c.id: Evidence(None, None, 0, None) for c in cells}, {"synthetic": True}
            )

    response = (
        TestClient(create_app(PartialProvider(), api_token=""))
        .post("/v1/fuel-index", json=payload)
        .json()
    )
    assert response["summary"]["mean_score"] is None
    assert response["summary"]["scored_cell_count"] == 0
    assert all(f["properties"]["status"] == "no_data" for f in response["features"])


def test_unconfigured_service_returns_actionable_503_not_mock_scores(payload):
    client = TestClient(create_app(EarthEngineProvider(project=""), api_token=""))
    assert client.get("/healthz").json()["earth_engine_configured"] is False
    response = client.post("/v1/fuel-index", json=payload)
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "earth_engine_not_configured"


def test_optional_server_token_is_enforced(payload):
    client = TestClient(create_app(SyntheticProvider(), api_token="local-test-token"))
    assert client.post("/v1/fuel-index", json=payload).status_code == 401
    assert (
        client.post(
            "/v1/fuel-index", json=payload, headers={"Authorization": "Bearer local-test-token"}
        ).status_code
        == 200
    )


def test_invalid_request_never_queries_provider(payload):
    class NeverProvider:
        def collect(self, *args):
            raise AssertionError("must not request satellite data")

    client = TestClient(create_app(NeverProvider(), api_token=""))
    payload["cell_size_m"] = 10
    assert client.post("/v1/fuel-index", json=payload).status_code == 422
    payload["cell_size_m"] = 1000
    payload["end_date"] = (datetime.now(UTC).date() + timedelta(days=100)).isoformat()
    assert client.post("/v1/fuel-index", json=payload).status_code == 422


def test_incomplete_provider_response_fails(payload):
    class BadProvider:
        def collect(self, *args):
            return ProviderResult({}, {})

    response = TestClient(create_app(BadProvider(), api_token="")).post(
        "/v1/fuel-index", json=payload
    )
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "invalid_provider_data"


def test_health_reports_successful_provider_initialization():
    provider = EarthEngineProvider(project="test-project")
    client = TestClient(create_app(provider, api_token=""))
    assert client.get("/healthz").json()["credentials_verified"] is False
    # Model the transition after ee.Initialize succeeds, without contacting Google.
    provider._ee = object()
    assert client.get("/healthz").json()["credentials_verified"] is True
