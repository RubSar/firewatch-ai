/**
 * Predictors for the learned canopy-structure model.
 *
 * ONE definition, used by both the training sampler (`sample.ts`) and the
 * inference provider (`providers/canopy-learned.ts`). That is the whole reason
 * this file exists separately: a model trained on features computed one way and
 * served features computed another way is wrong in a manner that no test
 * catches and no metric reveals — the held-out score stays good and production
 * quietly degrades. Sharing the code makes the skew impossible rather than
 * unlikely.
 *
 * Adding a feature means appending to FEATURE_NAMES and retraining. Inserting
 * one in the middle silently reinterprets every column of an existing model, so
 * `model.json` carries the feature list it was trained with and the provider
 * refuses to load a model whose list disagrees.
 */
import type { Bounds } from '@firewatch/sim/terrain'
import { Fuel } from '@firewatch/sim/fuels'
import { sampleBand, searchScenes, type StacItem } from '../providers/sentinel.ts'

/**
 * Column order. The model is trained against this exact sequence.
 *
 * Chosen to be physically motivated rather than exhaustive: reflectance and its
 * ratios carry greenness and water content, terrain carries the site quality
 * that decides how tall a stand grows, and `nirTexture` is the one feature
 * aimed squarely at structure — a closed even-aged canopy and an open savanna
 * can share a mean NIR and differ sharply in its local variance.
 */
export const FEATURE_NAMES = [
  'blue', 'green', 'red', 'nir', 'swir16', 'swir22',
  'ndvi', 'nbr', 'ndwi',
  'elevation', 'slope', 'northness', 'eastness',
  'nirTexture', 'fuelId', 'absLat',
] as const

export const FEATURE_COUNT = FEATURE_NAMES.length

/** The rasters a feature row is assembled from, all on the same grid. */
export interface FeatureGrids {
  blue: Float32Array
  green: Float32Array
  red: Float32Array
  nir: Float32Array
  swir16: Float32Array
  swir22: Float32Array
  elevation: Float32Array
  fuel: Uint8Array
  cols: number
  rows: number
  cellSize: number
  bounds: Bounds
  /** Which Sentinel-2 scene the reflectances came from, for provenance. */
  sceneId: string
}

const norm = (a: number, b: number) => {
  const s = a + b
  return s === 0 ? 0 : (a - b) / s
}

/**
 * Assembles one feature row into `out` at `offset`.
 *
 * Writes into a caller-owned buffer rather than allocating: inference runs this
 * for every cell of a 400x400 grid, and 160,000 short-lived arrays is a
 * measurable amount of garbage for no benefit.
 */
export function writeFeatureRow(g: FeatureGrids, i: number, out: Float32Array, offset: number) {
  const { cols, rows, elevation, cellSize, nir } = g
  const c = i % cols
  const r = (i / cols) | 0

  // Central differences, clamped at the edge. dz/dx east-positive, dz/dy
  // NORTH-positive — grid rows run southward, hence the sign flip.
  const xw = elevation[r * cols + Math.max(0, c - 1)]
  const xe = elevation[r * cols + Math.min(cols - 1, c + 1)]
  const yn = elevation[Math.max(0, r - 1) * cols + c]
  const ys = elevation[Math.min(rows - 1, r + 1) * cols + c]
  const dzdx = (xe - xw) / (2 * cellSize)
  const dzdy = (yn - ys) / (2 * cellSize)
  const grade = Math.hypot(dzdx, dzdy)
  const slope = (Math.atan(grade) * 180) / Math.PI
  // Aspect as two continuous components. A single 0-360 number is discontinuous
  // at north, and a tree would have to spend splits learning that 359 and 1 are
  // neighbours.
  const aspect = grade < 1e-6 ? 0 : Math.atan2(dzdx, dzdy)
  const northness = grade < 1e-6 ? 0 : Math.cos(aspect)
  const eastness = grade < 1e-6 ? 0 : Math.sin(aspect)

  // Local NIR standard deviation over the 3x3 neighbourhood.
  let sum = 0
  let sumSq = 0
  let n = 0
  for (let dr = -1; dr <= 1; dr++) {
    const rr = r + dr
    if (rr < 0 || rr >= rows) continue
    for (let dc = -1; dc <= 1; dc++) {
      const cc = c + dc
      if (cc < 0 || cc >= cols) continue
      const v = nir[rr * cols + cc]
      if (!Number.isFinite(v)) continue
      sum += v
      sumSq += v * v
      n++
    }
  }
  const mean = n > 0 ? sum / n : 0
  const texture = n > 1 ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0

  const lat = g.bounds.north - ((r + 0.5) / rows) * (g.bounds.north - g.bounds.south)

  out[offset + 0] = g.blue[i]
  out[offset + 1] = g.green[i]
  out[offset + 2] = g.red[i]
  out[offset + 3] = g.nir[i]
  out[offset + 4] = g.swir16[i]
  out[offset + 5] = g.swir22[i]
  out[offset + 6] = norm(g.nir[i], g.red[i])
  out[offset + 7] = norm(g.nir[i], g.swir22[i])
  out[offset + 8] = norm(g.green[i], g.nir[i])
  out[offset + 9] = elevation[i]
  out[offset + 10] = slope
  out[offset + 11] = northness
  out[offset + 12] = eastness
  out[offset + 13] = texture
  out[offset + 14] = g.fuel[i]
  out[offset + 15] = Math.abs(lat)
}

/** True when every reflectance at this cell is usable. */
export function featuresUsable(g: FeatureGrids, i: number): boolean {
  return (
    Number.isFinite(g.blue[i]) && Number.isFinite(g.green[i]) && Number.isFinite(g.red[i]) &&
    Number.isFinite(g.nir[i]) && Number.isFinite(g.swir16[i]) && Number.isFinite(g.swir22[i]) &&
    g.nir[i] > 0 && g.red[i] > 0
  )
}

/**
 * Cells where canopy structure is a meaningful question at all.
 *
 * By id, not by name. A first version matched on `f.name.includes('Shrub')`,
 * which misses `'Chaparral / shrub'` on the lowercase s — it happened to work
 * via the 'Chaparral' branch, which is precisely the kind of accident that
 * breaks when someone renames a fuel.
 */
export function isWoody(fuelId: number): boolean {
  return fuelId === Fuel.Timber || fuelId === Fuel.Shrub
}

const BANDS = ['blue', 'green', 'red', 'nir', 'swir16', 'swir22'] as const

/**
 * Fetches the six reflectance bands for a grid from the least-cloudy recent
 * Sentinel-2 scene.
 *
 * Deliberately NOT deadline-guarded the way `sentinelLandCover` is. That guard
 * exists because incident creation cannot block on a cold COG read; here a slow
 * read is simply a slow read, and returning a partial feature set would poison
 * the model rather than degrade it.
 */
export async function fetchReflectance(
  bounds: Bounds,
  cols: number,
  rows: number,
  timeoutMs: number
): Promise<{ bands: Record<string, Float32Array>; item: StacItem } | null> {
  const scenes = await searchScenes(bounds, timeoutMs)
  for (const item of scenes) {
    const got = await Promise.all(BANDS.map((b) => sampleBand(item, b, bounds, cols, rows)))
    if (got.every((g): g is Float32Array => g !== null)) {
      const bands: Record<string, Float32Array> = {}
      BANDS.forEach((b, k) => { bands[b] = got[k]! })
      return { bands, item }
    }
  }
  return null
}