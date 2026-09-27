/**
 * NWS gridpoint forecast — §9 `WeatherProvider`, United States.
 *
 * WHY THIS EXISTS: LICENSING, not accuracy. Open-Meteo's free tier is
 * **non-commercial**, and weather drives every fire in this system, so that one
 * term blocked commercialisation of the whole product. `api.weather.gov` is a US
 * federal work in the public domain, free for any use including commercial, and
 * needs no key — so for US domains the blocker simply goes away.
 *
 * It sits AHEAD of Open-Meteo in the chain. Outside the United States the
 * `/points` lookup fails and `resolve` falls back, with `degradedFrom` recording
 * it. Nothing has to know where the US is.
 *
 * WHAT IT DOES NOT FIX. Two Open-Meteo calls remain, and pretending otherwise
 * would be worse than the original problem:
 *
 *   - **Drought history.** NWS publishes forecasts, not archives, so
 *     days-since-rain still comes from the Open-Meteo archive. It is attempted
 *     and degrades to the scenario preset, so a US incident CAN run with zero
 *     Open-Meteo calls — just with a less well-founded drought clock.
 *   - **The hindcast archive and place-name search**, which have no NWS
 *     equivalent at all.
 *
 * The complete exits are to self-host Open-Meteo (it is open source, and the
 * underlying ERA5/GFS/DWD data is public) or to buy their commercial plan. Both
 * remove the term entirely; this provider removes the largest call volume from it.
 *
 * TWO QUIRKS OF THIS API worth knowing before editing.
 *
 * It **requires a User-Agent** identifying the caller, and answers 403 without
 * one. That is stated policy, not a bug to work around.
 *
 * Its values are **run-length encoded over ISO 8601 intervals**, not a dense
 * hourly array: each entry is `{ validTime: "<instant>/<duration>", value }`, and
 * every field has a different number of entries because a constant stretch is one
 * entry however long it runs. Temperature came back with 160 entries and wind
 * direction with 52 for the same period. They must be expanded onto a common
 * hourly grid before anything can read them as a time series.
 */
import type { Bounds } from '@firewatch/sim/terrain'
import type { Observation, WeatherProvider } from '@firewatch/contracts/providers'
import type { Config } from '../config.ts'
import { prov } from './provenance.ts'
import { getPreset } from '@firewatch/sim/weather'
import { WETTING_MM, droughtSince, openMeteo } from './tier2.ts'

/** NWS policy: identify yourself or get a 403. */
const UA = 'firewatch-ai/0.1 (wildfire spread simulator; contact via repository)'

interface GridSeries { uom?: string; values?: { validTime: string; value: number | null }[] }
interface GridPoint {
  properties?: {
    temperature?: GridSeries
    relativeHumidity?: GridSeries
    windSpeed?: GridSeries
    windDirection?: GridSeries
    windGust?: GridSeries
    quantitativePrecipitation?: GridSeries
  }
}

/**
 * Hours in an ISO 8601 duration, for the subset NWS emits: `PT1H`, `PT6H`,
 * `P1D`, `P1DT6H`. Returns at least 1 so a malformed duration cannot produce a
 * zero-length interval and silently drop a value.
 */
export function durationHours(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso)
  if (!m) return 1
  const days = Number(m[1] ?? 0)
  const hours = Number(m[2] ?? 0)
  const mins = Number(m[3] ?? 0)
  return Math.max(1, days * 24 + hours + Math.round(mins / 60))
}

/**
 * Expands a run-length encoded series onto `hours` hourly slots from `startMs`.
 *
 * Carries the last known value forward across gaps rather than leaving holes: a
 * hole would become `?? fallback` at the read site and put a default temperature
 * in the middle of a real forecast.
 */
export function expandSeries(series: GridSeries | undefined, startMs: number, hours: number): (number | null)[] {
  const out: (number | null)[] = new Array(hours).fill(null)
  for (const v of series?.values ?? []) {
    const [instant, dur] = v.validTime.split('/')
    const t0 = new Date(instant).getTime()
    if (!Number.isFinite(t0)) continue
    const span = durationHours(dur ?? 'PT1H')
    for (let h = 0; h < span; h++) {
      const idx = Math.round((t0 + h * 3600_000 - startMs) / 3600_000)
      if (idx >= 0 && idx < hours) out[idx] = v.value
    }
  }
  let last: number | null = null
  for (let i = 0; i < hours; i++) {
    if (out[i] == null) out[i] = last
    else last = out[i]
  }
  return out
}

async function getJson<T>(url: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': UA, accept: 'application/geo+json' } })
    if (!res.ok) throw new Error(`${url.replace(/\?.*/, '')} ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export function nwsWeather(cfg: Config, presetId: string): WeatherProvider {
  return {
    id: 'nws-gridpoint',
    fallbacks: [openMeteo(cfg, presetId)],
    async fetch(q: { bounds: Bounds; hours: number }, signal?: AbortSignal) {
      const lat = (q.bounds.north + q.bounds.south) / 2
      const lng = (q.bounds.east + q.bounds.west) / 2

      // /points resolves a coordinate to a forecast office and grid cell, and is
      // also the out-of-coverage test: outside the US it 404s and the chain
      // falls through to Open-Meteo.
      const pt = await getJson<{ properties?: { forecastGridData?: string; gridId?: string } }>(
        `https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`,
        cfg.fetchTimeoutMs,
        signal
      )
      const gridUrl = pt.properties?.forecastGridData
      if (!gridUrl) throw new Error('NWS returned no gridpoint — outside US coverage')

      const gp = await getJson<GridPoint>(gridUrl, Math.max(cfg.fetchTimeoutMs, 30000), signal)
      const p = gp.properties
      if (!p?.temperature?.values?.length) throw new Error('NWS gridpoint carried no temperature series')

      // Align to the current hour, for the same reason Open-Meteo does: starting
      // at the series origin would drive an afternoon incident with whatever
      // hour the office happened to publish from.
      const startMs = Math.floor(Date.now() / 3600_000) * 3600_000
      const hours = Math.max(1, q.hours)
      const temp = expandSeries(p.temperature, startMs, hours)
      const rh = expandSeries(p.relativeHumidity, startMs, hours)
      const spd = expandSeries(p.windSpeed, startMs, hours)
      const dir = expandSeries(p.windDirection, startMs, hours)
      const gust = expandSeries(p.windGust, startMs, hours)
      const precip = expandSeries(p.quantitativePrecipitation, startMs, hours)

      // Drought is still Open-Meteo's archive; it degrades to the preset, so a US
      // incident can run without touching Open-Meteo at all.
      const drought = await droughtSince(cfg, lat, lng, signal).catch(() => null)
      let sinceRain = drought?.days ?? getPreset(presetId).weather.daysSinceRain

      const forecast: Observation[] = []
      for (let k = 0; k < hours; k++) {
        const when = new Date(startMs + k * 3600_000)
        const speed = spd[k] ?? 0
        const g = gust[k] ?? speed
        const mm = precip[k] ?? 0
        if (k > 0) sinceRain = mm >= WETTING_MM / 24 ? 0 : sinceRain + 1 / 24
        forecast.push({
          at: when.toISOString(),
          hour: k,
          clock: `${String(when.getUTCHours()).padStart(2, '0')}:00`,
          temperature: temp[k] ?? 20,
          humidity: rh[k] ?? 40,
          windSpeed: speed,
          windDir: dir[k] ?? 0,
          gustiness: speed > 0.5 ? Math.max(0, Math.min(1, (g - speed) / speed)) : 0,
          daysSinceRain: sinceRain,
          precipitation: mm,
        })
      }

      return {
        data: { current: forecast[0], forecast },
        provenance: prov({
          source: `nws-gridpoint:${pt.properties?.gridId ?? 'unknown'}`,
          kind: 'measured',
          nativeResolution: 2500,
          observedAt: forecast[0].at,
          coverage: 1,
          note:
            `NWS gridpoint forecast (${pt.properties?.gridId ?? '?'}) from ${forecast[0].clock} UTC · ` +
            'US federal, public domain, free for commercial use · ' +
            (drought
              ? `${drought.capped ? '≥' : ''}${Math.round(drought.days)} d since ${WETTING_MM} mm of rain (Open-Meteo archive)`
              : `drought carried from the ${presetId} preset — no precipitation history`),
        }),
      }
    },
  }
}
