import hmac
import os
import threading
from datetime import UTC, datetime

from fastapi import Depends, FastAPI, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .errors import ServiceError
from .models import (
    AnalysisRequest,
    AnalysisResponse,
    CellFeature,
    FireInvestigationRequest,
    FireInvestigationResponse,
    Summary,
)
from .provider import EarthEngineProvider, Provider
from .scoring import LIMITATIONS, METHOD, score_cell
from .spatial import make_grid, make_investigation


def create_app(provider: Provider | None = None, api_token: str | None = None):
    app = FastAPI(
        title="FireWatch Fuel Index Service",
        version="0.1.0",
        description="Dynamic World + Sentinel-2 NDMI. Experimental relative fuel score; not a fire forecast.",
    )
    source = provider or EarthEngineProvider(
        timeout_seconds=int(os.getenv("FIREWATCH_EE_TIMEOUT_SECONDS", "120"))
    )
    token = os.getenv("FIREWATCH_API_TOKEN", "") if api_token is None else api_token
    gate = threading.BoundedSemaphore(1)
    origins = [v.strip() for v in os.getenv("FIREWATCH_CORS_ORIGINS", "").split(",") if v.strip()]
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization", "Content-Type"],
        )

    @app.exception_handler(ServiceError)
    async def service_error(_request, error):
        return JSONResponse(
            status_code=error.status,
            content={"detail": {"code": error.code, "message": error.message}},
        )

    def authorize(authorization: str | None = Header(default=None)):
        if token and not hmac.compare_digest(authorization or "", f"Bearer {token}"):
            raise ServiceError(401, "unauthorized", "A valid service bearer token is required")

    @app.get("/healthz")
    def health():
        return {
            "status": "ok",
            "earth_engine_configured": bool(getattr(source, "project", None)),
            "credentials_verified": bool(getattr(source, "credentials_verified", False)),
            "method_id": METHOD["id"],
        }

    @app.get("/v1/method")
    def method():
        return {**METHOD, "limitations": LIMITATIONS}

    @app.post("/v1/fuel-index", response_model=AnalysisResponse, dependencies=[Depends(authorize)])
    def fuel_index(request: AnalysisRequest):
        if not gate.acquire(blocking=False):
            raise ServiceError(
                429, "service_busy", "One satellite analysis is already running; retry later"
            )
        try:
            crs, cells = make_grid(request)
            collected = source.collect(request, crs, cells)
            try:
                if set(collected.cells) != {c.id for c in cells}:
                    raise ValueError("Incomplete provider output")
                features = [
                    CellFeature(
                        geometry=c.geometry, properties=score_cell(c, collected.cells[c.id])
                    )
                    for c in cells
                ]
            except (ValueError, KeyError) as exc:
                raise ServiceError(
                    502,
                    "invalid_provider_data",
                    "Satellite provider returned invalid or incomplete evidence",
                ) from exc
            total = sum(c.area_m2 for c in cells)
            scored = [f.properties for f in features if f.properties.score is not None]
            scored_area = sum(p.area_m2 for p in scored)
            observed_area = sum(p.area_m2 * p.valid_coverage for p in scored)
            mean = (
                sum(p.score * p.area_m2 * p.valid_coverage for p in scored) / observed_area
                if observed_area
                else None
            )
            return AnalysisResponse(
                generated_at=datetime.now(UTC),
                start_date=request.start_date,
                end_date=request.end_date,
                cell_size_m=request.cell_size_m,
                grid_crs=crs,
                method=METHOD,
                provenance=collected.provenance,
                limitations=LIMITATIONS,
                summary=Summary(
                    cell_count=len(cells),
                    scored_cell_count=len(scored),
                    total_area_m2=total,
                    scored_cell_area_m2=scored_area,
                    unscored_cell_area_m2=max(0, total - scored_area),
                    observed_scored_area_m2=observed_area,
                    mean_score=round(mean, 1) if mean is not None else None,
                ),
                features=features,
            )
        finally:
            gate.release()

    @app.post(
        "/v1/fire-investigation",
        response_model=FireInvestigationResponse,
        dependencies=[Depends(authorize)],
    )
    def fire_investigation(request: FireInvestigationRequest):
        investigation = make_investigation(request.fire)
        region_request = AnalysisRequest(
            region=investigation.investigation_area,
            start_date=request.start_date,
            end_date=request.end_date,
            cell_size_m=request.cell_size_m,
        )
        analysis = fuel_index(region_request)
        return FireInvestigationResponse(**analysis.model_dump(), investigation=investigation)

    return app


app = create_app()
