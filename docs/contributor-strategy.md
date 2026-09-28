# Technical contribution backlog

Reviewed 2026-09-28. These are proposed tasks, not assigned or published issues.
Start with [CONTRIBUTING](../CONTRIBUTING.md), then agree scope and acceptance
criteria in an issue before substantial work. Review owners are unassigned.

The initial observation-research scope is detecting existing fire extent and
tracking observed changes ([DR005](../AGENTS.md)). The repository also contains an
experimental spread simulator. Forecast and response-evaluation tasks below are
separate research proposals; they do not expand the accepted observation milestone
or establish operational readiness.

## Existing components and evidence gaps

This inventory describes code and recorded research, not a fresh rerun of the
scientific experiments. Follow each linked report for its date and limitations.

| Area | Existing evidence | Contribution that advances the intended use |
|---|---|---|
| Spread simulation | [Kernel](../frontend/sim/src/model.ts), [Rothermel calculations](../frontend/sim/src/rothermel.ts), shared browser/server execution | Review units, assumptions and propagation against independent reference cases; distinguish numerical correctness from forecast skill |
| Environmental inputs | [Provider registry](../frontend/api/src/providers/registry.ts): terrain, fuel, weather, canopy, burn history, barriers and structures, with fallbacks | Validate vintage, spatial resolution, missingness and provenance at forecast issue time |
| Machine learning | [Canopy provider](../frontend/api/src/providers/canopy-learned.ts) and [training](../frontend/api/src/canopy/train.py): trees with regional cross-validation | Audit target provenance and geographic transfer; add direct canopy rasters where available; propagate input uncertainty |
| Current fire observations | [FIRMS provider](../frontend/api/src/providers/firms.ts) rasterizes thermal detections | Hotspot pixels are not a surveyed perimeter. Build observation-quality and time-alignment checks before assimilation |
| Historical evaluation | [Hindcast](../frontend/api/src/hindcast.ts) uses reported origin where available, otherwise perimeter centroid, and sweeps suppression | Separate retrospective diagnostics from a fixed, information-at-issue-time forecast evaluation; prohibit outcome-derived ignition fallback in that benchmark |
| Historical analogs | [Recorded findings](concurrent-analysis/09-historical-similarity/findings.md) show retrospective association, including covariates selected using burned ground | Construct forecast-available features before interpreting analog matching as predictive skill |
| Image research | [Human-review handoff](concurrent-analysis/09-observation-baseline/review-handoff.md): 25 pilot images, two independent review packets, no accepted human labels | Recruit two qualified reviewers and an adjudicator; separate visible flame, smoke and unknown pixels |
| Dated references | [Satellite transfer audit](concurrent-analysis/09-observation-baseline/satellite-transfer.md), [IR readiness audit](concurrent-analysis/09-observation-baseline/reference-readiness.md) | Verify survey capture times and label meaning. Edits to geometry are not necessarily fire progression; timing and topology failures must remain in reports |
| Response/exposure | Kernel supports dozer, retardant and suppression; `containment` is a computed edge fraction; `structuresLost` counts structures on burned cells or uses assumed density | Review terminology and scenario validity. Exposure is not verified destruction, and modeled held edge is not an incident's reported containment |

The highest-value bottleneck is **credible evaluation and practitioner input**.
An additional large model will not resolve ambiguous observation times, missing
intervention records or unreviewed labels. ML work can contribute through canopy
estimation, observation models, uncertainty and later correction models on qualified
training data. LLMs can help extract cited report facts, but do not provide physical
ground truth or validate containment effectiveness.

## Scoped contribution proposals

Effort descriptions are rough scoping estimates. Begin with setup reproduction
(C09), dated reference verification (C03), or qualified independent image review
(C02). C04, C06 and C10 need research design and review; they are not beginner issues.

| Draft | Who / approximate scope | Deliverable and acceptance evidence |
|---|---|---|
| C01 — Review the incident-analysis workflow | FBAN or incident GIS specialist; 1–2 short sessions | Annotated walkthrough of observed state → forecast → community exposure → response alternatives; record required time horizon, missing inputs and misleading outputs; keep research advice distinct from agency endorsement |
| C02 — Independently review 25 pilot RGB cases | Two qualified image reviewers plus an adjudicator; start with a five-image timing trial | Separate original exports from the existing review packets, unknown regions preserved, experience and independence recorded, agreement report and unresolved disagreements; do not automatically freeze the benchmark |
| C03 — Verify one dated reference perimeter | Geospatial/fire-data researcher; one incident first | Original survey/report, stable incident identity, capture time/timezone evidence, geometry audit and redistribution terms; explicitly fail acceptance if only an edit time is known |
| C04 — Define and implement one forecast replay contract | Research/software pair; multi-session | Fixed issue time and horizon, input-availability ledger, pre-issue observation, independent later reference, whole-incident splits and unchanged baseline; report missing/late inputs. No final-perimeter centroid, future footprint or outcome-tuned suppression as forecast inputs |
| C05 — Audit canopy inputs and add a direct US reference adapter | Geospatial/ML engineer; bounded region | Provider returns native units, source year, coverage and missingness; compare the learned estimate with source rasters on separate regions. Keep non-US generalization unproven |
| C06 — Make response assumptions inspectable | Fire-behavior researcher + simulator developer; research task | Document the current dozer blocking, retardant factor and suppression hazard. Propose time/resource constraints, failure assumptions and sensitivity cases; practitioner review before claims of operational containment benefit |
| C07 — Distinguish exposure from losses and modeled held edge from containment | Frontend developer + domain reviewer; small issue | UI and export terminology align with computed quantities, source provenance and uncertainty; no unchanged numeric formula relabeled as an observed outcome |
| C08 — Add Python research checks to CI | Python/tooling contributor; small issue | Run hermetic contract/unit tests on a clean runner; network downloads and credentials remain opt-in. Existing frontend CI is preserved; a passing test is not advertised as scientific validation |
| C09 — Reproduce first-run setup | Beginner/documentation contributor; one OS | Fresh-clone install report, exact runtime/commands, actionable setup fix and screenshots. No full archive or Earth Engine access required to view bundled history; separately record online data requirements |
| C10 — Add forecast uncertainty evaluation | Statistician/ML researcher; after C03/C04 | Predeclared ensemble inputs and uncertainty target, calibrated coverage/reliability on held-out incidents and per-fire aggregation; report boundary error, missed spread, exposure timing, runtime and abstentions, not only area overlap |

## Choosing and completing a task

- Check open issues and PRs for overlap, identify a reviewer, and state the component.
- Preserve failing cases and unknown values in the deliverable, with reproducible inputs.
- For response comparisons, pair scenarios using the same initial state, weather
  members and random seeds; record resource and construction-time assumptions.
- Agreement with observed growth does not establish the counterfactual benefit
  of a containment action. Keep scientific acceptance separate from CI results.

The repository has a [project license](../LICENSE), [contribution guide](../CONTRIBUTING.md)
and [data guide](research-data/README.md). Third-party data and model terms remain
separate. See [GitHub configuration](../.github/configuration.md) for repository
settings; the presence of a template does not prove that a review rule is enabled.
