# Curated infrared reference and timing screen v1

Offline research formats for `fetch_ir_reference.py`, `audit_ir_reference.py` and
`match_ir_scenes.py`. Additive to [satellite-case](satellite-case.md) and
[satellite-transfer](satellite-transfer.md); no API or frontend interface changes.

`firewatch.research.ir-source-subset.v1` records immutable publisher release/DOI,
archive asset URL/size/published checksum, selected archive member names, local
relative paths, byte counts, SHA-256 and verified ZIP CRC-32. Whole-archive checksum
verification stays false for range reads. Original range responses have individual
byte hashes; these do not establish the full archive checksum. The original collector
and range-reader hashes identify preserved source snapshots, not current re-acquisition
code. The re-acquirer checks exact file sizes and every saved SHA-256, retains the
original source manifest verbatim, and records new retrieval times/ranges separately
in `reacquisition.json`. It never overwrites an existing dataset directory.

`firewatch.research.ir-reference-registry.v1` binds the original source-manifest hash
to one timestamp and KML hash per source observation. Each date must include an
explicit UTC offset. Preserve publisher time and normalize its instant to UTC;
never infer a timezone from the geographic location, filename or file modification
time. `timestamp_basis` and the pinned timestamp-source URL/hash remain explicit.
Every source KML must appear exactly once. Duplicate UTCs require review. A valid
registry is not automatic source certification or independent human annotation.

KML coordinates are WGS84 longitude, latitude, optional altitude. Altitude is ignored
for the planar footprint. Reject DTD/entity declarations, NetworkLinks, non-finite
or out-of-range coordinates, unclosed rings, and invalid/empty polygons. Preserve
inner rings and combine valid polygon parts by set union. No geometry repair occurs;
any invalid part excludes that dated file. Areas use CONUS Albers EPSG:5070 in square
metres converted to hectares. This adapter is for the recorded CONUS case, not a
general global-area calculator. GeoJSON coordinates stay WGS84.

`firewatch.research.ir-reference-audit.v1` lists all accepted/rejected observations
with source hashes, original timestamps, normalized UTC, geometry errors, valid
area/bounds/component counts and normalized WKB hashes. Its GeoJSON contains only
valid observations and is bound by byte hash. Endpoint geometry additions/removals
refer to successive **valid** observations and include actual elapsed hours; gaps
may span rejected/missing surveys. No interpolated fire-front position, rate or
burned-pixel truth is inferred. Original flight-report verification stays false in
this run. `time_matched_validation_allowed=false`; `validation_metrics=null`.

`firewatch.research.ir-timing-policy.v1` freezes reference-audit hash, STAC collection,
date window, query bounds [west,south,east,north], tile-cloud screen, group span,
primary maximum absolute capture gap, and descriptive sensitivity limits before
the catalogue is requested. These are experiment choices, not universal physical
tolerances. The policy does not authorize automatic label acceptance or tuning.

`firewatch.research.ir-scene-screen.v1` records a complete STAC response checksum,
policy/audit/code hashes, exclusions, and each valid reference's nearest covering
same-platform/datatake group. Footprints are polygon unions; every member meets the
window/cloud requirements. Reject duplicate IDs, invalid footprints or incomplete
matched counts. Group span is at most the policy limit. A candidate group must cover
the full reference geometry. Rank by maximum absolute gap from the earliest/latest
member capture, then group start and datatake ID. Preserve exact member IDs and both
UTC endpoints. No eligible group is represented by null, never a fabricated match.

Sensitivity counts measure reference observations, not unique independent incidents.
Metadata coverage does not establish valid pixels, smoke visibility or negligible
growth. Passing a time screen never enables accuracy metrics automatically. All
existing unknown-mask, independent-review and incident-split requirements remain.
