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
| `src/providers/tier1.ts` | elevation, fuel fallbacks, canopy assumption, values-at-risk |
| `src/providers/tier2.ts` | weather, wind field, fuel moisture |
| `src/providers/landfire.ts` | LANDFIRE FBFM40 fuel, CONUS |
| `src/providers/worldcover.ts` | ESA WorldCover fuel, global |
| `src/providers/sentinel.ts` | Sentinel-2 L2A: scene classification, band reads |
| `src/providers/burnhistory.ts` | dNBR burn severity from a Sentinel-2 scene pair |
| `src/providers/canopy-learned.ts` | canopy structure from a model trained on LANDFIRE |
| `src/providers/osm.ts` | Overpass roads, watercourses, building footprints |
| `src/providers/firms.ts` | NASA FIRMS active-fire detections |
| `src/providers/tiles.ts` | tile fetch, PNG/JPEG decode, disk cache |
| `src/providers/cogfetch.ts` | `node:https` shim for geotiff's range reads |
| `src/canopy/` | the canopy model: features, sampler, trainer, exported trees |

## Providers

Ports live in `@firewatch/contracts/providers` (ARCHITECTURE.md §9). Real
providers list a weaker one as a fallback, so a network failure degrades instead
of failing and `degradedFrom` records what it fell back from.

**Every port has a real implementation.** None returns invented data in live
mode, and `GET /api/health` reports `measured` or `derived` for all ten.

| Port | Live | Source |
|---|---|---|
| elevation | `terrarium-dem` | AWS Terrarium tiles |
| fuel | `landfire-fbfm40` → `esa-worldcover` → `esri-imagery-fuel` | Scott & Burgan 40-model set in CONUS, WorldCover elsewhere |
| canopy | `landfire-gbt-canopy` | gradient-boosted trees trained on LANDFIRE CBH/CBD/CC/CH |
| barriers | `osm-barriers` | Overpass roads and watercourses, per-edge `blockFrac` |
| burn history | `sentinel2-dnbr` | dNBR between two Sentinel-2 scenes |
| weather | `open-meteo` | keyless, ~10 kB |
| wind field | `open-meteo-windfield` | spatial anomaly, not absolute |
| fuel moisture | `nfdrs-1h-timelag` | Simard EMC + 1-h timelag over 7 d of history |
| observer | `firms-perimeter` | NASA FIRMS, 375 m pixels |
| values at risk | `osm-buildings` | counted footprints, not a per-hectare estimate |

Offline mode swaps every one for a procedural or null implementation, so the
whole system runs with no network and the header chip says so.

No provider returns bare data: each returns `Provided<T>` with a `Provenance`
whose `kind` is `measured`, `derived` or `synthetic`. The UI surfaces it — "mock
data presented as live" is meant to be a type error.

## Diagnostics

Assert-and-exit scripts rather than unit tests, because each needs live data or
trained artefacts.

| Command | Checks |
|---|---|
| `npm run watercheck` | the fuel classifier against six water bodies chosen to break a colour-based one |
| `npm run barriercheck` | OSM barrier geometry, and that the kernel honours the per-edge ordering |
| `npm run scarcheck` | burn-severity classification |
| `npm run canopy:check` | that TypeScript inference reproduces scikit-learn |
| `npm run hindcast` | replays real fires against mapped WFIGS perimeters — the only end-to-end accuracy number |

`npm run canopy:sample` and `canopy:train` rebuild the canopy model; training
needs a Python venv at `api/.venv` with numpy and scikit-learn.

## Protocol

- `POST /api/incidents` `{scenarioId, offline?}` → incident, grid meta, provenance
- `POST /api/incidents/:id/command` → ignite, treat, clearTreatment, params, control, reset
- `DELETE /api/incidents/:id` → release it; idle incidents are also reaped after `IDLE_TIMEOUT_MS`
- `WS /api/incidents/:id/stream` → one terrain frame, then delta state frames at 10 Hz

Only changed cells are sent, plus intensity for cells inside their flaming
window. A running fire costs ~1–3 kB/frame against the 132 kB a full grid would.
