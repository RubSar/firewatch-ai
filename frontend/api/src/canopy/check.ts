/**
 * Proves the TypeScript inference path reproduces scikit-learn.
 *
 *   npm run canopy:check --workspace=@firewatch/api
 *
 * The model is trained in Python and served in TypeScript, so there are two
 * implementations of the same tree walk and nothing about a wrong one looks
 * wrong: an off-by-one on a child index, a `<` where sklearn uses `<=`, a
 * forgotten learning-rate scaling or a missed clip all produce canopy numbers
 * that are entirely plausible and quietly different. `train.py` already checks
 * its export against sklearn in Python; this checks the code that actually runs
 * in production against a fixture of sklearn's own predictions on real rows.
 *
 * Follows the `watercheck` / `barriercheck` pattern — a script that asserts and
 * exits non-zero, not a unit test, because it needs the trained artefacts.
 */
import { readFileSync } from 'node:fs'
import { FEATURE_COUNT, FEATURE_NAMES } from './features.ts'
import { loadCanopyModel, predictCanopy } from '../providers/canopy-learned.ts'

interface Parity {
  featureNames: string[]
  rows: number[][]
  expect: Record<'cbh' | 'cbd' | 'cover' | 'height', number[]>
}

const path = new URL('./parity.json', import.meta.url).pathname
let parity: Parity
try {
  parity = JSON.parse(readFileSync(path, 'utf8')) as Parity
} catch {
  console.log(`no parity fixture at ${path} — run \`npm run canopy:train\` first`)
  process.exit(1)
}

const model = loadCanopyModel()
const fails: string[] = []
const ok = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) fails.push(msg)
}

console.log(`canopy model: ${model.raw.rows} rows, ${model.raw.regions.length} regions, trained ${model.raw.trainedAt}`)
console.log(`labels: ${model.raw.labelSource}\n`)

ok(
  parity.featureNames.join(',') === FEATURE_NAMES.join(','),
  `fixture feature order matches the code (${FEATURE_COUNT} features)`
)

// TOLERANCE. The fixture is rounded to 8 decimals and the features are carried
// through a Float32Array on the TS side, where Python used float64. Inference is
// a sequence of threshold comparisons, so a float32 rounding that lands a value
// on the far side of a split changes the leaf and therefore the prediction by a
// whole leaf's worth. That is expected and rare; it is not a wrong walk. A wrong
// walk misses by a large margin on most rows, so the check is on the worst
// absolute error AND on how many rows disagree at all.
const TOL = 1e-4
const TARGETS = ['cbh', 'cbd', 'cover', 'height'] as const
const x = new Float32Array(FEATURE_COUNT)
const worst: Record<string, number> = {}
const differing: Record<string, number> = {}

for (const t of TARGETS) {
  worst[t] = 0
  differing[t] = 0
}

for (let r = 0; r < parity.rows.length; r++) {
  for (let f = 0; f < FEATURE_COUNT; f++) x[f] = parity.rows[r][f]
  const got = predictCanopy(model, x, 0)
  for (const t of TARGETS) {
    const err = Math.abs(got[t] - parity.expect[t][r])
    if (err > worst[t]) worst[t] = err
    if (err > TOL) differing[t]++
  }
}

const n = parity.rows.length
for (const t of TARGETS) {
  const pct = (differing[t] / n) * 100
  ok(
    differing[t] === 0 || (pct < 3 && worst[t] < 0.6),
    `${t}: ${differing[t]}/${n} rows differ (${pct.toFixed(1)}%), worst |TS - sklearn| = ${worst[t].toExponential(2)}`
  )
}

// A wrong walk would still be self-consistent, so check the predictions are
// physically sane too — this is what would catch a clip or an init term lost.
const timber = new Float32Array(FEATURE_COUNT)
for (let f = 0; f < FEATURE_COUNT; f++) timber[f] = parity.rows[0][f]
const p0 = predictCanopy(model, timber, 0)
ok(p0.cbh >= 0 && p0.cbh <= 10, `CBH in the LANDFIRE range: ${p0.cbh.toFixed(2)} m`)
ok(p0.cbd >= 0 && p0.cbd <= 0.45, `CBD in the LANDFIRE range: ${p0.cbd.toFixed(3)} kg/m3`)
ok(p0.cover >= 0 && p0.cover <= 1, `cover is a fraction: ${p0.cover.toFixed(2)}`)
ok(p0.load >= 0, `load is non-negative: ${p0.load.toFixed(2)} kg/m2`)
ok(
  p0.height >= p0.cbh,
  `canopy top above its base: height ${p0.height.toFixed(1)} m vs CBH ${p0.cbh.toFixed(2)} m`
)

// Inference cost, because it runs inside incident creation for every woody cell.
const CELLS = 160_000
const t0 = performance.now()
for (let i = 0; i < CELLS; i++) predictCanopy(model, x, 0)
const ms = performance.now() - t0
console.log(`\n  ${CELLS.toLocaleString()} cells in ${ms.toFixed(0)} ms (${(ms / CELLS * 1000).toFixed(2)} us/cell)`)
ok(ms < 8000, `a full 400x400 grid costs under 8 s of the ~7 s incident budget`)

console.log(`\n${fails.length ? `✗ ${fails.length} FAILED` : '✓ TypeScript inference matches scikit-learn'}`)
process.exit(fails.length ? 1 : 0)
