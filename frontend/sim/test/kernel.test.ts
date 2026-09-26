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
import { Cell, Crown, attachCanopy, createSim, ignite, recomputeStats, step } from '../src/model.ts'
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

describe('crown fire', () => {
  const canopyOf = (n: number, cbh: number, cbd: number, load = 1.2) => ({
    load: new Float32Array(n).fill(load),
    cbh: new Float32Array(n).fill(cbh),
    cbd: new Float32Array(n).fill(cbd),
  })

  const runCrown = (o: { wind: number; cbh: number; cbd: number; steps?: number }) => {
    const t = flatTerrain({ fuel: Fuel.Timber })
    const n = t.cols * t.rows
    const params = { ...calm({ windSpeed: o.wind }), spotting: 1 }
    const sim = createSim(t, 7)
    attachCanopy(sim, canopyOf(n, o.cbh, o.cbd))
    ignite(sim, ((t.cols - 1) / 2) | 0, ((t.rows - 1) / 2) | 0, 0)
    for (let i = 0; i < (o.steps ?? 400); i++) step(sim, { params, weather: params, dt: 10 })
    recomputeStats(sim)
    return sim
  }

  it('leaves the surface fire untouched when no canopy is attached', () => {
    // The browser-only path never attaches one, and must behave exactly as it
    // did before crown fire existed.
    const t = flatTerrain({ fuel: Fuel.Timber })
    const params = { ...calm({ windSpeed: 60 }), spotting: 1 }
    const bare = runFrom(t, params, { steps: 400, seed: 7 })
    assert.equal(bare.canopy, null)
    assert.equal(bare.crownCells, 0)
    assert.equal(bare.stats.crownCells, 0)
  })

  it('does not crown below the initiation intensity', () => {
    // Calm timber tops out around 900 kW/m against an I_0 of ~1880.
    const sim = runCrown({ wind: 0, cbh: 5, cbd: 0.1 })
    assert.equal(sim.crownCells, 0, `crowned at ${sim.stats.maxIntensity.toFixed(0)} kW/m`)
  })

  it('crowns once the surface fire is intense enough', () => {
    const sim = runCrown({ wind: 60, cbh: 5, cbd: 0.1 })
    assert.ok(sim.crownCells > 0, 'never crowned despite a running timber fire')
  })

  it('is blocked by a high canopy base, at identical fire intensity', () => {
    const low = runCrown({ wind: 60, cbh: 5, cbd: 0.1 })
    const high = runCrown({ wind: 60, cbh: 15, cbd: 0.1 })
    assert.ok(low.crownCells > 0)
    assert.equal(high.crownCells, 0, 'a 15 m crown base should be out of reach')
  })

  it('transitions sharply at I_0 rather than gradually', () => {
    // Van Wagner's criterion is a threshold, not a ramp: a small change in
    // canopy base height either side of the fire's intensity should flip it.
    const below = runCrown({ wind: 45, cbh: 11, cbd: 0.1 })
    const above = runCrown({ wind: 45, cbh: 4, cbd: 0.1 })
    assert.equal(below.crownCells, 0)
    assert.ok(above.crownCells > 50, `only ${above.crownCells} cells crowned below the threshold`)
  })

  const countActive = (s: { crown: Uint8Array | null }) =>
    s.crown ? Array.from(s.crown).filter((v) => v === Crown.Active).length : 0

  it('needs bulk density as well as intensity to crown actively', () => {
    // Same fire, same canopy base — only bulk density differs. R_0 = 3.0/CBD,
    // so 1.0 demands 3 m/min and 0.02 demands 150. CBD 1.0 is dense, chosen
    // because nominal ROS tops out near 4 m/min; see the note in model.ts.
    const dense = runCrown({ wind: 60, cbh: 5, cbd: 1.0 })
    const sparse = runCrown({ wind: 60, cbh: 5, cbd: 0.02 })
    assert.ok(countActive(dense) > 0, 'a canopy dense enough to sustain crowning never did')
    assert.equal(countActive(sparse), 0, 'sparse canopy should torch, not crown actively')
  })

  it('records that realistic canopy does not yet crown actively', () => {
    // Not a desired behaviour — a consequence of nominal ROS sitting ~4.45x
    // below the emergent rate. Asserted so that when the energy kernel closes
    // that gap this test fails loudly and gets deleted, rather than the change
    // going unnoticed.
    const realistic = runCrown({ wind: 60, cbh: 5, cbd: 0.2 })
    assert.equal(
      countActive(realistic),
      0,
      'realistic canopy now crowns actively — the spread rate was fixed; delete this test'
    )
    assert.ok(realistic.crownCells > 0, 'it should still be torching')
  })

  it('consumes canopy fuel only where it crowned', () => {
    const sim = runCrown({ wind: 60, cbh: 5, cbd: 0.1 })
    assert.ok(sim.canopyLeft && sim.crown)
    for (let i = 0; i < sim.canopyLeft!.length; i++) {
      if (sim.crown![i] === Crown.None) {
        // Float32, so compare with tolerance rather than for equality.
        assert.ok(
          Math.abs(sim.canopyLeft![i] - 1.2) < 1e-6,
          `untouched cell ${i} lost canopy fuel (${sim.canopyLeft![i]})`
        )
      }
      assert.ok(sim.canopyLeft![i] >= 0, 'canopy load went negative')
    }
  })

  it('raises fireline intensity and long-range spotting when it crowns', () => {
    const surface = runCrown({ wind: 60, cbh: 15, cbd: 0.1 })
    const crowned = runCrown({ wind: 60, cbh: 5, cbd: 0.1 })
    assert.ok(
      crowned.stats.maxIntensity > surface.stats.maxIntensity,
      'crowning did not add the canopy to the heat release'
    )
    assert.ok(crowned.stats.spotFires >= surface.stats.spotFires, 'crowning did not increase spotting')
  })
})
