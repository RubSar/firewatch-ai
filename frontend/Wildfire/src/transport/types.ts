/**
 * Where the fire runs.
 *
 * Both transports expose a real `Sim` object, so the renderer cannot tell the
 * difference: MapView, fireGeometry and paint read `sim.state`, `sim.ignitedAt`
 * and `sim.treatment` exactly as before. The remote transport mirrors those
 * arrays from the wire instead of stepping them locally, which is what keeps
 * the whole rendering path unchanged.
 */
import type { ForecastHour, Params, Sim, Stats, Terrain } from '@firewatch/sim'
import type { Provenance } from '@firewatch/contracts/providers'

export interface TransportStatus {
  /** Short label for the header chip. */
  note: string
  /** True once real data is in hand (or the fallback has settled). */
  ready: boolean
  /** Per-port provenance; empty for the local transport. */
  provenance: Record<string, Provenance>
  /** Set when the transport is degraded or disconnected. */
  error?: string
}

export interface FireTransport {
  readonly kind: 'local' | 'remote'
  /** Always a real Sim. Remote patches it from deltas rather than stepping it. */
  readonly sim: Sim
  readonly terrain: Terrain
  readonly status: TransportStatus
  readonly forecast: ForecastHour[]

  ignite(col: number, row: number): void
  treat(col: number, row: number, kind: 1 | 2): void
  clearTreatment(): void
  reset(): void
  setParams(patch: Partial<Params>): void
  setControl(c: { playing?: boolean; speed?: number }): void

  /**
   * Called once per animation frame by the host.
   * Local steps the kernel; remote is a no-op because the server drives the
   * clock and pushes state.
   */
  advance(realDt: number, params: Params): void

  /**
   * Refresh the derived read-outs and return them.
   *
   * Perimeter and containment need a full-grid pass, so this is called at the
   * host's 5 Hz read-out cadence rather than per step. Local recomputes;
   * remote just returns what the server already sent.
   */
  sample(): Stats

  /** Fires when stats or the grid changed — the host re-renders read-outs. */
  subscribe(fn: (s: { stats: Stats; time: number; status: TransportStatus }) => void): () => void
  dispose(): void
}
