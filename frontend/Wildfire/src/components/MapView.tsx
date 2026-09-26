import { useEffect, useRef } from 'react'
import L from 'leaflet'
import type { Sim } from '../sim/model.ts'
import type { Terrain } from '../sim/terrain.ts'
import { baseIsEmpty, paintGrid } from '../render/paint.ts'
import { buildFireGeometry, makeBuffers, type FireGeometry, type GeometryBuffers } from '../render/fireGeometry.ts'
import type { Layers, Tool } from './ControlPanel.tsx'

interface Props {
  terrain: Terrain
  simRef: React.MutableRefObject<Sim>
  layers: Layers
  tool: Tool
  onIgnite: (col: number, row: number) => void
  onTreat: (col: number, row: number, kind: number) => void
  /** Hands the parent's animation loop a draw callback. */
  registerDraw: (fn: () => void) => void
}

const TILES = {
  topo: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
    maxZoom: 17,
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 18,
  },
}

export function MapView(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileRef = useRef<L.TileLayer | null>(null)
  const gridRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<ImageData | null>(null)
  const shadeRef = useRef<HTMLCanvasElement | null>(null)
  const geomRef = useRef<FireGeometry | null>(null)
  const bufRef = useRef<GeometryBuffers | null>(null)
  const lastPaint = useRef({ key: '' })
  const lastGeom = useRef({ time: -1, revision: -1, iso: false, at: 0 })
  const p = useRef(props)
  p.current = props

  // --- map creation ---------------------------------------------------
  useEffect(() => {
    const map = L.map(hostRef.current!, {
      zoomControl: false,
      attributionControl: true,
      zoomSnap: 0.25,
      wheelPxPerZoomLevel: 140,
    })
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    L.control.scale({ position: 'bottomright', imperial: true }).addTo(map)
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // --- fit to the active scenario --------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const b = props.terrain.bounds
    const bounds = L.latLngBounds([b.south, b.west], [b.north, b.east])
    // Cover, not contain: the simulated area should fill the viewport rather
    // than sit letterboxed in a black void.
    // ...but still let the user pull back far enough to see the whole domain.
    const cover = () => map.setMinZoom(map.getBoundsZoom(bounds, false) - 0.5)
    // Drop the previous scenario's constraints first: a stale maxBounds would
    // clamp the new centre before it is ever applied.
    map.setMinZoom(0)
    map.setMaxBounds(null as unknown as L.LatLngBounds)
    map.setView(bounds.getCenter(), map.getBoundsZoom(bounds, true), { animate: false })
    map.setMaxBounds(bounds.pad(0.25))
    cover()
    map.on('resize', cover)
    // Grid-resolution scratch canvas: one pixel per simulation cell.
    const g = document.createElement('canvas')
    g.width = props.terrain.cols
    g.height = props.terrain.rows
    gridRef.current = g
    const gctx = g.getContext('2d')!
    const { cols, rows, shade } = props.terrain
    imgRef.current = gctx.createImageData(cols, rows)
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
    return () => {
      map.off('resize', cover)
    }
  }, [props.terrain])

  // --- basemap tiles ----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    tileRef.current?.remove()
    tileRef.current = null
    if (props.layers.base === 'tiles') {
      const cfg = TILES[props.layers.tileStyle]
      tileRef.current = L.tileLayer(cfg.url, {
        attribution: cfg.attribution,
        maxZoom: cfg.maxZoom,
        crossOrigin: true,
      }).addTo(map)
    }
  }, [props.layers.base, props.layers.tileStyle])

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

      const geom = geomRef.current
      if (!geom) return

      // Everything below is drawn in grid coordinates; the transform maps them
      // onto the map, so the paths stay smooth however far the user zooms in.
      ctx.save()
      ctx.translate(nw.x, nw.y)
      ctx.scale(w / cols, h / rows)

      if (geom.isochrones.length) {
        for (const band of geom.isochrones) {
          ctx.fillStyle = band.fill
          ctx.fill(band.path)
        }
      } else if (geom.scar) {
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

      if (geom.flames.length) {
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
    p.current.registerDraw(draw)
  }, [])

  return (
    <>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={canvasRef} className="fire-canvas" />
    </>
  )
}
