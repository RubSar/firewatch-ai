/**
 * NASA FIRMS active fire detections — the real IgnitionSource of §9.
 *
 * FIRMS publishes global 24 h CSVs with no API key. It also sends no CORS
 * headers, so the browser cannot read them directly; proxying through here is
 * not a preference, it is the only way. The global VIIRS file is ~6 MB and
 * updates roughly hourly, so it is fetched once and cached rather than pulled
 * per request — a map pan must not cost 6 MB.
 *
 * These are *detections*, not fires: a thermal anomaly is also a gas flare, a
 * furnace or a burning landfill, and a cloudy overpass sees nothing at all.
 * The provenance note says so, because a dot on a map reads as certainty.
 */
import https from 'node:https'
import type { GridSpec, PerimeterObserver, Provenance } from '@firewatch/contracts/providers'
import type { FireDetection } from '@firewatch/contracts/wire'
import { prov } from './provenance.ts'
import { noObservations } from './tier1.ts'
import type { Config } from '../config.ts'

/**
 * Downloads text over node:https rather than fetch().
 *
 * undici — the fetch implementation built into Node — reliably fails against
 * this host with UND_ERR_CONNECT_TIMEOUT after its fixed 10 s connect limit,
 * while curl and node:https both connect in under 200 ms and stream the whole
 * file in ~3 s. The connect timeout is not configurable through the global
 * fetch, so the plain client is the fix, not a workaround to remove later.
 * Tile fetching elsewhere still uses fetch() because those hosts are fine.
 */
function getText(url: string, timeoutMs: number, redirectsLeft = 3): Promise<{ body: string; lastModified: string | null }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'user-agent': 'firewatch-ai/0.1 (wildfire simulation)', accept: 'text/csv,*/*' }, timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'))
          return resolve(getText(new URL(res.headers.location, url).toString(), timeoutMs, redirectsLeft - 1))
        }
        if (status !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${status}`))
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            lastModified: res.headers['last-modified'] ?? null,
          })
        )
        res.on('error', reject)
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error(`timed out after ${timeoutMs} ms`))
    })
    req.on('error', reject)
  })
}

interface Source {
  id: string
  url: string
  /** VIIRS reports a word, MODIS a 0-100 number. */
  confidenceKind: 'word' | 'percent'
  resolutionM: number
}

const SOURCES: Source[] = [
  {
    id: 'viirs-noaa20',
    url: 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv',
    confidenceKind: 'word',
    resolutionM: 375,
  },
  {
    id: 'modis',
    url: 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv',
    confidenceKind: 'percent',
    resolutionM: 1000,
  },
]

/** FIRMS refreshes roughly hourly; re-pulling faster only wastes bandwidth. */
const TTL_MS = 15 * 60 * 1000
/** Hard cap per response so a world-sized bbox cannot flood the browser. */
const MAX_RESULTS = 4000

interface Cached {
  at: number
  observedAt: string | null
  rows: FireDetection[]
  sourceIds: string[]
}

let cache: Cached | null = null
let inflight: Promise<Cached> | null = null

const normaliseConfidence = (raw: string, kind: Source['confidenceKind']): number => {
  if (kind === 'percent') {
    const n = Number(raw)
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n / 100)) : 0.5
  }
  const w = raw.trim().toLowerCase()
  return w === 'high' ? 0.9 : w === 'low' ? 0.2 : 0.55
}

function parseCsv(text: string, src: Source): FireDetection[] {
  const lines = text.split('\n')
  if (lines.length < 2) return []
  const cols = lines[0].trim().split(',')
  const ix = (n: string) => cols.indexOf(n)
  const iLat = ix('latitude')
  const iLng = ix('longitude')
  const iDate = ix('acq_date')
  const iTime = ix('acq_time')
  const iConf = ix('confidence')
  const iFrp = ix('frp')
  const iSat = ix('satellite')
  const iDn = ix('daynight')
  // Brightness column differs between instruments.
  const iBright = ix('bright_ti4') >= 0 ? ix('bright_ti4') : ix('brightness')
  if (iLat < 0 || iLng < 0) return []

  const out: FireDetection[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const f = line.split(',')
    const lat = Number(f[iLat])
    const lng = Number(f[iLng])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    // acq_time is HHMM, sometimes without the leading zero.
    const hhmm = (f[iTime] ?? '0').padStart(4, '0')
    out.push({
      lat,
      lng,
      at: `${f[iDate]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`,
      frp: Number(f[iFrp]) || 0,
      brightness: Number(f[iBright]) || 0,
      confidence: normaliseConfidence(f[iConf] ?? '', src.confidenceKind),
      satellite: f[iSat] ?? src.id,
      day: (f[iDn] ?? '').trim().toUpperCase() === 'D',
      resolutionM: src.resolutionM,
    })
  }
  return out
}

async function fetchAll(cfg: Config): Promise<Cached> {
  let lastError = 'unknown'
  const results = await Promise.all(
    SOURCES.map(async (src) => {
      try {
        const { body, lastModified } = await getText(src.url, Math.max(cfg.fetchTimeoutMs, 60000))
        return {
          id: src.id,
          rows: parseCsv(body, src),
          observedAt: lastModified ? new Date(lastModified).toISOString() : null,
        }
      } catch (err) {
        // One instrument failing still leaves a usable picture from the other.
        lastError = `${src.id}: ${(err as Error).message}`
        return { id: src.id, rows: [] as FireDetection[], observedAt: null }
      }
    })
  )
  const ok = results.filter((r) => r.rows.length)
  if (!ok.length) throw new Error(`no FIRMS source returned data (${lastError})`)
  return {
    at: Date.now(),
    observedAt: ok.map((r) => r.observedAt).filter(Boolean).sort().pop() ?? null,
    rows: ok.flatMap((r) => r.rows),
    sourceIds: ok.map((r) => r.id),
  }
}

async function load(cfg: Config): Promise<Cached> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache
  // Collapse concurrent misses onto one fetch: several clients toggling the
  // layer at once must not each pull 6 MB.
  if (!inflight) {
    inflight = fetchAll(cfg)
      .then((c) => {
        cache = c
        return c
      })
      .finally(() => {
        inflight = null
      })
  }
  try {
    return await inflight
  } catch (err) {
    // Stale data beats no data for something that refreshes hourly.
    if (cache) return cache
    throw err
  }
}

export interface FireQuery {
  north: number
  south: number
  east: number
  west: number
}

export async function activeFires(
  q: FireQuery,
  cfg: Config
): Promise<{ detections: FireDetection[]; provenance: Provenance; truncated: boolean }> {
  const c = await load(cfg)
  const hit = c.rows.filter(
    (d) => d.lat <= q.north && d.lat >= q.south && d.lng <= q.east && d.lng >= q.west
  )
  // Keep the strongest when trimming: a capped view should show the fires that
  // matter, not an arbitrary prefix of the file.
  const truncated = hit.length > MAX_RESULTS
  const detections = truncated
    ? [...hit].sort((a, b) => b.frp - a.frp).slice(0, MAX_RESULTS)
    : hit

  const ageMin = c.observedAt
    ? Math.round((Date.now() - new Date(c.observedAt).getTime()) / 60000)
    : null

  return {
    detections,
    truncated,
    provenance: prov({
      source: `nasa-firms:${c.sourceIds.join('+')}`,
      kind: 'measured',
      nativeResolution: c.sourceIds.includes('viirs-noaa20') ? 375 : 1000,
      observedAt: c.observedAt,
      coverage: 1,
      note:
        `NASA FIRMS active fire detections, last 24 h` +
        (ageMin !== null ? ` · file ${ageMin} min old` : '') +
        ' · thermal anomalies, not confirmed fires',
    }),
  }
}

/**
 * The same detections as the map layer, rasterised onto the incident grid —
 * the real `PerimeterObserver` of §9, replacing `NoObservations`.
 *
 * Two things this is not. It is not a perimeter: VIIRS pixels are 375 m and
 * MODIS 1 km, so each detection is painted as the square it actually is, and a
 * 40 ha fire is one blob either way. And it is not continuous: two overpasses a
 * day means the fire is unobserved for hours at a time. §6's assimilation loop
 * needs better than this to do anything useful — what it buys today is that the
 * port is wired, so a drone IR feed is one line in `registry.ts`.
 *
 * Zero detections is a *measured* result, not a missing one, and the note says
 * so. Confusing the two is how a quiet day starts looking like a broken feed.
 */
const OBSERVER_DEADLINE_MS = 6000

export function firmsPerimeter(cfg: Config): PerimeterObserver {
  return {
    id: 'firms-perimeter',
    fallbacks: [noObservations],
    async fetch(q: { grid: GridSpec; at: string }) {
      const { cols, rows, bounds, cellSize } = q.grid

      // The global CSV is ~6 MB on a cold cache and incident creation must not
      // block on it. Losing the race falls back to no-observations while the
      // download keeps going in the background, so the next incident has it.
      const pending = activeFires(bounds, cfg)
      pending.catch(() => undefined)
      let timer: ReturnType<typeof setTimeout> | undefined
      const got = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('FIRMS not cached yet')), OBSERVER_DEADLINE_MS)
        }),
      ]).finally(() => clearTimeout(timer))

      const burning = new Uint8Array(cols * rows)
      const maxTemp = new Float32Array(cols * rows)
      let lit = 0
      let footprint = 0

      for (const d of got.detections) {
        // A detection is a pixel, not a point: paint the square the sensor
        // actually integrated over, or a 375 m anomaly lands on one 38 m cell.
        const half = Math.max(0, Math.round(d.resolutionM / 2 / cellSize))
        footprint = Math.max(footprint, d.resolutionM)
        const cx = Math.floor(((d.lng - bounds.west) / (bounds.east - bounds.west)) * cols)
        const cy = Math.floor(((bounds.north - d.lat) / (bounds.north - bounds.south)) * rows)
        for (let r = cy - half; r <= cy + half; r++) {
          for (let c = cx - half; c <= cx + half; c++) {
            if (c < 0 || r < 0 || c >= cols || r >= rows) continue
            const i = r * cols + c
            if (!burning[i]) { burning[i] = 1; lit++ }
            if (d.brightness > maxTemp[i]) maxTemp[i] = d.brightness
          }
        }
      }

      return {
        // No detections means no radiometry either; null says "not observed"
        // where an all-zero array would read as "observed to be 0 K".
        data: { burning, maxTemp: lit ? maxTemp : null },
        provenance: prov({
          source: got.provenance.source,
          kind: 'measured',
          nativeResolution: footprint || got.provenance.nativeResolution,
          observedAt: got.provenance.observedAt,
          coverage: 1,
          note: got.detections.length
            ? `${got.detections.length} FIRMS detection(s) here in the last 24 h, painted as ` +
              `${footprint} m pixels over ${lit} cells — thermal anomalies, not a mapped perimeter`
            : 'No FIRMS detections here in the last 24 h — an observation of nothing, not a missing feed',
        }),
      }
    },
  }
}
