import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SCENARIOS, buildTerrain, type Terrain } from './sim/terrain.ts'
import { loadRealTerrain } from './data/realData.ts'
import { EMPTY_STATS, createSim, ignite, paintTreatment, recomputeStats, step, type Sim, type Stats } from './sim/model.ts'
import {
  chandlerBurningIndex, compassLabel, dangerRating, forecastAt, fuelMoisture, getPreset, mockForecast,
  type Params, type Weather,
} from './sim/weather.ts'
import { ControlPanel, type Layers, type Tool } from './components/ControlPanel.tsx'
import { MapView } from './components/MapView.tsx'
import { StatsPanel } from './components/StatsPanel.tsx'
import { Legend } from './components/Legend.tsx'
import { GrowthChart } from './components/GrowthChart.tsx'
import { ForecastStrip } from './components/ForecastStrip.tsx'

/** Simulation seconds advanced per integration step. */
const DT = 10
/** Ceiling on work per frame so a slow tab cannot spiral. */
const MAX_STEPS_PER_FRAME = 90

const SPEEDS = [
  { label: '1 min/s', value: 60 },
  { label: '5 min/s', value: 300 },
  { label: '30 min/s', value: 1800 },
]

const FORECAST_START_HOUR = 13

export default function App() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id)
  const scenario = useMemo(() => SCENARIOS.find((s) => s.id === scenarioId)!, [scenarioId])

  // The procedural terrain renders instantly so the map is never blank, then
  // the real DEM and land cover swap in behind it a second or so later.
  // Memoised because it is a 7-octave noise pass over 130k cells, and because
  // the effect below must reuse this exact object rather than build an
  // identical one — a new identity restarts everything downstream.
  const baseTerrain = useMemo(() => buildTerrain(scenario), [scenario])
  const [terrain, setTerrain] = useState<Terrain>(baseTerrain)
  const [dataNote, setDataNote] = useState('Loading terrain…')

  // Changing scenario is what resets the session. Live data arriving for the
  // scenario already on screen must not.
  useEffect(() => {
    ignitionsRef.current = []
    carryTreatment.current = false
    setTerrain(baseTerrain)
    setDataNote('Loading terrain…')
    setPlaying(false)
    setHasLines(false)
    setPresetId(scenario.preset)
    const ac = new AbortController()
    loadRealTerrain(baseTerrain, ac.signal)
      .then(({ terrain: real, note }) => {
        if (ac.signal.aborted) return
        setTerrain(real)
        setDataNote(note)
      })
      .catch(() => {
        if (!ac.signal.aborted) setDataNote('Offline — procedural terrain')
      })
    return () => ac.abort()
  }, [baseTerrain, scenario.preset])

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
  })
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(300)
  const [stats, setStats] = useState<Stats>(EMPTY_STATS)
  const [simTime, setSimTime] = useState(0)
  const [hasLines, setHasLines] = useState(false)
  const [peakArea, setPeakArea] = useState(1)

  // useRef keeps only the first value but still evaluates its argument on every
  // render, and this component re-renders 5 times a second — so build the
  // simulation lazily instead of allocating and discarding five 130k-cell
  // typed arrays per render.
  const simRef = useRef<Sim>(null as unknown as Sim)
  if (simRef.current === null) simRef.current = createSim(terrain)
  /** Whether the next sim rebuild should inherit the current control lines. */
  const carryTreatment = useRef(false)
  /** Cells the user lit, replayed if the terrain is swapped underneath them. */
  const ignitionsRef = useRef<{ col: number; row: number }[]>([])
  const drawRef = useRef<(() => void) | null>(null)
  const paramsRef = useRef(params)
  paramsRef.current = params
  const playingRef = useRef(playing)
  playingRef.current = playing
  const speedRef = useRef(speed)
  speedRef.current = speed

  const forecast = useMemo(
    () => mockForecast(getPreset(presetId).weather, FORECAST_START_HOUR),
    [presetId]
  )
  const forecastRef = useRef(forecast)
  forecastRef.current = forecast

  /** Weather actually driving the model right now. */
  const effective: Weather = params.followForecast ? forecastAt(forecast, simTime) : params
  const fmc = fuelMoisture(effective)
  const cbi = chandlerBurningIndex(effective.temperature, effective.humidity)
  const danger = dangerRating(cbi)

  // --- rebuild the sim whenever the scenario changes ---------------------
  useEffect(() => {
    const prev = simRef.current
    const sim = createSim(terrain)
    // Carry the user's control lines across a live-data swap, but never across
    // a scenario change.
    if (carryTreatment.current && prev && prev.treatment.length === sim.treatment.length) {
      sim.treatment.set(prev.treatment)
    }
    carryTreatment.current = true
    simRef.current = sim
    // No automatic ignition: the fire is the user's to start. Anything they had
    // already lit is replayed, because the real terrain arrives a second or so
    // after the procedural one and must not wipe their fire.
    for (const pt of ignitionsRef.current) ignite(sim, pt.col, pt.row, 1)
    recomputeStats(sim)
    setStats({ ...sim.stats })
    setSimTime(0)
    setPeakArea(1)
    drawRef.current?.()
  }, [terrain])

  // Switching preset rewrites the weather sliders but keeps response settings.
  useEffect(() => {
    setParams((p) => ({ ...p, ...getPreset(presetId).weather }))
  }, [presetId])

  // --- the loop -----------------------------------------------------------
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let carry = 0
    let statsClock = 0

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const realDt = Math.min(0.1, (now - last) / 1000)
      last = now
      const sim = simRef.current

      if (playingRef.current) {
        carry += realDt * speedRef.current
        let steps = Math.min(MAX_STEPS_PER_FRAME, Math.floor(carry / DT))
        carry -= steps * DT
        const prm = paramsRef.current
        while (steps-- > 0) {
          const weather: Weather = prm.followForecast ? forecastAt(forecastRef.current, sim.time) : prm
          step(sim, { params: prm, weather, dt: DT })
        }
      }

      drawRef.current?.()

      // React state at 5 Hz: the canvas is the real-time surface, not the DOM.
      statsClock += realDt
      if (statsClock > 0.2) {
        statsClock = 0
        recomputeStats(sim)
        setStats({ ...sim.stats })
        setSimTime(sim.time)
        setPeakArea((p) => Math.max(p, sim.stats.area))
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // --- interactions --------------------------------------------------------
  const onIgnite = useCallback((col: number, row: number) => {
    ignite(simRef.current, col, row, 1)
    ignitionsRef.current.push({ col, row })
    recomputeStats(simRef.current)
    setStats({ ...simRef.current.stats })
    setPlaying(true)
  }, [])

  const onTreat = useCallback((col: number, row: number, kind: number) => {
    paintTreatment(simRef.current, col, row, kind === 1 ? 1 : 2, kind)
    setHasLines(true)
  }, [])

  const clearLines = useCallback(() => {
    simRef.current.treatment.fill(0)
    // The renderer only rebuilds geometry when the sim changes; while paused the
    // clock is frozen, so without this the cleared lines stay on screen.
    simRef.current.revision++
    setHasLines(false)
  }, [])

  const reset = useCallback(() => {
    simRef.current = createSim(terrain)
    ignitionsRef.current = []
    recomputeStats(simRef.current)
    setStats({ ...simRef.current.stats })
    setSimTime(0)
    setPeakArea(1)
    setHasLines(false)
    setPlaying(false)
    drawRef.current?.()
  }, [terrain])

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

  const hours = simTime / 3600
  const clock = `${String((FORECAST_START_HOUR + Math.floor(hours)) % 24).padStart(2, '0')}:${String(
    Math.floor((simTime % 3600) / 60)
  ).padStart(2, '0')}`

  return (
    <div className={`app cursor-${tool}`}>
      <header className="header">
        <div className="brand">
          <span className="flame">🔥</span>
          <h1>Ember</h1>
          <small>wildfire spread sandbox</small>
        </div>
        <select
          className="scenario-select"
          value={scenarioId}
          onChange={(e) => setScenarioId(e.target.value)}
          title={scenario.blurb}
        >
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.region}
            </option>
          ))}
        </select>
        <span className={`data-chip${dataNote.startsWith('Live') ? ' live' : ''}`} title="Source of the elevation and fuel grids">
          {dataNote}
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
          <MapView
            terrain={terrain}
            simRef={simRef}
            layers={layers}
            tool={tool}
            onIgnite={onIgnite}
            onTreat={onTreat}
            registerDraw={registerDraw}
          />

          {params.followForecast && (
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
            <Legend base={layers.base} fuelOverlay={layers.fuelOverlay} />
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
              <GrowthChart history={simRef.current.history} peak={peakArea} />
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
