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
