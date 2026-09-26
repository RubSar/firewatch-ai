import L from "leaflet";
import {
  escapeHtml,
  scoreColor,
  statusLabel,
} from "../src/api/investigation.js";
import "leaflet/dist/leaflet.css";
import { IMAGERY } from "./analysis.js";
import { polygon } from "@turf/turf";
export const COLORS = {
  green: "#7ccba1",
  tan: "#eab875",
  dark: "#888da6",
  other: "#d8ded9",
};
export class LandscapeMap {
  constructor(el, onSelection) {
    this.el = el;
    this.onSelection = onSelection;
    this.map = L.map(el, {
      zoomControl: false,
      attributionControl: true,
    }).setView([37.76, -119.72], 13);
    this.satellite = L.tileLayer(`${IMAGERY}/{z}/{y}/{x}`, {
      maxZoom: 19,
      attribution:
        "Tiles © Esri — Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    });
    this.street = L.tileLayer(
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    );
    this.satellite.addTo(this.map);
    this.layers = L.layerGroup().addTo(this.map);
    this.heat = L.layerGroup().addTo(this.map);
    this.map.on("click", (e) => {
      if (!this.drawing) return;
      this.vertices.push([e.latlng.lng, e.latlng.lat]);
      this.updateDraft();
    });
    this.satellite.on("tileerror", () => this.onTileError?.());
  }
  setGeometry(geometry, fit = true) {
    this.geometry = geometry;
    this.layers.clearLayers();
    this.heat.clearLayers();
    L.geoJSON(geometry.interest, {
      style: {
        color: "#f4c95d",
        weight: 2,
        dashArray: "6 5",
        fillColor: "#f4c95d",
        fillOpacity: 0.22,
      },
      interactive: false,
    }).addTo(this.layers);
    L.geoJSON(geometry.fire, {
      style: {
        color: "#ff7566",
        weight: 2,
        fillColor: "#ed594c",
        fillOpacity: 0.4,
      },
      interactive: false,
    }).addTo(this.layers);
    if (fit)
      this.map.fitBounds(L.geoJSON(geometry.outer).getBounds(), {
        padding: [55, 65],
      });
  }
  draw() {
    this.cancelDraw();
    this.drawing = true;
    this.vertices = [];
    this.map.doubleClickZoom.disable();
    this.el.classList.add("drawing");
    this.draft = L.layerGroup().addTo(this.map);
  }
  updateDraft() {
    this.draft.clearLayers();
    const pts = this.vertices.map((p) => [p[1], p[0]]);
    L.polyline(pts, { color: "#ff7566", weight: 3 }).addTo(this.draft);
    pts.forEach((p) =>
      L.circleMarker(p, {
        radius: 4,
        color: "#fff",
        fillColor: "#ed594c",
        fillOpacity: 1,
      }).addTo(this.draft),
    );
    this.onDrawingStep?.(pts.length);
  }
  undo() {
    if (this.drawing) {
      this.vertices.pop();
      this.updateDraft();
    }
  }
  finish() {
    if (this.vertices.length < 3)
      return this.onDrawingStep?.(this.vertices.length);
    this.onSelection(polygon([[...this.vertices, this.vertices[0]]]));
  }
  cancelDraw() {
    this.drawing = false;
    this.vertices = [];
    this.el.classList.remove("drawing");
    this.map.doubleClickZoom.enable();
    if (this.draft) this.map.removeLayer(this.draft);
  }
  setMode(mode) {
    this.map.removeLayer(this.street);
    this.map.removeLayer(this.satellite);
    (mode === "satellite" ? this.satellite : this.street).addTo(this.map);
  }
  showGrid(result, show) {
    this.heat.clearLayers();
    if (!show || !result) return;
    L.geoJSON(result, {
      style: (feature) => ({
        color: "#ffffff",
        weight: 0.7,
        fillColor: scoreColor(feature.properties.score),
        fillOpacity: 0.65,
      }),
      onEachFeature: (feature, layer) => {
        const p = feature.properties;
        const value = (v, digits = 2) =>
          v == null ? "Unknown" : Number(v).toFixed(digits);
        layer.bindPopup(`<div class="cell-popup"><strong>Cell ${escapeHtml(p.cell_id)}</strong>
          <div class="cell-score">${p.score == null ? "Unknown score" : `${value(p.score, 1)} / 100`}</div>
          <p>${escapeHtml(statusLabel(p.status))}</p>
          <dl><dt>Clipped area</dt><dd>${value(p.area_m2 / 1e6)} km²</dd>
          <dt>Valid coverage</dt><dd>${value(p.valid_coverage * 100, 1)}%</dd>
          <dt>Vegetation evidence</dt><dd>${p.vegetation_probability == null ? "Unknown" : value(p.vegetation_probability * 100, 1) + "%"}</dd>
          <dt>NDMI</dt><dd>${value(p.ndmi, 3)}</dd>
          <dt>Dryness proxy</dt><dd>${value(p.dryness_proxy, 3)}</dd>
          <dt>Mean observations</dt><dd>${value(p.observation_count_mean, 1)}</dd></dl>
          <small>Experimental fuel score. See Evidence for imagery dates and sources.</small></div>`);
        layer.on("click", () => this.onCellSelect?.(feature));
      },
    }).addTo(this.heat);
  }

  zoom(delta) {
    this.map.setZoom(this.map.getZoom() + delta);
  }
  recenter() {
    this.map.fitBounds(L.geoJSON(this.geometry.outer).getBounds(), {
      padding: [55, 65],
    });
  }
}
export async function googleMap(el, key, bounds, onSelection) {
  if (!window.google?.maps) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      let timer = setTimeout(
        () =>
          reject(
            new Error("Google Maps timed out. Check the key and network."),
          ),
        15000,
      );
      window.firewatchGoogleReady = () => {
        clearTimeout(timer);
        resolve();
      };
      window.gm_authFailure = () =>
        reject(
          new Error(
            "Google Maps rejected the key. Check domain restrictions and API access.",
          ),
        );
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async&callback=firewatchGoogleReady`;
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Google Maps could not load."));
      };
      document.head.appendChild(s);
    });
  }
  const map = new google.maps.Map(el, {
    center: {
      lat: (bounds[1] + bounds[3]) / 2,
      lng: (bounds[0] + bounds[2]) / 2,
    },
    zoom: 14,
    mapTypeId: "satellite",
    disableDefaultUI: false,
    streetViewControl: false,
  });
  let first = null,
    rect = null;
  map.addListener("click", (e) => {
    if (!first) {
      first = e.latLng;
      return;
    }
    const b = [
      Math.min(first.lng(), e.latLng.lng()),
      Math.min(first.lat(), e.latLng.lat()),
      Math.max(first.lng(), e.latLng.lng()),
      Math.max(first.lat(), e.latLng.lat()),
    ];
    first = null;
    if (rect) rect.setMap(null);
    rect = new google.maps.Rectangle({
      map,
      bounds: { west: b[0], south: b[1], east: b[2], north: b[3] },
      strokeColor: "#fff",
      fillOpacity: 0.1,
    });
    onSelection(b);
  });
  return map;
}
