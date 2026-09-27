import type { Stats } from '@firewatch/sim/model'
import { STRUCTURES_PER_HA } from '@firewatch/sim/model'

interface Props {
  stats: Stats
  fmc: number
  /**
   * True when the server counted real OSM building footprints per cell. The
   * figure means a different thing then, so the footnote has to change with it.
   */
  structuresCounted?: boolean
}

const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

export function StatsPanel({ stats, fmc, structuresCounted }: Props) {
  const acres = stats.area * 2.4711
  const structuresNote = structuresCounted
    ? 'mapped OSM buildings inside the burn scar — unmapped ones are not counted'
    : `estimated at ${STRUCTURES_PER_HA} structures per hectare of burnt developed land`
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
        <span
          className="k"
          title="Cells where the fire left the surface and entered the canopy (Van Wagner). Crowning multiplies fireline intensity and throws embers much further."
        >
          Crown fire
        </span>
        <span className={`v${stats.crownCells > 0 ? ' alarm' : ''}`}>{fmt(stats.crownCells)}</span>
      </div>
      <div className="stat">
        <span className="k" title={structuresNote}>
          Structures lost*
        </span>
        <span className="v warn">{fmt(stats.structuresLost)}</span>
      </div>
      <p className="note" style={{ margin: '8px 0 0', fontSize: 10 }}>
        * {structuresNote}.
      </p>
    </div>
  )
}
