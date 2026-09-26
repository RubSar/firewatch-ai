import {
  buffer,
  difference,
  featureCollection,
  area,
  bbox,
  polygon,
  circle,
  kinks,
  booleanValid,
  distance,
} from "@turf/turf";
export const BUFFER_M = 28000;
export const rectangle = (b) =>
  polygon([
    [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[2], b[3]],
      [b[0], b[3]],
      [b[0], b[1]],
    ],
  ]);
export function circleFire(center, radius = 50) {
  return circle(center, radius, {
    steps: 512,
    units: "kilometers",
    properties: { demo: true, radius_km: radius },
  });
}
export function irregularFire(center) {
  const c = circle(center, 18, { steps: 12 }).geometry.coordinates[0];
  const scales = [1, 0.8, 1.2, 0.6, 0.9, 1.1, 0.65, 1, 0.75, 1.15, 0.7, 0.85];
  const ring = c
    .slice(0, -1)
    .map((p, i) => [
      center[0] + (p[0] - center[0]) * scales[i],
      center[1] + (p[1] - center[1]) * scales[i],
    ]);
  return polygon([[...ring, ring[0]]], { demo: true });
}
export function studyArea(fire) {
  if (fire?.geometry?.type !== "Polygon")
    throw new Error("Choose a single polygon fire perimeter.");
  const rings = fire.geometry.coordinates;
  if (
    !rings.length ||
    rings.some(
      (r) =>
        r.length < 4 ||
        r.some(
          (p) =>
            p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]),
        ),
    )
  )
    throw new Error("A fire needs at least three distinct vertices.");
  const b = bbox(fire);
  if (b[0] < -179 || b[2] > 179 || b[1] < -75 || b[3] > 75 || b[2] - b[0] > 180)
    throw new Error(
      "Use a regional polygon away from the poles and date line.",
    );
  if (!booleanValid(fire) || kinks(fire).features.length)
    throw new Error("Edges must not cross. Undo the last point and redraw.");
  if (distance([b[0], b[1]], [b[2], b[3]]) > 300)
    throw new Error(
      "Keep the fire perimeter within a 300 km diagonal for this regional calculation.",
    );
  if (area(fire) < 5000)
    throw new Error("Choose a fire larger than 0.005 km².");
  const outer = buffer(fire, 28, { units: "kilometers", steps: 64 });
  if (!outer) throw new Error("The fire perimeter could not be buffered.");
  const interest = difference(featureCollection([outer, fire]));
  if (!interest) throw new Error("The study area could not be calculated.");
  return {
    fire,
    outer,
    interest,
    bounds: bbox(outer),
    buffer_m: BUFFER_M,
    areas_km2: {
      fire: area(fire) / 1e6,
      outer: area(outer) / 1e6,
      interest: area(interest) / 1e6,
    },
    method:
      "Turf local azimuthal-equidistant spherical buffer; 64 segments per quadrant; polygon difference; spherical area. Regional approximation, not an ellipsoidal survey or spread forecast.",
  };
}
