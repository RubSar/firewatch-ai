# FireWatch statistics handbook

Reviewed 2026-09-26 against the local code, contracts, and five FireWatch chats.
This document separates implemented choices from research and unvalidated assumptions.

## What are we building?

A hackathon prototype for fire agencies and emergency responders: compare terrain,
fuels, weather and wind with historical incidents, sample possible growth through
Monte Carlo simulation, and compare a one-hour predicted perimeter with the actual
outcome. Four 0–100 matching indices are proposed; their calibration, similarity
search and spread simulation are not implemented. Preserve physical measurements,
units, dates and sources alongside any index.

## Why a 28 km buffer?

**28 km is a user-selected investigation distance, not a validated forecast or
safety boundary.** A contextual rationale is rounding up the documented Boonoke
grassfire advance: 25 km in 55 minutes = **27.3 km/h**. This is one extreme example,
not a universal maximum; faster short bursts have been reported. The chats do not
establish that this statistic was the original reason for selecting 28 km.
[Wildfire spread research](https://www.mdpi.com/2571-6255/5/2/55).

The historical rate describes forward advance. Our buffer extends in **all
directions** to define a consistent area to investigate; it does not predict equal
spread in every direction or guarantee containment for an hour.

`investigation area = buffer(fire perimeter, 28 km) − fire perimeter`

Distance starts at the supplied perimeter, not its centre. Corners round and nearby
parts can merge. A circular fire of radius 50 km gives approximately 78 km outer
radius and, under a flat-circle approximation, π(78² − 50²) ≈ **11,259 km²** of
investigation area. Production geometry uses regional projections and geographic
area calculations. “Outside the fire” does not independently prove land is unburned.

## Why these sizes and thresholds?

| Choice | Current meaning and rationale |
| --- | --- |
| **20 m analysis resolution** | NDMI uses Sentinel-2 B11 at 20 m; B8 and Dynamic World probabilities are aligned to that grid. Native 10 m land cover does not make the moisture evidence 10 m. |
| **5,000 m output-cell side** | Current default for manageable regional summaries: a full cell is 25 km². Boundary cells are clipped. This is an engineering default, not an optimal scientific scale. |
| **Map zoom** | Display scale, separate from analytical resolution. The browser RGB demo lowers tile zoom to request at most 48 tiles; it is not the satellite scoring pipeline. |
| **1–31 day imagery window** | API limit for temporal aggregation and workload. Match acquisition timestamps and geographic tiles; retain dates. A longer average can hide recent change. |
| **DW top-class probability ≥0.6; valid coverage ≥70%** | Prototype evidence filters, not validated accuracy guarantees. Coverage measures usable area, not confidence. |

The earlier 5.12 km image-tile suggestion was exploratory, not implemented.
[Satellite method and contract](../contracts/fuel-index.md).

## What does the 0–100 score mean?

An **experimental relative vegetation/dryness score**, not fire probability,
official Burning Index, measured fuel moisture, or speed:

`V = sum of trees, grass, flooded vegetation, crops and shrub probabilities`

`D = clamp((0.4 − vegetation-weighted NDMI) / 0.6, 0, 1)`

`score = round(100 × V × D, 1)`

NDMI anchors −0.2 and +0.4 are unvalidated assumptions. Zero does not mean “cannot
burn”; unknown stays `null`. Built-area probability ≥0.2 withholds scoring.
The regional mean weights scored cells by observed area; unknown area is reported
separately. Mean class probability is not measured land-cover percentage.
[Complete rules](../backend/api/fuel_service/scoring.py).

## What exists, and what remains?

| Location | Responsibility and status |
| --- | --- |
| `frontend/` + `frontend/visualization/` | Vite/Leaflet map, polygon drawing, buffer, export and Esri RGB screening. Optional Google selection. Not connected to satellite scores yet. |
| `backend/api/` | FastAPI: supplied fire → buffer → investigation cells → Earth Engine evidence → scores/GeoJSON. It does not detect the fire. |
| `backend/llm/` | Placeholder for extraction/explanations; no LLM is used in current scoring. |
| `contracts/`, `docs/`, `.github/` | Interfaces/examples, methods, and team configuration respectively. Notifications remain unconfigured. |

The saved [live investigation example](../contracts/examples/fire-investigation-response.live.json)
contains **125 cells: 111 scored, 14 withheld**, with real satellite evidence around
a hypothetical fire. This demonstrates execution, not predictive accuracy.

Historical GOFER/ERA5 research exists. Multi-fire matching, validation and the
proposed drone/thermal pipeline remain future work.

## Rules for answering statistical questions

- Keep **km/h** (linear advance) separate from **km²/h** (area growth); never infer
  a circular burned area from forward speed.
- Report method, interval, imagery date, coverage and missing values.
- Validate on held-out hourly perimeter pairs using only inputs available at
  prediction time; measure overlap, area error and uncertainty calibration.
- Next steps: connect the map to `/v1/fire-investigation`, validate score thresholds,
  then implement and evaluate historical matching and simulation.

Review sources: **statistics**, **Image-to-Fuel Index**, **Workflow**,
**Analyze Technosylva’s fire solutions**, **Plan GitHub Team Sync**. Latest code and
[service notes](fuel-index-service.md) supersede older chat status reports.
