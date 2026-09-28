# FireWatch: instructions for Codex and contributors

## Purpose and current state

Use this guide to choose where a task belongs and coordinate changes across the team.
Contributors may use any editor or assistant. Keep these instructions in the repository
so every checkout has the same guidance. This is a working research prototype with a
TypeScript frontend/simulation stack and optional Python research modules. Discover
commands from the component READMEs and configuration; do not infer deployment or
notification guarantees from the presence of a scaffold or workflow file.

## Directory guide

| Path | Put work here | Examples and boundaries |
| --- | --- | --- |
| `backend/api/` | Python historical acquisition, normalization, enrichment, exports and tests | Follow the component README. The active TypeScript simulation HTTP/WebSocket server lives in `frontend/api/`; keep document-model logic in `backend/llm/`. |
| `backend/llm/` | Model integrations, prompts, retrieval, structured-output parsing, and evaluations | Summarizing an incident, extracting alert fields, testing prompt quality. Return structured results to the API; keep HTTP routes and UI components elsewhere. |
| `backend/vision/` | RGB/thermal perception research, dataset adapters, baseline/model evaluations and component tests | Offline fire observations and quality checks. Put new study protocols in `research/studies/`; existing evidence remains in `docs/concurrent-analysis/` and shared research data formats in `contracts/research/`. Do not present experimental masks as confirmed live fire perimeters. |
| `frontend/` | The web application, routes/pages, layout, API clients, state, forms, and shared UI | Dashboard navigation, settings forms, loading/error states. This is the parent application directory; do not put all frontend code in visualization. |
| `frontend/src/visualization/` | Maps, charts, spatial layers, legends, and visual interaction components | Fire markers, heatmaps, timelines, map selection. Consume frontend data or shared contracts; never call model providers directly from the browser. |
| `contracts/` | Shared API schemas, event/data formats, and example requests/responses | Alert payloads, coordinate conventions, timestamps, error formats. Keep language-neutral definitions here when possible; avoid duplicated independently maintained schemas. |
| `research/` | Study protocols, experiment-specific notebooks/scripts, findings and review records | Use the study template and contribution guide. Reusable code stays in its component; shared contracts stay in `contracts/`. |
| `docs/` | Architecture, setup instructions, team decisions, and integration notes | Explain a dependency, record a schema migration, document local setup. Keep executable application logic in its component folder. |
| `.github/` | GitHub configuration, ownership rules, PR/issue templates, and workflows | `CODEOWNERS` and `workflows/` for CI or push notifications. A directory or README alone does not enable notifications or branch protection. |
| Repository root | Project-wide instructions and necessary shared configuration | `AGENTS.md`, overview README, workspace/build configuration. Treat root configuration and shared lockfiles as cross-team changes. |

Place component tests beside their implementation or under that component's test
directory, following the conventions established when its stack is introduced.
Put shared contract fixtures in `contracts/`. Document the location of future
cross-component integration tests before introducing a new test layout.

## Choose the scope before editing

1. Read this file, relevant folder READMEs, and any more specific `AGENTS.md` files.
2. Inspect the actual checkout, branch, and working-tree status. Preserve existing
   changes; do not reset, clean, overwrite, or stash another contributor's work.
3. State the task, affected directories, and cross-component dependencies in the
   task description or PR. Use an existing issue/PR as the coordination record.
4. Keep changes within the task's scope. Necessary cross-folder changes may be made
   together, but explain them and involve the affected component's contributor.
   Do not require approval for routine edits already authorized by the task.
5. Do not invent named owners. Until ownership is recorded in `CODEOWNERS` or team
   documentation, identify responsibility by component and flag missing assignments.

## Work directly on main

- User preference: use `/Users/rubenpersonal/WebstormProjects/firewatch-ai` and make
  changes directly on `main`, using `main` as the source for new work.
- Do not create task branches, additional worktrees, or sibling project directories
  unless the user explicitly requests them.
- Coordinate concurrent edits in the existing checkout and preserve all existing work.
- Inspect or fetch the latest remote state before starting when access is available.
  Never discard local work to synchronize. Report unavailable remote access.
- Keep commits and PRs focused. Avoid unrelated formatting, generated-file churn,
  dependency updates, or shared lockfile changes.
- Before integration, check for overlapping PRs and changes to shared contracts.
  Use the repository's review process and report unresolved conflicts.

## Coordinate interfaces

- Current simulator flow: `frontend/src/` -> optional `frontend/api/` -> shared
  simulation kernel and source providers. Python historical and vision tools run
  separately; there is no general frontend-to-LLM runtime integration.
- Future authenticated APIs must own server-side validation and authorization;
  secrets and provider credentials stay server-side. The local simulation API
  currently has no authentication or per-incident authorization.
- For an interface change, update the contract and realistic sample payloads first
  or in the same PR, then update affected producers and consumers.
- Specify field meaning, units, coordinate order/reference system, timestamps/time
  zones, optional/null behavior, and error cases when applicable.
- Prefer backward-compatible additions. Explicitly identify breaking changes and
  document the migration and affected consumers in `docs/` and the PR description.
- UI contributors may use contract-based fixtures while backend work is pending;
  label mock data clearly and do not present it as a live integration.
- Changing an LLM output shape can affect API validation and UI rendering even when
  only prompt files changed. Review those dependencies and relevant evaluations.

## Validate and hand off

- Discover documented commands from the actual project configuration; never invent
  commands or claim checks passed without running them.
- Run checks relevant to the change: API validation/tests for endpoints, LLM
  evaluations for prompt/output changes, frontend checks and visual inspection for
  UI changes, and producer/consumer checks for contracts.
- Documentation-only edits need a content/path review, not a new test suite.
- Never commit credentials, private production data, or local environment secrets.
  Use sanitized fixtures and document environment variable names without values.
- Summarize what changed, affected folders, checks performed, limitations, and any
  action another contributor must take. Include the PR or commit link when available.
- Do not assume another Codex chat or teammate automatically receives context.
  Record durable decisions in the repo or PR. Send messages or mentions only when
  the user has authorized the recipients and purpose.
- Automatic push notifications require a separately configured workflow. Until
  verified, do not claim the team was notified or that monitoring is active.


## Research and product decisions

Record future decisions here with date, status, rationale and supporting research. Keep competitor and related feasibility research categorized under the existing `docs/concurrent-analysis/` directory.

| ID | Date | Status | Decision and rationale |
| --- | --- | --- | --- |
| DR001 | 2026-09-26 | User direction | Investigate near-realtime Firewatch AI using drone position/orientation, RGB/infrared video, a temperature sensor, and weather API data. |
| DR002 | 2026-09-26 | Superseded for initial scope by DR005 | Separate detection, geolocation, physical spread forecasting and optional LLM explanation; each has different inputs and validation requirements. See [pipeline research](docs/concurrent-analysis/08-drone-realtime/pipeline.md). |
| DR003 | 2026-09-26 | Output scope resolved by DR005; hardware unresolved | Confirm whether final prediction means existing-fire detection, future spread, or pre-ignition risk. Camera hardware, geography, horizon and latency requirements remain open. |
| DR004 | 2026-09-26 | Superseded for new contributor studies by DR015 | Extend the existing `docs/concurrent-analysis/` location rather than create a duplicate root folder. No application stack or processing implementation selected. |
| DR005 | 2026-09-26 | Accepted — user clarification | Focus on detecting existing fire extent and tracking its observed spread over time. Future spread forecasting and pre-ignition prediction are outside the initial scope. Update [pipeline research](docs/concurrent-analysis/08-drone-realtime/pipeline.md) accordingly. |
| DR006 | 2026-09-26 | Proposed processing approach | Use synchronized RGB/infrared segmentation, ground geolocation and temporal comparison with coverage/uncertainty checks. Weather and temperature are supporting context; species classification and an LLM are optional. Metric spread requires adequate pose, calibration and terrain/depth. |
| DR007 | 2026-09-27 | Accepted research start; baseline milestone implemented | User authorized R01 and selected public datasets. Start with an offline, reproducible RGB/thermal baseline in `backend/vision/`, incident-separated evaluation, explicit unknown timestamps and independent label review. [First experiment](docs/concurrent-analysis/09-observation-baseline/README.md) uses a 24-pair FLAME 3 pilot; learned-model improvement and unseen-incident validation remain unproven. Vision/research ownership is unassigned. |
| DR008 | 2026-09-27 | M1 acquisition/audit executed; benchmark acceptance open | Acquired 992 FLAME2 RGB/IR/mask triplets. Keep the single inspected incident in pilot, preserve publisher multimodal fire/smoke semantics and display-only IR, and block an unseen-incident visible-flame benchmark until compatible independently reviewed masks and separate incident/site groups exist. [M1 evidence and split gate](docs/concurrent-analysis/09-observation-baseline/milestone-1.md). Boreal is a separate smoke candidate; its public catalogue splits reuse sites. |
| DR009 | 2026-09-27 | User direction; review preparation completed, acceptance pending | User confirmed no human reviewers are available and requested preparation with the gap recorded. Prepared separate RGB-only annotation packets for two humans on 25 pilot cases and comparison tools with explicit unknown handling. No human review, accepted labels, benchmark freeze or M2 training is claimed. [Handoff and remaining dependencies](docs/concurrent-analysis/09-observation-baseline/review-handoff.md). |
| DR010 | 2026-09-27 | User authorized; first satellite development case executed | Built the dated Cypress Creek Sentinel-2 Collection 1 case with fixed NBR/dNBR rules, cloud/coverage checks and frozen provenance. Preserve uncertain perimeter time and label overlap exploratory; do not equate this with drone M1 acceptance, time-matched accuracy or model generalization. [Experiment and remaining evidence](docs/concurrent-analysis/09-observation-baseline/cypress-creek-experiment.md). |
| DR011 | 2026-09-27 | Reference audit and transfer pilot executed; validation open | Cypress daily geometry edits are not verified progression times. Two additional metadata-selected incidents retain unchanged rules: Rawlins fails coverage; County Rd 169 passes coverage but the fixed pre-NBR floor largely rejects mapped extent. Preserve failures and acquisition-policy amendments; obtain independent dated references and use new incidents before evaluating a tuned method. [Transfer evidence](docs/concurrent-analysis/09-observation-baseline/satellite-transfer.md). M1 human review remains open. |
| DR012 | 2026-09-27 | IR reference acquired and screened; time-matched evaluation not admitted | Acquired FireBench Caldor 2021 release 2026.2 NIROPS KML subset with explicit publisher times and file checksums. Sixteen of 21 geometries pass without repair; zero covering Sentinel groups meet the provisional six-hour gap. Preserve publisher-curated time status, invalid geometries and endpoint uncertainty. Caldor is reference development, not held-out accuracy; existing thresholds and M1 review gap remain unchanged. [Reference audit and next protocol](docs/concurrent-analysis/09-observation-baseline/reference-readiness.md). |
| DR013 | 2026-09-27 | User-directed; local CUDA environment verified, evaluation pending | Prepare an inference-only Cypress Creek evaluation of the existing NASA/IBM Prithvi-EO burn-scar checkpoint on HLS imagery. Preserve six-band input order, Fmask unknowns and fixed dNBR comparison; no Cypress fine-tuning or generalization claim. Local Windows RTX 3050 environment and CUDA tensor smoke test pass; 512x512 model inference remains unverified with 4 GB VRAM. HLS acquisition and time-matched reference remain unresolved; cloud compute is optional. [Experiment protocol](docs/concurrent-analysis/09-observation-baseline/prithvi-cypress-creek-experiment.md). |
| DR014 | 2026-09-27 | Local pretrained-model execution verified; Cypress evaluation pending | Downloaded and hash-verified the selected Prithvi-EO-1.0-100M checkpoint. The newer NASA workshop uses a different v2 300M model, so retain the original 100M architecture through an inference-only adapter with strict weights loading and published 224/112 crop/stride. A real 512x512 publisher HLS demo passed on RTX 3050; extracted original inference calculations matched on one crop. Public Cypress discovery found ten granules, but Earthdata account setup, authenticated imagery screening and case evaluation remain pending. No training, accuracy or generalization claim; drone M1 review gap unchanged. [Execution evidence](docs/concurrent-analysis/09-observation-baseline/results/prithvi-local/README.md). |
| DR015 | 2026-09-28 | Accepted — user direction | Establish `research/` for contributor studies, protocols, study-specific notebooks/scripts and findings. Migrate historical data quality first with a forwarding page; retain other dated studies and background analysis in existing docs until individually migrated. Reusable implementations and shared contracts remain in their components. See [research guide](research/CONTRIBUTING.md). |
