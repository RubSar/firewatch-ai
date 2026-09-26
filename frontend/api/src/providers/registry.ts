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
  assumedCanopy, densityValuesAtRisk, imageryFuel, noBarriers, noBurnHistory,
  noObservations, proceduralDem, terrariumDem, topographyFuel,
} from './tier1.ts'
import { mockWeather, nfdrs1hMoisture, openMeteo, openMeteoWind, rhFuelMoisture, uniformWind } from './tier2.ts'
import { osmBarriers, osmValuesAtRisk } from './osm.ts'
import { firmsPerimeter } from './firms.ts'

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
  return {
    elevation: live ? terrariumDem(cfg) : proceduralDem,
    fuel: live ? imageryFuel(cfg) : topographyFuel,
    canopy: assumedCanopy,
    barriers: live ? osmBarriers(cfg) : noBarriers,
    burnHistory: noBurnHistory,
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

const MEASURED = new Set(['terrarium-dem', 'open-meteo', 'firms-perimeter'])
/** Real input, assumed parameters on top of it: imagery colours, OSM tag widths. */
const DERIVED = new Set([
  'esri-imagery-fuel', 'osm-barriers', 'osm-buildings',
  'open-meteo-windfield', 'nfdrs-1h-timelag',
])
const kindOf = (id: string): 'measured' | 'derived' | 'synthetic' =>
  DERIVED.has(id) ? 'derived' : MEASURED.has(id) ? 'measured' : 'synthetic'
