/**
 * Sentinel-2 L2A land cover, from the AWS Open Data mirror.
 *
 * Why this exists: the visible-band classifier in @firewatch/sim/classify is a
 * proxy tuned against Armenian imagery, and it fails badly elsewhere — it calls
 * the Great Salt Lake cropland and the Rio Negro urban. Water simply cannot be
 * identified reliably from RGB, because water is turquoise at Tahoe, black at
 * the Rio Negro, pink at the Great Salt Lake and brown wherever there is silt.
 *
 * The fix is not another threshold. It is the near-infrared, where water is
 * unambiguously dark regardless of what colour it looks to a human eye. ESA
 * already runs a classifier over the full 13-band stack and publishes the
 * result as the Scene Classification Layer, so the right move is to read that
 * rather than to re-derive a worse version of it from three visible bands.
 *
 * SCL is treated as AUTHORITATIVE for water and snow — the two classes it is
 * unambiguous about and the RGB proxy is hopeless at — and as ADVISORY
 * elsewhere, because it does not separate timber from scrub from grass, which
 * is exactly what the fuel model needs. Cloud, shadow and no-data fall through
 * to the RGB classifier rather than punching holes in the fuel map.
 *
 * Keyless and live-queryable: no Earth Engine account, no Sentinel Hub token.
 */
import { fromUrl, type GeoTIFFImage } from 'geotiff'
import type { Bounds } from '@firewatch/sim/terrain'
import type { Config } from '../config.ts'

/** Sentinel-2 Scene Classification Layer classes. */
export const SCL = {
  NoData: 0,
  Saturated: 1,
  DarkArea: 2,
  CloudShadow: 3,
  Vegetation: 4,
  NotVegetated: 5,
  Water: 6,
  Unclassified: 7,
  CloudMedium: 8,
  CloudHigh: 9,
  Cirrus: 10,
  Snow: 11,
} as const

const STAC = 'https://earth-search.aws.element84.com/v1/search'
/** Look this far back for a usable scene before giving up. */
const LOOKBACK_DAYS = 120
const MAX_CLOUD = 35
/**
 * How long a caller will wait for land cover before giving up on it.
 *
 * Reading a COG window takes 10-30 s cold, which is far too long to block
 * incident creation. Past this budget the caller proceeds on the RGB proxy
 * while the lookup keeps running in the background and populates the cache, so
 * the next visit to the same area gets the measured version instantly.
 */
const DEADLINE_MS = 6000

export interface LandCover {
  /** SCL class per grid cell, row-major, matching the caller's cols/rows. */
  scl: Uint8Array
  sceneId: string
  /** ISO date of the overpass. */
  observedAt: string
  cloudCover: number
  /** Fraction of cells that came back usable (not cloud/shadow/nodata). */
  usable: number
}

/**
 * WGS84 -> UTM forward projection.
 *
 * Sentinel-2 tiles are UTM, so the grid's lat/lng have to be projected to index
 * into them. Written out rather than pulled from proj4 because it is one
 * well-defined formula and this is the only place that needs it.
 */
function toUtm(lat: number, lng: number, zone: number, south: boolean) {
  const a = 6378137.0
  const f = 1 / 298.257223563
  const k0 = 0.9996
  const e2 = f * (2 - f)
  const ep2 = e2 / (1 - e2)
  const lng0 = ((zone * 6 - 183) * Math.PI) / 180
  const phi = (lat * Math.PI) / 180
  const lam = (lng * Math.PI) / 180

  const sinPhi = Math.sin(phi)
  const cosPhi = Math.cos(phi)
  const tanPhi = Math.tan(phi)

  const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi)
  const T = tanPhi * tanPhi
  const C = ep2 * cosPhi * cosPhi
  const A = (lam - lng0) * cosPhi
  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi))

  const easting =
    k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) +
    500000
  let northing =
    k0 *
    (M +
      N *
        tanPhi *
        ((A * A) / 2 +
          ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720))
  if (south) northing += 10000000
  return { easting, northing }
}

interface StacItem {
  id: string
  properties: { datetime: string; 'eo:cloud_cover'?: number; 'proj:epsg'?: number }
  assets: Record<string, { href: string }>
}

/** One retry: these hosts drop connections often enough to matter. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const msg = (err as Error).message
    if (/abort/i.test(msg)) throw err
    await new Promise((r) => setTimeout(r, 400))
    try {
      return await fn()
    } catch (err2) {
      throw new Error(`${label}: ${(err2 as Error).message} (after retry)`)
    }
  }
}

async function searchScenes(bounds: Bounds, timeoutMs: number): Promise<StacItem[]> {
  // Full RFC3339 — earth-search rejects a bare yyyy-mm-dd with a 400.
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await withRetry('stac', () => fetch(STAC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        collections: ['sentinel-2-l2a'],
        bbox: [bounds.west, bounds.south, bounds.east, bounds.north],
        datetime: `${since}/..`,
        query: { 'eo:cloud_cover': { lt: MAX_CLOUD } },
        // Least cloudy first: a clear scene from last month beats a hazy one
        // from yesterday for land cover, which changes on a seasonal scale.
        sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }],
        limit: 5,
      }),
    }))
    if (!res.ok) throw new Error(`STAC ${res.status} ${await res.text()}`)
    return ((await res.json()) as { features?: StacItem[] }).features ?? []
  } finally {
    clearTimeout(timer)
  }
}

/** Reads the SCL window covering `bounds` and resamples it onto the grid. */
async function sampleScene(
  item: StacItem,
  bounds: Bounds,
  cols: number,
  rows: number
): Promise<LandCover | null> {
  const epsg = item.properties['proj:epsg']
  if (!epsg || epsg < 32601 || epsg > 32760) return null
  const south = epsg >= 32700
  const zone = epsg - (south ? 32700 : 32600)

  const img: GeoTIFFImage = await withRetry('open-cog', async () =>
    (await fromUrl(item.assets.scl.href)).getImage()
  )
  const [ox, oy] = img.getOrigin()
  const [rx, ry] = img.getResolution()
  const W = img.getWidth()
  const H = img.getHeight()

  // Project the grid corners to find the pixel window to pull.
  const corners = [
    toUtm(bounds.north, bounds.west, zone, south),
    toUtm(bounds.north, bounds.east, zone, south),
    toUtm(bounds.south, bounds.west, zone, south),
    toUtm(bounds.south, bounds.east, zone, south),
  ]
  const xs = corners.map((c) => (c.easting - ox) / rx)
  const ys = corners.map((c) => (c.northing - oy) / ry)
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1)
  const x1 = Math.min(W, Math.ceil(Math.max(...xs)) + 1)
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1)
  const y1 = Math.min(H, Math.ceil(Math.max(...ys)) + 1)
  // The scene must actually cover the area, not merely intersect its bbox.
  if (x1 - x0 < 2 || y1 - y0 < 2) return null

  const raster = await withRetry('read-cog', () => img.readRasters({ window: [x0, y0, x1, y1] }))
  const band = (Array.isArray(raster) ? raster[0] : raster) as unknown as ArrayLike<number>
  const bw = x1 - x0
  const bh = y1 - y0

  const scl = new Uint8Array(cols * rows)
  let usable = 0
  for (let r = 0; r < rows; r++) {
    const lat = bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south)
    for (let c = 0; c < cols; c++) {
      const lng = bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west)
      const u = toUtm(lat, lng, zone, south)
      const px = Math.round((u.easting - ox) / rx) - x0
      const py = Math.round((u.northing - oy) / ry) - y0
      const i = r * cols + c
      if (px < 0 || py < 0 || px >= bw || py >= bh) {
        scl[i] = SCL.NoData
        continue
      }
      const v = band[py * bw + px] ?? SCL.NoData
      scl[i] = v
      if (
        v !== SCL.NoData && v !== SCL.Saturated && v !== SCL.CloudShadow &&
        v !== SCL.CloudMedium && v !== SCL.CloudHigh && v !== SCL.Cirrus
      ) {
        usable++
      }
    }
  }

  return {
    scl,
    sceneId: item.id,
    observedAt: item.properties.datetime,
    cloudCover: item.properties['eo:cloud_cover'] ?? 0,
    usable: usable / (cols * rows),
  }
}

/** Cache per area of interest: scenes change seasonally, not per request. */
const cache = new Map<string, { at: number; value: LandCover | null }>()
const TTL_MS = 6 * 60 * 60 * 1000
const key = (b: Bounds, cols: number, rows: number) =>
  `${b.north.toFixed(4)},${b.south.toFixed(4)},${b.east.toFixed(4)},${b.west.toFixed(4)},${cols}x${rows}`

/**
 * Best available Sentinel-2 land cover for the area, or null if none is usable.
 * Null is a normal outcome — persistent cloud, or a gap in coverage — and the
 * caller must degrade to the RGB proxy rather than treating it as an error.
 */
export async function sentinelLandCover(
  bounds: Bounds,
  cols: number,
  rows: number,
  cfg: Config,
  opts: { deadlineMs?: number } = {}
): Promise<LandCover | null> {
  const k = key(bounds, cols, rows)
  const hit = cache.get(k)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value

  const existing = inflight.get(k)
  const work = existing ?? lookup(bounds, cols, rows, cfg, k)
  if (!existing) inflight.set(k, work)

  // Race the lookup against the caller's patience. Losing the race is normal:
  // the work continues and the cache is warm for the next request.
  const deadline = opts.deadlineMs ?? DEADLINE_MS
  let timer: ReturnType<typeof setTimeout>
  const giveUp = new Promise<null>((res) => {
    timer = setTimeout(() => res(null), deadline)
  })
  try {
    return await Promise.race([work, giveUp])
  } finally {
    clearTimeout(timer!)
  }
}

const inflight = new Map<string, Promise<LandCover | null>>()

async function lookup(
  bounds: Bounds,
  cols: number,
  rows: number,
  cfg: Config,
  k: string
): Promise<LandCover | null> {
  let best: LandCover | null = null
  try {
    const items = await searchScenes(bounds, Math.max(cfg.fetchTimeoutMs, 30000))
    for (const item of items) {
      if (!item.assets.scl) continue
      try {
        const got = await sampleScene(item, bounds, cols, rows)
        // Take the first scene that actually sees most of the area; a scene
        // whose clouds sit over this bbox is useless however clear its average.
        if (got && got.usable > 0.6) {
          best = got
          break
        }
        if (got && (!best || got.usable > best.usable)) best = got
      } catch (err) {
        console.warn(`[sentinel] scene ${item.id} unreadable: ${(err as Error).message}`)
      }
    }
  } catch (err) {
    // Swallowing this silently made a plain HTTP 400 look like "no coverage".
    // Land cover is optional, so failure must not throw — but it must be visible.
    console.warn(`[sentinel] land cover lookup failed: ${(err as Error).message}`)
    best = null
  }

  if (cache.size > 64) cache.clear()
  cache.set(k, { at: Date.now(), value: best })
  inflight.delete(k)
  return best
}
