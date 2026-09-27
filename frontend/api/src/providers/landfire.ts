/**
 * LANDFIRE FBFM40 as the fuel source inside CONUS — §9 `FuelProvider`.
 *
 * FBFM40 is the Scott & Burgan (2005) 40-model set, and it is what FARSITE and
 * FlamMap are actually run against in the United States. Reading it directly beats
 * classifying imagery or crosswalking land cover, for the same reason ESA
 * WorldCover beat the visible-band proxy: someone has already done the work, with
 * field calibration this project cannot replicate.
 *
 * It matters more than a provider swap usually would, because EVERY hindcast fire
 * is in CONUS. So this is not only a better fuel map for US domains, it puts the
 * project's only end-to-end accuracy measurement onto operational fuel data.
 *
 * WHAT THIS DOES NOT YET DO. The kernel has seven single-load fuel beds; FBFM40
 * has forty multi-size-class ones. The crosswalk below therefore throws most of
 * the information away — GR1 and GR9 differ by a factor of twenty in load and both
 * land on `Fuel.Grass`. The real prize is Scott & Burgan's published bed
 * parameters (load by size class, depth, SAV), which would replace the invented
 * `depth`/`sav`/`bulkDensity` in fuels.ts and make the bench's Rothermel reference
 * valid — our timber depth is 0.65 m against FM8's published 0.061. That needs
 * multi-size-class Rothermel in the kernel first. This provider is the step that
 * makes the labels available; it is not the payoff.
 *
 * Outside CONUS the service returns nothing and this throws, so the chain falls
 * back to WorldCover. That boundary is the whole reason a learned fuel model
 * would ever be worth training — and the canopy experiment says to measure that
 * before believing it.
 */
import { fromArrayBuffer } from 'geotiff'
import type { FuelGrid, FuelProvider, TerrainQuery } from '@firewatch/contracts/providers'
import type { Bounds } from '@firewatch/sim/terrain'
import { Fuel } from '@firewatch/sim/fuels'
import type { Config } from '../config.ts'
import { prov } from './provenance.ts'
import { expand, worldCoverFuel } from './tier1.ts'

const LF2023 = 'https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2023'

/**
 * FBFM40 code -> this kernel's fuel class.
 *
 * Codes are Scott & Burgan's: 91-99 are the non-burnable and special classes,
 * then GR grass 101-109, GS grass-shrub 121-124, SH shrub 141-149, TU
 * timber-understorey 161-165, TL timber litter 181-189, SB slash-blowdown
 * 201-204.
 *
 * Two judgements worth naming. GS (grass-shrub) goes to Grass because those
 * models are grass-driven — the shrub component raises intensity but the grass
 * carries the fire. SB (slash and blowdown) goes to Timber because it is downed
 * woody fuel; it spreads faster than TL and nothing here represents that.
 */
function fbfm40ToFuel(code: number): number | null {
  if (code === 91) return Fuel.Urban
  // Snow and ice: unburnable, and Barren is this kernel's unburnable land class.
  if (code === 92) return Fuel.Barren
  if (code === 93) return Fuel.Agriculture
  if (code === 98) return Fuel.Water
  if (code === 99) return Fuel.Barren
  if (code >= 101 && code <= 109) return Fuel.Grass
  if (code >= 121 && code <= 124) return Fuel.Grass
  if (code >= 141 && code <= 149) return Fuel.Shrub
  if (code >= 161 && code <= 165) return Fuel.Timber
  if (code >= 181 && code <= 189) return Fuel.Timber
  if (code >= 201 && code <= 204) return Fuel.Timber
  return null
}

/** Human-readable family, for the provenance note. */
function fbfm40Family(code: number): string {
  if (code >= 101 && code <= 109) return 'GR grass'
  if (code >= 121 && code <= 124) return 'GS grass-shrub'
  if (code >= 141 && code <= 149) return 'SH shrub'
  if (code >= 161 && code <= 165) return 'TU timber-understorey'
  if (code >= 181 && code <= 189) return 'TL timber litter'
  if (code >= 201 && code <= 204) return 'SB slash-blowdown'
  if (code === 91) return 'urban'
  if (code === 93) return 'agriculture'
  if (code === 98) return 'water'
  if (code === 99 || code === 92) return 'barren/snow'
  return `code ${code}`
}

/**
 * Reads FBFM40 onto a grid via ArcGIS `exportImage`.
 *
 * NEAREST NEIGHBOUR IS NOT OPTIONAL. FBFM40 is categorical, and any interpolating
 * resample averages code numbers — halfway between GR2 (102) and TL4 (184) is 143,
 * which is SH3, a fuel model that exists and is nothing like either neighbour.
 * Bilinear here would silently invent fuels along every class boundary.
 *
 * `exportImage` rather than the point-sampling endpoint: a 400x400 grid is 160,000
 * cells, and `getSamples` caps at a few hundred points per call.
 */
async function readFbfm40(
  bounds: Bounds,
  cols: number,
  rows: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Int16Array | null> {
  const qs = new URLSearchParams({
    bbox: `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`,
    bboxSR: '4326',
    size: `${cols},${rows}`,
    imageSR: '4326',
    format: 'tiff',
    pixelType: 'S16',
    interpolation: 'RSP_NearestNeighbor',
    f: 'image',
  })
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`${LF2023}/LF2023_FBFM40_CONUS/ImageServer/exportImage?${qs}`, {
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`LANDFIRE FBFM40 ${res.status}`)
    const type = res.headers.get('content-type') ?? ''
    // An out-of-extent or malformed request answers 200 with a JSON error body,
    // not a TIFF. Checking the type turns that into a clean fallback instead of a
    // geotiff parse exception.
    if (!type.includes('tiff')) {
      throw new Error(`LANDFIRE FBFM40 returned ${type || 'no content-type'}, not a TIFF`)
    }
    const buf = await res.arrayBuffer()
    const img = await (await fromArrayBuffer(buf)).getImage()
    if (img.getWidth() !== cols || img.getHeight() !== rows) {
      throw new Error(`FBFM40 returned ${img.getWidth()}x${img.getHeight()}, expected ${cols}x${rows}`)
    }
    const [band] = await img.readRasters()
    return Int16Array.from(band as ArrayLike<number>)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    void onAbort
  }
}

/** Below this fraction of recognised codes, assume the domain is outside CONUS. */
const MIN_COVERAGE = 0.9

export function fbfm40Fuel(cfg: Config): FuelProvider {
  return {
    id: 'landfire-fbfm40',
    fallbacks: [worldCoverFuel(cfg)],
    async fetch(q: TerrainQuery, signal?: AbortSignal) {
      const { cols, rows, bounds } = q.grid
      const codes = await readFbfm40(bounds, cols, rows, Math.max(cfg.fetchTimeoutMs, 45000), signal)
      if (!codes) throw new Error('FBFM40 unavailable')

      const n = cols * rows
      const fuelId = new Uint8Array(n)
      const byFamily = new Map<string, number>()
      let recognised = 0
      for (let i = 0; i < n; i++) {
        const mapped = fbfm40ToFuel(codes[i])
        if (mapped == null) {
          // Unrecognised or nodata. Barren is inert, so an unmapped cell cannot
          // burn rather than defaulting into something that does.
          fuelId[i] = Fuel.Barren
          continue
        }
        fuelId[i] = mapped
        recognised++
        const fam = fbfm40Family(codes[i])
        byFamily.set(fam, (byFamily.get(fam) ?? 0) + 1)
      }

      const coverage = recognised / n
      if (coverage < MIN_COVERAGE) {
        throw new Error(
          `FBFM40 recognised only ${(coverage * 100).toFixed(0)}% of cells — outside CONUS`
        )
      }

      const top = [...byFamily.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k} ${((v / n) * 100).toFixed(0)}%`)
        .join(', ')
      const distinct = new Set(Array.from(codes).filter((c) => fbfm40ToFuel(c) != null)).size

      const data: FuelGrid = expand(fuelId)
      return {
        data,
        provenance: prov({
          source: 'landfire-lf2023-fbfm40',
          // 'derived', not 'measured': FBFM40 itself is an operational product,
          // but what reaches the kernel is a 40-to-7 crosswalk that discards the
          // load and depth distinctions those 40 models exist to express.
          kind: 'derived',
          nativeResolution: 30,
          observedAt: '2023-12-31T00:00:00Z',
          coverage,
          note:
            `LANDFIRE LF2023 FBFM40 (Scott & Burgan) · ${top} · ` +
            `${distinct} distinct models crosswalked to ${new Set(fuelId).size} kernel classes — ` +
            'the crosswalk discards load and depth distinctions; Scott & Burgan bed ' +
            'parameters need multi-size-class Rothermel first',
        }),
      }
    },
  }
}
