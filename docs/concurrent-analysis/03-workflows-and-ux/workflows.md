# Workflows and interface implications

Reviewed 2026-09-26. Workflow sequences below are our synthesis, not a verified walkthrough of the commercial application.

## Reference workflow

Tactical Analyst describes combining incident, resource, weather, and prediction information, including map bookmarks and downloadable reports. fiResponse describes managing incidents and resources through their lifecycle. [S04](https://technosylva.com/products/tactical-analyst/), [S05](https://technosylva.com/products/firesponse/)

## Proposed first workflow

1. Open a selected region and time window.
2. Inspect fire observations and available weather context.
3. Select an observation or incident and inspect source, timestamp, and quality information.
4. Review nearby assets when an appropriate exposure dataset is available.
5. Produce a brief with source links, time bounds, missing data, and analyst notes.

## Proposed screen structure

| Area | Purpose |
| --- | --- |
| Main map | Spatial context and selectable observations |
| Filter panel | Region, time, source, layer visibility |
| Detail panel | Selected feature, evidence, weather context, notes |
| Freshness indicator | Observation time, ingestion time, stale or unavailable feeds |
| Brief view | Review and export the selected evidence |

## Design questions to resolve

- Desktop analysis versus field use changes density, connectivity, and controls.
- A detection should not automatically become a confirmed incident.
- Observed, forecast, and illustrative layers need distinct labels and legends.
- Empty results, unavailable feeds, and no observations in the time window need different states.
- Color should be reinforced with text or symbols.

No authenticated UI, precise layout, interaction performance, visual theme, or accessibility behavior was verified. A visual audit remains separate work.
