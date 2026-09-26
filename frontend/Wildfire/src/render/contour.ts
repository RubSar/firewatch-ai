/**
 * Smooth vector outlines of the fire, in grid coordinates.
 *
 * The fire is drawn from paths rather than from scaled-up cells: a raster
 * overlay turns a 38 m cell into a visible square the moment the user zooms in,
 * while a path is resolution-independent and stays crisp at any zoom.
 *
 * Marching squares comes from d3-contour, which handles the ambiguous saddle
 * cases and winds holes correctly. What it does not do is round anything off,
 * so we blur the field first and run a quadratic through segment midpoints
 * after — together those turn a staircase of cells into an organic perimeter.
 */
import { contours } from 'd3-contour'

/**
 * Separable box blur, in place via a scratch buffer.
 */
export function smoothField(
  f: Float32Array, scratch: Float32Array, cols: number, rows: number, passes = 2
) {
  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < rows; r++) {
      const o = r * cols
      for (let c = 0; c < cols; c++) {
        scratch[o + c] =
          (f[o + (c > 0 ? c - 1 : 0)] + f[o + c] + f[o + (c < cols - 1 ? c + 1 : cols - 1)]) / 3
      }
    }
    for (let r = 0; r < rows; r++) {
      const o = r * cols
      const up = (r > 0 ? r - 1 : 0) * cols
      const dn = (r < rows - 1 ? r + 1 : rows - 1) * cols
      for (let c = 0; c < cols; c++) {
        f[o + c] = (scratch[up + c] + scratch[o + c] + scratch[dn + c]) / 3
      }
    }
  }
}

/**
 * Contours `field` at `threshold` and returns a fillable path in grid
 * coordinates, with corners rounded.
 */
export function contourPath(
  field: Float32Array, cols: number, rows: number, threshold: number
): Path2D | null {
  // d3-contour only indexes and reads .length, so the typed array goes straight
  // in. Converting to a plain array first allocates the whole grid again on
  // every call, which at 20 Hz costs more than the contour tracing itself.
  const [multi] = contours()
    .size([cols, rows])
    .thresholds([threshold])(field as unknown as number[])
  if (!multi || !multi.coordinates.length) return null

  const path = new Path2D()
  let drew = false
  for (const polygon of multi.coordinates) {
    for (const ring of polygon) {
      if (ring.length < 4) continue
      addSmoothRing(path, ring)
      drew = true
    }
  }
  return drew ? path : null
}

/** Quadratic through segment midpoints: rounds the 90-degree cell corners off. */
function addSmoothRing(path: Path2D, ring: [number, number][] | number[][]) {
  // d3 repeats the first point at the end; drop it so the ring closes cleanly.
  const n = ring.length - 1
  if (n < 3) return
  const mid = (i: number, j: number) => [(ring[i][0] + ring[j][0]) / 2, (ring[i][1] + ring[j][1]) / 2]

  const start = mid(n - 1, 0)
  path.moveTo(start[0], start[1])
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const m = mid(i, j)
    path.quadraticCurveTo(ring[i][0], ring[i][1], m[0], m[1])
  }
  path.closePath()
}
