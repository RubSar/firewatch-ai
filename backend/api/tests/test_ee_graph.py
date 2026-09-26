"""Validate graph against bundled official EE algorithm signatures, without auth/network.
This checks construction, not server execution or actual satellite values.
"""

import json
from pathlib import Path

import ee
from ee.apitestcase import ApiTestCase

from fuel_service.models import AnalysisRequest
from fuel_service.provider import build_graph
from fuel_service.spatial import make_grid


class TestGraph(ApiTestCase):
    def test_graph_serializes_with_supported_earth_engine_operations(self):
        payload = json.loads(
            (
                Path(__file__).resolve().parents[3] / "contracts/examples/fuel-index-request.json"
            ).read_text()
        )
        request = AnalysisRequest(**payload)
        crs, cells = make_grid(request)
        metadata, rows = build_graph(ee, request, crs, cells)
        meta = metadata.serialize()
        graph = rows.serialize()
        for collection in ("GOOGLE/DYNAMICWORLD/V1", "COPERNICUS/S2_SR_HARMONIZED"):
            assert collection in meta
        for operation in (
            "Image.reduceResolution",
            "Image.reduceRegions",
            "reduce.mean",
            "Image.reproject",
        ):
            assert operation in graph
        assert "vegetation_ndmi" in graph
        assert "acquisition_tile" in graph
