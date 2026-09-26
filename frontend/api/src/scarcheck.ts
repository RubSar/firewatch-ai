/**
 * Diagnostic: does dNBR find real burn scars?
 *   npm run scarcheck --workspace=@firewatch/api
 * Sites with recent large fires should show a burnt fraction; controls ~0.
 */
import { scenarioAt, buildTerrain } from '@firewatch/sim/terrain'
import { loadConfig } from './config.ts'
import { burnScarsFor } from './providers/burnhistory.ts'

const cfg = loadConfig()
const SITES: [string, number, number, string][] = [
  ['Palisades/LA (US)', 34.07, -118.55, 'Jan 2025 urban-interface fire'],
  ['Jasper (CA)', 52.88, -118.08, 'Jul 2024 townsite fire'],
  ['Khosrov (AM)', 39.98, 44.95, 'control — no recent large fire'],
  ['Lake Tahoe (US)', 39.10, -120.03, 'control — mostly water'],
]
for (const [name, lat, lng, why] of SITES) {
  const g = buildTerrain(scenarioAt(lat, lng, 20))
  const t0 = Date.now()
  try {
    const s = await burnScarsFor(g.bounds, g.cols, g.rows, cfg, { deadlineMs: 300000 })
    if (!s) { console.log(`${name.padEnd(20)} no usable scene pair       (${why})`); continue }
    const hist = [0, 0, 0, 0, 0]
    for (const c of s.severity) hist[c]++
    const n = s.severity.length
    console.log(
      `${name.padEnd(20)} burnt ${(s.burntFraction * 100).toFixed(1).padStart(5)}%  ` +
      `low/modlow/modhi/high = ${hist.slice(1).map((v) => ((v / n) * 100).toFixed(1)).join('/')}  ` +
      `${s.preDate} vs ${s.postDate}  ${((Date.now() - t0) / 1000).toFixed(0)}s   (${why})`
    )
  } catch (err) {
    console.log(`${name.padEnd(20)} FAILED: ${(err as Error).message}`)
  }
}
