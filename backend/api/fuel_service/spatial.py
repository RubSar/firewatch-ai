from dataclasses import dataclass
from math import floor

from pyproj import Geod, Transformer
from shapely.geometry import MultiPolygon, Polygon, box, mapping, shape
from shapely.geometry.polygon import orient
from shapely.ops import transform
from shapely.validation import explain_validity

from .errors import ServiceError
from .models import AnalysisRequest, InvestigationGeometry

GEOD = Geod(ellps="WGS84")
MAX_CELLS = 2048


@dataclass(frozen=True)
class Cell:
    id: str
    geometry: dict
    area_m2: float


def surface_area(geom):
    if geom.geom_type == "MultiPolygon":
        return sum(surface_area(p) for p in geom.geoms)
    return abs(GEOD.geometry_area_perimeter(orient(geom, sign=1))[0])


def polygon_parts(geom):
    if isinstance(geom, Polygon):
        return [geom] if geom.area > 0 else []
    if hasattr(geom, "geoms"):
        return [p for g in geom.geoms for p in polygon_parts(g)]
    return []


def validate_region(raw):
    polygons = [raw["coordinates"]] if raw["type"] == "Polygon" else raw["coordinates"]
    points = [p for poly in polygons for ring in poly for p in ring]
    if len(points) > 5000:
        raise ServiceError(413, "too_many_vertices", "Use at most 5000 polygon vertices")
    if any(r[0] != r[-1] for poly in polygons for r in poly):
        raise ServiceError(400, "invalid_geometry", "Every ring must be explicitly closed")
    if any(not (-179 <= p[0] <= 179 and -75 <= p[1] <= 75) for p in points):
        raise ServiceError(
            400, "unsupported_location", "Use coordinates within ±179° lon and ±75° lat"
        )
    geom = shape(raw)
    if geom.is_empty or not geom.is_valid:
        raise ServiceError(400, "invalid_geometry", explain_validity(geom))
    west, south, east, north = geom.bounds
    if east - west > 180 or GEOD.inv(west, south, east, north)[2] > 300_000:
        raise ServiceError(
            413, "extent_too_large", "Region must have a diagonal <=300 km; no date-line crossing"
        )
    area = surface_area(geom)
    if area < 400:
        raise ServiceError(400, "region_too_small", "Region must be at least 400 m²")
    if area > 25_000_000_000:
        raise ServiceError(413, "area_too_large", "Region must be <=25000 km²")
    return geom


def make_grid(request: AnalysisRequest) -> tuple[str, list[Cell]]:
    geom = validate_region(request.region.model_dump(mode="json"))
    center = geom.centroid
    zone = min(60, max(1, floor((center.x + 180) / 6) + 1))
    crs = f"EPSG:{(32600 if center.y >= 0 else 32700) + zone}"
    forward = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
    backward = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform
    projected = transform(forward, geom)
    lo_x, lo_y, hi_x, hi_y = projected.bounds
    size = request.cell_size_m
    min_x, min_y = floor(lo_x / size), floor(lo_y / size)
    max_x, max_y = floor(hi_x / size), floor(hi_y / size)
    # Bound pre-clipping work too, including widely separated MultiPolygon parts.
    if (max_x - min_x + 1) * (max_y - min_y + 1) > 20_000:
        raise ServiceError(413, "grid_too_large", "Increase cell_size_m or reduce the region")
    cells = []
    for x in range(min_x, max_x + 1):
        for y in range(min_y, max_y + 1):
            clipped = projected.intersection(
                box(x * size, y * size, (x + 1) * size, (y + 1) * size)
            )
            parts = polygon_parts(clipped)
            if not parts:
                continue
            clipped = parts[0] if len(parts) == 1 else MultiPolygon(parts)
            # Reclip after reprojection to exclude the supplied fire precisely at boundaries.
            geographic_parts = polygon_parts(transform(backward, clipped).intersection(geom))
            if not geographic_parts:
                continue
            geographic = (
                geographic_parts[0]
                if len(geographic_parts) == 1
                else MultiPolygon(geographic_parts)
            )
            cell_area = surface_area(geographic)
            if cell_area <= 0:
                continue
            cells.append(Cell(f"{crs.split(':')[1]}-{x}-{y}", mapping(geographic), cell_area))
            if len(cells) > MAX_CELLS:
                raise ServiceError(
                    413, "too_many_cells", "At most 2048 cells; increase cell_size_m"
                )
    if not cells:
        raise ServiceError(400, "empty_grid", "Region produced no polygon cells")
    return crs, cells


def make_investigation(fire) -> InvestigationGeometry:
    """Regional metric offset, not coordinate scaling. Fire holes remain eligible."""
    raw = fire.model_dump(mode="json")
    geom = validate_region(raw)
    center = geom.centroid
    crs = f"+proj=aeqd +lat_0={center.y} +lon_0={center.x} +datum=WGS84 +units=m +no_defs"
    forward = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
    backward = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform
    # Densify GeoJSON's straight lon/lat edges before projection (~<=560 m).
    projected = transform(forward, geom.segmentize(0.005))
    buffered = projected.buffer(28000, quad_segs=64).segmentize(500)
    wrapper = transform(backward, buffered).union(geom)
    interest = wrapper.difference(geom)
    # Apply the same supported-region limits to the derived analysis area.
    # Reject excess complexity explicitly before constructing response models.
    validate_region(mapping(wrapper))
    validate_region(mapping(interest))
    return InvestigationGeometry(
        fire=raw,
        wrapper=mapping(wrapper),
        investigation_area=mapping(interest),
        buffer_crs=crs,
        buffer_method=(
            "WGS84 local azimuthal-equidistant planar buffer; 28000 m; "
            "64 segments per quadrant; approximate regional ground distance. "
            "Investigation area = wrapper minus supplied fire."
        ),
        areas_m2={
            "fire": surface_area(geom),
            "wrapper": surface_area(wrapper),
            "investigation": surface_area(interest),
        },
    )
