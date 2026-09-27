# Visualization

Maps, charts and spatial interaction components belong here, inside the web app.
Use the shared TypeScript contracts in `@firewatch/contracts` and repository API
schemas and examples in `../../../contracts/`.

`HistoricalMap.tsx` is imported locally by `src/history/HistoryPage.tsx`. It renders
recorded GOFER extent and newly burned footprints from GeoJSON props; it does not
query data providers or run a fire model. React and Leaflet dependencies are declared
once in `frontend/package.json`.
