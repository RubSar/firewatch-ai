import { flamingTime } from '@firewatch/sim/fuels'
import { Cell, Treatment, type Sim } from '@firewatch/sim/model'
import { contourPath, smoothField } from './contour.ts'

export interface Band {
  path: Path2D
  fill: string
}

export interface FireGeometry {
  /** Everything already burnt, as one path with holes for unburnt islands. */
  scar: Path2D | null
  /** Burnt ground banded by arrival hour, newest first. Empty unless enabled. */
  isochrones: Band[]
  /** Active fire, outermost (coolest) first. */
  flames: Band[]
  dozer: Path2D | null
  retardant: Path2D | null
}

/** Scratch buffers, sized to the grid and reused between rebuilds. */
export interface GeometryBuffers {
  field: Float32Array
  scratch: Float32Array
  /** Frozen arrival-time bands, keyed by their cutoff in sim seconds. */
  isoCache: Map<number, Path2D | null>
  isoTime: number
}

export const makeBuffers = (n: number): GeometryBuffers => ({
  field: new Float32Array(n),
  scratch: new Float32Array(n),
  isoCache: new Map(),
  isoTime: 0,
})

/** Most arrival-time bands to draw; the interval widens rather than the count. */
const MAX_ISO_BANDS = 6

const ISO_COLOURS = ['#ffd86e', '#ff9634', '#e44e2c', '#a02e56', '#56285f', '#2c1e3a']

export function buildFireGeometry(
  sim: Sim,
  buf: GeometryBuffers,
  opts: { isochrones: boolean }
): FireGeometry {
  const { cols, rows } = sim.terrain
  const n = cols * rows
  const { field, scratch } = buf

  // --- burn scar -------------------------------------------------------
  // Skipped entirely in isochrone mode, where the bands replace it.
  let scar: Path2D | null = null
  if (!opts.isochrones) {
    for (let i = 0; i < n; i++) field[i] = sim.state[i] === Cell.Unburned ? 0 : 1
    smoothField(field, scratch, cols, rows, 2)
    scar = contourPath(field, cols, rows, 0.5)
  }

  // --- arrival-time bands ----------------------------------------------
  const isochrones: Band[] = []
  if (opts.isochrones && sim.time > 0) {
    // Cells only ever ignite later, so once the clock passes a band's cutoff
    // that band can never change again. Re-tracing every band on every rebuild
    // was costing half the frame rate; only the newest one is still moving.
    if (sim.time < buf.isoTime) buf.isoCache.clear()
    buf.isoTime = sim.time

    // Widen the interval rather than adding bands, so the cost stays bounded.
    const step = 3600 * Math.max(1, Math.ceil(sim.time / 3600 / MAX_ISO_BANDS))
    const count = Math.max(1, Math.min(MAX_ISO_BANDS, Math.ceil(sim.time / step)))

    // Largest (oldest cutoff) first so newer, smaller bands land on top.
    for (let k = count - 1; k >= 0; k--) {
      const cutoff = (k + 1) * step
      const frozen = sim.time > cutoff
      let path = frozen ? buf.isoCache.get(cutoff) : undefined
      if (path === undefined) {
        for (let i = 0; i < n; i++) {
          field[i] = sim.ignitedAt[i] >= 0 && sim.ignitedAt[i] <= cutoff ? 1 : 0
        }
        smoothField(field, scratch, cols, rows, 2)
        path = contourPath(field, cols, rows, 0.5)
        if (frozen) buf.isoCache.set(cutoff, path)
      }
      // Newest ground burns brightest; the oldest core cools to dark.
      if (path) isochrones.push({ path, fill: ISO_COLOURS[count - 1 - k] })
    }
  }

  // --- active fire ------------------------------------------------------
  // A cell stays alight for its whole burnout time — up to an hour in timber —
  // but it only *flames* for the first few minutes of that. Drawing the two the
  // same way gives a kilometre-deep wall of orange; separating them gives the
  // narrow bright front and trailing smoulder that a real fire has.
  const flames: Band[] = []
  if (sim.active.length) {
    for (let i = 0; i < n; i++) field[i] = sim.state[i] === Cell.Burning ? 1 : 0
    smoothField(field, scratch, cols, rows, 2)
    const smouldering = contourPath(field, cols, rows, 0.42)
    if (smouldering) flames.push({ path: smouldering, fill: '#33180f' })

    for (let i = 0; i < n; i++) {
      field[i] =
        sim.state[i] === Cell.Burning && sim.time - sim.ignitedAt[i] < flamingTime(sim.terrain.fuel[i])
          ? 1
          : 0
    }
    // Only one blur pass here: the head flames across many cells but the flanks
    // across barely one, and over-smoothing erases the flanks completely.
    smoothField(field, scratch, cols, rows, 1)
    const front = contourPath(field, cols, rows, 0.3)
    if (front) flames.push({ path: front, fill: '#d8410c' })

    // Hotter cores within the flaming front, scaled to the current peak so the
    // banding stays visible whether the fire creeps in grass or runs in timber.
    const peak = Math.max(1, sim.peakIntensity)
    for (let i = 0; i < n; i++) {
      field[i] =
        sim.state[i] === Cell.Burning && sim.time - sim.ignitedAt[i] < flamingTime(sim.terrain.fuel[i])
          ? sim.intensity[i] / peak
          : 0
    }
    smoothField(field, scratch, cols, rows, 1)
    const mid = contourPath(field, cols, rows, 0.12)
    if (mid) flames.push({ path: mid, fill: '#ff7a1a' })
    const hot = contourPath(field, cols, rows, 0.4)
    if (hot) flames.push({ path: hot, fill: '#ffb840' })
    const core = contourPath(field, cols, rows, 0.72)
    if (core) flames.push({ path: core, fill: '#fff0bd' })
  }

  return {
    scar,
    isochrones,
    flames,
    dozer: treatmentPath(sim, Treatment.Dozer, 0.75),
    retardant: treatmentPath(sim, Treatment.Retardant, 1.05),
  }
}

/** Control lines as overlapping discs, which stay smooth at any zoom. */
function treatmentPath(sim: Sim, kind: number, radius: number): Path2D | null {
  const { cols } = sim.terrain
  const path = new Path2D()
  let any = false
  for (let i = 0; i < sim.treatment.length; i++) {
    if (sim.treatment[i] !== kind) continue
    const c = i % cols
    const r = (i / cols) | 0
    path.moveTo(c + 0.5 + radius, r + 0.5)
    path.arc(c + 0.5, r + 0.5, radius, 0, Math.PI * 2)
    any = true
  }
  return any ? path : null
}
