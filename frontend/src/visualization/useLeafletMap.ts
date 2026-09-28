import { useEffect, useRef, useState, type RefObject } from 'react'
import L from 'leaflet'

export type Basemap = 'satellite' | 'topo' | 'none'

const TILES = {
  topo: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
    maxNativeZoom: 17,
  },
  satellite: {
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg',
    attribution:
      'Sentinel-2 cloudless 2020 &copy; <a href="https://s2maps.eu">EOX IT Services</a> (CC-BY-4.0), ' +
      'contains modified Copernicus Sentinel data',
    maxNativeZoom: 16,
  },
}

/** Shared map shell; each page owns its viewport and domain-specific layers. */
export function useLeafletMap(host: RefObject<HTMLDivElement>) {
  const mapRef = useRef<L.Map | null>(null)
  useEffect(() => {
    const map = L.map(host.current!, {
      zoomControl: false,
      attributionControl: true,
      zoomSnap: 0.25,
      wheelPxPerZoomLevel: 140,
      minZoom: 2,
      maxZoom: 18,
    })
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    L.control.scale({ position: 'bottomright', imperial: true }).addTo(map)
    mapRef.current = map
    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }))
    observer.observe(host.current!)
    return () => {
      observer.disconnect()
      map.remove()
      mapRef.current = null
    }
  }, [host])
  return mapRef
}

/** Retain source attribution and upscale native tiles when inspecting fine geometry. */
export function useBasemap(mapRef: RefObject<L.Map | null>, basemap: Basemap) {
  const [tileError, setTileError] = useState(false)
  useEffect(() => {
    setTileError(false)
    const map = mapRef.current
    if (!map || basemap === 'none') return
    const cfg = TILES[basemap]
    const layer = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      maxNativeZoom: cfg.maxNativeZoom,
      maxZoom: 18,
      crossOrigin: true,
    })
    const onError = () => setTileError(true)
    layer.on('tileerror', onError)
    layer.addTo(map)
    return () => {
      layer.off('tileerror', onError)
      layer.remove()
    }
  }, [mapRef, basemap])
  return tileError
}
