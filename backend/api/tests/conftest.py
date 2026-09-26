import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def payload():
    return json.loads((ROOT / "contracts/examples/fuel-index-request.json").read_text())
