/**
 * Canopy structure from a model trained on LANDFIRE — §9 `CanopyProvider`.
 *
 * Replaces `assumedCanopy`, which handed every timber cell CBH 5 m and CBD 0.1
 * and was the last synthetic port. Those two constants are the entire input to
 * Van Wagner's crown criteria, so crown fire — the behaviour that destroys towns
 * — was driven by numbers nobody measured. Sampled against LANDFIRE, the assumed
 * CBH of 5 m sits near the 90th percentile of a distribution whose median is
 * 0.8 m, which inflates `I_0 = [0.010 CBH (460 + 25.9 M_f)]^1.5` and suppresses
 * crowning across the board.
 *
 * WHAT THIS IS, EXACTLY. Gradient-boosted regression trees, trained on 5,499
 * cells across 13 CONUS regions, with LANDFIRE LF2023 CBH/CBD/CC/CH at 30 m as
 * labels and Sentinel-2 reflectance, SRTM-derived terrain and WorldCover class as
 * predictors. Cross-validated with whole regions held out, because neighbouring
 * 30 m pixels are near-duplicates and a random split would score interpolation
 * inside a forest the model already saw.
 *
 * WHY A MODEL RATHER THAN THE RASTER. LANDFIRE covers the US and this app
 * simulates anywhere on earth; the bookmarked scenarios are Armenian. Everywhere
 * outside CONUS the raster simply does not exist, and carrying the learned
 * relationship abroad is the whole point.
 *
 * Inside CONUS, reading LANDFIRE directly would be strictly better than
 * predicting it, and that provider does not exist yet. It is the obvious next
 * step and would make this one a fallback rather than the primary — worth doing
 * before anyone quotes US numbers.
 *
 * HOW GOOD IT IS, held out by region, against the constants it replaces:
 *
 *   cover   MAE 0.140 vs 0.205   RMSE 28% better
 *   height  MAE 4.65 vs 5.63 m   RMSE 18% better
 *   CBH     MAE 2.54 vs 3.96 m   RMSE 14% better
 *   CBD     MAE 0.048 vs 0.051   RMSE  4% better
 *
 * CBD is the honest disappointment and the one that matters most, because active
 * crowning is `R >= 3.0/CBD`. Optical reflectance sees the top of a canopy, and
 * bulk density is a property of its interior — a 4% gain is close to no signal.
 * Treat modelled CBD as "a field rather than a constant" and not as measurement;
 * lidar (GEDI L2B vertical profiles, Earthdata-gated) is what would actually move
 * it. The provenance note says so, and it must keep saying so.
 */
import { readFileSync } from 'node:fs'
import type {
  CanopyGrid, CanopyProvider, ElevationProvider, FuelProvider, TerrainQuery,
} from '@firewatch/contracts/providers'
import { Fuel } from '@firewatch/sim/fuels'
import type { Config } from '../config.ts'
import { prov } from './provenance.ts'
import { assumedCanopyFrom } from './tier1.ts'
import {
  FEATURE_COUNT, FEATURE_NAMES, featuresUsable, fetchReflectance, isWoody,
  writeFeatureRow, type FeatureGrids,
} from '../canopy/features.ts'

interface RawTree { f: number[]; t: number[]; l: number[]; r: number[]; v: number[] }
interface RawTarget { init: number; lr: number; trees: RawTree[] }
interface RawModel {
  featureNames: string[]
  targets: Record<string, RawTarget>
  clip: Record<string, [number, number]>
  trainedAt: string
  rows: number
  regions: string[]
  labelSource: string
  metrics: Record<string, { model: { mae: number; rmse: number }; assumed: { mae: number; rmse: number } }>
}

/**
 * Trees flattened into typed arrays, all trees of a target concatenated.
 *
 * Inference walks these for every woody cell of a 400x400 grid — 250 trees x 4
 * targets x up to 160,000 cells. Arrays-of-objects cost a pointer chase per node
 * and made that measurably slower for no benefit.
 */
interface FlatTarget {
  init: number
  lr: number
  /** Start index of each tree within the node arrays. */
  offsets: Int32Array
  feature: Int32Array
  threshold: Float64Array
  left: Int32Array
  right: Int32Array
  value: Float64Array
  lo: number
  hi: number
}

function flatten(t: RawTarget, clip: [number, number]): FlatTarget {
  const total = t.trees.reduce((n, tr) => n + tr.f.length, 0)
  const flat: FlatTarget = {
    init: t.init, lr: t.lr,
    offsets: new Int32Array(t.trees.length),
    feature: new Int32Array(total),
    threshold: new Float64Array(total),
    left: new Int32Array(total),
    right: new Int32Array(total),
    value: new Float64Array(total),
    lo: clip[0], hi: clip[1],
  }
  let at = 0
  t.trees.forEach((tr, k) => {
    flat.offsets[k] = at
    for (let n = 0; n < tr.f.length; n++) {
      flat.feature[at + n] = tr.f[n]
      flat.threshold[at + n] = tr.t[n]
      // Child indices are tree-local in the export; make them global once here
      // rather than adding the offset inside the hot loop. -1 stays -1.
      flat.left[at + n] = tr.l[n] < 0 ? -1 : tr.l[n] + at
      flat.right[at + n] = tr.r[n] < 0 ? -1 : tr.r[n] + at
      flat.value[at + n] = tr.v[n]
    }
    at += tr.f.length
  })
  return flat
}

/**
 * Sum of the ensemble at one feature row.
 *
 * `x[feature] <= threshold` goes LEFT, matching sklearn. Getting this comparison
 * backwards, or off by one on the child index, produces predictions that look
 * entirely reasonable and are wrong — which is why `train.py` re-implements this
 * walk in Python and refuses to write a model whose export does not reproduce
 * sklearn's own `predict` to 1e-5, and why a test drives real rows through both.
 */
function predict(m: FlatTarget, x: Float32Array, off: number): number {
  let sum = 0
  for (let k = 0; k < m.offsets.length; k++) {
    let n = m.offsets[k]
    while (m.left[n] !== -1) {
      n = x[off + m.feature[n]] <= m.threshold[n] ? m.left[n] : m.right[n]
    }
    sum += m.value[n]
  }
  return Math.min(m.hi, Math.max(m.lo, m.init + m.lr * sum))
}

export interface LoadedModel {
  raw: RawModel
  cbh: FlatTarget
  cbd: FlatTarget
  cover: FlatTarget
  height: FlatTarget
}

let cached: LoadedModel | null = null

/** Loads and validates `model.json`. Exported so tests can drive it directly. */
export function loadCanopyModel(): LoadedModel {
  if (cached) return cached
  const path = new URL('../canopy/model.json', import.meta.url).pathname
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RawModel
  // The column order the model was trained against must match the code that
  // builds a row now. A feature inserted in the middle would otherwise
  // reinterpret every column silently, and the model would still return
  // plausible numbers.
  const want = FEATURE_NAMES.join(',')
  const got = raw.featureNames.join(',')
  if (want !== got) {
    throw new Error(
      `canopy model feature mismatch — trained on [${got}], code builds [${want}]. Retrain.`
    )
  }
  cached = {
    raw,
    cbh: flatten(raw.targets.cbh, raw.clip.cbh),
    cbd: flatten(raw.targets.cbd, raw.clip.cbd),
    cover: flatten(raw.targets.cover, raw.clip.cover),
    height: flatten(raw.targets.height, raw.clip.height),
  }
  return cached
}

/**
 * All four targets at one feature row.
 *
 * The provider and `canopy/check.ts` both go through this, so the parity check
 * exercises the same code path production does rather than a copy of it.
 */
export function predictCanopy(model: LoadedModel, x: Float32Array, off = 0) {
  const cbh = predict(model.cbh, x, off)
  const cbd = predict(model.cbd, x, off)
  const height = predict(model.height, x, off)
  return {
    cbh,
    cbd,
    height,
    cover: predict(model.cover, x, off),
    /**
     * Canopy load from bulk density times canopy depth: kg/m3 x m = kg/m2.
     * Dimensionally exact rather than a fitted relation, and it keeps load
     * consistent with the CBD the crowning criterion reads — a separately
     * predicted load could contradict its own bulk density.
     */
    load: cbd * Math.max(0, height - cbh),
  }
}

/** Per-class fallback, for cells the model cannot see (cloud, no scene, non-woody). */
function assumedAt(fuelId: number) {
  if (fuelId === Fuel.Timber) return { cbh: 5, cbd: 0.1, cover: 0.7, load: 1.2 }
  if (fuelId === Fuel.Shrub) return { cbh: 1, cbd: 0.05, cover: 0.35, load: 0.3 }
  return { cbh: 0, cbd: 0, cover: 0, load: 0 }
}

export function learnedCanopy(
  cfg: Config,
  deps: { elevation: ElevationProvider; fuel: FuelProvider }
): CanopyProvider {
  return {
    id: 'landfire-gbt-canopy',
    /**
     * A missing model.json, a feature-list mismatch or a dead Sentinel-2 read
     * all land on the per-class assumption, with `degradedFrom` recording that
     * it happened. A hard failure here would take incident creation down over a
     * canopy layer the browser-only path does not even have.
     *
     * Over the LIVE fuel map, not the procedural one. `assumedCanopy` builds its
     * own terrain, which in live mode disagrees with the WorldCover
     * classification the rest of the incident uses, so falling back to it would
     * silently move the canopy onto invented forest.
     */
    fallbacks: [assumedCanopyFrom(deps.fuel)],
    async fetch(q: TerrainQuery) {
      const model = loadCanopyModel()
      const { cols, rows, cellSize, bounds } = q.grid
      const n = cols * rows

      // Resolved here rather than injected through the query, so canopy stays
      // one slot in `Incident.create`'s Promise.all instead of serialising
      // behind elevation and fuel. Both are tile-cached, so the second read is
      // cheap; awaiting them upstream would put a cold COG read on the critical
      // path twice over.
      const [dem, fuel, refl] = await Promise.all([
        deps.elevation.fetch(q),
        deps.fuel.fetch(q),
        fetchReflectance(bounds, cols, rows, Math.max(cfg.fetchTimeoutMs, 30000)).catch(() => null),
      ])

      const d: CanopyGrid = {
        canopyLoad: new Float32Array(n),
        cbh: new Float32Array(n),
        cbd: new Float32Array(n),
        cover: new Float32Array(n),
        assumed: new Uint8Array(n),
      }

      const fuelIds = fuel.data.fuelId
      let predicted = 0
      let woody = 0

      if (refl) {
        const grids: FeatureGrids = {
          blue: refl.bands.blue, green: refl.bands.green, red: refl.bands.red,
          nir: refl.bands.nir, swir16: refl.bands.swir16, swir22: refl.bands.swir22,
          elevation: dem.data.elevation, fuel: fuelIds,
          cols, rows, cellSize, bounds, sceneId: refl.item.id,
        }
        const x = new Float32Array(FEATURE_COUNT)
        for (let i = 0; i < n; i++) {
          if (!isWoody(fuelIds[i])) continue
          woody++
          if (!featuresUsable(grids, i)) continue
          writeFeatureRow(grids, i, x, 0)
          const p = predictCanopy(model, x, 0)
          d.cbh[i] = p.cbh
          d.cbd[i] = p.cbd
          d.cover[i] = p.cover
          d.canopyLoad[i] = p.load
          predicted++
        }
      }

      // Everything the model could not see falls back to the per-class constant,
      // flagged `assumed` so the UI and §4 can tell them apart. A hole in the
      // canopy map would silently disable crown fire there, which is worse than
      // a documented assumption.
      for (let i = 0; i < n; i++) {
        if (d.cover[i] > 0 || !isWoody(fuelIds[i])) continue
        const a = assumedAt(fuelIds[i])
        d.cbh[i] = a.cbh
        d.cbd[i] = a.cbd
        d.cover[i] = a.cover
        d.canopyLoad[i] = a.load
        d.assumed[i] = 1
      }

      const cov = woody > 0 ? (predicted / woody) * 100 : 0
      const m = model.raw.metrics
      return {
        data: d,
        provenance: prov({
          source: `landfire-lf2023-gbt${refl ? `+sentinel2:${refl.item.id}` : ''}`,
          // 'derived', not 'measured': every number here is a prediction, and
          // the cells the model could not see are per-class constants.
          kind: 'derived',
          nativeResolution: 30,
          observedAt: refl?.item.properties?.datetime ?? null,
          coverage: woody > 0 ? predicted / woody : 0,
          note:
          `Gradient-boosted trees trained on ${model.raw.labelSource}; ` +
          `${model.raw.rows} cells, ${model.raw.regions.length} regions, region-blocked CV. ` +
          `Predicted for ${cov.toFixed(0)}% of woody cells` +
          `${refl ? ` from Sentinel-2 ${refl.item.id}` : ' (no scene — all per-class assumptions)'}. ` +
          `Held-out MAE: CBH ${m.cbh.model.mae.toFixed(2)} m (assumption ${m.cbh.assumed.mae.toFixed(2)}), ` +
          `CBD ${m.cbd.model.mae.toFixed(3)} kg/m3 (assumption ${m.cbd.assumed.mae.toFixed(3)} — ` +
          `only 4% better on RMSE, do not read as measurement). ` +
          `Trained ${model.raw.trainedAt}`,
        }),
      }
    },
  }
}