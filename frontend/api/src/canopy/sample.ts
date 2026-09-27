/**
 * Builds the training table for the learned canopy model.
 *
 *   npm run canopy:sample --workspace=@firewatch/api
 *
 * LABELS come from LANDFIRE — CBH, CBD, canopy cover and canopy height as
 * published 30 m rasters for CONUS, keyless over their ArcGIS ImageServer.
 * This is the authoritative source: LANDFIRE is what FARSITE and FlamMap are
 * run against operationally, and CBH/CBD are exactly the two quantities Van
 * Wagner's crown criteria consume, so the model is supervised directly on what
 * the kernel needs rather than on a proxy like canopy height plus an allometry.
 *
 * FEATURES come from `features.ts`, shared with the inference provider.
 *
 * WHY A MODEL AND NOT JUST THE RASTER. LANDFIRE stops at the US border, and this
 * app simulates anywhere on earth — the three bookmarked scenarios are Armenian.
 * So the raster cannot be read directly for most of the domain, and the job is
 * to learn the LANDFIRE relationship from globally available predictors
 * (Sentinel-2, SRTM-derived terrain, WorldCover) and carry it abroad. That
 * generalisation is the entire value, and it is also the thing most likely to be
 * oversold: the honest claim is "trained on LANDFIRE, applied globally", not
 * "measured".
 *
 * Sampling is BY REGION, and the regions become the cross-validation blocks.
 * Two adjacent 30 m pixels are nearly the same observation, so a random split
 * would leak neighbours between train and test and report a score that has
 * nothing to do with generalising to a new forest. `train.py` holds out whole
 * regions for the same reason.
 */
import { writeFileSync } from 'node:fs'
import { buildTerrain, scenarioAt } from '@firewatch/sim/terrain'
import { loadConfig } from '../config.ts'
import { buildRegistry } from '../providers/registry.ts'
import { resolve } from '../providers/provenance.ts'
import {
  FEATURE_COUNT, FEATURE_NAMES, featuresUsable, fetchReflectance, isWoody,
  writeFeatureRow, type FeatureGrids,
} from './features.ts'

const LF = 'https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023'

/**
 * LANDFIRE stores these as scaled integers. The scale factors are the published
 * conventions, and the service's own advertised min/max corroborate each one:
 * CBH 0-100, CBD 0-45, CC 0-95, CH 0-510.
 */
const LABELS = [
  { layer: 'CBH', key: 'cbh', scale: 0.1, unit: 'm' },
  { layer: 'CBD', key: 'cbd', scale: 0.01, unit: 'kg/m3' },
  { layer: 'CC', key: 'cover', scale: 0.01, unit: 'fraction' },
  { layer: 'CH', key: 'height', scale: 0.1, unit: 'm' },
] as const

/**
 * Sampling regions: forested CONUS, spread across fire-relevant biomes.
 *
 * Diversity here is what the model can generalise from. A table drawn only from
 * Sierra Nevada conifer would learn Sierra Nevada conifer, and its held-out
 * score would say so only if the holdout were somewhere else — which is why the
 * region list and the CV blocking are the same list.
 */
const REGIONS = [
  { name: 'sierra-nevada', lat: 37.74, lng: -119.6 },
  { name: 'cascades-or', lat: 44.3, lng: -121.9 },
  { name: 'front-range-co', lat: 39.6, lng: -105.5 },
  { name: 'gila-nm', lat: 33.3, lng: -108.3 },
  { name: 'angelina-tx', lat: 31.3, lng: -94.3 },
  { name: 'ouachita-ar', lat: 34.5, lng: -93.7 },
  { name: 'smokies-tn', lat: 35.6, lng: -83.5 },
  { name: 'apalachicola-fl', lat: 30.1, lng: -84.9 },
  { name: 'black-hills-sd', lat: 43.9, lng: -103.5 },
  { name: 'kaibab-az', lat: 36.4, lng: -112.1 },
  { name: 'bitterroot-mt', lat: 46.0, lng: -114.2 },
  { name: 'san-gabriel-ca', lat: 34.3, lng: -117.8 },
  { name: 'wasatch-ut', lat: 40.6, lng: -111.6 },
  { name: 'coast-range-ca', lat: 39.4, lng: -123.2 },
]

/** 12 km across a 400-cell grid gives 30 m cells, matching LANDFIRE natively. */
const SPAN_KM = 12
const PER_REGION = 500
/** ArcGIS getSamples rejects very large multipoint geometries. */
const BATCH = 250

interface Row {
  region: string
  lat: number
  lng: number
  features: number[]
  cbh: number
  cbd: number
  cover: number
  height: number
}

/** Deterministic RNG, so re-running the sampler picks the same cells. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

async function landfireSamples(
  layer: string,
  pts: [number, number][],
  timeoutMs: number
): Promise<(number | null)[]> {
  const out: (number | null)[] = []
  for (let b = 0; b < pts.length; b += BATCH) {
    const chunk = pts.slice(b, b + BATCH)
    const body = new URLSearchParams({
      geometry: JSON.stringify({ points: chunk, spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryMultipoint',
      returnFirstValueOnly: 'true',
      f: 'json',
    })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(`${LF}/LF2023_${layer}_CONUS/ImageServer/getSamples`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: ac.signal,
      })
      if (!res.ok) throw new Error(`LANDFIRE ${layer} ${res.status}`)
      const json = (await res.json()) as {
        samples?: { locationId: number; value: string }[]
        error?: { message?: string }
      }
      if (json.error) throw new Error(`LANDFIRE ${layer}: ${json.error.message}`)
      // getSamples returns nothing for a point off the raster, and the results
      // are NOT guaranteed dense or ordered — index by locationId.
      const byId = new Map<number, string>()
      for (const s of json.samples ?? []) byId.set(s.locationId, s.value)
      for (let k = 0; k < chunk.length; k++) {
        const v = byId.get(k)
        const n = v == null ? NaN : Number(v)
        out.push(Number.isFinite(n) ? n : null)
      }
    } finally {
      clearTimeout(timer)
    }
  }
  return out
}

async function sampleRegion(region: { name: string; lat: number; lng: number }, cfg: ReturnType<typeof loadConfig>) {
  const sc = scenarioAt(region.lat, region.lng, SPAN_KM, { id: `canopy:${region.name}` })
  const base = buildTerrain(sc)
  const { cols, rows, bounds, cellSize } = base
  const grid = { bounds, cols, rows, cellSize, crs: 'EPSG:4326' as const }

  const reg = buildRegistry(cfg)
  const [dem, fuel, refl] = await Promise.all([
    resolve(reg.elevation, { grid, scenario: sc }),
    resolve(reg.fuel, { grid, scenario: sc }),
    fetchReflectance(bounds, cols, rows, Math.max(cfg.fetchTimeoutMs, 40000)),
  ])
  if (!refl) {
    console.log(`  ${region.name}: no usable Sentinel-2 scene — skipped`)
    return []
  }

  const grids: FeatureGrids = {
    blue: refl.bands.blue, green: refl.bands.green, red: refl.bands.red,
    nir: refl.bands.nir, swir16: refl.bands.swir16, swir22: refl.bands.swir22,
    elevation: dem.data.elevation, fuel: fuel.data.fuelId,
    cols, rows, cellSize, bounds, sceneId: refl.item.id,
  }

  // Candidate cells: woody, with clean reflectance, away from the border so the
  // 3x3 texture window is complete.
  const candidates: number[] = []
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c
      if (isWoody(grids.fuel[i]) && featuresUsable(grids, i)) candidates.push(i)
    }
  }
  if (candidates.length < 50) {
    console.log(`  ${region.name}: only ${candidates.length} woody cells — skipped`)
    return []
  }

  // Deterministic shuffle, then take the first PER_REGION.
  const rand = rng(0x5eed ^ region.name.length ^ Math.round(region.lat * 1000))
  for (let k = candidates.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1))
    ;[candidates[k], candidates[j]] = [candidates[j], candidates[k]]
  }
  const picked = candidates.slice(0, PER_REGION)

  const pts: [number, number][] = picked.map((i) => {
    const c = i % cols
    const r = (i / cols) | 0
    const lng = bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west)
    const lat = bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south)
    return [lng, lat]
  })

  const labelCols: Record<string, (number | null)[]> = {}
  for (const l of LABELS) {
    labelCols[l.key] = (await landfireSamples(l.layer, pts, Math.max(cfg.fetchTimeoutMs, 40000)))
      .map((v) => (v == null ? null : v * l.scale))
  }

  const buf = new Float32Array(FEATURE_COUNT)
  const rowsOut: Row[] = []
  for (let k = 0; k < picked.length; k++) {
    const cbh = labelCols.cbh[k]
    const cbd = labelCols.cbd[k]
    const cover = labelCols.cover[k]
    const height = labelCols.height[k]
    if (cbh == null || cbd == null || cover == null || height == null) continue
    // A cell LANDFIRE calls treeless carries no canopy structure to learn; it
    // would otherwise teach the model that woody reflectance implies CBD 0.
    if (height <= 0 || cover <= 0) continue
    writeFeatureRow(grids, picked[k], buf, 0)
    rowsOut.push({
      region: region.name,
      lng: pts[k][0], lat: pts[k][1],
      features: Array.from(buf),
      cbh, cbd, cover, height,
    })
  }
  const pct = ((rowsOut.length / picked.length) * 100).toFixed(0)
  console.log(
    `  ${region.name}: ${rowsOut.length} rows from ${picked.length} sampled ` +
    `(${pct}% had canopy) · ${candidates.length.toLocaleString()} woody cells · scene ${grids.sceneId}`
  )
  return rowsOut
}

const cfg = loadConfig()
const OUT = new URL('./training.jsonl', import.meta.url).pathname
console.log(`Sampling ${REGIONS.length} CONUS regions, up to ${PER_REGION} cells each`)
console.log(`labels: LANDFIRE LF2023 ${LABELS.map((l) => l.layer).join(', ')} @ 30 m`)
console.log(`features (${FEATURE_COUNT}): ${FEATURE_NAMES.join(' ')}\n`)

const all: Row[] = []
for (const region of REGIONS) {
  try {
    all.push(...(await sampleRegion(region, cfg)))
  } catch (err) {
    console.log(`  ${region.name}: FAILED — ${(err as Error).message}`)
  }
}

writeFileSync(OUT, all.map((r) => JSON.stringify(r)).join('\n') + '\n')
// The exact column order this table was built with. train.py copies it into
// model.json and the provider refuses a model whose list disagrees with the
// running code — the one way a silently-reinterpreted feature column gets caught.
writeFileSync(
  new URL('./feature-names.json', import.meta.url).pathname,
  JSON.stringify(FEATURE_NAMES)
)
const byRegion = new Map<string, number>()
for (const r of all) byRegion.set(r.region, (byRegion.get(r.region) ?? 0) + 1)
console.log(`\n${all.length} rows across ${byRegion.size} regions -> ${OUT}`)
if (all.length) {
  const q = (xs: number[], p: number) => xs.sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]
  for (const l of LABELS) {
    const xs = all.map((r) => r[l.key as 'cbh' | 'cbd' | 'cover' | 'height'])
    console.log(
      `  ${l.key.padEnd(7)} p5 ${q([...xs], 0.05).toFixed(2)}  median ${q([...xs], 0.5).toFixed(2)}  ` +
      `p95 ${q([...xs], 0.95).toFixed(2)}  ${l.unit}`
    )
  }
}