# Dated satellite development case v1

Canonical offline contract for `backend/vision/satellite_case.py`. Additive to the
drone contracts; no API events or frontend providers change. This is a burned-area
candidate experiment, not RGB-visible flame, thermal temperature, or future spread.

## Frozen configuration and catalogue

`firewatch.research.satellite-case.v1` fixes incident UUID, source response SHA-256,
collection, UTC acquisition windows, grid, cloud policy and thresholds. The Cypress
v1 experiment uses EPSG:32615, 20 m cells and a 1,000 m buffer around the
projected perimeter bounding box. The later [transfer extension](satellite-transfer.md)
permits other northern UTM zones. Bounds snap outward to multiples of 20 m. WGS84
positions are [longitude, latitude]; projected coordinates are metres. Raster rows
increase southward from the upper-left pixel corner; comparisons use cell centres.

The source must be exactly one WGS84 ArcGIS feature matching the incident UUID and
frozen byte hash. Preserve ring topology using even-odd containment (outer rings,
holes and islands), independent of ring orientation/order. Invalid rings fail;
there is no automatic geometry repair. UTM planar area and publisher GIS area are
reported separately and need not be identical.

`firewatch.research.satellite-catalog.v1` retains raw STAC responses, request URLs,
retrieval UTCs, byte hashes, grid/config hashes, every returned scene's eligibility,
shortlist and all five distinct incident/perimeter timestamps. A response is complete
only when its matched count equals its feature count; larger results fail instead
of silently truncating. This bounded case performs two queries of at most 100 items.
Catalogue retrieval time is never substituted for capture time.

Shortlist up to four fully covering scenes per window with tile cloud <=60%, newest
pre-fire first and earliest post-containment first, scene ID as a tie breaker. Read
only shortlisted SCL crops. Choose the pair with maximum **joint AOI valid fraction**,
with shortlist order breaking ties. Do not rank by candidate/reference agreement.
The tile cloud percentage is only a screening step; local SCL determines coverage.

## Acquisitions and radiometry

`firewatch.research.satellite-acquisition.v1` records the selected IDs, full selected
STAC items and hashes, all candidate SCL crops, any failures, pair coverage, and
native crop provenance. Reads use public HTTPS AWS COG range requests. The grid is
capped at 400,000 cells; NIR has four times that many native samples. This bounds
decoded crop size, not HTTP transfer bytes: COG blocks/headers may be larger.

For every crop record source URL, source shape/transform, native window in pixels,
resolution, retrieval UTC, scale/offset/no-data, GeoTIFF scale/offset metadata, local
file SHA-256 and publisher multihash/file size where present. Local hashes cover the
losslessly saved crop. **They do not verify the full remote asset's checksum.** No
complete remote COG download is claimed. Failed candidates remain recorded and
selection is only among successfully read candidates; failures limit completeness.

Native B08/NIR is 10 m, B12/SWIR2 and SCL are 20 m. Source CRS, rotation, native
resolution, pixel alignment, coverage and no-data compatibility are checked. For
this run, selected STAC and GeoTIFF scale/offset agree: `reflectance = DN*0.0001-0.1`.
Mask DN=0 **before** conversion. Aggregate each aligned NIR 2x2 block with its mean;
any missing contributor leaves the aggregate unknown. SWIR and SCL keep their
native 20 m cells. There is no invented 10 m SWIR detail or arbitrary reprojection.

Usable SCL classes are 4, 5 and 6 (vegetation, non-vegetated, water). Exclude every
other class, and a one-cell Chebyshev neighborhood around excluded cells. Outside
the AOI is unknown for this dilation, so its outermost row/column is excluded.
Both acquisitions must pass, with finite nonnegative NIR/SWIR and sum >1e-6.
Cloud masking is automatic screening, not an independent assessment of visibility.

## Outputs and interpretation

`firewatch.research.satellite-result.v1` contains the grid/config, scene UTCs and
processing baselines, input/code hashes, library versions, coverage, output hashes,
limitations, and two separate result fields:

- `exploratory_overlap`: confusion counts, IoU, Dice, precision, recall and area bias
  in the intersection of valid pixels. These are descriptive mapped-extent overlap.
- `time_matched_metrics`: null. `time_matched_validation_allowed` stays false in v1,
  because mapped reference time/target compatibility has not been established.

Fixed rules are `dNBR=NBR_pre-NBR_post >=0.1`, and the same rule with `NBR_pre>=0.1`.
NBR is `(NIR-SWIR)/(NIR+SWIR)` after radiometric conversion. A common multiplicative
scale cancels, but a common **additive offset does not**. No optimized threshold or
learned probability is produced. Additional comparators are all-negative and a disc
centred at the reported origin with radius from the **known reference area**. The
latter uses reference information and is not an operational prediction. Like all
comparators, it is clipped to the AOI and valid mask; its evaluated area can differ
from its full geometric area.

Each area uses 400 m2 =0.04 ha per grid cell. Bias is candidate minus reference area
over the same valid support; fractional bias divides by valid reference area.
Zero-denominator precision/recall/IoU/Dice/bias fraction is null. Unknown pixels do
not become true negatives. Coverage includes AOI/reference valid fractions and
excluded counts. The predeclared quality gate requires both fractions >=0.95; a
passed coverage gate alone never accepts scientific validation.

GeoTIFFs: `pre-nbr`, `post-nbr`, `dnbr` float32 with NaN no-data; `candidate` uint8
0/1/255=negative/positive/unknown; `reference` uint8 0/1; `valid` uint8 0/1. The
individual NBRs retain finite values independent of the joint cloud mask; use `valid`
for comparison. dNBR and candidate apply the joint mask. The PNG overview applies
the joint mask to every panel. Reports and inputs are not overwritten; use new
output directories. An incomplete acquisition lacks a final manifest and cannot
be evaluated as complete. Re-running evaluation uses local crops without network.

No automatic training, benchmark freeze, drone label acceptance, alert, production
provider update or simulator calibration follows from this result.
