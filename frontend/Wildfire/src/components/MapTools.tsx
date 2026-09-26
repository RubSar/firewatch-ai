import type { Tool } from './ControlPanel.tsx'

/**
 * Tool palette, on the map rather than in the sidebar.
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
  /** Infrared view. A view mode, not a tool — hence its own group. */
  thermal: boolean
  onThermal: (v: boolean) => void
}

const DRAW: { id: Tool; icon: string; label: string; hint: string }[] = [
  { id: 'ignite', icon: '🔥', label: 'Ignite', hint: 'Click the map to start a fire' },
  { id: 'dozer', icon: '🚜', label: 'Dozer line', hint: 'Drag to cut a control line' },
  { id: 'retardant', icon: '🛩️', label: 'Retardant', hint: 'Drag to lay a retardant drop' },
]

export function MapTools({ tool, onTool, onClearLines, hasLines, thermal, onThermal }: Props) {
  return (
    <div className="maptools" role="toolbar" aria-label="Map tools">
      {DRAW.map((t) => (
        <button
          key={t.id}
          className="mt-btn"
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
        aria-pressed={tool === 'pan'}
        onClick={() => onTool('pan')}
        title="Stop drawing and drag the map around"
      >
        <span className="ico">✋</span>
        <span className="mt-label">Pan map</span>
      </button>

      <button
        className="mt-btn mt-clear"
        onClick={onClearLines}
        disabled={!hasLines}
        title={hasLines ? 'Remove every control line and drop' : 'No lines or drops to clear'}
      >
        <span className="ico">🧹</span>
        <span className="mt-label">Clear</span>
      </button>

      <span className="mt-divider" aria-hidden="true" />

      <button
        className="mt-btn mt-thermal"
        aria-pressed={thermal}
        onClick={() => onThermal(!thermal)}
        title="Infrared view: render apparent temperature instead of the fire's own colours. Shows smouldering and cooling ground the visible view cannot."
      >
        <span className="ico">🌡️</span>
        <span className="mt-label">Thermal</span>
      </button>
    </div>
  )
}
