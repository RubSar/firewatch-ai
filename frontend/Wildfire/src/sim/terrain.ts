import { Fuel } from './fuels.ts'
import { fbm, ridged, makeRng } from './noise.ts'

export interface Bounds {
  north: number
  south: number
  east: number
  west: number
}

export interface Scenario {
  id: string
  name: string
  region: string
  blurb: string
  bounds: Bounds
  seed: number
  /** Peak ridge elevation in metres. */
  maxElev: number
  /** 0 = rolling hills, 1 = sharp ridge-and-canyon country. */
  ruggedness: number
  /** Ocean along the southern edge. */
  coast: boolean
  /** Relative share of developed land in the lowlands. */
  urban: number
  /** Shifts the whole vegetation mix toward heavier, woodier fuels. */
  woodiness: number
  /** Default weather preset id applied when the scenario loads. */
  preset: string
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'khosrov',
    name: 'Khosrov Forest Reserve',
    region: 'Ararat, Armenia',
    blurb:
      'Juniper woodland and dry steppe cut by the Azat and Khosrov gorges. Burned badly in August 2017.',
    bounds: { north: 40.04, south: 39.925, east: 45.04, west: 44.86 },
    seed: 40449,
    maxElev: 2300,
    ruggedness: 0.78,
    coast: false,
    urban: 0.12,
    woodiness: 0.02,
    preset: 'red-flag',
  },
  {
    id: 'dilijan',
    name: 'Dilijan National Park',
    region: 'Tavush, Armenia',
    blurb:
      'Dense beech and oak forest on steep northern slopes — the heaviest fuel loads in the country.',
    bounds: { north: 40.8, south: 40.685, east: 44.96, west: 44.78 },
    seed: 40744,
    maxElev: 2300,
    ruggedness: 0.62,
    coast: false,
    urban: 0.2,
    woodiness: 0.34,
    preset: 'heatwave',
  },
  {
    id: 'kapan',
    name: 'Kapan & Shikahogh',
    region: 'Syunik, Armenia',
    blurb:
      'Deep forested valleys in the far south, with the mining town of Kapan sitting right in the gorge.',
    bounds: { north: 39.26, south: 39.145, east: 46.5, west: 46.32 },
    seed: 39246,
    maxElev: 2600,
    ruggedness: 0.82,
    coast: false,
    urban: 0.28,
    woodiness: 0.28,
    preset: 'heatwave',
  },
]

export interface Terrain {
  cols: number
  rows: number
  /** Metres per cell (cells are near-square on the ground). */
  cellSize: number
  bounds: Bounds
  elevation: Float32Array
  fuel: Uint8Array
  /** Precomputed hillshade 0..1, used for the synthetic basemap. */
  shade: Float32Array
  maxElev: number
  minElev: number
  /** Where elevation and fuel came from. */
  source: 'synthetic' | 'live'
}

/** Grid width in cells. ~38 m cells across a typical 15 km scenario. */
const TARGET_COLS = 400
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function metresPerDegree(lat: number) {
  return { x: 111320 * Math.cos((lat * Math.PI) / 180), y: 110540 }
}

export function buildTerrain(sc: Scenario): Terrain {
  const { bounds } = sc
  const midLat = (bounds.north + bounds.south) / 2
  const mpd = metresPerDegree(midLat)
  const widthM = (bounds.east - bounds.west) * mpd.x
  const heightM = (bounds.north - bounds.south) * mpd.y

  const cols = TARGET_COLS
  const cellSize = widthM / cols
  const rows = Math.round(heightM / cellSize)

  const elevation = new Float32Array(cols * rows)
  const fuel = new Uint8Array(cols * rows)
  const shade = new Float32Array(cols * rows)
  const rng = makeRng(sc.seed ^ 0x5f3a)

  // --- elevation field -------------------------------------------------
  // Domain-warped ridged noise: the warp bends ridgelines so drainages branch
  // the way real watersheds do instead of looking like radio static.
  const freq = 7.0 / cols
  let minElev = Infinity
  let maxElev = -Infinity

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * freq
      const y = r * freq
      const wx = fbm(x * 0.45, y * 0.45, sc.seed + 21, 3) * 2 - 1
      const wy = fbm(x * 0.45 + 9.3, y * 0.45 - 4.1, sc.seed + 22, 3) * 2 - 1
      const px = x + 0.9 * wx
      const py = y + 0.9 * wy

      const ridge = ridged(px, py, sc.seed, 7)
      const soft = fbm(px * 0.6, py * 0.6, sc.seed + 4001, 5)
      let h = sc.ruggedness * ridge + (1 - sc.ruggedness) * soft
      h = Math.pow(h, 1.25)

      // Regional tilt: high ground inland, low ground toward the coast/valley.
      const tilt = sc.coast ? 1 - r / rows : 0.4 + 0.6 * (1 - r / rows)
      h *= 0.25 + 1.0 * tilt

      let e = h * sc.maxElev

      if (sc.coast) {
        const shoreRow = rows * (0.86 + 0.05 * (fbm(c * 0.025, 99, sc.seed + 313) * 2 - 1))
        e *= smoothstep(shoreRow + 2, shoreRow - 18, r)
        if (r > shoreRow) e = -5 - (r - shoreRow) * 0.8
      }

      elevation[r * cols + c] = e
      if (e < minElev) minElev = e
      if (e > maxElev) maxElev = e
    }
  }

  computeShade(elevation, shade, cols, rows, cellSize)

  // --- fuel classification ---------------------------------------------
  // Vegetation follows topography: cool, wet north-facing slopes and high
  // ground carry timber; hot south aspects and low ground carry grass/brush.
  const base = Math.max(0, minElev)
  const span = Math.max(1, maxElev - base)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const e = elevation[i]
      if (e <= 0) {
        fuel[i] = Fuel.Water
        continue
      }
      const en = (e - base) / span
      const dzdx = (sampleElev(elevation, cols, rows, c + 1, r) - sampleElev(elevation, cols, rows, c - 1, r)) / (2 * cellSize)
      const dzdy = (sampleElev(elevation, cols, rows, c, r + 1) - sampleElev(elevation, cols, rows, c, r - 1)) / (2 * cellSize)
      const grad = Math.hypot(dzdx, dzdy)
      const slope = Math.atan(grad)
      // +1 = faces due south (hot, dry), -1 = faces due north (cool, shaded).
      const southness = grad > 1e-4 ? -dzdy / grad : 0

      const patch = fbm(c * 0.09, r * 0.09, sc.seed + 777, 4) - 0.5
      // Higher = cooler and wetter = heavier, woodier fuel.
      const wetness = 0.12 + en * 0.8 - 0.22 * southness + 0.45 * patch + sc.woodiness

      let f: number
      const built =
        fbm(c * 0.06, r * 0.06, sc.seed + 1301, 3) * 0.75 + (1 - Math.min(1, slope / 0.22)) * 0.45
      if (en < 0.45 && built > 1.02 - sc.urban * 0.5) f = Fuel.Urban
      else if (en < 0.18 && slope < 0.12 && patch > 0.02) f = Fuel.Agriculture
      else if (wetness > 0.68) f = Fuel.Timber
      else if (wetness > 0.3) f = Fuel.Shrub
      else f = Fuel.Grass

      if (slope > 0.66 && patch < -0.12) f = Fuel.Barren
      if (rng() < 0.01 && f !== Fuel.Urban) f = Fuel.Grass
      fuel[i] = f
    }
  }

  // Inland scenarios get a reservoir in the lowest basin.
  if (!sc.coast) carveLake(elevation, fuel, cols, rows, sc.seed)

  return { cols, rows, cellSize, bounds, elevation, fuel, shade, maxElev, minElev, source: 'synthetic' }
}

/**
 * Standard hillshade, sun from the north-west at 45 deg with a little vertical
 * exaggeration. Used for both the procedural and the real DEM.
 */
export function computeShade(
  elevation: Float32Array, shade: Float32Array, cols: number, rows: number, cellSize: number
) {
  const az = (315 * Math.PI) / 180
  const alt = (45 * Math.PI) / 180
  const zf = 1.6
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const dzdx = (zf * (sampleElev(elevation, cols, rows, c + 1, r) - sampleElev(elevation, cols, rows, c - 1, r))) / (2 * cellSize)
      const dzdy = (zf * (sampleElev(elevation, cols, rows, c, r + 1) - sampleElev(elevation, cols, rows, c, r - 1))) / (2 * cellSize)
      const slope = Math.atan(Math.hypot(dzdx, dzdy))
      const aspect = Math.atan2(dzdy, -dzdx)
      const s = Math.cos(slope) * Math.sin(alt) + Math.sin(slope) * Math.cos(alt) * Math.cos(az - aspect)
      shade[i] = Math.min(1, Math.max(0, s))
    }
  }
}

function sampleElev(e: Float32Array, cols: number, rows: number, c: number, r: number) {
  const cc = Math.min(cols - 1, Math.max(0, c))
  const rr = Math.min(rows - 1, Math.max(0, r))
  return e[rr * cols + cc]
}

/** Slope magnitude in radians at a cell. */
export function localSlope(e: Float32Array, cols: number, rows: number, c: number, r: number, cellSize: number) {
  const dzdx = (sampleElev(e, cols, rows, c + 1, r) - sampleElev(e, cols, rows, c - 1, r)) / (2 * cellSize)
  const dzdy = (sampleElev(e, cols, rows, c, r + 1) - sampleElev(e, cols, rows, c, r - 1)) / (2 * cellSize)
  return Math.atan(Math.hypot(dzdx, dzdy))
}

function carveLake(elev: Float32Array, fuel: Uint8Array, cols: number, rows: number, seed: number) {
  // Flood the lowest basin in the lower third of the map.
  let best = Infinity
  let bc = 0
  let br = 0
  for (let r = Math.floor(rows * 0.45); r < rows - 6; r++) {
    for (let c = 6; c < cols - 6; c++) {
      const e = elev[r * cols + c]
      if (e < best) {
        best = e
        bc = c
        br = r
      }
    }
  }
  const level = best + 130
  const seen = new Uint8Array(cols * rows)
  const stack = [br * cols + bc]
  let count = 0
  while (stack.length && count < cols * rows * 0.05) {
    const i = stack.pop()!
    if (seen[i]) continue
    seen[i] = 1
    if (elev[i] > level) continue
    fuel[i] = Fuel.Water
    elev[i] = Math.min(elev[i], level - 1)
    count++
    const c = i % cols
    const r = (i / cols) | 0
    if (c > 0) stack.push(i - 1)
    if (c < cols - 1) stack.push(i + 1)
    if (r > 0) stack.push(i - cols)
    if (r < rows - 1) stack.push(i + cols)
  }
  void seed
}
