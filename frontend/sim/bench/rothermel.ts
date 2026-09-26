/**
 * Benchmark harness: this kernel against Rothermel, on identical inputs.
 *
 *   npm run bench --workspace=@firewatch/sim
 *
 * ARCHITECTURE.md §8 makes benchmarking against an established model a gate on
 * step 1. Cell2Fire and ELMFIRE were the intended references and neither is
 * buildable here, so this uses Rothermel directly — the model underneath
 * ELMFIRE, FARSITE and BehavePlus — validated to 4% on FM1.
 *
 * It reports three numbers per case, and the gap between them is the point:
 *
 *   rothermel  what an established model says the fire should do
 *   nominal    what this kernel computes per cell and reports to the UI
 *   emergent   how fast the front measurably advances
 *
 * `nominal vs rothermel` asks whether the kernel's tabulated rates and
 * multipliers are defensible at all. `emergent vs nominal` is the known 4.45x
 * arrival-draw defect. They are independent failures and conflating them is
 * how a model ends up plausible and wrong at once.
 */
import { FUELS, Fuel } from '../src/fuels.ts'
import { windMultiplier } from '../src/model.ts'
import { fuelMoisture } from '../src/weather.ts'
import { MIDFLAME_WIND_FACTOR, rothermelSpread } from '../src/rothermel.ts'
import { createSim, ignite, step } from '../src/model.ts'
import { calm, equivalentRadius, flatTerrain, nominalRos, reach } from '../test/harness.ts'

interface Case {
  fuel: number
  windKmh: number
  slopeDeg: number
  tempC: number
  rh: number
}

const CASES: Case[] = []
for (const fuel of [Fuel.Grass, Fuel.Shrub, Fuel.Timber, Fuel.Agriculture]) {
  for (const windKmh of [0, 15, 40]) {
    CASES.push({ fuel, windKmh, slopeDeg: 0, tempC: 25, rh: 25 })
  }
}
for (const slopeDeg of [15, 30]) {
  CASES.push({ fuel: Fuel.Grass, windKmh: 0, slopeDeg, tempC: 25, rh: 25 })
}

const DT = 10
/**
 * Domain and duration are chosen so the head never reaches the boundary.
 *
 * `reach` saturates at the grid edge, and a saturated measurement looks like
 * a plausible number rather than an error — an early run of this reported a
 * suspiciously uniform 28.80 m/min across unrelated cases, which was the fire
 * hitting the wall. The run stops once the head passes a fraction of the
 * half-width, and the elapsed time at that point gives the rate.
 */
const COLS = 401
const CELL = 30
const STOP_FRACTION = 0.7
const MAX_STEPS = 4000

function measure(c: Case) {
  const f = FUELS[c.fuel]
  const params = calm({ temperature: c.tempC, humidity: c.rh, windSpeed: c.windKmh })
  const fmc = fuelMoisture(params)

  const slopeTan = Math.tan((c.slopeDeg * Math.PI) / 180)
  const reference = rothermelSpread({
    fuel: {
      load: f.load,
      depth: f.depth,
      sav: f.sav,
      moistureOfExtinction: f.mx / 100,
    },
    moisture: fmc / 100,
    // Rothermel wants wind at flame height, not at 10 m.
    windKmh: c.windKmh * MIDFLAME_WIND_FACTOR,
    slopeTan,
  })

  // The kernel's own head-fire rate, in the same units. Calls the kernel's
  // wind function rather than restating it — a benchmark that keeps its own
  // copy of the formula stops measuring the thing it is benchmarking, which
  // is exactly what happened on the first run of this after the wind fix.
  const nominal = nominalRos(c.fuel, params, fmc) * 60 *
    windMultiplier(c.fuel, c.windKmh / 3.6, 1) *
    (c.slopeDeg > 0 ? Math.min(8, Math.exp(0.0693 * c.slopeDeg)) : 1)

  // Measured front advance.
  //
  // Equal-area radius is only meaningful for a round fire. Under wind or on
  // slope the fire is elongated, and an equal-area radius averages the fast
  // head with the crawling flanks and back — which understated the head badly
  // enough to distort the first run of this benchmark. Measure the HEAD
  // directly whenever there is a preferred direction.
  const terrain = flatTerrain({ cols: COLS, rows: COLS, cellSize: CELL, fuel: c.fuel, slope: slopeTan || undefined })
  const limit = ((COLS - 1) / 2) * CELL * STOP_FRACTION
  const directed = c.windKmh > 0 || c.slopeDeg > 0
  // Wind blows FROM the north in `calm()`, so the head runs south (+row);
  // the harness slopes uphill toward the north (-row).
  const dir: [number, number] = c.windKmh > 0 ? [0, 1] : [0, -1]

  const sim = createSim(terrain, 7)
  ignite(sim, ((COLS - 1) / 2) | 0, ((COLS - 1) / 2) | 0, 0)
  let elapsed = 0
  let front = 0
  for (let i = 0; i < MAX_STEPS; i++) {
    step(sim, { params, weather: params, dt: DT })
    elapsed += DT
    if (i % 10 !== 0) continue
    front = directed ? reach(sim, dir[0], dir[1]) : equivalentRadius(sim)
    if (front >= limit) break
    if (sim.active.length === 0) break
  }
  const emergent = elapsed > 0 ? (front / elapsed) * 60 : 0
  // Reaching the limit is the intended stop. Running out of steps without
  // reaching it means the fire was still short of the measurement distance,
  // so the rate may be understated — that is the case worth flagging.
  const saturated = front < limit * 0.999

  return { reference: reference.rosMMin, nominal, emergent, saturated, extinguished: reference.extinguished }
}

const name = (id: number) => FUELS[id].name.split(' ')[0]
const ratio = (a: number, b: number) => (b > 1e-9 ? (a / b).toFixed(2) + 'x' : '--')

console.log('Kernel vs Rothermel — head-fire rate of spread, m/min')
console.log('(emergent = head reach / time when directed, equal-area radius when calm)')
console.log()
console.log('fuel        wind  slope  rothermel   nominal  emergent   nom/roth  emrg/nom')
const gaps: number[] = []
for (const c of CASES) {
  const m = measure(c)
  if (m.nominal > 1e-9) gaps.push(m.nominal / Math.max(1e-9, m.reference))
  console.log(
    name(c.fuel).padEnd(12) +
      String(c.windKmh).padStart(4) +
      String(c.slopeDeg).padStart(7) +
      m.reference.toFixed(2).padStart(11) +
      m.nominal.toFixed(2).padStart(10) +
      m.emergent.toFixed(2).padStart(10) +
      ratio(m.nominal, m.reference).padStart(11) +
      ratio(m.emergent, m.nominal).padStart(10) +
      (m.saturated ? '  (short run)' : '')
  )
}
const lo = Math.min(...gaps)
const hi = Math.max(...gaps)
console.log()
console.log(`nominal / rothermel: ${lo.toFixed(2)}x - ${hi.toFixed(2)}x across ${gaps.length} cases`)
console.log(
  lo > 0.5 && hi < 2
    ? 'The kernel\'s own rates are within a factor of two of an established model.'
    : 'The kernel\'s own rates disagree with an established model by more than 2x — ' +
      'the arrival-draw defect is NOT the whole error.'
)
