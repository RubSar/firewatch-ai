import { TimeHeap } from './heap.ts'
import { andersonLB } from './shape.ts'
import { FUELS, Fuel, WIND_COEFFICIENTS, type FuelModel } from './fuels.ts'
import type { Terrain } from './terrain.ts'
import type { Params, Weather } from './weather.ts'
import { fuelMoisture } from './weather.ts'
import { makeRng } from './noise.ts'

export const Cell = { Unburned: 0, Burning: 1, Burned: 2 } as const

export const Treatment = { None: 0, Dozer: 1, Retardant: 2 } as const

/** Heat yield of forest fuels, kJ/kg — the constant in Byram's intensity equation. */
const HEAT_YIELD = 18600

export interface Stats {
  burnedCells: number
  activeCells: number
  /** Hectares. */
  area: number
  /** Kilometres of active fire edge. */
  perimeter: number
  /** Fraction of the active edge backed by a barrier or already-burnt ground. */
  containment: number
  /** Peak head-fire rate of spread this step, m/min. */
  maxRos: number
  /** Peak Byram fireline intensity, kW/m. */
  maxIntensity: number
  /** Byram flame length at peak intensity, m. */
  flameLength: number
  /** Developed (WUI) cells burnt. */
  wuiCells: number
  /** Structures destroyed, estimated at STRUCTURES_PER_HA on burnt WUI ground. */
  structuresLost: number
  spotFires: number
  /** Cells that have crowned — the fire left the surface and entered the canopy. */
  crownCells: number
}

/** Assumed dwelling density on developed cells — stated, not measured. */
export const STRUCTURES_PER_HA = 3

/**
 * The canopy, as the kernel needs it.
 *
 * Structural rather than imported from contracts: the sim package stays free
 * of anything above it, which is what lets the identical kernel run in a
 * browser with no server.
 */
export interface CanopyLayer {
  /** Available canopy fuel load, kg/m². */
  load: Float32Array
  /** Canopy base height, m — the gap a surface flame must bridge. */
  cbh: Float32Array
  /** Canopy bulk density, kg/m³ — decides whether crowning can sustain itself. */
  cbd: Float32Array
}

export const Crown = { None: 0, Passive: 1, Active: 2 } as const
export type Crown = (typeof Crown)[keyof typeof Crown]

export interface Sim {
  terrain: Terrain
  state: Uint8Array
  fuelLeft: Float32Array
  /** Byram fireline intensity per burning cell, kW/m. */
  intensity: Float32Array
  /** Sim seconds at which each cell ignited, -1 if never. */
  ignitedAt: Float32Array
  treatment: Uint8Array
  /** Null until attachCanopy; browser-only runs never allocate it. */
  canopy: CanopyLayer | null
  /** Remaining canopy fuel, kg/m². */
  canopyLeft: Float32Array | null
  /** Per cell: Crown.None | Passive | Active. */
  crown: Uint8Array | null
  active: number[]
  /**
   * Minimum travel time to each cell, sim seconds; Infinity = not yet reached.
   * Float32 so that the value pushed onto `front` and the value stored here are
   * bit-identical, which is what makes the stale-entry check work.
   */
  arrival: Float32Array
  /** Dijkstra frontier for the minimum-travel-time propagation. */
  front: TimeHeap
  time: number
  /** Bumped whenever the grid changes outside of a step, so the renderer can
   *  skip repainting a frame in which nothing moved. */
  revision: number
  /** Cells ever ignited. Maintained incrementally; the O(n) scan is not. */
  burnedCells: number
  peakRos: number
  peakIntensity: number
  wuiCells: number
  spotFires: number
  /** Cells that have crowned, passive or active. */
  crownCells: number
  stats: Stats
  history: { t: number; area: number; perimeter: number }[]
  rng: () => number
}

export const EMPTY_STATS: Stats = {
  burnedCells: 0, activeCells: 0, area: 0, perimeter: 0, containment: 0,
  maxRos: 0, maxIntensity: 0, flameLength: 0, wuiCells: 0, structuresLost: 0, spotFires: 0,
  crownCells: 0,
}

/**
 * `seed` exists for tests.
 *
 * The kernel is stochastic but deterministic, which is what makes a run
 * reproducible — and also what makes a single run impossible to tell apart
 * from a systematic bias, since every run returns the identical answer.
 * Averaging over seeds is the only way to ask whether the lattice itself
 * favours a direction: worst-direction deviation measures 23% at one seed,
 * 7.7% at eight and 5.2% at twenty-four. Production leaves it unset.
 */
export function createSim(terrain: Terrain, seed = 0xf13e5): Sim {
  const n = terrain.cols * terrain.rows
  return {
    terrain,
    state: new Uint8Array(n),
    fuelLeft: Float32Array.from({ length: n }, (_, i) => FUELS[terrain.fuel[i]].load),
    intensity: new Float32Array(n),
    ignitedAt: new Float32Array(n).fill(-1),
    treatment: new Uint8Array(n),
    canopy: null,
    canopyLeft: null,
    crown: null,
    active: [],
    arrival: new Float32Array(n).fill(Infinity),
    front: new TimeHeap(),
    time: 0,
    revision: 0,
    burnedCells: 0,
    peakRos: 0,
    peakIntensity: 0,
    wuiCells: 0,
    spotFires: 0,
    crownCells: 0,
    stats: { ...EMPTY_STATS },
    history: [],
    rng: makeRng(seed),
  }
}

/**
 * Moves a running fire onto a sim built over a different terrain of the same
 * size — used when real DEM/fuel arrives a second after the procedural grid and
 * must not wipe what the user lit.
 *
 * Copies every mutable field. Leaving any out is a silent bug: omitting
 * `fuelLeft` makes burnt cells burn again, omitting `intensity` blanks the
 * flame bands until the next step recomputes them.
 */
export function transferSimState(from: Sim, to: Sim): boolean {
  if (from.state.length !== to.state.length) return false
  to.state.set(from.state)
  to.fuelLeft.set(from.fuelLeft)
  to.intensity.set(from.intensity)
  to.ignitedAt.set(from.ignitedAt)
  to.treatment.set(from.treatment)
  to.active = [...from.active]
  to.arrival.set(from.arrival)
  // The frontier is rebuilt from the burning cells on the next step, so it is
  // dropped rather than copied — the rates it was built from belonged to the
  // old terrain anyway.
  to.front.clear()
  to.time = from.time
  to.revision = from.revision + 1
  to.burnedCells = from.burnedCells
  to.peakRos = from.peakRos
  to.peakIntensity = from.peakIntensity
  to.wuiCells = from.wuiCells
  to.spotFires = from.spotFires
  to.history = from.history.map((h) => ({ ...h }))
  recomputeStats(to)
  return true
}

/**
 * Gives a sim a canopy to burn.
 *
 * Separate from `createSim` so the browser-only path, which has no canopy
 * provider, allocates nothing and behaves exactly as it did before crown fire
 * existed. A sim with no canopy attached can only ever burn on the surface.
 */
export function attachCanopy(sim: Sim, canopy: CanopyLayer): boolean {
  const n = sim.state.length
  if (canopy.load.length !== n || canopy.cbh.length !== n || canopy.cbd.length !== n) return false
  sim.canopy = canopy
  sim.canopyLeft = Float32Array.from(canopy.load)
  sim.crown = new Uint8Array(n)
  return true
}

export function ignite(sim: Sim, col: number, row: number, radius = 1): number {
  const { cols, rows, fuel } = sim.terrain
  let lit = 0
  for (let r = row - radius; r <= row + radius; r++) {
    for (let c = col - radius; c <= col + radius; c++) {
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue
      const i = r * cols + c
      if (sim.state[i] !== Cell.Unburned || FUELS[fuel[i]].load <= 0) continue
      sim.state[i] = Cell.Burning
      sim.ignitedAt[i] = sim.time
      sim.arrival[i] = sim.time
      sim.intensity[i] = 1
      sim.active.push(i)
      sim.burnedCells++
      if (fuel[i] === Fuel.Urban) sim.wuiCells++
      lit++
      sim.revision++
    }
  }
  return lit
}

export function paintTreatment(sim: Sim, col: number, row: number, radius: number, kind: number) {
  const { cols, rows } = sim.terrain
  let knocked = false
  for (let r = row - radius; r <= row + radius; r++) {
    for (let c = col - radius; c <= col + radius; c++) {
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue
      if ((c - col) ** 2 + (r - row) ** 2 > radius * radius) continue
      const i = r * cols + c
      sim.treatment[i] = kind
      // Retardant and dozer line both knock down anything already alight.
      if (sim.state[i] === Cell.Burning) {
        sim.state[i] = Cell.Burned
        sim.intensity[i] = 0
        knocked = true
      }
    }
  }
  // Only rescan the active list if this stamp actually put something out.
  if (knocked) sim.active = sim.active.filter((i) => sim.state[i] === Cell.Burning)
  /**
   * Discard queued arrival times, or the line does not work.
   *
   * MTT computes when the fire WILL reach a cell, so the moment a line is drawn
   * the cells behind it already hold arrival times calculated as if it were not
   * there. Without this the fire walks straight through a dozer line drawn in
   * front of it — the one behaviour this product cannot get wrong, and a defect
   * that would only show up by watching the map, never in a stats assertion.
   */
  invalidateFront(sim)
  sim.revision++
}

/**
 * Foliar moisture content, %.
 *
 * A constant because nothing in the model tracks it: live crown foliage dries
 * on a seasonal cycle driven by plant physiology, not by the days-since-rain
 * the surface fuels use. 100% is mid-range for conifer in fire season. It
 * enters Van Wagner's initiation threshold, so it matters — and it is the
 * assumption to replace first if crown behaviour ever needs defending.
 */
const FOLIAR_MOISTURE = 100

/**
 * Critical mass flow rate for sustained crowning, kg·m⁻²·min⁻¹ (Van Wagner).
 * Divided by canopy bulk density it gives the spread rate below which a crown
 * fire cannot feed itself and drops back to torching.
 */
const CRITICAL_MASS_FLOW = 3.0

/**
 * Van Wagner's critical surface intensity for crown combustion, kW/m.
 *
 *   I_0 = [0.010 · CBH · (460 + 25.9·M_f)]^1.5
 *
 * The bracket is the heat needed to ignite crown foliage across the gap: a
 * high canopy base takes more, damp foliage takes more. A 5 m base at 100%
 * foliar moisture gives ~1880 kW/m, which is the right order — a creeping
 * grass fire is tens, a running timber fire tens of thousands.
 */
export function crownInitiationIntensity(cbh: number, foliarMoisture = FOLIAR_MOISTURE): number {
  if (cbh <= 0) return Infinity
  return Math.pow(0.010 * cbh * (460 + 25.9 * foliarMoisture), 1.5)
}

/**
 * Spread rate, m/min, above which crowning sustains itself rather than merely
 * torching. Sparse canopy needs the fire to move faster to keep the crown
 * alight, which is why `cbd` is in the denominator.
 */
export function activeCrownThreshold(cbd: number): number {
  return cbd > 0 ? CRITICAL_MASS_FLOW / cbd : Infinity
}

/*
 * ACTIVE CROWNING IS CURRENTLY UNDER-TRIGGERED, and deliberately so.
 *
 * Van Wagner's `R` is the fire's actual spread rate. The kernel has two
 * candidates and they disagree by the factor this model has not yet fixed:
 *
 *   nominal  (what a cell computes)   1.9 - 6.9 m/min at 40-80 km/h in timber
 *   emergent (what the front does)      9 -  31 m/min, the same run
 *   R_0 for a realistic CBD of 0.2                  15 m/min
 *
 * So feeding nominal means realistic canopy rarely crowns actively, while
 * feeding emergent would fire at plausible winds — by multiplying in a bug's
 * magnitude. The second is worse: it couples a published physics threshold to
 * the size of a defect, and would silently break when the §4 energy kernel
 * removes that defect.
 *
 * Nominal it is. Passive crowning (torching) is unaffected and does most of
 * the visible work anyway through spotting. This resolves itself when emergent
 * and nominal converge — the `todo` in kernel.test.ts is the same defect.
 */

/**
 * WHY THE SPREAD RATE IS NOT CALIBRATED — read before trying.
 *
 * The front advances at ~4.45x the ROS this kernel reports. Three fixes were
 * implemented and measured, and all three were reverted because each traded a
 * uniform error for a worse non-uniform one:
 *
 *   per-link draw (current)          rate 4.45x, spread  18%, isotropy  7.7%
 *   + hazard divided by 4.6          rate 0.68x, spread 300%
 *   receiver-side, combine by MAX    rate 3.01x, spread  25%, isotropy 14.7%
 *   receiver-side, normalised sum    rate 1.70x, spread 216%, isotropy 17.6%
 *
 * The cause is that this lattice sits near a percolation threshold, so
 * slowing links does not slow fuels proportionally — the fast ones scale and
 * the slow ones collapse. And the residual after the double-count is removed
 * is first-passage percolation: arrival times are exponential, so the front
 * travels the luckiest of many paths and outruns the mean by construction.
 * Neither is reachable with a constant.
 *
 * A uniform, characterised 4.45x error is more useful than a non-uniform 1.7x
 * one, because you can reason about the first. The real fix is the
 * deterministic energy accumulator of ARCHITECTURE.md §4, which does not
 * double-count and does not draw. `sim/test/kernel.test.ts` keeps the number
 * visible on every run.
 */

/** How long a cell stays alight, seconds — heavy fuels smoulder far longer. */
const burnDuration = (load: number) => 360 + load * 900

/**
 * Neighbour offsets: [dc, dr, distance multiplier, bearing degrees].
 *
 * Exported because the index into this array is the `d` of
 * `blockFrac[i * 8 + d]`: a barrier provider that rasterises onto a different
 * ordering blocks the wrong edges, and nothing would fail loudly.
 */
/** Midflame wind as a fraction of the 10 m wind the weather feed reports. */
const MIDFLAME_FACTOR = 0.4
/** km/h to ft/min, the units Rothermel's wind coefficients are defined in. */
const KMH_TO_FT_MIN = 54.6807
/**
 * Ceiling on the wind multiplier.
 *
 * Rothermel's phi_w is unbounded in the formula but capped in practice —
 * BehavePlus limits effective wind against reaction intensity, because past
 * some speed the flame is blown off the fuel rather than driven into it.
 *
 * The proper limit is a function of reaction intensity and is the refinement
 * to make here. This flat ceiling is a backstop against a slider producing a
 * meaningless number, and is deliberately set high enough not to bite inside
 * real fire weather: it was 150, which clipped grass at 65 km/h — a strong
 * wind, not an impossible one — and quietly turned a correct formula into a
 * wrong answer. 1000 corresponds to roughly 150 km/h midflame in fine fuel.
 */
const MAX_WIND_FACTOR = 1000

/**
 * Rothermel's wind multiplier for the fuel being entered, `1 + phi_w`.
 *
 * Replaces `exp(0.115·U)`, which was badly too weak: it reached 3.6x at
 * 40 km/h and 8x at 65, where Rothermel reaches 65x and 177x. Under-predicting
 * wind-driven spread is the worst direction to be wrong in — that is the case
 * that kills people — and nothing could see it until `npm run bench` gave the
 * kernel an external reference to disagree with.
 *
 * Wind response belongs to the fuel bed, so the coefficients are per fuel and
 * precomputed in fuels.ts.
 *
 * THIS IS A HEADING-FIRE TERM and the kernel now only ever calls it with
 * `align` = 1. Passing a reduced wind to get a flank rate was the single
 * largest error in the model: it returns the head rate of a CALMER fire, not
 * the flank rate of this one. At 40 km/h the 45-degree direction came out at
 * 0.59 of full phi_w where the ellipse says 0.065, so off-axis spread ran ~9x
 * too fast, every fire came out round (L/B 1.0-1.5 against real perimeters of
 * 2.2-2.6) and inflated, and Dice could not beat an equal-area circle because
 * the model was one. Directional variation now comes from `ellipseShape`.
 *
 * `align` is kept in the signature because the bench and the wind-response test
 * both pass 1 and read it as "the head-fire gain", which is exactly what it is.
 */
export function windMultiplier(fuelId: number, windMs: number, align: number): number {
  const w = WIND_COEFFICIENTS[fuelId]
  if (!w || w.b === 0) return 1
  const alongKmh = windMs * 3.6 * align * MIDFLAME_FACTOR
  if (alongKmh <= 0) return Math.max(0.15, Math.exp(0.115 * windMs * align))
  const phiW = w.c * Math.pow(alongKmh * KMH_TO_FT_MIN, w.b) * w.packing
  return 1 + Math.min(MAX_WIND_FACTOR, phiW)
}

/**
 * Cap on length-to-breadth. Anderson's fit is calibrated to roughly 10 mi/h
 * midflame and grows without bound above it — at 65 km/h it reaches L/B 56,
 * which puts the backing rate at 1/12,500 of the head. Real wind-driven fires
 * sit nearer L/B 2-3 (the five hindcast perimeters measure 1.3-2.6, implying
 * head:back of about 15-25), and FARSITE caps the ratio for the same reason.
 * 8 is above anything observed here and still bounds the extrapolation.
 */
const MAX_LB = 8

/**
 * Eccentricity of the spread ellipse for a given wind, via Anderson (1983).
 *
 * L/B = a/b, and e = sqrt(1 - (b/a)^2), so e = sqrt(1 - 1/(L/B)^2). Calm air
 * gives L/B = 1 exactly, hence e = 0 and a circle — which is why the calm-wind
 * behaviour and its tests are untouched by the elliptical rewrite.
 */
export function ellipseEccentricity(windMs: number): number {
  const lb = Math.min(MAX_LB, andersonLB(windMs * 3.6 * MIDFLAME_FACTOR))
  return Math.sqrt(Math.max(0, 1 - 1 / (lb * lb)))
}

/**
 * Richards (1990) elliptical spread: the fraction of the head-fire rate that
 * applies at angle theta off the wind.
 *
 *   R(theta) = R_head * (1 - e) / (1 - e * cos theta)
 *
 * The ignition point sits at the rear focus, so theta = 0 returns 1 (the head),
 * theta = 180 returns (1-e)/(1+e) (the backing edge) and theta = 90 returns
 * (1-e) (the flank, the semi-latus rectum). Integrating it recovers L/B by
 * construction, which is the property the old cosine-fed phi_w lacked.
 *
 * This is the formulation under FARSITE, FlamMap, Prometheus and Cell2Fire.
 * Takes cos(theta) rather than theta because the caller already has it.
 */
export function ellipseShape(ecc: number, cosTheta: number): number {
  return (1 - ecc) / (1 - ecc * cosTheta)
}

export const NEIGHBOURS: [number, number, number, number][] = [
  [0, -1, 1, 0], [1, -1, Math.SQRT2, 45], [1, 0, 1, 90], [1, 1, Math.SQRT2, 135],
  [0, 1, 1, 180], [-1, 1, Math.SQRT2, 225], [-1, 0, 1, 270], [-1, -1, Math.SQRT2, 315],
]

/** Gust and direction wobble are deterministic functions of sim time. */
export function gustAt(w: Weather, time: number) {
  const osc = 0.55 * Math.sin(time / 131) + 0.3 * Math.sin(time / 47 + 1.7) + 0.15 * Math.sin(time / 17 + 0.4)
  const speed = Math.max(0, w.windSpeed * (1 + 0.55 * w.gustiness * osc))
  const dir = w.windDir + 18 * w.gustiness * Math.sin(time / 89 + 2.3)
  return { speed, dir }
}

export interface StepInput {
  params: Params
  /** Effective weather this step — either the sliders or the forecast feed. */
  weather: Weather
  /** Seconds of simulated time to advance. */
  dt: number
  /**
   * Per-edge barrier obstruction, `blockFrac[i * 8 + d]` for the flux from cell
   * `i` toward `NEIGHBOURS[d]` — roads, streams, anything narrower than a cell
   * (ARCHITECTURE.md §5 handles those as vectors, not as unburnable cells).
   * Omitted means no barriers, which is what the browser-only path passes.
   */
  blockFrac?: Float32Array
  /**
   * Per-cell wind vector in m/s, u eastward and v northward. Omitted means the
   * single vector in `weather`, which is what the browser-only path passes.
   *
   * Wind dominates total error (ARCHITECTURE.md §7), and a 15 km domain spans
   * several cells of any real forecast grid, so one vector for the whole fire
   * is the largest avoidable simplification in the model.
   */
  windField?: { u: Float32Array; v: Float32Array }
  /**
   * Per-cell dead fine fuel moisture, %. Omitted means the scalar derived from
   * `weather`. A field lets aspect and shading matter: a south slope at noon is
   * drier than the gully beside it, and that is where a fire turns.
   */
  moisture?: Float32Array
}

/**
 * Rothermel's moisture damping coefficient, 0 = will not carry.
 *
 *   eta_M = 1 - 2.59 r + 5.11 r^2 - 3.52 r^3,  r = fmc / mx
 *
 * Published, and identical to the term in `rothermel.ts` — so the kernel and its
 * own external reference now agree on this factor by construction rather than by
 * coincidence.
 *
 * It replaces `((mx - fmc) / (mx - 1.5))^1.5`, which was invented. The two agree
 * closely at r ~ 0.4 and diverge by 2x by r ~ 0.65, and the old `mx` values
 * happened to sit the test conditions right in the agreeing region — so
 * correcting `mx` to published Anderson figures made the invented curve visible
 * as a 0.5x disagreement in the calm-wind Rothermel check. Two wrong things
 * cancelling, again, and only the external reference could see it.
 *
 * eta_M is exactly 0 at r = 1, so extinction still falls out of the formula
 * rather than needing its own branch; r is clamped because beyond extinction the
 * polynomial turns back upward.
 *
 * Extracted so the per-cell path can evaluate it against local moisture while
 * the scalar path keeps precomputing it once per fuel per step.
 */
export function moistureDamping(f: FuelModel, fmc: number): number {
  if (f.load <= 0 || f.mx <= 0) return 0
  const r = Math.min(1, fmc / f.mx)
  return Math.max(0, 1 - 2.59 * r + 5.11 * r * r - 3.52 * r * r * r)
}

/**
 * Discards every queued arrival time, so the frontier is rebuilt from the
 * currently burning cells under present conditions.
 *
 * MTT computes when the fire WILL reach a cell, which means an arrival time can
 * be queued long before it comes due. Anything that changes the rate field
 * afterwards — a dozer line, retardant, a wind shift — would otherwise be
 * ignored by arrivals already in the queue, and a control line drawn in front of
 * a fire would not stop it. That is the one behaviour this product cannot get
 * wrong, so it is invalidated explicitly rather than left to decay.
 *
 * Only cells with a queued arrival can be stale, so this walks the heap rather
 * than the grid. Burning cells are not re-pushed: `step` relaxes every active
 * cell each time it runs, which repopulates the frontier for free.
 *
 * Call it after mutating `treatment` or `blockFrac` outside a step.
 */
export function invalidateFront(sim: Sim) {
  const { arrival, front, state } = sim
  for (let k = 0; k < front.size; k++) {
    const j = front.vals[k]
    if (state[j] === Cell.Unburned) arrival[j] = Infinity
  }
  front.clear()
}

export function step(sim: Sim, input: StepInput) {
  const { terrain, state, fuelLeft, intensity, treatment, rng, canopy, canopyLeft, crown } = sim
  const { arrival, front } = sim
  const { cols, rows, cellSize, elevation, fuel } = terrain
  const { weather, params, dt, blockFrac, windField, moisture } = input

  const fmc = fuelMoisture(weather)
  const gust = gustAt(weather, sim.time)
  const windMs = gust.speed / 3.6
  const windToBearing = (gust.dir + 180) % 360
  // Gusting is a time signal, not a place signal, so it rides on top of a
  // spatial field rather than replacing it: scale the local vector by the same
  // factor the scalar gust applies, and carry the same direction wobble.
  const gustScale = weather.windSpeed > 0.1 ? gust.speed / weather.windSpeed : 1
  const gustVeer = gust.dir - weather.windDir
  const tempMult = 1 + 0.018 * (weather.temperature - 20)
  // Crews and aircraft only hold a line while the fire is slow enough to work.
  const suppressionEffort = params.suppression / 100
  const rainQuench = weather.precipitation * 0.0004

  // With one moisture value for the whole grid the damping is a per-fuel
  // constant, so precompute it. A moisture field forces the per-cell path.
  const moistOf = FUELS.map((f) => moistureDamping(f, fmc))
  const dampingAt = (f: FuelModel, cell: number) =>
    moisture ? moistureDamping(f, moisture[cell]) : moistOf[f.id]

  // Head-fire wind gain is per fuel and, without a wind field, per grid. This
  // also removes eight windMultiplier calls per active cell per step.
  const uniformWind = !windField
  const headMultOf = FUELS.map((f) => windMultiplier(f.id, windMs, 1))
  const eccUniform = ellipseEccentricity(windMs)

  const now = sim.time
  const until = now + dt
  // Constant across the grid, and relax() needs it, so it is hoisted.
  const heatMult = Math.max(0.2, tempMult)

  /**
   * THE FRONTIER IS NOT RESEEDED WHEN THE WEATHER MOVES, on purpose.
   *
   * MTT assumes a static rate field, so the textbook answer is to recompute per
   * burn period, and a first version did that on a quantised weather signature.
   * It was badly wrong: reseeding discards queued arrival times, and this model
   * has no notion of partial progress along a link, so a link slower than one
   * step restarts its clock every reseed and NEVER completes. With gusting on,
   * the signature changed almost every step and only links finishing inside a
   * single 10 s step could ever fire. The fire came out 165x too small with
   * nothing flaming — caught by `npm run smoke:api`, not by any unit test.
   *
   * Not reseeding is safe here because the frontier is inherently shallow: relax
   * only ever pushes the eight immediate neighbours of a burning or
   * freshly-settled cell, so pending arrivals are one ring deep. Relaxation
   * lowers a time but never raises it, which means a gust can pull that single
   * ring in early and nothing beyond it. The error is bounded to one cell and
   * self-corrects; the alternative was a fire that could not spread.
   *
   * Treatment changes are different and DO reseed — see `invalidateFront`. There
   * the cost of stale arrivals is a dozer line that does not work, which is worth
   * losing a ring of progress over.
   */

  let lastMaxRos = 0
  let lastWindMs = windMs
  let lastWindToBearing = windToBearing

  /**
   * Relax every outgoing link of cell `i`, given that the fire is there at
   * `base` — the edge-relaxation half of Finney (2002) Minimum Travel Time.
   *
   * Travel time along a link is `distance / R(theta)`, so the arrival time at a
   * neighbour is a real number rather than a multiple of `dt`. That is what
   * replaced `p = 1 - exp(-ROS dt / d)` and a Bernoulli draw, and it fixes two
   * measured defects at once:
   *
   *   - the arrival-draw overshoot. The draw gave each link an independent
   *     chance every step, so the front advanced by first-passage percolation
   *     over many paths rather than at the rate the kernel reported — 4.45x too
   *     fast in calm air.
   *   - the ceiling at `cellSize / dt`. Emergent head rate was about
   *     `p * cellSize / dt`, saturating at 3 m/s on a 30 m grid at DT = 10, so
   *     nominal head rates above ~30 km/h of wind were simply unreachable and
   *     four of five hindcasts under-predicted extent.
   *
   * Also returns the head-fire rate for `i` and leaves the fastest actual edge
   * rate in `lastMaxRos`, because the combustion pass needs both and this is the
   * only place the eight directions are visited.
   */
  const relax = (i: number, base: number): number => {
    const fm = FUELS[fuel[i]]
    lastMaxRos = 0
    let wMs = windMs
    let wBearing = windToBearing
    if (windField) {
      const u = windField.u[i]
      const v = windField.v[i]
      wMs = Math.hypot(u, v) * gustScale
      // atan2(u, v) gives the bearing the wind blows TOWARD, clockwise from
      // north — which is already the convention the spread term wants.
      wBearing = (((Math.atan2(u, v) * 180) / Math.PI) + gustVeer + 360) % 360
    }
    lastWindMs = wMs
    lastWindToBearing = wBearing
    if (dampingAt(fm, i) <= 0) return 0

    const c = i % cols
    const r = (i / cols) | 0
    const ecc = uniformWind ? eccUniform : ellipseEccentricity(wMs)
    let headMax = 0

    for (let d = 0; d < NEIGHBOURS.length; d++) {
      const [dc, dr, distMul, bearing] = NEIGHBOURS[d]
      const nc = c + dc
      const nr = r + dr
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const j = nr * cols + nc
      if (state[j] !== Cell.Unburned) continue
      const nf = FUELS[fuel[j]]
      if (nf.load <= 0) continue
      if (treatment[j] === Treatment.Dozer) continue

      // A barrier narrower than a cell obstructs part of the shared edge, so
      // only the open fraction of the flux crosses it. Never quite 1 in
      // practice — a road stops a creeping flank, not a spotting head fire.
      const block = blockFrac ? blockFrac[i * 8 + d] : 0
      if (block >= 1) continue

      const dist = cellSize * distMul

      // Slope: rate of spread roughly doubles per 10 deg of upslope.
      const slopeDeg = (Math.atan((elevation[j] - elevation[i]) / dist) * 180) / Math.PI
      const slopeMult = Math.min(8, Math.exp(0.0693 * Math.max(-25, Math.min(25, slopeDeg))))

      // Spread is governed by the fuel being entered, damped by its own
      // moisture of extinction — grass carries where damp timber will not.
      const nMoist = dampingAt(nf, j)
      if (nMoist <= 0) continue

      // Head-fire rate for this fuel, on this slope: phi_w at full alignment.
      const headMult = uniformWind ? headMultOf[fuel[j]] : windMultiplier(fuel[j], wMs, 1)
      const headRos = nf.baseRos * nMoist * heatMult * slopeMult * headMult
      if (headRos > headMax) headMax = headRos

      // Richards (1990): the head rate scaled onto the spread ellipse. Slope
      // stays per-direction rather than being folded into a combined
      // wind-slope vector as FARSITE does — a simplification, and the one
      // place this departs from the reference formulation.
      const cosTheta = Math.cos(((bearing - wBearing) * Math.PI) / 180)

      let ros = headRos * ellipseShape(ecc, cosTheta) * (1 - block)
      if (treatment[j] === Treatment.Retardant) ros *= 0.12
      if (ros <= 0) continue
      if (ros > lastMaxRos) lastMaxRos = ros

      const t = base + dist / ros
      if (t < arrival[j]) {
        arrival[j] = t
        // Push what was STORED, not `t`: arrival is Float32 and the heap key is
        // Float64, so pushing `t` would make the stale-entry check on pop never
        // match and every cell would ignite off its first, worst path.
        front.push(arrival[j], j)
      }
    }
    return headMax
  }

  const ignitions: number[] = []
  const stillActive: number[] = []
  let maxRos = 0
  let maxIntensity = 0

  for (let k = 0; k < sim.active.length; k++) {
    const i = sim.active[k]
    const fm = FUELS[fuel[i]]

    // --- fuel consumption ---
    fuelLeft[i] -= (fm.load / burnDuration(fm.load)) * dt
    if (fuelLeft[i] <= 0) {
      state[i] = Cell.Burned
      intensity[i] = 0
      continue
    }

    const c = i % cols
    const r = (i / cols) | 0

    if (dampingAt(fm, i) <= 0) {
      // Too wet to carry — the cell burns out where it stands.
      fuelLeft[i] -= (fm.load / burnDuration(fm.load)) * dt * 2
      intensity[i] = Math.min(intensity[i], 250)
      stillActive.push(i)
      continue
    }

    /**
     * Propagate from this cell, and read back the rates doing so implied.
     *
     * `relax` visits the eight directions once and is the only place they are
     * visited, so the combustion terms below take their rates from it rather
     * than recomputing. `base` is clamped forward to `now`: a cell that has been
     * alight for an hour must give its neighbours an arrival time an hour later,
     * not one measured from when it first lit.
     */
    const cellHeadRos = relax(i, Math.max(arrival[i], now))
    const cellMaxRos = lastMaxRos
    const cellWindMs = lastWindMs
    const cellWindToBearing = lastWindToBearing

    // Byram: I = H * w * ROS.
    let byram = HEAT_YIELD * fm.load * cellHeadRos

    // --- crown fire (Van Wagner) ---
    // A surface fire enters the canopy when it is intense enough to bridge the
    // gap to the crown base, and SUSTAINS there only if it is also moving fast
    // enough to keep the crown alight. Two criteria, not one: the first alone
    // gives torching, which mostly matters because it throws embers.
    let crowning: Crown = Crown.None
    if (canopy && canopyLeft && crown && canopyLeft[i] > 0) {
      const i0 = crownInitiationIntensity(canopy.cbh[i])
      if (byram >= i0) {
        crowning = cellHeadRos * 60 >= activeCrownThreshold(canopy.cbd[i]) ? Crown.Active : Crown.Passive
        if (crown[i] === Crown.None) sim.crownCells++
        if (crowning > crown[i]) crown[i] = crowning

        // Canopy load joins the heat release. Torching consumes a fraction of
        // the crown; an active crown fire takes essentially all of it.
        const share = crowning === Crown.Active ? 1 : 0.3
        byram = HEAT_YIELD * (fm.load + canopyLeft[i] * share) * cellHeadRos

        // Crown fuel is fine and burns out fast — a minute in an active crown
        // run, longer when it is only torching.
        const residence = crowning === Crown.Active ? 60 : 180
        canopyLeft[i] = Math.max(0, canopyLeft[i] - (canopy.load[i] / residence) * dt)
      }
    }

    intensity[i] = byram
    // `peakRos` surfaces as "Head-fire spread", so it reads the head rate.
    if (cellHeadRos > maxRos) maxRos = cellHeadRos
    if (byram > maxIntensity) maxIntensity = byram

    // --- spotting: embers lofted from high-intensity fuel ---
    // Crowning is the main long-range ember source: burning foliage is lofted
    // from the top of the canopy rather than from ground level, so it both
    // starts higher and travels further.
    const spotBoost = crowning === Crown.Active ? 3 : crowning === Crown.Passive ? 2 : 1
    if (params.spotting > 0 && cellWindMs > 3 && byram > 1500) {
      const pSpot = fm.spotting * spotBoost * params.spotting * (cellWindMs / 60) * (dt / 60) * 0.06
      if (rng() < pSpot) {
        const maxCells = (cellWindMs * 90 * (crowning === Crown.Active ? 1.8 : 1)) / cellSize
        const range = 2 + rng() * maxCells
        const jitter = ((rng() - 0.5) * 34 * Math.PI) / 180
        const th = ((cellWindToBearing * Math.PI) / 180) + jitter
        const sc2 = Math.round(c + Math.sin(th) * range)
        const sr2 = Math.round(r - Math.cos(th) * range)
        if (sc2 >= 0 && sr2 >= 0 && sc2 < cols && sr2 < rows) {
          const sj = sr2 * cols + sc2
          if (state[sj] === Cell.Unburned && FUELS[fuel[sj]].load > 0 && treatment[sj] === Treatment.None) {
            ignitions.push(sj)
            sim.spotFires++
          }
        }
      }
    }

    // --- suppression: effective only on a slow-moving edge ---
    if (suppressionEffort > 0) {
      // cellMaxRos, not cellHeadRos: a crew holds the edge in front of them,
      // which on a flank is far slower than the head.
      const holdable = Math.max(0, 1 - cellMaxRos / 0.4)
      const pOut = 1 - Math.exp(-suppressionEffort * holdable * (dt / 1800))
      if (rng() < pOut) {
        state[i] = Cell.Burned
        intensity[i] = 0
        continue
      }
    }

    // --- rain knock-down ---
    if (rainQuench > 0 && rng() < 1 - Math.exp(-rainQuench * dt)) {
      state[i] = Cell.Burned
      intensity[i] = 0
      continue
    }

    stillActive.push(i)
  }

  /**
   * Settle every cell the fire reaches inside this step, earliest first.
   *
   * This is the search half of MTT. A cell popped here immediately relaxes its
   * own links, so a chain of cells can ignite within one step — which is what
   * lifts the old `cellSize / dt` ceiling on head-fire rate. It terminates
   * because each pop marks a cell Burning permanently, so at worst it settles
   * the grid once.
   *
   * `arrival[j] !== t` discards stale heap entries: lazy deletion means a cell
   * with an improved time still has its old, worse entry in the queue, and
   * igniting off that would undo the shortest-path property entirely.
   */
  while (front.peekKey() <= until) {
    const t = front.peekKey()
    const j = front.pop()
    if (j < 0) break
    if (arrival[j] !== t || state[j] !== Cell.Unburned) continue
    state[j] = Cell.Burning
    // The true arrival, not the step boundary — isochrones read this, and
    // quantising it to dt was visible as terracing in the arrival-time bands.
    sim.ignitedAt[j] = t
    intensity[j] = 500
    if (fuel[j] === Fuel.Urban) sim.wuiCells++
    sim.burnedCells++
    stillActive.push(j)
    relax(j, t)
  }

  // Spot fires are still stochastic and still land whole: an ember either
  // starts a fire or it does not, and there is no travel time to accumulate.
  for (const j of ignitions) {
    if (state[j] !== Cell.Unburned) continue
    state[j] = Cell.Burning
    sim.ignitedAt[j] = until
    arrival[j] = until
    intensity[j] = 500
    if (fuel[j] === Fuel.Urban) sim.wuiCells++
    sim.burnedCells++
    stillActive.push(j)
  }

  sim.active = stillActive
  sim.time += dt

  sim.peakRos = maxRos
  sim.peakIntensity = maxIntensity
}

/**
 * Perimeter/containment need a full-grid pass, so this is called once per
 * rendered frame rather than once per simulation step.
 *
 * `structures` is a per-cell count of real buildings when a provider supplied
 * one. Without it the loss figure stays the `STRUCTURES_PER_HA` estimate over
 * burnt developed land, which is what the browser-only path uses.
 */
export function recomputeStats(sim: Sim, structures?: Float32Array) {
  const { cols, rows, cellSize, fuel } = sim.terrain
  const { state, treatment } = sim
  const cellArea = cellSize * cellSize

  // Fire perimeter: the 4-connected outline of everything already burnt or
  // burning. An edge counts as held once no active flame touches it or a
  // barrier (line, retardant, water) sits on the far side.
  let edge = 0
  let held = 0
  let structuresLost = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (state[i] === Cell.Unburned) continue
      if (structures) structuresLost += structures[i]
      for (let d = 0; d < 4; d++) {
        const nc = c + ORTHO[d][0]
        const nr = r + ORTHO[d][1]
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
        const j = nr * cols + nc
        if (state[j] !== Cell.Unburned) continue
        edge++
        if (state[i] === Cell.Burned || treatment[j] !== Treatment.None || FUELS[fuel[j]].load <= 0) held++
      }
    }
  }

  const burned = sim.burnedCells
  sim.stats = {
    burnedCells: burned,
    activeCells: sim.active.length,
    area: (burned * cellArea) / 10000,
    perimeter: (edge * cellSize) / 1000,
    containment: edge > 0 ? held / edge : burned > 0 ? 1 : 0,
    maxRos: sim.peakRos * 60,
    maxIntensity: sim.peakIntensity,
    flameLength: sim.peakIntensity > 0 ? 0.0775 * Math.pow(sim.peakIntensity, 0.46) : 0,
    wuiCells: sim.wuiCells,
    structuresLost: structures
      ? Math.round(structuresLost)
      : Math.round(((sim.wuiCells * cellArea) / 10000) * STRUCTURES_PER_HA),
    spotFires: sim.spotFires,
    crownCells: sim.crownCells,
  }

  const last = sim.history[sim.history.length - 1]
  if (!last || sim.time - last.t >= 300) {
    sim.history.push({ t: sim.time, area: sim.stats.area, perimeter: sim.stats.perimeter })
    if (sim.history.length > 600) sim.history.shift()
  }
}

const ORTHO: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]]
