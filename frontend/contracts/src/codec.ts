/**
 * Binary codec for the state channel.
 *
 * Lives in contracts because both sides must agree byte for byte; a drift here
 * is silent and renders as a corrupted fire rather than an error. All little-
 * endian, all via DataView, no alignment assumptions.
 *
 * Only cells that changed are sent. Fire is monotone — a cell goes unburned →
 * burning → burnt and never back — so the changed set stays a thin band around
 * the front rather than growing with the burn scar.
 */
import type { Stats } from '@firewatch/sim'
import type { StateFrame } from './wire.ts'

export const FRAME_TERRAIN = 1
export const FRAME_STATE = 2

/** Bytes per changed cell: u32 index + u8 state + f32 ignitedAt. */
const CHANGED_STRIDE = 9
/** Bytes per changed treatment cell: u32 index + u8 kind. */
const TREATMENT_STRIDE = 5
/**
 * Bytes per flaming cell: u32 index + u8 intensity quantised against the frame
 * peak. Only cells inside their flaming window are sent, because that is the
 * only place the renderer reads intensity — sending it for every burning cell
 * would be ~5x the traffic for bands that are never drawn.
 */
const FLAMING_STRIDE = 5
const STATE_HEADER = 1 + 1 + 8 + 4 + 4 + 4 + 4 + 44

// --- terrain (sent once per incident) -----------------------------------

export interface TerrainFrame {
  cols: number
  rows: number
  cellSize: number
  bounds: { north: number; south: number; east: number; west: number }
  minElev: number
  maxElev: number
  elevation: Float32Array
  fuel: Uint8Array
}

export function encodeTerrain(t: TerrainFrame): ArrayBuffer {
  const n = t.cols * t.rows
  const header = 1 + 2 + 2 + 4 + 8 * 4 + 4 + 4
  const buf = new ArrayBuffer(header + n * 4 + n)
  const v = new DataView(buf)
  let o = 0
  v.setUint8(o, FRAME_TERRAIN); o += 1
  v.setUint16(o, t.cols, true); o += 2
  v.setUint16(o, t.rows, true); o += 2
  v.setFloat32(o, t.cellSize, true); o += 4
  for (const k of ['north', 'south', 'east', 'west'] as const) {
    v.setFloat64(o, t.bounds[k], true); o += 8
  }
  v.setFloat32(o, t.minElev, true); o += 4
  v.setFloat32(o, t.maxElev, true); o += 4
  new Uint8Array(buf, o, n * 4).set(new Uint8Array(t.elevation.buffer, t.elevation.byteOffset, n * 4))
  o += n * 4
  new Uint8Array(buf, o, n).set(t.fuel)
  return buf
}

export function decodeTerrain(buf: ArrayBuffer): TerrainFrame {
  const v = new DataView(buf)
  let o = 0
  const type = v.getUint8(o); o += 1
  if (type !== FRAME_TERRAIN) throw new Error(`expected terrain frame, got ${type}`)
  const cols = v.getUint16(o, true); o += 2
  const rows = v.getUint16(o, true); o += 2
  const cellSize = v.getFloat32(o, true); o += 4
  const bounds = {} as TerrainFrame['bounds']
  for (const k of ['north', 'south', 'east', 'west'] as const) {
    bounds[k] = v.getFloat64(o, true); o += 8
  }
  const minElev = v.getFloat32(o, true); o += 4
  const maxElev = v.getFloat32(o, true); o += 4
  const n = cols * rows
  // Copy rather than view: the socket buffer is not guaranteed 4-byte aligned.
  const elevation = new Float32Array(n)
  new Uint8Array(elevation.buffer).set(new Uint8Array(buf, o, n * 4))
  o += n * 4
  const fuel = new Uint8Array(n)
  fuel.set(new Uint8Array(buf, o, n))
  return { cols, rows, cellSize, bounds, minElev, maxElev, elevation, fuel }
}

// --- state (sent per tick) ----------------------------------------------

export interface FlamingCell {
  index: number
  /** 0..1 of the frame's peak intensity. */
  intensity: number
}

export interface StateFrameInput {
  time: number
  revision: number
  activeCells: number
  peakIntensity: number
  peakRos: number
  stats: Stats
  full: boolean
  changedIndices: Uint32Array
  changedCount: number
  state: Uint8Array
  ignitedAt: Float32Array
  treatmentIndices: Uint32Array
  treatmentCount: number
  treatment: Uint8Array
  flamingIndices: Uint32Array
  flamingCount: number
  intensity: Float32Array
}

export function encodeState(s: StateFrameInput): ArrayBuffer {
  const size =
    STATE_HEADER +
    4 + s.changedCount * CHANGED_STRIDE +
    4 + s.treatmentCount * TREATMENT_STRIDE +
    4 + s.flamingCount * FLAMING_STRIDE
  const buf = new ArrayBuffer(size)
  const v = new DataView(buf)
  let o = 0
  v.setUint8(o, FRAME_STATE); o += 1
  v.setUint8(o, s.full ? 1 : 0); o += 1
  v.setFloat64(o, s.time, true); o += 8
  v.setUint32(o, s.revision, true); o += 4
  v.setUint32(o, s.activeCells, true); o += 4
  v.setFloat32(o, s.peakIntensity, true); o += 4
  v.setFloat32(o, s.peakRos, true); o += 4

  const st = s.stats
  v.setUint32(o, st.burnedCells, true); o += 4
  v.setUint32(o, st.activeCells, true); o += 4
  v.setFloat32(o, st.area, true); o += 4
  v.setFloat32(o, st.perimeter, true); o += 4
  v.setFloat32(o, st.containment, true); o += 4
  v.setFloat32(o, st.maxRos, true); o += 4
  v.setFloat32(o, st.maxIntensity, true); o += 4
  v.setFloat32(o, st.flameLength, true); o += 4
  v.setUint32(o, st.wuiCells, true); o += 4
  v.setUint32(o, st.structuresLost, true); o += 4
  v.setUint32(o, st.spotFires, true); o += 4

  v.setUint32(o, s.changedCount, true); o += 4
  for (let k = 0; k < s.changedCount; k++) {
    const i = s.changedIndices[k]
    v.setUint32(o, i, true); o += 4
    v.setUint8(o, s.state[i]); o += 1
    v.setFloat32(o, s.ignitedAt[i], true); o += 4
  }
  v.setUint32(o, s.treatmentCount, true); o += 4
  for (let k = 0; k < s.treatmentCount; k++) {
    const i = s.treatmentIndices[k]
    v.setUint32(o, i, true); o += 4
    v.setUint8(o, s.treatment[i]); o += 1
  }

  // Quantise against the frame's own peak, which is what the renderer scales
  // by too — so the bands look identical to a locally stepped sim.
  const peak = Math.max(1, s.peakIntensity)
  v.setUint32(o, s.flamingCount, true); o += 4
  for (let k = 0; k < s.flamingCount; k++) {
    const i = s.flamingIndices[k]
    v.setUint32(o, i, true); o += 4
    v.setUint8(o, Math.max(0, Math.min(255, Math.round((s.intensity[i] / peak) * 255)))); o += 1
  }
  return buf
}

export function decodeState(buf: ArrayBuffer): StateFrame {
  const v = new DataView(buf)
  let o = 0
  const type = v.getUint8(o); o += 1
  if (type !== FRAME_STATE) throw new Error(`expected state frame, got ${type}`)
  const full = v.getUint8(o) === 1; o += 1
  const time = v.getFloat64(o, true); o += 8
  const revision = v.getUint32(o, true); o += 4
  const activeCells = v.getUint32(o, true); o += 4
  const peakIntensity = v.getFloat32(o, true); o += 4
  const peakRos = v.getFloat32(o, true); o += 4

  const stats: Stats = {
    burnedCells: v.getUint32(o, true),
    activeCells: v.getUint32(o + 4, true),
    area: v.getFloat32(o + 8, true),
    perimeter: v.getFloat32(o + 12, true),
    containment: v.getFloat32(o + 16, true),
    maxRos: v.getFloat32(o + 20, true),
    maxIntensity: v.getFloat32(o + 24, true),
    flameLength: v.getFloat32(o + 28, true),
    wuiCells: v.getUint32(o + 32, true),
    structuresLost: v.getUint32(o + 36, true),
    spotFires: v.getUint32(o + 40, true),
  }
  o += 44

  const changedCount = v.getUint32(o, true); o += 4
  const changed = new Array<{ index: number; state: number; ignitedAt: number }>(changedCount)
  for (let k = 0; k < changedCount; k++) {
    const index = v.getUint32(o, true); o += 4
    const state = v.getUint8(o); o += 1
    const ignitedAt = v.getFloat32(o, true); o += 4
    changed[k] = { index, state, ignitedAt }
  }
  const treatmentCount = v.getUint32(o, true); o += 4
  const treatmentChanged = new Array<{ index: number; kind: number }>(treatmentCount)
  for (let k = 0; k < treatmentCount; k++) {
    const index = v.getUint32(o, true); o += 4
    const kind = v.getUint8(o); o += 1
    treatmentChanged[k] = { index, kind }
  }

  const flamingCount = v.getUint32(o, true); o += 4
  const flaming = new Array<FlamingCell>(flamingCount)
  for (let k = 0; k < flamingCount; k++) {
    const index = v.getUint32(o, true); o += 4
    flaming[k] = { index, intensity: v.getUint8(o) / 255 }
    o += 1
  }
  return {
    time, revision, activeCells, peakIntensity, peakRos, stats,
    changed, treatmentChanged, flaming, full,
  }
}

/** Frame discriminator without decoding the body. */
export const frameType = (buf: ArrayBuffer) => new DataView(buf).getUint8(0)
