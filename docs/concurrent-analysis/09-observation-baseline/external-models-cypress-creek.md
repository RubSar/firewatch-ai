# External models and the Cypress Creek case

Date: 2026-09-27. Status: source assessment and incident snapshot, not a completed
model evaluation. The user supplied ELMFIRE, Cell2Fire, Sentinel Hub scripts, a Cornea
link and Cypress Creek metadata. Scope: research documentation/evidence only. Existing
M1 review requirements and the observed-fire product scope remain unchanged.

## How the supplied resources fit

| Resource | Method / evidence | Useful role in FireWatch |
|---|---|---|
| [ELMFIRE](https://elmfire.io/) | Physical/empirical spread formulations with a level-set front | External simulator comparison on matched fuels, terrain, weather and initialization |
| [Cell2Fire](https://github.com/cell2fire/Cell2Fire) | Cell-based landscape propagation with elliptical within-cell spread; can use Canadian FBP | Alternative spread reference after reconciling fuel and rate-of-spread conventions |
| [Sentinel Hub scripts](https://custom-scripts.sentinel-hub.com/custom-scripts/) | JavaScript satellite-band transformations | Transparent satellite observation baseline and visual QA |
| [Cypress Creek incident page](https://fires.cornea.is/fire/texas_cypress-creek_2026-02-24-191651) | Reported incident information | Find a case, then preserve the underlying agency record and dated geometry |

These resources are not trained models for drone flame segmentation. ELMFIRE's
[mathematical reference](https://elmfire.io/tech_ref.html) describes narrow-band
level-set propagation, second-order Runge-Kutta integration and Superbee flux limiting.
Its guide lists gridded fuel/topography/weather/moisture inputs and outputs including
arrival time and spread rate. The current distribution documents Linux/WSL2 and
AGPLv3 plus Commons Clause terms; record the exact version and governing terms before
an implementation decision. No installation or model run was performed here.

Cell2Fire's repository identifies it as research software and points to
[C2FK](https://github.com/fire2a/C2FK) as a more actively maintained fork. Its Canadian
FBP option is not interchangeable with Rothermel on identically numbered fuel classes.
An inter-model comparison must first agree on the fuel system, moisture variables,
wind reference height, units and propagation assumptions. Treat disagreement as a
diagnostic, not evidence that one model is ground truth.

The [NBR example](https://custom-scripts.sentinel-hub.com/custom-scripts/sentinel-2/nbr/)
computes `NBR = (B08 - B12) / (B08 + B12)`; `dNBR = NBR_before - NBR_after` measures
spectral change. This is a fixed mathematical baseline, not learned AI. Burn scars,
active flame and operational perimeters have different meanings. The
[Sentinel-2 L2A documentation](https://docs.sentinel-hub.com/api/latest/data/sentinel-2-l2a/)
lists B08 at 10 m and B12/SCL at 20 m. Upsampling does not create finer SWIR evidence.
Use consistent reflectance processing and a common grid, mask clouds/shadows/no-data
for both exact acquisitions, and retain missing coverage. Tile cloud percentage alone
does not establish that the incident area is clear.

## Incident identity and verified metadata

The supplied [Cornea URL](https://fires.cornea.is/fire/colorado_county-rd-169_2026-02-18-141814)
is **County Rd 169, Elbert County, Colorado**, not Cypress Creek in Texas. Keep these
as separate cases. The Cypress Creek page is linked in the table above.

The public current-incident point query returned no Cypress Creek feature. A bounded
query of [NIFC's WFIGS year-to-date perimeter service](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_YearToDate/FeatureServer/0)
returned one matching record. The raw response and exact query/retrieval time/hash
are retained in [snapshot](results/cypress-creek-wfigs-snapshot.json) and
[provenance](results/cypress-creek-wfigs-provenance.json). This verifies the user-supplied
dates and approximate coordinates, with the following distinctions:

| Field | Value from the retained record |
|---|---|
| Incident / IRWIN ID | Cypress Creek / `8432b888-2a01-4825-8eb6-c74589de24fc` |
| Reported point of origin | Latitude 31.0586, longitude -94.3567 |
| County / state | Angelina / US-TX |
| Reported incident area | 6,754 acres = 2,733.247 ha |
| GIS polygon area attribute | 6,753.942 acres = 2,733.223 ha |
| Discovery | 2026-02-24 18:30 UTC |
| Containment | 2026-03-09 19:18 UTC |
| Fire out | 2026-05-06 13:00 UTC |
| Jurisdiction / protecting agency / landowner category | USFS / USFS / USFS; federal land |
| Type / cause | WF / Undetermined |
| Mapping method / feature status | Mixed Methods / Approved |
| Polygon timestamp | 2026-02-27 11:20 UTC |
| Polygon date-current field | 2026-03-01 22:20:53 UTC |

Area conversion uses 0.40468564224 hectares per international acre; the polygon area
above is the publisher's attribute, not a newly calculated geometry measurement.
The response geometry was requested in EPSG:4326, coordinates [longitude, latitude],
and has two rings with 699 vertices in total. Do not assume both rings are disjoint
filled polygons; preserve their topology when rasterizing.

Containment, extinction and polygon timestamps are separate. Discovery-to-containment
is 312.8 hours; discovery-to-polygon timestamp is approximately 64.83 hours. The
record does not by itself establish that the polygon represents the extent at
containment, or the exact acquisition time of every mapped segment. Preserve both
times and resolve the observation/reference time before a time-matched score.

## Existing prototype and new remote work

Remote main fetched during this assessment advanced from `99eea09` to `a0d5982`.
Three commits add and revise `frontend/api/src/hindcast.ts`: mapped-perimeter
comparison, precision/recall and an equal-area-disc baseline, then replay duration
and reported-origin handling. This assessment inspected that code; it did not rerun
the historical model or certify the performance numbers in existing documentation.

Relevant existing code:

- `frontend/api/src/providers/burnhistory.ts`: NBR/dNBR, RBR and severity/fuel changes.
  Scene selection is relative to `Date.now()` with a roughly year-separated pair;
  it is not an event-specific February/March 2026 experiment.
- `frontend/api/src/providers/sentinel.ts`: scene search, raster sampling and SCL.
- `frontend/api/src/hindcast.ts` at `a0d5982`: WFIGS polygons, archive weather,
  even-odd ray-casting rasterization, Dice/precision/recall and a disc comparison.
  Reported origin is used when available/in-grid, with centroid fallback. Earlier
  introductory prose still describes centroid-only behavior; trust the implementation.
- `frontend/sim/src/rothermel.ts` and `frontend/sim/bench/rothermel.ts`: the current
  analytical spread reference and benchmark; neither executes ELMFIRE or Cell2Fire.

The current hindcast requests containment time but not the polygon timestamp. It
also chooses a small subset from service response order rather than a frozen incident
list. For Cypress Creek, record identity and reference time should be made explicit
before interpreting another score. Input terrain/fuel provenance also needs an event
date audit: imagery selected today can incorporate the aftermath of the fire being
replayed. Suppression remains absent from the replay. These are research-design
dependencies; this task did not modify the simulator or its evaluations.

## Recommended next experiment

Proposed objective: **build a reproducible, dated Cypress Creek observation case and
test the existing satellite baseline against an appropriately dated mapped extent.**
This is a separate satellite/landscape evaluation, not completion of M1's independent
drone annotation review.

1. Freeze the incident ID and this source snapshot. Resolve what time the polygon
   represents, or obtain dated progression perimeters; retain uncertainty if unresolved.
2. Select pre-fire and post-fire Sentinel-2 acquisitions explicitly. Record scene IDs,
   UTCs, checksums, processing baseline, cloud/occlusion masks and common-grid metadata.
   Review nearby burns and non-fire land changes; two scenes alone cannot attribute
   every changed pixel to this incident.
3. Run fixed NBR/dNBR thresholds before ML. Report valid coverage, IoU/Dice,
   precision/recall, area bias and spatial errors. A publisher perimeter is a mapped
   reference with its own uncertainty, not pixel-perfect active-flame truth. One
   already-inspected fire is a development case, not a held-out generalization result.
4. For simulator work, first freeze event-time fuels/weather/origin and matched
   horizon, then compare the prototype with ELMFIRE under common inputs. Preserve a
   simple geometric baseline and evaluate additional independent incidents before
   calibration or claims of improved prediction.

ML candidates after those baselines: multispectral burned-area segmentation,
uncertainty/quality estimation, and later parameter calibration across independent
fires. Training on simulation masks alone measures agreement with that simulator;
it cannot establish real-world accuracy. No model was trained, no satellite imagery
was downloaded, and no M1 human review status was changed by this assessment.

Validation: source pages inspected; one public perimeter response saved and parsed;
timestamps, area conversions, geometry dimensions and snapshot checksum checked;
local/remote code paths reviewed. Documentation/data changes require no application
test run. The existing research results remain intact.
