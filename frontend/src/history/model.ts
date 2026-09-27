import type { Geometry } from 'geojson'

export interface Measurement {
  field: string; value: number | string | Record<string, unknown> | null; unit: string | null
  source: string; support: string; kind: string; time_window: Record<string, unknown>
  flags: string[]; review_status: string; retrieval_status: string | null
}
export interface Interval {
  id: string; event_id: string; start: string | null; end: string | null; area_ha: number | null; growth_ha: number | null
  kind?: 'perimeter_snapshot'; source_label?: string; incident?: Record<string, unknown>
  perimeter: Geometry; newly_burned: Geometry | null; measurements: Measurement[]; flags: string[]
}
export interface FireEvent {
  id: string; name: string; year: number; region: string
  bounds: [number, number, number, number]; intervals: Interval[]; source_sha256: string
}
export interface Library {
  schema_version: string; geometry_simplification_m: number; archive_sha256: string; events: FireEvent[]
}
export function eventAvailability(event: FireEvent) {
  const counts = event.intervals.map(r => SPECS.filter(s => value(r, s) !== null).length)
  const completeHours = event.intervals.filter((r, i) => r.kind !== 'perimeter_snapshot'
    && r.start !== null && r.end !== null
    && Date.parse(r.end) - Date.parse(r.start) === 3600000
    && r.area_ha !== null && r.growth_ha !== null && counts[i] === SPECS.length).length
  return { completeHours, records: event.intervals.length,
    coverage: counts.reduce((sum, n) => sum + n, 0) / Math.max(1, counts.length * SPECS.length),
    snapshotsOnly: event.intervals.every(r => r.kind === 'perimeter_snapshot') }
}
export function sortByAvailability(events: FireEvent[]) {
  const stats = new Map(events.map(e => [e.id, eventAvailability(e)]))
  return [...events].sort((a, b) => {
    const x = stats.get(a.id)!, y = stats.get(b.id)!
    return y.completeHours - x.completeHours || y.coverage - x.coverage
      || y.records - x.records || a.name.localeCompare(b.name) || b.year - a.year || a.id.localeCompare(b.id)
  })
}
export const GROUPS = ['Vegetation', 'Fuels', 'Terrain', 'Wind', 'Weather'] as const
export type Group = typeof GROUPS[number]
export const SPECS = [
  { key: 'ndvi', label: 'NDVI', group: 'Vegetation', field: 'ndvi', source: 'NASA/HLS/', span: 2, unit: '', digits: 2 },
  { key: 'ndmi', label: 'NDMI', group: 'Vegetation', field: 'ndmi', source: 'NASA/HLS/', span: 2, unit: '', digits: 2 },
  { key: 'nbr', label: 'NBR', group: 'Vegetation', field: 'nbr', source: 'NASA/HLS/', span: 2, unit: '', digits: 2 },
  { key: 'fuel', label: 'Fuel', group: 'Fuels', field: 'fuel_model_40', source: 'LANDFIRE', span: 1, unit: '', digits: 0 },
  { key: 'slope', label: 'Slope', group: 'Terrain', field: 'slope_deg', source: 'USGS/3DEP/', span: 90, unit: '°', digits: 1 },
  { key: 'wind', label: 'Wind', group: 'Wind', field: 'wind_speed_m_s', source: 'ECMWF/', span: 100, unit: ' km/h', digits: 1 },
  { key: 'temp', label: 'Temperature', group: 'Weather', field: 'temperature_c', source: 'ECMWF/', span: 60, unit: '°C', digits: 1 },
  { key: 'rh', label: 'Humidity', group: 'Weather', field: 'relative_humidity_pct', source: 'ECMWF/', span: 100, unit: '%', digits: 1 },
] as const
export type Spec = typeof SPECS[number]
export function measurement(r: Interval, spec: Spec) {
  const support = r.kind === 'perimeter_snapshot' ? 'cumulative_perimeter_context' : 'newly_burned'
  return r.measurements.find(m => m.field === spec.field && m.source.startsWith(spec.source) && m.support === support)
}
export function value(r: Interval, spec: Spec): number | Record<string, number> | null {
  const m = measurement(r, spec)
  if (m?.value == null) return null
  if (spec.key === 'fuel') {
    const proportions = (m.value as Record<string, unknown>).class_sample_proportions
    if (!proportions || typeof proportions !== 'object') return null
    const entries = Object.entries(proportions).filter(([, p]) => typeof p === 'number' && Number.isFinite(p) && p >= 0)
    const sum = entries.reduce((s, [, p]) => s + (p as number), 0)
    return sum > 0 ? Object.fromEntries(entries.map(([k, p]) => [k, (p as number) / sum])) : null
  }
  return typeof m.value === 'number' && Number.isFinite(m.value)
    ? m.value * (spec.key === 'wind' ? 3.6 : 1) : null
}
export function fuelLabel(code: string) {
  const n = Number(code)
  if (n >= 101 && n <= 109) return 'Grass'
  if (n >= 121 && n <= 124) return 'Grass / shrub'
  if (n >= 141 && n <= 149) return 'Shrub'
  if (n >= 161 && n <= 165) return 'Timber understory'
  if (n >= 181 && n <= 189) return 'Timber litter'
  if (n >= 201 && n <= 204) return 'Slash / blowdown'
  return `Class ${code}`
}
export function display(r: Interval, spec: Spec) {
  const v = value(r, spec)
  if (v === null) return 'Unavailable'
  if (typeof v === 'number') return `${v.toFixed(spec.digits)}${spec.unit}`
  const code = Object.keys(v).sort((a, b) => v[b] - v[a] || a.localeCompare(b))[0]
  return fuelLabel(code)
}
export function difference(a: Interval, b: Interval, spec: Spec): number | null {
  // Snapshot context is not a measured growth situation, even with complete fields.
  if (a.kind === 'perimeter_snapshot' || b.kind === 'perimeter_snapshot') return null
  const x = value(a, spec), y = value(b, spec)
  if (x === null || y === null) return null
  if (typeof x === 'number' && typeof y === 'number') return Math.min(1, Math.abs(x - y) / spec.span)
  if (typeof x === 'object' && typeof y === 'object') {
    return Math.min(1, [...new Set([...Object.keys(x), ...Object.keys(y)])]
      .reduce((total, key) => total + Math.abs((x[key] ?? 0) - (y[key] ?? 0)), 0) / 2)
  }
  return null
}
export function compare(a: Interval, b: Interval, groups: readonly Group[]) {
  const fields = SPECS.filter(s => groups.includes(s.group))
  const missing = fields.filter(s => difference(a, b, s) === null).map(s => s.label)
  const byGroup = groups.map(group => {
    const ds = fields.filter(s => s.group === group).map(s => difference(a, b, s))
    return { group, distance: ds.some(d => d === null) ? null : ds.reduce<number>((sum, d) => sum + (d ?? 0), 0) / ds.length }
  })
  const eligible = groups.length >= 3 && !missing.length && a.event_id !== b.event_id
  return { percentage: eligible ? 100 * byGroup.reduce((s, g) => s + g.distance!, 0) / groups.length : null,
    compared: fields.length - missing.length, total: fields.length, missing, byGroup }
}
export function rank(a: Interval, events: FireEvent[], groups: readonly Group[]) {
  return events.filter(e => e.id !== a.event_id).map(event => {
    const candidates = event.intervals.map(interval => ({ interval, score: compare(a, interval, groups) }))
      .filter(c => c.score.percentage !== null)
      .sort((a, b) => a.score.percentage! - b.score.percentage! || a.interval.id.localeCompare(b.interval.id))
    return { event, best: candidates[0] ?? null, eligible: candidates.length }
  }).sort((a, b) => (a.best?.score.percentage ?? Infinity) - (b.best?.score.percentage ?? Infinity) || a.event.id.localeCompare(b.event.id))
}
export const hectares = (x: number | null) => x === null ? 'Unavailable' : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(x)
export const dateLabel = (x: string | null) => x === null ? 'Observation time unavailable' : new Date(x).toLocaleString('en-GB', { timeZone: 'UTC', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
