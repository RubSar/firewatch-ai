/**
 * Weather inputs and the fire-danger indices derived from them.
 *
 * MOCK: `mockForecast` stands in for a real hourly feed. In production this is
 * the NWS/NOAA gridpoint forecast (or a RAWS station pull) for the incident
 * centroid — same shape, same units, so only the fetch changes.
 */

export interface Weather {
  /** Dry-bulb air temperature, deg C. */
  temperature: number
  /** Relative humidity, %. */
  humidity: number
  /** Sustained 10 m wind, km/h. */
  windSpeed: number
  /** Direction the wind blows FROM, degrees clockwise from north. */
  windDir: number
  /** 0 = steady, 1 = violently gusty. */
  gustiness: number
  /** Days since the last wetting rain — drives the drought/curing signal. */
  daysSinceRain: number
  /** Current rainfall, mm/h. */
  precipitation: number
}

export interface Params extends Weather {
  /** Ember production multiplier, 0 disables spotting entirely. */
  spotting: number
  /** Suppression effort committed, 0-100 %. */
  suppression: number
  /** Drive weather from the hourly forecast feed instead of the sliders. */
  followForecast: boolean
}

export interface Preset {
  id: string
  name: string
  hint: string
  weather: Weather
}

export const PRESETS: Preset[] = [
  {
    id: 'calm-morning',
    name: 'Calm morning',
    hint: 'Marine layer, damp fuels. Fire only creeps.',
    weather: { temperature: 21, humidity: 52, windSpeed: 9, windDir: 225, gustiness: 0.2, daysSinceRain: 15, precipitation: 0 },
  },
  {
    id: 'red-flag',
    name: 'Critical fire weather',
    hint: 'Hot, dry and breezy. Red-flag thresholds met.',
    weather: { temperature: 33, humidity: 14, windSpeed: 32, windDir: 20, gustiness: 0.5, daysSinceRain: 48, precipitation: 0 },
  },
  {
    id: 'foehn',
    name: 'Foehn windstorm',
    hint: 'Warm dry downslope wind off the range, single-digit humidity. Worst case.',
    weather: { temperature: 31, humidity: 7, windSpeed: 65, windDir: 45, gustiness: 0.8, daysSinceRain: 90, precipitation: 0 },
  },
  {
    id: 'heatwave',
    name: 'Heatwave',
    hint: 'Extreme heat, light wind. Plume-dominated growth.',
    weather: { temperature: 42, humidity: 12, windSpeed: 14, windDir: 340, gustiness: 0.35, daysSinceRain: 70, precipitation: 0 },
  },
  {
    id: 'wet-front',
    name: 'Rain band moving in',
    hint: 'Frontal rain. Watch the fire lie down, then the wind shift.',
    weather: { temperature: 19, humidity: 88, windSpeed: 24, windDir: 190, gustiness: 0.6, daysSinceRain: 0, precipitation: 3.5 },
  },
]

export const getPreset = (id: string) => PRESETS.find((p) => p.id === id) ?? PRESETS[1]

/**
 * Dead fine-fuel moisture content (%). A rough stand-in for the NFDRS 1-hour
 * timelag calculation: humidity drives it, heat and drought dry it out, rain
 * puts it straight back.
 */
export function fuelMoisture(w: Weather): number {
  let fmc = 3 + w.humidity * 0.34 - (w.temperature - 15) * 0.18
  fmc *= 1 - 0.25 * Math.min(1, w.daysSinceRain / 60)
  fmc += w.precipitation * 5
  return Math.min(60, Math.max(1.5, fmc))
}

/** Chandler Burning Index — a standard temperature/humidity fire-danger scale. */
export function chandlerBurningIndex(t: number, rh: number): number {
  const cbi = (((110 - 1.373 * rh) - 0.54 * (10.2 - t)) * (124 * Math.pow(10, -0.0142 * rh))) / 60
  return Math.max(0, cbi)
}

export function dangerRating(cbi: number) {
  if (cbi < 50) return { label: 'Low', color: '#4ade80' }
  if (cbi < 75) return { label: 'Moderate', color: '#facc15' }
  if (cbi < 90) return { label: 'High', color: '#fb923c' }
  if (cbi < 97.5) return { label: 'Very high', color: '#f43f5e' }
  return { label: 'Extreme', color: '#c026d3' }
}

export const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
export const compassLabel = (deg: number) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]

export interface ForecastHour extends Weather {
  /** Hours from ignition. */
  hour: number
  clock: string
}

/**
 * 24 hours of plausible weather with a diurnal cycle, anchored on a preset.
 * Afternoon heat and evening downslope wind are where the bad runs happen.
 */
export function mockForecast(base: Weather, startHour = 13): ForecastHour[] {
  const out: ForecastHour[] = []
  for (let h = 0; h < 24; h++) {
    const clockH = (startHour + h) % 24
    // Peak heat ~16:00, minimum ~05:00.
    const diurnal = Math.cos(((clockH - 16) / 24) * 2 * Math.PI)
    const wobble = Math.sin(h * 0.9) * 0.5 + Math.sin(h * 0.37 + 2.1) * 0.5
    const temperature = base.temperature + diurnal * 7 - 3
    const humidity = Math.min(98, Math.max(4, base.humidity - diurnal * 18 + 10))
    // Downslope/offshore winds strengthen overnight; sea breeze peaks late day.
    const windCycle = base.windSpeed > 40 ? -Math.cos(((clockH - 3) / 24) * 2 * Math.PI) : diurnal
    const windSpeed = Math.max(2, base.windSpeed * (0.72 + 0.4 * windCycle) + wobble * 3)
    out.push({
      hour: h,
      clock: `${String(clockH).padStart(2, '0')}:00`,
      temperature: Math.round(temperature * 10) / 10,
      humidity: Math.round(humidity),
      windSpeed: Math.round(windSpeed * 10) / 10,
      windDir: (base.windDir + Math.sin(h * 0.42) * 22 + 360) % 360,
      gustiness: Math.min(1, base.gustiness * (0.8 + 0.4 * Math.abs(windCycle))),
      daysSinceRain: base.daysSinceRain + h / 24,
      precipitation: base.precipitation > 0 ? Math.max(0, base.precipitation * (1 - h / 10)) : 0,
    })
  }
  return out
}

/** Linear interpolation between forecast hours at an arbitrary sim time. */
export function forecastAt(fc: ForecastHour[], simSeconds: number): Weather {
  const h = simSeconds / 3600
  const i = Math.min(fc.length - 1, Math.floor(h))
  const j = Math.min(fc.length - 1, i + 1)
  const t = h - i
  const lerp = (a: number, b: number) => a + (b - a) * t
  const a = fc[i]
  const b = fc[j]
  // Interpolate direction the short way round the compass.
  let dd = ((b.windDir - a.windDir + 540) % 360) - 180
  return {
    temperature: lerp(a.temperature, b.temperature),
    humidity: lerp(a.humidity, b.humidity),
    windSpeed: lerp(a.windSpeed, b.windSpeed),
    windDir: (a.windDir + dd * t + 360) % 360,
    gustiness: lerp(a.gustiness, b.gustiness),
    daysSinceRain: lerp(a.daysSinceRain, b.daysSinceRain),
    precipitation: lerp(a.precipitation, b.precipitation),
  }
}
