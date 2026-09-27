/**
 * Composition root — ARCHITECTURE.md §9.
 *
 * The ONLY place that names concrete implementations. Everything else takes a
 * port. Flipping `mode` swaps real for mock without another file changing.
 */
import type {
  BarrierProvider, BurnHistoryProvider, CanopyProvider, ElevationProvider,
  FuelMoistureModel, FuelProvider, PerimeterObserver, ValuesAtRisk, WeatherProvider,
  WindFieldProvider,
} from '@firewatch/contracts/providers'
import type { Config } from '../config.ts'
import {
  assumedCanopy, densityValuesAtRisk, noBarriers, noBurnHistory,
  noObservations, proceduralDem, terrariumDem, topographyFuel,
} from './tier1.ts'
import { mockWeather, nfdrs1hMoisture, openMeteo, openMeteoWind, rhFuelMoisture, uniformWind } from './tier2.ts'
import { sentinelBurnHistory } from './burnhistory.ts'
import { osmBarriers, osmValuesAtRisk } from './osm.ts'
import { firmsPerimeter } from './firms.ts'
import { learnedCanopy } from './canopy-learned.ts'
import { fbfm40Fuel } from './landfire.ts'

export interface Registry {
  elevation: ElevationProvider
  fuel: FuelProvider
  canopy: CanopyProvider
  barriers: BarrierProvider
  burnHistory: BurnHistoryProvider
  weather: (presetId: string) => WeatherProvider
  wind: WindFieldProvider
  moisture: FuelMoistureModel
  observer: PerimeterObserver
  valuesAtRisk: ValuesAtRisk
}

export function buildRegistry(cfg: Config): Registry {
  const live = cfg.mode === 'live'
  const elevation = live ? terrariumDem(cfg) : proceduralDem
  /**
   * FBFM40 first, WorldCover behind it via the fallback chain.
   *
   * Inside CONUS this is the operational fuel model the US fire agencies run;
   * outside it the service returns nothing, the provider throws, and `resolve`
   * drops to WorldCover with `degradedFrom` recording that it happened. So the
   * order encodes "use the authoritative source where it exists" without anything
   * having to know where CONUS is.
   */
  const fuel = live ? fbfm40Fuel(cfg) : topographyFuel
  return {
    elevation,
    fuel,
    /**
     * The learned canopy model takes the elevation and fuel PORTS, not their
     * resolved data — the only dependency-injected provider here. It needs both
     * as predictors, and resolving them itself keeps canopy as one slot in
     * `Incident.create`'s Promise.all rather than serialising behind them. Both
     * are tile-cached, so the second read is cheap.
     *
     * Offline mode stays on the assumption: there is no Sentinel-2 to predict
     * from, and a procedural grid would feed the model features it never saw.
     */
    canopy: live ? learnedCanopy(cfg, { elevation, fuel }) : assumedCanopy,
    barriers: live ? osmBarriers(cfg) : noBarriers,
    burnHistory: live ? sentinelBurnHistory(cfg) : noBurnHistory,
    weather: (presetId) => (live ? openMeteo(cfg, presetId) : mockWeather(presetId)),
    wind: live ? openMeteoWind(cfg) : uniformWind,
    moisture: live ? nfdrs1hMoisture(cfg) : rhFuelMoisture,
    observer: live ? firmsPerimeter(cfg) : noObservations,
    valuesAtRisk: live ? osmValuesAtRisk(cfg) : densityValuesAtRisk,
  }
}

/** Flat description for GET /api/health — which port is bound to what. */
export function describe(r: Registry) {
  return {
    elevation: { id: r.elevation.id, kind: kindOf(r.elevation.id) },
    fuel: { id: r.fuel.id, kind: kindOf(r.fuel.id) },
    canopy: { id: r.canopy.id, kind: kindOf(r.canopy.id) },
    barriers: { id: r.barriers.id, kind: kindOf(r.barriers.id) },
    burnHistory: { id: r.burnHistory.id, kind: kindOf(r.burnHistory.id) },
    weather: { id: r.weather('red-flag').id, kind: kindOf(r.weather('red-flag').id) },
    wind: { id: r.wind.id, kind: kindOf(r.wind.id) },
    moisture: { id: r.moisture.id, kind: kindOf(r.moisture.id) },
    observer: { id: r.observer.id, kind: kindOf(r.observer.id) },
    valuesAtRisk: { id: r.valuesAtRisk.id, kind: kindOf(r.valuesAtRisk.id) },
  } as const
}

const MEASURED = new Set(['terrarium-dem', 'open-meteo', 'firms-perimeter', 'esa-worldcover'])
/** Real input, assumed parameters on top of it: imagery colours, OSM tag widths. */
const DERIVED = new Set([
  'esri-imagery-fuel', 'osm-barriers', 'osm-buildings',
  'open-meteo-windfield', 'nfdrs-1h-timelag', 'sentinel2-dnbr',
  // Learned, which is a kind of derived: real predictors, a fitted mapping, and
  // held-out error published in its provenance note. Never 'measured' — the
  // numbers are predictions, and LANDFIRE is the label source, not the input.
  'landfire-gbt-canopy',
  // FBFM40 itself is operational, but a 40-to-7 crosswalk is derived from it.
  'landfire-fbfm40',
])
const kindOf = (id: string): 'measured' | 'derived' | 'synthetic' =>
  DERIVED.has(id) ? 'derived' : MEASURED.has(id) ? 'measured' : 'synthetic'
