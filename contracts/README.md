# Shared data contracts

Language-neutral research schemas and small examples live here. These are separate
from the simulation's [TypeScript wire/provider contracts](../frontend/contracts/README.md).
A schema file does not create an HTTP endpoint or certify the truth of its data.

| Contract | Producer and consumer |
| --- | --- |
| [Historical situation semantics](historical-situation.md) and [schema](historical-situation.schema.json) | Python historical import, quality checks and optional retrospective comparison |
| [Enrichment sidecar](enrichment-sidecar.schema.json) | GOFER enrichment and the static preview exporter; keeps source/support/review state per measurement |
| [NIFC snapshot](nifc-snapshot.schema.json) | NIFC importer and preview exporter; single perimeter with unknown growth |
| [Historical preview](historical-preview.schema.json) | Python exporter → browser historical atlas; preserves interval versus snapshot kind |
| [Observation research formats](research/README.md) | Offline vision acquisition, rules, annotation and satellite evaluation tools |

Examples under `examples/` retain their own provenance and review status. A real
source example is not necessarily independently reviewed or cleared for redistribution;
see [source notices](../THIRD_PARTY_NOTICES.md). Research examples may also be explicitly
synthetic to demonstrate a format.

When changing a contract, update producers, consumers, examples and relevant tests
together. Document units, coordinate order/CRS, time support, optional/null semantics
and compatibility. Keep source observations, derived values and assumptions distinct.
Coordinate with affected components; named ownership remains unassigned.
