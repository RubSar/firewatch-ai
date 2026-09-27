# Satellite transfer and perimeter-audit contracts v1

Additive offline research formats for `perimeter_reference.py` and
`satellite_mosaic.py`. The existing [satellite-case contract](satellite-case.md)
continues to define NBR radiometry, unknown masks, 20 m cells, conditional overlap,
and coverage gates. No API, LLM or frontend schema changes.

The shared grid now permits northern UTM EPSG:32601–32660; the recorded pilot uses
32613/32614/32615. It does not implement southern UTM or cross-zone reprojection.
Use a suitable native zone and require matching scene CRS. All persisted capture
times use UTC; WGS84 is [longitude, latitude], projected units are metres, area is
hectares, and dimensionless indices are not probabilities. Case UUIDs, window dates,
configurations and source SHA-256 values are frozen before satellite selection.

`firewatch.research.perimeter-audit.v1` preserves ordered source geometry versions,
object IDs, `BurnPeriod`, publisher acres, timestamps, map methods, source-ring and
normalized WGS84 WKB hashes. Invalid geometries have a non-null error and null
normalized hash/equality; never repair them or infer growth. Reused timestamps and
area decreases are diagnostics. `reference_time_verified` and `official_progression`
remain false: successful parsing does not certify an observation survey. Reject
truncated source queries, mixed UUIDs or duplicate/non-positive BurnPeriod values.

`firewatch.research.transfer-policy.v1` records population/date bounds, case count,
metadata eligibility, separation, algorithm constants and amendments.
`firewatch.research.transfer-selection.v1` records all candidate decisions and
selected snapshot/config hashes. Candidate ordering is discovery UTC then UUID;
duplicate UUID records are excluded. Non-overlap and origin distance are structural
screens, not statistical independence. Missing required timestamps, invalid geometry
and excessive grid size are excluded before inspecting spectra. Failed acquisitions
remain attempted cases and are not replaced based on outcome.

`firewatch.research.mosaic-catalog.v1` binds configuration, perimeter, grid and raw
STAC response hashes to shortlisted groups. A group shares platform and datatake ID,
contains at most four tiles, spans <=300 seconds, and its footprint union covers
the AOI. Every member must meet the original cloud/date/CRS/band requirements.
Retain each member's exact capture UTC; a time range is not a single instantaneous
acquisition. Shortlist up to four groups, latest pre / earliest post first, datatake
ID breaking ties. Incomplete responses or no covering groups fail explicitly.

`firewatch.research.mosaic-acquisition.v1` binds the catalogue hash, selected groups,
all successfully acquired SCL crops, candidate pair coverage and failed reads. Native
crops are aligned to the full AOI and padded with source no-data outside each tile.
Record both the requested window and the actual source intersection read. Source
CRS, pixel alignment, no-data and STAC/GeoTIFF scale/offset must agree. No reprojected
interpolation or silent radiometric fallback is allowed. Full remote COG checksums
remain unverified; local crops are checksummed.

Within an overpass, lexical member ID order chooses the first SCL class in 4/5/6
per cell. Where none is usable, retain the first non-zero SCL for diagnostics;
where all are no-data, tile choice is -1. All bands use that same source choice.
Apply the one-cell quality buffer after mosaicking. NIR is converted per source
then averaged 2x2 before selecting its 20 m cell. A non-finite spectral value remains
unknown even if another tile could supply it. Choose the pre/post pair by maximal
joint SCL-valid area, with fixed shortlist order breaking ties. No spectral score,
reference overlap or another date influences filling. Failed reads narrow the
available candidates and remain visible in the manifest.

`firewatch.research.mosaic-result.v1` includes original fixed-rule overlap fields,
coverage, member IDs/times, code/input hashes and output hashes. Additional GeoTIFFs
`pre-tile-choice` and `post-tile-choice` are int16 zero-based selected-member indices,
with -1 no-data; they are provenance, not confidence. `time_matched_metrics` stays
null and `time_matched_validation_allowed` false. Passing >=95% coverage does not
establish reference compatibility. Failed-gate overlap is diagnostic only and must
not be pooled or presented as whole-case performance. Empty metric denominators
remain null rather than zero.

`firewatch.research.transfer-summary.v1` counts attempted cases, coverage passes and
time-matched validations separately, and links exact reports. No average accuracy is
computed for this pilot. A compressed evidence file retains both gzip SHA-256 and
decompressed source-byte SHA-256; unzip before passing it to the original selector.
Original Cypress source and outputs remain frozen; evaluation report timestamps and
code hashes can change on replay, but scores and raster/PNG bytes must match.
