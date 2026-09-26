# Drone-based near-realtime processing

Date: 2026-09-26. Status: research proposal, not an approved implementation design.
Confirmed scope: detect the existing fire extent and track its observed spread in near realtime using drone imagery and pose. Temperature and weather provide supporting context.
Affected components if implemented: backend ingestion/analysis, shared contracts, and frontend visualization. Vision and temporal mapping are separate from the optional LLM briefing component; placement of new processing code remains to be decided.

## Confirmed output

The user clarified: “detecting the existing fire spread.” Scope is the currently observed fire extent and its change over time. Future spread forecasting and pre-ignition prediction are outside this initial scope.

Proposed outputs: timestamped hotspot tracks, observed active-fire masks/polygons, locally observed front movement in metres/minute, direction in degrees clockwise from true north, newly observed fire area in square metres, and per-region confidence/quality and last-observed time. Only produce metric geometry after adequate geolocation; otherwise report image-space detections and unavailable ground metrics.

Distinguish active fire, residual hot ground, visible burned ground, smoke, and unobserved areas. An active-fire mask does not by itself establish a complete incident perimeter or total burned area.

## Inputs and derived outputs

| Input | Processing proposal | Output and limitations |
| --- | --- | --- |
| Drone position/orientation | Match frame capture time to GPS/IMU, altitude datum and gimbal pose; calibrate camera intrinsics and mounting offsets | Camera pose and uncertainty; intersect image rays with terrain/depth to obtain ground coordinates. GPS alone is not hotspot position. |
| Radiometric infrared | Decode calibrated measurements; account for emissivity and atmospheric/reflection parameters; segment thermal anomalies and track them | Hotspot masks, apparent surface temperature statistics, anomaly persistence and quality. Saturation means out-of-range, not an exact maximum. |
| Non-radiometric infrared | Detect relative thermal contrast | Hotspot candidates and relative intensity; do not infer degrees Celsius from a color palette. |
| Regular RGB camera | Fire/smoke segmentation, temporal tracking, visibility assessment; classify vegetation when evidence supports it | Fire/smoke masks, detection scores, vegetation/fuel-class candidates. Ordinary RGB does not provide reliable temperature. Species is optional and uncertain under smoke or low resolution. |
| Temperature sensor | Identify sensor type and placement, calibrate, timestamp and filter | An ambient probe measures conditions at the drone; a directed radiometer measures its target. Neither automatically describes the entire fire. |
| Weather API | Spatial/time lookup, unit normalization, freshness checks and caching | Wind speed/direction/gusts, humidity, air temperature, precipitation history and forecast. Preserve measurement height, resolution and forecast issue/valid time. |

FLIR documents that quantitative temperature requires radiometric capability and correct measurement parameters [1]. OpenCV documents camera calibration and projection geometry [2]. The proposed localization additionally needs terrain or depth and calibrated camera pose; these are not supplied by an image alone.

## Proposed processing pipeline

1. Ingest timestamped frames and telemetry. Preserve capture time separately from receipt time and measure clock offsets.
2. Run RGB and thermal perception independently, preferably close to the drone when bandwidth is constrained.
3. Align sensors geometrically and temporally. Track candidates across frames and georeference supported detections.
4. Fuse evidence into a current-state map. Track observation age, visibility and positional uncertainty. Missing imagery is not evidence of no fire. Do not blindly multiply correlated detector scores or label uncalibrated scores as probabilities.
5. Compare successive ground-referenced extents to estimate observed movement. Account for drone motion, occlusion and positional error before reporting growth.
6. Compare only ground areas with adequate observations at both timestamps. Newly visible terrain must not be labeled new spread. Estimate local front displacement over a measured interval, reject uncertain correspondences, and divide by elapsed time for speed. Avoid assuming the same boundary point remains identifiable as fronts merge or split.
7. Add weather and temperature as context. Fuel/species classification is optional enrichment, not a prerequisite for the observed-spread pipeline. Terrain/depth remains important for geolocation.
8. Publish current fire, recent observed spread, residual heat and coverage as separate layers, with quality flags and observation timestamps. An optional LLM may summarize these measurements; no spread simulator is required for the confirmed scope.

## Suggested measurement rules

- Use a local metric coordinate system for distances/areas and state its reference system; expose map coordinates with an explicit longitude/latitude convention.
- For a matched front segment, observed speed = ground displacement / elapsed time. Report the observation interval, not just a number.
- Choose intervals long enough that displacement exceeds combined registration/geolocation error. If movement cannot be resolved, return insufficient evidence rather than zero spread.
- A new fire mask outside the earlier mask is a candidate increase only within comparable coverage; confirm persistence and account for false detections and localization error.
- Give each map cell/feature its own timestamp. A drone survey creates observations at different times, not one simultaneous complete perimeter.

## Scheduling and latency — proposed targets to benchmark

- Decode the incoming stream; choose inference cadence after hardware measurements. A starting experiment is 5–10 analyzed frames/second, with tracking between expensive detections.
- Aim for updated detection/map results within 1–3 seconds of capture. This includes transmission, decode, inference, localization and display; it is not a performance claim.
- Update observed spread when a previously seen area has a new usable observation. Choose comparison windows based on revisit cadence and localization error; frame rate alone does not determine spread-measurement cadence.
- Refresh weather according to provider updates and cache headers, not every video frame.
- Bound queues and prioritize fresh data for live analysis; record dropped frames and keep archival recording separate if needed. Show degraded/stale state after connectivity loss.

## Validation and missing prerequisites

Obtain camera/drone specifications, radiometric formats, telemetry timestamps, gimbal angles, altitude conventions, compute hardware, uplink performance, geography, terrain/depth coverage, revisit cadence, and labeled sample flights.

Evaluate false alarms per flight-hour, missed-fire rate, detection delay, geolocation error and capture-to-display p95 latency. Split training and evaluation by incident/location, not adjacent frames. Test smoke, sun-heated surfaces, sensor saturation, missing feeds, changing camera pose and network delays.

Evaluate observed extent and local movement against annotated, georeferenced sequences. Measure boundary error, area error and spread-speed error over stated intervals. Include newly revealed terrain and stationary fires viewed from a moving drone to check that camera movement and changing coverage do not create false spread. Future forecasting would need a separate design and validation effort.

## Sources

Accessed 2026-09-26; primary technical sources. Proposed architecture and timing above are our engineering recommendations, not claims by these sources.

1. [FLIR — Measuring temperatures](https://docs.flir.com/T810605/en-US/latest/s10.html)
2. [OpenCV — Camera calibration](https://docs.opencv.org/4.13.0/d4/d94/tutorial_camera_calibration.html)
3. [US Forest Service — Fire Behavior](https://research.fs.usda.gov/fire/firebehavior)
4. [US Forest Service — Fuel Characteristic Classification System](https://research.fs.usda.gov/pnw/projects/fccs)

[Decision log](../../../AGENTS.md)
