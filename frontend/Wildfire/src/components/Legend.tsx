import { FUELS, FUEL_LEGEND } from '../sim/fuels.ts'
import type { BaseLayer } from '../render/paint.ts'

const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`

export function Legend({ base, fuelOverlay }: { base: BaseLayer; fuelOverlay: boolean }) {
  const showFuel = base === 'fuel' || fuelOverlay
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
