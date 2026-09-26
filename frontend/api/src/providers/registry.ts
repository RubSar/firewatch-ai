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
  proceduralDem, terrariumDem, topographyFuel,
} from './tier1.ts'
import { mockWeather, openMeteo, rhFuelMoisture, uniformWind } from './tier2.ts'
import { synthetic } from './provenance.ts'

/** No observations — the assimilation loop of §6 has nothing to assimilate yet. */
export const noObservations: PerimeterObserver = {
  id: 'no-observations',
  fallbacks: [],
  async fetch() {
    return {
      data: { burning: new Uint8Array(0), maxTemp: null },
      provenance: synthetic('none', 'No IR or VIIRS feed — assimilation loop inactive (§6)'),
    }
  },
}

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
    barriers: noBarriers,
    burnHistory: noBurnHistory,
    weather: (presetId) => (live ? openMeteo(cfg, presetId) : mockWeather(presetId)),
    wind: uniformWind,
    moisture: rhFuelMoisture,
    observer: noObservations,
    valuesAtRisk: densityValuesAtRisk,
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

const REAL = new Set(['terrarium-dem', 'esri-imagery-fuel', 'open-meteo'])
const kindOf = (id: string): 'measured' | 'derived' | 'synthetic' =>
  id === 'esri-imagery-fuel' ? 'derived' : REAL.has(id) ? 'measured' : 'synthetic'
