/**
 * Wire protocol between the browser and the incident API.
 *
 * Control is JSON over REST or the socket; fire state is binary over the socket
 * (see codec.ts). The split is deliberate: commands are rare and want to be
 * readable, state is 10 Hz and wants to be small.
 */
import type { ForecastHour, Params, Stats } from '@firewatch/sim'
import type { Provenance } from './providers.ts'

// 2: state frames carry per-cell flame intensity for the hot bands.
export const PROTOCOL_VERSION = 2

// --- REST ---------------------------------------------------------------

export interface ScenarioDto {
  id: string
  name: string
  region: string
  blurb: string
  bounds: { north: number; south: number; east: number; west: number }
  preset: string
}

export interface HealthDto {
  ok: boolean
  protocol: number
  uptimeSeconds: number
  incidents: number
  /** Per-incident liveness, so a leak can be diagnosed rather than inferred. */
  sessions: { id: string; sockets: number; idleSeconds: number | null }[]
  /** Which provider implementation is bound to each port, and whether it is real. */
  providers: Record<string, { id: string; kind: Provenance['kind'] }>
}

/**
 * Either a bookmarked scenario id, or an arbitrary point on earth.
 *
 * The data sources are global — Terrarium DEM, Esri imagery and Open-Meteo all
 * cover the world — so a bookmark is only a convenience, never a constraint.
 */
export interface CreateIncidentRequest {
  /** A bookmarked scenario. Ignored when `lat`/`lng` are given. */
  scenarioId?: string
  lat?: number
  lng?: number
  /** Edge length of the simulated square, km. Defaults to 15. */
  spanKm?: number
  /** Label for the location, e.g. from a geocoder. */
  name?: string
  region?: string
  /** Skip live tile fetches and use the procedural fallback. Used by tests. */
  offline?: boolean
}

/** One satellite active-fire detection, as the UI needs it. */
export interface FireDetection {
  lat: number
  lng: number
  /** ISO 8601 UTC of the overpass. */
  at: string
  /** Fire radiative power, MW — the closest thing to "how big". */
  frp: number
  /** Brightness temperature, K. */
  brightness: number
  /** VIIRS reports low/nominal/high; MODIS reports 0-100. Normalised to 0..1. */
  confidence: number
  satellite: string
  day: boolean
}

export interface FiresDto {
  detections: FireDetection[]
  /** Where the data came from and how stale it is. */
  provenance: import('./providers.ts').Provenance
  /** True when the bbox hit the cap and results were trimmed. */
  truncated: boolean
}

export interface GeocodeResult {
  name: string
  /** "California, United States" — already formatted for display. */
  detail: string
  lat: number
  lng: number
  countryCode: string | null
}

export interface GridMetaDto {
  cols: number
  rows: number
  cellSize: number
  bounds: { north: number; south: number; east: number; west: number }
  minElev: number
  maxElev: number
}

export interface IncidentDto {
  incidentId: string
  scenarioId: string
  grid: GridMetaDto
  /** One entry per provider port that contributed. Surfaced in the UI header. */
  provenance: Record<string, Provenance>
  params: Params
  forecast: ForecastHour[]
  forecastStartHour: number
}

/** All mutating commands, usable over REST body or socket message. */
export type IncidentCommand =
  | { type: 'ignite'; col: number; row: number; radius?: number }
  | { type: 'treat'; col: number; row: number; radius: number; kind: 1 | 2 }
  | { type: 'clearTreatment' }
  | { type: 'params'; patch: Partial<Params> }
  | { type: 'control'; playing?: boolean; speed?: number }
  | { type: 'reset' }

// --- WebSocket ----------------------------------------------------------

/** Server → client, JSON channel. Binary frames carry state; these carry events. */
export type ServerEvent =
  | { type: 'hello'; protocol: number; incident: IncidentDto }
  | { type: 'provenance'; provenance: Record<string, Provenance> }
  | { type: 'control'; playing: boolean; speed: number }
  | { type: 'history'; history: { t: number; area: number; perimeter: number }[] }
  | { type: 'error'; message: string }

/** Client → server, JSON channel. */
export type ClientMessage =
  | { type: 'command'; command: IncidentCommand }
  /** Backpressure: client asks for a full grid instead of deltas. */
  | { type: 'resync' }

/** Decoded form of a binary state frame. */
export interface StateFrame {
  time: number
  revision: number
  activeCells: number
  peakIntensity: number
  peakRos: number
  stats: Stats
  /** Cell indices whose state or ignition time changed since the last frame. */
  changed: { index: number; state: number; ignitedAt: number }[]
  treatmentChanged: { index: number; kind: number }[]
  /**
   * Cells currently carrying flame, with intensity as a 0..1 fraction of
   * `peakIntensity`. Only the flaming window is sent — that is the only place
   * the renderer reads intensity.
   */
  flaming: { index: number; intensity: number }[]
  /** True when this frame replaces the whole grid rather than patching it. */
  full: boolean
}
