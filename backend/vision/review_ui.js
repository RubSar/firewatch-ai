/* Standalone review editor. No network requests or persistent browser storage. */
"use strict";
const ReviewTools = (() => {
  const targets = ["visible_flame", "smoke"];
  function encodeRle(mask) {
    const runs = [];
    for (const value of mask) {
      if (![0, 1, 255].includes(value)) throw Error("Invalid mask code");
      const last = runs[runs.length - 1];
      if (last && last[0] === value) last[1]++;
      else runs.push([value, 1]);
    }
    return runs;
  }
  function decodeRle(runs, shape) {
    if (!Array.isArray(shape) || shape.length !== 2 || shape.some(n => !Number.isInteger(n) || n <= 0)) throw Error("Invalid dimensions");
    const size = shape[0] * shape[1];
    if (size > 16000000 || !Array.isArray(runs) || !runs.length || runs.length > size) throw Error("Invalid mask encoding");
    let count = 0;
    for (const run of runs) {
      if (!Array.isArray(run) || run.length !== 2 || ![0, 1, 255].includes(run[0]) || !Number.isInteger(run[1]) || run[1] <= 0) throw Error("Invalid mask run");
      count += run[1];
      if (count > size) throw Error("Mask exceeds image size");
    }
    if (count !== size) throw Error("Incomplete mask");
    const result = new Uint8Array(size);
    let offset = 0;
    for (const [value, length] of runs) { result.fill(value, offset, offset + length); offset += length; }
    return result;
  }
  function emptyLayer(shape) {
    return {mask: new Uint8Array(shape[0] * shape[1]).fill(255), reviewed: false, notes: "", modified_at_utc: null, undo: []};
  }
  function utc(value) { return typeof value === "string" && value.includes("T") && value.endsWith("Z") && Number.isFinite(Date.parse(value)); }
  function importReview(input, review) {
    if (review.schema_version !== "firewatch.research.human_review.v1" || review.packet_id !== input.packet.packet_id || review.reviewer_slot !== input.slot) throw Error("Wrong packet or reviewer slot");
    if (typeof review.reviewer_id !== "string" || !review.reviewer_id.trim() || review.annotator_type !== "human" || review.method !== "manual" || typeof review.independence_attested !== "boolean" || !utc(review.exported_at_utc)) throw Error("Invalid reviewer metadata");
    if (!Array.isArray(review.records)) throw Error("Missing review records");
    const cases = new Map(input.packet.cases.map(c => [c.case_id, c]));
    const state = new Map();
    for (const row of review.records) {
      const c = cases.get(row.case_id);
      if (!c || state.has(c.case_id) || row.rgb_sha256 !== c.rgb_sha256 || JSON.stringify(row.dimensions_hw) !== JSON.stringify(c.dimensions_hw)) throw Error("Unknown, duplicate or changed image");
      if (!row.layers || Object.keys(row.layers).sort().join(",") !== [...targets].sort().join(",")) throw Error("Both target layers required");
      const layers = {};
      for (const target of targets) {
        const layer = row.layers[target];
        if (typeof layer.reviewed !== "boolean" || typeof layer.notes !== "string" || !(layer.modified_at_utc === null || utc(layer.modified_at_utc))) throw Error("Invalid layer metadata");
        const mask = decodeRle(layer.mask_rle, c.dimensions_hw);
        if (layer.reviewed && (!utc(layer.modified_at_utc) || (mask.includes(255) && !layer.notes.trim()))) throw Error("Reviewed unknown pixels require notes and a timestamp");
        layers[target] = {mask, reviewed: layer.reviewed, notes: layer.notes, modified_at_utc: layer.modified_at_utc, undo: []};
      }
      state.set(c.case_id, layers);
    }
    for (const c of cases.values()) if (!state.has(c.case_id)) state.set(c.case_id, Object.fromEntries(targets.map(t => [t, emptyLayer(c.dimensions_hw)])));
    return state;
  }
  function exportReview(input, state, reviewerId, independence, now) {
    if (!reviewerId.trim()) throw Error("Enter your reviewer ID before exporting.");
    return {schema_version: "firewatch.research.human_review.v1", packet_id: input.packet.packet_id,
      reviewer_slot: input.slot, reviewer_id: reviewerId.trim(), annotator_type: "human", method: "manual",
      independence_attested: independence, exported_at_utc: now,
      records: input.packet.cases.map(c => ({...c, layers: Object.fromEntries(targets.map(target => {
        const layer = state.get(c.case_id)[target];
        return [target, {reviewed: layer.reviewed, notes: layer.notes, modified_at_utc: layer.modified_at_utc, mask_rle: encodeRle(layer.mask)}];
      }))}))};
  }
  function paint(mask, shape, x, y, radius, code) {
    const [h, w] = shape;
    for (let py = Math.max(0, Math.floor(y - radius)); py <= Math.min(h - 1, Math.ceil(y + radius)); py++)
      for (let px = Math.max(0, Math.floor(x - radius)); px <= Math.min(w - 1, Math.ceil(x + radius)); px++)
        if ((px - x) ** 2 + (py - y) ** 2 <= radius ** 2) mask[py * w + px] = code;
  }
  return {targets, encodeRle, decodeRle, emptyLayer, importReview, exportReview, paint};
})();
if (typeof module !== "undefined") module.exports = ReviewTools;

function startReview(input) {
  const byId = id => document.getElementById(id);
  const cases = input.packet.cases;
  let state = new Map(cases.map(c => [c.case_id, Object.fromEntries(ReviewTools.targets.map(t => [t, ReviewTools.emptyLayer(c.dimensions_hw)]))]));
  let index = 0, code = 1, dirty = false, stroke = null;
  const canvas = byId("mask"), context = canvas.getContext("2d"), image = byId("rgb");
  const selected = () => cases[index];
  const layer = () => state.get(selected().case_id)[byId("target").value];
  function message(text, error = false) { byId("message").textContent = text; byId("message").dataset.error = String(error); }
  function changed() { const l = layer(); l.reviewed = false; l.modified_at_utc = new Date().toISOString(); dirty = true; byId("reviewed").checked = false; }
  function snapshot() { const l = layer(); l.undo.push({mask: l.mask.slice(), notes: l.notes}); if (l.undo.length > 20) l.undo.shift(); }
  function progress() {
    let count = 0;
    for (const layers of state.values()) for (const t of ReviewTools.targets) if (layers[t].reviewed) count++;
    byId("progress").textContent = `${count} / ${cases.length * 2} image layers reviewed`;
    Array.from(byId("case").options).forEach((option, i) => {
      const layers = state.get(cases[i].case_id);
      option.textContent = `${cases[i].case_id} · ${ReviewTools.targets.filter(t => layers[t].reviewed).length}/2 reviewed`;
    });
  }
  function render() {
    const l = layer(), [h, w] = selected().dimensions_hw;
    const pixels = context.createImageData(w, h);
    const color = byId("target").value === "smoke" ? [28, 151, 208] : [247, 107, 30];
    let positives = 0, unknowns = 0;
    for (let i = 0; i < l.mask.length; i++) {
      const value = l.mask[i], start = i * 4;
      if (value === 1) { pixels.data.set([...color, 150], start); positives++; }
      if (value === 255) { pixels.data.set([177, 61, 193, 65], start); unknowns++; }
    }
    context.putImageData(pixels, 0, 0);
    byId("counts").textContent = `${w} × ${h} native pixels · ${positives} positive · ${l.mask.length - positives - unknowns} negative · ${unknowns} unknown`;
    canvas.style.opacity = byId("overlay").checked ? "1" : "0";
    canvas.style.pointerEvents = byId("overlay").checked ? "auto" : "none";
    byId("reviewed").checked = l.reviewed;
    byId("undo").disabled = !l.undo.length;
    progress();
  }
  function show() {
    const c = selected(), [h, w] = c.dimensions_hw, zoom = Number(byId("zoom").value);
    image.src = input.images[c.case_id];
    image.style.width = `${w * zoom}px`; image.style.height = `${h * zoom}px`;
    canvas.width = w; canvas.height = h;
    canvas.style.width = `${w * zoom}px`; canvas.style.height = `${h * zoom}px`;
    byId("case").value = String(index);
    byId("prev").disabled = index === 0; byId("next").disabled = index === cases.length - 1;
    byId("notes").value = layer().notes;
    message("");
    render();
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect(), [h, w] = selected().dimensions_hw;
    return [Math.max(0, Math.min(w - 1, (event.clientX - rect.left) * w / rect.width - 0.5)), Math.max(0, Math.min(h - 1, (event.clientY - rect.top) * h / rect.height - 0.5))];
  }
  function draw(event) {
    const next = point(event), radius = Number(byId("radius").value);
    const previous = stroke || next, distance = Math.hypot(next[0] - previous[0], next[1] - previous[1]);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius / 2)));
    for (let i = 0; i <= steps; i++) ReviewTools.paint(layer().mask, selected().dimensions_hw, previous[0] + (next[0] - previous[0]) * i / steps, previous[1] + (next[1] - previous[1]) * i / steps, radius, code);
    stroke = next; changed(); render();
  }
  canvas.addEventListener("pointerdown", event => { if (event.button !== 0) return; event.preventDefault(); snapshot(); stroke = point(event); canvas.setPointerCapture(event.pointerId); draw(event); });
  canvas.addEventListener("pointermove", event => { if (stroke) draw(event); });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(name, () => { stroke = null; });
  for (const [i, c] of cases.entries()) { const option = document.createElement("option"); option.value = String(i); option.textContent = c.case_id; byId("case").append(option); }
  byId("slot").textContent = `Reviewer ${input.slot} · ${input.packet.data_kind === "synthetic" ? "SYNTHETIC TEST" : "Independent pilot"}`;
  byId("provenance").textContent = `Packet ${input.packet.packet_id} · RGB only · No publisher masks, thermal images or predictions in this file. Source imagery: FLAME 2 / RFF public release, CC BY 4.0 (publisher declaration).`;
  byId("prev").onclick = () => { index--; show(); };
  byId("next").onclick = () => { index++; show(); };
  byId("case").onchange = () => { index = Number(byId("case").value); show(); };
  byId("target").onchange = show; byId("zoom").onchange = show; byId("overlay").onchange = render;
  byId("radius").oninput = () => { byId("radius-value").textContent = byId("radius").value; };
  document.querySelectorAll("[data-code]").forEach(button => { button.onclick = () => { code = Number(button.dataset.code); document.querySelectorAll("[data-code]").forEach(b => b.setAttribute("aria-pressed", String(b === button))); }; });
  byId("negative-all").onclick = () => { snapshot(); layer().mask.fill(0); changed(); render(); message("Whole layer marked negative. Inspect every area and paint positives / unknowns as needed. Undo is available."); };
  byId("reset").onclick = () => { snapshot(); layer().mask.fill(255); changed(); render(); message("Layer reset to unknown. Undo is available."); };
  byId("undo").onclick = () => { const old = layer().undo.pop(); if (old) { layer().mask = old.mask; layer().notes = old.notes; byId("notes").value = old.notes; changed(); render(); } };
  byId("notes").oninput = () => { layer().notes = byId("notes").value; changed(); render(); };
  byId("reviewed").onchange = () => {
    const l = layer();
    if (byId("reviewed").checked && l.mask.includes(255) && !l.notes.trim()) { byId("reviewed").checked = false; message("Explain the remaining unknown pixels in your notes first.", true); return; }
    l.reviewed = byId("reviewed").checked; l.modified_at_utc = new Date().toISOString(); dirty = true; progress(); message(l.reviewed ? "Layer marked reviewed. Export JSON to save." : "Layer reopened for review.");
  };
  byId("reviewer").oninput = byId("independent").onchange = () => { dirty = true; };
  byId("export").onclick = () => {
    try {
      const review = ReviewTools.exportReview(input, state, byId("reviewer").value, byId("independent").checked, new Date().toISOString());
      const serialized = JSON.stringify(review, null, 2) + "\n";
      byId("export-text").value = serialized; byId("export-fallback").hidden = false;
      const url = URL.createObjectURL(new Blob([serialized], {type: "application/json"}));
      const link = document.createElement("a"); link.href = url; link.download = `firewatch-${input.packet.packet_id.slice(0, 12)}-reviewer-${input.slot}-${Date.now()}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000); dirty = false;
      message("JSON prepared. Verify the download was saved, or use Save JSON manually, before closing.");
    } catch (error) { message(error.message, true); }
  };
  byId("import").onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      if (file.size > 100000000) throw Error("Review file exceeds 100 MB.");
      const review = JSON.parse(await file.text()), imported = ReviewTools.importReview(input, review);
      if (dirty && !window.confirm("Replace unsaved work with this imported review?")) return;
      state = imported; byId("reviewer").value = review.reviewer_id; byId("independent").checked = review.independence_attested;
      dirty = false; show(); message("Your review was restored from JSON.");
    } catch (error) { message(error.message, true); }
    finally { event.target.value = ""; }
  };
  window.addEventListener("beforeunload", event => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
  show();
}
if (typeof document !== "undefined") startReview(INPUT);
