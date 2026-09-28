# Suppression effects in historical fire records

Status: **proposed**. Created: 2026-09-28. Contributors and reviewer: unassigned.
No new intervention dataset or completed study is claimed.

## Research question

For one GOFER pilot fire, can official evidence identify when and where suppression
occurred well enough to characterize its influence on historical comparisons?

## Proposed scope and method

Start with Creek Fire and an official incident report. Record exact passage/page,
source version/hash, observation time or range, spatial scope, intervention type,
and review status. Keep reported times distinct from inferred or publication times.
Join evidence to existing event/interval IDs only when the match is justified.
Unknown timing remains unknown; absence of a report is not evidence of no intervention.

## Deliverable and acceptance

A reviewed evidence table, a documented interval-linkage method and an explicit
assessment of whether any pre-intervention window can actually be supported. A
finding that no reliable window exists is valid. Do not estimate a causal suppression
effect from timing alone or automatically remove reported interventions from growth.

## Reproduction and next step

Use the [document-extraction module](../../../backend/llm/README.md) and
[source register](../../../docs/research-data/sources.md) where applicable. Human
review is required for accepted extracted facts. Agree on one source and an evidence
format, then add `protocol.md` and `findings.md` from the [template](../../templates/study/README.md).
Any shared intervention schema belongs in `contracts/` with producer/consumer review.
No experiment commands or measured results exist for this proposal yet.
