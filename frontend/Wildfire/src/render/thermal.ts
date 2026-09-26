/**
 * Infrared view: the scene as a thermal camera would render it.
 *
 * This is how crews actually look at a fire — IR sees through smoke and answers
 * "where is it hot right now", which visible-band imagery cannot. It also puts
 * the model on the same axis as the one observation that could falsify it:
 * FIRMS and drone IR both report brightness temperature, so a simulated
 * temperature field can be compared against measured kelvin directly
 * (ARCHITECTURE.md §6, where maxTemp is a validation target rather than a driver).
 *
 * A raster rather than contours, because temperature is a continuous field and
 * banding it into paths would invent edges that are not there.
 */
import { FUELS, flamingTime } from '@firewatch/sim/fuels'
import { Cell, type Sim } from '@firewatch/sim/model'
import { smoothField } from './contour.ts'

/** Kelvin above ambient a fully developed flame reaches. After §4's T_f map. */
const DELTA_T_MAX = 1050
/**
 * Byram intensity at which apparent temperature saturates, kW/m. Flame
 * temperature is buffered by radiative loss and entrainment — it does not climb
 * indefinitely with intensity — so the map saturates rather than scaling.
 */
const I_REF = 2500
/** Time constant for burnt ground cooling back toward ambient, seconds. */
const COOL_TAU = 1800
/** Smouldering runs far cooler than flame but stays well above ambient. */
const SMOULDER_FRACTION = 0.34

export interface ThermalRange {
  /** Kelvin at the bottom of the palette. */
  min: number
  /** Kelvin at the top. */
  max: number
}

/**
 * Ironbow-style ramp: black through purple and red to white.
 *
 * Perceptually ordered so hotter always reads as brighter — the property that
 * makes a thermal image legible at a glance, and the reason a rainbow ramp
 * would be actively misleading here.
 */
const STOPS: [number, number, number][] = [
  [8, 8, 20],      // ambient
  [46, 20, 84],    // barely warm
  [122, 24, 104],  // warm
  [196, 48, 62],   // hot
  [240, 122, 20],  // flaming
  [252, 206, 88],  // core
  [255, 255, 240], // saturated
]

function ramp(t: number): [number, number, number] {
  const x = Math.min(0.9999, Math.max(0, t)) * (STOPS.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = STOPS[i]
  const b = STOPS[i + 1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/** Apparent temperature of one cell, kelvin. */
export function cellTemperature(sim: Sim, i: number, ambientK: number): number {
  const state = sim.state[i]
  if (state === Cell.Unburned) return ambientK

  const since = sim.time - sim.ignitedAt[i]
  if (state === Cell.Burning) {
    const rise = DELTA_T_MAX * Math.tanh(sim.intensity[i] / I_REF)
    const flaming = since < flamingTime(sim.terrain.fuel[i])
    return ambientK + rise * (flaming ? 1 : SMOULDER_FRACTION)
  }

  // Burnt: still radiating, cooling exponentially toward ambient. This is the
  // part visible imagery cannot show at all and IR makes obvious.
  const peak = ambientK + DELTA_T_MAX * SMOULDER_FRACTION
  return ambientK + (peak - ambientK) * Math.exp(-Math.max(0, since) / COOL_TAU)
}

/** Scratch buffers for the temperature field, reused between frames. */
let field: Float32Array | null = null
let scratch: Float32Array | null = null

/**
 * Paints a grid-resolution thermal raster. Returns the range actually present,
 * so the legend can label real numbers instead of a fixed guess.
 *
 * The field is blurred before colouring. That is not a cosmetic smoothing: a
 * thermal camera has a point-spread function, so a real IR frame never shows
 * single-pixel speckle, and an unblurred per-cell raster reads as noise rather
 * than as a fire front. One pass only — the flanks are barely a cell wide and
 * over-smoothing erases them, the same constraint the flame contours have.
 */
export function paintThermal(
  img: ImageData,
  sim: Sim,
  opts: { ambientC: number }
): ThermalRange {
  const { cols, rows, fuel } = sim.terrain
  const n = cols * rows
  const data = img.data
  const ambientK = opts.ambientC + 273.15
  if (!field || field.length !== n) {
    field = new Float32Array(n)
    scratch = new Float32Array(n)
  }
  // Fix the top of the scale rather than tracking the frame's own maximum: a
  // palette that rescales every frame makes the fire look constant while the
  // numbers change, which is exactly backwards.
  const maxK = ambientK + DELTA_T_MAX
  const span = Math.max(1, maxK - ambientK)

  for (let i = 0; i < n; i++) field[i] = cellTemperature(sim, i, ambientK)
  smoothField(field, scratch!, cols, rows, 1)

  for (let i = 0; i < n; i++) {
    const o = i * 4
    const t = (field[i] - ambientK) / span

    if (t < 0.012) {
      // Cold ground: let the basemap show through, faintly cooled. Water reads
      // colder still, which is how it looks in a real IR frame.
      const water = FUELS[fuel[i]].load <= 0 && fuel[i] === 0
      data[o] = water ? 4 : 10
      data[o + 1] = water ? 10 : 12
      data[o + 2] = water ? 34 : 24
      data[o + 3] = water ? 150 : 120
      continue
    }
    const [r, g, b] = ramp(t)
    data[o] = r
    data[o + 1] = g
    data[o + 2] = b
    // Hot pixels fully opaque; merely warm ground stays semi-transparent so the
    // terrain underneath is still readable.
    data[o + 3] = Math.round(150 + 105 * Math.min(1, t * 1.6))
  }
  return { min: ambientK, max: maxK }
}

/** Same ramp as the raster, as a CSS colour — for markers and swatches. */
export function thermalColour(t: number): string {
  const [r, g, b] = ramp(t)
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`
}

/** Palette swatch for the legend, as CSS stops. */
export const THERMAL_CSS_GRADIENT = STOPS.map(
  (c, i) => `rgb(${c.join(',')}) ${((i / (STOPS.length - 1)) * 100).toFixed(0)}%`
).join(', ')

export const kToC = (k: number) => k - 273.15
