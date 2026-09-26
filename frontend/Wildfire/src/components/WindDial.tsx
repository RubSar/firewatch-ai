import { useCallback, useRef } from 'react'
import { compassLabel } from '../sim/weather.ts'

interface Props {
  /** Direction the wind blows FROM, degrees. */
  dir: number
  speed: number
  gust: number
  disabled?: boolean
  onChange: (dir: number) => void
}

const SIZE = 118
const R = SIZE / 2

export function WindDial({ dir, speed, gust, disabled, onChange }: Props) {
  const ref = useRef<SVGSVGElement>(null)

  const pointAt = useCallback(
    (e: PointerEvent | React.PointerEvent) => {
      const el = ref.current
      if (!el || disabled) return
      const b = el.getBoundingClientRect()
      const dx = e.clientX - (b.left + b.width / 2)
      const dy = e.clientY - (b.top + b.height / 2)
      // Screen angle -> compass bearing of the point the user grabbed.
      const deg = (Math.atan2(dx, -dy) * 180) / Math.PI
      onChange(Math.round((deg + 360) % 360))
    },
    [onChange, disabled]
  )

  const onDown = (e: React.PointerEvent) => {
    if (disabled) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pointAt(e)
    const move = (ev: PointerEvent) => pointAt(ev)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // The arrow points the way the wind pushes the fire.
  const toDeg = (dir + 180) % 360
  const rad = (toDeg * Math.PI) / 180
  const len = 14 + Math.min(34, (speed / 90) * 34)
  const tipX = R + Math.sin(rad) * len
  const tipY = R - Math.cos(rad) * len
  const tailX = R - Math.sin(rad) * (len * 0.55)
  const tailY = R + Math.cos(rad) * (len * 0.55)

  return (
    <svg
      ref={ref}
      className="dial"
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      onPointerDown={onDown}
      role="slider"
      aria-label="Wind direction"
      aria-valuenow={Math.round(dir)}
      aria-valuemin={0}
      aria-valuemax={359}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'ArrowLeft') onChange((dir + 355) % 360)
        if (e.key === 'ArrowRight') onChange((dir + 5) % 360)
      }}
    >
      <circle cx={R} cy={R} r={R - 1} fill="#141b24" stroke="#27313f" />
      <circle cx={R} cy={R} r={R - 12} fill="none" stroke="#202a36" strokeDasharray="2 4" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
        const t = (a * Math.PI) / 180
        const major = a % 90 === 0
        const r1 = R - 3
        const r2 = R - (major ? 9 : 6)
        return (
          <line
            key={a}
            x1={R + Math.sin(t) * r1}
            y1={R - Math.cos(t) * r1}
            x2={R + Math.sin(t) * r2}
            y2={R - Math.cos(t) * r2}
            stroke={major ? '#4c5b6e' : '#2d3846'}
            strokeWidth={major ? 1.5 : 1}
          />
        )
      })}
      {(['N', 'E', 'S', 'W'] as const).map((c, i) => {
        const t = ((i * 90) * Math.PI) / 180
        return (
          <text
            key={c}
            x={R + Math.sin(t) * (R - 19)}
            y={R - Math.cos(t) * (R - 19) + 3.5}
            textAnchor="middle"
            fontSize="9"
            fill="#6b7a8d"
          >
            {c}
          </text>
        )
      })}
      {/* gust halo */}
      <circle cx={R} cy={R} r={7 + gust * 9} fill="rgba(255,107,26,.13)">
        <animate attributeName="r" values={`7;${7 + gust * 13};7`} dur={`${2.6 - gust * 1.4}s`} repeatCount="indefinite" />
      </circle>
      <line x1={tailX} y1={tailY} x2={tipX} y2={tipY} stroke="#ff6b1a" strokeWidth="3" strokeLinecap="round" />
      <polygon
        points={`${tipX},${tipY} ${tipX - Math.sin(rad - 2.5) * 9},${tipY + Math.cos(rad - 2.5) * 9} ${
          tipX - Math.sin(rad + 2.5) * 9
        },${tipY + Math.cos(rad + 2.5) * 9}`}
        fill="#ff6b1a"
      />
      <circle cx={R} cy={R} r="3.5" fill="#ffd24d" />
      <title>{`Wind from ${compassLabel(dir)} (${Math.round(dir)} deg) — drag to change`}</title>
    </svg>
  )
}
