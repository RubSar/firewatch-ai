/**
 * OpenStreetMap barriers via Overpass — the real `BarrierProvider` of §9.
 *
 * Roads and streams are the cheapest real data that changes the fire: a
 * motorway with its verges is a 30 m fuel break, and until now the model had
 * none of them. §5 is explicit that features narrower than a cell belong in
 * the per-edge blocking fraction rather than as unburnable cells — a 30 m road
 * on a 38 m grid would otherwise either vanish or eat the whole cell.
 *
 * Keyless and free, but a shared community endpoint: the response is cached on
 * disk like tiles, and OVERPASS_URL points at a private instance if one exists.
 *
 * What is measured here is the *geometry*. The width is an assumption per tag
 * (`width` is used where OSM carries it), which is why the provenance says
 * `derived` rather than `measured`.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NEIGHBOURS } from '@firewatch/sim/model'
import type {
  BarrierField, BarrierProvider, TerrainQuery, ValuesAtRisk, ValuesAtRiskGrid,
} from '@firewatch/contracts/providers'
import { prov } from './provenance.ts'
import { densityValuesAtRisk, noBarriers } from './tier1.ts'
import type { Config } from '../config.ts'

/**
 * Assumed cleared width in metres, including the verge that actually stops a
 * creeping flank. Deliberately coarse: OSM has no width for most ways, and a
 * per-class table is defensible where an invented per-way number is not.
 */
const ROAD_WIDTH: Record<string, number> = {
  motorway: 30, motorway_link: 16, trunk: 22, trunk_link: 14,
  primary: 16, secondary: 12, tertiary: 9,
  unclassified: 7, residential: 7, service: 5, track: 4,
}
const WATER_WIDTH: Record<string, number> = {
  river: 30, canal: 12, stream: 5, ditch: 3, drain: 3,
}

/** Nothing is a total block: embers cross every road ever built. */
const MAX_BLOCK = 0.95
/** Footways and paths carry no meaningful break, so they are not requested. */
const ROADS = Object.keys(ROAD_WIDTH).join('|')
const WATERWAYS = Object.keys(WATER_WIDTH).join('|')

/**
 * Occupants per mapped structure. OSM has no such attribute, so this is the one
 * assumption in an otherwise counted layer — and the reason the provenance says
 * `derived`.
 */
const PEOPLE_PER_STRUCTURE = 2.5

interface OverpassWay {
  type: string
  tags?: Record<string, string>
  geometry?: { lat: number; lon: number }[]
  /** `out center` gives one point per way or relation instead of its outline. */
  center?: { lat: number; lon: number }
}
interface OverpassResponse {
  elements?: OverpassWay[]
  osm3s?: { timestamp_osm_base?: string }
}

export function osmBarriers(cfg: Config): BarrierProvider {
  return {
    id: 'osm-barriers',
    fallbacks: [noBarriers],
    async fetch(q: TerrainQuery, signal?: AbortSignal) {
      const { cols, rows, cellSize, bounds } = q.grid
      const json = await overpass(
        cfg,
        // `out geom` returns coordinates inline, which avoids a second round
        // trip to resolve node ids and roughly halves the response.
        `${head(cfg)}(way["highway"~"^(${ROADS})$"](${bbox(bounds)});` +
          `way["waterway"~"^(${WATERWAYS})$"](${bbox(bounds)}););out geom;`,
        signal
      )
      const ways = (json.elements ?? []).filter((e) => e.type === 'way' && (e.geometry?.length ?? 0) > 1)
      // Zero ways is treated as a failure rather than an empty barrier field:
      // silently identical to the mock is exactly the outcome the provenance
      // chip exists to prevent. The fallback records `degradedFrom`.
      if (!ways.length) throw new Error('overpass returned no ways')

      const blockFrac = new Float32Array(cols * rows * 8)
      let roadWays = 0
      let waterWays = 0
      let blockedEdges = 0

      for (const w of ways) {
        const width = widthOf(w.tags ?? {})
        if (width <= 0) continue
        if (w.tags?.waterway) waterWays++
        else roadWays++
        const frac = Math.min(MAX_BLOCK, width / cellSize)
        const g = w.geometry as { lat: number; lon: number }[]
        for (let k = 1; k < g.length; k++) {
          blockedEdges += blockSegment(
            blockFrac, cols, rows,
            toGrid(g[k - 1].lat, g[k - 1].lon, q.grid),
            toGrid(g[k].lat, g[k].lon, q.grid),
            frac
          )
        }
      }

      if (!blockedEdges) throw new Error('overpass ways fell outside the grid')

      const data: BarrierField = { blockFrac }
      return {
        data,
        provenance: prov({
          source: 'osm-overpass',
          kind: 'derived',
          nativeResolution: null,
          observedAt: json.osm3s?.timestamp_osm_base ?? null,
          coverage: 1,
          note:
            `Live OSM · ${roadWays} roads + ${waterWays} watercourses blocking ${blockedEdges} cell edges — ` +
            `geometry measured, widths assumed per tag`,
        }),
      }
    },
  }
}

/**
 * OSM building footprints — the real `ValuesAtRisk` of §9.
 *
 * `out center` rather than `out geom`: one point per building instead of its
 * outline, which is all a per-cell count needs and is the difference between a
 * few hundred kilobytes and several megabytes over a town.
 *
 * The honest caveat is completeness, not accuracy. A building that nobody has
 * mapped is not counted, and rural Armenia is mapped unevenly — so this can
 * only ever under-count, never over-count. It is still a count of real
 * buildings where the old estimate was 3 per hectare of anything that looked
 * developed from the air.
 */
export function osmValuesAtRisk(cfg: Config): ValuesAtRisk {
  return {
    id: 'osm-buildings',
    fallbacks: [densityValuesAtRisk],
    async fetch(q: TerrainQuery, signal?: AbortSignal) {
      const { cols, rows, bounds } = q.grid
      const json = await overpass(
        cfg,
        `${head(cfg)}(way["building"](${bbox(bounds)});relation["building"](${bbox(bounds)}););out center;`,
        signal
      )

      const data: ValuesAtRiskGrid = {
        structures: new Float32Array(cols * rows),
        population: new Float32Array(cols * rows),
      }
      let counted = 0
      for (const e of json.elements ?? []) {
        const pt = e.center ?? (e.type === 'node' ? (e as unknown as { lat: number; lon: number }) : null)
        if (!pt || typeof pt.lat !== 'number') continue
        const g = toGrid(pt.lat, pt.lon, q.grid)
        const c = Math.floor(g.x)
        const r = Math.floor(g.y)
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue
        const i = r * cols + c
        data.structures[i] += 1
        data.population[i] += PEOPLE_PER_STRUCTURE
        counted++
      }

      // Zero buildings over a populated bbox means the query failed, not that
      // the valley is empty — fall back rather than report a confident zero.
      if (!counted) throw new Error('overpass returned no buildings')

      return {
        data,
        provenance: prov({
          source: 'osm-buildings',
          kind: 'derived',
          nativeResolution: null,
          observedAt: json.osm3s?.timestamp_osm_base ?? null,
          coverage: 1,
          note:
            `Live OSM · ${counted.toLocaleString('en-US')} mapped buildings counted per cell ` +
            `(occupancy assumed at ${PEOPLE_PER_STRUCTURE}/structure; unmapped buildings are not counted)`,
        }),
      }
    },
  }
}

/** `width=12` and `width=12 m` both appear; anything unparseable falls back to the tag table. */
function widthOf(tags: Record<string, string>): number {
  const tagged = Number.parseFloat(tags.width ?? '')
  if (Number.isFinite(tagged) && tagged > 0) return tagged
  if (tags.highway) {
    const lanes = Number.parseFloat(tags.lanes ?? '')
    if (Number.isFinite(lanes) && lanes > 0) return lanes * 3.5 + 4
    return ROAD_WIDTH[tags.highway] ?? 0
  }
  if (tags.waterway) return WATER_WIDTH[tags.waterway] ?? 0
  return 0
}

/** Continuous grid coordinates — plate carrée, the same mapping the DEM sampler uses. */
function toGrid(lat: number, lon: number, grid: TerrainQuery['grid']) {
  const { bounds, cols, rows } = grid
  return {
    x: ((lon - bounds.west) / (bounds.east - bounds.west)) * cols,
    y: ((bounds.north - lat) / (bounds.north - bounds.south)) * rows,
  }
}

/**
 * Blocks every cell-to-cell flux path that crosses this barrier segment.
 *
 * The criterion is geometric and direction-free: the line from one cell centre
 * to its neighbour's centre either crosses the barrier or it does not. Marking
 * the edges a line *passes through* instead — the obvious implementation — gets
 * a road running along a cell boundary exactly backwards, blocking flux along
 * the road and leaving the flux across it open.
 *
 * Exported for `barriercheck`, which asserts exactly that property — it is the
 * one part of this provider that is easy to get silently wrong.
 */
export function blockSegment(
  blockFrac: Float32Array, cols: number, rows: number,
  a: { x: number; y: number }, b: { x: number; y: number }, frac: number
): number {
  // One cell of margin: a flux path reaches half a cell past its own centre.
  const c0 = Math.max(0, Math.floor(Math.min(a.x, b.x)) - 1)
  const c1 = Math.min(cols - 1, Math.floor(Math.max(a.x, b.x)) + 1)
  const r0 = Math.max(0, Math.floor(Math.min(a.y, b.y)) - 1)
  const r1 = Math.min(rows - 1, Math.floor(Math.max(a.y, b.y)) + 1)
  let marked = 0

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * cols + c
      for (let d = 0; d < 8; d++) {
        const [dc, dr] = NEIGHBOURS[d]
        const nc = c + dc
        const nr = r + dr
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
        if (!crosses(c + 0.5, r + 0.5, nc + 0.5, nr + 0.5, a.x, a.y, b.x, b.y)) continue
        const j = nr * cols + nc
        // Both directions: a barrier is not one-way, and the kernel reads the
        // edge from whichever side is burning.
        const opp = (d + 4) % 8
        if (frac > blockFrac[i * 8 + d]) { blockFrac[i * 8 + d] = frac; marked++ }
        if (frac > blockFrac[j * 8 + opp]) blockFrac[j * 8 + opp] = frac
      }
    }
  }
  return marked
}

/** Proper segment intersection by orientation sign; collinear touching does not count. */
function crosses(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number
): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px))
  return (
    o(ax, ay, bx, by, cx, cy) !== o(ax, ay, bx, by, dx, dy) &&
    o(cx, cy, dx, dy, ax, ay) !== o(cx, cy, dx, dy, bx, by)
  )
}

const head = (cfg: Config) => `[out:json][timeout:${Math.round(cfg.fetchTimeoutMs / 1000)}];`
const bbox = (b: TerrainQuery['grid']['bounds']) =>
  `${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)}`

/** One Overpass call per query, cached on disk. */
async function overpass(cfg: Config, query: string, signal?: AbortSignal) {
  const key = createHash('sha1').update(cfg.overpassUrl + query).digest('hex')
  const path = join(cfg.tileCacheDir, `osm-${key}.json`)
  try {
    return JSON.parse(await readFile(path, 'utf8')) as OverpassResponse
  } catch {
    // not cached
  }

  // 429 and 504 are how the public instance says "busy, come back": it runs a
  // slot queue, and a bbox that returns 650 kB in a second can 504 a minute
  // later. One retry converts most of those into a hit; past that, the caller's
  // fallback chain takes over and the chip says the barriers are mocked.
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), cfg.fetchTimeoutMs)
    const onAbort = () => ac.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await fetch(cfg.overpassUrl, {
        method: 'POST',
        // Overpass rate-limits by client and asks for an identifying agent.
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'firewatch-ai/0.1 (wildfire simulation)' },
        body: new URLSearchParams({ data: query }),
        signal: ac.signal,
      })
      if (res.status === 429 || res.status === 504) {
        res.body?.cancel()
        const after = Number.parseFloat(res.headers.get('retry-after') ?? '')
        const waitMs = Math.min(5000, Number.isFinite(after) ? after * 1000 : 1500)
        lastErr = new Error(`overpass ${res.status}`)
        if (attempt === 0) await new Promise((r) => setTimeout(r, waitMs))
        continue
      }
      if (!res.ok) throw new Error(`overpass ${res.status}`)
      const text = await res.text()
      const json = JSON.parse(text) as OverpassResponse
      await mkdir(cfg.tileCacheDir, { recursive: true })
      await writeFile(path, text)
      return json
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  throw lastErr ?? new Error('overpass unreachable')
}
