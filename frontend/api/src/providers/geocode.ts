/**
 * Place-name lookup.
 *
 * Open-Meteo's geocoder: keyless, CORS-clean and the same provider already
 * supplying weather, so there is one fewer service to reason about. Proxied
 * through the API rather than called from the browser so results can be cached
 * and the UI has a single origin to talk to.
 */
import type { GeocodeResult } from '@firewatch/contracts/wire'
import type { Config } from '../config.ts'

const ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search'
/** Small LRU-ish cache: the same handful of queries recur while demoing. */
const cache = new Map<string, GeocodeResult[]>()
const CACHE_MAX = 200

interface OpenMeteoPlace {
  name: string
  latitude: number
  longitude: number
  country?: string
  country_code?: string
  admin1?: string
  admin2?: string
}

export async function geocode(
  query: string,
  cfg: Config,
  signal?: AbortSignal
): Promise<GeocodeResult[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const key = q.toLowerCase()
  const hit = cache.get(key)
  if (hit) return hit

  const url = `${ENDPOINT}?name=${encodeURIComponent(q)}&count=8&language=en&format=json`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), cfg.fetchTimeoutMs)
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) throw new Error(`geocode ${res.status}`)
    const json = (await res.json()) as { results?: OpenMeteoPlace[] }
    const out: GeocodeResult[] = (json.results ?? []).map((r) => ({
      name: r.name,
      detail: [r.admin1, r.country].filter(Boolean).join(', '),
      lat: r.latitude,
      lng: r.longitude,
      countryCode: r.country_code ?? null,
    }))
    if (cache.size >= CACHE_MAX) cache.clear()
    cache.set(key, out)
    return out
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
