import json
from pathlib import Path

from fuel_service.app import create_app
from fuel_service.models import AnalysisResponse

ROOT = Path(__file__).resolve().parents[3]


def test_openapi_snapshot_matches_runtime():
    saved = json.loads((ROOT / "contracts/fuel-index.openapi.json").read_text())
    assert create_app(api_token="").openapi() == saved


def test_example_is_valid_and_explicitly_synthetic():
    saved = json.loads((ROOT / "contracts/examples/fuel-index-response.synthetic.json").read_text())
    response = AnalysisResponse.model_validate(saved)
    assert response.provenance["synthetic"] is True
    assert response.schema_version == "fuel-index/1.0"
