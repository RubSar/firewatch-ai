/**
 * Real terrain and land cover, pulled from open raster tile services at runtime.
 *
 *  - Elevation: AWS "Terrarium" terrain tiles (Mapzen/Nextzen heritage, public,
 *    no key). Height is RGB-encoded: (R*256 + G + B/256) - 32768 metres.
 *  - Land cover: Sentinel-2 cloudless (EOX, CC-BY-4.0), classified into our fuel models from
 *    visible-band greenness, brightness and local texture.
 *
 * Both services send `Access-Control-Allow-Origin: *`, so the tiles can be read
 * back out of a canvas. If anything fails we keep the procedural terrain, which
 * means the demo still runs with no network at all.
 *
 * This is the layer a production build would replace with a proper 3DEP DEM and
 * a LANDFIRE FBFM40 fuel raster; the classification below is a visible-band
 * stand-in for real fuel-model data, not a substitute for it.
 */
import { Fuel } from '@firewatch/sim/fuels'
import { cellBands, classifyFuel, NO_DATA, type CellBands } from '@firewatch/sim/classify'
import { computeShade, localSlope, type Bounds, type Terrain } from '@firewatch/sim/terrain'

const DEM_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`
// Sentinel-2 cloudless (EOX, CC-BY-4.0). Replaced Esri World Imagery, whose
// terms restrict use without a licence. Axis order is /{z}/{row}/{col}, as Esri's
// was. Attribution is carried by the Leaflet control in MapView.
const IMAGERY_URL = (z: number, x: number, y: number) =>
  `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`

const TILE = 256
const MAX_TILES = 140

const lngToTileX = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z
const latToTileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}

/** Ground resolution of one tile pixel, metres. */
const metresPerPixel = (lat: number, z: number) =>
  (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z

/** Pick the zoom whose pixels land closest to `targetM` on the ground. */
function zoomFor(lat: number, targetM: number, min: number, max: number) {
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / targetM)
  return Math.max(min, Math.min(max, Math.round(z)))
}

function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`tile failed: ${url}`))
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    img.src = url
  })
}

interface Mosaic {
  px: Uint8ClampedArray
  w: number
  h: number
  x0: number
  y0: number
  z: number
  /** Fraction of tiles that actually loaded. */
  coverage: number
}

/** Stitches every tile covering `bounds` into one readable pixel buffer. */
async function fetchMosaic(
  bounds: Bounds,
  z: number,
  urlFor: (z: number, x: number, y: number) => string,
  signal?: AbortSignal
): Promise<Mosaic | null> {
  const x0 = Math.floor(lngToTileX(bounds.west, z))
  const x1 = Math.floor(lngToTileX(bounds.east, z))
  const y0 = Math.floor(latToTileY(bounds.north, z))
  const y1 = Math.floor(latToTileY(bounds.south, z))
  const nx = x1 - x0 + 1
  const ny = y1 - y0 + 1
  if (nx * ny > MAX_TILES) return null

  const canvas = document.createElement('canvas')
  canvas.width = nx * TILE
  canvas.height = ny * TILE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  const jobs: Promise<void>[] = []
  let ok = 0
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      jobs.push(
        loadImage(urlFor(z, x, y), signal)
          .then((img) => {
            ctx.drawImage(img, (x - x0) * TILE, (y - y0) * TILE, TILE, TILE)
            ok++
          })
          // A hole in the mosaic is survivable; a total miss is not.
          .catch(() => undefined)
      )
    }
  }
  await Promise.all(jobs)
  if (signal?.aborted) return null
  const coverage = ok / (nx * ny)
  if (coverage < 0.6) return null

  return {
    px: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    w: canvas.width,
    h: canvas.height,
    x0,
    y0,
    z,
    coverage,
  }
}

/** Mosaic pixel coordinates for a geographic point. */
const toPixel = (m: Mosaic, lat: number, lng: number) => ({
  x: (lngToTileX(lng, m.z) - m.x0) * TILE,
  y: (latToTileY(lat, m.z) - m.y0) * TILE,
})

function demHeight(m: Mosaic, x: number, y: number): number {
  const xi = Math.max(0, Math.min(m.w - 1, Math.round(x)))
  const yi = Math.max(0, Math.min(m.h - 1, Math.round(y)))
  const o = (yi * m.w + xi) * 4
  // A tile that failed to load leaves transparent pixels, which would decode to
  // -32768 m and wreck both the hillshade and the elevation ramp.
  if (m.px[o + 3] < 250) return NaN
  const e = m.px[o] * 256 + m.px[o + 1] + m.px[o + 2] / 256 - 32768
  // Deep bathymetry tells us nothing here; everything below sea level is water.
  return e < -50 ? -50 : e
}

/** Bilinear so a 30 m DEM resampled to 70 m cells does not stair-step. */
function demBilinear(m: Mosaic, x: number, y: number): number {
  const fx = Math.floor(x)
  const fy = Math.floor(y)
  const tx = x - fx
  const ty = y - fy
  const a = demHeight(m, fx, fy)
  const b = demHeight(m, fx + 1, fy)
  const c = demHeight(m, fx, fy + 1)
  const d = demHeight(m, fx + 1, fy + 1)
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) return NaN
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty
}

export interface LoadResult {
  terrain: Terrain
  /** Human-readable note for the UI. */
  note: string
}

/**
 * Replaces a procedural terrain's elevation and fuel with real data.
 * Resolves with the original terrain untouched if the network is unavailable.
 */
export async function loadRealTerrain(base: Terrain, signal?: AbortSignal): Promise<LoadResult> {
  const { bounds, cols, rows, cellSize } = base
  const midLat = (bounds.north + bounds.south) / 2

  const demZoom = zoomFor(midLat, cellSize / 2, 10, 14)
  const imgZoom = zoomFor(midLat, cellSize / 3, 11, 15)

  const [dem, imagery] = await Promise.all([
    fetchMosaic(bounds, demZoom, DEM_URL, signal).catch(() => null),
    fetchMosaic(bounds, imgZoom, IMAGERY_URL, signal).catch(() => null),
  ])

  if (signal?.aborted || !dem) {
    return { terrain: base, note: 'Offline — procedural terrain' }
  }

  const elevation = new Float32Array(cols * rows)
  const fuel = new Uint8Array(cols * rows)
  const shade = new Float32Array(cols * rows)
  let minElev = Infinity
  let maxElev = -Infinity

  // --- elevation ---------------------------------------------------------
  for (let r = 0; r < rows; r++) {
    const lat = bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south)
    for (let c = 0; c < cols; c++) {
      const lng = bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west)
      const p = toPixel(dem, lat, lng)
      elevation[r * cols + c] = demBilinear(dem, p.x, p.y)
    }
  }
  fillHoles(elevation, cols, rows)
  for (let i = 0; i < elevation.length; i++) {
    if (elevation[i] < minElev) minElev = elevation[i]
    if (elevation[i] > maxElev) maxElev = elevation[i]
  }
  computeShade(elevation, shade, cols, rows, cellSize)

  // --- land cover --------------------------------------------------------
  if (imagery) {
    const half = Math.max(1, Math.round(cellSize / metresPerPixel(midLat, imagery.z) / 2))
    for (let r = 0; r < rows; r++) {
      const lat = bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south)
      for (let c = 0; c < cols; c++) {
        const lng = bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west)
        const p = toPixel(imagery, lat, lng)
        const i = r * cols + c
        const slopeDeg = (localSlope(elevation, cols, rows, c, r, cellSize) * 180) / Math.PI
        const f = classifyFuel(imagery, p.x, p.y, half, elevation[i], slopeDeg)
        // Where the imagery has a hole, keep the topography-driven guess.
        fuel[i] = f === NO_DATA ? base.fuel[i] : f
      }
    }
  } else {
    // DEM but no imagery: fall back to the topography-driven vegetation rules.
    fuel.set(base.fuel)
    for (let i = 0; i < fuel.length; i++) if (elevation[i] <= 0) fuel[i] = Fuel.Water
  }

  const note = imagery
    ? `Live DEM + imagery · z${dem.z}/z${imagery.z}`
    : `Live DEM · z${dem.z} (imagery unavailable)`

  return {
    terrain: { ...base, elevation, fuel, shade, minElev, maxElev, source: 'live' },
    note,
  }
}

/** Grows valid elevations into any gaps left by a tile that failed to load. */
function fillHoles(elev: Float32Array, cols: number, rows: number) {
  for (let pass = 0; pass < 12; pass++) {
    let remaining = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        if (!Number.isNaN(elev[i])) continue
        let sum = 0
        let n = 0
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr
            const nc = c + dc
            if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue
            const v = elev[nr * cols + nc]
            if (!Number.isNaN(v)) {
              sum += v
              n++
            }
          }
        }
        if (n) elev[i] = sum / n
        else remaining++
      }
    }
    if (!remaining) break
  }
  for (let i = 0; i < elev.length; i++) if (Number.isNaN(elev[i])) elev[i] = -50
}

/**
 * Per-cell average of the satellite imagery, for tuning the classifier against
 * what the sensor actually saw. Returns RGBA at grid resolution.
 */
export async function debugBands(base: Terrain, signal?: AbortSignal): Promise<CellBands[] | null> {
  const { bounds, cols, rows, cellSize } = base
  const midLat = (bounds.north + bounds.south) / 2
  const m = await fetchMosaic(bounds, zoomFor(midLat, cellSize / 3, 11, 15), IMAGERY_URL, signal)
  if (!m) return null
  const half = Math.max(1, Math.round(cellSize / metresPerPixel(midLat, m.z) / 2))
  const out: CellBands[] = []
  for (let r = 0; r < rows; r++) {
    const lat = bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south)
    for (let c = 0; c < cols; c++) {
      const lng = bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west)
      const p = toPixel(m, lat, lng)
      out.push(cellBands(m, p.x, p.y, half))
    }
  }
  return out
}

export async function debugImagery(base: Terrain, signal?: AbortSignal): Promise<Uint8ClampedArray | null> {
  const { bounds, cols, rows, cellSize } = base
  const midLat = (bounds.north + bounds.south) / 2
  const m = await fetchMosaic(bounds, zoomFor(midLat, cellSize / 3, 11, 15), IMAGERY_URL, signal)
  if (!m) return null
  const half = Math.max(1, Math.round(cellSize / metresPerPixel(midLat, m.z) / 2))
  const out = new Uint8ClampedArray(cols * rows * 4)
  for (let r = 0; r < rows; r++) {
    const lat = bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south)
    for (let c = 0; c < cols; c++) {
      const lng = bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west)
      const p = toPixel(m, lat, lng)
      let rr = 0, gg = 0, bb = 0, n = 0
      const x0 = Math.max(0, Math.round(p.x) - half)
      const x1 = Math.min(m.w - 1, Math.round(p.x) + half)
      const y0 = Math.max(0, Math.round(p.y) - half)
      const y1 = Math.min(m.h - 1, Math.round(p.y) + half)
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const o = (y * m.w + x) * 4
          rr += m.px[o]; gg += m.px[o + 1]; bb += m.px[o + 2]; n++
        }
      }
      const o = (r * cols + c) * 4
      out[o] = rr / n; out[o + 1] = gg / n; out[o + 2] = bb / n; out[o + 3] = 255
    }
  }
  return out
}

/**
 * Band statistics and the classifier itself live in @firewatch/sim/classify, so
 * the server classifies tiles the same way the browser does. Re-exported here
 * because calibrate.ts reads them through this module.
 */
export { cellBands, NO_DATA, type CellBands }
