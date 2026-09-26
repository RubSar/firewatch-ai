/**
 * Hindcast: replay real fires and score the model against their mapped
 * perimeters — ARCHITECTURE.md §8 step 4.
 *
 *   npm run hindcast --workspace=@firewatch/api
 *
 * Everything before this measured the model against itself or against another
 * model. This is the first number that says anything about real fires.
 *
 * Ground truth is the WFIGS interagency perimeter: an authoritative polygon
 * for ONE named incident, with a discovery time. An earlier version derived
 * the scar from dNBR between two Sentinel-2 scenes and it did not work —
 * Sentinel's revisit and cloud force the scene pair tens of days apart, so
 * the "scar" was every fire in the region that season scored against a
 * simulation of one. The perimeter dataset solves that by construction.
 *
 * WHAT THIS STILL IS NOT. The ignition point is the polygon centroid, because
 * no ignition coordinate is wired. That is generous: a real forecast starts
 * from a detection at the edge of a young fire, not the middle of where it
 * will end up. And there is no suppression in the replay, while every one of
 * these fires was fought. So this measures whether the model grows a fire of
 * roughly the right size and shape under the real weather, unsuppressed. A
 * Dice score from it must not be quoted as operational accuracy.
 */
import { buildTerrain, scenarioAt } from '@firewatch/sim/terrain'
import { Cell, createSim, ignite, recomputeStats, step } from '@firewatch/sim/model'
import { FUELS } from '@firewatch/sim/fuels'
import type { Params } from '@firewatch/sim/weather'
import { loadConfig } from './config.ts'
import { buildRegistry } from './providers/registry.ts'
import { resolve } from './providers/provenance.ts'
import type { Config } from './config.ts'

const WFIGS =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'WFIGS_Interagency_Perimeters_YearToDate/FeatureServer/0/query'

/** Acres to hectares. */
const AC_HA = 0.404686
/**
 * Replay runs discovery -> containment, not a fixed window.
 *
 * A fixed 96 h was scoring a four-day simulation against a FINAL perimeter.
 * Cypress Creek burned for thirteen days, so the model was being asked to
 * reproduce thirteen days of growth in four — which biases toward
 * under-prediction, and it still over-predicted by 2x. Any area error
 * measured that way understates itself.
 */
const FALLBACK_HOURS = 96
/**
 * Ceiling on a replay. Each simulated hour is 360 kernel steps over the whole
 * grid, so a two-month containment would dominate the run for no extra
 * insight — by then suppression, not weather, is deciding the outcome.
 */
const MAX_REPLAY_HOURS = 14 * 24
/** Domain padding around the perimeter, so the fire is not clipped by the grid. */
const PAD = 1.6

interface Perimeter {
  name: string
  acres: number
  discovered: number
  /** Null when the record has no containment time. */
  contained: number | null
  rings: number[][][]
  lat: number
  lng: number
  spanKm: number
  /** Reported point of origin, when the record carries one. */
  originLat: number | null
  originLng: number | null
}

async function fetchPerimeters(minAcres: number, maxAcres: number, cfg: Config): Promise<Perimeter[]> {
  const url =
    `${WFIGS}?where=poly_GISAcres%3E${minAcres}+AND+poly_GISAcres%3C${maxAcres}` +
    `&outFields=poly_IncidentName,attr_FireDiscoveryDateTime,attr_ContainmentDateTime,` +
    `poly_GISAcres,attr_InitialLatitude,attr_InitialLongitude` +
    `&returnGeometry=true&outSR=4326&resultRecordCount=12&f=json`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Math.max(cfg.fetchTimeoutMs, 45000))
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) throw new Error(`WFIGS ${res.status}`)
    const json = (await res.json()) as {
      features?: { attributes: Record<string, unknown>; geometry?: { rings?: number[][][] } }[]
    }
    const out: Perimeter[] = []
    for (const f of json.features ?? []) {
      const rings = f.geometry?.rings
      const discovered = f.attributes.attr_FireDiscoveryDateTime as number | null
      if (!rings?.length || !discovered) continue
      const pts = rings.flat()
      const lo = Math.min(...pts.map((p) => p[0]))
      const hi = Math.max(...pts.map((p) => p[0]))
      const la = Math.min(...pts.map((p) => p[1]))
      const ha = Math.max(...pts.map((p) => p[1]))
      const lat = (la + ha) / 2
      const widthKm = (hi - lo) * 111.32 * Math.cos((lat * Math.PI) / 180)
      const heightKm = (ha - la) * 110.54
      out.push({
        name: String(f.attributes.poly_IncidentName ?? 'unnamed'),
        acres: Number(f.attributes.poly_GISAcres ?? 0),
        discovered,
        contained: (f.attributes.attr_ContainmentDateTime as number | null) ?? null,
        rings,
        lat,
        lng: (lo + hi) / 2,
        spanKm: Math.max(widthKm, heightKm) * PAD,
        originLat: (f.attributes.attr_InitialLatitude as number | null) ?? null,
        originLng: (f.attributes.attr_InitialLongitude as number | null) ?? null,
      })
    }
    return out
  } finally {
    clearTimeout(timer)
  }
}

/** Even-odd ray casting: is (lng, lat) inside any ring? */
function inPolygon(rings: number[][][], lng: number, lat: number): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/** Hourly weather as it actually was, from Open-Meteo's archive. */
async function archiveWeather(
  lat: number, lng: number, startMs: number, hours: number, cfg: Config
): Promise<Params[] | null> {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&start_date=${iso(startMs)}&end_date=${iso(startMs + hours * 3600_000)}` +
    `&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation&timezone=UTC`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), cfg.fetchTimeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) throw new Error(`archive ${res.status}`)
    const json = (await res.json()) as {
      hourly?: {
        time: string[]; temperature_2m: number[]; relative_humidity_2m: number[]
        wind_speed_10m: number[]; wind_direction_10m: number[]; precipitation: number[]
      }
    }
    const h = json.hourly
    if (!h?.time?.length) return null
    const from = h.time.findIndex((t) => new Date(`${t}Z`).getTime() >= startMs)
    let dry = 30
    return h.time.slice(Math.max(0, from), Math.max(0, from) + hours).map((_, k) => {
      const i = Math.max(0, from) + k
      const rain = h.precipitation[i] ?? 0
      dry = rain > 0.2 ? 0 : dry + 1 / 24
      return {
        temperature: h.temperature_2m[i] ?? 20,
        humidity: h.relative_humidity_2m[i] ?? 40,
        windSpeed: h.wind_speed_10m[i] ?? 0,
        windDir: h.wind_direction_10m[i] ?? 0,
        gustiness: 0.3,
        daysSinceRain: dry,
        precipitation: rain,
        spotting: 1,
        suppression: 0,
        followForecast: false,
      }
    })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Every burnable cell fuel-connected to the ignition point.
 *
 * The ceiling on what any spread model could ever burn here, whatever its
 * rate. Two of three hindcasts burnt out well before their replay window
 * ended and lengthening the window changed nothing, which says the model is
 * limited by what it can REACH rather than by how fast it travels. This
 * measures that ceiling so the two can be told apart: if the modelled area
 * sits at the ceiling, the rate is irrelevant and the fix is fuel
 * connectivity and barriers.
 *
 * Eight-connected, matching the kernel's neighbour set.
 */
function reachableArea(fuel: Uint8Array, cols: number, rows: number, startCol: number, startRow: number): Uint8Array {
  const seen = new Uint8Array(cols * rows)
  const start = startRow * cols + startCol
  if (FUELS[fuel[start]].load <= 0) return seen
  const stack = [start]
  seen[start] = 1
  while (stack.length) {
    const i = stack.pop()!
    const c = i % cols
    const r = (i / cols) | 0
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dc && !dr) continue
        const nc = c + dc
        const nr = r + dr
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
        const j = nr * cols + nc
        if (seen[j] || FUELS[fuel[j]].load <= 0) continue
        seen[j] = 1
        stack.push(j)
      }
    }
  }
  return seen
}

export function dice(a: Uint8Array, b: Uint8Array) {
  let inter = 0
  let ca = 0
  let cb = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i]) ca++
    if (b[i]) cb++
    if (a[i] && b[i]) inter++
  }
  return { dice: ca + cb > 0 ? (2 * inter) / (ca + cb) : 0, inter, aCells: ca, bCells: cb }
}

async function run(p: Perimeter, cfg: Config) {
  const when = new Date(p.discovered).toISOString().slice(0, 16).replace('T', ' ')
  console.log(`\n=== ${p.name} — ${Math.round(p.acres).toLocaleString()} ac ` +
    `(${Math.round(p.acres * AC_HA).toLocaleString()} ha), discovered ${when}Z ===`)

  const sc = scenarioAt(p.lat, p.lng, Math.max(8, Math.min(80, Math.round(p.spanKm))))
  const base = buildTerrain(sc)
  const { cols, rows, bounds, cellSize } = base
  const grid = { bounds, cols, rows, cellSize, crs: 'EPSG:4326' as const }
  const haPerCell = (cellSize * cellSize) / 10000

  // Ground truth: the mapped perimeter, rasterised onto our grid.
  const truth = new Uint8Array(cols * rows)
  let truthCells = 0
  let sx = 0
  let sy = 0
  for (let r = 0; r < rows; r++) {
    const lat = bounds.north - ((r + 0.5) / rows) * (bounds.north - bounds.south)
    for (let c = 0; c < cols; c++) {
      const lng = bounds.west + ((c + 0.5) / cols) * (bounds.east - bounds.west)
      if (inPolygon(p.rings, lng, lat)) {
        truth[r * cols + c] = 1
        truthCells++
        sx += c
        sy += r
      }
    }
  }
  // Self-check: the rasterised polygon must agree with the acreage WFIGS
  // reports for it. Two of the first four runs disagreed by 100x — the
  // polygon had landed almost entirely outside the derived grid — and a
  // rasterisation that silently captures the wrong area produces a Dice score
  // that looks like a measurement and is not one.
  const rasterHa = truthCells * haPerCell
  const reportedHa = p.acres * AC_HA
  const agreement = rasterHa / reportedHa
  console.log(`  grid ${cols}x${rows} @ ${cellSize.toFixed(0)}m · perimeter covers ` +
    `${truthCells.toLocaleString()} cells (${rasterHa.toFixed(0)} ha vs ${reportedHa.toFixed(0)} reported)`)
  if (truthCells < 50 || agreement < 0.8 || agreement > 1.25) {
    // Usually the SOURCE disagrees with itself rather than the rasterisation
    // being wrong: WFIGS carries four separate records named "Wildhorse", and
    // the one matching the size filter claims 6,949 acres with a polygon
    // spanning about a kilometre. Either the acreage or the geometry is wrong
    // and there is no way to tell which, so the record is unusable.
    const polySpanKm = p.spanKm / PAD
    return console.log(
      `  SKIPPED — polygon rasterises to ${rasterHa.toFixed(0)} ha but the record claims ` +
      `${reportedHa.toFixed(0)} ha (${agreement.toFixed(2)}x), across a ${polySpanKm.toFixed(1)} km extent. ` +
      'Source record is self-inconsistent.'
    )
  }

  // Discovery to containment, so the simulated period matches the period the
  // perimeter actually describes.
  const burnedHours = p.contained
    ? Math.round((p.contained - p.discovered) / 3600_000)
    : null
  const wantHours = Math.min(MAX_REPLAY_HOURS, Math.max(6, burnedHours ?? FALLBACK_HOURS))
  const truncated = burnedHours != null && burnedHours > MAX_REPLAY_HOURS

  const weather = await archiveWeather(p.lat, p.lng, p.discovered, wantHours, cfg)
  if (!weather?.length) return console.log('  no archive weather — skipped')
  const peak = weather.reduce((m, w) => Math.max(m, w.windSpeed), 0)
  const rain = weather.reduce((m, w) => m + w.precipitation, 0)
  const span = burnedHours
    ? `discovery to containment (${(burnedHours / 24).toFixed(1)} d)${truncated ? `, capped at ${MAX_REPLAY_HOURS / 24} d` : ''}`
    : `no containment time — fixed ${FALLBACK_HOURS} h window`
  console.log(`  replay: ${weather.length} h — ${span}`)
  console.log(`  weather: peak wind ${peak.toFixed(0)} km/h, ${rain.toFixed(1)} mm rain`)

  // Through the registry, so the hindcast scores whatever the product would
  // actually run. Calling a provider directly meant this kept measuring the
  // visible-band classifier for a whole session after WorldCover replaced it.
  const reg = buildRegistry(cfg)
  const dem = await resolve(reg.elevation, { grid, scenario: sc })
  const fuel = await resolve(reg.fuel, { grid, scenario: sc })
  // Roads and streams. The replay ran without them for its whole life, which
  // made "barriers do nothing" untestable rather than false.
  // Never swallow this silently. It reported "none active" for three fires
  // while the provider was returning 70,832 blocking edges when called
  // directly — a bare catch turned a failure into a finding.
  const barriers = await resolve(reg.barriers, { grid, scenario: sc }).catch((err) => {
    console.log(`  barriers: FAILED — ${(err as Error).message}`)
    return null
  })
  const edges = cols * rows * 8
  const blockFrac =
    barriers && barriers.data.blockFrac.length === edges &&
    barriers.data.blockFrac.some((v) => v > 0)
      ? barriers.data.blockFrac
      : null
  if (barriers && !blockFrac) {
    console.log(
      `  barriers: resolved but unusable — ${barriers.data.blockFrac.length} edges ` +
      `(expected ${edges}), any non-zero: ${barriers.data.blockFrac.some((v) => v > 0)}`
    )
  } else if (blockFrac) {
    let nz = 0
    for (const v of blockFrac) if (v > 0) nz++
    console.log(`  barriers: ${nz.toLocaleString()} blocked edges — ${barriers!.provenance.note.slice(0, 58)}`)
  }
  const terrain = {
    ...base, elevation: dem.data.elevation, fuel: fuel.data.fuelId,
    minElev: dem.data.minElev, maxElev: dem.data.maxElev, source: 'live' as const,
  }

  /**
   * Ignite at the REPORTED point of origin where the record has one.
   *
   * Using the perimeter centroid instead quietly rigged the comparison: it
   * starts the fire in the middle of where it ended up, which suits a
   * symmetric model and penalises a directional one for running downwind past
   * the far edge. An equal-area circle scored 0.758 against the model's 0.388
   * under that setup — a result about the experiment, not the physics.
   */
  const centroidCol = Math.round(sx / truthCells)
  const centroidRow = Math.round(sy / truthCells)
  let ic = centroidCol
  let ir = centroidRow
  let origin = 'perimeter centroid (assumed)'
  if (p.originLat != null && p.originLng != null) {
    const c = Math.round(((p.originLng - bounds.west) / (bounds.east - bounds.west)) * cols)
    const r = Math.round(((bounds.north - p.originLat) / (bounds.north - bounds.south)) * rows)
    if (c >= 0 && r >= 0 && c < cols && r < rows) {
      ic = c
      ir = r
      const offset = Math.hypot(c - centroidCol, r - centroidRow) * cellSize / 1000
      origin = `reported point of origin (${offset.toFixed(1)} km from the centroid)`
    }
  }
  console.log(`  ignition: ${origin}`)

  const sim = createSim(terrain, 7)
  ignite(sim, ic, ir, 1)
  const DT = 10
  for (const hour of weather) {
    for (let s = 0; s < 3600 / DT; s++) {
      step(sim, { params: hour, weather: hour, dt: DT, ...(blockFrac ? { blockFrac } : {}) })
    }
  }
  recomputeStats(sim)

  const modelled = new Uint8Array(sim.state.length)
  for (let i = 0; i < modelled.length; i++) modelled[i] = sim.state[i] !== Cell.Unburned ? 1 : 0

  // When did it stop growing? Lengthening the replay from 96 h to 313 h did
  // not change Cypress Creek's area at all, and 113 Incident reached its
  // final size in 6 h — the model floods everything fuel-connected and then
  // stops, so duration barely enters into it. That is a different defect from
  // "burns too long", and it is the one to chase.
  console.log(`  growth: ${sim.active.length === 0 ? 'burnt out' : `${sim.active.length} cells still alight`}` +
    ` at the end of the replay`)

  // Is the model rate-limited or reach-limited?
  const reachable = reachableArea(terrain.fuel, cols, rows, ic, ir)
  let reachCells = 0
  for (const v of reachable) if (v) reachCells++
  let burnable = 0
  for (const f of terrain.fuel) if (FUELS[f].load > 0) burnable++
  const modelledCells = sim.burnedCells
  console.log(
    `  reachable: ${(reachCells * haPerCell).toFixed(0)} ha fuel-connected to the origin ` +
    `(${((burnable / terrain.fuel.length) * 100).toFixed(0)}% of the grid is burnable at all)`
  )
  console.log(
    `  the model burnt ${((modelledCells / Math.max(1, reachCells)) * 100).toFixed(0)}% of what it could reach` +
    ` -> ${modelledCells / Math.max(1, reachCells) > 0.9 ? 'REACH-limited: rate is not the binding constraint' : 'rate-limited: it stopped short of the reachable area'}`
  )
  const d = dice(truth, modelled)

  /**
   * Null model: a disc at the ignition point with the same area the model
   * produced. Dice rewards overlap, and a fire started at the centroid of the
   * true perimeter overlaps it substantially no matter what physics runs —
   * so the question is not "is Dice high" but "is it higher than a circle".
   * Anything the physics is worth shows up as the gap between these two.
   *
   * Centred on the ignition point, whatever that is, so the disc and the
   * model start from the same place and only their shapes differ.
   */
  const discRadius = Math.sqrt(d.bCells / Math.PI)
  const disc = new Uint8Array(truth.length)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((c - ic) ** 2 + (r - ir) ** 2 <= discRadius * discRadius) disc[r * cols + c] = 1
    }
  }
  const nullModel = dice(truth, disc)

  const recall = d.inter / Math.max(1, d.aCells)
  const precision = d.inter / Math.max(1, d.bCells)
  console.log(`  modelled ${(d.bCells * haPerCell).toFixed(0)} ha in ${weather.length} h, ` +
    `area ratio ${(d.bCells / d.aCells).toFixed(2)}x`)
  console.log(`  DICE ${d.dice.toFixed(3)}   recall ${(recall * 100).toFixed(0)}% of the real fire caught` +
    `   precision ${(precision * 100).toFixed(0)}% of the prediction real`)
  console.log(`  null model (equal-area disc at the same point): DICE ${nullModel.dice.toFixed(3)}` +
    `   -> physics ${d.dice > nullModel.dice ? 'beats' : 'DOES NOT BEAT'} a circle` +
    ` (${(d.dice - nullModel.dice >= 0 ? '+' : '')}${(d.dice - nullModel.dice).toFixed(3)})`)
}

const cfg = loadConfig()
const perims = await fetchPerimeters(5000, 60000, cfg)
console.log(`WFIGS: ${perims.length} mapped perimeters between 5k and 60k acres`)
console.log('(ignition from the reported point of origin where available; no suppression modelled)')
for (const p of perims.slice(0, 4)) {
  try {
    await run(p, cfg)
  } catch (err) {
    console.log(`  FAILED: ${(err as Error).message}`)
  }
}
