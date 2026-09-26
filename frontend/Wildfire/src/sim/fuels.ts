/**
 * Simplified surface fuel models, loosely after Anderson's 13 (NFFL) set.
 *
 * MOCK: in production these come from a LANDFIRE FBFM40 raster clipped to the
 * area of interest. Every cell carries only a fuel-model id, so swapping the
 * procedural generator for a real raster read is a drop-in change.
 */
export const Fuel = {
  Water: 0,
  Barren: 1,
  Grass: 2,
  Shrub: 3,
  Timber: 4,
  Agriculture: 5,
  Urban: 6,
} as const
export type Fuel = (typeof Fuel)[keyof typeof Fuel]

export interface FuelModel {
  id: Fuel
  name: string
  /** No-wind, no-slope rate of spread on flat ground at low moisture (m/s). */
  baseRos: number
  /** Available fuel load (kg/m^2) — drives burn duration and fireline intensity. */
  load: number
  /** Moisture of extinction (% dead fuel moisture): above this it will not carry fire. */
  mx: number
  /** Relative ember production, drives long-range spotting. */
  spotting: number
  color: [number, number, number]
}

/** Indexed by Fuel id. */
export const FUELS: FuelModel[] = [
  { id: Fuel.Water, name: 'Water', baseRos: 0, load: 0, mx: 0, spotting: 0, color: [44, 84, 122] },
  { id: Fuel.Barren, name: 'Rock / barren', baseRos: 0, load: 0, mx: 0, spotting: 0, color: [150, 142, 130] },
  { id: Fuel.Grass, name: 'Grass / annual', baseRos: 0.062, load: 0.8, mx: 20, spotting: 0.2, color: [188, 166, 98] },
  { id: Fuel.Shrub, name: 'Chaparral / shrub', baseRos: 0.034, load: 3.2, mx: 26, spotting: 0.8, color: [112, 128, 76] },
  { id: Fuel.Timber, name: 'Timber / conifer', baseRos: 0.013, load: 5.5, mx: 30, spotting: 1.0, color: [58, 88, 62] },
  { id: Fuel.Agriculture, name: 'Agriculture', baseRos: 0.021, load: 1.1, mx: 32, spotting: 0.1, color: [158, 178, 104] },
  { id: Fuel.Urban, name: 'Urban / WUI', baseRos: 0.007, load: 2.4, mx: 22, spotting: 0.5, color: [141, 138, 145] },
]

export const isBurnable = (f: number) => FUELS[f].load > 0

export const FUEL_LEGEND: Fuel[] = [Fuel.Grass, Fuel.Shrub, Fuel.Timber, Fuel.Agriculture, Fuel.Urban, Fuel.Water]
