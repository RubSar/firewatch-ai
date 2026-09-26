import test from "node:test";
import assert from "node:assert/strict";
import { classifyPixel } from "./analysis.js";
test("color screening separates green, dark, tan and neutral surfaces", () => {
  assert.equal(classifyPixel(55, 100, 45), "green");
  assert.equal(classifyPixel(30, 40, 35), "dark");
  assert.equal(classifyPixel(155, 140, 90), "tan");
  assert.equal(classifyPixel(180, 180, 180), "other");
});
import { studyArea, circleFire, irregularFire } from "./geometry.js";
import {
  distance,
  booleanPointInPolygon,
  polygon,
  pointToLineDistance,
  lineString,
} from "@turf/turf";
test("50 km circular fire has a 78 km outer boundary and excludes the fire", () => {
  const center = [-120, 37],
    g = studyArea(circleFire(center));
  for (const p of g.outer.geometry.coordinates[0])
    assert.ok(Math.abs(distance(center, p) - 78) < 0.02);
  assert.ok(Math.abs(g.areas_km2.fire - Math.PI * 2500) < 1);
  assert.ok(Math.abs(g.areas_km2.interest - Math.PI * (78 ** 2 - 50 ** 2)) < 2);
  assert.ok(
    Math.abs(g.areas_km2.outer - g.areas_km2.fire - g.areas_km2.interest) <
      1e-6,
  );
  assert.equal(booleanPointInPolygon(center, g.interest), false);
});
test("irregular perimeter is preserved and buffer bbox corners are excluded", () => {
  const fire = irregularFire([-120, 37]),
    g = studyArea(fire);
  assert.deepEqual(g.fire, fire);
  assert.equal(
    booleanPointInPolygon([g.bounds[0], g.bounds[1]], g.interest),
    false,
  );
  assert.ok(g.interest.geometry.coordinates.length >= 2);
});
test("reject crossing, polar and overlarge polygons", () => {
  assert.throws(
    () =>
      studyArea(
        polygon([
          [
            [0, 0],
            [1, 1],
            [0, 1],
            [1, 0],
            [0, 0],
          ],
        ]),
      ),
    /cross/,
  );
  assert.throws(() => studyArea(circleFire([0, 80])), /poles/);
  assert.throws(() => studyArea(circleFire([0, 0], 200)), /300/);
});

test("irregular outer boundary stays 28 km from fire edges", () => {
  const fire = irregularFire([-120, 37]),
    g = studyArea(fire),
    line = lineString(fire.geometry.coordinates[0]);
  for (let i = 0; i < g.outer.geometry.coordinates[0].length; i += 13) {
    const d = pointToLineDistance(g.outer.geometry.coordinates[0][i], line, {
      units: "kilometers",
      method: "geodesic",
    });
    assert.ok(Math.abs(d - 28) < 0.05, `distance ${d}`);
  }
});
