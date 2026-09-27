/**
 * In-browser transport — the original behaviour, unchanged.
 *
 * Kept as a first-class configuration rather than a fallback: it is what makes
 * the app work with no server and no network, and it is what the smoke test
 * exercises deterministically.
 */
import {
  createSim, forecastAt, ignite, invalidateFront, paintTreatment, recomputeStats, step,
} from '@firewatch/sim'
import type { Params, Sim, ForecastHour, Stats, Terrain, Weather } from '@firewatch/sim'
import type { FireTransport, TransportStatus } from './types.ts'

const DT = 10
const MAX_STEPS_PER_FRAME = 90

export class LocalTransport implements FireTransport {
  readonly kind = 'local' as const
  sim: Sim
  terrain: Terrain
  status: TransportStatus
  forecast: ForecastHour[]
  /**
   * Cells the user lit, in order. Kept so a provisional local transport can
   * hand its ignitions to the real one when a slower source finishes loading —
   * the user's fire must survive the swap.
   */
  readonly userIgnitions: { col: number; row: number }[] = []
  /** Control lines the user drew, as operations so they can be replayed. */
  readonly userTreatments: { col: number; row: number; kind: 1 | 2 }[] = []
  /**
   * Staging mode: accept input and render, but never step.
   *
   * Used while a slower source loads. Stepping here would build up fire that
   * the real source cannot inherit — the server starts its own incident at
   * t=0 — so the growth would visibly vanish at the handoff.
   */
  readonly staging: boolean
  private carry = 0
  private playing = false
  private speed = 300
  private subs = new Set<(s: { stats: Stats; time: number; status: TransportStatus }) => void>()

  constructor(terrain: Terrain, forecast: ForecastHour[], note: string, staging = false) {
    this.staging = staging
    this.terrain = terrain
    this.forecast = forecast
    this.sim = createSim(terrain)
    this.status = { note, ready: true, provenance: {} }
    recomputeStats(this.sim)
  }

  ignite(col: number, row: number) {
    this.userIgnitions.push({ col, row })
    ignite(this.sim, col, row, 1)
    this.playing = true
    recomputeStats(this.sim)
    this.emit()
  }

  treat(col: number, row: number, kind: 1 | 2) {
    this.userTreatments.push({ col, row, kind })
    paintTreatment(this.sim, col, row, kind === 1 ? 1 : 2, kind)
  }

  clearTreatment() {
    this.userTreatments.length = 0
    this.sim.treatment.fill(0)
    // Clearing a line frees cells the queued arrival times were computed
    // around, so discard them and let the next step re-derive the frontier.
    invalidateFront(this.sim)
    // The renderer only rebuilds geometry when the sim changes; while paused the
    // clock is frozen, so without this the cleared lines stay on screen.
    this.sim.revision++
  }

  reset() {
    this.sim = createSim(this.terrain)
    this.userIgnitions.length = 0
    this.userTreatments.length = 0
    this.playing = false
    this.carry = 0
    recomputeStats(this.sim)
    this.emit()
  }

  setParams() {
    // Local reads params straight from the host on each advance().
  }

  setControl(c: { playing?: boolean; speed?: number }) {
    if (c.playing !== undefined) this.playing = c.playing
    if (c.speed !== undefined) this.speed = c.speed
  }

  advance(realDt: number, params: Params) {
    if (!this.playing || this.staging) return
    this.carry += realDt * this.speed
    let steps = Math.min(MAX_STEPS_PER_FRAME, Math.floor(this.carry / DT))
    this.carry -= steps * DT
    while (steps-- > 0) {
      const weather: Weather = params.followForecast
        ? forecastAt(this.forecast, this.sim.time)
        : params
      step(this.sim, { params, weather, dt: DT })
    }
  }

  sample(): Stats {
    recomputeStats(this.sim)
    return this.sim.stats
  }

  subscribe(fn: (s: { stats: Stats; time: number; status: TransportStatus }) => void) {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  private emit() {
    for (const fn of this.subs) {
      fn({ stats: { ...this.sim.stats }, time: this.sim.time, status: this.status })
    }
  }

  dispose() {
    this.subs.clear()
  }
}
