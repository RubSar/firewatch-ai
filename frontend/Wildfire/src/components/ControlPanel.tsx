import { PRESETS, compassLabel, type Params } from '@firewatch/sim/weather'
import type { BaseLayer } from '../render/paint.ts'
import { WindDial } from './WindDial.tsx'

export type Tool = 'ignite' | 'dozer' | 'retardant' | 'pan'

export interface Layers {
  base: BaseLayer
  tileStyle: 'topo' | 'satellite'
  fuelOverlay: boolean
  contours: boolean
  isochrones: boolean
  /** NASA FIRMS satellite detections from the last 24 h. Needs the server. */
  activeFires: boolean
}

interface Props {
  /** Unset in browser-only mode: FIRMS sends no CORS headers, so the fire
   *  detection layer can only be fetched through the API. */
  canShowActiveFires?: boolean
  params: Params
  onParams: (p: Partial<Params>) => void
  preset: string
  onPreset: (id: string) => void
  tool: Tool
  onTool: (t: Tool) => void
  layers: Layers
  onLayers: (l: Partial<Layers>) => void
  onClearLines: () => void
  hasLines: boolean
}

function Slider({
  label, value, min, max, step = 1, unit, disabled, onChange, format,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  disabled?: boolean
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  return (
    <div className="slider">
      <div className="row">
        <label htmlFor={`s-${label}`}>{label}</label>
        <span className="val">
          {format ? format(value) : value}
          {unit ? <em>{unit}</em> : null}
        </span>
      </div>
      <input
        id={`s-${label}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  )
}

export function ControlPanel({
  canShowActiveFires,
  params, onParams, preset, onPreset, tool, onTool, layers, onLayers, onClearLines, hasLines,
}: Props) {
  const fc = params.followForecast

  return (
    <>
      <section className="section">
        <h2>Weather scenario</h2>
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className="preset"
              aria-pressed={preset === p.id}
              onClick={() => onPreset(p.id)}
              title={p.hint}
            >
              {p.name}
              <span>{p.hint}</span>
            </button>
          ))}
        </div>
        <label className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={fc} onChange={(e) => onParams({ followForecast: e.target.checked })} />
          Drive from hourly forecast feed
        </label>
        <p className="note">
          Mock 24 h forecast with a diurnal cycle. In production this is the NWS gridpoint API or the
          nearest RAWS station — the sliders below become read-outs.
        </p>
      </section>

      <section className="section">
        <h2>Wind</h2>
        <div className="wind">
          <WindDial
            dir={params.windDir}
            speed={params.windSpeed}
            gust={params.gustiness}
            disabled={fc}
            onChange={(d) => onParams({ windDir: d })}
          />
          <div className="readout">
            <div className="big">
              {Math.round(params.windSpeed)}
              <em> km/h</em>
            </div>
            <div className="sub">
              from {compassLabel(params.windDir)} ({Math.round(params.windDir)}&deg;)
            </div>
            <div className="sub">
              gusting to {Math.round(params.windSpeed * (1 + 0.55 * params.gustiness))} km/h
            </div>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <Slider label="Wind speed" value={Math.round(params.windSpeed)} min={0} max={100} unit=" km/h" disabled={fc} onChange={(v) => onParams({ windSpeed: v })} />
          <Slider label="Gustiness" value={params.gustiness} min={0} max={1} step={0.05} disabled={fc} onChange={(v) => onParams({ gustiness: v })} format={(v) => `${Math.round(v * 100)}%`} />
        </div>
      </section>

      <section className="section">
        <h2>Atmosphere &amp; fuel</h2>
        <Slider label="Temperature" value={Math.round(params.temperature)} min={-5} max={48} unit=" °C" disabled={fc} onChange={(v) => onParams({ temperature: v })} />
        <Slider label="Relative humidity" value={Math.round(params.humidity)} min={3} max={100} unit=" %" disabled={fc} onChange={(v) => onParams({ humidity: v })} />
        <Slider label="Days since rain" value={Math.round(params.daysSinceRain)} min={0} max={120} unit=" d" disabled={fc} onChange={(v) => onParams({ daysSinceRain: v })} />
        <Slider label="Rainfall" value={params.precipitation} min={0} max={10} step={0.5} unit=" mm/h" disabled={fc} onChange={(v) => onParams({ precipitation: v })} />
        <p className="note">
          Temperature, humidity and drought combine into dead fine-fuel moisture. Above a fuel's
          moisture of extinction the fire stops carrying altogether.
        </p>
      </section>

      <section className="section">
        <h2>Fire behaviour &amp; response</h2>
        <Slider label="Ember spotting" value={params.spotting} min={0} max={2} step={0.1} onChange={(v) => onParams({ spotting: v })} format={(v) => `${v.toFixed(1)}×`} />
        <Slider label="Suppression effort" value={params.suppression} min={0} max={100} unit=" %" onChange={(v) => onParams({ suppression: v })} />
        <p className="note">
          Crews only hold a line while the head fire is slow enough to work — pour on effort during a
          wind-driven run and watch it achieve very little.
        </p>
      </section>

      <section className="section">
        <h2>Map tools</h2>
        <div className="tools">
          <button className="tool" aria-pressed={tool === 'ignite'} onClick={() => onTool('ignite')}>
            <span className="ico">🔥</span> Ignite
          </button>
          <button className="tool" aria-pressed={tool === 'dozer'} onClick={() => onTool('dozer')}>
            <span className="ico">🚜</span> Dozer line
          </button>
          <button className="tool" aria-pressed={tool === 'retardant'} onClick={() => onTool('retardant')}>
            <span className="ico">🛩️</span> Retardant
          </button>
          <button className="tool" aria-pressed={tool === 'pan'} onClick={() => onTool('pan')}>
            <span className="ico">✋</span> Pan map
          </button>
        </div>
        <button className="btn ghost" style={{ marginTop: 9, width: '100%' }} onClick={onClearLines} disabled={!hasLines}>
          Clear lines &amp; drops
        </button>
      </section>

      <section className="section">
        <h2>Layers</h2>
        <div className="seg" style={{ marginBottom: 9 }}>
          <button aria-pressed={layers.base === 'fuel'} onClick={() => onLayers({ base: 'fuel' })}>Fuel</button>
          <button aria-pressed={layers.base === 'elevation'} onClick={() => onLayers({ base: 'elevation' })}>Terrain</button>
          <button aria-pressed={layers.base === 'tiles'} onClick={() => onLayers({ base: 'tiles' })}>Real map</button>
        </div>
        {layers.base === 'tiles' && (
          <div className="seg" style={{ marginBottom: 9 }}>
            <button aria-pressed={layers.tileStyle === 'topo'} onClick={() => onLayers({ tileStyle: 'topo' })}>Topographic</button>
            <button aria-pressed={layers.tileStyle === 'satellite'} onClick={() => onLayers({ tileStyle: 'satellite' })}>Satellite</button>
          </div>
        )}
        {layers.base === 'tiles' && (
          <label className="check">
            <input type="checkbox" checked={layers.fuelOverlay} onChange={(e) => onLayers({ fuelOverlay: e.target.checked })} />
            Tint by fuel model
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={layers.contours} disabled={layers.base === 'tiles'} onChange={(e) => onLayers({ contours: e.target.checked })} />
          100 m contours
        </label>
        <label className="check">
          <input type="checkbox" checked={layers.isochrones} onChange={(e) => onLayers({ isochrones: e.target.checked })} />
          Arrival-time isochrones
        </label>
        <label
          className={`check${canShowActiveFires ? '' : ' disabled'}`}
          title={
            canShowActiveFires
              ? 'NASA FIRMS VIIRS + MODIS detections from the last 24 h. Click one to ignite there.'
              : 'Needs the server: FIRMS sends no CORS headers, so the browser cannot read it directly.'
          }
        >
          <input
            type="checkbox"
            checked={layers.activeFires}
            disabled={!canShowActiveFires}
            onChange={(e) => onLayers({ activeFires: e.target.checked })}
          />
          Show current fires
        </label>
        <p className="note">
          Elevation comes from a real DEM and the fuel grid is classified from satellite imagery, so
          the fire runs up the actual ridges. Procedural terrain is used only as an offline fallback.
        </p>
      </section>
    </>
  )
}
