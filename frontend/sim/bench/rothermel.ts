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
import { fuelMoisture } from '../src/weather.ts'
import { MIDFLAME_WIND_FACTOR, rothermelSpread } from '../src/rothermel.ts'
import { calm, equivalentRadius, flatTerrain, nominalRos, runFrom } from '../test/harness.ts'

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

const STEPS = 500
const DT = 10

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

  // The kernel's own head-fire rate, in the same units.
  const nominal = nominalRos(c.fuel, params, fmc) * 60 *
    (c.windKmh > 0 ? Math.min(40, Math.exp(0.115 * (c.windKmh / 3.6))) : 1) *
    (c.slopeDeg > 0 ? Math.min(8, Math.exp(0.0693 * c.slopeDeg)) : 1)

  // Measured front advance. Slope runs are uphill-only, so equal-area radius
  // understates the head; wind runs likewise. Reported anyway, flagged below.
  const terrain = flatTerrain({ fuel: c.fuel, slope: slopeTan || undefined })
  const sim = runFrom(terrain, params, { steps: STEPS, dt: DT, seed: 7 })
  const emergent = (equivalentRadius(sim) / (STEPS * DT)) * 60

  return { reference: reference.rosMMin, nominal, emergent, extinguished: reference.extinguished }
}

const name = (id: number) => FUELS[id].name.split(' ')[0]
const ratio = (a: number, b: number) => (b > 1e-9 ? (a / b).toFixed(2) + 'x' : '--')

console.log('Kernel vs Rothermel — head-fire rate of spread, m/min')
console.log('(equal-area emergent rate understates the head when wind or slope is on)')
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
      ratio(m.emergent, m.nominal).padStart(10)
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
