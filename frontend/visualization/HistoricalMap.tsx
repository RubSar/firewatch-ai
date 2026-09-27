import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import type { Geometry } from 'geojson'

interface Props {
  event: { id: string; name: string; bounds: [number, number, number, number] }
  interval: { perimeter: Geometry; newly_burned: Geometry | null; kind?: string; source_label?: string }
  color: string; tiles: 'satellite' | 'topo' | 'none'
  zoom: number; linked: boolean; onZoom: (zoom: number) => void; fitKey: number
}
export function HistoricalMap(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const latest = useRef(props)
  const [tileError, setTileError] = useState(false)
  latest.current = props
  useEffect(() => {
    const m = L.map(host.current!, { zoomControl: false, zoomSnap: 0.25, minZoom: 4, maxZoom: 18 })
    map.current = m
    m.attributionControl.setPrefix(false)
    L.control.zoom({ position: 'topright' }).addTo(m)
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(m)
    m.on('zoomend', () => { if (latest.current.linked) latest.current.onZoom(m.getZoom()) })
    const observer = new ResizeObserver(() => m.invalidateSize({ pan: false }))
    observer.observe(host.current!)
    return () => { observer.disconnect(); m.remove(); map.current = null }
  }, [])
  useEffect(() => {
    const bounds = L.geoJSON(props.interval.perimeter).getBounds()
    if (bounds.isValid()) map.current?.setView(bounds.getCenter(), map.current.getZoom() ?? latest.current.zoom, { animate: false })
  }, [props.event.id, props.interval])
  useEffect(() => {
    if (props.linked && map.current?.getZoom() !== props.zoom) map.current?.setZoom(props.zoom, { animate: false })
  }, [props.zoom, props.linked])
  useEffect(() => {
    setTileError(false)
    if (props.tiles === 'none') return
    const satellite = props.tiles === 'satellite'
    const layer = L.tileLayer(satellite
      ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
      : 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: satellite ? 18 : 17,
      attribution: satellite ? 'Imagery © Esri, Maxar, Earthstar Geographics' : '© OpenStreetMap, SRTM · © OpenTopoMap',
    }).addTo(map.current!)
    layer.on('tileerror', () => setTileError(true))
    return () => { layer.remove() }
  }, [props.tiles])
  useEffect(() => {
    const layers = L.layerGroup().addTo(map.current!)
    L.geoJSON(props.interval.perimeter, { style: { color: props.color, weight: 2, fillColor: props.color, fillOpacity: 0.15 } }).addTo(layers)
    if (props.interval.newly_burned) L.geoJSON(props.interval.newly_burned, {
      style: { color: '#ffbd70', weight: 1, fillColor: '#ff851b', fillOpacity: 0.8 },
    }).addTo(layers)
    return () => { layers.remove() }
  }, [props.interval, props.color])
  useEffect(() => {
    if (!props.fitKey) return
    const bounds = L.geoJSON(latest.current.interval.perimeter).getBounds()
    if (bounds.isValid()) map.current?.fitBounds(bounds, { padding: [30, 30], animate: false, maxZoom: 14 })
  }, [props.fitKey])
  return <div className="history-map-wrap">
    <div className="history-map" ref={host} aria-label={`${props.event.name} recorded fire extent map`} />
    <div className="history-map-caption">{props.interval.kind === 'perimeter_snapshot' ? `${props.interval.source_label} · perimeter snapshot` : 'GOFER · extent at interval end'}</div>
    {tileError && <div className="history-tile-warning">Basemap unavailable · fire geometry remains visible</div>}
  </div>
}
