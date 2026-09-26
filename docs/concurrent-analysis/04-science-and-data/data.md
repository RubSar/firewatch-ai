# Science and candidate data

Reviewed 2026-09-26.

## Competitor science

Technosylva describes fire modeling around weather, fuels, and topography, with scientific and operational validation. Its science page claims 85% accuracy for historical WUI building losses; the metric definition, evaluation protocol, and transferability were not checked here. [S06: Fire Science](https://technosylva.com/fire-science/)

Its operations page advertises simulations in under 30 seconds and weather forecasts beyond 100 hours at 2 km spatial and hourly temporal resolution. Treat these as vendor claims, not independently measured performance. [S03: Wildfire Operations](https://technosylva.com/products/wildfire-operations/)

## Candidate sources, not selected integrations

| Source | Verified from documentation | Proposed use / remaining checks |
| --- | --- | --- |
| [NASA FIRMS API](https://firms.modaps.eosdis.nasa.gov/api/) (S11) | Area-based hotspot CSV, availability queries, MAP_KEY setup; country features marked unavailable on the reviewed page | Observation layer; check sensor fields, latency, quotas, attribution and geography before implementation |
| [NWS API](https://www.weather.gov/documentation/services-web-api) (S12) | Forecasts, alerts, observations; identifying User-Agent required; open data with rate limits; point lookup leads to grid forecasts | Candidate for a US pilot; verify regional coverage, missing values, caching and upstream delays |
| [LANDFIRE](https://landfire.gov/) (S13) | Vegetation, fuel and disturbance products with versioned regional updates | Possible later modeling input; verify geography, resolution, release, access and processing cost |

## Data still needed

Reliable incident identities and perimeters; terrain; building/population exposure; utility assets if relevant; regional sources outside the US. No endpoints or licenses for these have been validated in this pass.

## Proposed evidence requirements

Retain source IDs, observation and retrieval timestamps, units, coordinates, quality flags and dataset versions. Never turn unavailable measurements into zero. Evaluate any future spread model against held-out incidents and appropriate baselines before asserting accuracy.

An AI-written briefing and a fire-behavior model are separate components. Our proposed initial AI role is summarizing supplied evidence with citations, not inventing fire perimeters or physical predictions.
