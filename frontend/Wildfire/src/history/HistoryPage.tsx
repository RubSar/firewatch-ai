import { useEffect, useMemo, useState } from 'react'
import { HistoricalMap } from '@firewatch/visualization/historical-map'
import { SPECS, dateLabel, display, eventAvailability, hectares, measurement, sortByAvailability, value } from './model'
import type { FireEvent, Interval, Library, Measurement, Spec } from './model'
import './history.css'

function Evidence({ r, spec }: { r: Interval; spec: Spec }) {
  const m = measurement(r, spec)
  const v = value(r, spec)
  const code = v && typeof v === 'object' ? Object.keys(v).sort((a, b) => v[b] - v[a])[0] : null
  const hint = !m || v === null ? (m?.retrieval_status || m?.flags[m.flags.length - 1] || (r.kind === 'perimeter_snapshot' ? 'No perimeter context measurement' : 'No footprint measurement')).replace(/_/g, ' ')
    : spec.key === 'fuel' ? `FBFM40 ${code} · ${Math.round((v as Record<string, number>)[code!] * 100)}% of samples`
    : m.source.includes('HLS') ? `Image: ${m.time_window.acquired_at ? dateLabel(String(m.time_window.acquired_at)) + ' UTC' : 'date unavailable'}`
    : m.source.includes('3DEP') ? '3DEP · acquisition date unverified' : 'ERA5-Land · hourly reanalysis'
  return <small title={m ? `${m.source}\n${JSON.stringify(m.time_window)}\n${m.flags.join(', ')}` : hint}>{hint}</small>
}

function Metrics({ record }: { record: Interval }) {
  return <div className="history-metrics">{SPECS.map(spec => <div key={spec.key} className={`history-metric ${value(record, spec) === null ? 'missing' : ''}`}>
    <div className="history-metric-label">{spec.label}</div>
    <strong>{display(record, spec)}</strong><Evidence r={record} spec={spec} />
  </div>)}</div>
}

function Timeline({ event, index, onChange, side }: { event: FireEvent; index: number; onChange: (n: number) => void; side: string }) {
  if (event.intervals[index].kind === 'perimeter_snapshot') return <div className="history-timeline"><b>Perimeter snapshot · growth history unavailable</b><p>{dateLabel(event.intervals[index].end)} UTC</p></div>
  const max = Math.max(1, ...event.intervals.map(r => r.growth_ha ?? 0))
  return <div className="history-timeline">
    <div className="history-timeline-heading"><span>Recorded hourly growth</span><b>{index + 1} / {event.intervals.length}</b></div>
    <svg viewBox="0 0 720 42" preserveAspectRatio="none" aria-hidden="true">{event.intervals.map((r, i) => {
      const h = Math.max(1.5, Math.max(0, r.growth_ha ?? 0) / max * 40)
      return <rect key={r.id} x={i * 720 / event.intervals.length} y={42 - h} width={720 / event.intervals.length - 2} height={h} fill={i === index ? '#ffb56b' : '#52626a'} />
    })}</svg>
    <input aria-label={`${side} timestamp`} type="range" min="0" max={event.intervals.length - 1} step="1" value={index} onChange={e => onChange(Number(e.target.value))} />
    <div className="history-timeline-ends"><span>{dateLabel(event.intervals[0].end)}</span><span>{dateLabel(event.intervals[event.intervals.length - 1].end)} UTC</span></div>
  </div>
}

function RecordTime({ record }: { record: Interval }) {
  return <>{record.kind === 'perimeter_snapshot' ? 'Perimeter observed: ' : `${dateLabel(record.start)} → `}{dateLabel(record.end)}{record.end ? ' UTC' : ''}</>
}
function SnapshotNote({ record }: { record: Interval }) {
  if (record.kind !== 'perimeter_snapshot') return null
  return <div className="history-snapshot-note"><b>NIFC perimeter snapshot · context only</b><p>Parameters summarize the cumulative perimeter, not newly burned ground. Weather is sampled at the preceding whole hour. Growth is unknown.</p><details><summary>Incident identity, dates & quality</summary><pre>{JSON.stringify({ event_id: record.event_id, ...record.incident, flags: record.flags }, null, 2)}</pre></details></div>
}

function pretty(m?: Measurement) {
  if (!m || m.value === null) return 'Unavailable'
  if (typeof m.value === 'number') return `${Number(m.value.toFixed(3))} ${m.unit ?? ''}`
  if (typeof m.value === 'object') return JSON.stringify(m.value)
  return m.value
}
function AllMeasurements({ record }: { record: Interval }) {
  return <details className="history-evidence"><summary>Inspect all source measurements <span>{record.measurements.length} fields & sources · spatial context preserved</span></summary>
    <div className="history-table-scroll"><table><thead><tr><th>Measurement / spatial support</th><th>Value / evidence</th></tr></thead><tbody>{record.measurements.map((m, i) =>
      <tr key={`${m.field}|${m.source}|${m.support}|${i}`}><th>{m.field}<small>{m.source}<br />{m.support.replace(/_/g, ' ')}</small></th><td><div className="history-evidence-value">{pretty(m)}</div><details><summary>Source time & quality</summary><pre>{JSON.stringify({ time_window: m.time_window, flags: m.flags, review: m.review_status, retrieval: m.retrieval_status }, null, 2)}</pre></details></td></tr>
    )}</tbody></table></div>
  </details>
}

export default function HistoryPage() {
  const [library, setLibrary] = useState<Library | null>(null)
  const [error, setError] = useState('')
  const [eventId, setEventId] = useState('')
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [mapFocus, setMapFocus] = useState(false)
  const [tiles, setTiles] = useState<'satellite' | 'topo' | 'none'>('satellite')
  const [zoom, setZoom] = useState(11)
  const [fitKey, setFitKey] = useState(1)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`${import.meta.env.BASE_URL}data/historical-pilot.json`, { signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error(`Historical library unavailable (${r.status}). Run the preview data exporter.`)
      const data = await r.json() as Library
      if (!['1.0', '1.1'].includes(data.schema_version) || !data.events?.length || data.events.some(e => !e.intervals.length)) throw new Error('Unsupported or empty historical library.')
      setLibrary(data)
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [])
  const events = useMemo(() => sortByAvailability(library?.events ?? []), [library])
  const event = events.find(e => e.id === eventId) ?? events[0]
  const record = event?.intervals[index]
  const available = record ? SPECS.filter(s => value(record, s) !== null).length : 0
  useEffect(() => {
    if (!playing || !event || event.intervals.length < 2) return
    const timer = window.setInterval(() => {
      setIndex(i => { if (i >= event.intervals.length - 1) { setPlaying(false); return i } return i + 1 })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [playing, event])
  function changeIndex(n: number) { setIndex(n); setPlaying(false) }
  function download() {
    if (!record || !event) return
    const blob = new Blob([JSON.stringify({ interpretation: 'Historical observation; suppression effects are not separated. Not an unsuppressed simulation benchmark.', event: { id: event.id, name: event.name, year: event.year, region: event.region, source_sha256: event.source_sha256 }, record }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob), a = document.createElement('a')
    a.href = url; a.download = 'historical-fire-record.json'; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  if (!library || !event || !record) return <main className="history-page"><div className="history-loading"><span className="history-kicker">FIREWATCH / HISTORICAL ATLAS</span><h1>{error ? 'Library unavailable' : 'Loading the historical library…'}</h1><p>{error || 'Reading recorded perimeters and environmental measurements.'}</p><a href="/">Return to simulator</a></div></main>
  const completeness = eventAvailability(event)
  const snapshot = record.kind === 'perimeter_snapshot'
  return <main className={`history-page history-single ${mapFocus ? 'history-map-focused' : ''}`}>
    <header className="history-header"><a className="history-brand" href="/">◈ <b>FIREWATCH</b></a><span className="history-header-divider" /><span>Historical atlas</span><span className="history-header-spacer" /><span className="history-live-dot" /> Real historical records <a className="history-back" href="/">Open simulator ↗</a></header>
    <div className="history-body">
      <section className="history-title-row"><div><div className="history-kicker">OBSERVE · EXPLORE · UNDERSTAND</div><h1>One fire. Its recorded history.</h1><p>Explore a single event through its available timestamps and environmental measurements.</p></div><div className="history-library-count"><strong>{events.reduce((s, e) => s + e.intervals.length, 0)}</strong><span>loaded records<br />{events.length} fires · GOFER + NIFC</span></div></section>
      <section className="history-event-controls" aria-label="Event and playback controls">
        <div><label className="history-label" htmlFor="reference-fire">Historical event · most complete hours first</label>
          <select id="reference-fire" value={event.id} onChange={e => { setEventId(e.target.value); changeIndex(0); setFitKey(k => k + 1) }}>{events.map(e => {
            const stats = eventAvailability(e)
            return <option key={e.id} value={e.id}>{e.name} · {e.year} · {stats.records} {stats.records === 1 ? 'record' : 'records'} · {stats.snapshotsOnly ? `snapshot · ${Math.round(stats.coverage * 100)}% fields` : `${stats.completeHours} complete hours`}</option>
          })}</select>
        </div>
        <div><label className="history-label" htmlFor="reference-hour">Record timestamp (UTC)</label>
          <select id="reference-hour" value={index} onChange={e => changeIndex(Number(e.target.value))}>{event.intervals.map((r, i) => <option key={r.id} value={i}>{dateLabel(r.end)} · {r.kind === 'perimeter_snapshot' ? 'perimeter snapshot' : `+${hectares(r.growth_ha)} ha`}</option>)}</select>
        </div>
        <div className="history-play-controls"><button onClick={() => changeIndex(Math.max(0, index - 1))} disabled={index === 0} aria-label="Previous record">←</button><button disabled={snapshot || event.intervals.length < 2} onClick={() => { if (index === event.intervals.length - 1) setIndex(0); setPlaying(!playing) }}>{playing ? 'Ⅱ Pause' : '▷ Play history'}</button><button onClick={() => changeIndex(Math.min(event.intervals.length - 1, index + 1))} disabled={index === event.intervals.length - 1} aria-label="Next record">→</button></div>
        <button className="history-export" onClick={download}>Export record ↓</button>
      </section>
      <p className="history-availability-note"><b>{completeness.snapshotsOnly ? 'Snapshot only · no hourly progression' : `${completeness.completeHours} / ${completeness.records} complete hours`}</b><span>Complete = hourly progression + all 8 displayed parameters. Source review is still pending.</span></p>
      <div className="history-map-toolbar"><div className="history-legend"><span><i className="extent" /> Recorded extent</span>{!snapshot && <span><i className="growth" /> Newly burned this hour</span>}</div><span>Drag to pan · scroll to zoom</span><select aria-label="Basemap" value={tiles} onChange={e => setTiles(e.target.value as typeof tiles)}><option value="satellite">Satellite imagery</option><option value="topo">Topographic</option><option value="none">Geometry only</option></select><button onClick={() => setFitKey(k => k + 1)}>Fit extent</button><button aria-pressed={mapFocus} onClick={() => setMapFocus(v => !v)}>{mapFocus ? 'Show details' : 'Focus map'}</button></div>
      <section className="history-fire-card">
        <div className="history-card-heading"><div><span className="history-section-label">{snapshot ? 'PERIMETER SNAPSHOT' : 'RECORDED HOURLY PROGRESSION'}</span><h2>{event.name} Fire <span>{event.year}</span></h2></div><span className="history-location">{event.region}</span><span className="history-record-count">Record {index + 1} of {event.intervals.length}</span></div>
        <div className="history-timestamp"><RecordTime record={record} /></div>
        <SnapshotNote record={record} />
        <Metrics record={record} />
        <HistoricalMap event={event} interval={record} color="#f7b979" tiles={tiles} linked={false} zoom={zoom} onZoom={setZoom} fitKey={fitKey} />
        <div className="history-area-stats"><div><small>Recorded extent</small><b>{hectares(record.area_ha)} <em>ha</em></b></div><div><small>Growth during interval</small><b>{record.growth_ha === null ? 'Unavailable' : <>+{hectares(record.growth_ha)} <em>ha</em></>}</b></div><div><small>Parameters available</small><b>{available} / {SPECS.length}</b></div></div>
        <Timeline side="Event" event={event} index={index} onChange={changeIndex} />
      </section>
      <section className="history-method"><details><summary>About this record <span>Source coverage and interpretation</span></summary><p>Events are ordered by complete hourly record count, then average availability of the eight displayed parameters, then total record count. Snapshots cannot qualify as complete hours. Missing values are never counted as zero measurements.</p><p>Counts describe records loaded in this viewer, not the full archive. GOFER currently covers the first 72 available hours per pilot fire. NIFC records are dated perimeter snapshots; hourly growth is unknown.</p><p>GOFER parameters summarize newly burned ground. Zero-growth hours have no new footprint, so these measurements remain unavailable. NIFC parameters describe cumulative-perimeter context. All measurements remain pending review.</p><p>Historical boundaries include the effects of any suppression actions; those effects have not been separated. This viewer does not establish an unsuppressed simulator benchmark. Basemap imagery may come from a different date. Perimeters show recorded extent, not active flames.</p></details></section>
      <AllMeasurements record={record} />
      <footer className="history-footer">GOFER v0.2 · NIFC/WFIGS · ERA5-Land · LANDFIRE LF2016 · 3DEP · NASA enrichment <span>Single-event research preview</span></footer>
    </div>
  </main>
}
