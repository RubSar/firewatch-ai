import { FUELS, Fuel, type FuelModel } from './fuels.ts'
import type { Terrain } from './terrain.ts'
import type { Params, Weather } from './weather.ts'
import { fuelMoisture } from './weather.ts'
import { makeRng } from './noise.ts'

export const Cell = { Unburned: 0, Burning: 1, Burned: 2 } as const

export const Treatment = { None: 0, Dozer: 1, Retardant: 2 } as const

/** Heat yield of forest fuels, kJ/kg — the constant in Byram's intensity equation. */
const HEAT_YIELD = 18600

export interface Stats {
  burnedCells: number
  activeCells: number
  /** Hectares. */
  area: number
  /** Kilometres of active fire edge. */
  perimeter: number
  /** Fraction of the active edge backed by a barrier or already-burnt ground. */
  containment: number
  /** Peak head-fire rate of spread this step, m/min. */
  maxRos: number
  /** Peak Byram fireline intensity, kW/m. */
  maxIntensity: number
  /** Byram flame length at peak intensity, m. */
  flameLength: number
  /** Developed (WUI) cells burnt. */
  wuiCells: number
  /** Structures destroyed, estimated at STRUCTURES_PER_HA on burnt WUI ground. */
  structuresLost: number
  spotFires: number
}

/** Assumed dwelling density on developed cells — stated, not measured. */
export const STRUCTURES_PER_HA = 3

export interface Sim {
  terrain: Terrain
  state: Uint8Array
  fuelLeft: Float32Array
  /** Byram fireline intensity per burning cell, kW/m. */
  intensity: Float32Array
  /** Sim seconds at which each cell ignited, -1 if never. */
  ignitedAt: Float32Array
  treatment: Uint8Array
  active: number[]
  time: number
  /** Bumped whenever the grid changes outside of a step, so the renderer can
   *  skip repainting a frame in which nothing moved. */
  revision: number
  /** Cells ever ignited. Maintained incrementally; the O(n) scan is not. */
  burnedCells: number
  peakRos: number
  peakIntensity: number
  wuiCells: number
  spotFires: number
  stats: Stats
  history: { t: number; area: number; perimeter: number }[]
  rng: () => number
}

export const EMPTY_STATS: Stats = {
  burnedCells: 0, activeCells: 0, area: 0, perimeter: 0, containment: 0,
  maxRos: 0, maxIntensity: 0, flameLength: 0, wuiCells: 0, structuresLost: 0, spotFires: 0,
}

export function createSim(terrain: Terrain): Sim {
  const n = terrain.cols * terrain.rows
  return {
    terrain,
    state: new Uint8Array(n),
    fuelLeft: Float32Array.from({ length: n }, (_, i) => FUELS[terrain.fuel[i]].load),
    intensity: new Float32Array(n),
    ignitedAt: new Float32Array(n).fill(-1),
    treatment: new Uint8Array(n),
    active: [],
    time: 0,
    revision: 0,
    burnedCells: 0,
    peakRos: 0,
    peakIntensity: 0,
    wuiCells: 0,
    spotFires: 0,
    stats: { ...EMPTY_STATS },
    history: [],
    rng: makeRng(0xf13e5),
  }
}

/**
 * Moves a running fire onto a sim built over a different terrain of the same
 * size — used when real DEM/fuel arrives a second after the procedural grid and
 * must not wipe what the user lit.
 *
 * Copies every mutable field. Leaving any out is a silent bug: omitting
 * `fuelLeft` makes burnt cells burn again, omitting `intensity` blanks the
 * flame bands until the next step recomputes them.
 */
export function transferSimState(from: Sim, to: Sim): boolean {
  if (from.state.length !== to.state.length) return false
  to.state.set(from.state)
  to.fuelLeft.set(from.fuelLeft)
  to.intensity.set(from.intensity)
  to.ignitedAt.set(from.ignitedAt)
  to.treatment.set(from.treatment)
  to.active = [...from.active]
  to.time = from.time
  to.revision = from.revision + 1
  to.burnedCells = from.burnedCells
  to.peakRos = from.peakRos
  to.peakIntensity = from.peakIntensity
  to.wuiCells = from.wuiCells
  to.spotFires = from.spotFires
  to.history = from.history.map((h) => ({ ...h }))
  recomputeStats(to)
  return true
}

export function ignite(sim: Sim, col: number, row: number, radius = 1): number {
  const { cols, rows, fuel } = sim.terrain
  let lit = 0
  for (let r = row - radius; r <= row + radius; r++) {
    for (let c = col - radius; c <= col + radius; c++) {
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue
      const i = r * cols + c
      if (sim.state[i] !== Cell.Unburned || FUELS[fuel[i]].load <= 0) continue
      sim.state[i] = Cell.Burning
      sim.ignitedAt[i] = sim.time
      sim.intensity[i] = 1
      sim.active.push(i)
      sim.burnedCells++
      if (fuel[i] === Fuel.Urban) sim.wuiCells++
      lit++
      sim.revision++
    }
  }
  return lit
}

export function paintTreatment(sim: Sim, col: number, row: number, radius: number, kind: number) {
  const { cols, rows } = sim.terrain
  let knocked = false
  for (let r = row - radius; r <= row + radius; r++) {
    for (let c = col - radius; c <= col + radius; c++) {
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue
      if ((c - col) ** 2 + (r - row) ** 2 > radius * radius) continue
      const i = r * cols + c
      sim.treatment[i] = kind
      // Retardant and dozer line both knock down anything already alight.
      if (sim.state[i] === Cell.Burning) {
        sim.state[i] = Cell.Burned
        sim.intensity[i] = 0
        knocked = true
      }
    }
  }
  // Only rescan the active list if this stamp actually put something out.
  if (knocked) sim.active = sim.active.filter((i) => sim.state[i] === Cell.Burning)
  sim.revision++
}

/** How long a cell stays alight, seconds — heavy fuels smoulder far longer. */
const burnDuration = (load: number) => 360 + load * 900

/**
 * Neighbour offsets: [dc, dr, distance multiplier, bearing degrees].
 *
 * Exported because the index into this array is the `d` of
 * `blockFrac[i * 8 + d]`: a barrier provider that rasterises onto a different
 * ordering blocks the wrong edges, and nothing would fail loudly.
 */
export const NEIGHBOURS: [number, number, number, number][] = [
  [0, -1, 1, 0], [1, -1, Math.SQRT2, 45], [1, 0, 1, 90], [1, 1, Math.SQRT2, 135],
  [0, 1, 1, 180], [-1, 1, Math.SQRT2, 225], [-1, 0, 1, 270], [-1, -1, Math.SQRT2, 315],
]

/** Gust and direction wobble are deterministic functions of sim time. */
export function gustAt(w: Weather, time: number) {
  const osc = 0.55 * Math.sin(time / 131) + 0.3 * Math.sin(time / 47 + 1.7) + 0.15 * Math.sin(time / 17 + 0.4)
  const speed = Math.max(0, w.windSpeed * (1 + 0.55 * w.gustiness * osc))
  const dir = w.windDir + 18 * w.gustiness * Math.sin(time / 89 + 2.3)
  return { speed, dir }
}

export interface StepInput {
  params: Params
  /** Effective weather this step — either the sliders or the forecast feed. */
  weather: Weather
  /** Seconds of simulated time to advance. */
  dt: number
  /**
   * Per-edge barrier obstruction, `blockFrac[i * 8 + d]` for the flux from cell
   * `i` toward `NEIGHBOURS[d]` — roads, streams, anything narrower than a cell
   * (ARCHITECTURE.md §5 handles those as vectors, not as unburnable cells).
   * Omitted means no barriers, which is what the browser-only path passes.
   */
  blockFrac?: Float32Array
  /**
   * Per-cell wind vector in m/s, u eastward and v northward. Omitted means the
   * single vector in `weather`, which is what the browser-only path passes.
   *
   * Wind dominates total error (ARCHITECTURE.md §7), and a 15 km domain spans
   * several cells of any real forecast grid, so one vector for the whole fire
   * is the largest avoidable simplification in the model.
   */
  windField?: { u: Float32Array; v: Float32Array }
  /**
   * Per-cell dead fine fuel moisture, %. Omitted means the scalar derived from
   * `weather`. A field lets aspect and shading matter: a south slope at noon is
   * drier than the gully beside it, and that is where a fire turns.
   */
  moisture?: Float32Array
}

/**
 * How strongly a fuel's own moisture damps its spread, 0 = will not carry.
 *
 * Extracted so the per-cell path can evaluate it against local moisture while
 * the scalar path keeps precomputing it once per fuel per step.
 */
function moistureDamping(f: FuelModel, fmc: number): number {
  return f.load <= 0 || fmc >= f.mx ? 0 : Math.pow((f.mx - fmc) / (f.mx - 1.5), 1.5)
}

export function step(sim: Sim, input: StepInput) {
  const { terrain, state, fuelLeft, intensity, treatment, rng } = sim
  const { cols, rows, cellSize, elevation, fuel } = terrain
  const { weather, params, dt, blockFrac, windField, moisture } = input

  const fmc = fuelMoisture(weather)
  const gust = gustAt(weather, sim.time)
  const windMs = gust.speed / 3.6
  const windToBearing = (gust.dir + 180) % 360
  // Gusting is a time signal, not a place signal, so it rides on top of a
  // spatial field rather than replacing it: scale the local vector by the same
  // factor the scalar gust applies, and carry the same direction wobble.
  const gustScale = weather.windSpeed > 0.1 ? gust.speed / weather.windSpeed : 1
  const gustVeer = gust.dir - weather.windDir
  const tempMult = 1 + 0.018 * (weather.temperature - 20)
  // Crews and aircraft only hold a line while the fire is slow enough to work.
  const suppressionEffort = params.suppression / 100
  const rainQuench = weather.precipitation * 0.0004

  // With one moisture value for the whole grid the damping is a per-fuel
  // constant, so precompute it. A moisture field forces the per-cell path.
  const moistOf = FUELS.map((f) => moistureDamping(f, fmc))
  const dampingAt = (f: FuelModel, cell: number) =>
    moisture ? moistureDamping(f, moisture[cell]) : moistOf[f.id]

  const ignitions: number[] = []
  const stillActive: number[] = []
  let maxRos = 0
  let maxIntensity = 0

  for (let k = 0; k < sim.active.length; k++) {
    const i = sim.active[k]
    const fm = FUELS[fuel[i]]

    // --- fuel consumption ---
    fuelLeft[i] -= (fm.load / burnDuration(fm.load)) * dt
    if (fuelLeft[i] <= 0) {
      state[i] = Cell.Burned
      intensity[i] = 0
      continue
    }

    const c = i % cols
    const r = (i / cols) | 0

    // --- head-fire rate of spread for this cell ---
    const heatMult = Math.max(0.2, tempMult)

    if (dampingAt(fm, i) <= 0) {
      // Too wet to carry — the cell burns out where it stands.
      fuelLeft[i] -= (fm.load / burnDuration(fm.load)) * dt * 2
      intensity[i] = Math.min(intensity[i], 250)
      stillActive.push(i)
      continue
    }

    // Local wind where a field is supplied, otherwise the single vector.
    let cellWindMs = windMs
    let cellWindToBearing = windToBearing
    if (windField) {
      const u = windField.u[i]
      const v = windField.v[i]
      cellWindMs = Math.hypot(u, v) * gustScale
      // atan2(u, v) gives the bearing the wind blows TOWARD, clockwise from
      // north — which is already the convention the spread term wants.
      cellWindToBearing = (((Math.atan2(u, v) * 180) / Math.PI) + gustVeer + 360) % 360
    }

    let cellMaxRos = 0
    for (let d = 0; d < NEIGHBOURS.length; d++) {
      const [dc, dr, distMul, bearing] = NEIGHBOURS[d]
      const nc = c + dc
      const nr = r + dr
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const j = nr * cols + nc
      if (state[j] !== Cell.Unburned) continue
      const nf = FUELS[fuel[j]]
      if (nf.load <= 0) continue
      if (treatment[j] === Treatment.Dozer) continue

      // A barrier narrower than a cell obstructs part of the shared edge, so
      // only the open fraction of the flux crosses it. Never quite 1 in
      // practice — a road stops a creeping flank, not a spotting head fire.
      const block = blockFrac ? blockFrac[i * 8 + d] : 0
      if (block >= 1) continue

      const dist = cellSize * distMul

      // Slope: rate of spread roughly doubles per 10 deg of upslope.
      const slopeDeg = (Math.atan((elevation[j] - elevation[i]) / dist) * 180) / Math.PI
      const slopeMult = Math.min(8, Math.exp(0.0693 * Math.max(-25, Math.min(25, slopeDeg))))

      // Wind: exponential in the component of wind along the spread direction,
      // so the head races and the backing edge crawls.
      const align = Math.cos(((bearing - cellWindToBearing) * Math.PI) / 180)
      const windMult = Math.min(40, Math.exp(0.115 * cellWindMs * align))

      // Spread is governed by the fuel being entered, damped by its own
      // moisture of extinction — grass carries where damp timber will not.
      const nMoist = dampingAt(nf, j)
      if (nMoist <= 0) continue

      let ros = nf.baseRos * nMoist * heatMult * slopeMult * windMult * (1 - block)
      if (treatment[j] === Treatment.Retardant) ros *= 0.12

      if (ros > cellMaxRos) cellMaxRos = ros
      // Exponential arrival: p = 1 - exp(-ROS * dt / distance).
      const p = 1 - Math.exp(-(ros * dt) / dist)
      if (rng() < p) ignitions.push(j)
    }

    // Byram: I = H * w * ROS.
    const byram = HEAT_YIELD * fm.load * cellMaxRos
    intensity[i] = byram
    if (cellMaxRos > maxRos) maxRos = cellMaxRos
    if (byram > maxIntensity) maxIntensity = byram

    // --- spotting: embers lofted from high-intensity fuel ---
    if (params.spotting > 0 && cellWindMs > 3 && byram > 1500) {
      const pSpot = fm.spotting * params.spotting * (cellWindMs / 60) * (dt / 60) * 0.06
      if (rng() < pSpot) {
        const maxCells = (cellWindMs * 90) / cellSize
        const range = 2 + rng() * maxCells
        const jitter = ((rng() - 0.5) * 34 * Math.PI) / 180
        const th = ((cellWindToBearing * Math.PI) / 180) + jitter
        const sc2 = Math.round(c + Math.sin(th) * range)
        const sr2 = Math.round(r - Math.cos(th) * range)
        if (sc2 >= 0 && sr2 >= 0 && sc2 < cols && sr2 < rows) {
          const sj = sr2 * cols + sc2
          if (state[sj] === Cell.Unburned && FUELS[fuel[sj]].load > 0 && treatment[sj] === Treatment.None) {
            ignitions.push(sj)
            sim.spotFires++
          }
        }
      }
    }

    // --- suppression: effective only on a slow-moving edge ---
    if (suppressionEffort > 0) {
      const holdable = Math.max(0, 1 - cellMaxRos / 0.4)
      const pOut = 1 - Math.exp(-suppressionEffort * holdable * (dt / 1800))
      if (rng() < pOut) {
        state[i] = Cell.Burned
        intensity[i] = 0
        continue
      }
    }

    // --- rain knock-down ---
    if (rainQuench > 0 && rng() < 1 - Math.exp(-rainQuench * dt)) {
      state[i] = Cell.Burned
      intensity[i] = 0
      continue
    }

    stillActive.push(i)
  }

  for (const j of ignitions) {
    if (state[j] !== Cell.Unburned) continue
    state[j] = Cell.Burning
    sim.ignitedAt[j] = sim.time
    intensity[j] = 500
    if (fuel[j] === Fuel.Urban) sim.wuiCells++
    sim.burnedCells++
    stillActive.push(j)
  }

  sim.active = stillActive
  sim.time += dt

  sim.peakRos = maxRos
  sim.peakIntensity = maxIntensity
}

/**
 * Perimeter/containment need a full-grid pass, so this is called once per
 * rendered frame rather than once per simulation step.
 *
 * `structures` is a per-cell count of real buildings when a provider supplied
 * one. Without it the loss figure stays the `STRUCTURES_PER_HA` estimate over
 * burnt developed land, which is what the browser-only path uses.
 */
export function recomputeStats(sim: Sim, structures?: Float32Array) {
  const { cols, rows, cellSize, fuel } = sim.terrain
  const { state, treatment } = sim
  const cellArea = cellSize * cellSize

  // Fire perimeter: the 4-connected outline of everything already burnt or
  // burning. An edge counts as held once no active flame touches it or a
  // barrier (line, retardant, water) sits on the far side.
  let edge = 0
  let held = 0
  let structuresLost = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (state[i] === Cell.Unburned) continue
      if (structures) structuresLost += structures[i]
      for (let d = 0; d < 4; d++) {
        const nc = c + ORTHO[d][0]
        const nr = r + ORTHO[d][1]
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
        const j = nr * cols + nc
        if (state[j] !== Cell.Unburned) continue
        edge++
        if (state[i] === Cell.Burned || treatment[j] !== Treatment.None || FUELS[fuel[j]].load <= 0) held++
      }
    }
  }

  const burned = sim.burnedCells
  sim.stats = {
    burnedCells: burned,
    activeCells: sim.active.length,
    area: (burned * cellArea) / 10000,
    perimeter: (edge * cellSize) / 1000,
    containment: edge > 0 ? held / edge : burned > 0 ? 1 : 0,
    maxRos: sim.peakRos * 60,
    maxIntensity: sim.peakIntensity,
    flameLength: sim.peakIntensity > 0 ? 0.0775 * Math.pow(sim.peakIntensity, 0.46) : 0,
    wuiCells: sim.wuiCells,
    structuresLost: structures
      ? Math.round(structuresLost)
      : Math.round(((sim.wuiCells * cellArea) / 10000) * STRUCTURES_PER_HA),
    spotFires: sim.spotFires,
  }

  const last = sim.history[sim.history.length - 1]
  if (!last || sim.time - last.t >= 300) {
    sim.history.push({ t: sim.time, area: sim.stats.area, perimeter: sim.stats.perimeter })
    if (sim.history.length > 600) sim.history.shift()
  }
}

const ORTHO: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]]
