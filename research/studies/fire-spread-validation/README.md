# Fire-spread validation

Status: **proposed**. Created: 2026-09-28. Contributors and reviewer: unassigned.
This is a future research proposal, not authorization to change the current simulator
or a claim that a new validation experiment has run.

## Research question

Under which documented input and observation conditions can a simulator's growth
be meaningfully compared with a historical fire perimeter?

## Proposed scope and method

First review the [existing simulation evaluation](../../../docs/simulation-evaluation.md)
and [historical-data study](../historical-data-quality/README.md). Define one event,
forecast/observation interval, initial state, input availability, reference uncertainty
and known/unknown intervention status. Separate calibration from held-out evaluation.
Specify area and spatial metrics, baselines and uncertainty before tuning.

Historical fires include suppression, while the intended comparison may omit it.
Address that mismatch explicitly using supported restrictions or sensitivity analysis;
an undocumented interval must not be labeled unsuppressed. Realized burn-footprint
covariates cannot serve as prospective inputs. Agreement is not proof of causality.

## Deliverable and acceptance

A reproducible evaluation protocol, eligibility criteria and an evidence-backed
assessment of whether available references support the comparison. If they do not,
report the blocking data gaps. Acceptance of the protocol does not establish
operational forecasting accuracy or readiness.

## Reproduction and next step

Record the chosen kernel/provider versions, data hashes, configuration, commands and
expected artifacts before running. Reusable simulator changes stay in
[`frontend/sim/`](../../../frontend/sim/); study-specific notebooks may live here.
Copy the [protocol/findings template](../../templates/study/README.md) when the scope
is agreed. No new commands, metrics or results are claimed in this proposal.
