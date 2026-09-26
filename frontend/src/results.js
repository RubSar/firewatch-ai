import { escapeHtml as esc, statusLabel } from "./api/investigation.js";
const num = (v, digits = 2) =>
  v == null
    ? "Unknown"
    : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits });
const row = (label, value) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`;

export function renderMethod(result) {
  return `<div class="method-content"><div class="eyebrow">OPEN CALCULATION</div><h2>From fire to fuel evidence.</h2>
  <p class="small muted">Dynamic World + Sentinel-2 NDMI · experimental policy v1</p>
  <ol class="process">
  <li><strong>Receive the fire polygon</strong><p>The supplied perimeter defines the fire. Fire detection is outside this service.</p></li>
  <li><strong>Create the investigation ring</strong><p>The backend buffers outward by 28,000 m in a local WGS84 projection, then subtracts the fire. Corners are rounded; nearby parts may merge. This is an approximate regional distance buffer.</p></li>
  <li><strong>Clip the grid</strong><p>Only cells outside the fire are scored. Nominal cell sizes are projected metres; boundary cells are clipped. The initial map shows a local preview; a successful response replaces it with backend geometry.</p></li>
  <li><strong>Match satellite observations</strong><p>Match Dynamic World land-cover probabilities and Sentinel-2 imagery by acquisition time and tile. Mask clouds, shadows, snow and uncertain land cover. Analyze common support at 20 m.</p></li>
  <li><strong>Compute vegetation and dryness</strong><p>V = trees + grass + crops + shrubs + flooded vegetation probabilities.<br>NDMI = (B8 − B11) / (B8 + B11), weighted by vegetation evidence.<br>D = clamp((0.4 − NDMI) / 0.6, 0, 1).</p></li>
  <li><strong>Score and apply quality rules</strong><p>Score = 100 × V × D. Coverage below 70%, missing data, missing moisture or substantial built cover yields an unknown score. Strong non-vegetated evidence can score zero. The mean is weighted by valid observed area.</p></li></ol>
  <div class="notice"><p>The thresholds are unvalidated prototype assumptions. This is not fire probability, a spread forecast, or an official Burning Index. Outside the supplied perimeter does not independently confirm unburned land.</p></div>
  ${result ? `<p class="small muted spaced">Method: ${esc(result.method.id)}<br>${esc(result.investigation.buffer_method)}</p>` : ""}</div>`;
}

export function renderOverview(r) {
  const s = r.summary;
  const unknown = s.cell_count - s.scored_cell_count;
  return `<div class="overview"><div class="result-label">Analysis complete <span>${r.provenance.synthetic ? "SYNTHETIC DATA" : "SATELLITE EVIDENCE"}</span></div>
    <div class="score-card"><div class="eyebrow">INVESTIGATION AREA · MEAN FUEL SCORE</div><div class="score">${s.mean_score == null ? "—" : num(s.mean_score, 1)}<span>/ 100</span></div>
    <p>${s.mean_score == null ? "No cells passed the quality rules" : "Experimental vegetation × dryness score"}</p><small>Weighted by valid observed area. Unknown cells are excluded, never treated as zero.</small></div>
    <div class="analysis-stats"><div><strong>${s.scored_cell_count}</strong><span>scored cells</span></div><div><strong>${unknown}</strong><span>unknown cells</span></div>
    <div><strong>${num(s.total_area_m2 / 1e6)}</strong><span>km² investigation ring</span></div><div><strong>${num(s.unscored_cell_area_m2 / 1e6)}</strong><span>km² in unknown cells</span></div></div>
    <div class="comparison"><span>Imagery window · UTC</span><strong>${esc(r.start_date)} → ${esc(r.end_date)}</strong><small>End date excluded · ${num(r.cell_size_m)} m nominal cells · ${r.analysis_resolution_m} m observations</small></div>
    <div class="notice"><p>Click a map cell to inspect its score, coverage and NDMI. Gray means unknown. A low score does not establish that an area is safe.</p></div>
    <button class="text-link" id="view-method">See exactly how this was calculated →</button></div>`;
}

export function renderEvidence(r, cell) {
  const p = cell?.properties;
  const selected = p
    ? `<section class="cell-detail"><h3>Selected cell ${esc(p.cell_id)}</h3><dl>
    ${row("Status", statusLabel(p.status))}${row("Score", p.score == null ? "Unknown" : `${p.score} / 100`)}
    ${row("Area", `${num(p.area_m2 / 1e6)} km²`)}${row("Valid coverage", `${num(p.valid_coverage * 100, 1)}%`)}
    ${row("Vegetation evidence V", num(p.vegetation_probability, 4))}${row("NDMI", num(p.ndmi, 4))}
    ${row("Dryness proxy D", num(p.dryness_proxy, 4))}${row("Mean observations", num(p.observation_count_mean, 2))}</dl>
    <details><summary>Land-cover probabilities</summary>${
      Object.entries(p.landcover_probabilities || {})
        .map(
          ([k, v]) =>
            `<div class="count-row"><span>${esc(statusLabel(k))}</span><strong>${num(v * 100, 1)}%</strong></div>`,
        )
        .join("") || "<p>No land-cover evidence available.</p>"
    }</details></section>`
    : '<p class="small muted">Click a cell on the map to inspect its evidence.</p>';
  const counts = Object.groupBy
    ? Object.groupBy(r.features, (f) => f.properties.status)
    : r.features.reduce((a, f) => {
        (a[f.properties.status] ||= []).push(f);
        return a;
      }, {});
  const pairs = r.provenance.acquisition_pairs || [];
  return `<div class="evidence"><div class="eyebrow">ANALYSIS RECEIPT</div><h2>Follow the evidence.</h2>${selected}<dl>
    ${row("Provider", r.provenance.provider)}${row("Generated", new Date(r.generated_at).toLocaleString())}
    ${row("Imagery window (UTC)", `${r.start_date} → ${r.end_date} (end excluded)`)}
    ${row("Matched acquisitions", r.provenance.pair_count ?? pairs.length)}${row("Grid / resolution", `${r.cell_size_m} m / ${r.analysis_resolution_m} m`)}
    ${row("Grid CRS", r.grid_crs)}${row("Method", r.method.id)}${row("Synthetic evidence", r.provenance.synthetic ? "Yes" : "No")}</dl>
    <h3>Cell quality</h3>${Object.entries(counts)
      .map(
        ([k, v]) =>
          `<div class="count-row"><span>${esc(statusLabel(k))}</span><strong>${v.length}</strong></div>`,
      )
      .join("")}
    <h3 class="spaced">Satellite inputs</h3><p class="small">${esc(r.provenance.dynamic_world_collection)}<br>${esc(r.provenance.sentinel2_collection)}</p>
    <a class="text-link" target="_blank" rel="noreferrer" href="https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1">Dynamic World dataset ↗</a>
    <a class="text-link" target="_blank" rel="noreferrer" href="https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED">Sentinel-2 SR dataset ↗</a>
    <details class="spaced"><summary>${pairs.length} acquisition records</summary><p class="small muted">Candidate assets across the ring; not every image contributes to every cell.</p>${pairs.map((a) => `<div class="asset-record"><strong>${esc(a.acquired_at)}</strong><div>DW: ${esc(a.dynamic_world_id)}</div><div>S2: ${esc(a.sentinel2_id)}</div></div>`).join("")}</details>
    <p class="small muted spaced">${esc(r.provenance.attribution)}</p><button id="download-evidence" class="button outline full">Download full JSON receipt</button></div>`;
}
