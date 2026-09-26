/**
 * Diagnostic: are the OSM barriers real, and do they block the right edges?
 *
 *   npm run barriercheck --workspace=@firewatch/api
 *   FIREWATCH_MODE=offline npm run barriercheck --workspace=@firewatch/api   # geometry only
 *
 * Two halves. The first is offline and deterministic: a barrier lying exactly
 * along a cell boundary must block the flux *across* it and leave the flux
 * *along* it open. Getting that backwards is invisible in the UI — the fire
 * still slows down, just in the wrong direction — so it is asserted here.
 *
 * The second half hits Overpass for each scenario and reports what came back.
 * A road count of zero means the query or the bbox is wrong, not that Armenia
 * has no roads.
 */
import { SCENARIOS, buildTerrain, scenarioAt } from '@firewatch/sim/terrain'
import { Cell, NEIGHBOURS, createSim, ignite, recomputeStats, step } from '@firewatch/sim/model'
import { getPreset } from '@firewatch/sim/weather'
import type { Params } from '@firewatch/sim/weather'
import { loadConfig } from './config.ts'
import { osmBarriers, blockSegment } from './providers/osm.ts'

const cfg = loadConfig()
const D = { N: 0, NE: 1, E: 2, SE: 3, S: 4, SW: 5, W: 6, NW: 7 } as const
let failures = 0
/** blockFrac is a Float32Array, so 0.8 comes back as 0.800000011920929. */
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log(`barriercheck · mode=${cfg.mode}\n`)
console.log('▸ edge geometry (no network)')
{
  const cols = 5, rows = 5
  const b = new Float32Array(cols * rows * 8)
  // A barrier straight along the boundary between rows 1 and 2.
  blockSegment(b, cols, rows, { x: 0, y: 2 }, { x: 5, y: 2 }, 0.8)
  const at = (c: number, r: number, d: number) => b[(r * cols + c) * 8 + d]

  check(near(at(2, 1, D.S), 0.8), 'flux across the barrier is blocked', `S = ${at(2, 1, D.S)}`)
  check(at(2, 1, D.E) === 0, 'flux along the barrier is open', `E = ${at(2, 1, D.E)}`)
  check(at(2, 1, D.N) === 0, 'flux away from the barrier is open', `N = ${at(2, 1, D.N)}`)
  check(near(at(2, 2, D.N), 0.8), 'the far side sees the same edge', `N = ${at(2, 2, D.N)}`)
  check(near(at(2, 1, D.SE), 0.8), 'diagonals crossing it are blocked too', `SE = ${at(2, 1, D.SE)}`)

  // A vertical barrier is the same claim rotated, and catches a transposed index.
  const v = new Float32Array(cols * rows * 8)
  blockSegment(v, cols, rows, { x: 2, y: 0 }, { x: 2, y: 5 }, 0.8)
  const vat = (c: number, r: number, d: number) => v[(r * cols + c) * 8 + d]
  check(near(vat(1, 2, D.E), 0.8) && vat(1, 2, D.S) === 0, 'vertical barrier blocks E, not S',
    `E = ${vat(1, 2, D.E)} S = ${vat(1, 2, D.S)}`)

  // NEIGHBOURS order is the contract between this provider and the kernel.
  check(NEIGHBOURS[D.S][1] === 1 && NEIGHBOURS[D.E][0] === 1, 'NEIGHBOURS order unchanged',
    NEIGHBOURS.map(([dc, dr]) => `${dc},${dr}`).join(' '))
}

console.log('\n▸ the kernel honours the field (no network)')
{
  // A controlled A/B: identical terrain, identical seed, identical weather, one
  // wall of fully blocked edges. Anything other than "crosses / does not cross"
  // means the field is being fetched and ignored, which is what it was before.
  const sc = scenarioAt(40.0, 44.95, 15)
  const t = buildTerrain(sc)
  const wall = Math.floor(t.cols / 2) + 20
  const params: Params = {
    ...getPreset(sc.preset).weather,
    // Wind from the west so the head runs at the wall, and no spotting: embers
    // are *meant* to cross a road, so leaving them on would test nothing.
    windDir: 270,
    windSpeed: 35,
    gustiness: 0,
    spotting: 0,
    suppression: 0,
    followForecast: false,
  }

  const blockFrac = new Float32Array(t.cols * t.rows * 8)
  blockSegment(blockFrac, t.cols, t.rows, { x: wall, y: 0 }, { x: wall, y: t.rows }, 1)

  const run = (barrier: Float32Array | null) => {
    const sim = createSim(t)
    ignite(sim, Math.floor(t.cols / 2), Math.floor(t.rows / 2), 2)
    for (let k = 0; k < 900; k++) {
      step(sim, { params, weather: params, dt: 10, ...(barrier ? { blockFrac: barrier } : {}) })
    }
    recomputeStats(sim)
    let past = 0
    for (let r = 0; r < t.rows; r++) {
      for (let c = wall; c < t.cols; c++) if (sim.state[r * t.cols + c] !== Cell.Unburned) past++
    }
    return { area: sim.stats.area, past }
  }

  const open = run(null)
  const blocked = run(blockFrac)
  check(open.past > 50, 'without the wall the fire crosses the line',
    `${open.past} cells past it, ${open.area.toFixed(0)} ha total`)
  check(blocked.past === 0, 'with the wall it does not',
    `${blocked.past} cells past it, ${blocked.area.toFixed(0)} ha total`)
}

if (cfg.mode === 'live') {
  console.log('\n▸ overpass per scenario')
  for (const sc of SCENARIOS) {
    const base = buildTerrain(sc)
    const grid = {
      bounds: base.bounds, cols: base.cols, rows: base.rows,
      cellSize: base.cellSize, crs: 'EPSG:4326' as const,
    }
    const t0 = Date.now()
    try {
      // The provider directly, not through `resolve`: a diagnostic that silently
      // reported the fallback's empty field would be testing `noBarriers`.
      const got = await osmBarriers(cfg).fetch({ grid, scenario: sc })
      const bf = got.data.blockFrac
      let blocked = 0
      let sum = 0
      for (const v of bf) if (v > 0) { blocked++; sum += v }
      const pct = ((blocked / bf.length) * 100).toFixed(2)
      check(
        got.provenance.kind === 'derived' && blocked > 0,
        `${sc.id} (${Date.now() - t0}ms)`,
        `${blocked} edges ${pct}% mean block ${blocked ? (sum / blocked).toFixed(2) : '—'} · ${got.provenance.source}`
      )
      console.log(`      ${got.provenance.note}`)
      if (got.provenance.degradedFrom) console.log(`      DEGRADED from ${got.provenance.degradedFrom}`)
    } catch (err) {
      check(false, `${sc.id}`, (err as Error).message)
    }
  }
} else {
  console.log('\n(offline: skipping Overpass — run without FIREWATCH_MODE=offline to check the feed)')
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
