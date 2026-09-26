# Fire investigation UI integration

Scope: frontend API client, result rendering, map layers, local Vite proxy and
integration documentation. Consumes the existing `/v1/fire-investigation` contract;
no backend schema changes or provider calls from the browser. No named owners are
recorded. Existing untracked work and the current branch are preserved. A Git remote
is configured, but the remote HEAD check failed on DNS resolution; no remote overlap
review, commits, pushes or teammate notifications were performed.

## Data flow

Fire GeoJSON geometry + UTC imagery window + cell_size_m -> same-origin `/api`
proxy -> fuel service -> backend wrapper/ring geometries and scored FeatureCollection.
The browser's local 28 km buffer is a labeled preview only. All successful result
boundaries and areas come from the backend, including clipped cell geometries.

`frontend/src/api/investigation.js` owns the HTTP client, request validation and
geometry adapter. `frontend/src/results.js` owns the results/evidence/method panels.
`frontend/visualization/map.js` renders score polygons and cell popups. `main.js`
coordinates request cancellation, selection and result lifecycle.

The client has no fixture fallback. Switching input invalidates scores and aborts
the pending fetch; response identity guards prevent stale requests replacing newer
selections. A synchronous server query may continue after abort, so the UI says
“Stop waiting” and backend 429 errors remain visible. A spinner does not claim
percentage completion. Null remains unknown, distinct from a zero score.

Proxy authentication stays server-side. Deployments need a same-origin API gateway;
static assets alone cannot route `/api`. See frontend/README.md for settings.

## Verification

- Frontend production build passed (existing >500 kB bundle warning remains).
- Eight frontend tests passed: geometry plus request/response/error consumer tests
  against the shared backend fixture. No model accuracy claim follows from these tests.
- Real UI click through the proxy returned 125 cells, 111 scored / 14 unknown,
  mean experimental score 0.4, 31 matched acquisitions, and 2566.93 km² ring area.
- Visually inspected the colored grid, fire exclusion, unknown gray cells, and
  per-cell popup/Evidence values against the returned data.

This supersedes earlier documentation stating that the frontend is unconnected.

Also verified full JSON export retains all 125 features and synthetic=false, changing
the fire removes old map cells/results, and invalid date windows show a recoverable
validation message. No authentication or model credentials enter the client bundle.
