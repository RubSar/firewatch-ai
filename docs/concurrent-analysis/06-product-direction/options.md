# Product direction options

Reviewed 2026-09-26. Everything here is proposed, not approved scope.

| Option | Demonstrated value | Tradeoff |
| --- | --- | --- |
| A. Situational-awareness analyst workspace — recommended | Explore observations and weather, inspect evidence, create a brief | Useful end-to-end workflow; does not demonstrate validated spread forecasting |
| B. Historical scenario explorer | Replay one documented incident and compare time steps and contextual layers | Repeatable demonstration; historical input must be clearly labeled |
| C. Utility asset-risk planner | Explore provided asset exposure and compare priorities | Needs asset inventory and a defensible scoring method; harder without a partner dataset |

## Recommendation and rationale

Start with A, optionally using an explicitly labeled historical dataset for a repeatable demonstration. It tests whether combining evidence helps a specific user complete a real task, while leaving model development as its own workstream.

Candidate scope: one region, map and time filters, selected-observation details, weather context, source/freshness display, and a reviewable brief. Add exposure analysis only if a suitable dataset is available.

Candidate exclusions for that first version: automated dispatch, power-shutoff recommendations, evacuation decisions, original spread modeling, comprehensive multi-hazard planning, billing and enterprise administration.

## Suggested success criteria

A user can find a relevant observation, inspect its supporting evidence, identify stale or missing inputs, and export an accurate brief. Any numeric target for response time or task completion should be chosen after expected data volume and user needs are known.

## Decisions needed next

First choose the primary user. Then choose geography, prototype versus pilot expectations, available data, and the meaning of similarity to Technosylva. Deadline and budget will determine the depth of each workflow.

The authoritative status of these proposals is in [AGENTS.md](../../AGENTS.md), D004–D005.
