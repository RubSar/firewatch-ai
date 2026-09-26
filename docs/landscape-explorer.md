# Landscape explorer implementation and handoff

Scope: frontend/ web application, frontend/visualization/ map and image analysis, contracts/ shared result format. Existing scaffold files are preserved. No named contributor assignments or remote are configured.

The app uses an open Leaflet renderer with attributed Esri satellite tiles and OpenStreetMap streets. Optional Google Maps area selection uses ordinary map click events, not the removed DrawingManager API. Same-size geographic presets represent Sierra Nevada mixed conifer, Olympic Peninsula evergreen, and Mojave bare terrain; these are location examples, not labeled ground-truth training data.

Analysis is real RGB pixel sampling (every eighth pixel on both axes, geospatial clipping), with mutually exclusive green/tan/dark/other rules. Requests are in batches of four, with timeouts and cancellation. More than 25 km² is rejected; tile zoom is lowered to bound workload. Comparison area is a rectangular expansion minus the selected area. Images are not sent to a model. Pixel classification is heuristic and unvalidated. Canopy fraction, fuel moisture and dry-tree condition cannot be established from the green signal. Acquisition times are unknown for these basemap tiles. No fake numeric fire index is shown.

Next integration: API owner should supply dated Sentinel-2 / Dynamic World products and actual metadata using the shared contract. LLM owner can add RemoteCLIP scene descriptions behind API routes. Add a calibrated fuel index only with sufficient ground truth and moisture evidence; preserve null where unknown. Querying a historical incident requires imagery available before the prediction time.

Sources: https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer ; https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1 ; https://dataspace.copernicus.eu/data-collections/copernicus-sentinel-missions/sentinel-2 ; https://github.com/ChenDelong1999/RemoteCLIP . Google setup: https://developers.google.com/maps/documentation/javascript/get-api-key .

Verification: run frontend/npm test and npm run build. Browser acceptance: presets recenter; drawing creates a valid selection; too-large selections fail clearly; analysis yields actual sample counts; changing selection cancels and clears; Evidence and Method explain data; export returns receipt; source links and settings open; small screens remain usable. Google live integration requires a valid key.

## Verification performed

- Three Node tests passed for color-rule categories, surrounding-area expansion and invalid/oversize bounds.
- Production Vite build passed.
- In-app browser: real Sierra Nevada analysis returned 4,340 selected samples and 5,548 surrounding samples (16 tiles, zoom 15); green signal was 23%. Mojave reference returned 5% green signal. These are color measurements, not model accuracy evaluations.
- Verified custom rectangle drawing, 250 m selection setting, preset changes, source dialog, evidence panel, JSON preview matching counts, and missing Google key validation.
- Inspected desktop 1440×950 and mobile 390×844; mobile document width equals viewport width. Browser download completion could not be confirmed by the in-app automation, so JSON is also visible and copyable in a modal. Google Maps live rendering remains unverified without a key.

## Polygon buffer update (supersedes rectangular workflow above)

- Scope: frontend UI and visualization, contracts and docs. Turf added to the frontend package/lockfile; no API/LLM changes. No remote or named owners are configured.
- Draw vertices, Undo, then Finish (at least three vertices). Crossing edges fail without losing the draft. Cancel preserves the previous fire. Presets are synthetic irregular fires plus a 50 km circular fire.
- Red is the fire. Yellow is the 28 km outer buffer minus the fire. Study, fire and combined areas are displayed. Export is available before imagery analysis and includes all three GeoJSON features.
- geometry.js uses Turf's local spherical azimuthal-equidistant projection and rounded JSTS buffer, polygon difference and spherical area. This is not a bounding rectangle or radial scaling of vertices. Concavities can close when within 28 km; original fire geometry is retained. Regional input limit: 300 km diagonal, away from poles/date line. See v2 contract for approximation and limits.
- The imagery score now describes only the interest ring. Fire imagery is the comparison. Coarse sampling at this scale cannot identify individual dead trees. Buffer distance is geographic, not a fire-spread forecast.
- Google remains an optional two-corner rectangle selector, converted into a polygon and processed with the same 28 km calculation; live Google rendering is unverified without a key.
- Geometry tests cover circle radii/areas, subtraction, concave boundary distances, and invalid geometries. Run `npm test --prefix frontend` and `npm run build --prefix frontend` from the repository root.

Polygon update verification: all five Node tests and production build passed (Vite reports a non-blocking 500 kB chunk-size warning from added geometry code). Browser verified 50 km circle areas, custom polygon drawing with Undo/Finish, and v2 JSON geometry export preview. Sierra study-ring analysis produced 6,237 ring samples and 801 fire samples from 16 tiles at zoom 10. Final desktop map was visually inspected with sample overlay hidden to confirm red fire and yellow ring boundaries. Download file completion and live Google Maps remain unverified.
