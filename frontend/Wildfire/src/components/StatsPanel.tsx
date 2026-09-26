import type { Stats } from '../sim/model.ts'
import { STRUCTURES_PER_HA } from '../sim/model.ts'

interface Props {
  stats: Stats
  fmc: number
}

const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

export function StatsPanel({ stats, fmc }: Props) {
  const acres = stats.area * 2.4711
  return (
    <div className="stats">
      <h3>Incident status</h3>
      <div className="stat hi">
        <span className="k">Area burnt</span>
        <span className="v">{fmt(stats.area)} ha</span>
      </div>
      <div className="stat">
        <span className="k">&nbsp;</span>
        <span className="v" style={{ color: 'var(--muted)', fontSize: 11 }}>{fmt(acres)} acres</span>
      </div>
      <div className="stat">
        <span className="k">Perimeter</span>
        <span className="v">{fmt(stats.perimeter, 1)} km</span>
      </div>
      <div className="stat">
        <span className="k">Containment</span>
        <span className="v" style={{ color: stats.containment > 0.7 ? 'var(--good)' : undefined }}>
          {fmt(stats.containment * 100)}%
        </span>
      </div>
      <div className="contain-bar">
        <i style={{ width: `${Math.min(100, stats.containment * 100)}%` }} />
      </div>
      <hr />
      <div className="stat">
        <span className="k">Head-fire spread</span>
        <span className="v hot">{fmt(stats.maxRos, 1)} m/min</span>
      </div>
      <div className="stat">
        <span className="k">Fireline intensity</span>
        <span className="v hot">{fmt(stats.maxIntensity)} kW/m</span>
      </div>
      <div className="stat">
        <span className="k">Flame length</span>
        <span className="v hot">{fmt(stats.flameLength, 1)} m</span>
      </div>
      <div className="stat">
        <span className="k">Dead fuel moisture</span>
        <span className="v" style={{ color: fmc < 6 ? 'var(--ember)' : fmc > 20 ? 'var(--cool)' : undefined }}>
          {fmt(fmc, 1)}%
        </span>
      </div>
      <hr />
      <div className="stat">
        <span className="k">Active cells</span>
        <span className="v">{fmt(stats.activeCells)}</span>
      </div>
      <div className="stat">
        <span className="k">Spot fires</span>
        <span className="v">{fmt(stats.spotFires)}</span>
      </div>
      <div className="stat">
        <span className="k" title={`Estimated at ${STRUCTURES_PER_HA} structures per hectare of burnt developed land`}>
          Structures lost*
        </span>
        <span className="v warn">{fmt(stats.structuresLost)}</span>
      </div>
      <p className="note" style={{ margin: '8px 0 0', fontSize: 10 }}>
        * estimated at {STRUCTURES_PER_HA} structures per hectare of burnt developed land.
      </p>
    </div>
  )
}
