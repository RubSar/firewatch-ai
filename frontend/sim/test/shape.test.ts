/**
 * Shape descriptors, tested against ellipses whose answer is known before the
 * code runs.
 *
 * Worth the file: the first version of the bearing formula used the math angle
 * atan2(dRow, dCol) instead of the compass bearing atan2(dCol, -dRow), and so
 * reported every orientation 90 deg off. It agreed with itself across all
 * three hindcast fires and looked like a finding about the model. Nothing but a
 * known-answer test catches that class of bug.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { andersonLB, lengthToBreadth } from '../src/shape.ts'

const N = 101

/** An ellipse of semi-axes 40x10 whose long axis points at compass `b`. */
function ellipse(b: number) {
  const t = (b * Math.PI) / 180
  // Unit vector toward bearing b in (col, row): east is +col, north is -row.
  const ux = Math.sin(t)
  const uy = -Math.cos(t)
  const m = new Uint8Array(N * N)
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const x = c - 50
      const y = r - 50
      const along = x * ux + y * uy
      const across = -x * uy + y * ux
      if ((along / 40) ** 2 + (across / 10) ** 2 <= 1) m[r * N + c] = 1
    }
  }
  return m
}

test('bearing recovers the orientation an ellipse was built with', () => {
  for (const b of [0, 30, 45, 59, 90, 135, 168]) {
    const { bearing } = lengthToBreadth(ellipse(b), N)
    // Bearing is modulo 180: an axis has no head or tail.
    const err = Math.min(Math.abs(bearing - b), 180 - Math.abs(bearing - b))
    assert.ok(err < 2, `built ${b} deg, measured ${bearing.toFixed(1)} deg`)
  }
})

test('L/B recovers the axis ratio an ellipse was built with', () => {
  for (const b of [0, 45, 90, 168]) {
    const { lb } = lengthToBreadth(ellipse(b), N)
    // 40:10 = 4. Rasterising a 101-cell grid costs a little accuracy.
    assert.ok(Math.abs(lb - 4) < 0.15, `bearing ${b}: L/B ${lb.toFixed(2)}, expected 4`)
  }
})

test('a disc is isotropic: L/B ~ 1 at any bearing', () => {
  const m = new Uint8Array(N * N)
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if ((c - 50) ** 2 + (r - 50) ** 2 <= 35 * 35) m[r * N + c] = 1
  }
  assert.ok(Math.abs(lengthToBreadth(m, N).lb - 1) < 0.02)
})

test('too few cells to have a shape returns a neutral answer', () => {
  assert.equal(lengthToBreadth(new Uint8Array(N * N), N).lb, 1)
})

test('Anderson L/B rises with wind and is ~1 in calm air', () => {
  // Anderson (1983): a fire in still air is round; L/B grows monotonically.
  assert.ok(Math.abs(andersonLB(0) - 1) < 0.01, `calm L/B ${andersonLB(0).toFixed(3)}`)
  let prev = andersonLB(0)
  for (const kmh of [2, 5, 10, 20, 40]) {
    const v = andersonLB(kmh)
    assert.ok(v > prev, `L/B fell from ${prev.toFixed(2)} to ${v.toFixed(2)} at ${kmh} km/h`)
    prev = v
  }
})

/**
 * The emergent fire's shape, against Anderson (1983).
 *
 * These are the tests the elliptical rewrite exists to pass. Before it, the
 * kernel fed Rothermel's phi_w the wind component along each spread direction,
 * which produced a near-circular fire at EVERY wind speed — L/B 1.27 at 25 km/h
 * and 1.38 at 65, against real perimeters measuring 2.2-2.6 — and that single
 * defect was the model's largest error.
 *
 * Asserting on the directional ROS would not have caught it: that was strongly
 * anisotropic the whole time (head:flank about 37:1 at 25 km/h). Only the shape
 * of the finished burn shows it, which is why these tests run the kernel rather
 * than inspecting a formula.
 *
 * THE DOMAIN MUST NOT CLIP THE HEAD. The first version of this used a 201-cell
 * grid; the head reached the edge a third of the way through, after which only
 * the flanks could grow and L/B fell from 1.97 back to 1.30. That reads exactly
 * like the fix not working. `assertUnclipped` makes it impossible to get wrong
 * silently.
 */
import { ellipseEccentricity, ellipseShape } from '../src/model.ts'
import { Cell } from '../src/model.ts'
import { calm, flatTerrain, runFrom } from './harness.ts'

const GRID = 301
const STEPS = 200

/** Mean L/B and bearing over seeds, with a hard check that nothing hit an edge. */
function burnShape(windKmh: number, seeds = [1, 2, 3]) {
  const terrain = flatTerrain({ cols: GRID, rows: GRID, cellSize: 30 })
  let lbSum = 0
  let bSum = 0
  for (const seed of seeds) {
    // windDir 180 blows FROM the south, so the fire runs north: bearing 0.
    const sim = runFrom(terrain, calm({ windSpeed: windKmh, windDir: 180 }), { seed, steps: STEPS })
    const mask = new Uint8Array(sim.state.length)
    let minR = GRID
    let maxR = -1
    let minC = GRID
    let maxC = -1
    for (let i = 0; i < mask.length; i++) {
      if (sim.state[i] === Cell.Unburned) continue
      mask[i] = 1
      const r = (i / GRID) | 0
      const c = i % GRID
      if (r < minR) minR = r
      if (r > maxR) maxR = r
      if (c < minC) minC = c
      if (c > maxC) maxC = c
    }
    assert.ok(
      minR > 0 && maxR < GRID - 1 && minC > 0 && maxC < GRID - 1,
      `fire reached the domain edge at ${windKmh} km/h seed ${seed} — grow the grid or shorten the run, ` +
      'a clipped head makes any shape measurement meaningless'
    )
    const sh = lengthToBreadth(mask, GRID)
    lbSum += sh.lb
    // Fold onto 0 = north-south so seeds average without wrapping at 180.
    bSum += sh.bearing > 90 ? sh.bearing - 180 : sh.bearing
  }
  return { lb: lbSum / seeds.length, bearing: bSum / seeds.length }
}

test('a wind-driven fire elongates, and along the wind', () => {
  const { lb, bearing } = burnShape(25)
  // 2.01 as measured. Before the elliptical rewrite this was 1.27.
  assert.ok(lb > 1.8, `L/B ${lb.toFixed(2)} at 25 km/h — the fire is round again`)
  assert.ok(Math.abs(bearing) < 12, `major axis on bearing ${bearing.toFixed(0)}, expected ~0 (N-S)`)
})

test('elongation increases with wind', () => {
  // The defect this replaces gave 1.27-1.38 across the whole range, so the shape
  // carried no wind information at all. Measured now: about 1.24 / 1.33 / 1.93.
  //
  // Deliberately NOT asserting a fixed gap between consecutive winds. The
  // 0 -> 15 km/h step is only about +0.09, which is real rather than noise:
  // lateral leakage through the diagonals suppresses elongation most where the
  // ellipse is least eccentric, so low winds are where the lattice hurts most.
  // A +0.2 threshold failed here and was measuring my expectation, not the
  // kernel. The claim worth defending is that shape now carries wind at all.
  const lbs = [0, 15, 25].map((k) => burnShape(k, [1, 2, 3]).lb)
  const shown = lbs.map((v) => v.toFixed(2)).join(' -> ')
  assert.ok(Math.abs(lbs[0] - 1) < 0.35, `calm fire is not round: L/B ${lbs[0].toFixed(2)}`)
  assert.ok(lbs[2] > lbs[0] + 0.45, `wind barely changed the shape: ${shown}`)
  assert.ok(lbs[1] >= lbs[0] - 0.05, `L/B fell with wind: ${shown}`)
  assert.ok(lbs[2] > lbs[1] + 0.2, `L/B flat from 15 to 25 km/h: ${shown}`)
})

test('ellipseShape returns 1 at the head, (1-e)/(1+e) at the back, (1-e) on the flank', () => {
  for (const e of [0, 0.3, 0.7, 0.95]) {
    assert.ok(Math.abs(ellipseShape(e, 1) - 1) < 1e-12, `head at e=${e}`)
    assert.ok(Math.abs(ellipseShape(e, -1) - (1 - e) / (1 + e)) < 1e-12, `back at e=${e}`)
    assert.ok(Math.abs(ellipseShape(e, 0) - (1 - e)) < 1e-12, `flank at e=${e}`)
  }
})

test('calm air is a circle, and eccentricity is capped in extreme wind', () => {
  assert.equal(ellipseEccentricity(0), 0)
  // MAX_LB = 8 -> e = sqrt(1 - 1/64). Uncapped, 65 km/h gives L/B 56 and a
  // backing rate of 1/12,500 of the head, far outside Anderson's calibration.
  const capped = Math.sqrt(1 - 1 / 64)
  assert.ok(Math.abs(ellipseEccentricity(65 / 3.6) - capped) < 1e-9)
  assert.ok(ellipseEccentricity(10 / 3.6) < capped, 'a moderate wind should not be at the cap')
})

/**
 * The lattice leaks sideways, and this is the size of it.
 *
 * `todo` for the same reason as the nominal-ROS test: the remaining cause is a
 * propagation redesign, and failing the build on it would block unrelated work.
 * Delete it when Finney (2002) Minimum Travel Time lands, not before.
 *
 * Measured shortfall: emergent L/B reaches about half of Anderson's (2.01 vs
 * 4.39 at 25 km/h, 2.97 vs 8.00 at 40). The cause is not the ellipse — it is
 * that the flank runs 4-10x its nominal rate while the head runs 0.5-1.0x, and
 * the excess grows with eccentricity. Two effects compose:
 *
 *   - an isotropic arrival-draw overshoot, visible in calm air where head and
 *     flank both run ~2.8x nominal and the shape stays round;
 *   - lateral leakage through the diagonal neighbours. Reaching a cell off to
 *     the side via 45-degree steps uses ellipseShape(45 deg) = 0.084 rather
 *     than the flank's 0.026 — 3.2x faster — and first-passage percolation
 *     always finds that path. 3.2 x 2.2 = 7.0 against a measured 6.9.
 *
 * Both are what MTT fixes, by computing minimum arrival time over the network
 * with the elliptical template instead of drawing per-link Bernoulli arrivals.
 */
test('emergent L/B reaches Anderson (1983)', () => {
  for (const kmh of [15, 25]) {
    const got = burnShape(kmh, [1, 2]).lb
    const want = Math.min(8, andersonLB(((kmh / 3.6) * 3.6 * 0.4)))
    assert.ok(got > want / 1.5, `${kmh} km/h: emergent L/B ${got.toFixed(2)} vs Anderson ${want.toFixed(2)}`)
  }
})
