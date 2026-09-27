import { FUELS } from '@firewatch/sim/fuels'
import { type Sim } from '@firewatch/sim/model'

export type BaseLayer = 'fuel' | 'elevation' | 'tiles'

export interface PaintOptions {
  base: BaseLayer
  /** Tint unburnt ground by fuel model when sitting over real map tiles. */
  fuelOverlay: boolean
  /** Draw 100 m contour lines over the synthetic bases. */
  contours: boolean
}

/** True when the base layer has nothing to draw and the raster can be skipped. */
export const baseIsEmpty = (o: PaintOptions) => o.base === 'tiles' && !o.fuelOverlay

/** Hypsometric ramp: valley green -> tan -> rock -> snow. */
const ELEV_RAMP: [number, number, number][] = [
  [56, 96, 64], [104, 130, 72], [162, 152, 92], [176, 130, 84], [150, 122, 110], [226, 226, 230],
]

function rampAt(t: number): [number, number, number] {
  const x = Math.min(0.9999, Math.max(0, t)) * (ELEV_RAMP.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = ELEV_RAMP[i]
  const b = ELEV_RAMP[i + 1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/** Flame colour ramp keyed on Byram fireline intensity (kW/m). */
export function paintGrid(img: ImageData, sim: Sim, opts: PaintOptions) {
  const { terrain } = sim
  const { cols, rows, elevation, shade, fuel, maxElev } = terrain
  const data = img.data
  const overTiles = opts.base === 'tiles'
  const elevSpan = Math.max(1, maxElev)

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const o = i * 4
      const sh = 0.42 + 0.9 * shade[i]
      let cr: number
      let cg: number
      let cb: number
      let alpha = 255

      if (opts.base === 'elevation') {
        const water = elevation[i] <= 0
        const col = rampAt(water ? 0 : elevation[i] / elevSpan)
        cr = (water ? 44 : col[0]) * (water ? 1 : sh)
        cg = (water ? 84 : col[1]) * (water ? 1 : sh)
        cb = (water ? 122 : col[2]) * (water ? 1 : sh)
      } else {
        const fm = FUELS[fuel[i]]
        const water = fuel[i] === 0
        cr = fm.color[0] * (water ? 1 : sh)
        cg = fm.color[1] * (water ? 1 : sh)
        cb = fm.color[2] * (water ? 1 : sh)
        if (overTiles) alpha = water || !opts.fuelOverlay ? 0 : 115
      }

      // Contour lines read as topography even on the flat fuel layer.
      if (opts.contours && !overTiles && elevation[i] > 0) {
        const e = elevation[i]
        const right = c < cols - 1 ? elevation[i + 1] : e
        const down = r < rows - 1 ? elevation[i + cols] : e
        if (Math.floor(e / 100) !== Math.floor(right / 100) || Math.floor(e / 100) !== Math.floor(down / 100)) {
          cr *= 0.74
          cg *= 0.74
          cb *= 0.74
        }
      }

      data[o] = cr
      data[o + 1] = cg
      data[o + 2] = cb
      data[o + 3] = alpha
    }
  }
}
