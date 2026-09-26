import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One place that decides mock vs real. Nothing else in the server may branch on
 * it — everything downstream sees a provider and cannot tell the difference,
 * which is the whole point of ARCHITECTURE.md §9.
 */
export interface Config {
  port: number
  host: string
  /** 'live' attempts real tile/weather fetches; 'offline' is fully procedural. */
  mode: 'live' | 'offline'
  tileCacheDir: string
  /** Wall-clock milliseconds between broadcast state frames. */
  tickMs: number
  /** Refuse to hold more than this many incidents in memory. */
  maxIncidents: number
  /** Network timeout for any Tier 1/2 fetch, ms. */
  fetchTimeoutMs: number
  /** Drop an incident this long after its last socket detaches. */
  idleTimeoutMs: number
  /** Overpass endpoint for OSM barriers. The public instance is rate-limited. */
  overpassUrl: string
}

export function loadConfig(env = process.env): Config {
  const mode = env.FIREWATCH_MODE === 'offline' ? 'offline' : 'live'
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    mode,
    tileCacheDir: env.TILE_CACHE_DIR ?? join(tmpdir(), 'firewatch-tiles'),
    tickMs: Number(env.TICK_MS ?? 100),
    maxIncidents: Number(env.MAX_INCIDENTS ?? 32),
    fetchTimeoutMs: Number(env.FETCH_TIMEOUT_MS ?? 15000),
    idleTimeoutMs: Number(env.IDLE_TIMEOUT_MS ?? 60000),
    overpassUrl: env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter',
  }
}
