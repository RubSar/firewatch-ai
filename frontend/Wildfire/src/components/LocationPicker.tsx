import { useEffect, useRef, useState } from 'react'
import { DEFAULT_SPAN_KM, SCENARIOS, scenarioAt, scenarioCentre, type Scenario } from '@firewatch/sim/terrain'
import type { GeocodeResult } from '@firewatch/contracts/wire'

/**
 * Picks the area of interest — anywhere on earth.
 *
 * Every data source is global, so the bookmarked scenarios are shortcuts, not
 * the available set. Three ways in: search a place name, simulate wherever the
 * map is currently pointed, or pick a bookmark.
 */
interface Props {
  scenario: Scenario
  onScenario: (s: Scenario) => void
  /** Reads the map's current centre and visible span. */
  getView: () => { lat: number; lng: number; spanKm: number }
  /** When set, geocoding is proxied through the API rather than called direct. */
  apiUrl?: string
}

const SPANS = [8, 15, 25, 40]

/** Open-Meteo's geocoder is CORS-clean, so browser-only mode can search too. */
async function searchDirect(q: string, signal: AbortSignal): Promise<GeocodeResult[]> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`geocode ${res.status}`)
  const json = (await res.json()) as {
    results?: { name: string; latitude: number; longitude: number; country?: string; country_code?: string; admin1?: string }[]
  }
  return (json.results ?? []).map((r) => ({
    name: r.name,
    detail: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lng: r.longitude,
    countryCode: r.country_code ?? null,
  }))
}

export function LocationPicker({ scenario, onScenario, getView, apiUrl }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GeocodeResult[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [spanKm, setSpanKm] = useState(() => Math.round(scenarioCentre(scenario).spanKm))
  const boxRef = useRef<HTMLDivElement>(null)

  // Debounced search: a keystroke per request would hammer the geocoder and
  // the results would race each other back.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      setError(null)
      return
    }
    const ac = new AbortController()
    const timer = setTimeout(async () => {
      setBusy(true)
      setError(null)
      try {
        const found = apiUrl
          ? ((await (await fetch(`${apiUrl}/api/geocode?q=${encodeURIComponent(q)}`, { signal: ac.signal })).json()) as { results: GeocodeResult[] }).results
          : await searchDirect(q, ac.signal)
        if (ac.signal.aborted) return
        setResults(found)
        setOpen(true)
        if (!found.length) setError('No match — try a nearby town, or pan the map and use “this view”.')
      } catch (err) {
        if (!ac.signal.aborted) setError(`Search unavailable: ${(err as Error).message}`)
      } finally {
        if (!ac.signal.aborted) setBusy(false)
      }
    }, 300)
    return () => {
      ac.abort()
      clearTimeout(timer)
    }
  }, [query, apiUrl])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  const pick = (r: GeocodeResult) => {
    onScenario(scenarioAt(r.lat, r.lng, spanKm, { name: r.name, region: r.detail }))
    setQuery('')
    setResults([])
    setOpen(false)
  }

  const useThisView = () => {
    const v = getView()
    // Clamp to what the grid can sensibly resolve: 400 columns across.
    const span = Math.max(4, Math.min(80, Math.round(v.spanKm)))
    setSpanKm(span)
    onScenario(scenarioAt(v.lat, v.lng, span, { name: 'Map view', region: `${span} km across` }))
    setOpen(false)
  }

  const centre = scenarioCentre(scenario)

  return (
    <div className="location" ref={boxRef}>
      <input
        className="location-input"
        type="search"
        value={query}
        placeholder="Search anywhere — a town, park or region…"
        aria-label="Search for a location to simulate"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results.length) pick(results[0])
          if (e.key === 'Escape') setOpen(false)
        }}
      />
      <button className="btn ghost" onClick={useThisView} title="Simulate the area currently on screen">
        Use this view
      </button>

      {open && (
        <div className="location-menu">
          {busy && <div className="location-note">Searching…</div>}
          {error && <div className="location-note">{error}</div>}
          {results.map((r) => (
            <button key={`${r.lat},${r.lng},${r.name}`} className="location-item" onClick={() => pick(r)}>
              <span className="li-name">{r.name}</span>
              <span className="li-detail">{r.detail}</span>
            </button>
          ))}

          <div className="location-sep">Area size</div>
          <div className="seg span-seg">
            {SPANS.map((s) => (
              <button
                key={s}
                aria-pressed={spanKm === s}
                onClick={() => {
                  setSpanKm(s)
                  onScenario(scenarioAt(centre.lat, centre.lng, s, { name: scenario.name, region: scenario.region }))
                }}
                title={`${s} km across · ~${Math.round((s * 1000) / 400)} m cells`}
              >
                {s} km
              </button>
            ))}
          </div>

          <div className="location-sep">Bookmarks</div>
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              className="location-item"
              onClick={() => {
                onScenario(s)
                setOpen(false)
              }}
              title={s.blurb}
            >
              <span className="li-name">{s.name}</span>
              <span className="li-detail">{s.region}</span>
            </button>
          ))}
        </div>
      )}

      <button
        className="location-current"
        onClick={() => setOpen((v) => !v)}
        title={`${scenario.name} · ${centre.lat.toFixed(3)}, ${centre.lng.toFixed(3)} · ${Math.round(centre.spanKm)} km across`}
      >
        <span className="lc-name">{scenario.name}</span>
        <span className="lc-span">{Math.round(centre.spanKm)} km</span>
      </button>
    </div>
  )
}

export { DEFAULT_SPAN_KM }
