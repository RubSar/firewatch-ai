/**
 * Kernel physics tests — ARCHITECTURE.md's Verification section, as code.
 *
 * That section claims these "run in CI and gate every kernel change". They did
 * not exist. A model whose numbers look plausible while its emergent behaviour
 * is wrong is the failure mode the document names, and it is invisible to
 * every check that does not measure behaviour directly.
 *
 * No test here is `todo` any more. Two were, for the whole life of this file:
 * the front advanced at 4.45x the kernel's own nominal rate, and calm-wind
 * spread disagreed with Rothermel by 5.6x. Both were the same defect — a
 * per-step Bernoulli arrival draw, which let the front advance by first-passage
 * percolation over competing paths instead of at the modelled rate. Finney
 * (2002) Minimum Travel Time replaced it and both closed on their own.
 *
 * The lesson worth keeping: a `todo` that encodes a target and reports the real
 * number is how a known defect stays visible without blocking unrelated work.
 * Neither was ever tuned into passing.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Fuel, FUELS } from '../src/fuels.ts'
import {
  Cell, Crown, Treatment, attachCanopy, createSim, ignite, paintTreatment, recomputeStats, step,
  windMultiplier,
} from '../src/model.ts'
import { fuelMoisture } from '../src/weather.ts'
import { MIDFLAME_WIND_FACTOR, rothermelSpread } from '../src/rothermel.ts'
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
 * PROMOTED FROM TODO. Measured 0.95-1.00x across the bench's 14 cases, having
 * sat at 4.45x for this test's whole life.
 *
 * The cause was the arrival draw: `p = 1 - exp(-ROS dt / d)` gave every link an
 * independent chance every step, so the front advanced by first-passage
 * percolation over many competing paths rather than at the rate the kernel
 * reported. Finney (2002) Minimum Travel Time replaced it with a deterministic
 * shortest-arrival-time search, and the discrepancy went away rather than being
 * calibrated out. Do not reintroduce a per-step probability of ignition.
 */
it(
  'front advances at the kernel\'s own nominal ROS',
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

  it('is blocked by a high enough canopy base, at identical fire intensity', () => {
    // Relative rather than absolute: I_0 grows as CBH^1.5, so whatever the
    // fire's intensity, some canopy base is out of reach. Pinning a specific
    // height would make this a test of the spread rate instead.
    const low = runCrown({ wind: 20, cbh: 3, cbd: 0.1 })
    const high = runCrown({ wind: 20, cbh: 40, cbd: 0.1 })
    assert.ok(low.crownCells > 0, 'a low crown base was never reached')
    assert.equal(high.crownCells, 0, 'a 40 m crown base should be out of reach')
  })

  it('transitions sharply at I_0 rather than gradually', () => {
    // Van Wagner's criterion is a threshold, not a ramp. Bracket it by
    // searching for the height where crowning stops, then check that one step
    // either side of it flips the outcome.
    let blocked = 4
    while (blocked < 200 && runCrown({ wind: 20, cbh: blocked, cbd: 0.1 }).crownCells > 0) {
      blocked *= 2
    }
    const passes = runCrown({ wind: 20, cbh: blocked / 2, cbd: 0.1 })
    const fails = runCrown({ wind: 20, cbh: blocked, cbd: 0.1 })
    // A FRACTION, not a count. This asserted `crownCells > 50`, which was
    // calibrated against the arrival-draw overshoot: the front used to run 4.45x
    // the kernel's own rate, so any run burnt more cells than it should have.
    // MTT removed the overshoot and the same fire is now 45 cells, so a count
    // threshold started failing while the behaviour under test got better.
    // Every burnt cell crowns below the threshold and none above it, which is
    // the sharpness being claimed and is independent of how big the fire is.
    assert.ok(passes.burnedCells > 20, `fire too small to conclude anything: ${passes.burnedCells} cells`)
    assert.ok(
      passes.crownCells / passes.burnedCells > 0.8,
      `only ${passes.crownCells} of ${passes.burnedCells} burnt cells crowned below the threshold`
    )
    assert.equal(fails.crownCells, 0, `still crowning at a ${blocked} m crown base`)
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
    const surface = runCrown({ wind: 20, cbh: 40, cbd: 0.1 })
    const crowned = runCrown({ wind: 20, cbh: 3, cbd: 0.1 })
    assert.ok(
      crowned.stats.maxIntensity > surface.stats.maxIntensity,
      'crowning did not add the canopy to the heat release'
    )
    assert.ok(crowned.stats.spotFires >= surface.stats.spotFires, 'crowning did not increase spotting')
  })
})

/**
 * The external reference ARCHITECTURE.md's Verification section asks for.
 *
 * Until now the only "target" available was `nominalRos`, which is the
 * kernel's own formula — a model checked against its own opinion. Rothermel
 * shares no structure with it, so disagreement means something.
 *
 * `npm run bench` prints the full table.
 */
/**
 * PROMOTED FROM TODO, and it is now testing what it always claimed to.
 *
 * It used to fail at 5.6x because the EMERGENT rate carried the arrival-draw
 * overshoot on top of whatever the kernel's own rate was, so the two errors were
 * indistinguishable. With MTT the emergent rate equals the nominal rate, and
 * what is left is the nominal-vs-Rothermel offset alone — 1.14x for grass.
 *
 * Grass only. The per-fuel offsets range 0.24x-1.14x (see `npm run bench`) and
 * are NOT the arrival draw: they come from `depth`, `sav` and `bulkDensity`
 * being invented rather than measured. Widening this test to every fuel would
 * hide that behind a loose bound; it needs real Anderson or Scott & Burgan bed
 * parameters and multi-size-class Rothermel.
 */
it('calm-wind spread matches Rothermel within a factor of two', () => {
  const f = FUELS[Fuel.Grass]
  const params = calm({ temperature: 25, humidity: 25 })
  const reference = rothermelSpread({
    fuel: { load: f.load, depth: f.depth, sav: f.sav, moistureOfExtinction: f.mx / 100 },
    moisture: fuelMoisture(params) / 100,
    windKmh: 0,
    slopeTan: 0,
  }).rosMMin
  const steps = 500
  const emergent = (equivalentRadius(runFrom(flatTerrain(), params, { steps, dt: 10, seed: 7 })) / (steps * 10)) * 60
  assert.ok(
    emergent / reference > 0.5 && emergent / reference < 2,
    `emergent ${emergent.toFixed(2)} m/min against Rothermel ${reference.toFixed(2)} ` +
      `— ${(emergent / reference).toFixed(1)}x (the arrival-draw overshoot)`
  )
})

it('matches Rothermel\'s wind response across the useful range', () => {
  // Was the larger of the two errors: exp(0.115*U) reached 3.6x at 40 km/h
  // where Rothermel reaches 65x, so wind-driven fire — the dangerous case —
  // was badly under-predicted. The kernel now uses Rothermel's own phi_w.
  //
  // Calls windMultiplier rather than restating it: a test that keeps its own
  // copy of the formula stops testing the code, which is how the original
  // version of this kept passing the wrong thing.
  const f = FUELS[Fuel.Grass]
  const fuel = { load: f.load, depth: f.depth, sav: f.sav, moistureOfExtinction: f.mx / 100 }
  const moisture = fuelMoisture(calm({ temperature: 25, humidity: 25 })) / 100
  const at = (w: number) =>
    rothermelSpread({ fuel, moisture, windKmh: w * MIDFLAME_WIND_FACTOR, slopeTan: 0 }).rosMMin
  for (const kmh of [10, 20, 40, 65]) {
    const referenceGain = at(kmh) / at(0)
    const kernelGain = windMultiplier(Fuel.Grass, kmh / 3.6, 1)
    const err = Math.abs(kernelGain - referenceGain) / referenceGain
    assert.ok(
      err < 0.1,
      `at ${kmh} km/h the kernel multiplies spread by ${kernelGain.toFixed(1)}x ` +
        `where Rothermel gives ${referenceGain.toFixed(1)}x`
    )
  }
})

describe('control lines stop a fire that is already coming', () => {
  /**
   * The behaviour minimum-travel-time propagation most endangers.
   *
   * MTT computes when the fire WILL reach a cell, so the moment a line is drawn
   * the cells in front of it already hold arrival times calculated as though it
   * were not there. The settle pass checks that a cell is still unburnt before
   * igniting it, but a queued arrival knows nothing about a treatment applied
   * after it was computed, so without `invalidateFront` a treated cell ignites
   * off a stale arrival — and then relaxes its own links, seeding spread on the
   * far side.
   *
   * THE LINE MUST GO DIRECTLY AGAINST THE FRONT. A first version drew it well
   * ahead of the fire and passed with the invalidation removed, because nothing
   * had been queued that far out yet: the frontier is only one ring deep, so
   * that is the only place staleness can exist. One cell thick, for the same
   * reason — a three-cell line absorbs the one-cell leak and hides the defect.
   */
  const runToLine = (o: { treat: boolean }) => {
    const N = 121
    const t = flatTerrain({ cols: N, rows: N, cellSize: 30 })
    // Wind from the north, so the fire runs south into increasing rows.
    const params = calm({ windSpeed: 25, windDir: 0 })
    const sim = createSim(t, 3)
    ignite(sim, 60, 40, 0)
    for (let i = 0; i < 60; i++) step(sim, { params, weather: params, dt: 10 })

    // Furthest row the fire has reached, so the line lands on cells whose
    // arrival times are already in the queue.
    let front = 0
    for (let i = 0; i < sim.state.length; i++) {
      if (sim.state[i] !== Cell.Unburned) front = Math.max(front, (i / N) | 0)
    }
    const line = front + 1
    if (o.treat) for (let c = 0; c < N; c++) paintTreatment(sim, c, line, 0, Treatment.Dozer)

    for (let i = 0; i < 400; i++) step(sim, { params, weather: params, dt: 10 })

    let beyond = 0
    let onLine = 0
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (sim.state[r * N + c] === Cell.Unburned) continue
        if (r === line) onLine++
        else if (r > line) beyond++
      }
    }
    return { beyond, onLine, line }
  }

  it('crosses freely when there is no line', () => {
    const { beyond, line } = runToLine({ treat: false })
    assert.ok(beyond > 20, `only ${beyond} cells burnt past row ${line} — the control case never got there`)
  })

  it('never ignites a treated cell, and never gets past the line', () => {
    const { beyond, onLine, line } = runToLine({ treat: true })
    assert.equal(onLine, 0, `${onLine} cells burnt ON the dozer line at row ${line} — a stale arrival ignited a treated cell`)
    assert.equal(beyond, 0, `${beyond} cells burnt beyond the dozer line — the front ignored it`)
  })
})
