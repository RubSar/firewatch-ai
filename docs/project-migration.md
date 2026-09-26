# Project migration — 2026-09-26

User-selected source: `/Users/rubenpersonal/WebstormProjects/firewatch-ai`.
The fuel service, connected map, API contracts, fixtures, lockfiles and implementation
docs were copied from `/Users/rubenpersonal/Documents/ChatGPT/FireWatch`.
All future work on this implementation should use the new checkout.

Existing Git metadata, AGENTS.md (including research decisions), IDE configuration,
research documents and frontend/Wildfire were preserved. The two differing component
README files were merged. The earlier folder remains a backup, not the active source.
No credentials, .env.local files, Git metadata or old virtual environments were copied.
Dependencies are recreated at the new location from the existing lockfiles.

Scope: backend/api, frontend, contracts, docs, plus root README navigation. This is
a location change; it does not change product scope, research decisions, or combine
the fuel-score map with the separate Wildfire application.

The destination was clean on main before migration. Work is on
`codex/migrate-fuel-ui`. Fetching origin failed because noninteractive GitHub
authentication was unavailable; no merge, push or remote conflict review occurred.

## Verification

- 52 copied/shared source files matched SHA-256 hashes; two READMEs were merged.
- 30 backend tests and Ruff checks passed in the destination environment.
- Eight frontend tests and the production build passed in the destination.
- The existing large-bundle warning and upstream TestClient deprecation warning remain.
- Stopped the original development processes and restarted both services from this
  checkout: frontend at http://127.0.0.1:5173/ and API at http://127.0.0.1:8001/.
- `/api/healthz` through the frontend proxy returned HTTP 200 and configured=true.
  Credentials are checked lazily by the next analysis; no new satellite query was
  needed for this unchanged-code migration.
- Changes are uncommitted on codex/migrate-fuel-ui; no push was performed.
