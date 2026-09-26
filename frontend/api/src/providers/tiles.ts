/**
 * Server-side tile mosaic: fetch, decode, cache.
 *
 * The browser reads tiles back out of a canvas; Node has no canvas, so PNG and
 * JPEG are decoded directly. The addressing math is shared (@firewatch/sim/geo)
 * so both sides sample identical pixels.
 *
 * Tiles are cached on disk because a scenario is ~20-40 tiles (~1.5 MB) and
 * re-fetching them per incident is the difference between a 3-second and a
 * 30-millisecond incident create.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'
import { TILE_SIZE, latToTileY, lngToTileX } from '@firewatch/sim/geo'
import type { Bounds } from '@firewatch/sim/terrain'
import type { RasterView } from '@firewatch/sim/classify'

export interface Mosaic extends RasterView {
  px: Uint8Array
  w: number
  h: number
  x0: number
  y0: number
  z: number
  /** Fraction of tiles that actually loaded. */
  coverage: number
}

/** Above this many tiles the request is refused rather than hammering a service. */
const MAX_TILES = 140
/** Below this coverage the mosaic is unusable and the caller should fall back. */
const MIN_COVERAGE = 0.6

const decode = (buf: Buffer, contentType: string) => {
  if (contentType.includes('png')) {
    const png = PNG.sync.read(buf)
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
  }
  const img = jpeg.decode(buf, { useTArray: true })
  return { width: img.width, height: img.height, data: new Uint8Array(img.data) }
}

async function fetchTile(
  url: string, cacheDir: string, timeoutMs: number, signal?: AbortSignal
): Promise<{ width: number; height: number; data: Uint8Array }> {
  const key = createHash('sha1').update(url).digest('hex')
  const metaPath = join(cacheDir, `${key}.meta`)
  const binPath = join(cacheDir, `${key}.bin`)
  try {
    const [meta, bin] = await Promise.all([readFile(metaPath, 'utf8'), readFile(binPath)])
    return decode(bin, meta)
  } catch {
    // not cached
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) throw new Error(`${res.status} ${url}`)
    const contentType = res.headers.get('content-type') ?? 'image/png'
    const buf = Buffer.from(await res.arrayBuffer())
    await mkdir(cacheDir, { recursive: true })
    await Promise.all([writeFile(metaPath, contentType), writeFile(binPath, buf)])
    return decode(buf, contentType)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Stitches every tile covering `bounds` into one readable RGBA buffer. */
export async function fetchMosaic(
  bounds: Bounds,
  z: number,
  urlFor: (z: number, x: number, y: number) => string,
  opts: { cacheDir: string; timeoutMs: number; signal?: AbortSignal }
): Promise<Mosaic | null> {
  const x0 = Math.floor(lngToTileX(bounds.west, z))
  const x1 = Math.floor(lngToTileX(bounds.east, z))
  const y0 = Math.floor(latToTileY(bounds.north, z))
  const y1 = Math.floor(latToTileY(bounds.south, z))
  const nx = x1 - x0 + 1
  const ny = y1 - y0 + 1
  if (nx * ny > MAX_TILES) return null

  const w = nx * TILE_SIZE
  const h = ny * TILE_SIZE
  const px = new Uint8Array(w * h * 4)
  let ok = 0

  await Promise.all(
    Array.from({ length: nx * ny }, async (_, k) => {
      const tx = x0 + (k % nx)
      const ty = y0 + Math.floor(k / nx)
      try {
        const img = await fetchTile(urlFor(z, tx, ty), opts.cacheDir, opts.timeoutMs, opts.signal)
        const ox = (tx - x0) * TILE_SIZE
        const oy = (ty - y0) * TILE_SIZE
        // Blit row by row; tiles are TILE_SIZE square but never assume it.
        const cw = Math.min(TILE_SIZE, img.width)
        const ch = Math.min(TILE_SIZE, img.height)
        for (let row = 0; row < ch; row++) {
          const src = row * img.width * 4
          const dst = ((oy + row) * w + ox) * 4
          px.set(img.data.subarray(src, src + cw * 4), dst)
        }
        ok++
      } catch {
        // A hole in the mosaic is survivable; a total miss is not.
      }
    })
  )

  const coverage = ok / (nx * ny)
  if (coverage < MIN_COVERAGE) return null
  return { px, w, h, x0, y0, z, coverage }
}

/** Mosaic pixel coordinates for a geographic point. */
export const toPixel = (m: Mosaic, lat: number, lng: number) => ({
  x: (lngToTileX(lng, m.z) - m.x0) * TILE_SIZE,
  y: (latToTileY(lat, m.z) - m.y0) * TILE_SIZE,
})

export const DEM_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`

export const IMAGERY_URL = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
