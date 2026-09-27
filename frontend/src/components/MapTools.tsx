import type { Tool } from './ControlPanel.tsx'

/**
 * Tool palette, on the map rather than in the sidebar.
 *
 * Every button carries an explicit aria-label: the visible text collapses to
 * icons on narrower viewports, so it cannot be relied on as the accessible
 * name. Screen readers and the smoke test both read the label, which is why
 * they stay in sync.
 *
 * Tools belong with the thing they act on: you are looking at the map when you
 * decide to stop drawing and pan, and hunting the left panel for that is the
 * wrong ask. Pan is also separated from the three drawing tools by a divider —
 * it is not a fourth brush, it is the absence of one, and styling it as a peer
 * of Ignite/Dozer/Retardant is what made it hard to find.
 */
interface Props {
  tool: Tool
  onTool: (t: Tool) => void
  onClearLines: () => void
  hasLines: boolean
  /** Overlay toggles. View modes, not tools — hence their own group. */
  thermal: boolean
  onThermal: (v: boolean) => void
  isochrones: boolean
  onIsochrones: (v: boolean) => void
  activeFires: boolean
  onActiveFires: (v: boolean) => void
  /** False in browser-only mode: FIRMS sends no CORS headers. */
  canShowActiveFires: boolean
}

const DRAW: { id: Tool; icon: string; label: string; hint: string }[] = [
  { id: 'ignite', icon: '🔥', label: 'Ignite', hint: 'Click the map to start a fire' },
  { id: 'dozer', icon: '🚜', label: 'Dozer line', hint: 'Drag to cut a control line' },
  { id: 'retardant', icon: '🛩️', label: 'Retardant', hint: 'Drag to lay a retardant drop' },
]

export function MapTools({
  tool, onTool, onClearLines, hasLines,
  thermal, onThermal, isochrones, onIsochrones, activeFires, onActiveFires, canShowActiveFires,
}: Props) {
  return (
    <div className="maptools" role="toolbar" aria-label="Map tools">
      {DRAW.map((t) => (
        <button
          key={t.id}
          className="mt-btn"
          aria-label={t.label}
          aria-pressed={tool === t.id}
          onClick={() => onTool(t.id)}
          title={t.hint}
        >
          <span className="ico">{t.icon}</span>
          <span className="mt-label">{t.label}</span>
        </button>
      ))}

      <span className="mt-divider" aria-hidden="true" />

      <button
        className="mt-btn mt-pan"
        aria-label="Pan map"
        aria-pressed={tool === 'pan'}
        onClick={() => onTool('pan')}
        title="Stop drawing and drag the map around"
      >
        <span className="ico">✋</span>
        <span className="mt-label">Pan map</span>
      </button>

      <button
        className="mt-btn mt-clear"
        aria-label="Clear lines and drops"
        onClick={onClearLines}
        disabled={!hasLines}
        title={hasLines ? 'Remove every control line and drop' : 'No lines or drops to clear'}
      >
        <span className="ico">🧹</span>
        <span className="mt-label">Clear</span>
      </button>

      <span className="mt-divider" aria-hidden="true" />

      <button
        className="mt-btn mt-view"
        aria-label="Thermal (infrared) view"
        aria-pressed={thermal}
        onClick={() => onThermal(!thermal)}
        title="Infrared view: render apparent temperature instead of the fire's own colours. Shows smouldering and cooling ground the visible view cannot."
      >
        <span className="ico">🌡️</span>
        <span className="mt-label">Thermal</span>
      </button>

      <button
        className="mt-btn mt-view"
        aria-label="Arrival-time isochrones"
        aria-pressed={isochrones}
        onClick={() => onIsochrones(!isochrones)}
        title="Band the burn scar by the hour the fire reached it, instead of drawing it as one scar"
      >
        <span className="ico">⏱️</span>
        <span className="mt-label">Isochrones</span>
      </button>

      <button
        className="mt-btn mt-view"
        aria-label="Show current fires"
        aria-pressed={activeFires}
        disabled={!canShowActiveFires}
        onClick={() => onActiveFires(!activeFires)}
        title={
          canShowActiveFires
            ? 'NASA FIRMS VIIRS + MODIS detections from the last 24 h. Click one to ignite there.'
            : 'Needs the server: FIRMS sends no CORS headers, so the browser cannot read it directly.'
        }
      >
        <span className="ico">🛰️</span>
        <span className="mt-label">Fires</span>
      </button>
    </div>
  )
}
