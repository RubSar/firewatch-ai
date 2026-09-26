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

      // Days since rain is not in the feed; carry the preset's drought signal
      // rather than inventing one, and say so in the note.
      const droughtDays = getPreset(presetId).weather.daysSinceRain
      // The feed starts at 00:00 UTC today, so row 0 is midnight. Starting
      // there would drive an afternoon incident with overnight weather — cool,
      // damp and calm — and badly under-predict. Seek to the current hour.
      const nowMs = Date.now()
      let start = h.time.findIndex((t) => new Date(`${t}Z`).getTime() + 3600_000 > nowMs)
      if (start < 0) start = 0

      const count = Math.min(q.hours, h.time.length - start)
      const forecast: Observation[] = []
      for (let k = 0; k < count; k++) {
        const i = start + k
        const speed = h.wind_speed_10m[i] ?? 0
        const gust = h.wind_gusts_10m?.[i] ?? speed
        const when = new Date(`${h.time[i]}Z`)
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
          daysSinceRain: droughtDays,
          precipitation: h.precipitation?.[i] ?? 0,
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
          note: `Live forecast · Open-Meteo from ${forecast[0].clock} UTC (drought carried from ${presetId} preset)`,
        }),
      }
    },
  }
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
      u: new Float32Array(n).fill(Math.sin(toward) * s),
      v: new Float32Array(n).fill(-Math.cos(toward) * s),
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
