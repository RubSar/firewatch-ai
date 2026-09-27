/**
 * Tier 2 providers — weather, wind field, fuel moisture.
 *
 * Open-Meteo is the one real feed wired here: no key, small JSON, and it covers
 * Armenia. It is the cheapest real data in the whole system, which is why it is
 * real while the Tier 1 heavyweights stay mocked.
 */
import { fuelMoisture, getPreset, mockForecast } from '@firewatch/sim/weather'
import type { Weather } from '@firewatch/sim/weather'
import type { Bounds } from '@firewatch/sim/terrain'
import type {
  ElevationGrid, FuelMoistureModel, GridSpec, Observation,
  WeatherProvider, WindField, WindFieldProvider,
} from '@firewatch/contracts/providers'
import { prov, synthetic } from './provenance.ts'
import type { Config } from '../config.ts'

const FORECAST_START_HOUR = 13

/**
 * Daily rainfall that actually ends a drought, mm. A trace evaporates the same
 * afternoon without recharging dead fuels, so counting it would reset the
 * clock on a day that changed nothing.
 */
const WETTING_MM = 2
/**
 * How far back to look for that rain. `fuelMoisture()` saturates its drought
 * term at 60 days, so anything past this cannot change the model — the number
 * is reported as a floor rather than pretending to be exact.
 */
const LOOKBACK_DAYS = 61

export function mockWeather(presetId: string): WeatherProvider {
  return {
    id: 'mock-forecast',
    fallbacks: [],
    async fetch(q: { bounds: Bounds; hours: number }) {
      const base = getPreset(presetId).weather
      const hourly = mockForecast(base, FORECAST_START_HOUR)
      const now = new Date()
      const forecast: Observation[] = hourly.slice(0, q.hours).map((w, i) => ({
        ...w,
        at: new Date(now.getTime() + i * 3600_000).toISOString(),
      }))
      return {
        data: { current: forecast[0] ?? { ...base, at: now.toISOString() }, forecast },
        provenance: synthetic('mock-forecast', `Mock ${presetId} forecast — synthetic weather`),
      }
    },
  }
}

/**
 * Open-Meteo hourly forecast. Free, keyless, ~10 kB of JSON.
 * Maps to the same Weather shape the sliders produce, so nothing downstream
 * can tell which one it got.
 */
export function openMeteo(cfg: Config, presetId: string): WeatherProvider {
  return {
    id: 'open-meteo',
    fallbacks: [mockWeather(presetId)],
    async fetch(q: { bounds: Bounds; hours: number }, signal?: AbortSignal) {
      const lat = (q.bounds.north + q.bounds.south) / 2
      const lng = (q.bounds.east + q.bounds.west) / 2
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
        `&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation` +
        `&forecast_days=2&timezone=UTC`

      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), cfg.fetchTimeoutMs)
      const onAbort = () => ac.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      let json: OpenMeteoResponse
      try {
        const res = await fetch(url, { signal: ac.signal })
        if (!res.ok) throw new Error(`open-meteo ${res.status}`)
        json = (await res.json()) as OpenMeteoResponse
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }

      const h = json.hourly
      if (!h?.time?.length) throw new Error('open-meteo returned no hourly data')

      // Days since rain is measured from the precipitation history, not carried
      // from the preset: it was the one invented number inside a port labelled
      // `measured`. If that second call fails the preset still covers it, and
      // the note says which of the two happened.
      const drought = await droughtSince(cfg, lat, lng, signal).catch(() => null)
      const droughtDays = drought?.days ?? getPreset(presetId).weather.daysSinceRain
      // The feed starts at 00:00 UTC today, so row 0 is midnight. Starting
      // there would drive an afternoon incident with overnight weather — cool,
      // damp and calm — and badly under-predict. Seek to the current hour.
      const nowMs = Date.now()
      let start = h.time.findIndex((t) => new Date(`${t}Z`).getTime() + 3600_000 > nowMs)
      if (start < 0) start = 0

      const count = Math.min(q.hours, h.time.length - start)
      const forecast: Observation[] = []
      // The drought clock runs forward through the forecast and resets when it
      // rains, so a rain band in hour 6 damps the fuels from hour 6 — the same
      // thing `mockForecast` does, driven by a real number.
      let sinceRain = droughtDays
      for (let k = 0; k < count; k++) {
        const i = start + k
        const speed = h.wind_speed_10m[i] ?? 0
        const gust = h.wind_gusts_10m?.[i] ?? speed
        const when = new Date(`${h.time[i]}Z`)
        const precip = h.precipitation?.[i] ?? 0
        if (k > 0) sinceRain = precip >= WETTING_MM / 24 ? 0 : sinceRain + 1 / 24
        forecast.push({
          at: when.toISOString(),
          // hour is relative to the start of the run, matching mockForecast, so
          // the forecast strip never branches on where the weather came from.
          hour: k,
          clock: `${String(when.getUTCHours()).padStart(2, '0')}:00`,
          temperature: h.temperature_2m[i] ?? 20,
          humidity: h.relative_humidity_2m[i] ?? 40,
          windSpeed: speed,
          windDir: h.wind_direction_10m[i] ?? 0,
          gustiness: speed > 0.5 ? Math.max(0, Math.min(1, (gust - speed) / speed)) : 0,
          daysSinceRain: sinceRain,
          precipitation: precip,
        })
      }
      return {
        data: { current: forecast[0], forecast },
        provenance: prov({
          source: 'open-meteo',
          kind: 'measured',
          nativeResolution: null,
          observedAt: forecast[0].at,
          coverage: 1,
          note:
            `Live forecast · Open-Meteo from ${forecast[0].clock} UTC · ` +
            (drought
              ? `${drought.capped ? '≥' : ''}${Math.round(drought.days)} d since ${WETTING_MM} mm of rain`
              : `drought carried from ${presetId} preset — no precipitation history`),
        }),
      }
    },
  }
}

/**
 * Days since the last wetting rain, from Open-Meteo's daily precipitation.
 *
 * A separate call rather than `past_days` on the hourly one: 61 days of hourly
 * rows is ~1500 records of six variables to answer a question that 61 daily
 * sums answer in a few kilobytes.
 */
async function droughtSince(
  cfg: Config, lat: number, lng: number, signal?: AbortSignal
): Promise<{ days: number; capped: boolean }> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&daily=precipitation_sum&past_days=${LOOKBACK_DAYS}&forecast_days=1&timezone=UTC`

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), cfg.fetchTimeoutMs)
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let sums: (number | null)[]
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) throw new Error(`open-meteo daily ${res.status}`)
    const json = (await res.json()) as { daily?: { precipitation_sum?: (number | null)[] } }
    sums = json.daily?.precipitation_sum ?? []
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (!sums.length) throw new Error('open-meteo returned no daily precipitation')

  // Rows are ascending and the last one is today, partial but real: rain this
  // morning means zero days since rain, not one.
  const last = sums.length - 1
  for (let i = last; i >= 0; i--) {
    if ((sums[i] ?? 0) >= WETTING_MM) return { days: last - i, capped: false }
  }
  return { days: sums.length, capped: true }
}

interface OpenMeteoResponse {
  hourly?: {
    time: string[]
    temperature_2m: number[]
    relative_humidity_2m: number[]
    wind_speed_10m: number[]
    wind_direction_10m: number[]
    wind_gusts_10m?: number[]
    precipitation?: number[]
  }
}

/**
 * Uniform wind — ARCHITECTURE.md §5 wants WindNinja at 100 m here. Until then
 * every cell gets the same vector, which is exactly the simplification the doc
 * names as the biggest unmodelled error in steep ground.
 */
export const uniformWind: WindFieldProvider = {
  id: 'uniform-wind',
  fallbacks: [],
  async fetch(q: { grid: GridSpec; elevation: ElevationGrid; at: Observation }) {
    const n = q.grid.cols * q.grid.rows
    // windDir is the direction the wind comes FROM; convert to a "toward" vector.
    const toward = ((q.at.windDir + 180) % 360) * (Math.PI / 180)
    const s = q.at.windSpeed / 3.6
    const data: WindField = {
      // u east, v north — the meteorological convention the contract fixes.
      u: new Float32Array(n).fill(Math.sin(toward) * s),
      v: new Float32Array(n).fill(Math.cos(toward) * s),
      resolution: Number.POSITIVE_INFINITY,
    }
    return {
      data,
      provenance: synthetic('uniform', 'Uniform wind field — no terrain downscaling (WindNinja not wired)'),
    }
  },
}

/** RH-driven scalar, broadcast per cell. An NFDRS timelag model replaces this. */
export const rhFuelMoisture: FuelMoistureModel = {
  id: 'rh-fuel-moisture',
  compute(grid: GridSpec, weather: Observation) {
    const fmc = fuelMoisture(weather as Weather)
    return {
      data: new Float32Array(grid.cols * grid.rows).fill(fmc),
      provenance: synthetic('rh-formula', 'Dead fine fuel moisture from RH/temp/drought — single global value'),
    }
  },
}

// --- real wind field ----------------------------------------------------

/**
 * Wind sampled from Open-Meteo on a lattice and interpolated onto the grid.
 *
 * Not WindNinja — there is no terrain downscaling here, so ridge acceleration
 * and valley sheltering are still missing (ARCHITECTURE.md §5). What it does
 * fix is the larger error: a 15 km domain spans several cells of any real
 * forecast grid, and collapsing that to one vector for the whole fire is the
 * biggest avoidable simplification in a model where wind dominates (§7).
 *
 * Stored as an ANOMALY rather than absolute wind: `speedRatio` is local speed
 * over the domain mean and `veerDeg` is the local turn from the mean bearing.
 * That keeps the wind slider meaningful — the user sets the strength, the data
 * supplies the shape — instead of a real field silently overriding the control
 * the whole sandbox is built around.
 */
export interface WindAnomaly {
  speedRatio: Float32Array
  veerDeg: Float32Array
  /** Metres between lattice samples on the ground. */
  resolution: number
  meanSpeedKmh: number
  meanDirDeg: number
  model: string
}

/** Lattice side length. Finer than the forecast grid buys nothing. */
function latticeSide(spanKm: number) {
  return Math.max(2, Math.min(5, Math.round(spanKm / 4)))
}

const bilinear = (a: number, b: number, c: number, d: number, tx: number, ty: number) =>
  a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty

/** Circular mean of bearings — averaging 350° and 10° as numbers gives 180°. */
function meanBearing(degs: number[]): number {
  let x = 0
  let y = 0
  for (const d of degs) {
    x += Math.cos((d * Math.PI) / 180)
    y += Math.sin((d * Math.PI) / 180)
  }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** Smallest signed turn from a to b, in degrees. */
const veer = (from: number, to: number) => ((to - from + 540) % 360) - 180

export async function fetchWindAnomaly(
  bounds: Bounds,
  cols: number,
  rows: number,
  cfg: Config,
  signal?: AbortSignal
): Promise<WindAnomaly | null> {
  const midLat = (bounds.north + bounds.south) / 2
  const spanKm = ((bounds.east - bounds.west) * 111.32 * Math.cos((midLat * Math.PI) / 180))
  const k = latticeSide(spanKm)

  const lats: number[] = []
  const lngs: number[] = []
  for (let r = 0; r < k; r++) {
    for (let c = 0; c < k; c++) {
      lats.push(bounds.north - ((r + 0.5) / k) * (bounds.north - bounds.south))
      lngs.push(bounds.west + ((c + 0.5) / k) * (bounds.east - bounds.west))
    }
  }

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lats.map((v) => v.toFixed(4)).join(',')}` +
    `&longitude=${lngs.map((v) => v.toFixed(4)).join(',')}` +
    `&hourly=wind_speed_10m,wind_direction_10m&forecast_days=1&timezone=UTC`

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), cfg.fetchTimeoutMs)
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let rows_: OpenMeteoPoint[]
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) throw new Error(`open-meteo wind ${res.status}`)
    const json = await res.json()
    rows_ = Array.isArray(json) ? json : [json]
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (rows_.length !== k * k) return null

  const hour = new Date().getUTCHours()
  const speeds: number[] = []
  const dirs: number[] = []
  for (const r of rows_) {
    const h = r.hourly
    const i = Math.min(hour, (h?.wind_speed_10m?.length ?? 1) - 1)
    speeds.push(h?.wind_speed_10m?.[i] ?? 0)
    dirs.push(h?.wind_direction_10m?.[i] ?? 0)
  }
  const meanSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length
  const meanDir = meanBearing(dirs)
  // A dead-calm forecast carries no usable shape and would divide by ~zero.
  if (meanSpeed < 0.5) return null

  const ratioL = speeds.map((s) => s / meanSpeed)
  const veerL = dirs.map((d) => veer(meanDir, d))

  const speedRatio = new Float32Array(cols * rows)
  const veerDeg = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++) {
    const fy = Math.min(k - 1.0001, Math.max(0, ((r + 0.5) / rows) * k - 0.5))
    const y0 = Math.floor(fy)
    const ty = fy - y0
    for (let c = 0; c < cols; c++) {
      const fx = Math.min(k - 1.0001, Math.max(0, ((c + 0.5) / cols) * k - 0.5))
      const x0 = Math.floor(fx)
      const tx = fx - x0
      const at = (yy: number, xx: number) => Math.min(k - 1, yy) * k + Math.min(k - 1, xx)
      const i = r * cols + c
      speedRatio[i] = bilinear(ratioL[at(y0, x0)], ratioL[at(y0, x0 + 1)], ratioL[at(y0 + 1, x0)], ratioL[at(y0 + 1, x0 + 1)], tx, ty)
      veerDeg[i] = bilinear(veerL[at(y0, x0)], veerL[at(y0, x0 + 1)], veerL[at(y0 + 1, x0)], veerL[at(y0 + 1, x0 + 1)], tx, ty)
    }
  }

  return {
    speedRatio,
    veerDeg,
    resolution: (spanKm * 1000) / k,
    meanSpeedKmh: meanSpeed,
    meanDirDeg: meanDir,
    model: `open-meteo ${k}x${k} lattice`,
  }
}

interface OpenMeteoPoint {
  hourly?: { wind_speed_10m?: number[]; wind_direction_10m?: number[] }
}

// --- real fuel moisture -------------------------------------------------

/**
 * Dead fine fuel moisture from an NFDRS-style 1-hour timelag model, driven by
 * Open-Meteo's recent hourly history.
 *
 * The formula this replaces evaluated a snapshot: it had no memory, so rain
 * that fell yesterday had no effect whatsoever and the drought signal came
 * from a hand-set `daysSinceRain` on the preset. A timelag model integrates
 * toward the equilibrium moisture content hour by hour, so the fuels are wet
 * after rain and dry out at a rate the weather sets rather than a slider.
 *
 * Two honest limits: the history is one point for the whole domain (the
 * spatial part is a terrain adjustment, not an observation), and 1-hour fuels
 * equilibrate within hours, so a week of history mostly buys correct behaviour
 * around rain rather than a true drought signal — that lives in the 10/100/1000
 * hour classes this model does not carry.
 */
const HISTORY_DAYS = 7
const HISTORY_TTL_MS = 30 * 60 * 1000
/** Saturation 1-h fuels approach in rain, %. */
const RAIN_SATURATION = 35

interface History {
  at: number
  /** Moisture after integrating the whole record, %. */
  settled: number
  /** Hours since the last wet hour IN THE RECORD, so bounded by its length. */
  hoursSinceRain: number
  /** False means no rain fell in the window — not that it has never rained. */
  sawRain: boolean
  observedAt: string | null
}

const historyCache = new Map<string, History>()
const historyInflight = new Map<string, Promise<History | null>>()

/**
 * One hour of 1-h fuel moisture, stepped toward equilibrium.
 *
 * Exported because the hindcast has to run the SAME model the product runs.
 * It could not simply call `nfdrs1hMoisture`: that seeds itself from
 * `warmMoistureHistory`, which fetches `past_days=7` relative to NOW, so
 * replaying a fire from March would settle its fuels against September weather.
 * The hindcast has correctly dated archive hours of its own and needs only the
 * integrator, so the integrator is what is shared.
 *
 * Rain drives fine fuels toward saturation far faster than drying returns them —
 * wetting is minutes, drying is hours — hence the two time constants.
 */
export function stepOneHourMoisture(
  prev: number,
  tempC: number,
  rh: number,
  precipMm: number
): number {
  const wet = precipMm > 0.1
  const target = wet ? Math.min(RAIN_SATURATION, 10 + precipMm * 12) : equilibriumMoisture(tempC, rh)
  const tau = wet ? 0.3 : 1.0
  return target + (prev - target) * Math.exp(-1 / tau)
}

/** Simard's equilibrium moisture content. T in Celsius, RH in %. */
export function equilibriumMoisture(tempC: number, rh: number): number {
  const t = tempC * 1.8 + 32
  const h = Math.max(0, Math.min(100, rh))
  if (h < 10) return 0.03229 + 0.281073 * h - 0.000578 * h * t
  if (h < 50) return 2.22749 + 0.160107 * h - 0.014784 * t
  return 21.0606 + 0.005565 * h * h - 0.00035 * h * t - 0.483199 * h
}

async function fetchHistory(bounds: Bounds, cfg: Config): Promise<History | null> {
  const lat = (bounds.north + bounds.south) / 2
  const lng = (bounds.east + bounds.west) / 2
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&hourly=temperature_2m,relative_humidity_2m,precipitation&past_days=${HISTORY_DAYS}` +
    `&forecast_days=1&timezone=UTC`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), cfg.fetchTimeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) throw new Error(`open-meteo history ${res.status}`)
    const json = (await res.json()) as {
      hourly?: { time: string[]; temperature_2m: number[]; relative_humidity_2m: number[]; precipitation: number[] }
    }
    const h = json.hourly
    if (!h?.time?.length) return null

    const nowMs = Date.now()
    let m = equilibriumMoisture(h.temperature_2m[0] ?? 20, h.relative_humidity_2m[0] ?? 40)
    // Counted from the start of the record, so it can never exceed it. Whether
    // rain fell before the window is simply unknown, and `sawRain` says so
    // rather than the count quietly implying a longer dry spell than observed.
    let hoursSinceRain = 0
    let sawRain = false
    let counted = 0
    for (let i = 0; i < h.time.length; i++) {
      if (new Date(`${h.time[i]}Z`).getTime() > nowMs) break
      const rain = h.precipitation[i] ?? 0
      // Rain drives 1-h fuels toward saturation far faster than drying
      // returns them: wetting is minutes, drying is hours.
      m = stepOneHourMoisture(m, h.temperature_2m[i] ?? 20, h.relative_humidity_2m[i] ?? 40, rain)
      if (rain > 0.1) {
        hoursSinceRain = 0
        sawRain = true
      } else {
        hoursSinceRain++
      }
      counted = i
    }
    return {
      at: Date.now(),
      settled: m,
      hoursSinceRain,
      sawRain,
      observedAt: h.time[Math.max(0, counted)] ? `${h.time[counted]}Z` : null,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const histKey = (b: Bounds) => `${b.north.toFixed(3)},${b.west.toFixed(3)}`

/** Warms the history cache so `compute` has real data to work from. */
export async function warmMoistureHistory(bounds: Bounds, cfg: Config): Promise<History | null> {
  const k = histKey(bounds)
  const hit = historyCache.get(k)
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit
  let job = historyInflight.get(k)
  if (!job) {
    job = fetchHistory(bounds, cfg).then((h) => {
      if (h) historyCache.set(k, h)
      historyInflight.delete(k)
      return h
    })
    historyInflight.set(k, job)
  }
  return job
}

/**
 * Per-cell moisture: the history-settled value stepped once toward the current
 * weather's equilibrium, then adjusted for terrain.
 *
 * The terrain part is an adjustment and not an observation — a sun-facing slope
 * really is drier than the gully beside it, but the size of that difference
 * here is assumed, not measured.
 */
export function nfdrs1hMoisture(cfg: Config): FuelMoistureModel {
  return {
    id: 'nfdrs-1h-timelag',
    compute(grid: GridSpec, weather: Observation, elevation: ElevationGrid) {
      const { cols, rows, cellSize, bounds } = grid
      const hist = historyCache.get(histKey(bounds))
      // Nothing fetched yet: fall back to the memoryless formula rather than
      // block. The warm call fills the cache for the next evaluation.
      void warmMoistureHistory(bounds, cfg)

      const base = hist
        ? stepOneHourMoisture(hist.settled, weather.temperature, weather.humidity, weather.precipitation)
        : fuelMoisture(weather as Weather)

      const midLat = (bounds.north + bounds.south) / 2
      const northern = midLat >= 0
      const data = new Float32Array(cols * rows)
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c
          const e = elevation.elevation
          const at = (cc: number, rr: number) =>
            e[Math.min(rows - 1, Math.max(0, rr)) * cols + Math.min(cols - 1, Math.max(0, cc))]
          const dzdx = (at(c + 1, r) - at(c - 1, r)) / (2 * cellSize)
          const dzdy = (at(c, r + 1) - at(c, r - 1)) / (2 * cellSize)
          const grad = Math.hypot(dzdx, dzdy)
          // +1 faces the equator (sun-facing, drier), -1 faces the pole.
          const sunward = grad > 1e-4 ? (northern ? -dzdy : dzdy) / grad : 0
          const steep = Math.min(1, Math.atan(grad) / 0.7)
          // Sun-facing slopes run drier; the effect grows with steepness.
          let m = base * (1 - 0.2 * sunward * steep)
          // Lapse rate: cooler higher ground holds a little more moisture.
          m *= 1 + 0.00004 * Math.max(0, e[i] - elevation.minElev)
          data[i] = Math.min(60, Math.max(1.5, m))
        }
      }

      const note = hist
        ? `NFDRS 1-h timelag over ${HISTORY_DAYS} d of Open-Meteo history` +
          ` · ${hist.sawRain ? `rain ${hist.hoursSinceRain} h ago` : `no rain in ${HISTORY_DAYS} d`}` +
          ' · terrain aspect adjustment assumed'
        : 'Snapshot RH formula — history not loaded yet'
      return {
        data,
        provenance: hist
          ? prov({
              source: 'open-meteo-history',
              kind: 'derived',
              nativeResolution: null,
              observedAt: hist.observedAt,
              coverage: 1,
              note,
            })
          : synthetic('rh-formula', note),
      }
    },
  }
}

/** Builds an absolute wind field by scaling an anomaly with the current weather. */
export function windFieldFrom(
  anomaly: WindAnomaly | null,
  at: { windSpeed: number; windDir: number },
  n: number
): WindField {
  const u = new Float32Array(n)
  const v = new Float32Array(n)
  const baseToward = (at.windDir + 180) % 360
  const baseMs = at.windSpeed / 3.6
  if (!anomaly) {
    const th = (baseToward * Math.PI) / 180
    u.fill(Math.sin(th) * baseMs)
    v.fill(Math.cos(th) * baseMs)
    return { u, v, resolution: Number.POSITIVE_INFINITY }
  }
  for (let i = 0; i < n; i++) {
    const th = (((baseToward + anomaly.veerDeg[i]) % 360) * Math.PI) / 180
    const s = baseMs * anomaly.speedRatio[i]
    u[i] = Math.sin(th) * s
    v[i] = Math.cos(th) * s
  }
  return { u, v, resolution: anomaly.resolution }
}

const anomalyCache = new Map<string, { at: number; value: WindAnomaly | null }>()
const ANOMALY_TTL_MS = 30 * 60 * 1000
const anomKey = (b: Bounds) => `${b.north.toFixed(3)},${b.west.toFixed(3)},${b.south.toFixed(3)}`

/** Cached anomaly for an area; null while unavailable. */
export async function windAnomalyFor(
  bounds: Bounds, cols: number, rows: number, cfg: Config, signal?: AbortSignal
): Promise<WindAnomaly | null> {
  const k = anomKey(bounds)
  const hit = anomalyCache.get(k)
  if (hit && Date.now() - hit.at < ANOMALY_TTL_MS) return hit.value
  const value = await fetchWindAnomaly(bounds, cols, rows, cfg, signal)
  if (anomalyCache.size > 64) anomalyCache.clear()
  anomalyCache.set(k, { at: Date.now(), value })
  return value
}

/**
 * The port form. Real spatial shape from Open-Meteo, magnitude and bearing
 * still set by whatever weather is driving the model — so the wind slider
 * keeps working and the data supplies what the slider cannot.
 */
export function openMeteoWind(cfg: Config): WindFieldProvider {
  return {
    id: 'open-meteo-windfield',
    fallbacks: [uniformWind],
    async fetch(q: { grid: GridSpec; elevation: ElevationGrid; at: Observation }, signal?: AbortSignal) {
      const { cols, rows, bounds } = q.grid
      const anomaly = await windAnomalyFor(bounds, cols, rows, cfg, signal)
      if (!anomaly) throw new Error('no wind lattice available')
      return {
        data: windFieldFrom(anomaly, q.at, cols * rows),
        provenance: prov({
          source: 'open-meteo-windfield',
          kind: 'derived',
          nativeResolution: anomaly.resolution,
          observedAt: null,
          coverage: 1,
          note:
            `Wind shape from a ${anomaly.model} at ${(anomaly.resolution / 1000).toFixed(1)} km ` +
            `· strength and bearing still follow the controls · no terrain downscaling`,
        }),
      }
    },
  }
}
