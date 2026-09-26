# Firewatch AI — horizontally scalable infrastructure specification

Version 0.1 · 26 September 2026 · Design proposal, not a deployed or benchmarked system.

This specification defines the backend for live drone RGB imagery, radiometric thermal frames, flight telemetry, environmental observations and weather context. It extends the local temperature-grid prototype. It does not claim trained wildfire recognition, validated spread prediction or operational routing.

## Read in this order

1. [Architecture and scaling invariants](01-architecture.md)
2. [Detailed microservice specifications](02-service-catalog.md)
3. [Data contracts, APIs and consistency](03-data-contracts.md)
4. [Capacity, deployment, reliability and acceptance](04-operations.md)

Machine-readable files: `service-catalog.json`, `topics.json`, `capacity-assumptions.json`, `capacity-results.json`, and the `contracts/` directory. `capacity.py` recalculates bandwidth, storage and illustrative GPU requirements. `verify_spec.py` checks the package's service/topic references, schema/example relationships and capacity arithmetic; it does not test a running infrastructure.

## Planning basis

- Vendor-neutral; drone, payload and cloud provider not selected.
- Working design point: 100 simultaneous drones per regional deployment. Capacity formulas also cover 10 and 1,000 drones. This is an editable assumption, not a purchased capacity commitment.
- RGB capture: 30 FPS, with fresh fire/smoke inference on every received frame in strict mode. Thermal: 5 radiometric frames/second. Vegetation inference: 1 FPS as a separate documented workload.
- Surface-temperature calculations use sensor values. RGB classifiers cannot provide measured Celsius values. Species and material properties remain unknown when evidence is inadequate.
- Initial SLO proposal: p95 below 2 seconds from eligible capture to a published fire observation, subject to a defined field link; backend latency is tracked separately.
- Partitioned state by session, analysis run and map tile; elastic stateless GPU inference; durable metadata events separate from binary media.
- At-least-once transport plus idempotent, fenced state updates. No claim of exactly-once delivery to external recipients.
- Each mission has one active processing region. Regional failover changes an epoch and is explicit; this design does not promise unrestricted multi-region active-active writes.

## Delivery boundary

The package is a technical design with contracts and a capacity calculator. No cloud resources, brokers, databases, Kubernetes clusters or live device integrations have been created. GPU-throughput numbers in examples are hypothetical until measured with the selected models and hardware.
