/**
 * Kernel physics tests — ARCHITECTURE.md's Verification section, as code.
 *
 * That section claims these "run in CI and gate every kernel change". They did
 * not exist. A model whose numbers look plausible while its emergent behaviour
 * is wrong is the failure mode the document names, and it is invisible to
 * every check that does not measure behaviour directly.
 *
 * Two tests are marked `todo`. They encode the target, measure the real value,
 * and do not fail the suite — because the defect they catch is known,
 * quantified in §4, and fixing it is a kernel redesign rather than a patch.
 * Deleting them would be pretending; failing the build on them would block
 * every unrelated change.
 */
import { describe, it, todo } from 'node:test'
import assert from 'node:assert/strict'
import { Fuel, FUELS } from '../src/fuels.ts'
import { Cell, createSim, ignite, step } from '../src/model.ts'
import { fuelMoisture } from '../src/weather.ts'
import {
  DIRECTIONS, calm, equivalentRadius, flatTerrain, meanReachByDirection, nominalRos, reach, runFrom,
} from './harness.ts'

/**
 * Seeds to average over.
 *
 * A single run cannot distinguish lattice bias from its own frozen randomness:
 * measured worst-direction deviation is 23% at one seed, 7.7% at eight and
 * 5.2% at twenty-four, converging on no systematic preference. Eight is where
 * the noise is small enough to make a 10% bound meaningful without the suite
 * taking all day.
 */
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8]

const pct = (a: number, b: number) => (Math.abs(a - b) / Math.max(a, b)) * 100

describe('isotropy — flat ground, no wind', () => {
  it('spreads within 10% along axes and diagonals', () => {
    const r = meanReachByDirection(flatTerrain(), calm(), { steps: 400, seeds: SEEDS })
    // DIRECTIONS alternates axis, diagonal, axis, ...
    const axis = r.filter((_, i) => i % 2 === 0)
    const diag = r.filter((_, i) => i % 2 === 1)
    const meanAxis = axis.reduce((a, b) => a + b) / axis.length
    const meanDiag = diag.reduce((a, b) => a + b) / diag.length
    assert.ok(meanAxis > 0, 'fire did not spread at all')
    assert.ok(
      pct(meanAxis, meanDiag) < 10,
      `axis ${meanAxis.toFixed(0)}m vs diagonal ${meanDiag.toFixed(0)}m — ` +
        `${pct(meanAxis, meanDiag).toFixed(1)}% apart, lattice anisotropy`
    )
  })

  it('favours no compass direction once the seeded noise is averaged out', () => {
    const rs = meanReachByDirection(flatTerrain(), calm(), { steps: 400, seeds: SEEDS })
    const mean = rs.reduce((a, b) => a + b) / rs.length
    rs.forEach((r, i) => {
      const dev = (Math.abs(r - mean) / mean) * 100
      assert.ok(
        dev < 10,
        `${DIRECTIONS[i]} reached ${r.toFixed(0)}m against a mean of ${mean.toFixed(0)}m ` +
          `(${dev.toFixed(1)}% off) — structural, not noise, at ${SEEDS.length} seeds`
      )
    })
  })
})

/**
 * Still `todo`, and now known to be unreachable by tuning — see the long note
 * above `burnDuration` in model.ts for the three fixes that were measured and
 * reverted. Closing this needs the §4 energy accumulator.
 */
todo(
  'front advances at the kernel\'s own nominal ROS ' +
    '(not calibratable — see model.ts; needs the §4 energy accumulator)',
  () => {
    const t = flatTerrain()
    const params = calm()
    const steps = 400
    const dt = 10
    const sim = runFrom(t, params, { steps, dt })
    const measured = equivalentRadius(sim) / (steps * dt)
    const target = nominalRos(Fuel.Grass, params, fuelMoisture(params))
    assert.ok(
      pct(measured, target) < 10,
      `measured ${measured.toFixed(4)} m/s against nominal ${target.toFixed(4)} m/s ` +
        `— ratio ${(measured / target).toFixed(2)}x`
    )
  }
)

describe('wind', () => {
  it('elongates the fire downwind and holds the backing edge', () => {
    const t = flatTerrain()
    // Wind FROM the north, so the fire must run south (increasing row).
    const sim = runFrom(t, calm({ windSpeed: 40, windDir: 0 }), { steps: 300 })
    const head = reach(sim, 0, 1)
    const back = reach(sim, 0, -1)
    assert.ok(head > back * 3, `head ${head.toFixed(0)}m vs backing ${back.toFixed(0)}m — not elongated`)
  })

  it('sends the head in the direction the wind blows toward, not from', () => {
    const t = flatTerrain()
    // FROM the west: the head belongs in the east.
    const sim = runFrom(t, calm({ windSpeed: 40, windDir: 270 }), { steps: 300 })
    const east = reach(sim, 1, 0)
    const west = reach(sim, -1, 0)
    assert.ok(east > west * 3, `east ${east.toFixed(0)}m vs west ${west.toFixed(0)}m — wind direction inverted`)
  })

  it('a uniform wind FIELD reproduces the scalar path exactly', () => {
    // Regression: the provider emitted v southward while the kernel read it
    // northward, and a uniform field grew a 26% larger fire than the identical
    // scalar wind. Equality here is the invariant that keeps them agreeing.
    const t = flatTerrain()
    const params = calm({ windSpeed: 30, windDir: 135 })
    const n = t.cols * t.rows
    const toward = ((params.windDir + 180) % 360) * (Math.PI / 180)
    const s = params.windSpeed / 3.6
    const scalar = runFrom(t, params, { steps: 250 })
    const field = runFrom(t, params, {
      steps: 250,
      extra: {
        windField: {
          u: new Float32Array(n).fill(Math.sin(toward) * s),
          v: new Float32Array(n).fill(Math.cos(toward) * s),
        },
      },
    })
    assert.equal(field.burnedCells, scalar.burnedCells, 'field and scalar wind disagree')
  })
})

describe('slope', () => {
  it('runs faster uphill than downhill, and more so on steeper ground', () => {
    const gentle = runFrom(flatTerrain({ slope: Math.tan((10 * Math.PI) / 180) }), calm(), { steps: 400 })
    const steep = runFrom(flatTerrain({ slope: Math.tan((30 * Math.PI) / 180) }), calm(), { steps: 400 })
    // North (row 0) is uphill in the harness.
    const gentleRatio = reach(gentle, 0, -1) / Math.max(1, reach(gentle, 0, 1))
    const steepRatio = reach(steep, 0, -1) / Math.max(1, reach(steep, 0, 1))
    assert.ok(gentleRatio > 1, `10 deg did not favour uphill (ratio ${gentleRatio.toFixed(2)})`)
    assert.ok(
      steepRatio > gentleRatio,
      `30 deg ratio ${steepRatio.toFixed(2)} not above 10 deg ratio ${gentleRatio.toFixed(2)}`
    )
  })
})

describe('fuel and moisture', () => {
  it('never burns a cell with no fuel load', () => {
    // Regression: lakes appeared to burn. The kernel was always correct and
    // the classifier was not, but the invariant belongs in a test either way.
    const t = flatTerrain()
    const mid = ((t.rows - 1) / 2) | 0
    for (let c = 0; c < t.cols; c++) t.fuel[(mid + 8) * t.cols + c] = Fuel.Water
    const sim = runFrom(t, calm({ windSpeed: 50, windDir: 0 }), { steps: 600 })
    for (let i = 0; i < sim.state.length; i++) {
      if (FUELS[t.fuel[i]].load <= 0) {
        assert.equal(sim.state[i], Cell.Unburned, `an unburnable cell caught fire at index ${i}`)
      }
    }
  })

  it('stops entirely above a fuel\'s moisture of extinction', () => {
    const t = flatTerrain()
    const n = t.cols * t.rows
    const beyond = FUELS[Fuel.Grass].mx + 5
    const sim = runFrom(t, calm(), { steps: 300, extra: { moisture: new Float32Array(n).fill(beyond) } })
    assert.equal(sim.burnedCells, 1, 'fire spread past the moisture of extinction')
  })

  it('never consumes more fuel than a cell had', () => {
    const t = flatTerrain({ fuel: Fuel.Timber })
    const sim = runFrom(t, calm(), { steps: 800 })
    const initial = FUELS[Fuel.Timber].load
    for (let i = 0; i < sim.fuelLeft.length; i++) {
      assert.ok(sim.fuelLeft[i] <= initial + 1e-6, `cell ${i} gained fuel`)
      if (sim.state[i] === Cell.Burned) {
        assert.ok(sim.fuelLeft[i] <= initial, `burnt cell ${i} kept its full load`)
      }
    }
  })
})

describe('determinism', () => {
  it('reproduces a run exactly from the same seed', () => {
    const t = flatTerrain()
    const params = calm({ windSpeed: 25, windDir: 45 })
    const a = runFrom(t, params, { steps: 300 })
    const b = runFrom(t, params, { steps: 300 })
    assert.equal(a.burnedCells, b.burnedCells)
    assert.deepEqual(Array.from(a.state), Array.from(b.state), 'identical inputs diverged')
  })

  it('does not depend on how the time step is subdivided', () => {
    // The arrival formula p = 1 - exp(-ROS*dt/d) exists to make spread rate
    // independent of dt. Different RNG draw counts mean this is statistical,
    // not exact, so the bound is loose on purpose.
    const t = flatTerrain()
    const params = calm()
    const coarse = equivalentRadius(runFrom(t, params, { steps: 200, dt: 20 }))
    const fine = equivalentRadius(runFrom(t, params, { steps: 400, dt: 10 }))
    assert.ok(
      pct(coarse, fine) < 15,
      `dt=20 gave ${coarse.toFixed(0)}m but dt=10 gave ${fine.toFixed(0)}m — step-size dependent`
    )
  })
})

describe('bookkeeping', () => {
  it('counts every ignited cell exactly once', () => {
    const t = flatTerrain()
    const sim = runFrom(t, calm({ windSpeed: 20, windDir: 0 }), { steps: 400 })
    let counted = 0
    for (const s of sim.state) if (s !== Cell.Unburned) counted++
    assert.equal(sim.burnedCells, counted, 'the incremental burn count drifted from the grid')
  })

  it('leaves no cell burning with its fuel exhausted', () => {
    const t = flatTerrain()
    const sim = runFrom(t, calm(), { steps: 900 })
    for (let i = 0; i < sim.state.length; i++) {
      if (sim.state[i] === Cell.Burning) {
        assert.ok(sim.fuelLeft[i] > 0, `cell ${i} is alight with no fuel left`)
      }
    }
  })

  it('keeps the active list consistent with the grid', () => {
    const t = flatTerrain()
    const sim = runFrom(t, calm({ windSpeed: 15, windDir: 90 }), { steps: 350 })
    for (const i of sim.active) {
      assert.equal(sim.state[i], Cell.Burning, `active list holds a cell that is not burning`)
    }
    let burning = 0
    for (const s of sim.state) if (s === Cell.Burning) burning++
    assert.equal(sim.active.length, burning, 'active list and grid disagree on how many cells burn')
  })
})

describe('ignition', () => {
  it('refuses to ignite outside the grid', () => {
    const t = flatTerrain()
    const sim = createSim(t)
    assert.equal(ignite(sim, -5, -5, 0), 0)
    assert.equal(ignite(sim, t.cols + 5, t.rows + 5, 0), 0)
    assert.equal(sim.burnedCells, 0)
  })

  it('does nothing when stepped with no fire', () => {
    const t = flatTerrain()
    const sim = createSim(t)
    const params = calm({ windSpeed: 60 })
    for (let i = 0; i < 100; i++) step(sim, { params, weather: params, dt: 10 })
    assert.equal(sim.burnedCells, 0, 'a fire started on its own')
  })
})
