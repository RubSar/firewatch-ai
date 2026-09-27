// Dev-only harness: compares real imagery against what the classifier makes of it.
import { SCENARIOS, buildTerrain } from '@firewatch/sim/terrain'
import { FUELS } from '@firewatch/sim/fuels'
import { loadRealTerrain, debugImagery, debugBands } from './data/realData.ts'

const out = document.getElementById('out')!
out.innerHTML = ''

const canvasOf = (cols: number, rows: number, paint: (d: Uint8ClampedArray) => void, caption: string) => {
  const cv = document.createElement('canvas')
  cv.width = cols; cv.height = rows
  cv.style.width = `${cols * 1.7}px`
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(cols, rows)
  paint(img.data)
  ctx.putImageData(img, 0, 0)
  const fig = document.createElement('figure')
  const cap = document.createElement('figcaption')
  cap.textContent = caption
  fig.append(cap, cv)
  return fig
}

for (const sc of SCENARIOS) {
  const base = buildTerrain(sc)
  const { cols, rows } = base
  const [{ terrain, note }, imagery, bands] = await Promise.all([loadRealTerrain(base), debugImagery(base), debugBands(base)])

  const row = document.createElement('div')
  row.className = 'row'

  if (imagery) row.append(canvasOf(cols, rows, (d) => d.set(imagery), `${sc.name} — Sentinel-2 cloudless`))

  row.append(
    canvasOf(cols, rows, (d) => {
      for (let i = 0; i < cols * rows; i++) {
        const f = FUELS[terrain.fuel[i]]
        const sh = 0.45 + 0.85 * terrain.shade[i]
        d[i * 4] = f.color[0] * sh
        d[i * 4 + 1] = f.color[1] * sh
        d[i * 4 + 2] = f.color[2] * sh
        d[i * 4 + 3] = 255
      }
    }, `classified fuel — ${note}`)
  )

  row.append(
    canvasOf(cols, rows, (d) => {
      const span = Math.max(1, terrain.maxElev - terrain.minElev)
      for (let i = 0; i < cols * rows; i++) {
        const t = (terrain.elevation[i] - terrain.minElev) / span
        const v = 40 + 200 * terrain.shade[i]
        d[i * 4] = v * (0.6 + 0.5 * t)
        d[i * 4 + 1] = v * (0.75 - 0.2 * t)
        d[i * 4 + 2] = v * (0.6 - 0.3 * t)
        d[i * 4 + 3] = 255
      }
    }, `DEM hillshade — ${terrain.minElev.toFixed(0)}…${terrain.maxElev.toFixed(0)} m`)
  )

  const counts: Record<string, number> = {}
  for (let i = 0; i < cols * rows; i++) {
    const n = FUELS[terrain.fuel[i]].name
    counts[n] = (counts[n] ?? 0) + 1
  }
  const pct = (xs: number[], q: number) => xs[Math.floor(q * (xs.length - 1))].toFixed(3)
  let bandText = ''
  if (bands) {
    for (const k of ['grvi', 'bright', 'texture', 'blueness'] as const) {
      const xs = bands.map((b) => b[k]).sort((a, b) => a - b)
      bandText += `${k.padEnd(9)} p5=${pct(xs, 0.05)} p25=${pct(xs, 0.25)} p50=${pct(xs, 0.5)} p75=${pct(xs, 0.75)} p95=${pct(xs, 0.95)}\n`
    }
  }
  const pre = document.createElement('pre')
  pre.textContent = bandText + '\n' + Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${((v / (cols * rows)) * 100).toFixed(1)}%`)
    .join('\n')
  row.append(pre)
  out.append(row)
}
document.title = 'calibration ready'
