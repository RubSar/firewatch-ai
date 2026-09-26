import {
  createIcons,
  Flame,
  Scan,
  Layers,
  Workflow,
  Settings2,
  ArrowUpRight,
  Database,
  Trees,
  TreePine,
  Mountain,
  Check,
  ChevronDown,
  Satellite,
  Sparkles,
  ArrowRight,
  Cpu,
  Plus,
  Minus,
  LocateFixed,
  Download,
  MountainSnow,
  ScanEye,
  GitCompareArrows,
  NotebookText,
  Info,
  Fingerprint,
  RotateCcw,
  X,
  ScanLine,
  CircleCheck,
  RefreshCw,
} from "lucide";
const icons = {
  Flame,
  Scan,
  Layers,
  Workflow,
  Settings2,
  ArrowUpRight,
  Database,
  Trees,
  TreePine,
  Mountain,
  Check,
  ChevronDown,
  Satellite,
  Sparkles,
  ArrowRight,
  Cpu,
  Plus,
  Minus,
  LocateFixed,
  Download,
  MountainSnow,
  ScanEye,
  GitCompareArrows,
  NotebookText,
  Info,
  Fingerprint,
  RotateCcw,
  X,
  ScanLine,
  CircleCheck,
  RefreshCw,
};
import { LandscapeMap, googleMap } from "../visualization/map.js";
import {
  investigate,
  requestPayload,
  resultGeometry,
  escapeHtml,
} from "./api/investigation.js";
import { renderMethod, renderOverview, renderEvidence } from "./results.js";
import {
  studyArea,
  irregularFire,
  circleFire,
  rectangle,
} from "../visualization/geometry.js";
import { bbox } from "@turf/turf";
import "./style.css";
const presets = [
  {
    id: "hoh",
    name: "Hoh forest",
    location: "Washington, United States",
    kind: "Small fire · satellite demo",
    bounds: [-123.95, 47.85, -123.94, 47.86],
    icon: "tree-pine",
  },
  {
    id: "sierra",
    name: "Sierra Nevada",
    location: "California, United States",
    kind: "Mixed conifer",
    description: "Mountain forest & exposed granite",
    bounds: [-119.748, 37.745, -119.724, 37.762],
    icon: "trees",
  },
  {
    id: "olympic",
    name: "50 km circle",
    location: "Washington, United States",
    kind: "50 km fire → 78 km outer radius",
    description: "Dense evergreen canopy",
    bounds: [-123.954, 47.851, -123.93, 47.868],
    icon: "tree-pine",
  },
  {
    id: "mojave",
    name: "Mojave Desert",
    location: "California, United States",
    kind: "Bare terrain reference",
    description: "Rock, sand & sparse vegetation",
    bounds: [-115.679, 35.025, -115.655, 35.042],
    icon: "mountain",
  },
];
presets.forEach(
  (p) =>
    (p.fire =
      p.id === "hoh"
        ? rectangle(p.bounds)
        : p.id === "olympic"
          ? circleFire([-123.5, 47.5])
          : irregularFire([
              (p.bounds[0] + p.bounds[2]) / 2,
              (p.bounds[1] + p.bounds[3]) / 2,
            ])),
);
let fire = presets[0].fire,
  geometry = studyArea(fire);
let preset = presets[0],
  bounds = bbox(fire),
  selectedCell = null,
  error = null,
  result = null,
  tab = "overview",
  controller = null,
  busy = false,
  showOverlay = true,
  custom = false;
const icon = (name, cls = "") => `<i data-lucide="${name}" class="${cls}"></i>`;
const $ = (s) => document.querySelector(s);
const fmt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const refreshIcons = () => createIcons({ icons });
document.querySelector("#app").innerHTML = `
<aside class="rail"><a class="brand-mark" href="#" aria-label="FireWatch home">${icon("flame")}</a><button class="rail-button active" title="Landscape explorer" aria-label="Landscape explorer">${icon("scan")}</button><button class="rail-button sources-trigger" title="Data sources" aria-label="Data sources">${icon("layers")}</button><button class="rail-button method-trigger" title="Calculation method" aria-label="Calculation method">${icon("workflow")}</button><div class="rail-bottom"><span class="status-dot"></span><span>FW</span></div></aside>
<div class="workspace"><header><div class="wordmark">FireWatch<span> / </span><span class="section-name">Landscape explorer</span></div><div class="header-right"><span class="prototype"><span></span> Research prototype</span><button id="google-settings" class="icon-button" aria-label="Map provider settings" title="Map provider settings">${icon("settings-2")}</button><span class="avatar">FW</span></div></header>
<main><section class="intro"><div><div class="eyebrow">LANDSCAPE INTELLIGENCE</div><h1>Understand the ground ahead.</h1><p>Explore an area. Read the landscape. Trace every finding to its source.</p></div><button class="button subtle sources-trigger">${icon("database")} Data & sources ${icon("arrow-up-right")}</button></section>
<div class="explorer"><aside class="selection-panel"><div class="selection-scroll"><div class="step-label"><span>01</span> CHOOSE YOUR AREA</div><h2>A place to explore</h2><p class="muted small">Choose a synthetic fire example, or draw its perimeter.</p><div class="preset-list">${presets.map((p, i) => `<button class="preset ${i === 0 ? "selected" : ""}" data-preset="${p.id}"><span class="preset-icon">${icon(p.icon)}</span><span><strong>${p.name}</strong><small>${p.kind}</small></span><span class="preset-check">${icon("check")}</span></button>`).join("")}</div>
<div class="divider"></div><div class="label-row"><h3>Area of interest</h3><span id="selection-type" class="tiny-badge">PRESET</span></div><div class="area-measure"><strong id="area-size"></strong><span>km² study area</span></div><button id="draw" class="button outline full">${icon("scan")} Draw fire perimeter</button><p id="draw-help" class="small muted">Click each vertex, then Finish. Edges must not cross.</p><div class="divider"></div><div class="buffer-summary"><strong>28 km beyond the fire</strong><p class="small muted">Yellow area = outer buffer − fire.<br>Geometric study area, not a spread forecast.</p><div id="geometry-metrics"></div></div><div class="divider"></div><form id="analysis-options"><label class="field-label" for="start-date">Imagery start date (UTC)</label><input id="start-date" type="date" value="2025-07-01" min="2017-03-28" required><label class="field-label" for="end-date">End date (exclusive)</label><input id="end-date" type="date" value="2025-08-01" min="2017-03-29" required><p class="small muted">Historical demo window · 1–31 days.</p><label class="field-label" for="cell-size">Nominal grid cell size</label><select id="cell-size"><option value="5000">5,000 m × 5,000 m</option><option value="2000">2,000 m × 2,000 m</option><option value="1000">1,000 m × 1,000 m</option></select><p class="small muted">Boundary cells are clipped. Smaller grids may exceed the 2,048-cell limit.</p></form><div class="source-mini">${icon("satellite")}<div><strong>Analysis sources</strong><span>Dynamic World + Sentinel-2 · 20 m analysis</span></div></div></div><div class="analysis-action"><button id="analyze" class="button primary full">${icon("sparkles")} Analyze fuel index ${icon("arrow-right")}</button><p class="local-note">${icon("cpu")} Satellite analysis via Earth Engine</p></div></aside>
<section class="map-shell"><div id="map"></div><div class="map-top"><div class="map-title"><span class="live-dot"></span><div><strong id="map-name">Sierra Nevada</strong><span id="map-location">California, United States</span></div></div><div class="map-switch"><button class="active" data-mode="satellite">Satellite</button><button data-mode="street">Map</button></div></div><div id="drawing-banner" class="drawing-banner" hidden>Click at least 3 vertices.<button id="undo-draw">Undo</button><button id="finish-draw">Finish</button><button id="cancel-draw">Cancel</button></div><div class="map-tools"><button id="zoom-in" aria-label="Zoom in">${icon("plus")}</button><button id="zoom-out" aria-label="Zoom out">${icon("minus")}</button><button id="recenter" aria-label="Recenter selection">${icon("locate-fixed")}</button></div><div class="map-bottom"><div class="map-legend"><span><i class="boundary-key"></i> Fire perimeter</span><span><i class="buffer-key"></i> 28 km study area</span></div><div id="score-legend" class="map-legend score-legend" hidden><strong>Fuel score</strong><span><i style="background:#57a487"></i>0–&lt;25</span><span><i style="background:#dbbf59"></i>25–&lt;50</span><span><i style="background:#e48b44"></i>50–&lt;75</span><span><i style="background:#c74e49"></i>75–100</span><span><i style="background:#919ba6"></i>Unknown</span></div><button id="overlay-toggle" class="overlay-button" hidden>${icon("layers")} Hide scores</button></div><div id="map-status" hidden></div></section>
<aside class="result-panel"><div class="result-heading"><div class="step-label"><span>02</span> LANDSCAPE ANALYSIS</div><button id="export" class="icon-button" disabled title="Export analysis JSON" aria-label="Export analysis JSON">${icon("download")}</button></div><div class="tabs" role="tablist"><button data-tab="overview" role="tab" aria-selected="true" class="active">Overview</button><button data-tab="evidence" role="tab" aria-selected="false">Evidence</button><button data-tab="method" role="tab" aria-selected="false">Method</button></div><div id="results" aria-live="polite"></div></aside></div>
<footer><span>${icon("fingerprint")} Every result has a source.</span><span>DW + NDMI v1 <b>·</b> Experimental fuel score</span><button id="reset">Reset workspace ${icon("rotate-ccw")}</button></footer></main></div>
<dialog id="sources-dialog"><div class="dialog-head"><div><div class="eyebrow">TRANSPARENT BY DESIGN</div><h2>Know what powers the map.</h2></div><button class="icon-button close-dialog" aria-label="Close sources">${icon("x")}</button></div><p>The basemap provides visual context. The backend queries dated satellite observations for the investigation ring.</p><div class="source-card"><span class="tag connected">ANALYSIS INPUT</span><h3>Dynamic World · Google / WRI</h3><p>Land-cover probabilities at 10 m native resolution, aggregated to the shared 20 m analysis grid.</p><a href="https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1" target="_blank" rel="noreferrer">Explore dataset ↗</a></div><div class="source-card"><span class="tag connected">ANALYSIS INPUT</span><h3>Sentinel-2 · Copernicus</h3><p>Near-infrared and shortwave-infrared reflectance provide vegetation-weighted NDMI. Clouds and shadows are masked. NDMI is a moisture proxy, not measured fuel moisture.</p><a href="https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED" target="_blank" rel="noreferrer">Explore dataset ↗</a></div><div class="source-card"><span class="tag">BASEMAP ONLY</span><h3>Esri World Imagery / OpenStreetMap</h3><p>Visible map tiles do not supply the fuel scores. Esri acquisition dates can differ from the analysis window. Optional Google Maps is an area selector.</p><a href="https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer" target="_blank" rel="noreferrer">View imagery service ↗</a></div><p class="small">Exact acquisition dates, dataset IDs, valid coverage and calculation details appear in Evidence after a successful analysis.</p></dialog>
<dialog id="settings-dialog"><div class="dialog-head"><h2>Map provider</h2><button class="icon-button close-dialog" aria-label="Close settings">${icon("x")}</button></div><p>The open map works immediately. To select an area with Google Maps, use a browser API key restricted to this site.</p><label class="field-label" for="google-key">Google Maps browser API key</label><input id="google-key" type="password" autocomplete="off" placeholder="Paste a restricted browser key"><p class="small muted">Kept in memory for this page session. The key is sent to Google to load Maps.</p><button id="open-google" class="button primary full">Open Google Maps selector ${icon("arrow-up-right")}</button><p id="google-error" role="alert"></p><p class="small">Enable Maps JavaScript API in your Google project. Select two opposite corners, then return to the explorer to analyze.</p></dialog>
<dialog id="export-dialog"><div class="dialog-head"><h2>Analysis JSON receipt</h2><button class="icon-button close-dialog" aria-label="Close JSON receipt">${icon("x")}</button></div><p>Full service response including geometries, cell scores, quality status, satellite sources and calculation metadata. Unknown scores remain null.</p><pre id="json-preview" tabindex="0"></pre><div class="export-actions"><button id="copy-json" class="button outline">Copy JSON</button><button id="save-json" class="button primary">Download JSON</button></div></dialog><dialog id="google-dialog"><div class="dialog-head"><h2>Select on Google Maps</h2><button class="icon-button close-dialog" aria-label="Close Google Maps">${icon("x")}</button></div><p id="google-instruction">Click two opposite corners. Your selection will be transferred to the explorer.</p><div id="google-map"></div></dialog><div id="toast" role="status" hidden></div>`;
const map = new LandscapeMap($("#map"), (b) => {
  try {
    const next = studyArea(b);
    cancelAnalysis();
    fire = b;
    geometry = next;
    bounds = bbox(fire);
    map.cancelDraw();
    $("#drawing-banner").hidden = true;
    custom = true;
    result = null;
    selectedCell = null;
    error = null;
    setSelection();
    renderResults();
    toast("Area selected. Ready to analyze.");
  } catch (e) {
    toast(e.message);
  }
});
map.onDrawingStep = (n) => {
  $("#drawing-banner").firstChild.textContent =
    `${n} vertices · Click more points or Finish. `;
  $("#finish-draw").disabled = n < 3;
};
map.onTileError = () => {
  $("#map-status").hidden = false;
  $("#map-status").textContent =
    "Some imagery tiles could not load. Check your connection or switch to Map.";
};
function setSelection() {
  map.setGeometry(geometry);
  $("#area-size").textContent = fmt(geometry.areas_km2.interest);
  $("#geometry-metrics").innerHTML =
    `<div>Fire <strong>${fmt(geometry.areas_km2.fire)} km²</strong></div><div>Fire + study area <strong>${fmt(geometry.areas_km2.outer)} km²</strong></div><small>${fire.properties?.radius_km ? "Radius: 50 km → 78 km (approx.)" : "Rounded 28 km offset along all edges"}</small><small>${result ? "Backend geometry · WGS84 areas" : "Local geometry preview · run analysis to verify"}</small>`;
  $("#selection-type").textContent = custom ? "CUSTOM" : "PRESET";
  $("#map-name").textContent = custom ? "Custom selection" : preset.name;
  $("#map-location").textContent = custom
    ? `${Math.abs((bounds[1] + bounds[3]) / 2).toFixed(3)}° ${bounds[1] + bounds[3] >= 0 ? "N" : "S"} · ${Math.abs((bounds[0] + bounds[2]) / 2).toFixed(3)}° ${bounds[0] + bounds[2] >= 0 ? "E" : "W"}`
    : preset.location;
  document
    .querySelectorAll(".preset")
    .forEach((e) =>
      e.classList.toggle("selected", !custom && e.dataset.preset === preset.id),
    );
  $("#export").disabled = false;
  $("#overlay-toggle").hidden = !result;
  $("#score-legend").hidden = !result || !showOverlay;
}
function toast(msg) {
  $("#toast").textContent = msg;
  $("#toast").hidden = false;
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => ($("#toast").hidden = true), 5500);
}
function cancelAnalysis() {
  controller?.abort();
  controller = null;
  busy = false;
  $("#analyze").disabled = false;
  $("#analyze").innerHTML =
    `${icon("sparkles")} Analyze fuel index ${icon("arrow-right")}`;
}
function renderResults() {
  $("#export").disabled = busy;
  $("#overlay-toggle").hidden = !result;
  $("#score-legend").hidden = !result || !showOverlay;
  if (busy) {
    $("#results").innerHTML =
      `<div class="loading-state"><span class="scan-orbit">${icon("satellite")}</span><div class="eyebrow">SATELLITE ANALYSIS</div><h2>Analyzing the investigation ring</h2><p>Creating cells, matching imagery and calculating fuel scores…</p><div class="progress-track indeterminate"><span></span></div><p class="small muted">This may take a few minutes. The service returns results when complete.</p><button id="cancel-analysis" class="button outline">Stop waiting</button><p class="small muted">The server may finish its current query after you stop waiting.</p></div>`;
    $("#cancel-analysis").onclick = () => {
      cancelAnalysis();
      renderResults();
    };
  } else if (error) {
    $("#results").innerHTML =
      `<div class="empty-state" role="alert"><h2>Analysis unavailable</h2><p>${escapeHtml(error)}</p><button id="retry-analysis" class="button primary full">Retry analysis</button><p>No estimated or cached scores have been substituted.</p></div>`;
    $("#retry-analysis").onclick = run;
  } else if (tab === "method") {
    $("#results").innerHTML = renderMethod(result);
  } else if (!result) {
    $("#results").innerHTML =
      `<div class="empty-state"><div class="landscape-symbol">${icon("mountain-snow")}</div><div class="eyebrow">INVESTIGATE THE SURROUNDINGS</div><h2>What could fuel a fire?</h2><p>Analyze cells within 28 km of the supplied fire. The burning polygon is excluded.</p><div class="empty-features"><span>${icon("trees")} Dynamic World vegetation evidence</span><span>${icon("satellite")} Sentinel-2 moisture proxy</span><span>${icon("notebook-text")} Sources & calculation trail</span></div><div class="notice"><p>Choose imagery dates and a grid size. Presets are hypothetical fires. Scores are experimental, not spread predictions.</p></div></div>`;
  } else if (tab === "evidence") {
    $("#results").innerHTML = renderEvidence(result, selectedCell);
    $("#download-evidence").onclick = download;
  } else {
    $("#results").innerHTML = renderOverview(result);
    $("#view-method").onclick = () => setTab("method");
  }
  refreshIcons();
}
function setTab(t) {
  tab = t;
  document.querySelectorAll("[data-tab]").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === t);
    el.setAttribute("aria-selected", String(el.dataset.tab === t));
  });
  renderResults();
}
async function run() {
  cancelAnalysis();
  map.cancelDraw();
  $("#drawing-banner").hidden = true;
  result = null;
  selectedCell = null;
  error = null;
  map.showGrid(null, false);
  let payload;
  try {
    payload = requestPayload(
      fire,
      $("#start-date").value,
      $("#end-date").value,
      $("#cell-size").value,
    );
  } catch (e) {
    error = e.message;
    renderResults();
    return;
  }
  busy = true;
  controller = new AbortController();
  const current = controller;
  $("#analyze").disabled = true;
  $("#analyze").textContent = "Analyzing…";
  setTab("overview");
  try {
    const data = await investigate(payload, current.signal);
    if (current.signal.aborted || controller !== current) return;
    result = data;
    geometry = resultGeometry(result);
    busy = false;
    $("#analyze").disabled = false;
    $("#analyze").innerHTML = `${icon("refresh-cw")} Analyze again`;
    setSelection();
    map.showGrid(result, showOverlay);
    renderResults();
    controller = null;
  } catch (e) {
    if (current.signal.aborted || controller !== current) return;
    cancelAnalysis();
    error = e.message;
    renderResults();
  }
}
function download() {
  const json = JSON.stringify(
    result || {
      analysis_kind: "geometry_preview",
      geometry,
      note: "Local preview only. No satellite analysis has been performed.",
      coordinate_system: "EPSG:4326",
    },
    null,
    2,
  );
  $("#json-preview").textContent = json;
  $("#export-dialog").showModal();
  $("#copy-json").onclick = async () => {
    try {
      await navigator.clipboard.writeText(json);
      toast("JSON receipt copied.");
    } catch {
      toast("Copy unavailable. Select the JSON text or download the receipt.");
    }
  };
  $("#save-json").onclick = () => {
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "firewatch-fire-investigation.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}
document.querySelectorAll("[data-preset]").forEach(
  (el) =>
    (el.onclick = () => {
      cancelAnalysis();
      preset = presets.find((p) => p.id === el.dataset.preset);
      fire = preset.fire;
      geometry = studyArea(fire);
      bounds = bbox(fire);
      custom = false;
      result = null;
      selectedCell = null;
      error = null;
      map.cancelDraw();
      $("#drawing-banner").hidden = true;
      setSelection();
      renderResults();
    }),
);
$("#draw").onclick = () => {
  cancelAnalysis();
  renderResults();
  map.draw();
  $("#drawing-banner").hidden = false;
  $("#drawing-banner").firstChild.textContent =
    "Click at least 3 vertices around the fire. ";
  $("#finish-draw").disabled = true;
};
$("#cancel-draw").onclick = () => {
  map.cancelDraw();
  $("#drawing-banner").hidden = true;
};
$("#finish-draw").onclick = () => map.finish();
$("#undo-draw").onclick = () => map.undo();
$("#analyze").onclick = run;
$("#export").onclick = download;
document
  .querySelectorAll("[data-tab]")
  .forEach((e) => (e.onclick = () => setTab(e.dataset.tab)));
document
  .querySelectorAll(".sources-trigger")
  .forEach((e) => (e.onclick = () => $("#sources-dialog").showModal()));
document
  .querySelectorAll(".method-trigger")
  .forEach((e) => (e.onclick = () => setTab("method")));
document
  .querySelectorAll(".close-dialog")
  .forEach((e) => (e.onclick = () => e.closest("dialog").close()));
document.querySelectorAll("dialog").forEach((d) =>
  d.addEventListener("click", (e) => {
    if (e.target === d) {
      const r = d.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        d.close();
    }
  }),
);
$("#zoom-in").onclick = () => map.zoom(1);
$("#zoom-out").onclick = () => map.zoom(-1);
$("#recenter").onclick = () => map.recenter();
document.querySelectorAll("[data-mode]").forEach(
  (e) =>
    (e.onclick = () => {
      map.setMode(e.dataset.mode);
      $("#map-status").hidden = true;
      document
        .querySelectorAll("[data-mode]")
        .forEach((x) => x.classList.toggle("active", x === e));
    }),
);
$("#overlay-toggle").onclick = () => {
  showOverlay = !showOverlay;
  map.showGrid(result, showOverlay);
  $("#score-legend").hidden = !result || !showOverlay;
  $("#overlay-toggle").innerHTML =
    `${icon("layers")} ${showOverlay ? "Hide" : "Show"} scores`;
  refreshIcons();
};
$("#reset").onclick = () => {
  $("#start-date").value = "2025-07-01";
  $("#end-date").value = "2025-08-01";
  $("#cell-size").value = "5000";

  showOverlay = true;
  $("#overlay-toggle").innerHTML = `${icon("layers")} Hide scores`;
  setTab("overview");
  document.querySelector('[data-preset="hoh"]').click();
};
$(".brand-mark").onclick = (e) => {
  e.preventDefault();
  $("#reset").click();
};
$(".rail-button.active").onclick = () => setTab("overview");
$("#google-settings").onclick = () => $("#settings-dialog").showModal();
$("#google-key").value = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";
$("#open-google").onclick = async () => {
  const key = $("#google-key").value.trim();
  if (!key) {
    $("#google-error").textContent =
      "Enter a restricted Google Maps browser key.";
    return;
  }
  $("#open-google").disabled = true;
  $("#google-error").textContent = "";
  $("#google-dialog").showModal();
  try {
    await googleMap($("#google-map"), key, bounds, (b) => {
      try {
        cancelAnalysis();
        const nextFire = rectangle(b),
          nextGeometry = studyArea(nextFire);
        fire = nextFire;
        geometry = nextGeometry;
        bounds = b;
        custom = true;
        result = null;
        selectedCell = null;
        error = null;
        setSelection();
        renderResults();
        $("#google-dialog").close();
        $("#settings-dialog").close();
        toast(
          "Google Maps selection transferred. Fuel analysis uses Dynamic World and Sentinel-2.",
        );
      } catch (e) {
        $("#google-instruction").textContent = e.message;
      }
    });
  } catch (e) {
    $("#google-dialog").close();
    $("#google-error").textContent = e.message;
  } finally {
    $("#open-google").disabled = false;
  }
};
map.onCellSelect = (cell) => {
  selectedCell = cell;
  setTab("evidence");
};
$("#analysis-options").onsubmit = (e) => {
  e.preventDefault();
  run();
};
$("#analysis-options").onchange = () => {
  cancelAnalysis();
  result = null;
  selectedCell = null;
  error = null;
  geometry = studyArea(fire);
  setSelection();
  renderResults();
};
$("#end-date").max = new Date().toISOString().slice(0, 10);
$("#start-date").max = $("#end-date").max;
setSelection();
renderResults();
refreshIcons();
