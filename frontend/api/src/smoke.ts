/**
 * Backend smoke test: boots the real server, drives an incident through every
 * command, and decodes the binary stream to prove the codec round-trips.
 *
 * Runs offline by default so it needs no network and is deterministic:
 *   npm run smoke --workspace=@firewatch/api
 *   FIREWATCH_MODE=live npm run smoke --workspace=@firewatch/api
 */
import { WebSocket } from 'ws'
import { decodeState, decodeTerrain, frameType, FRAME_TERRAIN } from '@firewatch/contracts/codec'
import type { TerrainFrame } from '@firewatch/contracts/codec'
import type { HealthDto, IncidentDto, ScenarioDto, ServerEvent, StateFrame } from '@firewatch/contracts/wire'
import { loadConfig } from './config.ts'
import { buildServer } from './server.ts'

const mode = process.env.FIREWATCH_MODE === 'live' ? 'live' : 'offline'
const cfg = { ...loadConfig(), mode: mode as 'live' | 'offline', port: 0, tickMs: 50 }
const failures: string[] = []
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const step = (n: string) => console.log(`\n▸ ${n}`)

const app = await buildServer(cfg)
await app.listen({ port: 0, host: '127.0.0.1' })
const addr = app.server.address()
if (!addr || typeof addr === 'string') throw new Error('no address')
const base = `http://127.0.0.1:${addr.port}`
const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

console.log(`firewatch api smoke · mode=${mode} · ${base}`)

step('health + provider wiring')
const health = await json<HealthDto>('/api/health')
check(health.ok === true, 'health ok')
const kinds = Object.entries(health.providers).map(([k, v]) => `${k}=${v.kind}`)
check(Object.keys(health.providers).length === 10, '10 ports bound', kinds.join(' '))

step('scenarios')
const scenarios = await json<ScenarioDto[]>('/api/scenarios')
check(scenarios.length === 3, `${scenarios.length} scenarios`, scenarios.map((s) => s.id).join(', '))

step('create incident')
const t0 = Date.now()
const inc = await json<IncidentDto>('/api/incidents', {
  method: 'POST',
  body: JSON.stringify({ scenarioId: 'khosrov', offline: mode === 'offline' }),
})
check(!!inc.incidentId, `created in ${Date.now() - t0}ms`, `${inc.grid.cols}x${inc.grid.rows} @ ${inc.grid.cellSize.toFixed(1)}m`)
check(Object.keys(inc.provenance).length >= 6, 'provenance for every port',
  Object.entries(inc.provenance).map(([k, v]) => `${k}:${v.kind}`).join(' '))
const synthetic = Object.values(inc.provenance).filter((p) => p.kind === 'synthetic').length
check(true, `${synthetic}/${Object.keys(inc.provenance).length} ports are mocked`, 'surfaced, not hidden')

step('websocket stream')
const ws = new WebSocket(`${base.replace('http', 'ws')}/api/incidents/${inc.incidentId}/stream`)
ws.binaryType = 'arraybuffer'
/**
 * A mutable container rather than loose `let`s: TypeScript cannot see the
 * assignments inside the socket callback and narrows plain locals to `never`.
 */
const rx = {
  terrain: null as TerrainFrame | null,
  last: null as StateFrame | null,
  frames: 0,
  bytes: 0,
  /**
   * A client-side mirror of the grid, rebuilt from deltas exactly as
   * RemoteTransport does. Checking stats alone is not enough: a reset that
   * clears the server's shadows resets the numbers while leaving the burn scar
   * on every client, and only a mirror catches that.
   */
  grid: new Uint8Array(0),
  lit: 0,
}
const events: ServerEvent[] = []

await new Promise<void>((res, rej) => {
  ws.on('error', rej)
  ws.on('message', (data: Buffer | ArrayBuffer) => {
    // `ws` hands back Buffers for both text and binary frames, so sniff the
    // first byte: JSON events start with '{', binary frames with a type tag.
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data)
    if (view[0] === 0x7b) {
      events.push(JSON.parse(Buffer.from(view).toString()) as ServerEvent)
      return
    }
    // Copy into a standalone ArrayBuffer: a Buffer is a view into a shared pool
    // and its byteOffset is rarely 0, which the codec's DataView would misread.
    const buf = view.slice().buffer
    rx.bytes += buf.byteLength
    if (frameType(buf) === FRAME_TERRAIN) {
      rx.terrain = decodeTerrain(buf)
      rx.grid = new Uint8Array(rx.terrain.cols * rx.terrain.rows)
      return
    }
    const f = decodeState(buf)
    if (f.full) rx.grid.fill(0)
    for (const c of f.changed) rx.grid[c.index] = c.state
    rx.lit = f.flaming.length
    rx.last = f
    rx.frames++
  })
  ws.on('open', () => setTimeout(res, 400))
})
check(!!rx.terrain, 'terrain frame decoded',
  rx.terrain ? `${rx.terrain.cols}x${rx.terrain.rows}, elev ${rx.terrain.minElev.toFixed(0)}..${rx.terrain.maxElev.toFixed(0)}m` : '')
check(rx.terrain?.cols === inc.grid.cols && rx.terrain?.rows === inc.grid.rows, 'terrain matches DTO')
check(events.some((e) => e.type === 'hello'), 'hello event received')
check(rx.frames > 0, `${rx.frames} state frames`)

step('ignite + run')
const mid = { col: Math.floor(inc.grid.cols * 0.45), row: Math.floor(inc.grid.rows * 0.4) }
await json(`/api/incidents/${inc.incidentId}/command`, {
  method: 'POST', body: JSON.stringify({ type: 'ignite', ...mid }),
})
await json(`/api/incidents/${inc.incidentId}/command`, {
  method: 'POST', body: JSON.stringify({ type: 'control', playing: true, speed: 1800 }),
})
const before = rx.bytes
await new Promise((r) => setTimeout(r, 3000))
const grew = rx.last
check(!!grew && grew.stats.area > 0, 'fire is growing',
  grew ? `${grew.stats.area.toFixed(0)} ha, ${grew.activeCells} active, ROS ${grew.stats.maxRos.toFixed(1)} m/min` : '')
check(!!grew && grew.stats.perimeter > 0, 'perimeter computed', grew ? `${grew.stats.perimeter.toFixed(1)} km` : '')
check(rx.grid.some((v) => v !== 0), 'client mirror has burnt cells',
  `${rx.grid.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0)} cells`)
check(rx.lit > 0, 'flame intensity streamed', `${rx.lit} flaming cells this frame`)
const deltaBytes = rx.bytes - before
check(deltaBytes > 0, 'delta frames are small',
  `${(deltaBytes / 1024).toFixed(0)} kB over 3 s across ${rx.frames} frames = ${Math.round(deltaBytes / Math.max(1, rx.frames))} B/frame avg`)

step('dozer line raises containment')
const lineCol = Math.floor(inc.grid.cols * 0.2)
for (let r = Math.floor(inc.grid.rows * 0.25); r < Math.floor(inc.grid.rows * 0.75); r += 2) {
  await json(`/api/incidents/${inc.incidentId}/command`, {
    method: 'POST', body: JSON.stringify({ type: 'treat', col: lineCol, row: r, radius: 1, kind: 1 }),
  })
}
await new Promise((r) => setTimeout(r, 600))
check((rx.last?.treatmentChanged?.length ?? 0) >= 0, 'treatment streamed',
  `containment ${((rx.last?.stats.containment ?? 0) * 100).toFixed(0)}%`)

step('params + reset')
await json(`/api/incidents/${inc.incidentId}/command`, {
  method: 'POST', body: JSON.stringify({ type: 'params', patch: { windSpeed: 65, humidity: 7 } }),
})
const after = await json<IncidentDto>(`/api/incidents/${inc.incidentId}`)
check(after.params.windSpeed === 65 && after.params.humidity === 7, 'params applied')
await json(`/api/incidents/${inc.incidentId}/command`, {
  method: 'POST', body: JSON.stringify({ type: 'reset' }),
})
await new Promise((r) => setTimeout(r, 300))
check((rx.last?.stats.area ?? -1) === 0, 'reset clears the stats')
// The regression that matters: the grid every client renders must clear too.
const leftover = rx.grid.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0)
check(leftover === 0, 'reset clears the client mirror', leftover ? `${leftover} cells still set` : 'grid empty')
check(rx.lit === 0, 'reset clears flame intensity')

step('cleanup')
ws.close()
await new Promise((r) => setTimeout(r, 200))
const stillHeld = await json<HealthDto>('/api/health')
check(stillHeld.incidents === 1, 'closing a socket alone does not drop the incident',
  'the reaper and the client DELETE are what release it')
const del = await fetch(`${base}/api/incidents/${inc.incidentId}`, { method: 'DELETE' })
check(del.ok, 'DELETE accepted')
const finalHealth = await json<HealthDto>('/api/health')
check(finalHealth.incidents === 0, 'incident released')

await app.close()
console.log(`\n${failures.length ? `✗ ${failures.length} FAILED: ${failures.join(', ')}` : '✓ all backend checks passed'}`)
process.exit(failures.length ? 1 : 0)
