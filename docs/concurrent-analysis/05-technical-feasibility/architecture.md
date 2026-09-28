# Technical feasibility

> Dated background research, not current application setup or accepted scope.
> See the [research index](../README.md) and [decision log](../../../AGENTS.md).

Reviewed 2026-09-26. This was a conceptual proposal before application implementation; it does not describe the current checkout.

## What public research does not establish

The reviewed product pages do not disclose enough to identify Technosylva's frontend framework, backend, database, cloud topology, proprietary model implementation, or integration contracts. No equivalent API access has been established for Firewatch AI.

## Candidate component boundaries

| Component | Responsibility | Dependency |
| --- | --- | --- |
| Source adapters | Retrieve and normalize observations and weather | Selected providers and access terms |
| Spatial store | Retain geometry, time, provenance, and versions | Data volume and query patterns |
| Query service | Filter and combine available context | Normalized records |
| Map client | Render layers, selections and freshness | Query service and map provider |
| Brief generator | Summarize an explicit evidence bundle | Evidence retrieval; optional language model |
| Scenario engine, later | Run and version physical simulations | Validated model, terrain, fuels and weather |

This separation would let a replay dataset and live feeds serve the same analyst interface.

## Feasibility tiers

- Lower initial complexity: bounded-region observation map, source details, filtering and deterministic brief export.
- Moderate complexity: feed refresh/retries, cross-source identity matching, spatial exposure queries and grounded language-model summaries.
- Major separate effort: validated spread forecasting, calibrated loss estimates, offline multi-agency synchronization and operational dispatch.

## Questions before choosing technology

Expected region size, update cadence, dataset volume, deployment target, map licensing, budget, authentication needs, and whether external API credentials are available.

## Suggested validation

Check coordinate/time normalization, duplicate ingestion, stale-feed behavior and evidence-to-brief traceability. If prediction is later included, assess calibration and historical performance separately from interface correctness.
