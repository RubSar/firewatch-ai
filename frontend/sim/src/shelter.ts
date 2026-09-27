/**
 * Canopy sheltering of dead fine fuel moisture.
 *
 * WHY THIS EXISTS. The hindcast's shape-through-time trace showed the model
 * getting a fire's shape, bearing and area roughly right for its first hours and
 * then destroying all three by never stopping: Anderson Bridge reaches L/B 3.69
 * on bearing 141 deg at hour 10 against a real perimeter of 2.17 on 140 deg, and
 * by hour 191 it has filled its fuel-connected region at L/B 1.00. A fire that
 * never pauses has no shape.
 *
 * Moisture of extinction is the only mechanism besides rain that halts spread,
 * and it was unreachable. Simard's equilibrium moisture saturates near 27% at
 * 100% relative humidity, and on Anderson Bridge the 2 m archive series never
 * drove it above 21.9% — so timber at any published moisture of extinction (FM10
 * is 25%, FM8 is 30%) carried all 191 hours.
 *
 * THE MISSING PHYSICS. Fuel under a canopy is not in equilibrium with air
 * measured at 2 m in the open. It is cooler and sits in more humid air, most
 * strongly at night, so it is damper than open-air EMC implies. Rothermel (1983,
 * "How to Predict the Spread and Intensity of Forest and Range Fires") handles
 * this with dead fuel moisture corrections keyed on shading — roughly +3 to +5
 * percentage points for fuels under 50% or more canopy, largest at night.
 *
 * HOW MUCH OF THIS IS ASSUMED. The mechanism and the size of the effect are
 * published; `SHELTER_RH_GAIN` expressing it as a humidity offset proportional to
 * canopy cover is a simplification, and a continuous ramp in cover rather than
 * Rothermel's shaded/exposed step is a choice. 12 points of relative humidity at
 * full cover lands the EMC correction at +4 to +5 points, inside the published
 * range. It is not a fitted constant — nothing here was tuned against a Dice
 * score — but it is the assumption to attack first if crown-fire behaviour ever
 * needs defending.
 */

/**
 * Relative humidity added at full canopy cover, percentage points.
 *
 * Deliberately expressed on humidity rather than on moisture directly, so the
 * correction passes through Simard's nonlinearity: the same offset matters more
 * on a humid night than a dry afternoon, which is the behaviour the published
 * tables show.
 */
export const SHELTER_RH_GAIN = 12

/** Open-air relative humidity adjusted for the canopy above a cell, %. */
export function shelteredHumidity(rh: number, canopyCover: number): number {
  const cover = Math.min(1, Math.max(0, canopyCover))
  return Math.min(100, rh + SHELTER_RH_GAIN * cover)
}

/**
 * Blends an open-air and a fully-sheltered moisture value by canopy cover.
 *
 * Both series are integrated separately through the one-hour timelag and then
 * mixed here, rather than running the integrator per cell. Exact at cover 0 and
 * cover 1, monotone between, and it turns 160,000 integrations per hour into two
 * plus a lerp.
 */
export function blendByCover(openFmc: number, shelteredFmc: number, canopyCover: number): number {
  const cover = Math.min(1, Math.max(0, canopyCover))
  return openFmc + (shelteredFmc - openFmc) * cover
}
