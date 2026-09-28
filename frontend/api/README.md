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
| `src/providers/registry.ts` | composition root — selects top-level providers; adapters define fallback chains |
| `src/providers/tier1.ts` | elevation, fuel fallbacks, canopy assumption, values-at-risk |
| `src/providers/tier2.ts` | weather, wind field, fuel moisture |
| `src/providers/landfire.ts` | LANDFIRE FBFM40 fuel, CONUS |
| `src/providers/nws.ts` | NWS gridpoint forecast with Open-Meteo fallback |
| `src/providers/worldcover.ts` | ESA WorldCover fuel, global |
| `src/providers/sentinel.ts` | Sentinel-2 L2A: scene classification, band reads |
| `src/providers/burnhistory.ts` | dNBR burn severity from a Sentinel-2 scene pair |
| `src/providers/canopy-learned.ts` | canopy structure from a model trained on LANDFIRE |
| `src/providers/osm.ts` | Overpass roads, watercourses, building footprints |
| `src/providers/firms.ts` | NASA FIRMS active-fire detections |
| `src/providers/tiles.ts` | tile fetch, PNG/JPEG decode, disk cache |
| `src/providers/cogfetch.ts` | `node:https` shim for geotiff's range reads |
| `src/canopy/` | the canopy model: features, sampler, trainer, exported trees |

## Configuration and runtime boundary

Use Node.js 24+. Commands in the first block run from `frontend/`; diagnostic
commands below run from `frontend/api/` or use `--workspace=@firewatch/api`.
The API runs TypeScript directly. It does not serve the Vite production bundle.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Listen address |
| `FIREWATCH_MODE` | `live` | Only `offline` selects procedural/null providers |
| `TILE_CACHE_DIR` | OS temporary directory + `firewatch-tiles` | Reusable source cache |
| `TICK_MS` | `100` | Server tick/broadcast interval in milliseconds |
| `MAX_INCIDENTS` | `32` | In-memory incident limit |
| `FETCH_TIMEOUT_MS` | `15000` | General provider timeout in milliseconds |
| `IDLE_TIMEOUT_MS` | `60000` | Idle timeout for incidents without connected sockets |
| `OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | OSM query endpoint |
| `OVERPASS_TIMEOUT_MS` | `60000` | OSM query budget in milliseconds |

[config.ts](src/config.ts) is the source of defaults. Incidents are in memory and
are lost on restart. The server has permissive CORS and no authentication or
per-incident authorization. These are local prototype interfaces; do not treat
this README or the infrastructure proposal as evidence of a deployed secured service.

## Providers

Ports live in `@firewatch/contracts/providers` (ARCHITECTURE.md §9). Real
providers list a weaker one as a fallback, so a network failure degrades instead
of failing and `degradedFrom` records what it fell back from.

Live mode attempts external providers and may fall back to derived, assumed or
synthetic inputs. `GET /api/health` reports registry configuration, not the outcome
of a particular fetch. Inspect the incident's resolved provenance, coverage and
`degradedFrom` fields before describing its inputs as measured.

| Port | Live | Source |
|---|---|---|
| elevation | `terrarium-dem` | AWS Terrarium tiles |
| fuel | `landfire-fbfm40` → `esa-worldcover` → `s2cloudless-visible-band-fuel` | Scott & Burgan 40-model set in CONUS, WorldCover elsewhere, Sentinel-2 cloudless visible-band as last resort |
| canopy | `landfire-gbt-canopy` | gradient-boosted trees trained on LANDFIRE CBH/CBD/CC/CH |
| barriers | `osm-barriers` | Overpass roads and watercourses, per-edge `blockFrac` |
| burn history | `sentinel2-dnbr` | dNBR between two Sentinel-2 scenes |
| weather | `nws-gridpoint` → `open-meteo` | NWS gridpoint in supported US locations; Open-Meteo fallback (check source terms) |
| wind field | `open-meteo-windfield` | spatial anomaly, not absolute |
| fuel moisture | `nfdrs-1h-timelag` | Simard EMC + 1-h timelag over 7 d of history |
| observer | `firms-perimeter` | NASA FIRMS, 375 m pixels |
| values at risk | `osm-buildings` | counted footprints, not a per-hectare estimate |

Offline mode swaps every one for a procedural or null implementation, so the
whole system runs with no network and the header chip says so.

No provider returns bare data: each returns `Provided<T>` with a `Provenance`
whose `kind` is `measured`, `derived` or `synthetic`. Types require this metadata;
they cannot prove it is accurate. Review adapter behavior, provenance tests and
fallback handling together.

## Diagnostics

Assert-and-exit scripts rather than unit tests, because each needs live data or
trained artefacts.

| Command | Checks |
|---|---|
| `npm run watercheck` | the fuel classifier against six water bodies chosen to break a colour-based one |
| `npm run barriercheck` | OSM barrier geometry, and that the kernel honours the per-edge ordering |
| `npm run scarcheck` | burn-severity classification |
| `npm run canopy:check` | that TypeScript inference reproduces scikit-learn |
| `npm run hindcast` | replays real fires against mapped WFIGS perimeters — a retrospective diagnostic, with timing and outcome-leakage limitations |

`npm run canopy:sample` and `canopy:train` rebuild the canopy model; training
needs a Python venv at `api/.venv` with numpy and scikit-learn.

## Protocol

The complete DTOs are in [wire.ts](../contracts/src/wire.ts), and binary frames in
[codec.ts](../contracts/src/codec.ts). Both browser and API must change together.
The API also exposes `GET /api/health`, `/api/scenarios`, `/api/geocode`, `/api/fires`
and `/api/incidents/:id`; inspect [server.ts](src/server.ts) for validation and errors.


- `POST /api/incidents` `{scenarioId, offline?}` → incident, grid meta, provenance
- `POST /api/incidents/:id/command` → ignite, treat, clearTreatment, params, control, reset
- `DELETE /api/incidents/:id` → release it; idle incidents are also reaped after `IDLE_TIMEOUT_MS`
- `WS /api/incidents/:id/stream` → one terrain frame, then delta state frames at 10 Hz

Only changed cells are sent, plus intensity for cells inside their flaming
window. Payload size depends on grid size, changed cells and active flame count;
measure it for the scenario rather than assuming a fixed bandwidth budget.
See [evaluation limits](../../docs/simulation-evaluation.md) for replay interpretation
and [third-party notices](../../THIRD_PARTY_NOTICES.md) before redistributing data.
