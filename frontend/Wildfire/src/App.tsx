import { useCallback, useEffect, useRef, useState } from 'react'
import { SCENARIOS, buildTerrain, type Scenario, type Terrain } from '@firewatch/sim/terrain'
import { LocationPicker } from './components/LocationPicker.tsx'
import { loadRealTerrain } from './data/realData.ts'
import { EMPTY_STATS, transferSimState, type Sim, type Stats } from '@firewatch/sim/model'
import {
  chandlerBurningIndex, compassLabel, dangerRating, forecastAt, fuelMoisture, getPreset, mockForecast,
  type Params, type Weather,
} from '@firewatch/sim/weather'
import { ControlPanel, type Layers, type Tool } from './components/ControlPanel.tsx'
import { MapView } from './components/MapView.tsx'
import { StatsPanel } from './components/StatsPanel.tsx'
import { Legend } from './components/Legend.tsx'
import { GrowthChart } from './components/GrowthChart.tsx'
import { ForecastStrip } from './components/ForecastStrip.tsx'
import { LocalTransport } from './transport/local.ts'
import { RemoteTransport } from './transport/remote.ts'
import type { FireTransport, TransportStatus } from './transport/types.ts'

const SPEEDS = [
  { label: '1 min/s', value: 60 },
  { label: '5 min/s', value: 300 },
  { label: '30 min/s', value: 1800 },
]

const FORECAST_START_HOUR = 13

/**
 * Set VITE_API_URL to run the kernel on the server. Unset, the simulation runs
 * in the browser exactly as before — offline is a first-class configuration,
 * not an error path, which is what lets the smoke test run with no network.
 */
const API_URL: string | undefined = import.meta.env.VITE_API_URL

interface Source {
  transport: FireTransport | null
  terrain: Terrain | null
  status: TransportStatus
}

const CONNECTING: TransportStatus = { note: 'Connecting…', ready: false, provenance: {} }

/**
 * Owns the transport and the terrain it carries.
 *
 * Local mode keeps the original two-stage load: procedural terrain renders
 * instantly so the map is never blank, then the real DEM and land cover swap in
 * behind it. Anything the user already lit is carried onto the new sim, because
 * the real terrain arrives a second or so after the procedural one and must not
 * wipe their fire.
 */
function useFireSource(scenario: Scenario): Source {
  const [source, setSource] = useState<Source>({ transport: null, terrain: null, status: CONNECTING })

  useEffect(() => {
    let disposed = false
    const ac = new AbortController()
    let current: FireTransport | null = null
    const adopt = (t: FireTransport, terrain: Terrain) => {
      if (disposed) return t.dispose()
      // Swapping sources retires the old one immediately rather than at unmount,
      // so a scenario change never leaves two clocks running.
      if (current && current !== t) current.dispose()
      current = t
      setSource({ transport: t, terrain, status: t.status })
    }

    setSource({ transport: null, terrain: null, status: CONNECTING })

    // Procedural terrain renders instantly so the map is never blank, whichever
    // source is being waited on. Without it a remote incident — which has tiles
    // to fetch — shows nothing for seconds and silently swallows the first click.
    const base = buildTerrain(scenario)
    const forecast = mockForecast(getPreset(scenario.preset).weather, FORECAST_START_HOUR)
    // Against a server the provisional sim only stages input — see
    // LocalTransport.staging. Locally it runs, because the upgraded transport
    // inherits its full state and nothing is lost.
    const provisional = new LocalTransport(
      base,
      forecast,
      API_URL ? 'Connecting to server…' : 'Loading terrain…',
      Boolean(API_URL)
    )
    adopt(provisional, base)

    void (async () => {
      if (API_URL) {
        try {
          const remote = await RemoteTransport.connect(API_URL, scenario, ac.signal)
          if (disposed) return remote.dispose()
          // Replay everything the user did while the server was preparing.
          // Lines first: a line drawn before ignition must already be in place.
          for (const t of provisional.userTreatments) remote.treat(t.col, t.row, t.kind)
          for (const pt of provisional.userIgnitions) remote.ignite(pt.col, pt.row)
          return adopt(remote, remote.terrain)
        } catch (err) {
          if (disposed) return
          // A server that is down must not take the demo with it.
          console.warn('remote transport unavailable, falling back to in-browser sim:', err)
        }
      }

      try {
        const { terrain: real, note } = await loadRealTerrain(base, ac.signal)
        if (disposed || ac.signal.aborted) return
        const upgraded = new LocalTransport(real, forecast, note)
        upgraded.userIgnitions.push(...provisional.userIgnitions)
        upgraded.userTreatments.push(...provisional.userTreatments)
        // Every mutable field, not a subset: omitting fuelLeft would let burnt
        // cells burn again, omitting intensity would blank the flame bands.
        transferSimState(provisional.sim, upgraded.sim)
        adopt(upgraded, real)
      } catch {
        if (!disposed) {
          setSource((s) =>
            s.transport === provisional
              ? { ...s, status: { ...s.status, note: 'Offline — procedural terrain' } }
              : s
          )
        }
      }
    })()

    return () => {
      disposed = true
      ac.abort()
      current?.dispose()
    }
  }, [scenario])

  return source
}

export default function App() {
  // The scenario is a value, not an id into a fixed list: any point on earth
  // is a valid area of interest, and the bookmarks are just starting points.
  const [scenario, setScenario] = useState<Scenario>(SCENARIOS[0])

  const { transport, terrain, status } = useFireSource(scenario)

  const [presetId, setPresetId] = useState(scenario.preset)
  const [params, setParams] = useState<Params>(() => ({
    ...getPreset(scenario.preset).weather,
    spotting: 1,
    suppression: 0,
    followForecast: false,
  }))
  const [tool, setTool] = useState<Tool>('ignite')
  const [layers, setLayers] = useState<Layers>({
    base: 'tiles',
    tileStyle: 'satellite',
    fuelOverlay: false,
    contours: true,
    isochrones: false,
    activeFires: false,
    thermal: false,
  })
  const [fireLayer, setFireLayer] = useState<
    { count: number; note: string; truncated: boolean; loading?: boolean } | null
  >(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(300)
  const [stats, setStats] = useState<Stats>(EMPTY_STATS)
  const [simTime, setSimTime] = useState(0)
  const [hasLines, setHasLines] = useState(false)
  const [peakArea, setPeakArea] = useState(1)

  // MapView reads simRef.current every frame; keep it pointing at whichever
  // transport is current without re-creating the component.
  const simRef = useRef<Sim>(null as unknown as Sim)
  if (transport) simRef.current = transport.sim
  const drawRef = useRef<(() => void) | null>(null)
  const getViewRef = useRef<() => { lat: number; lng: number; spanKm: number }>(() => ({
    lat: 0, lng: 0, spanKm: 15,
  }))
  const paramsRef = useRef(params)
  paramsRef.current = params
  const transportRef = useRef<FireTransport | null>(null)
  transportRef.current = transport

  const forecast = transport?.forecast ?? []

  useEffect(() => {
    if (!transport) return
    setStats({ ...transport.sample() })
    setSimTime(transport.sim.time)
    setPeakArea(Math.max(1, transport.sim.stats.area))
    setHasLines(transport.sim.treatment.some((t) => t !== 0))
    drawRef.current?.()
  }, [transport])

  useEffect(() => {
    setPresetId(scenario.preset)
    setPlaying(false)
  }, [scenario])

  // Switching preset rewrites the weather sliders but keeps response settings.
  useEffect(() => {
    setParams((p) => ({ ...p, ...getPreset(presetId).weather }))
  }, [presetId])

  // Push control and parameter changes to whichever side owns the kernel.
  useEffect(() => {
    transport?.setControl({ playing, speed })
  }, [transport, playing, speed])

  useEffect(() => {
    transport?.setParams(params)
  }, [transport, params])

  // --- the loop -----------------------------------------------------------
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let statsClock = 0

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const realDt = Math.min(0.1, (now - last) / 1000)
      last = now
      const t = transportRef.current
      if (!t) return

      // Local steps the kernel here; remote is a no-op because the server
      // drives the clock and pushes state over the socket.
      t.advance(realDt, paramsRef.current)
      drawRef.current?.()

      // React state at 5 Hz: the canvas is the real-time surface, not the DOM.
      statsClock += realDt
      if (statsClock > 0.2) {
        statsClock = 0
        const s = t.sample()
        setStats({ ...s })
        setSimTime(t.sim.time)
        setPeakArea((p) => Math.max(p, s.area))
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // --- interactions --------------------------------------------------------
  const onIgnite = useCallback((col: number, row: number) => {
    transportRef.current?.ignite(col, row)
    setPlaying(true)
  }, [])

  const onTreat = useCallback((col: number, row: number, kind: number) => {
    transportRef.current?.treat(col, row, kind === 1 ? 1 : 2)
    setHasLines(true)
  }, [])

  const clearLines = useCallback(() => {
    transportRef.current?.clearTreatment()
    setHasLines(false)
  }, [])

  const reset = useCallback(() => {
    transportRef.current?.reset()
    setSimTime(0)
    setPeakArea(1)
    setHasLines(false)
    setPlaying(false)
    setStats(EMPTY_STATS)
    drawRef.current?.()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      // Do not hijack keys aimed at a focused form control: typing "r" to jump
      // through the scenario list should not reset the incident, and Space
      // should still re-activate a focused button.
      if (el && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName))) return
      if (e.code === 'Space') {
        e.preventDefault()
        setPlaying((v) => !v)
      }
      if (e.key === 'r' || e.key === 'R') reset()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reset])

  const registerDraw = useCallback((fn: () => void) => {
    drawRef.current = fn
  }, [])

  const registerGetView = useCallback((fn: () => { lat: number; lng: number; spanKm: number }) => {
    getViewRef.current = fn
  }, [])

  /** Weather actually driving the model right now. */
  const effective: Weather =
    params.followForecast && forecast.length ? forecastAt(forecast, simTime) : params
  const fmc = fuelMoisture(effective)
  const cbi = chandlerBurningIndex(effective.temperature, effective.humidity)
  const danger = dangerRating(cbi)

  const hours = simTime / 3600
  const clock = `${String((FORECAST_START_HOUR + Math.floor(hours)) % 24).padStart(2, '0')}:${String(
    Math.floor((simTime % 3600) / 60)
  ).padStart(2, '0')}`

  const chipNote = status.error ?? status.note
  const chipLive = !status.error && /live|server/i.test(status.note)
  const provTitle = Object.keys(status.provenance).length
    ? Object.entries(status.provenance).map(([k, v]) => `${k}: ${v.note}`).join('\n')
    : 'Source of the elevation and fuel grids'

  return (
    <div className={`app cursor-${tool}`}>
      <header className="header">
        <div className="brand">
          <span className="flame">🔥</span>
          <h1>Ember</h1>
          <small>wildfire spread sandbox</small>
        </div>
        <LocationPicker
          scenario={scenario}
          onScenario={setScenario}
          getView={() => getViewRef.current()}
          apiUrl={API_URL}
        />
        <span className={`data-chip${chipLive ? ' live' : ''}`} title={provTitle}>
          {transport?.kind === 'remote' ? '☁ ' : ''}
          {chipNote}
        </span>
        <div className="spacer" />
        <div className="danger-badge" title={`Chandler Burning Index ${cbi.toFixed(0)}`}>
          <span className="dot" style={{ background: danger.color, color: danger.color }} />
          <span className="lbl">Fire danger</span>
          <span className="val" style={{ color: danger.color }}>
            {danger.label}
          </span>
        </div>
        <button className="btn" onClick={reset} title="Reset the incident (R)">
          Reset
        </button>
      </header>

      <div className="body">
        <aside className="panel-left">
          <ControlPanel
            canShowActiveFires={Boolean(API_URL)}
            params={params}
            onParams={(patch) => setParams((p) => ({ ...p, ...patch }))}
            preset={presetId}
            onPreset={setPresetId}
            tool={tool}
            onTool={setTool}
            layers={layers}
            onLayers={(patch) => setLayers((l) => ({ ...l, ...patch }))}
            onClearLines={clearLines}
            hasLines={hasLines}
          />
        </aside>

        <main className="map-wrap">
          {terrain && (
            <MapView
              terrain={terrain}
              simRef={simRef}
              layers={layers}
              tool={tool}
              onIgnite={onIgnite}
              onTreat={onTreat}
              registerDraw={registerDraw}
              registerGetView={registerGetView}
              apiUrl={API_URL}
              onFiresLoaded={setFireLayer}
              ambientC={effective.temperature}
            />
          )}

          {params.followForecast && forecast.length > 0 && (
            <div className="hud hud-top">
              <ForecastStrip forecast={forecast} simHours={hours} />
            </div>
          )}

          <div className="hud hud-tr">
            <StatsPanel stats={stats} fmc={fmc} />
          </div>

          {stats.burnedCells === 0 && tool === 'ignite' && (
            <div className="ignite-prompt">Click the map to start a fire</div>
          )}

          <div className="hud hud-bl">
            <Legend
              base={layers.base}
              fuelOverlay={layers.fuelOverlay}
              thermal={layers.thermal}
              ambientC={effective.temperature}
            />
            {layers.activeFires && fireLayer && (
              <div className="fires-note" title={fireLayer.note}>
                {fireLayer.loading ? (
                  <>
                    <span className="fires-dot pulse" />
                    Loading fire detections…
                    <small>NASA FIRMS · first load pulls a 24 h global file</small>
                  </>
                ) : (
                  <>
                    <span className="fires-dot" />
                    {fireLayer.count.toLocaleString()} active fire detection
                    {fireLayer.count === 1 ? '' : 's'} in view
                    {fireLayer.truncated ? ' (strongest 4,000)' : ''}
                    <small>NASA FIRMS · last 24 h · click one to ignite there</small>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="transport">
            <button className="play" onClick={() => setPlaying((v) => !v)} title="Play/pause (space)">
              {playing ? '❚❚' : '▶'}
            </button>
            <div className="clock">
              {String(Math.floor(hours)).padStart(2, '0')}:{String(Math.floor((simTime % 3600) / 60)).padStart(2, '0')}
              <small>elapsed · {clock}</small>
            </div>
            <div className="seg" style={{ flex: '0 0 auto' }}>
              {SPEEDS.map((s) => (
                <button key={s.value} aria-pressed={speed === s.value} onClick={() => setSpeed(s.value)}>
                  {s.label}
                </button>
              ))}
            </div>
            <div className="grow">
              <GrowthChart history={simRef.current?.history ?? []} peak={peakArea} />
            </div>
            <div className="hint">
              {stats.activeCells === 0 && stats.burnedCells > 0
                ? 'Fire is out — reset or ignite again'
                : stats.activeCells > 0
                  ? `${stats.activeCells.toLocaleString()} cells alight · ${Math.round(effective.windSpeed)} km/h from ${compassLabel(effective.windDir)}`
                  : tool === 'ignite'
                    ? 'Click the map to start a fire'
                    : tool === 'pan'
                      ? 'Drag to pan the map'
                      : 'Drag on the map to draw'}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
