/**
 * ESA WorldCover 10 m land cover, crosswalked to fuel models.
 *
 * Replaces guessing vegetation from how it looks in a visible-band photograph.
 * The hindcast made the case: over the Cypress Creek fire in Angelina National
 * Forest, the RGB classifier returned 52% Cropland and 7.9% Tree cover, while
 * WorldCover returns 97.7% Tree cover — which is what a national forest is.
 * A fuel map that thinks a forest is farmland gets both the fuel load and the
 * spread rate wrong, and inflates the area a fire can reach.
 *
 * WorldCover is a classified product built from Sentinel-1 and Sentinel-2 with
 * global validation, not a threshold on three visible bands. It is from 2021,
 * so it misses recent change — that is what the dNBR burn-history layer is
 * for — but being a year or two stale beats being a different biome.
 *
 * ARCHITECTURE.md §2 called this "ships Tier 1 in days with no training at
 * all". Keyless, on AWS Open Data, 3-degree tiles named by SW corner.
 */
import { fromUrl, type GeoTIFFImage } from 'geotiff'
import { Fuel } from '@firewatch/sim/fuels'
import type { Bounds } from '@firewatch/sim/terrain'
import { COG_OPTS } from './cogfetch.ts'
import type { Config } from '../config.ts'

const BASE = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map'

/** WorldCover v200 class codes. */
export const WC = {
  Tree: 10, Shrub: 20, Grass: 30, Crop: 40, BuiltUp: 50, Bare: 60,
  SnowIce: 70, Water: 80, Wetland: 90, Mangrove: 95, MossLichen: 100,
} as const

/**
 * Crosswalk to this kernel's fuel models.
 *
 * Wetland maps to grass rather than water: herbaceous wetland carries fire
 * readily once drawn down in a drought, and calling it unburnable would stop
 * a fire that in reality runs straight through. Snow maps to barren because
 * the kernel has no seasonal state — a 2021 snow classification says more
 * about the acquisition date than about today.
 */
const CROSSWALK: Record<number, number> = {
  [WC.Tree]: Fuel.Timber,
  [WC.Shrub]: Fuel.Shrub,
  [WC.Grass]: Fuel.Grass,
  [WC.Crop]: Fuel.Agriculture,
  [WC.BuiltUp]: Fuel.Urban,
  [WC.Bare]: Fuel.Barren,
  [WC.SnowIce]: Fuel.Barren,
  [WC.Water]: Fuel.Water,
  [WC.Wetland]: Fuel.Grass,
  [WC.Mangrove]: Fuel.Timber,
  [WC.MossLichen]: Fuel.Grass,
}

/** 3-degree tile name for a point, e.g. N30W096. */
export function tileName(lat: number, lng: number): string {
  const la = Math.floor(lat / 3) * 3
  const lo = Math.floor(lng / 3) * 3
  const ns = `${la >= 0 ? 'N' : 'S'}${String(Math.abs(la)).padStart(2, '0')}`
  const ew = `${lo >= 0 ? 'E' : 'W'}${String(Math.abs(lo)).padStart(3, '0')}`
  return `${ns}${ew}`
}

interface TileWindow {
  data: ArrayLike<number>
  x0: number
  y0: number
  w: number
  h: number
  ox: number
  oy: number
  rx: number
  ry: number
}

async function readTile(name: string, bounds: Bounds): Promise<TileWindow | null> {
  const url = `${BASE}/ESA_WorldCover_10m_2021_v200_${name}_Map.tif`
  const img: GeoTIFFImage = await (await fromUrl(url, COG_OPTS)).getImage()
  const [ox, oy] = img.getOrigin()
  const [rx, ry] = img.getResolution()
  const W = img.getWidth()
  const H = img.getHeight()

  const xs = [(bounds.west - ox) / rx, (bounds.east - ox) / rx]
  const ys = [(bounds.north - oy) / ry, (bounds.south - oy) / ry]
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1)
  const x1 = Math.min(W, Math.ceil(Math.max(...xs)) + 1)
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1)
  const y1 = Math.min(H, Math.ceil(Math.max(...ys)) + 1)
  if (x1 - x0 < 2 || y1 - y0 < 2) return null

  const raster = await img.readRasters({ window: [x0, y0, x1, y1] })
  const data = (Array.isArray(raster) ? raster[0] : raster) as unknown as ArrayLike<number>
  return { data, x0, y0, w: x1 - x0, h: y1 - y0, ox, oy, rx, ry }
}

export interface WorldCoverGrid {
  /** Fuel id per cell, row-major. */
  fuelId: Uint8Array
  /** Fraction of cells that came from WorldCover rather than a gap. */
  coverage: number
  /** Raw class histogram, for diagnostics. */
  classes: Map<number, number>
}

const cache = new Map<string, { at: number; value: WorldCoverGrid | null }>()
const TTL_MS = 24 * 60 * 60 * 1000
const DEADLINE_MS = 8000
const inflight = new Map<string, Promise<WorldCoverGrid | null>>()
const key = (b: Bounds, c: number, r: number) =>
  `${b.north.toFixed(3)},${b.west.toFixed(3)},${b.south.toFixed(3)},${c}x${r}`

async function build(bounds: Bounds, cols: number, rows: number): Promise<WorldCoverGrid | null> {
  // An area of interest can straddle up to four 3-degree tiles.
  const names = new Set<string>()
  for (const lat of [bounds.north, bounds.south]) {
    for (const lng of [bounds.west, bounds.east]) names.add(tileName(lat, lng))
  }
  const tiles = new Map<string, TileWindow>()
  for (const n of names) {
    try {
      const t = await readTile(n, bounds)
      if (t) tiles.set(n, t)
    } catch (err) {
      console.warn(`[worldcover] tile ${n}: ${(err as Error).message}`)
    }
  }
  if (!tiles.size) return null

  const fuelId = new Uint8Array(cols * rows)
  const classes = new Map<number, number>()
  let filled = 0
  for (let r = 0; r < rows; r++) {
    const lat = bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south)
    for (let c = 0; c < cols; c++) {
      const lng = bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west)
      const t = tiles.get(tileName(lat, lng))
      const i = r * cols + c
      if (!t) continue
      const px = Math.round((lng - t.ox) / t.rx) - t.x0
      const py = Math.round((lat - t.oy) / t.ry) - t.y0
      if (px < 0 || py < 0 || px >= t.w || py >= t.h) continue
      const cls = t.data[py * t.w + px]
      const mapped = CROSSWALK[cls]
      if (mapped === undefined) continue
      fuelId[i] = mapped
      classes.set(cls, (classes.get(cls) ?? 0) + 1)
      filled++
    }
  }
  return { fuelId, coverage: filled / (cols * rows), classes }
}

/**
 * WorldCover for an area, or null while unavailable.
 *
 * Same bargain as the Sentinel-2 land-cover read: a deadline so incident
 * creation never blocks on a COG, with the work continuing in the background
 * to warm the cache.
 */
export async function worldCoverFor(
  bounds: Bounds, cols: number, rows: number, _cfg: Config,
  opts: { deadlineMs?: number } = {}
): Promise<WorldCoverGrid | null> {
  const k = key(bounds, cols, rows)
  const hit = cache.get(k)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value

  let job = inflight.get(k)
  if (!job) {
    job = build(bounds, cols, rows)
      .catch((err) => {
        console.warn(`[worldcover] ${(err as Error).message}`)
        return null
      })
      .then((v) => {
        if (cache.size > 64) cache.clear()
        cache.set(k, { at: Date.now(), value: v })
        inflight.delete(k)
        return v
      })
    inflight.set(k, job)
  }
  let timer: ReturnType<typeof setTimeout>
  const giveUp = new Promise<null>((res) => { timer = setTimeout(() => res(null), opts.deadlineMs ?? DEADLINE_MS) })
  try {
    return await Promise.race([job, giveUp])
  } finally {
    clearTimeout(timer!)
  }
}

export const WC_NAMES: Record<number, string> = {
  10: 'Tree cover', 20: 'Shrubland', 30: 'Grassland', 40: 'Cropland', 50: 'Built-up',
  60: 'Bare/sparse', 70: 'Snow/ice', 80: 'Water', 90: 'Wetland', 95: 'Mangrove', 100: 'Moss/lichen',
}
