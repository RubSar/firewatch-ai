/**
 * Incident API. REST for lifecycle and commands, WebSocket for the state
 * stream: commands are rare and want to be readable, state is 10 Hz and wants
 * to be small.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { DEFAULT_SPAN_KM, SCENARIOS, scenarioAt } from '@firewatch/sim/terrain'
import type { Scenario } from '@firewatch/sim/terrain'
import type {
  ClientMessage, CreateIncidentRequest, GeocodeResult, HealthDto, IncidentCommand, ScenarioDto,
  ServerEvent,
} from '@firewatch/contracts/wire'
import { PROTOCOL_VERSION } from '@firewatch/contracts/wire'
import { Incident } from './incident.ts'
import { geocode } from './providers/geocode.ts'
import { activeFires } from './providers/firms.ts'
import { buildRegistry, describe, type Registry } from './providers/registry.ts'
import type { Config } from './config.ts'

interface Session {
  incident: Incident
  sockets: Set<{ send(data: unknown): void; readyState: number }>
  timer: NodeJS.Timeout
  /** When the last socket detached. 0 while at least one is attached. */
  idleSince: number
}

export async function buildServer(cfg: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } })
  await app.register(websocket)

  const reg: Registry = buildRegistry(cfg)
  const sessions = new Map<string, Session>()
  const startedAt = Date.now()

  // CORS is deliberately permissive: this serves a local dev UI on another port
  // and holds no credentials and no private data.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('access-control-allow-origin', '*')
    reply.header('access-control-allow-headers', 'content-type')
    reply.header('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS')
  })
  app.options('/*', async (_req, reply) => reply.code(204).send())

  app.get('/api/health', async (): Promise<HealthDto> => ({
    ok: true,
    protocol: PROTOCOL_VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    incidents: sessions.size,
    sessions: [...sessions.values()].map((s) => ({
      id: s.incident.id,
      sockets: s.sockets.size,
      idleSeconds: s.idleSince ? Math.round((Date.now() - s.idleSince) / 1000) : null,
    })),
    providers: describe(reg),
  }))

  app.get('/api/scenarios', async (): Promise<ScenarioDto[]> =>
    SCENARIOS.map((s) => ({
      id: s.id, name: s.name, region: s.region, blurb: s.blurb, bounds: s.bounds, preset: s.preset,
    }))
  )

  app.get('/api/geocode', async (req, reply) => {
    const q = (req.query as { q?: string }).q ?? ''
    try {
      const results: GeocodeResult[] = await geocode(q, cfg)
      return { results }
    } catch (err) {
      return reply.code(502).send({ error: `geocoding unavailable: ${(err as Error).message}` })
    }
  })

  app.get('/api/fires', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const nums = ['north', 'south', 'east', 'west'].map((k) => Number(q[k]))
    if (nums.some((n) => !Number.isFinite(n))) {
      return reply.code(400).send({ error: 'north, south, east and west are required' })
    }
    const [north, south, east, west] = nums
    if (north <= south || east <= west) {
      return reply.code(400).send({ error: 'north must exceed south, and east must exceed west' })
    }
    try {
      return await activeFires({ north, south, east, west }, cfg)
    } catch (err) {
      return reply.code(502).send({ error: `FIRMS unavailable: ${(err as Error).message}` })
    }
  })

  app.post('/api/incidents', async (req, reply) => {
    const body = (req.body ?? {}) as CreateIncidentRequest

    // A bookmark is a convenience, not a constraint: every data source is
    // global, so any lat/lng is a valid area of interest.
    let scenario: Scenario | undefined
    if (typeof body.lat === 'number' && typeof body.lng === 'number') {
      if (!Number.isFinite(body.lat) || Math.abs(body.lat) > 85) {
        return reply.code(400).send({ error: 'lat must be finite and within ±85° (web-Mercator limit)' })
      }
      if (!Number.isFinite(body.lng) || Math.abs(body.lng) > 180) {
        return reply.code(400).send({ error: 'lng must be finite and within ±180°' })
      }
      const spanKm = body.spanKm ?? DEFAULT_SPAN_KM
      if (!Number.isFinite(spanKm) || spanKm < 2 || spanKm > 80) {
        return reply.code(400).send({ error: 'spanKm must be between 2 and 80' })
      }
      scenario = scenarioAt(body.lat, body.lng, spanKm, { name: body.name, region: body.region })
    } else {
      scenario = SCENARIOS.find((s) => s.id === body.scenarioId)
    }
    if (!scenario) return reply.code(400).send({ error: `unknown scenario '${body.scenarioId}'` })
    if (sessions.size >= cfg.maxIncidents) {
      return reply.code(503).send({ error: 'incident limit reached' })
    }
    // An offline request gets the procedural chain regardless of server mode,
    // so tests are deterministic and need no network.
    const useReg = body.offline ? buildRegistry({ ...cfg, mode: 'offline' }) : reg
    const incident = await Incident.create(scenario, useReg)
    const session: Session = {
      incident,
      sockets: new Set(),
      idleSince: Date.now(),
      timer: setInterval(() => broadcast(session), cfg.tickMs),
    }
    sessions.set(incident.id, session)
    return incident.toDto()
  })

  const find = (id: string) => sessions.get(id)

  app.get('/api/incidents/:id', async (req, reply) => {
    const s = find((req.params as { id: string }).id)
    if (!s) return reply.code(404).send({ error: 'no such incident' })
    return s.incident.toDto()
  })

  app.post('/api/incidents/:id/command', async (req, reply) => {
    const s = find((req.params as { id: string }).id)
    if (!s) return reply.code(404).send({ error: 'no such incident' })
    const cmd = req.body as IncidentCommand
    if (!cmd || typeof cmd.type !== 'string') {
      return reply.code(400).send({ error: 'command requires a type' })
    }
    s.incident.apply(cmd)
    broadcast(s)
    return { ok: true, time: s.incident.sim.time, stats: s.incident.stats }
  })

  app.delete('/api/incidents/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const s = find(id)
    if (!s) return reply.code(404).send({ error: 'no such incident' })
    clearInterval(s.timer)
    for (const ws of s.sockets) tryClose(ws)
    sessions.delete(id)
    return { ok: true }
  })

  app.get('/api/incidents/:id/stream', { websocket: true }, (socket, req) => {
    const s = find((req.params as { id: string }).id)
    if (!s) {
      send(socket, { type: 'error', message: 'no such incident' } satisfies ServerEvent)
      socket.close()
      return
    }
    s.sockets.add(socket)
    s.idleSince = 0
    send(socket, { type: 'hello', protocol: PROTOCOL_VERSION, incident: s.incident.toDto() })
    socket.send(Buffer.from(s.incident.encodeTerrain()))
    // A joining client needs the whole grid, not the delta since the last tick.
    socket.send(Buffer.from(s.incident.encode(true)))
    send(socket, { type: 'control', playing: s.incident.playing, speed: s.incident.speed })

    socket.on('message', (raw: Buffer) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return send(socket, { type: 'error', message: 'malformed message' })
      }
      if (msg.type === 'command') {
        try {
          s.incident.apply(msg.command)
          broadcast(s)
        } catch (err) {
          send(socket, { type: 'error', message: (err as Error).message })
        }
      } else if (msg.type === 'resync') {
        socket.send(Buffer.from(s.incident.encode(true)))
      }
    })
    socket.on('close', () => {
      s.sockets.delete(socket)
      if (!s.sockets.size) s.idleSince = Date.now()
    })
  })

  function broadcast(s: Session) {
    s.incident.tick()
    if (!s.sockets.size) return
    const frame = Buffer.from(s.incident.encode(false))
    for (const ws of s.sockets) {
      if (ws.readyState === 1) ws.send(frame)
    }
  }

  /**
   * Reap incidents nobody is watching.
   *
   * A browser that navigates away, crashes, or is force-quit never calls
   * DELETE, and each orphan keeps a 10 Hz timer stepping a fire nobody sees.
   * Without this, repeated scenario changes walk straight into maxIncidents.
   * The client's DELETE on dispose is the fast path; this is the backstop.
   */
  const reaper = setInterval(() => {
    const cutoff = Date.now() - cfg.idleTimeoutMs
    for (const [id, s] of sessions) {
      if (!s.sockets.size && s.idleSince && s.idleSince < cutoff) {
        clearInterval(s.timer)
        sessions.delete(id)
        app.log.warn({ id }, 'reaped idle incident')
      }
    }
  }, Math.max(1000, Math.floor(cfg.idleTimeoutMs / 4)))
  reaper.unref()

  app.addHook('onClose', async () => {
    clearInterval(reaper)
    for (const s of sessions.values()) clearInterval(s.timer)
    sessions.clear()
  })

  return app
}

const send = (ws: { send(d: unknown): void }, ev: ServerEvent) => ws.send(JSON.stringify(ev))
const tryClose = (ws: unknown) => {
  try {
    (ws as { close(): void }).close()
  } catch {
    // already gone
  }
}
