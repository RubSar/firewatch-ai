import { useEffect, useRef } from 'react'
import L from 'leaflet'
import type { Geometry } from 'geojson'
import { useBasemap, useLeafletMap, type Basemap } from './useLeafletMap.ts'

interface Props {
  event: { id: string; name: string; bounds: [number, number, number, number] }
  interval: { perimeter: Geometry; newly_burned: Geometry | null; kind?: string; source_label?: string }
  color: string; tiles: Basemap
  fitKey: number
}
export function HistoricalMap(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const map = useLeafletMap(host)
  const latest = useRef(props)
  const tileError = useBasemap(map, props.tiles)
  latest.current = props
  useEffect(() => {
    const bounds = L.geoJSON(props.interval.perimeter).getBounds()
    if (bounds.isValid()) map.current?.setView(bounds.getCenter(), map.current.getZoom() ?? 11, { animate: false })
  }, [props.event.id, props.interval])
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
    <div className="history-map firewatch-map" ref={host} aria-label={`${props.event.name} recorded fire extent map`} />
    <div className="history-map-caption">{props.interval.kind === 'perimeter_snapshot' ? `${props.interval.source_label} · perimeter snapshot` : 'GOFER · extent at interval end'}</div>
    {tileError && <div className="history-tile-warning">Basemap unavailable · fire geometry remains visible</div>}
  </div>
}
