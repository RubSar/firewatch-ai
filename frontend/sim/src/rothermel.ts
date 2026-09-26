/**
 * Rothermel's 1972 surface fire spread model — an INDEPENDENT reference.
 *
 * ARCHITECTURE.md's Verification section asks that emergent spread "matches an
 * externally specified target ROS". It had none: the only target available was
 * the kernel's own `baseRos × multipliers`, so the check was circular — a
 * model compared against its own opinion.
 *
 * This is that external target. Cell2Fire and ELMFIRE were the intended
 * references, and neither is buildable here (no cmake, Boost, Eigen or
 * gfortran), but what they would have supplied for surface spread is
 * Rothermel: it is the model underneath BehavePlus, FARSITE, FlamMap and
 * ELMFIRE, and its constants are published rather than fitted here.
 *
 * Crucially it shares no structure with the kernel. Rothermel derives spread
 * from a heat balance — reaction intensity, propagating flux ratio, and the
 * heat sink needed to bring fuel to ignition — where the kernel multiplies a
 * tabulated base rate by empirical factors. Agreement between them means
 * something; agreement with `nominalRos` would not.
 *
 * Imperial internally, because that is the form the constants are published
 * in and converting the constants rather than the inputs is how sign and
 * exponent errors get introduced. Inputs and outputs are SI.
 */

/** Oven-dry particle density, lb/ft³. */
const PARTICLE_DENSITY = 32
/** Total mineral content, fraction. */
const MINERAL_TOTAL = 0.0555
/** Effective (silica-free) mineral content, fraction. */
const MINERAL_EFFECTIVE = 0.010
/** Low heat content of forest fuels, Btu/lb. */
const HEAT_CONTENT = 8000

const KG_M2_TO_LB_FT2 = 0.204816
const M_TO_FT = 3.28084
const FT_MIN_TO_M_MIN = 0.3048
/** km/h to ft/min. */
const KMH_TO_FT_MIN = 54.6807

export interface RothermelFuel {
  /** Oven-dry fuel load, kg/m². */
  load: number
  /** Fuel bed depth, m. */
  depth: number
  /** Surface-area-to-volume ratio, ft²/ft³. */
  sav: number
  /** Moisture of extinction, fraction (0.12 = 12%). */
  moistureOfExtinction: number
}

export interface RothermelInput {
  fuel: RothermelFuel
  /** Dead fuel moisture, fraction. */
  moisture: number
  /** Midflame wind speed, km/h. */
  windKmh: number
  /** Slope, as a rise/run tangent. */
  slopeTan: number
}

export interface RothermelResult {
  /** Rate of spread, m/min. */
  rosMMin: number
  /** Reaction intensity, Btu/ft²/min. */
  reactionIntensity: number
  /** Wind multiplier, dimensionless. */
  windFactor: number
  /** Slope multiplier, dimensionless. */
  slopeFactor: number
  /** True when moisture is at or past extinction and nothing spreads. */
  extinguished: boolean
}

/**
 * Surface rate of spread.
 *
 * `R = I_R · ξ · (1 + φ_w + φ_s) / (ρ_b · ε · Q_ig)` — reaction intensity
 * times the fraction of it that propagates, over the heat needed to bring the
 * fuel ahead to ignition.
 */
export function rothermelSpread(input: RothermelInput): RothermelResult {
  const { fuel, moisture, windKmh, slopeTan } = input
  const sigma = fuel.sav
  const w0 = fuel.load * KG_M2_TO_LB_FT2
  const delta = fuel.depth * M_TO_FT

  if (w0 <= 0 || delta <= 0 || sigma <= 0) {
    return { rosMMin: 0, reactionIntensity: 0, windFactor: 0, slopeFactor: 0, extinguished: true }
  }

  const rhoB = w0 / delta
  const beta = rhoB / PARTICLE_DENSITY
  const betaOpt = 3.348 * Math.pow(sigma, -0.8189)
  const ratio = beta / betaOpt

  // Reaction intensity: how much heat the fuel bed releases per unit area.
  const A = 133 * Math.pow(sigma, -0.7913)
  const gammaMax = Math.pow(sigma, 1.5) / (495 + 0.0594 * Math.pow(sigma, 1.5))
  const gamma = gammaMax * Math.pow(ratio, A) * Math.exp(A * (1 - ratio))

  const rm = Math.min(moisture / fuel.moistureOfExtinction, 1)
  const etaM = Math.max(0, 1 - 2.59 * rm + 5.11 * rm * rm - 3.52 * rm * rm * rm)
  const etaS = Math.min(1, 0.174 * Math.pow(MINERAL_EFFECTIVE, -0.19))
  const wn = w0 / (1 + MINERAL_TOTAL)
  const reactionIntensity = gamma * wn * HEAT_CONTENT * etaM * etaS

  // Fraction of that heat which actually drives the fire forward.
  const xi =
    Math.exp((0.792 + 0.681 * Math.sqrt(sigma)) * (beta + 0.1)) / (192 + 0.2595 * sigma)

  // Wind and slope, as multipliers on the propagating flux.
  const C = 7.47 * Math.exp(-0.133 * Math.pow(sigma, 0.55))
  const B = 0.02526 * Math.pow(sigma, 0.54)
  const E = 0.715 * Math.exp(-3.59e-4 * sigma)
  const windFtMin = Math.max(0, windKmh) * KMH_TO_FT_MIN
  const windFactor = windFtMin > 0 ? C * Math.pow(windFtMin, B) * Math.pow(ratio, -E) : 0
  const slopeFactor = 5.275 * Math.pow(beta, -0.3) * slopeTan * slopeTan

  // Heat sink: only the fine surface fraction is heated to ignition, which is
  // what the effective heating number accounts for.
  const epsilon = Math.exp(-138 / sigma)
  const qIg = 250 + 1116 * moisture
  const sink = rhoB * epsilon * qIg

  const extinguished = moisture >= fuel.moistureOfExtinction || sink <= 0
  const rosFtMin = extinguished ? 0 : (reactionIntensity * xi * (1 + windFactor + slopeFactor)) / sink

  return {
    rosMMin: rosFtMin * FT_MIN_TO_M_MIN,
    reactionIntensity,
    windFactor,
    slopeFactor,
    extinguished,
  }
}

/**
 * SINGLE FUEL PARTICLE ONLY — the limitation that decides what this can check.
 *
 * Rothermel's full model weights load and SAV across size classes (1-h, 10-h,
 * 100-h, live) before entering the heat balance. This implementation treats
 * the bed as one particle, which is exact for a fuel model that is essentially
 * all fine dead fuel and wrong for one that is not. Measured against published
 * BehavePlus output at 8% moisture and 8 km/h midflame:
 *
 *   FM1  short grass, ~all 1-h     26.97 vs 26.0 m/min    4% — valid
 *   FM2  timber grass + understorey 23.12 vs 12.0         multi-class, invalid
 *   FM8  closed timber litter        1.99 vs  0.5         multi-class, invalid
 *   FM10 timber + understorey       13.15 vs  2.4         multi-class, invalid
 *
 * That is not a transcription error — FM1 validating to 4% is what rules that
 * out. It is the missing size-class aggregation, and it matters here only
 * because this kernel's own FUELS are also single-load, single-SAV models. So
 * the comparison is like for like, and the reference is sound for exactly the
 * fuels it is being used on. Adding multi-class support is the prerequisite
 * for ever comparing against a real Anderson or Scott & Burgan model.
 */
export const ANDERSON_FUELS: Record<string, RothermelFuel> = {
  /** Short grass — nearly all 1-h fine fuel, so the single-particle form holds. */
  fm1: { load: 0.166, depth: 0.305, sav: 3500, moistureOfExtinction: 0.12 },
  /** Multi-class. Present for the validation table above, NOT a usable reference. */
  fm2: { load: 0.897, depth: 0.305, sav: 3000, moistureOfExtinction: 0.15 },
  fm8: { load: 1.121, depth: 0.061, sav: 2000, moistureOfExtinction: 0.30 },
  fm10: { load: 2.694, depth: 0.305, sav: 2000, moistureOfExtinction: 0.25 },
}

/**
 * Midflame wind as a fraction of the 10 m wind the weather feed reports.
 *
 * Rothermel's wind term wants the wind at flame height, not at a met station's
 * 10 m. 0.4 is the conventional adjustment for unsheltered surface fuels;
 * under closed canopy it is nearer 0.1-0.2. Comparing a 10 m wind directly
 * against Rothermel would overstate its spread by roughly a factor of two, so
 * this factor is doing real work rather than tidying units.
 */
export const MIDFLAME_WIND_FACTOR = 0.4
