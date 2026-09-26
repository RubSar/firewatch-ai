# FireWatch: instructions for Codex and contributors

## Purpose and current state

Use this guide to choose where a task belongs and coordinate changes across the team.
All contributors use Codex. Keep these instructions in the repository so every checkout
has the same guidance. This is currently a directory scaffold: do not assume a framework,
package manager, test command, deployment setup, or notification workflow exists.

## Directory guide

| Path | Put work here | Examples and boundaries |
| --- | --- | --- |
| `backend/api/` | HTTP endpoints, validation, application services, persistence adapters, and server-side authorization | Alert endpoints, filtering, database access, invoking the LLM module. Keep prompts and model-provider logic in `backend/llm/`. |
| `backend/llm/` | Model integrations, prompts, retrieval, structured-output parsing, and evaluations | Summarizing an incident, extracting alert fields, testing prompt quality. Return structured results to the API; keep HTTP routes and UI components elsewhere. |
| `frontend/` | The web application, routes/pages, layout, API clients, state, forms, and shared UI | Dashboard navigation, settings forms, loading/error states. This is the parent application directory; do not put all frontend code in visualization. |
| `frontend/visualization/` | Maps, charts, spatial layers, legends, and visual interaction components | Fire markers, heatmaps, timelines, map selection. Consume frontend data or shared contracts; never call model providers directly from the browser. |
| `contracts/` | Shared API schemas, event/data formats, and example requests/responses | Alert payloads, coordinate conventions, timestamps, error formats. Keep language-neutral definitions here when possible; avoid duplicated independently maintained schemas. |
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

## Work in isolated checkouts

- Use a short-lived branch per task, normally `codex/<short-task-name>`.
- Concurrent Codex chats on the same machine should use separate worktrees/checkouts.
  Component folders alone do not isolate Git state or simultaneous file edits.
- Inspect or fetch the latest remote state before starting when access is available.
  Never discard local work to synchronize. Report unavailable remote access.
- Keep commits and PRs focused. Avoid unrelated formatting, generated-file churn,
  dependency updates, or shared lockfile changes.
- Before integration, check for overlapping PRs and changes to shared contracts.
  Use the repository's review process and report unresolved conflicts.

## Coordinate interfaces

- Expected flow: frontend -> API -> LLM module/provider. The API owns server-side
  validation and authorization; secrets and provider credentials stay server-side.
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

