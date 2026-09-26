/**
 * Controlled terrain for kernel tests.
 *
 * `buildTerrain` generates ridged noise and carves a lake, which is the right
 * thing for the app and useless for a physics check: every measurement would
 * be confounded by slope and by unburnable cells. These helpers build exactly
 * the conditions a claim is stated under — flat, uniform, no water — so a
 * failure means the kernel is wrong rather than the terrain being awkward.
 */
import { Fuel, FUELS } from '../src/fuels.ts'
import { Cell, createSim, ignite, step, type Sim } from '../src/model.ts'
import type { Terrain } from '../src/terrain.ts'
import type { Params, Weather } from '../src/weather.ts'

export interface FlatOpts {
  cols?: number
  rows?: number
  cellSize?: number
  fuel?: number
  /** Metres of rise per metre travelled toward the north (grid row 0). */
  slope?: number
}

export function flatTerrain(o: FlatOpts = {}): Terrain {
  const cols = o.cols ?? 161
  const rows = o.rows ?? 161
  const cellSize = o.cellSize ?? 30
  const n = cols * rows
  const elevation = new Float32Array(n)
  if (o.slope) {
    for (let r = 0; r < rows; r++) {
      // Row 0 is north and highest, so +y in grid space runs downhill.
      const h = (rows - 1 - r) * cellSize * o.slope
      for (let c = 0; c < cols; c++) elevation[r * cols + c] = h
    }
  }
  let minElev = Infinity
  let maxElev = -Infinity
  for (const e of elevation) {
    if (e < minElev) minElev = e
    if (e > maxElev) maxElev = e
  }
  return {
    cols,
    rows,
    cellSize,
    bounds: { north: 40.1, south: 40, east: 45.1, west: 45 },
    elevation,
    fuel: new Uint8Array(n).fill(o.fuel ?? Fuel.Grass),
    shade: new Float32Array(n).fill(0.5),
    minElev,
    maxElev,
    source: 'synthetic',
  }
}

/** Calm, dry, no wind — the condition every isotropy claim is stated under. */
export function calm(over: Partial<Weather> = {}): Params {
  return {
    temperature: 20,
    humidity: 20,
    windSpeed: 0,
    windDir: 0,
    gustiness: 0,
    daysSinceRain: 30,
    precipitation: 0,
    ...over,
    spotting: 0,
    suppression: 0,
    followForecast: false,
  }
}

export interface RunOpts {
  steps?: number
  dt?: number
  seed?: number
  extra?: Record<string, unknown>
}

export function runFrom(terrain: Terrain, params: Params, o: RunOpts = {}): Sim {
  const sim = createSim(terrain, o.seed)
  ignite(sim, (terrain.cols - 1) / 2 | 0, (terrain.rows - 1) / 2 | 0, 0)
  const dt = o.dt ?? 10
  for (let i = 0; i < (o.steps ?? 300); i++) {
    step(sim, { params, weather: params, dt, ...(o.extra ?? {}) })
  }
  return sim
}

/** The eight compass directions, as grid steps. */
export const DIRECTIONS: [number, number][] = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
]

/**
 * Mean reach per direction across several RNG seeds.
 *
 * One seeded run cannot answer whether the lattice favours a direction: it is
 * deterministic, so its lopsidedness is frozen and looks exactly like bias.
 * Averaging over seeds lets the stochastic part cancel and leaves whatever is
 * structural.
 */
export function meanReachByDirection(
  terrain: Terrain, params: Params, o: RunOpts & { seeds?: number[] } = {}
): number[] {
  const seeds = o.seeds ?? [1, 2, 3, 4, 5, 6, 7, 8]
  const totals = new Array(DIRECTIONS.length).fill(0)
  for (const seed of seeds) {
    const sim = runFrom(terrain, params, { ...o, seed })
    DIRECTIONS.forEach(([c, r], i) => { totals[i] += reach(sim, c, r) })
  }
  return totals.map((t) => t / seeds.length)
}

/** Furthest burnt cell from the ignition point along a compass direction, in metres. */
export function reach(sim: Sim, dc: number, dr: number): number {
  const { cols, rows, cellSize } = sim.terrain
  const c0 = ((cols - 1) / 2) | 0
  const r0 = ((rows - 1) / 2) | 0
  const stepLen = Math.hypot(dc, dr)
  let far = 0
  for (let k = 1; k < Math.max(cols, rows) / 2; k++) {
    const c = c0 + dc * k
    const r = r0 + dr * k
    if (c < 0 || r < 0 || c >= cols || r >= rows) break
    if (sim.state[r * cols + c] !== Cell.Unburned) far = k * stepLen * cellSize
  }
  return far
}

/** Radius of a circle with the same area as the burn scar, metres. */
export function equivalentRadius(sim: Sim): number {
  let burnt = 0
  for (const s of sim.state) if (s !== Cell.Unburned) burnt++
  const area = burnt * sim.terrain.cellSize ** 2
  return Math.sqrt(area / Math.PI)
}

/**
 * Nominal rate of spread the kernel's own terms imply for a fuel under these
 * conditions, m/s. This is the number the front SHOULD advance at, derived the
 * same way `step` derives it, minus the neighbour loop.
 */
export function nominalRos(fuelId: number, params: Params, fmc: number): number {
  const f = FUELS[fuelId]
  const damping = f.load <= 0 || fmc >= f.mx ? 0 : Math.pow((f.mx - fmc) / (f.mx - 1.5), 1.5)
  const heat = Math.max(0.2, 1 + 0.018 * (params.temperature - 20))
  return f.baseRos * damping * heat
}
