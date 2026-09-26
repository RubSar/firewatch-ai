interface Props {
  history: { t: number; area: number }[]
  /** Hectares, used so the y-axis does not jump around while paused. */
  peak: number
}

/** Sparkline of cumulative burnt area against simulated time. */
export function GrowthChart({ history, peak }: Props) {
  const W = 300
  const H = 40
  if (history.length < 2) {
    return (
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <line x1="0" y1={H - 1} x2={W} y2={H - 1} stroke="#27313f" />
      </svg>
    )
  }
  const tMax = Math.max(3600, history[history.length - 1].t)
  const yMax = Math.max(1, peak)
  const pts = history.map((h) => {
    const x = (h.t / tMax) * W
    const y = H - 2 - (h.area / yMax) * (H - 5)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Burnt area over time">
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="0" y1={H * f} x2={W} y2={H * f} stroke="#1f2833" strokeWidth="1" />
      ))}
      <polygon points={`0,${H} ${pts.join(' ')} ${W * (history[history.length - 1].t / tMax)},${H}`} fill="rgba(255,107,26,.18)" />
      <polyline points={pts.join(' ')} fill="none" stroke="#ff6b1a" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
