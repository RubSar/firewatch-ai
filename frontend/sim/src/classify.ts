/**
 * Visible-band fuel classification.
 *
 * Pure: takes a raster view and returns a fuel id, with no DOM, no fetch and no
 * canvas — so the browser (canvas-backed) and the server (PNG/JPEG-decoder
 * backed) classify identically rather than drifting apart. Thresholds were tuned
 * against measured band statistics for the Armenian scenarios via calibrate.html.
 *
 * MOCK BOUNDARY: this is a proxy for a fuel-model raster, not a measurement.
 * ARCHITECTURE.md §9 replaces it with a WorldCover crosswalk behind FuelProvider.
 */
import { Fuel } from './fuels.ts'

/** Minimal structural view of an RGBA raster — a canvas or a decoded tile mosaic. */
export interface RasterView {
  px: Uint8ClampedArray | Uint8Array
  w: number
  h: number
}

export interface CellBands {
  /** Green-red vegetation index, a visible-band stand-in for NDVI. */
  grvi: number
  bright: number
  /** Local standard deviation of brightness: development has hard edges. */
  texture: number
  blueness: number
  /** Blue minus green. Water is the only cover where this goes positive. */
  bg: number
}

/** Sentinel: imagery is missing here, so the caller should keep its fallback. */
export const NO_DATA = -1

/** The band statistics the classifier keys on, averaged over one cell's footprint. */
export function cellBands(m: RasterView, px: number, py: number, half: number): CellBands {
  let r = 0, g = 0, b = 0, sum = 0, sumSq = 0, n = 0
  const x0 = Math.max(0, Math.round(px) - half)
  const x1 = Math.min(m.w - 1, Math.round(px) + half)
  const y0 = Math.max(0, Math.round(py) - half)
  const y1 = Math.min(m.h - 1, Math.round(py) + half)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = (y * m.w + x) * 4
      const pr = m.px[o], pg = m.px[o + 1], pb = m.px[o + 2]
      r += pr; g += pg; b += pb
      const lum = (pr + pg + pb) / 3
      sum += lum; sumSq += lum * lum; n++
    }
  }
  if (!n) return { grvi: 0, bright: 0, texture: 0, blueness: 0, bg: 0 }
  r /= n; g /= n; b /= n
  const bright = sum / n
  return {
    grvi: (g - r) / (g + r + 1),
    bright,
    texture: Math.sqrt(Math.max(0, sumSq / n - bright * bright)),
    blueness: b - (r + g) / 2,
    bg: b - g,
  }
}

/**
 * Classifies one cell of satellite imagery into a fuel model.
 *
 * Visible-band only, so this is a proxy, not a measurement: greenness stands in
 * for NDVI, and local texture separates the hard geometric edges of development
 * from the smooth tone of bare ground.
 */
export function classifyFuel(
  m: RasterView, px: number, py: number, half: number, elev: number, slopeDeg: number
): number {
  const { grvi, bright, texture, blueness } = cellBands(m, px, py, half)

  // A hole in the imagery mosaic reads as pure black; say so rather than
  // inventing a fuel for it.
  if (bright < 6) return NO_DATA

  // Water is the only cover here where blue is not the weakest band: across all
  // regions vegetated ground never gets above about -12, while open water runs
  // positive. Greenness is useless for this — Sevan is turquoise, so green sits
  // far above red and a vegetation index calls the lake dense forest. Texture
  // rejects the other bluish-grey surface, concrete.
  if (elev <= 0) return Fuel.Water
  if (blueness > -6 && texture < 14) return Fuel.Water

  // Development: hard geometric edges give a local variance neither canopy nor
  // bare ground produces.
  if (texture > 24 && bright > 80 && grvi < 0.1) return Fuel.Urban

  // Closed canopy is green *and* dark; open juniper or scrub is green and
  // bright. Brightness is what separates Dilijan's forest from Khosrov's steppe.
  // Dark green on flat ground is irrigated cropland or orchard, not forest —
  // Armenia's woodland is on the slopes, and the distinction matters because
  // timber carries four times the fuel load of a field.
  if (grvi > 0.115) {
    if (bright >= 72) return Fuel.Shrub
    return slopeDeg > 4 ? Fuel.Timber : Fuel.Agriculture
  }
  if (grvi > 0.02) return bright < 105 ? Fuel.Shrub : Fuel.Agriculture
  if (bright > 140 && Math.abs(grvi) < 0.03) return Fuel.Barren
  return Fuel.Grass
}
