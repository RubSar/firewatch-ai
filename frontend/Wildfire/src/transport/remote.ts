/**
 * Server-driven transport.
 *
 * The server owns the clock and the kernel; this mirrors the resulting grid
 * into a local `Sim` so every renderer downstream is untouched. Only the cells
 * the server says changed are written, which is why a running fire costs
 * ~1-3 kB per frame rather than the 132 kB a full grid would.
 */
import { computeShade, createSim, EMPTY_STATS } from '@firewatch/sim'
import type { ForecastHour, Params, Scenario, Sim, Stats, Terrain } from '@firewatch/sim'
import { scenarioCentre } from '@firewatch/sim/terrain'
import { FRAME_TERRAIN, decodeState, decodeTerrain, frameType } from '@firewatch/contracts/codec'
import type { IncidentDto, ServerEvent } from '@firewatch/contracts/wire'
import type { FireTransport, TransportStatus } from './types.ts'

/** Cell.Burning — mirrored here to avoid importing the whole model for one constant. */
const BURNING = 1

export class RemoteTransport implements FireTransport {
  readonly kind = 'remote' as const
  sim: Sim
  terrain: Terrain
  status: TransportStatus
  forecast: ForecastHour[]
  private ws: WebSocket | null = null
  private active = new Set<number>()
  /** Cells whose intensity we wrote last frame, so they can be cleared. */
  private litLastFrame: number[] = []
  private readonly incidentId: string
  private readonly baseUrl: string
  private subs = new Set<(s: { stats: Stats; time: number; status: TransportStatus }) => void>()
  private closed = false

  private constructor(terrain: Terrain, incident: IncidentDto, baseUrl: string) {
    this.incidentId = incident.incidentId
    this.baseUrl = baseUrl
    this.terrain = terrain
    this.sim = createSim(terrain)
    this.forecast = incident.forecast
    this.status = {
      note: summarise(incident),
      ready: true,
      provenance: incident.provenance,
    }
  }

  /**
   * Creates an incident, waits for the terrain frame, and returns a ready
   * transport. Terrain arrives as elevation + fuel only; hillshade is recomputed
   * locally rather than sent, which saves 4 bytes per cell on a one-off payload.
   */
  static async connect(baseUrl: string, scenario: Scenario, signal?: AbortSignal): Promise<RemoteTransport> {
    // A bookmark goes by id so the server keeps its hand-tuned placeholder
    // terrain; anywhere else goes by coordinates. Both end up as the same kind
    // of incident — the bookmark is a shortcut, not a different code path.
    const c = scenarioCentre(scenario)
    const body = scenario.id.startsWith('at:')
      ? { lat: c.lat, lng: c.lng, spanKm: Math.round(c.spanKm), name: scenario.name, region: scenario.region }
      : { scenarioId: scenario.id }
    const res = await fetch(`${baseUrl}/api/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) throw new Error(`create incident failed: ${res.status}`)
    const incident: IncidentDto = await res.json()

    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/incidents/${incident.incidentId}/stream`
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'

    const terrain = await new Promise<Terrain>((resolve, reject) => {
      const fail = (m: string) => reject(new Error(m))
      ws.onerror = () => fail('socket error')
      ws.onclose = () => fail('socket closed before terrain arrived')
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') return
        const buf = ev.data as ArrayBuffer
        if (frameType(buf) !== FRAME_TERRAIN) return
        const t = decodeTerrain(buf)
        const shade = new Float32Array(t.cols * t.rows)
        computeShade(t.elevation, shade, t.cols, t.rows, t.cellSize)
        resolve({
          cols: t.cols,
          rows: t.rows,
          cellSize: t.cellSize,
          bounds: t.bounds,
          elevation: t.elevation,
          fuel: t.fuel,
          shade,
          minElev: t.minElev,
          maxElev: t.maxElev,
          source: 'live',
        })
      }
      signal?.addEventListener('abort', () => fail('aborted'), { once: true })
    })

    const rt = new RemoteTransport(terrain, incident, baseUrl)
    rt.attach(ws)
    return rt
  }

  private attach(ws: WebSocket) {
    this.ws = ws
    ws.onerror = null
    ws.onclose = () => {
      if (this.closed) return
      this.status = { ...this.status, ready: false, error: 'Disconnected from server' }
      this.emit()
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const event = JSON.parse(ev.data) as ServerEvent
        if (event.type === 'error') {
          this.status = { ...this.status, error: event.message }
          this.emit()
        }
        return
      }
      const buf = ev.data as ArrayBuffer
      if (frameType(buf) === FRAME_TERRAIN) return
      this.applyState(buf)
    }
  }

  private applyState(buf: ArrayBuffer) {
    const f = decodeState(buf)
    const { sim } = this
    if (f.full) {
      sim.state.fill(0)
      sim.ignitedAt.fill(-1)
      sim.treatment.fill(0)
      sim.intensity.fill(0)
      this.active.clear()
      this.litLastFrame = []
    }
    for (const c of f.changed) {
      sim.state[c.index] = c.state
      sim.ignitedAt[c.index] = c.ignitedAt
      if (c.state === BURNING) this.active.add(c.index)
      else this.active.delete(c.index)
    }
    for (const t of f.treatmentChanged) sim.treatment[t.index] = t.kind

    sim.time = f.time
    // The server's revision is authoritative; bumping locally as well would let
    // the two drift and make the renderer's change test unreliable.
    sim.revision = f.revision
    sim.peakIntensity = f.peakIntensity
    sim.peakRos = f.peakRos
    sim.stats = f.stats

    // Intensity arrives only for cells inside their flaming window, so clear
    // last frame's before writing this one — otherwise cells that stopped
    // flaming keep a hot core forever.
    for (const i of this.litLastFrame) sim.intensity[i] = 0
    this.litLastFrame.length = 0
    for (const c of f.flaming) {
      sim.intensity[c.index] = c.intensity * f.peakIntensity
      this.litLastFrame.push(c.index)
    }
    // fireGeometry only reads active.length, but keep it a real index list so
    // anything else that touches it sees the truth.
    sim.active = [...this.active]

    const last = sim.history[sim.history.length - 1]
    if (!last || f.time - last.t >= 300) {
      sim.history.push({ t: f.time, area: f.stats.area, perimeter: f.stats.perimeter })
      if (sim.history.length > 600) sim.history.shift()
    }
    this.emit()
  }

  private send(command: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'command', command }))
    }
  }

  ignite(col: number, row: number) { this.send({ type: 'ignite', col, row, radius: 1 }) }
  treat(col: number, row: number, kind: 1 | 2) { this.send({ type: 'treat', col, row, radius: kind === 1 ? 1 : 2, kind }) }
  clearTreatment() { this.send({ type: 'clearTreatment' }) }
  reset() { this.send({ type: 'reset' }) }
  setParams(patch: Partial<Params>) { this.send({ type: 'params', patch }) }
  setControl(c: { playing?: boolean; speed?: number }) { this.send({ type: 'control', ...c }) }

  /** The server drives the clock; nothing to do per frame. */
  advance() {}

  /** The server already ran the full-grid pass; the wire carries the result. */
  sample(): Stats {
    return this.sim.stats
  }

  subscribe(fn: (s: { stats: Stats; time: number; status: TransportStatus }) => void) {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  private emit() {
    const payload = { stats: this.sim.stats ?? EMPTY_STATS, time: this.sim.time, status: this.status }
    for (const fn of this.subs) fn(payload)
  }

  dispose() {
    this.closed = true
    this.subs.clear()
    try { this.ws?.close() } catch { /* already gone */ }
    // Release the incident rather than leaving the server stepping a fire
    // nobody is watching. keepalive lets it survive page unload; the server
    // also reaps idle incidents in case this never arrives.
    try {
      void fetch(`${this.baseUrl}/api/incidents/${this.incidentId}`, {
        method: 'DELETE',
        keepalive: true,
      }).catch(() => undefined)
    } catch {
      // Nothing to do — the server-side reaper is the backstop.
    }
  }
}

/** Header chip text: names what is real and what is mocked, never just "live". */
function summarise(inc: IncidentDto): string {
  const p = inc.provenance
  const real = Object.entries(p).filter(([, v]) => v.kind !== 'synthetic').map(([k]) => k)
  const mocked = Object.entries(p).filter(([, v]) => v.kind === 'synthetic').length
  if (!real.length) return `Server · all ${mocked} sources mocked`
  return `Server · live ${real.join(' + ')} · ${mocked} mocked`
}
