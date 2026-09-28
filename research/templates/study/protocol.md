# Study protocol

Protocol date/version: not set. Status: proposed.

## Question, scope and acceptance criteria

Define the hypothesis or audit question, population/events, geography, temporal
resolution and what evidence would support, reject or leave it unresolved. Identify
planned baselines and metrics where relevant. A data-quality audit need not predict.

## Data and provenance

For each input record publisher URL, dataset/version, license or terms, acquisition
route, retrieval date, checksum and local/external artifact location. State what is
available, missing or restricted. Link shared schemas instead of redefining them.

Define event/interval identity, units, CRS, native resolution, observation versus
processing time, spatial support, missingness and source conflicts. State how human
intervention is known or unknown and which variables are retrospective.

## Method and evaluation

Describe processing and derivations, eligibility/exclusions, quality checks,
independent sampling units, uncertainty and sensitivity analysis. If comparing or
training models, separate development and evaluation events and prevent temporal,
geographic or outcome leakage. Document where independent review is required.

## Reproduction plan

Record code revision, working directory, environment/dependency lock, commands,
random seeds, expected outputs, compute/access requirements and estimated download
size when known. Use placeholders for credentials. Cite existing component runners.

## Amendments

None. Record date, change, reason and whether evaluation results were already seen.
Keep failed approaches and protocol deviations inspectable.
