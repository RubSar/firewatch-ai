/**
 * Burn severity from Sentinel-2 dNBR — ARCHITECTURE.md §3, implemented.
 *
 * Recently burned ground carries little fuel, so a fuel map that does not know
 * about last season's scars over-predicts spread straight across them. This
 * finds those scars by differencing the Normalised Burn Ratio between a recent
 * scene and one about a year earlier: NBR keys on NIR minus SWIR2, and fire
 * moves both hard in opposite directions, which is why it separates burn from
 * drought or harvest far better than a vegetation index does.
 *
 * The output is a GRADED fuel reduction, never a zero-fuel mask. Recently burnt
 * ground is not inert — grass recovers in a season, and a low-severity
 * understorey burn leaves the canopy standing — so §3's table reduces load by
 * class rather than deleting it.
 *
 * Detection window is roughly the last year, because that is what one scene
 * pair sees. Older scars read as unburnt, which is the conservative error: the
 * model keeps the fuel it cannot prove is gone.
 */
import type { BurnHistoryProvider, SeverityGrid, TerrainQuery } from '@firewatch/contracts/providers'
import type { Bounds } from '@firewatch/sim/terrain'
import { prov, synthetic } from './provenance.ts'
import { SCL, sampleBand, searchScenes, sentinelLandCover, type StacItem } from './sentinel.ts'
import type { Config } from '../config.ts'

/**
 * dNBR is only meaningful where something was burnable to begin with.
 *
 * Over water both NIR and SWIR are near zero, so their normalised difference
 * is numerical noise that swings across the severity breaks at random — a
 * 20 km box on Lake Tahoe scored 26% "burnt" before this floor existed. Bare
 * rock and pavement have the same problem more mildly. Requiring the PRE scene
 * to look like living vegetation removes all three, and costs nothing: a cell
 * that was not vegetated cannot have lost vegetation to fire.
 */
const VEGETATED_NBR_MIN = 0.1

/** Key & Benson / USGS breaks, as §3 tabulates them. */
export const SEVERITY_BREAKS = [0.1, 0.27, 0.44, 0.66] as const

/** Fraction of surface fuel REMAINING, by severity class. Mirrors §3. */
export const SURFACE_REMAINING = [1, 0.6, 0.3, 0.15, 0.05] as const

export function severityClass(dnbr: number): number {
  if (!Number.isFinite(dnbr) || dnbr < SEVERITY_BREAKS[0]) return 0
  if (dnbr < SEVERITY_BREAKS[1]) return 1
  if (dnbr < SEVERITY_BREAKS[2]) return 2
  if (dnbr < SEVERITY_BREAKS[3]) return 3
  return 4
}

const nbr = (nir: number, swir: number) =>
  Number.isFinite(nir) && Number.isFinite(swir) && nir + swir !== 0
    ? (nir - swir) / (nir + swir)
    : NaN

interface Scars {
  rbr: Float32Array
  severity: Uint8Array
  yearsSince: Float32Array
  /** Fraction of cells in a burnt class. */
  burntFraction: number
  preDate: string
  postDate: string
}

const cache = new Map<string, { at: number; value: Scars | null }>()
const TTL_MS = 12 * 60 * 60 * 1000
const key = (b: Bounds, c: number, r: number) =>
  `${b.north.toFixed(3)},${b.west.toFixed(3)},${b.south.toFixed(3)},${c}x${r}`

/** Picks the least-cloudy scene whose date falls inside a window. */
function pickIn(items: StacItem[], fromMs: number, toMs: number): StacItem | null {
  const inWindow = items.filter((i) => {
    const t = new Date(i.properties.datetime).getTime()
    return t >= fromMs && t <= toMs && i.assets.nir && i.assets.swir22
  })
  if (!inWindow.length) return null
  return inWindow.sort(
    (a, b) => (a.properties['eo:cloud_cover'] ?? 100) - (b.properties['eo:cloud_cover'] ?? 100)
  )[0]
}

async function detect(
  bounds: Bounds,
  cols: number,
  rows: number,
  cfg: Config
): Promise<Scars | null> {
  // Reuses the cached land-cover read; null simply means the NBR floor works
  // alone, which handles water well enough on its own.
  const land = await sentinelLandCover(bounds, cols, rows, cfg, { deadlineMs: 20000 }).catch(() => null)
  const now = Date.now()
  const DAY = 86400_000
  // Two windows about a year apart. A year rather than a season so the pair is
  // phenologically comparable: differencing spring against autumn would read
  // ordinary leaf-off as a burn scar.
  const recent = await searchScenes(bounds, Math.max(cfg.fetchTimeoutMs, 30000))
  const post = pickIn(recent, now - 120 * DAY, now)
  if (!post) return null

  const postMs = new Date(post.properties.datetime).getTime()
  const older = await searchScenes(
    bounds,
    Math.max(cfg.fetchTimeoutMs, 30000),
    { from: postMs - 430 * DAY, to: postMs - 300 * DAY }
  )
  const pre = pickIn(older, postMs - 430 * DAY, postMs - 300 * DAY)
  if (!pre) return null

  const [preNir, preSwir, postNir, postSwir] = await Promise.all([
    sampleBand(pre, 'nir', bounds, cols, rows),
    sampleBand(pre, 'swir22', bounds, cols, rows),
    sampleBand(post, 'nir', bounds, cols, rows),
    sampleBand(post, 'swir22', bounds, cols, rows),
  ])
  if (!preNir || !preSwir || !postNir || !postSwir) return null

  const n = cols * rows
  const rbr = new Float32Array(n)
  const severity = new Uint8Array(n)
  const yearsSince = new Float32Array(n).fill(99)
  const ageYears = (now - postMs) / (365 * DAY)
  let burnt = 0
  for (let i = 0; i < n; i++) {
    const a = nbr(preNir[i], preSwir[i])
    const b = nbr(postNir[i], postSwir[i])
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    // Nothing that was not vegetated before can have burnt, and pretending
    // otherwise is how open water becomes a high-severity scar.
    if (a < VEGETATED_NBR_MIN) continue
    if (land) {
      const k = land.scl[i]
      if (k === SCL.Water || k === SCL.Snow || k === SCL.CloudHigh || k === SCL.CloudMedium || k === SCL.CloudShadow) {
        continue
      }
    }
    const d = a - b
    // RBR normalises by pre-fire condition, so a scar in sparse desert scrub
    // is not swamped by one in closed forest (Parks et al.).
    rbr[i] = d / (a + 1.001)
    const cls = severityClass(d)
    severity[i] = cls
    if (cls > 0) {
      // The pair only brackets the year between the two scenes, so this is
      // "within the last year", not a date.
      yearsSince[i] = Math.max(0.1, ageYears)
      burnt++
    }
  }
  return {
    rbr,
    severity,
    yearsSince,
    burntFraction: burnt / n,
    preDate: pre.properties.datetime.slice(0, 10),
    postDate: post.properties.datetime.slice(0, 10),
  }
}

/**
 * Four COG reads over flaky S3: measured at 90-120 s when it works at all, and
 * failing outright often enough to matter. Incident creation cannot wait for
 * that, so callers get a deadline and the work continues in the background to
 * warm the cache — the same bargain the land-cover read makes.
 */
const DEADLINE_MS = 4000
const inflight = new Map<string, Promise<Scars | null>>()

export async function burnScarsFor(
  bounds: Bounds, cols: number, rows: number, cfg: Config,
  opts: { deadlineMs?: number } = {}
): Promise<Scars | null> {
  const k = key(bounds, cols, rows)
  const hit = cache.get(k)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value

  let job = inflight.get(k)
  if (!job) {
    job = (async () => {
      let value: Scars | null = null
      try {
        value = await detect(bounds, cols, rows, cfg)
      } catch (err) {
        console.warn(`[burnhistory] ${(err as Error).message}`)
      }
      if (cache.size > 48) cache.clear()
      cache.set(k, { at: Date.now(), value })
      inflight.delete(k)
      return value
    })()
    inflight.set(k, job)
  }

  const deadline = opts.deadlineMs ?? DEADLINE_MS
  let timer: ReturnType<typeof setTimeout>
  const giveUp = new Promise<null>((res) => { timer = setTimeout(() => res(null), deadline) })
  try {
    return await Promise.race([job, giveUp])
  } finally {
    clearTimeout(timer!)
  }
}

export function sentinelBurnHistory(cfg: Config): BurnHistoryProvider {
  return {
    id: 'sentinel2-dnbr',
    fallbacks: [],
    async fetch(q: TerrainQuery) {
      const { bounds, cols, rows } = q.grid
      const scars = await burnScarsFor(bounds, cols, rows, cfg)
      // A miss here is the deadline, not an absence of scars — say which.
      const n = cols * rows
      if (!scars) {
        const data: SeverityGrid = {
          rbr: new Float32Array(n),
          severity: new Uint8Array(n),
          yearsSince: new Float32Array(n).fill(99),
        }
        return {
          data,
          provenance: synthetic(
            'none',
            'Burn scars not loaded — scene pair still fetching or unavailable; fuel is unreduced'
          ),
        }
      }
      return {
        data: { rbr: scars.rbr, severity: scars.severity, yearsSince: scars.yearsSince },
        provenance: prov({
          source: 'sentinel2-dnbr',
          kind: 'derived',
          nativeResolution: 20,
          observedAt: `${scars.postDate}T00:00:00Z`,
          coverage: 1,
          note:
            `Burn severity from dNBR, ${scars.preDate} vs ${scars.postDate} · ` +
            `${(scars.burntFraction * 100).toFixed(1)}% of the area burnt in that window · ` +
            'older scars read as unburnt',
        }),
      }
    },
  }
}
