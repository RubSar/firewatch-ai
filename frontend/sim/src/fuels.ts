/**
 * Simplified surface fuel models, loosely after Anderson's 13 (NFFL) set.
 *
 * MOCK: in production these come from a LANDFIRE FBFM40 raster clipped to the
 * area of interest. Every cell carries only a fuel-model id, so swapping the
 * procedural generator for a real raster read is a drop-in change.
 */
export const Fuel = {
  Water: 0,
  Barren: 1,
  Grass: 2,
  Shrub: 3,
  Timber: 4,
  Agriculture: 5,
  Urban: 6,
} as const
export type Fuel = (typeof Fuel)[keyof typeof Fuel]

export interface FuelModel {
  id: Fuel
  name: string
  /** No-wind, no-slope rate of spread on flat ground at low moisture (m/s). */
  baseRos: number
  /** Available fuel load (kg/m^2) — drives burn duration and fireline intensity. */
  load: number
  /**
   * 1-h (fine) fraction of the load, kg/m^2. This — not the whole bed — is the
   * heat sink in Rothermel's preignition term, which is why timber at 5.5 kg/m^2
   * total still ignites: only ~0.9 of that is fine enough to carry the front.
   * See ARCHITECTURE.md §4, "Ignition threshold".
   */
  fineLoad: number
  /** Fuel bed bulk density, kg/m^3. */
  bulkDensity: number
  /** Fuel bed depth, m. */
  depth: number
  /** Characteristic surface-area-to-volume ratio, ft^2/ft^3 — drives eps = exp(-138/sav). */
  sav: number
  /**
   * Moisture of extinction (% dead fuel moisture): above this it will not carry.
   *
   * PUBLISHED Anderson (1982) values, unlike `depth`, `sav` and `bulkDensity` on
   * this table, which are still invented. Moisture of extinction is a single
   * property per fuel model rather than a size-class aggregate, so it can be
   * taken from the literature without multi-size-class Rothermel first — which is
   * why it is the one column here that is real.
   *
   * It was invented too, and too high: grass 20, shrub 26, timber 30,
   * agriculture 32. Simard's equilibrium moisture saturates near 27% at 100% RH,
   * so timber's 30 made extinction UNREACHABLE by humidity and timber carried
   * 191 of 191 replay hours on Anderson Bridge. A fuel that never stops produces
   * a fire that fills its fuel-connected region, and such a fire has no shape:
   * measured L/B decayed from 3.69 at hour 10 to 1.00 at hour 191 against a real
   * perimeter of 2.17.
   */
  mx: number
  /** Relative ember production, drives long-range spotting. */
  spotting: number
  color: [number, number, number]
}

/** Indexed by Fuel id. */
/**
 * Moisture of extinction, mapped to the closest Anderson (1982) fuel model:
 *
 *   Grass / annual      -> FM1  short grass                     12%
 *   Chaparral / shrub   -> FM4  chaparral                       20%
 *   Timber / conifer    -> FM10 timber litter + understorey      25%
 *   Agriculture         -> FM1-like cured herbaceous            12%
 *   Urban / WUI         -> no Anderson analogue; 22% is assumed
 *
 * FM10 rather than FM8 for timber. FM8 is closed timber litter with no
 * understorey and its 30% is genuinely published — but it is also the one
 * Anderson model whose extinction humidity cannot be reached from open-air EMC,
 * and a WorldCover "tree cover" pixel is far more often timber WITH understorey.
 * Picking FM8 for a generic tree class was what made timber unstoppable.
 */
export const FUELS: FuelModel[] = [
  { id: Fuel.Water, name: 'Water', baseRos: 0, load: 0, fineLoad: 0, bulkDensity: 0, depth: 0, sav: 0, mx: 0, spotting: 0, color: [44, 84, 122] },
  { id: Fuel.Barren, name: 'Rock / barren', baseRos: 0, load: 0, fineLoad: 0, bulkDensity: 0, depth: 0, sav: 0, mx: 0, spotting: 0, color: [150, 142, 130] },
  { id: Fuel.Grass, name: 'Grass / annual', baseRos: 0.062, load: 0.8, fineLoad: 0.8, bulkDensity: 2.67, depth: 0.3, sav: 3500, mx: 12, spotting: 0.2, color: [188, 166, 98] },
  { id: Fuel.Shrub, name: 'Chaparral / shrub', baseRos: 0.034, load: 3.2, fineLoad: 1.2, bulkDensity: 2.46, depth: 1.3, sav: 1500, mx: 20, spotting: 0.8, color: [112, 128, 76] },
  { id: Fuel.Timber, name: 'Timber / conifer', baseRos: 0.013, load: 5.5, fineLoad: 0.9, bulkDensity: 8.46, depth: 0.65, sav: 1700, mx: 25, spotting: 1.0, color: [58, 88, 62] },
  { id: Fuel.Agriculture, name: 'Agriculture', baseRos: 0.021, load: 1.1, fineLoad: 1.0, bulkDensity: 3.14, depth: 0.35, sav: 2000, mx: 12, spotting: 0.1, color: [158, 178, 104] },
  { id: Fuel.Urban, name: 'Urban / WUI', baseRos: 0.007, load: 2.4, fineLoad: 0.6, bulkDensity: 4.0, depth: 0.6, sav: 1200, mx: 22, spotting: 0.5, color: [141, 138, 145] },
]

export const isBurnable = (f: number) => FUELS[f].load > 0

/**
 * Rothermel's wind coefficients, precomputed per fuel.
 *
 * The wind response is a property of the fuel bed — a sparse, fine bed is far
 * more wind-sensitive than a compact one — so C, B and E depend on the
 * surface-area-to-volume ratio and the packing ratio, not on the weather.
 * They never change, so they are computed once here rather than per cell per
 * step.
 */
export interface WindCoefficients {
  c: number
  b: number
  /** Already raised to the power and inverted: (beta/betaOpt)^-E. */
  packing: number
}

/** Oven-dry particle density, lb/ft³ — Rothermel's constant. */
const PARTICLE_DENSITY_LB_FT3 = 32
const KG_M2_TO_LB_FT2 = 0.204816
const M_TO_FT = 3.28084

export const WIND_COEFFICIENTS: WindCoefficients[] = FUELS.map((f) => {
  if (f.load <= 0 || f.depth <= 0 || f.sav <= 0) return { c: 0, b: 0, packing: 0 }
  const rhoB = (f.load * KG_M2_TO_LB_FT2) / (f.depth * M_TO_FT)
  const beta = rhoB / PARTICLE_DENSITY_LB_FT3
  const betaOpt = 3.348 * Math.pow(f.sav, -0.8189)
  return {
    c: 7.47 * Math.exp(-0.133 * Math.pow(f.sav, 0.55)),
    b: 0.02526 * Math.pow(f.sav, 0.54),
    packing: Math.pow(beta / betaOpt, -0.715 * Math.exp(-3.59e-4 * f.sav)),
  }
})

/**
 * How long a cell actually carries flame, seconds — a small fraction of its
 * total burnout time. Heavier fuels flame for longer.
 *
 * Lives here rather than in the renderer because the server needs the same
 * window to decide which cells' intensity is worth sending: it is the only
 * place the flame bands read intensity, so it is the only place worth the bytes.
 */
export const flamingTime = (fuel: number) => 60 + FUELS[fuel].load * 60

export const FUEL_LEGEND: Fuel[] = [Fuel.Grass, Fuel.Shrub, Fuel.Timber, Fuel.Agriculture, Fuel.Urban, Fuel.Water]
