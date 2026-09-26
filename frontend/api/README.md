# @firewatch/api

Incident API. Runs the fire kernel server-side and streams state to browsers.

```bash
npm run dev:api                          # from frontend/, :8787, live data
FIREWATCH_MODE=offline npm run dev:api   # fully procedural, no network
npm run smoke:api                        # boots the server, decodes the stream
```

Node runs this TypeScript directly — no build step. That means type-stripping
only, so **no TS `enum`, `namespace`, parameter properties or decorators**;
`erasableSyntaxOnly` makes `tsc` enforce it.

| Path | What |
|---|---|
| `src/server.ts` | REST + WebSocket. Control is JSON, fire state is binary |
| `src/incident.ts` | one running fire: sim, clock, diff against what clients last saw |
| `src/providers/registry.ts` | **composition root** — the only file naming concrete implementations |
| `src/providers/tier1.ts` | elevation, fuel, canopy, barriers, burn history, values-at-risk |
| `src/providers/tier2.ts` | weather, wind field, fuel moisture |
| `src/providers/tiles.ts` | tile fetch, PNG/JPEG decode, disk cache |

## Providers

Ports live in `@firewatch/contracts/providers` (ARCHITECTURE.md §9). Each has an
offline implementation and, where cheap, a real one. Real providers list their
offline counterpart as a fallback, so a network failure degrades instead of
failing and `degradedFrom` records it.

| Port | Real today | Mocked |
|---|---|---|
| elevation | AWS Terrarium tiles | procedural |
| fuel | Esri imagery + visible-band classifier | topography rules |
| weather | Open-Meteo (keyless, ~10 kB) | preset + diurnal cycle |
| canopy, barriers, burn history, wind, observer, values-at-risk | — | all |

No provider returns bare data: each returns `Provided<T>` with a `Provenance`
the UI must surface. `GET /api/health` reports which port is bound to what, plus
live incident and socket counts.

## Protocol

- `POST /api/incidents` `{scenarioId, offline?}` → incident, grid meta, provenance
- `POST /api/incidents/:id/command` → ignite, treat, clearTreatment, params, control, reset
- `DELETE /api/incidents/:id` → release it; idle incidents are also reaped after `IDLE_TIMEOUT_MS`
- `WS /api/incidents/:id/stream` → one terrain frame, then delta state frames at 10 Hz

Only changed cells are sent, plus intensity for cells inside their flaming
window. A running fire costs ~2.5 kB/frame against the 132 kB a full grid would.
