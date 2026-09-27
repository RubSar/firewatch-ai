# Visualization

Maps, charts, and visual components belong here.

Use the shared API schemas and example responses in `../../contracts/`.

`HistoricalMap.tsx` is exported by the `@firewatch/visualization` workspace. It renders
recorded GOFER extent and newly burned footprints for the frontend's `/history` page.
It consumes GeoJSON props and does not query data providers or run a fire model.
