/**
 * Tier 1 providers — elevation, fuel, and the mocked rest.
 *
 * Each port has a procedural implementation that always works and a real one
 * that reads tiles. The real one lists the procedural one as its fallback, so a
 * network failure degrades instead of failing, and `degradedFrom` records it.
 */
import {
  FUELS, Fuel, buildTerrain, computeShade, localSlope, metresPerPixel, zoomFor,
  terrariumHeight, classifyFuel, NO_DATA,
} from '@firewatch/sim'
import type {
  BarrierField, BarrierProvider, BurnHistoryProvider, CanopyGrid, CanopyProvider,
  ElevationProvider, FuelGrid, FuelProvider, PerimeterObserver, SeverityGrid,
  TerrainQuery, ValuesAtRisk, ValuesAtRiskGrid,
} from '@firewatch/contracts/providers'
import { DEM_URL, IMAGERY_URL, fetchMosaic, toPixel, type Mosaic } from './tiles.ts'
import { SCL, sentinelLandCover } from './sentinel.ts'
import { prov, synthetic } from './provenance.ts'
import type { Config } from '../config.ts'

// --- elevation ----------------------------------------------------------

export const proceduralDem: ElevationProvider = {
  id: 'procedural-dem',
  fallbacks: [],
  async fetch(q: TerrainQuery) {
    const t = buildTerrain(q.scenario)
    return {
      data: { elevation: t.elevation, minElev: t.minElev, maxElev: t.maxElev },
      provenance: synthetic('procedural', 'Procedural terrain — synthetic, not measured'),
    }
  },
}

export function terrariumDem(cfg: Config): ElevationProvider {
  return {
    id: 'terrarium-dem',
    fallbacks: [proceduralDem],
    async fetch(q: TerrainQuery, signal?: AbortSignal) {
      const { grid } = q
      const midLat = (grid.bounds.north + grid.bounds.south) / 2
      const z = zoomFor(midLat, grid.cellSize / 2, 10, 14)
      const m = await fetchMosaic(grid.bounds, z, DEM_URL, {
        cacheDir: cfg.tileCacheDir, timeoutMs: cfg.fetchTimeoutMs, signal,
      })
      if (!m) throw new Error('DEM mosaic unavailable')

      const { cols, rows, bounds } = grid
      const elevation = new Float32Array(cols * rows)
      for (let r = 0; r < rows; r++) {
        const lat = bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south)
        for (let c = 0; c < cols; c++) {
          const lng = bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west)
          const p = toPixel(m, lat, lng)
          elevation[r * cols + c] = bilinear(m, p.x, p.y)
        }
      }
      fillHoles(elevation, cols, rows)
      let minElev = Infinity, maxElev = -Infinity
      for (const e of elevation) {
        if (e < minElev) minElev = e
        if (e > maxElev) maxElev = e
      }
      return {
        data: { elevation, minElev, maxElev },
        provenance: prov({
          source: 'aws-terrarium',
          kind: 'measured',
          nativeResolution: metresPerPixel(midLat, z),
          observedAt: null,
          coverage: m.coverage,
          note: `Live DEM · z${z}`,
        }),
      }
    },
  }
}

function height(m: Mosaic, x: number, y: number): number {
  const xi = Math.max(0, Math.min(m.w - 1, Math.round(x)))
  const yi = Math.max(0, Math.min(m.h - 1, Math.round(y)))
  const o = (yi * m.w + xi) * 4
  return terrariumHeight(m.px[o], m.px[o + 1], m.px[o + 2], m.px[o + 3])
}

/** Bilinear so a 30 m DEM resampled to ~38 m cells does not stair-step. */
function bilinear(m: Mosaic, x: number, y: number): number {
  const fx = Math.floor(x), fy = Math.floor(y)
  const tx = x - fx, ty = y - fy
  const a = height(m, fx, fy), b = height(m, fx + 1, fy)
  const c = height(m, fx, fy + 1), d = height(m, fx + 1, fy + 1)
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) return NaN
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty
}

/** Grows valid elevations into any gaps left by a tile that failed to load. */
function fillHoles(elev: Float32Array, cols: number, rows: number) {
  for (let pass = 0; pass < 12; pass++) {
    let remaining = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        if (!Number.isNaN(elev[i])) continue
        let sum = 0, n = 0
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr, nc = c + dc
            if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue
            const v = elev[nr * cols + nc]
            if (!Number.isNaN(v)) { sum += v; n++ }
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

// --- fuel ---------------------------------------------------------------

/** Expands fuel ids into the per-cell bed properties the kernel needs. */
function expand(fuelId: Uint8Array): FuelGrid {
  const n = fuelId.length
  const g: FuelGrid = {
    fuelId,
    fineLoad: new Float32Array(n),
    totalLoad: new Float32Array(n),
    bulkDensity: new Float32Array(n),
    depth: new Float32Array(n),
    sav: new Float32Array(n),
    confusion: null,
  }
  for (let i = 0; i < n; i++) {
    const f = FUELS[fuelId[i]]
    g.fineLoad[i] = f.fineLoad
    g.totalLoad[i] = f.load
    g.bulkDensity[i] = f.bulkDensity
    g.depth[i] = f.depth
    g.sav[i] = f.sav
  }
  return g
}

export const topographyFuel: FuelProvider = {
  id: 'topography-fuel',
  fallbacks: [],
  async fetch(q: TerrainQuery) {
    const t = buildTerrain(q.scenario)
    return {
      data: expand(t.fuel),
      provenance: synthetic('procedural', 'Procedural fuel from topography — synthetic'),
    }
  },
}

export function imageryFuel(cfg: Config): FuelProvider {
  return {
    id: 'esri-imagery-fuel',
    fallbacks: [topographyFuel],
    async fetch(q: TerrainQuery, signal?: AbortSignal) {
      const { grid } = q
      const midLat = (grid.bounds.north + grid.bounds.south) / 2
      const z = zoomFor(midLat, grid.cellSize / 3, 11, 15)
      const m = await fetchMosaic(grid.bounds, z, IMAGERY_URL, {
        cacheDir: cfg.tileCacheDir, timeoutMs: cfg.fetchTimeoutMs, signal,
      })
      if (!m) throw new Error('imagery mosaic unavailable')

      // Classification needs elevation for the water and forest/cropland rules.
      const dem = await resolveElevation(cfg, q, signal)
      const { cols, rows, bounds, cellSize } = grid
      const base = buildTerrain(q.scenario)
      const fuelId = new Uint8Array(cols * rows)
      const half = Math.max(1, Math.round(cellSize / metresPerPixel(midLat, z) / 2))

      // Sentinel-2's Scene Classification Layer, where available. Null is a
      // normal outcome (cloud, coverage gap) and simply leaves the RGB proxy in
      // charge, so this can never make the map worse than it was.
      const land = await sentinelLandCover(bounds, cols, rows, cfg)
      let sclWater = 0
      let sclSnow = 0

      for (let r = 0; r < rows; r++) {
        const lat = bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south)
        for (let c = 0; c < cols; c++) {
          const lng = bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west)
          const p = toPixel(m, lat, lng)
          const i = r * cols + c

          // SCL is authoritative for exactly the two classes it is unambiguous
          // about and the RGB proxy is hopeless at. Everything else falls
          // through, because SCL cannot separate timber from scrub from grass.
          if (land) {
            const k = land.scl[i]
            if (k === SCL.Water) {
              fuelId[i] = Fuel.Water
              sclWater++
              continue
            }
            if (k === SCL.Snow) {
              fuelId[i] = Fuel.Barren
              sclSnow++
              continue
            }
          }

          const slopeDeg = (localSlope(dem.elevation, cols, rows, c, r, cellSize) * 180) / Math.PI
          const f = classifyFuel(m, p.x, p.y, half, dem.elevation[i], slopeDeg)
          // Where the imagery has a hole, keep the topography-driven guess.
          fuelId[i] = f === NO_DATA ? base.fuel[i] : f
        }
      }

      const n = cols * rows
      // Say where the thresholds came from, not just what they are. SCL makes
      // water and snow trustworthy anywhere; the vegetation split is a set of
      // brightness and texture breaks fitted to Armenian imagery, and nothing
      // else in the UI would tell someone simulating Yosemite that.
      const tuned = 'vegetation split is a visible-band proxy tuned on Armenian imagery, unvalidated elsewhere'
      const note = land
        ? `Live imagery z${z} + Sentinel-2 SCL ${land.observedAt.slice(0, 10)} ` +
          `(${(land.cloudCover).toFixed(0)}% cloud, ${(land.usable * 100).toFixed(0)}% usable) — ` +
          `water/snow measured, ${tuned}`
        : `Live imagery · z${z} — no Sentinel-2 scene available, ${tuned}`
      void sclSnow
      void n

      return {
        data: expand(fuelId),
        provenance: prov({
          source: land ? `esri-world-imagery+sentinel2-scl:${land.sceneId}` : 'esri-world-imagery',
          kind: 'derived',
          nativeResolution: land ? 20 : metresPerPixel(midLat, z),
          observedAt: land?.observedAt ?? null,
          coverage: m.coverage,
          note,
        }),
      }
    },
  }
}

/** Fuel classification needs a DEM; reuse the same provider chain rather than refetch logic. */
async function resolveElevation(cfg: Config, q: TerrainQuery, signal?: AbortSignal) {
  const { resolve } = await import('./provenance.ts')
  const p = cfg.mode === 'live' ? terrariumDem(cfg) : proceduralDem
  return (await resolve(p, q, signal)).data
}

// --- mocked Tier 1 ports ------------------------------------------------
// ARCHITECTURE.md §9: writing the null implementation now forces the call site
// to exist, so the real provider later is one line of composition.

/** Per-class assumptions until GEDI-derived rasters exist (§4, §7). */
export const assumedCanopy: CanopyProvider = {
  id: 'assumed-canopy',
  fallbacks: [],
  async fetch(q: TerrainQuery) {
    const t = buildTerrain(q.scenario)
    const n = t.cols * t.rows
    const d: CanopyGrid = {
      canopyLoad: new Float32Array(n),
      cbh: new Float32Array(n),
      cbd: new Float32Array(n),
      cover: new Float32Array(n),
      assumed: new Uint8Array(n).fill(1),
    }
    for (let i = 0; i < n; i++) {
      const timber = t.fuel[i] === 4
      const shrub = t.fuel[i] === 3
      d.canopyLoad[i] = timber ? 1.2 : shrub ? 0.3 : 0
      d.cbh[i] = timber ? 5 : shrub ? 1 : 0
      d.cbd[i] = timber ? 0.1 : shrub ? 0.05 : 0
      d.cover[i] = timber ? 0.7 : shrub ? 0.35 : 0
    }
    return {
      data: d,
      provenance: synthetic(
        'per-class-assumption',
        'Canopy assumed per fuel class — no CBH/CBD measurement (§4 names this the weakest input)'
      ),
    }
  },
}

/** No observations — the assimilation loop of §6 has nothing to assimilate yet. */
export const noObservations: PerimeterObserver = {
  id: 'no-observations',
  fallbacks: [],
  async fetch() {
    return {
      data: { burning: new Uint8Array(0), maxTemp: null },
      provenance: synthetic('none', 'No IR or VIIRS feed — assimilation loop inactive (§6)'),
    }
  },
}

export const noBarriers: BarrierProvider = {
  id: 'no-barriers',
  fallbacks: [],
  async fetch(q: TerrainQuery) {
    const t = buildTerrain(q.scenario)
    const data: BarrierField = { blockFrac: new Float32Array(t.cols * t.rows * 8) }
    return { data, provenance: synthetic('none', 'No OSM barriers loaded — roads and streams absent') }
  },
}

export const noBurnHistory: BurnHistoryProvider = {
  id: 'no-burn-history',
  fallbacks: [],
  async fetch(q: TerrainQuery) {
    const t = buildTerrain(q.scenario)
    const n = t.cols * t.rows
    const data: SeverityGrid = {
      rbr: new Float32Array(n),
      severity: new Uint8Array(n),
      yearsSince: new Float32Array(n).fill(99),
    }
    return { data, provenance: synthetic('none', 'No burn history — GEE dNBR not wired (§3)') }
  },
}

/** Density estimate, stated not measured — the current STRUCTURES_PER_HA rule. */
export const densityValuesAtRisk: ValuesAtRisk = {
  id: 'density-values-at-risk',
  fallbacks: [],
  async fetch(q: TerrainQuery) {
    const t = buildTerrain(q.scenario)
    const n = t.cols * t.rows
    const haPerCell = (t.cellSize * t.cellSize) / 10000
    const d: ValuesAtRiskGrid = { structures: new Float32Array(n), population: new Float32Array(n) }
    for (let i = 0; i < n; i++) {
      if (t.fuel[i] === 6) {
        d.structures[i] = 3 * haPerCell
        d.population[i] = 7.5 * haPerCell
      }
    }
    return {
      data: d,
      provenance: synthetic('density-estimate', 'Structures estimated at 3/ha on developed land — not a building footprint count'),
    }
  },
}

export { computeShade }
