from datetime import UTC, date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


Position = tuple[float, float]
Ring = Annotated[list[Position], Field(min_length=4, max_length=5000)]
PolygonCoordinates = Annotated[list[Ring], Field(min_length=1, max_length=100)]


class Polygon(StrictModel):
    type: Literal["Polygon"]
    coordinates: PolygonCoordinates


class MultiPolygon(StrictModel):
    type: Literal["MultiPolygon"]
    coordinates: Annotated[list[PolygonCoordinates], Field(min_length=1, max_length=100)]


Geometry = Annotated[Polygon | MultiPolygon, Field(discriminator="type")]


class AnalysisWindow(StrictModel):
    start_date: date
    end_date: date
    cell_size_m: int = Field(default=5000, ge=100, le=5000, strict=True)

    @model_validator(mode="after")
    def validate_window(self):
        if self.start_date < date(2017, 3, 28):
            raise ValueError("Sentinel-2 SR requests must start on or after 2017-03-28")
        if not 1 <= (self.end_date - self.start_date).days <= 31:
            raise ValueError("Date window must be between 1 and 31 days (end exclusive)")
        # No current/future day: ingestion can still lag behind the requested window.

        if self.end_date > datetime.now(UTC).date():
            raise ValueError("end_date must not be later than today's UTC date")
        return self


class AnalysisRequest(AnalysisWindow):
    region: Geometry


class FireInvestigationRequest(AnalysisWindow):
    fire: Geometry


class InvestigationGeometry(StrictModel):
    fire: Geometry
    wrapper: Geometry
    investigation_area: Geometry
    buffer_m: Literal[28000] = 28000
    buffer_method: str
    buffer_crs: str
    areas_m2: dict[str, float]


class CellProperties(StrictModel):
    cell_id: str
    area_m2: float = Field(gt=0)
    status: Literal[
        "scored",
        "non_vegetated",
        "no_data",
        "insufficient_coverage",
        "unsupported_built_area",
        "missing_moisture",
    ]
    score: float | None = Field(default=None, ge=0, le=100)
    landcover_probabilities: dict[str, float] | None = None
    vegetation_probability: float | None = None
    ndmi: float | None = Field(default=None, ge=-1, le=1)
    dryness_proxy: float | None = Field(default=None, ge=0, le=1)
    valid_coverage: float = Field(ge=0, le=1)
    observation_count_mean: float | None = Field(default=None, ge=0)


class CellFeature(StrictModel):
    type: Literal["Feature"] = "Feature"
    geometry: Geometry
    properties: CellProperties


class Summary(StrictModel):
    cell_count: int
    scored_cell_count: int
    total_area_m2: float
    scored_cell_area_m2: float
    unscored_cell_area_m2: float
    observed_scored_area_m2: float
    mean_score: float | None


class AnalysisResponse(StrictModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    schema_version: Literal["fuel-index/1.0"] = "fuel-index/1.0"
    generated_at: datetime
    start_date: date
    end_date: date
    cell_size_m: int
    analysis_resolution_m: int = 20
    grid_crs: str
    method: dict[str, JsonValue]
    provenance: dict[str, JsonValue]
    limitations: list[str]
    summary: Summary
    features: list[CellFeature]


class FireInvestigationResponse(AnalysisResponse):
    investigation: InvestigationGeometry
