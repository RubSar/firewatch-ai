import { FUELS, FUEL_LEGEND } from '@firewatch/sim/fuels'
import type { BaseLayer } from '../render/paint.ts'
import { THERMAL_CSS_GRADIENT } from '../render/thermal.ts'

const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`

export function Legend({
  base,
  fuelOverlay,
  thermal,
  ambientC,
}: {
  base: BaseLayer
  fuelOverlay: boolean
  thermal?: boolean
  ambientC?: number
}) {
  const showFuel = base === 'fuel' || fuelOverlay

  // In infrared the fire colours mean nothing; a temperature scale does.
  if (thermal) {
    const lo = Math.round(ambientC ?? 20)
    const hi = lo + 1050
    const mid = Math.round(lo + (hi - lo) / 2)
    return (
      <div className="legend">
        <h4>Apparent temperature</h4>
        <div className="thermal-bar" style={{ background: `linear-gradient(90deg, ${THERMAL_CSS_GRADIENT})` }} />
        <div className="thermal-ticks">
          <span>{lo}&deg;C</span>
          <span>{mid}&deg;C</span>
          <span>{hi}&deg;C</span>
        </div>
        <div className="legend-row" style={{ marginTop: 6 }}>
          <i style={{ background: 'rgb(122,24,104)' }} />
          <span>smouldering &amp; cooling scar</span>
        </div>
        <div className="legend-row">
          <i style={{ background: 'rgb(252,206,88)' }} />
          <span>flaming front</span>
        </div>
        <div className="legend-row">
          <i style={{ background: 'rgb(4,10,34)' }} />
          <span>water &mdash; coldest</span>
        </div>
        <p className="legend-note">
          Modelled, not measured. Scale matches the brightness temperature FIRMS reports.
        </p>
      </div>
    )
  }

  return (
    <div className="legend">
      {(showFuel || base === 'elevation') && <h4>{base === 'elevation' ? 'Elevation' : 'Fuel model'}</h4>}
      {base === 'elevation' ? (
        <>
          <div className="legend-row">
            <i style={{ background: 'linear-gradient(90deg,#38603f,#a2985c,#b0827a,#e2e2e6)', width: 74 }} />
            <span>valley &rarr; ridge</span>
          </div>
        </>
      ) : showFuel ? (
        FUEL_LEGEND.map((f) => (
          <div className="legend-row" key={f}>
            <i style={{ background: rgb(FUELS[f].color) }} />
            <span>{FUELS[f].name}</span>
          </div>
        ))
      ) : null}
      <h4 style={showFuel || base === 'elevation' ? { marginTop: 10 } : undefined}>Fire</h4>
      <div className="legend-row">
        <i style={{ background: 'linear-gradient(90deg,#d8410c,#ff7a1a,#ffb840,#fff0bd)', width: 34 }} />
        <span>active &mdash; by intensity</span>
      </div>
      <div className="legend-row">
        <i style={{ background: '#3a1a10' }} />
        <span>smouldering</span>
      </div>
      <div className="legend-row">
        <i style={{ background: '#2b2522' }} />
        <span>burnt</span>
      </div>
      <div className="legend-row">
        <i style={{ background: '#c4aa7e' }} />
        <span>dozer line</span>
      </div>
      <div className="legend-row">
        <i style={{ background: '#b2453a' }} />
        <span>retardant drop</span>
      </div>
    </div>
  )
}
