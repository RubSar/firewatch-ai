# GOFER enrichment pilot: observed findings

This is the checked-in data-quality result from the reproducible 72-hour enrichment run. Values are source observations or deterministic transformations with per-measurement provenance. Nulls and disagreements are retained. It does not measure prediction performance.

## Event coverage

| GOFER event | Year | Intervals | New-growth footprints | No-growth/no-footprint | Intervals with burned-footprint temperature | LANDFIRE layer requests completed | Final GOFER–MTBS extent IoU |
|---|---:|---:|---:|---:|---:|---:|---:|
| gofer:2019:Kincade | 2019 | 72 | 15 | 57 | 13/72 | 120/120 | 0.788 |
| gofer:2020:Bobcat | 2020 | 72 | 33 | 39 | 30/72 | 264/264 | 0.756 |
| gofer:2020:Creek | 2020 | 72 | 63 | 9 | 58/72 | 492/504 | 0.860 |

The Creek row uses the official 2016 LANDFIRE remap snapshot; some categorical layers are unavailable for individual footprints. The interval-level report preserves each missing value, and the event manifest records source request errors. MTBS IoU is a final-perimeter comparison only.

## Source findings and interpretation

- **GOFER:** the source summary and fire progression archive are checksum-pinned. Perimeters retain source-defined UTC interval boundaries. The reconstructed hourly footprint is `P_end - P_start`; no-growth intervals retain `geometry: null`. One Creek interval is flagged for non-nested perimeters.
- **ERA5-Land:** hourly 2 m temperature/dew point, precipitation, 10 m wind components and deterministic RH/VPD/speed/direction are attached separately to the new-growth footprint and the ignition point. Pixel weather is absent for no-growth intervals; ignition-point context remains separately available. Precipitation uses the source hourly band and native accumulation window. Negative reanalysis precipitation artifacts remain visible and flagged.
- **3DEP:** elevation, slope and aspect are measured from the USGS 10 m source grid. The catalog result does not establish the acquisition date for each pixel; terrain is explicitly flagged as potentially retrospective.
- **LANDFIRE:** LF2016 Remap predates all events, but is several years old. Continuous canopy fields preserve native values and documented conversions. Fuel model and vegetation class layers are categorical; current reports give sampled class distributions (up to 1,000 points), not exact full-pixel histograms. Creek returned partial coverage and 12 HTTP 400 query failures over three interval-layer groups; those fields remain null.
- **RAWS:** no historical station rows were acquired because the archive needs credentials. Each event sidecar records this status and leaves station, distance, elevation, observation time and conventions null. No reanalysis copy is called independent confirmation.
- **MTBS:** the independent final extent outlines disagree with GOFER to varying degrees (see IoU and each event `event-enrichment.json`). Both boundaries and the area differences are preserved. The comparison cannot validate hourly growth.
- **Document evidence:** the Forest Service Creek investigation PDF was obtained from a secondary mirrored copy after its USDA download endpoint returned 403. Granite Docling processed all 27 image pages; 5 returned too little OCR text to use. Qwen produced 26 candidates, of which 21 (80.8%) had exact page-linked quotations under conservative PDF line-wrap normalization. Five candidates have no value because the quote failed, and one page returned malformed JSON. All 26 candidates remain pending; this link rate is not extraction precision or recall. One linked `temperature` candidate is `54,000` with no unit, showing why a valid quote still needs semantic and unit review.

## Pilot artifacts

- `contracts/examples/enriched-creek-2020-hour.json` is one real hourly Creek record with full measurement provenance and reconstructed newly burned footprint.
- Ignored runtime outputs under `backend/api/.research-data/enrichment-pilot/data/` contain all 216 interval records, event-level RAWS/MTBS/LANDFIRE metadata, source response caches and before/after completeness reports. The original GOFER input remains immutable.
- The sidecar contract is `contracts/enrichment-sidecar.schema.json`; it preserves value, units, measurement kind, original data, source/version, temporal/spatial support, method, quality flags, evidence, review status and conflicts.

## Gaps and next acceptance gate

Historical station coverage, an adequately dated terrain snapshot, a newer pre-fire LANDFIRE snapshot, and Creek LANDFIRE service coverage are unresolved. Official report availability for Kincade and Bobcat also remains to be sourced. Local document extraction must remain pending until every candidate is human-reviewed. The [Creek evidence review table](creek-document-evidence-review.md) records candidate page, field, evidence-link result and pending status. The 100-case extraction benchmark has not been run; do not claim the 95% precision automation gate. The current deliverable supports source auditing and historical data-quality review only.
