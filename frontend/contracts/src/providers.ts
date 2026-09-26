/**
 * Provider ports — ARCHITECTURE.md §9.
 *
 * Every data source the system reads is one of these, with at least two
 * implementations: one that works offline, one that reads real data. Nothing in
 * the kernel or the UI may name a concrete implementation.
 *
 * The rule that makes the mock/real swap safe: no provider returns bare data.
 * It returns data plus where the data came from, and the UI is required to
 * surface it — so "mock data presented as live" is a type error, not a
 * judgement call.
 */
import type { Bounds, Scenario } from '@firewatch/sim/terrain'
import type { ForecastHour } from '@firewatch/sim/weather'

export type ProvenanceKind = 'measured' | 'derived' | 'synthetic'

export interface Provenance {
  /** Machine-readable source id, e.g. 'worldcover-v200', 'procedural', 'esri-imagery'. */
  source: string
  /** 'measured' = real observation; 'derived' = computed from one; 'synthetic' = invented. */
  kind: ProvenanceKind
  /** Native ground resolution in metres before resampling, null if not raster-derived. */
  nativeResolution: number | null
  /** When the underlying observation was taken (ISO 8601), not when it was fetched. */
  observedAt: string | null
  fetchedAt: string
  /** 0..1 — fraction of the domain actually covered. Below 1 means holes were filled. */
  coverage: number
  /** Human-readable, shown in the UI. Must say so when kind is 'synthetic'. */
  note: string
  /** Set when this provider fell back; names what it fell back from. */
  degradedFrom?: string
}

export interface Provided<T> {
  data: T
  provenance: Provenance
}

/** Every provider is abortable and declares its own fallback chain. */
export interface Provider<TQuery, TData> {
  readonly id: string
  fetch(query: TQuery, signal?: AbortSignal): Promise<Provided<TData>>
  /** Tried in order when this one fails. Empty = hard dependency (§1 failure table). */
  readonly fallbacks: ReadonlyArray<Provider<TQuery, TData>>
}

export interface GridSpec {
  bounds: Bounds
  cols: number
  rows: number
  /** Metres per cell. */
  cellSize: number
  /** Providers resample to this; no caller reprojects. */
  crs: 'EPSG:4326'
}

/**
 * Tier 1 queries carry the scenario as well as the grid: a procedural provider
 * genuinely needs the seed and terrain character, and a real one simply ignores
 * it. Making that explicit beats smuggling a seed into GridSpec.
 */
export interface TerrainQuery {
  grid: GridSpec
  scenario: Scenario
}

// --- Tier 1 · Perception ------------------------------------------------

export interface ElevationGrid {
  /** Metres. No NaN — providers fill their own holes. */
  elevation: Float32Array
  minElev: number
  maxElev: number
}
export type ElevationProvider = Provider<TerrainQuery, ElevationGrid>

/** `fineLoad` vs `totalLoad` is load-bearing — see the Q_ig note in §4. */
export interface FuelGrid {
  /** Indexes FUELS in @firewatch/sim/fuels. */
  fuelId: Uint8Array
  /** kg/m², 1-h fraction — the Q_ig sink. */
  fineLoad: Float32Array
  /** kg/m², all size classes. */
  totalLoad: Float32Array
  bulkDensity: Float32Array
  /** Metres. */
  depth: Float32Array
  /** σ, surface-area-to-volume — drives ε = exp(-138/σ). */
  sav: Float32Array
  /** Per-class confusion rates, so §7 can perturb classification honestly. */
  confusion: ReadonlyMap<number, ReadonlyMap<number, number>> | null
}
export type FuelProvider = Provider<TerrainQuery, FuelGrid>

/** Weakest inputs in the chain (§4) — `assumed` is the point. */
export interface CanopyGrid {
  canopyLoad: Float32Array
  /** Canopy base height, m. */
  cbh: Float32Array
  /** Canopy bulk density, kg/m³. */
  cbd: Float32Array
  cover: Float32Array
  /** 1 where CBH/CBD are per-class assumptions rather than measured. */
  assumed: Uint8Array
}
export type CanopyProvider = Provider<TerrainQuery, CanopyGrid>

/** Vector barriers → the sub-cell blocking fractions of §5. Per-edge, not per-cell. */
export interface BarrierField {
  /**
   * blockFrac[i * 8 + d] = 0..1 obstruction on the flux from cell i toward
   * neighbour d, where d indexes `NEIGHBOURS` in `@firewatch/sim/model`.
   * Providers must use that order; the kernel reads it directly.
   */
  blockFrac: Float32Array
}
export type BarrierProvider = Provider<TerrainQuery, BarrierField>

/** Burn history → the graded fuel reduction of §3, never a binary mask. */
export interface SeverityGrid {
  /** Relative Burn Ratio, for display and thresholding by a caller that wants to. */
  rbr: Float32Array
  /**
   * Key & Benson class 0-4 (unburned .. high). Classified by the provider
   * because only it holds the dNBR that the breaks are defined on — RBR is a
   * different scale and thresholding it with dNBR breaks is simply wrong.
   */
  severity: Uint8Array
  /** Years since the burn, 99 where none was detected. */
  yearsSince: Float32Array
}
export type BurnHistoryProvider = Provider<TerrainQuery, SeverityGrid>

// --- Tier 2 · Weather ---------------------------------------------------

/**
 * windDir is the direction wind blows FROM, degrees clockwise from north.
 * Carries ForecastHour's `hour`/`clock` so a live feed and the mock feed are the
 * same shape — the UI's forecast strip reads those and must not branch on source.
 */
export type Observation = ForecastHour & { at: string }

export interface WeatherBundle {
  current: Observation
  /** Hourly, ascending. Callers interpolate; providers do not. */
  forecast: Observation[]
}
export type WeatherProvider = Provider<{ bounds: Bounds; hours: number }, WeatherBundle>

export interface WindField {
  /**
   * Eastward component, m/s. Meteorological convention, as ECMWF and
   * Open-Meteo use — NOT grid-aligned. `v` is northward even though grid rows
   * increase southward; mixing the two silently rotates the fire.
   */
  u: Float32Array
  /** Northward component, m/s. */
  v: Float32Array
  /** Metres — the resolution the field was actually solved at, before interpolation. */
  resolution: number
}
export type WindFieldProvider = Provider<
  { grid: GridSpec; elevation: ElevationGrid; at: Observation },
  WindField
>

export interface FuelMoistureModel {
  readonly id: string
  /**
   * Per-cell, because aspect and shading matter once this stops being a scalar.
   * `prior` is unused by the simple model; it exists so an NFDRS timelag model —
   * which integrates toward equilibrium rather than evaluating a formula — drops
   * in without changing any caller.
   */
  compute(
    grid: GridSpec,
    weather: Observation,
    elevation: ElevationGrid,
    prior?: Float32Array
  ): Provided<Float32Array>
}

// --- Tier 3 · Kernel inputs ---------------------------------------------

export interface DetectedIgnition {
  lat: number
  lng: number
  detectedAt: string
  confidence: number
}
export type IgnitionSource = Provider<{ bounds: Bounds; since: string }, { points: DetectedIgnition[] }>

export type SuppressionAction =
  | { kind: 'line'; cells: number[]; builtAt: number }
  | { kind: 'retardant'; cells: number[]; droppedAt: number; concentration: number }
  | { kind: 'crew'; cells: number[]; from: number; personnel: number }

export interface SuppressionPlan {
  readonly id: string
  actionsAt(simTime: number): readonly SuppressionAction[]
}

export interface ObservedPerimeter {
  /** 1 where the sensor saw fire, on the query's grid. Empty when unobserved. */
  burning: Uint8Array
  /** Radiometric max temp where available — scores the kernel's maxTemp diagnostic. */
  maxTemp: Float32Array | null
}
/**
 * Takes the grid, not just the bounds: `burning` is a raster, and a raster
 * without the spec it was sampled onto cannot be compared to anything.
 */
export type PerimeterObserver = Provider<{ grid: GridSpec; at: string }, ObservedPerimeter>

export interface ValuesAtRiskGrid {
  /** Count per cell. */
  structures: Float32Array
  population: Float32Array
}
export type ValuesAtRisk = Provider<TerrainQuery, ValuesAtRiskGrid>
