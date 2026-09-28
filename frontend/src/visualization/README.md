# Visualization

Maps, charts and spatial interaction components belong here, inside the web app.
Use the shared TypeScript contracts in `@firewatch/contracts` and repository API
schemas and examples in [repository contracts](../../../contracts/README.md).

`HistoricalMap.tsx` is imported locally by `src/history/HistoryPage.tsx`. It renders
recorded GOFER extent and newly burned footprints from GeoJSON props; it does not
query data providers or run a fire model. React and Leaflet dependencies are declared
once in `frontend/package.json`.

`useLeafletMap.ts` supplies the shared Leaflet lifecycle, zoom/scale controls and
basemap definitions used by both the simulator and history. Satellite imagery uses
EOX Sentinel-2 cloudless 2020; topographic imagery uses OpenTopoMap. Keep attribution
in the shared configuration. Tiles are upscaled beyond their native zoom to inspect
geometry; that does not add imagery detail. Each page owns its overlays and viewport.
