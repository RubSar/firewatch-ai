# Historical situation contract, version 1.0

This is an offline research interface, not an HTTP endpoint. The executable
schema is [historical-situation.schema.json](historical-situation.schema.json).
The former fuel-index API is no longer present in this checkout.

## Meaning and units

- One record describes one event during one source-defined interval. Identity is
  `(dataset, event_id, interval.start, interval.end)`. Conflicting duplicates fail;
  identical duplicate source records are counted and removed.
- CFSDS v1.1 uses daily burning-date labels derived from `year` and `DOB`. The end
  date is the following calendar date. These are **not UTC midnights or exact
  24-hour observation windows**. Source weather includes local-noon and daily
  summaries with differing windows. Do not reinterpret them as hourly forecasts.
- GOFER-Combined v0.2 uses consecutive UTC snapshots exactly one hour apart.
  The first snapshot has no observed preceding interval and is excluded. Gaps,
  missing areas and negative growth are excluded and counted.
- `state.starting_area_ha`: CFSDS `cumuarea - firearea`; GOFER previous snapshot
  `farea * 100` (km² to ha). This is reconstructed historical state.
- `state.previous_growth_ha`: outcome of the immediately preceding contiguous
  interval from the same event; null for a first interval or gap. It is never
  filled from the current outcome or source `prevgrow` without alignment checks.
- `outcome.growth_ha`: CFSDS `firearea`; GOFER difference between snapshot areas
  multiplied by 100. `proportional_growth` is this value divided by starting area,
  a fraction rather than a percentage; null when starting area is zero.
- Environmental measurements carry value, unit, original column and retrospective
  flag. Missing measurements are null, never zero. An absent source column has a
  null source-field reference. Wind direction is unavailable in the daily summary.
- CFSDS `ws` converts km/h to m/s and `vpd` converts hPa to kPa. Temperature is °C,
  rain mm, biomass t/ha, cover/conifer percentage, elevation m, slope/aspect degrees,
  and peat/nonfuel proportions fractions. Fuel moisture codes retain source indices.
- All original columns and strings are retained in `provenance.raw`, including
  fields not used in matching. CFSDS raw `lon,lat` are the retrospective growth
  centroid in geographic longitude/latitude; location is not a matching feature.
  Raw values are evidence, not a second normalized interface.

## Leakage and missing information

Environmental fields describe the area that ultimately burned. Zero-growth rows
can use a later growth footprint. Their `retrospective` flags remain true. Raw final
area, current growth, spread distance, percentages, and GOFER retrospective active
fire-line length must not enter matching features. State and outcomes are separate
objects, and the matcher uses an explicit feature allowlist.

GOFER environmental values remain null until separately enriched. Missing suppression
information is not an assumption of no intervention. JSON schema validation checks
shape; adapters and tests additionally enforce chronology and identity.

## Comparison result

The runner emits query identity and interval, actual and median matched growth in
ha, empirical p10/p90, range width, actual and estimated proportional growth, error,
coverage, and supporting-fire count. Detailed examples include source situations
and dimensionless distances (null for random matches). A result with fewer than
the selected number of distinct fires has `adequate=false` and no estimate.

Adequacy is a count rule, not a calibrated similarity threshold. Ranges describe
historical variability, not calibrated confidence. All results are explicitly
`retrospective_association_only`.
