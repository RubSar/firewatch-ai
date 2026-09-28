import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useBasemap, useLeafletMap } from '../visualization/useLeafletMap.ts'
import type { Sim } from '@firewatch/sim/model'
import type { Terrain } from '@firewatch/sim/terrain'
import { baseIsEmpty, paintGrid } from '../render/paint.ts'
import { paintThermal, thermalColour } from '../render/thermal.ts'
import { buildFireGeometry, makeBuffers, type FireGeometry, type GeometryBuffers } from '../render/fireGeometry.ts'
import type { Layers, Tool } from './ControlPanel.tsx'
import type { FireDetection, FiresDto } from '@firewatch/contracts/wire'

interface Props {
  terrain: Terrain
  simRef: React.MutableRefObject<Sim>
  layers: Layers
  tool: Tool
  onIgnite: (col: number, row: number) => void
  onTreat: (col: number, row: number, kind: number) => void
  /** Hands the parent's animation loop a draw callback. */
  registerDraw: (fn: () => void) => void
  /** Hands the parent a way to read where the user has panned to. */
  registerGetView?: (fn: () => { lat: number; lng: number; spanKm: number }) => void
  /** Base URL of the incident API. Required for the FIRMS layer. */
  apiUrl?: string
  /** Ambient air temperature in Celsius — the floor of the thermal scale. */
  ambientC: number
  /** Reports what the active-fire layer found, for the status line. */
  onFiresLoaded?: (s: { count: number; note: string; truncated: boolean; loading?: boolean } | null) => void
}

export function MapView(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mapRef = useLeafletMap(hostRef)
  useBasemap(mapRef, props.layers.base === 'tiles' ? props.layers.tileStyle : 'none')
  const gridRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<ImageData | null>(null)
  const thermalRef = useRef<{ canvas: HTMLCanvasElement; img: ImageData } | null>(null)
  const shadeRef = useRef<HTMLCanvasElement | null>(null)
  const domainRef = useRef<L.Rectangle | null>(null)
  const firesRef = useRef<L.LayerGroup | null>(null)
  const toCellRef = useRef<((ll: L.LatLng) => { col: number; row: number } | null) | null>(null)
  /** The draw callback, so the zoom handler can force a repaint. */
  const drawFnRef = useRef<(() => void) | null>(null)
  const geomRef = useRef<FireGeometry | null>(null)
  const bufRef = useRef<GeometryBuffers | null>(null)
  const lastPaint = useRef({ key: '' })
  const lastGeom = useRef({ time: -1, revision: -1, iso: false, at: 0 })
  const p = useRef(props)
  p.current = props

  // --- fit to the active scenario --------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const b = props.terrain.bounds
    const bounds = L.latLngBounds([b.south, b.west], [b.north, b.east])
    // No maxBounds and a world-level minZoom: the simulated square is one area
    // of interest on a global map, not the edge of the world. The user has to
    // be able to roam away from it to choose somewhere else.
    map.setMaxBounds(null as unknown as L.LatLngBounds)
    map.setMinZoom(2)
    map.setView(bounds.getCenter(), map.getBoundsZoom(bounds, true), { animate: false })

    // Outline the simulated area so it stays findable once the user pans off it.
    domainRef.current?.remove()
    domainRef.current = L.rectangle(bounds, {
      color: '#ffb347',
      weight: 1.5,
      dashArray: '6 5',
      fill: false,
      interactive: false,
    }).addTo(map)
    // Grid-resolution scratch canvas: one pixel per simulation cell.
    const g = document.createElement('canvas')
    g.width = props.terrain.cols
    g.height = props.terrain.rows
    gridRef.current = g
    const gctx = g.getContext('2d')!
    const { cols, rows, shade } = props.terrain
    imgRef.current = gctx.createImageData(cols, rows)
    // Separate grid-resolution canvas for the infrared raster, so toggling the
    // view never disturbs the cached base raster.
    const tc = document.createElement('canvas')
    tc.width = cols
    tc.height = rows
    thermalRef.current = { canvas: tc, img: tc.getContext('2d')!.createImageData(cols, rows) }
    bufRef.current = makeBuffers(cols * rows)
    geomRef.current = null
    lastGeom.current = { time: -1, revision: -1, iso: false, at: 0 }
    lastPaint.current = { key: '' }

    // Greyscale hillshade, built once, used to give the burn scar the texture of
    // the ground it burnt over.
    const sc = document.createElement('canvas')
    sc.width = cols
    sc.height = rows
    const sctx = sc.getContext('2d')!
    const simg = sctx.createImageData(cols, rows)
    for (let i = 0; i < cols * rows; i++) {
      const v = 40 + 190 * shade[i]
      simg.data[i * 4] = v
      simg.data[i * 4 + 1] = v
      simg.data[i * 4 + 2] = v
      simg.data[i * 4 + 3] = 255
    }
    sctx.putImageData(simg, 0, 0)
    shadeRef.current = sc
  }, [props.terrain])

  // --- let the parent read the current view, for "simulate this view" ----
  useEffect(() => {
    p.current.registerGetView?.(() => {
      const map = mapRef.current
      if (!map) {
        const b = p.current.terrain.bounds
        return { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2, spanKm: 15 }
      }
      const c = map.getCenter()
      const vb = map.getBounds()
      // Square domain from the shorter screen axis, so what is asked for is
      // always fully visible rather than cropped by the viewport's aspect.
      const widthKm =
        ((vb.getEast() - vb.getWest()) * 111.32 * Math.cos((c.lat * Math.PI) / 180))
      const heightKm = (vb.getNorth() - vb.getSouth()) * 110.54
      return { lat: c.lat, lng: c.lng, spanKm: Math.min(widthKm, heightKm) }
    })
  }, [])

  // --- keep the fire canvas in step with Leaflet's zoom animation -------
  //
  // The canvas is positioned over the map rather than inside Leaflet's
  // transformed panes, and it is drawn from latLngToContainerPoint. During an
  // animated zoom that helper still reports the PRE-animation geometry, so the
  // tiles glide to the new zoom while the fire sits still and then snaps at
  // zoomend — which is exactly the jerk you see.
  //
  // The fix is the same one Leaflet uses for its own canvas renderer: mirror
  // the animation with a CSS transform for its duration, then drop the
  // transform at zoomend and let the next frame redraw at the true geometry.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const onZoomAnim = (e: L.ZoomAnimEvent) => {
      const cv = canvasRef.current
      if (!cv) return
      const scale = map.getZoomScale(e.zoom, map.getZoom())
      // Where the incoming centre sits right now; after the zoom it must land
      // in the middle of the viewport. Solve s·p + t = centre for t.
      const p0 = map.latLngToContainerPoint(e.center)
      const size = map.getSize()
      cv.style.transformOrigin = '0 0'
      // Matches Leaflet's own zoom animation so the two move together; a
      // different easing is more obvious than no animation at all.
      cv.style.transition = 'transform 250ms cubic-bezier(0, 0, 0.25, 1)'
      cv.style.transform =
        `translate(${size.x / 2 - scale * p0.x}px, ${size.y / 2 - scale * p0.y}px) scale(${scale})`
    }

    const clearTransform = () => {
      const cv = canvasRef.current
      if (!cv) return
      cv.style.transition = ''
      cv.style.transform = ''
      cv.style.transformOrigin = ''
      // Redraw immediately at the true geometry rather than waiting a frame,
      // so there is no flash of untransformed canvas.
      drawFnRef.current?.()
    }

    map.on('zoomanim', onZoomAnim)
    map.on('zoomend', clearTransform)
    map.on('viewreset', clearTransform)
    return () => {
      map.off('zoomanim', onZoomAnim)
      map.off('zoomend', clearTransform)
      map.off('viewreset', clearTransform)
    }
  }, [])

  // --- map interaction --------------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const { tool } = props
    if (tool === 'pan') map.dragging.enable()
    else map.dragging.disable()

    const toCell = (ll: L.LatLng) => {
      const { bounds, cols, rows } = p.current.terrain
      const col = Math.floor(((ll.lng - bounds.west) / (bounds.east - bounds.west)) * cols)
      const row = Math.floor(((bounds.north - ll.lat) / (bounds.north - bounds.south)) * rows)
      if (col < 0 || row < 0 || col >= cols || row >= rows) return null
      return { col, row }
    }

    toCellRef.current = toCell
    let painting = false
    let last: { col: number; row: number } | null = null

    const stamp = (col: number, row: number) => {
      if (tool === 'ignite') p.current.onIgnite(col, row)
      else if (tool === 'dozer') p.current.onTreat(col, row, 1)
      else if (tool === 'retardant') p.current.onTreat(col, row, 2)
    }

    /**
     * Stamp every cell between the last point and this one. Without this a
     * quick drag leaves gaps, and a control line with gaps holds nothing.
     */
    const apply = (ll: L.LatLng) => {
      const cell = toCell(ll)
      if (!cell) return
      if (last) {
        const dc = cell.col - last.col
        const dr = cell.row - last.row
        const n = Math.max(Math.abs(dc), Math.abs(dr))
        for (let k = 1; k < n; k++) {
          stamp(Math.round(last.col + (dc * k) / n), Math.round(last.row + (dr * k) / n))
        }
      }
      stamp(cell.col, cell.row)
      last = cell
    }

    const onDown = (e: L.LeafletMouseEvent) => {
      if (tool === 'pan') return
      painting = true
      last = null
      apply(e.latlng)
    }
    const onMove = (e: L.LeafletMouseEvent) => {
      if (!painting || tool === 'ignite') return
      apply(e.latlng)
    }
    const onUp = () => {
      painting = false
      last = null
    }

    map.on('mousedown', onDown)
    map.on('mousemove', onMove)
    map.on('mouseup', onUp)
    window.addEventListener('pointerup', onUp)
    return () => {
      map.off('mousedown', onDown)
      map.off('mousemove', onMove)
      map.off('mouseup', onUp)
      window.removeEventListener('pointerup', onUp)
    }
  }, [props.tool])

  // --- NASA FIRMS active fire detections ---------------------------------
  // Fetched for whatever is on screen and refreshed on pan, because the point
  // of the layer is to find real fires, which means roaming the map.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (!props.layers.activeFires || !props.apiUrl) {
      firesRef.current?.remove()
      firesRef.current = null
      p.current.onFiresLoaded?.(null)
      return
    }

    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ac = new AbortController()

    const load = async () => {
      // The first request pulls a 6 MB global file and can take ~15 s. Say so
      // immediately rather than leaving the map silent and looking broken.
      p.current.onFiresLoaded?.({ count: 0, note: 'Loading NASA FIRMS detections…', truncated: false, loading: true })
      const b = map.getBounds()
      const q = new URLSearchParams({
        north: String(Math.min(85, b.getNorth())),
        south: String(Math.max(-85, b.getSouth())),
        east: String(Math.min(180, b.getEast())),
        west: String(Math.max(-180, b.getWest())),
      })
      try {
        const res = await fetch(`${p.current.apiUrl}/api/fires?${q}`, { signal: ac.signal })
        if (!res.ok) throw new Error(`${res.status}`)
        const dto = (await res.json()) as FiresDto
        if (disposed) return
        draw(dto.detections)
        p.current.onFiresLoaded?.({
          count: dto.detections.length,
          note: dto.provenance.note,
          truncated: dto.truncated,
        })
      } catch (err) {
        if (!disposed && (err as Error).name !== 'AbortError') {
          p.current.onFiresLoaded?.({ count: 0, note: `Fire detections unavailable: ${(err as Error).message}`, truncated: false })
        }
      }
    }

    const draw = (detections: FireDetection[]) => {
      firesRef.current?.remove()
      const group = L.layerGroup()
      for (const d of detections) {
        // Radius by fire radiative power, the closest proxy for "how big".
        // sqrt so a 400 MW detection reads as bigger than a 4 MW one without
        // swamping the map.
        const r = Math.max(3, Math.min(14, 3 + Math.sqrt(d.frp) * 0.7))
        const hot = Math.min(1, d.frp / 120)
        // In infrared, colour the detection by its own measured brightness
        // temperature on the same scale as the model — that comparison is the
        // whole point of having both on one map.
        const ir = p.current.layers.thermal
        const fill = ir
          ? thermalColour((d.brightness - (p.current.ambientC + 273.15)) / 1050)
          : hot > 0.6 ? '#ffe8a3' : hot > 0.25 ? '#ff8c25' : '#e0452a'
        L.circleMarker([d.lat, d.lng], {
          radius: r,
          color: ir ? '#cfe4ff' : '#ffd7a1',
          weight: 1,
          opacity: 0.55 + 0.35 * d.confidence,
          fillColor: fill,
          fillOpacity: 0.35 + 0.45 * d.confidence,
        })
          .bindTooltip(
            `<b>${d.frp.toFixed(1)} MW</b> · ${d.satellite} ${d.day ? 'day' : 'night'}<br/>` +
              `${new Date(d.at).toUTCString().replace('GMT', 'UTC')}<br/>` +
              `confidence ${(d.confidence * 100).toFixed(0)}% · ${d.brightness.toFixed(0)} K ` +
              `(${(d.brightness - 273.15).toFixed(0)} °C measured)<br/>` +
              `<i>click to ignite here</i>`,
            { direction: 'top', opacity: 0.95 }
          )
          .on('click', () => {
            const cell = toCellRef.current?.(L.latLng(d.lat, d.lng))
            if (cell) p.current.onIgnite(cell.col, cell.row)
          })
          .addTo(group)
      }
      group.addTo(map)
      firesRef.current = group
    }

    const debounced = () => {
      clearTimeout(timer)
      timer = setTimeout(load, 500)
    }
    void load()
    map.on('moveend', debounced)
    return () => {
      disposed = true
      ac.abort()
      clearTimeout(timer)
      map.off('moveend', debounced)
      firesRef.current?.remove()
      firesRef.current = null
    }
  }, [props.layers.activeFires, props.layers.thermal, props.apiUrl, props.terrain])

  // --- render loop hook --------------------------------------------------
  useEffect(() => {
    const draw = () => {
      const map = mapRef.current
      const cv = canvasRef.current
      const grid = gridRef.current
      const img = imgRef.current
      const buf = bufRef.current
      if (!map || !cv || !grid || !img || !buf) return
      const { terrain, simRef, layers } = p.current
      const sim = simRef.current
      const { cols, rows } = terrain

      const size = map.getSize()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      if (cv.width !== Math.round(size.x * dpr) || cv.height !== Math.round(size.y * dpr)) {
        cv.width = Math.round(size.x * dpr)
        cv.height = Math.round(size.y * dpr)
        cv.style.width = `${size.x}px`
        cv.style.height = `${size.y}px`
      }
      const ctx = cv.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size.x, size.y)

      const paintOpts = {
        base: layers.base,
        fuelOverlay: layers.fuelOverlay,
        contours: layers.contours,
      }
      const needRaster = !baseIsEmpty(paintOpts)

      // The base raster only changes when the layer settings do.
      const key = `${layers.base}|${layers.fuelOverlay}|${layers.contours}`
      if (needRaster && lastPaint.current.key !== key) {
        paintGrid(img, sim, paintOpts)
        grid.getContext('2d')!.putImageData(img, 0, 0)
        lastPaint.current = { key }
      }

      // Rebuild the fire outlines at 20 Hz. Tracing contours costs far more
      // than filling them, and the perimeter does not visibly move in 50 ms —
      // meanwhile pan and zoom still redraw at full frame rate, because the
      // paths live in grid space and only the transform changes.
      const lg = lastGeom.current
      const now = performance.now()
      const changed = lg.time !== sim.time || lg.revision !== sim.revision || lg.iso !== layers.isochrones
      if (changed && now - lg.at > 50) {
        geomRef.current = buildFireGeometry(sim, buf, { isochrones: layers.isochrones })
        lastGeom.current = { time: sim.time, revision: sim.revision, iso: layers.isochrones, at: now }
      }

      const b = terrain.bounds
      const nw = map.latLngToContainerPoint([b.north, b.west])
      const se = map.latLngToContainerPoint([b.south, b.east])
      const w = se.x - nw.x
      const h = se.y - nw.y

      if (needRaster) {
        ctx.imageSmoothingEnabled = layers.base === 'tiles'
        ctx.imageSmoothingQuality = 'medium'
        ctx.drawImage(grid, nw.x, nw.y, w, h)
      }

      // --- infrared view -------------------------------------------------
      // Rebuilt on the same throttle as the contours, then drawn every frame,
      // so panning stays at full rate. Replaces the fire's own colouring
      // entirely rather than tinting it: a thermal image is a measurement,
      // and blending it with stylised flame colours would make it a decoration.
      if (layers.thermal) {
        const th = thermalRef.current
        if (th) {
          if (changed && now - lg.at > 50) {
            paintThermal(th.img, sim, { ambientC: p.current.ambientC })
            th.canvas.getContext('2d')!.putImageData(th.img, 0, 0)
          }
          ctx.imageSmoothingEnabled = true
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(th.canvas, nw.x, nw.y, w, h)
        }
      }

      const geom = geomRef.current
      if (!geom) return
      // In infrared the temperature raster IS the fire; the scar and flame
      // bands would only double-draw it. Control lines still matter, though —
      // a dozer line is a real feature of the incident, not a fire colour.
      const irOnly = layers.thermal

      // Everything below is drawn in grid coordinates; the transform maps them
      // onto the map, so the paths stay smooth however far the user zooms in.
      ctx.save()
      ctx.translate(nw.x, nw.y)
      ctx.scale(w / cols, h / rows)

      if (!irOnly && geom.isochrones.length) {
        for (const band of geom.isochrones) {
          ctx.fillStyle = band.fill
          ctx.fill(band.path)
        }
      } else if (!irOnly && geom.scar) {
        ctx.fillStyle = 'rgba(28, 24, 22, 0.88)'
        ctx.fill(geom.scar)
        // Hillshade inside the scar, so burnt ground keeps the shape of the
        // terrain instead of reading as a flat grey blob.
        if (shadeRef.current) {
          ctx.save()
          ctx.clip(geom.scar)
          ctx.globalCompositeOperation = 'overlay'
          ctx.globalAlpha = 0.55
          ctx.imageSmoothingEnabled = true
          ctx.drawImage(shadeRef.current, 0, 0, cols, rows)
          ctx.restore()
        }
      }

      if (geom.retardant) {
        // The rust red of dried Phos-Chek. It reads apart from the fire not by
        // hue — both are red — but by being matte and darker where the flame is
        // saturated and glowing.
        // Not stroked: the path is a union of per-cell discs, so an outline
        // would trace every internal circle and read as hatching.
        ctx.fillStyle = 'rgba(178, 69, 58, 0.92)'
        ctx.fill(geom.retardant)
      }
      if (geom.dozer) {
        ctx.fillStyle = '#c4aa7e'
        ctx.fill(geom.dozer)
      }

      if (!irOnly && geom.flames.length) {
        ctx.save()
        // Glow, in grid units so it scales with the map.
        ctx.shadowColor = 'rgba(255, 120, 30, 0.75)'
        ctx.shadowBlur = Math.max(2, (w / cols) * 1.6)
        for (const band of geom.flames) {
          ctx.fillStyle = band.fill
          ctx.fill(band.path)
        }
        ctx.restore()
      }

      ctx.restore()
    }
    drawFnRef.current = draw
    p.current.registerDraw(draw)
  }, [])

  return (
    <>
      <div ref={hostRef} className="firewatch-map" style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={canvasRef} className="fire-canvas" />
    </>
  )
}
