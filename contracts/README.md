# Contracts

Historical enrichment measurements are append-only sidecars described by
[`enrichment-sidecar.schema.json`](enrichment-sidecar.schema.json). Keep source observations,
derived values, spatial supports, evidence and review state individually attributable. See
[`enriched Creek pilot`](../docs/concurrent-analysis/09-historical-similarity/enrichment-pilot.md).

Shared API schemas and example requests and responses belong here.

NIFC perimeter observations use [`nifc-snapshot.schema.json`](nifc-snapshot.schema.json),
with real examples in `examples/nifc/`. They are snapshots with unknown growth,
not hourly intervals. Historical preview schema 1.1 preserves that distinction.

Coordinate contract changes with the API and frontend owners before merging.
