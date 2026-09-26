/**
 * One running fire. Owns the sim, the clock, and the diff against what clients
 * were last told.
 *
 * The stepping logic mirrors the browser's rAF loop exactly — same DT, same
 * per-frame step budget — because the same @firewatch/sim code runs on both
 * sides and divergence here would show as a fire that behaves differently
 * depending on where it ran.
 */
import { randomUUID } from 'node:crypto'
import {
  EMPTY_STATS, buildTerrain, computeShade, createSim, flamingTime, forecastAt, getPreset,
  ignite, mockForecast, paintTreatment, recomputeStats, step,
} from '@firewatch/sim'
import type { ForecastHour, Params, Scenario, Sim, Stats, Terrain, Weather } from '@firewatch/sim'
import type {
  ElevationGrid, FuelMoistureModel, GridSpec, Provenance, TerrainQuery,
} from '@firewatch/contracts/providers'
import { warmMoistureHistory, windAnomalyFor, windFieldFrom, type WindAnomaly } from './providers/tier2.ts'
import { encodeState, encodeTerrain, type StateFrameInput } from '@firewatch/contracts/codec'
import type { IncidentCommand, IncidentDto } from '@firewatch/contracts/wire'
import { resolve } from './providers/provenance.ts'
import type { Registry } from './providers/registry.ts'
import type { Config } from './config.ts'

/** Simulation seconds per integration step — must match the browser's DT. */
const DT = 10
/** Ceiling on work per tick so a slow host cannot spiral. */
const MAX_STEPS_PER_TICK = 90
const FORECAST_START_HOUR = 13

export class Incident {
  readonly id = randomUUID()
  readonly provenance: Record<string, Provenance> = {}
  /**
   * Per-edge barrier obstruction, or null when the field is all zeros.
   *
   * Lives on the incident rather than on `Sim` so that `reset` — which builds a
   * fresh sim over the same terrain — cannot drop it. Terrain-derived and
   * immutable for the incident's life, exactly like `terrain` itself.
   */
  blockFrac: Float32Array | null = null
  /** Real wind shape for this area; null falls back to the single vector. */
  windAnomaly: WindAnomaly | null = null
  private windField: { u: Float32Array; v: Float32Array } | null = null
  private moistureField: Float32Array | null = null
  /** Weather the fields were built for, so they rebuild only when it moves. */
  private fieldSig = ''
  private moistureModel: FuelMoistureModel | null = null
  private elevationGrid: ElevationGrid | null = null
  private gridSpec: GridSpec | null = null
  /** Real per-cell building counts when OSM supplied them; null keeps the estimate. */
  structures: Float32Array | null = null
  sim: Sim
  playing = false
  /** Matches the UI's DEFAULT_SPEED; the client pushes its own on connect. */
  speed = 60
  params: Params
  forecast: ForecastHour[]
  private carry = 0
  private lastTick = performance.now()
  private shadowState: Uint8Array
  private shadowTreatment: Uint8Array
  private changedIdx: Uint32Array
  private treatIdx: Uint32Array
  private flamingIdx: Uint32Array

  readonly scenario: Scenario
  readonly terrain: Terrain

  // Explicit fields rather than parameter properties: Node runs this file with
  // type-stripping only, and parameter properties emit code, so they are not
  // erasable. `erasableSyntaxOnly` in tsconfig makes tsc reject them too.
  private constructor(scenario: Scenario, terrain: Terrain) {
    this.scenario = scenario
    this.terrain = terrain
    this.sim = createSim(terrain)
    this.params = {
      ...getPreset(scenario.preset).weather,
      spotting: 1,
      suppression: 0,
      followForecast: false,
    }
    this.forecast = mockForecast(getPreset(scenario.preset).weather, FORECAST_START_HOUR)
    const n = terrain.cols * terrain.rows
    this.shadowState = new Uint8Array(n)
    this.shadowTreatment = new Uint8Array(n)
    this.changedIdx = new Uint32Array(n)
    this.treatIdx = new Uint32Array(n)
    this.flamingIdx = new Uint32Array(n)
  }

  /**
   * Resolves every Tier 1 port, then assembles a Terrain. Elevation and fuel are
   * fetched concurrently and each degrades independently — a live DEM with
   * procedural fuel is a valid, and clearly labelled, outcome.
   */
  static async create(
    scenario: Scenario,
    reg: Registry,
    cfg: Config,
    signal?: AbortSignal
  ): Promise<Incident> {
    const base = buildTerrain(scenario)
    const grid: GridSpec = {
      bounds: base.bounds,
      cols: base.cols,
      rows: base.rows,
      cellSize: base.cellSize,
      crs: 'EPSG:4326',
    }
    const q: TerrainQuery = { grid, scenario }

    // Everything that only needs the grid goes out at once. Weather waits on
    // nothing either, but it feeds `params`, so it is read below. Keeping the
    // slow ones concurrent is what holds incident creation at the cost of the
    // slowest fetch rather than the sum of them — the FIRMS observer's cold
    // cache alone is 6 seconds of deadline it can spend behind the tiles.
    const now = new Date().toISOString()
    const [elev, fuel, canopy, barriers, values, observer, burnHistory, weather] = await Promise.all([
      resolve(reg.elevation, q, signal),
      resolve(reg.fuel, q, signal),
      resolve(reg.canopy, q, signal),
      resolve(reg.barriers, q, signal),
      resolve(reg.valuesAtRisk, q, signal),
      resolve(reg.observer, { grid, at: now }, signal),
      resolve(reg.burnHistory, q, signal),
      resolve(reg.weather(scenario.preset), { bounds: base.bounds, hours: 24 }, signal).catch(() => null),
    ])

    const shade = new Float32Array(base.cols * base.rows)
    computeShade(elev.data.elevation, shade, base.cols, base.rows, base.cellSize)

    const terrain: Terrain = {
      ...base,
      elevation: elev.data.elevation,
      fuel: fuel.data.fuelId,
      shade,
      minElev: elev.data.minElev,
      maxElev: elev.data.maxElev,
      source: elev.provenance.kind === 'synthetic' ? 'synthetic' : 'live',
    }

    const inc = new Incident(scenario, terrain)
    inc.provenance.elevation = elev.provenance
    inc.provenance.fuel = fuel.provenance
    inc.provenance.canopy = canopy.provenance
    inc.provenance.barriers = barriers.provenance
    // Length is checked rather than trusted: a provider that rasterised onto a
    // different grid would block edges belonging to other cells, which reads as
    // a physics bug rather than a data bug.
    const edges = base.cols * base.rows * 8
    if (barriers.data.blockFrac.length === edges && barriers.data.blockFrac.some((v) => v > 0)) {
      inc.blockFrac = barriers.data.blockFrac
    }

    inc.provenance.valuesAtRisk = values.provenance
    if (values.data.structures.length === base.cols * base.rows) inc.structures = values.data.structures
    inc.provenance.observer = observer.provenance
    inc.provenance.burnHistory = burnHistory.provenance

    if (weather) {
      inc.provenance.weather = weather.provenance
      inc.forecast = weather.data.forecast.map(({ at: _at, ...w }) => w)
      const cur = weather.data.current
      if (cur) {
        // Copy only the Weather fields: `at`, `hour` and `clock` describe the
        // forecast row, not the model's inputs, and Params has no place for them.
        inc.params = {
          ...inc.params,
          temperature: cur.temperature,
          humidity: cur.humidity,
          windSpeed: cur.windSpeed,
          windDir: cur.windDir,
          gustiness: cur.gustiness,
          daysSinceRain: cur.daysSinceRain,
          precipitation: cur.precipitation,
        }
      }
    }
    inc.provenance.wind = (await resolve(reg.wind, {
      grid,
      elevation: elev.data,
      at: { ...inc.params, hour: 0, clock: '00:00', at: now },
    }, signal)).provenance

    // Keep what the kernel needs: the anomaly is the expensive part and is
    // reused, while the absolute field is rebuilt whenever the weather moves.
    inc.gridSpec = grid
    inc.elevationGrid = elev.data
    inc.moistureModel = reg.moisture
    inc.windAnomaly = await windAnomalyFor(base.bounds, base.cols, base.rows, cfg, signal)
      .catch(() => null)
    await warmMoistureHistory(base.bounds, cfg).catch(() => null)
    inc.rebuildFields()

    // Moisture is recorded even though it is evaluated per step rather than
    // fetched: a port missing from this record is a mocked source the UI never
    // mentions, which is the opposite of what §9's provenance rule is for.
    inc.provenance.moisture = reg.moisture
      .compute(grid, { ...inc.params, hour: 0, clock: '00:00', at: now }, elev.data)
      .provenance

    recomputeStats(inc.sim, inc.structures ?? undefined)
    return inc
  }

  /**
   * Rebuilds the per-cell wind and moisture fields for the current weather.
   *
   * Cheap — a multiply and rotate per cell — so it runs whenever the weather
   * actually changes rather than on a timer. The expensive parts (the wind
   * lattice, the weather history) are cached by their providers.
   */
  rebuildFields() {
    const w = this.effectivePublic()
    const sig = [w.windSpeed, w.windDir, w.temperature, w.humidity, w.precipitation]
      .map((v) => Math.round(v * 10))
      .join('|')
    if (sig === this.fieldSig) return
    this.fieldSig = sig

    const n = this.terrain.cols * this.terrain.rows
    this.windField = windFieldFrom(this.windAnomaly, w, n)

    if (this.moistureModel && this.elevationGrid && this.gridSpec) {
      const got = this.moistureModel.compute(
        this.gridSpec,
        { ...w, hour: 0, clock: '00:00', at: new Date().toISOString() },
        this.elevationGrid
      )
      this.moistureField = got.data
      this.provenance.moisture = got.provenance
    }
  }

  /** The weather currently driving the model — also used to key the fields. */
  effectivePublic(): Weather {
    return this.effective()
  }

  get stats(): Stats {
    return this.sim.stats ?? EMPTY_STATS
  }

  /** Weather actually driving the model right now. */
  private effective(): Weather {
    return this.params.followForecast ? forecastAt(this.forecast, this.sim.time) : this.params
  }

  apply(cmd: IncidentCommand) {
    const { sim } = this
    switch (cmd.type) {
      case 'ignite':
        ignite(sim, cmd.col, cmd.row, cmd.radius ?? 1)
        this.playing = true
        break
      case 'treat':
        paintTreatment(sim, cmd.col, cmd.row, cmd.radius, cmd.kind)
        break
      case 'clearTreatment':
        sim.treatment.fill(0)
        sim.revision++
        break
      case 'params':
        this.params = { ...this.params, ...cmd.patch }
        break
      case 'control':
        if (cmd.playing !== undefined) this.playing = cmd.playing
        if (cmd.speed !== undefined) this.speed = cmd.speed
        break
      case 'reset':
        this.sim = createSim(this.terrain)
        this.playing = false
        this.carry = 0
        // The shadows are deliberately NOT cleared. They record what clients
        // were last told; clearing them makes the next delta empty, so the
        // stats reset while the burn scar stays on screen. Leaving them stale
        // is what makes the diff emit every burnt cell as unburned.
        break
    }
    recomputeStats(this.sim, this.structures ?? undefined)
  }

  /** Advance the clock. Returns true if the grid changed. */
  tick(now = performance.now()): boolean {
    const realDt = Math.min(0.1, (now - this.lastTick) / 1000)
    this.lastTick = now
    if (!this.playing) return false

    this.carry += realDt * this.speed
    let steps = Math.min(MAX_STEPS_PER_TICK, Math.floor(this.carry / DT))
    this.carry -= steps * DT
    if (steps <= 0) return false

    while (steps-- > 0) {
      // Weather can move under a running clock (forecast feed, slider), so
      // check before each batch rather than only when a command arrives.
      this.rebuildFields()
      step(this.sim, {
        params: this.params,
        weather: this.effective(),
        dt: DT,
        ...(this.blockFrac ? { blockFrac: this.blockFrac } : {}),
        ...(this.windField ? { windField: this.windField } : {}),
        ...(this.moistureField ? { moisture: this.moistureField } : {}),
      })
    }
    recomputeStats(this.sim, this.structures ?? undefined)
    return true
  }

  /**
   * Diffs the grid against what was last broadcast.
   *
   * A full 132k-cell compare per tick is ~0.2 ms and is provably correct, which
   * beats instrumenting the kernel to report its own changes and getting it
   * subtly wrong. Fire is monotone, so the changed set is a thin band at the
   * front rather than the whole scar.
   */
  encode(full: boolean): ArrayBuffer {
    const { sim } = this
    const n = sim.state.length
    const terrainFuel = this.terrain.fuel
    let changedCount = 0
    let treatmentCount = 0

    for (let i = 0; i < n; i++) {
      const s = sim.state[i]
      if (full ? s !== 0 : s !== this.shadowState[i]) {
        this.changedIdx[changedCount++] = i
        this.shadowState[i] = s
      } else if (!full) {
        this.shadowState[i] = s
      }
      const t = sim.treatment[i]
      if (full ? t !== 0 : t !== this.shadowTreatment[i]) {
        this.treatIdx[treatmentCount++] = i
        this.shadowTreatment[i] = t
      } else if (!full) {
        this.shadowTreatment[i] = t
      }
    }

    // Intensity only matters inside the flaming window — that is where the
    // renderer draws its hot bands. Walking `active` rather than the whole grid
    // keeps this proportional to the fire, not the map.
    let flamingCount = 0
    for (const i of sim.active) {
      if (sim.time - sim.ignitedAt[i] < flamingTime(terrainFuel[i])) {
        this.flamingIdx[flamingCount++] = i
      }
    }

    const input: StateFrameInput = {
      time: sim.time,
      revision: sim.revision,
      activeCells: sim.active.length,
      peakIntensity: sim.peakIntensity,
      peakRos: sim.peakRos,
      stats: this.stats,
      full,
      changedIndices: this.changedIdx,
      changedCount,
      state: sim.state,
      ignitedAt: sim.ignitedAt,
      treatmentIndices: this.treatIdx,
      treatmentCount,
      treatment: sim.treatment,
      flamingIndices: this.flamingIdx,
      flamingCount,
      intensity: sim.intensity,
    }
    return encodeState(input)
  }

  encodeTerrain(): ArrayBuffer {
    const t = this.terrain
    return encodeTerrain({
      cols: t.cols,
      rows: t.rows,
      cellSize: t.cellSize,
      bounds: t.bounds,
      minElev: t.minElev,
      maxElev: t.maxElev,
      elevation: t.elevation,
      fuel: t.fuel,
    })
  }

  toDto(): IncidentDto {
    return {
      incidentId: this.id,
      scenarioId: this.scenario.id,
      grid: {
        cols: this.terrain.cols,
        rows: this.terrain.rows,
        cellSize: this.terrain.cellSize,
        bounds: this.terrain.bounds,
        minElev: this.terrain.minElev,
        maxElev: this.terrain.maxElev,
      },
      provenance: this.provenance,
      params: this.params,
      forecast: this.forecast,
      forecastStartHour: FORECAST_START_HOUR,
    }
  }
}
