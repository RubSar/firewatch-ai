# 4. Capacity, deployment, reliability and acceptance

> Design proposal, 2026-09-26. Services and acceptance targets below are not a deployed
> or benchmarked system. See the [specification status](README.md).

## 4.1 Capacity assumptions and equations

`capacity-assumptions.json` is the editable source of planning inputs. `python capacity.py` regenerates `capacity-results.json` and `capacity-table.md` for 10, 100 and 1,000 concurrent drones. Values are decimal units. Default concurrent design point is 100; hardware and model rates remain unselected.

Per drone: 1080p RGB at 30 FPS, encoded at assumed 8 Mbps; 640x512 radiometric UINT16 at 5 FPS without compression; telemetry 20 messages/s at 512 bytes. RGB fire/smoke analysis is fresh inference every received frame; vegetation is an independent 1 FPS task. Assume four active flight hours/day and seven days of originals. Network allowance is 20%; it is not a measured cellular overhead.

Equations:

```text
thermal_bytes_per_second = width * height * bytes_per_pixel * FPS / compression_ratio
ingress_bits_per_second = drones * (RGB_bytes_s + thermal_bytes_s + telemetry_bytes_s) * 8 * (1 + overhead)
original_storage_bytes = drones * original_bytes_s * flight_hours_day * 3600 * retention_days
model_requests_s = drones * analyzed_FPS * requests_per_frame
GPU_count = ceil(model_requests_s / (measured_requests_per_GPU_s * target_utilization))
equal_GPU_count_per_zone = ceil(model_requests_s / (measured_rate * target_utilization * surviving_zones))
```

The calculator uses **hypothetical** fire throughput of 100 requests/GPU/s and vegetation throughput of 20 requests/GPU/s, dedicated model pools, 65% operating utilization and three zones. These numbers demonstrate sensitivity, not NVIDIA performance or a purchase recommendation. Tiling, separate smoke/fire models, precision, resolution, input transfer and model-memory capacity can change demand substantially. A benchmark must count the complete model ensemble and memory working set.

At 100 drones, illustrative requirements are approximately 4.12 Gbps ingress with allowance, 1.54 TB original data per active hour and 43.21 TB for seven days at four hours/day. At continuous 24-hour operation, original storage multiplies by six. Replication/erasure overhead, retained incident evidence, derived masks, database indexes and backups are additional. Mask/object request rates and storage headroom must be sized separately.

Decoded RGB is the hidden fabric cost: one RGB888 transfer at 1080p/30 FPS is about 1.493 Gbps/drone; 100 drones imply 149.3 Gbps before additional copies. Prefer decode/inference placement and reuse, transmit original compressed media across the field link, and avoid persisting decoded raw RGB as the default archive. Float32 thermal transport doubles the listed UINT16 thermal byte rate. Never apply lossy compression to numerical temperature values without separately validating and declaring its error.

Metadata approximation: eight events per RGB frame at 2 KiB average, plus separately modelled control/context work. At 100 drones this is 24,000 events/s and 49.15 MB/s before Kafka replication. Topic-specific retention differs; the capacity calculator's three-day replicated estimate is a planning approximation, not the total of the complete topic catalog. Measure actual event sizes and output cardinality before broker sizing.

## 4.2 Service-level objectives and latency budgets

All numbers are proposed acceptance targets. Latency is reported together with deadline coverage and source-clock quality; excluding failed/late frames from the denominator is prohibited.

| Objective | Proposed target / eligibility |
|---|---|
| Public query/control availability | 99.9% monthly, excluding explicitly scoped scheduled maintenance only if contract permits |
| Ingest-to-published observation | p95 <=1.5 s for admitted live workload and committed payload references |
| Capture-to-published observation | p95 <=2 s when capture clock uncertainty <=50 ms and negotiated field-link budget <=500 ms |
| Live frame coverage | >=99% of received/admitted RGB frames finish required fire/smoke inference within deadline; report source missing frames separately |
| Grid freshness | Surface cells updated when observable; stale status when last relevant input exceeds configured expiry, initially 5 s |
| First alert attempt | p95 <=1 s after incident rule emits notification request; confirmation-window and recipient delivery time separate |
| Per-session worker recovery | Proposed <=30 s under cached-model, healthy-storage conditions, with explicit gap/reset markers |
| Regional recovery | Proposed RTO 30 min, RPO <=5 min for replicated durable metadata/media; requires measured replication and drills |

Example backend budget, an engineering allocation rather than additive percentile mathematics: ingest commit 150 ms; decoding/synchronization 150 ms; queue + GPU + postprocess 350 ms; fusion 150 ms; georeference 100 ms; grid/incident commit 100 ms; browser/event delivery 200 ms; reserve 300 ms = 1,500 ms. Thermal calculation runs in parallel with vision. Independent p95 values cannot simply be added to prove end-to-end p95; tracing and load tests establish the actual distribution.

Capture clock unavailable: capture-to-result is unknown; report receipt-to-result and clock status instead. Detection delay due to an evidence-persistence rule is reported separately from compute latency. A 2-second published candidate objective does not mean a 2-second operator-confirmed incident.

## 4.3 Autoscaling policies

| Workload | Primary signal | Scaling/drain policy |
|---|---|---|
| C01/D03 APIs | In-flight requests, request p95, CPU and DB pool wait | Minimum two replicas; bounded DB pool per replica; admission protects DB |
| I01/P01 media | Reserved sessions, bitrate, decode slots and oldest frame age | Placement controller admits new sessions; no eviction of active decoder state during routine scale-down |
| I02/I03 ingestion | Accepted messages/pixels per second, upload latency and source backlog | Scale before quotas are exceeded; field spool absorbs short disruption |
| P02/P03/P06 workers | Estimated remaining work and oldest eligible event age | Scale independent task workers; limit in-flight tasks to downstream capacity |
| P04 GPUs | Outstanding model work divided by validated sustainable throughput, deadline slack and ready replicas | Pre-warm; minimum active capacity; node provisioning independently sized |
| P05/P07/D01 stateful processors | Owned shards, weighted backlog and transaction latency | Partition-aware scaling with leases, checkpointed drain and fencing |
| D04 subscriptions | Active connections, egress and buffer pressure | Shard connections; reconnect/resume on drain; bounded per-client state |
| D02 notifications | Oldest pending delivery and per-destination quota | Dedicated pool with retry budget; no borrowing live GPU capacity |
| O01 replay | Batch backlog subject to quota | Separate compute reservation; may scale to zero when idle |

Use one autoscaler as owner of each Deployment; do not install competing HPA and KEDA controllers that both change the same replica count. KEDA can manage a workload's HPA when chosen. For partitioned topics, consumer count beyond partitions does not automatically create useful ordered parallelism; validate scaler behavior [S4, S6]. Lag count alone is insufficient: ten large tiles may cost more than thousands of small telemetry events.

Starting policy candidates: evaluate signals every 15 seconds, scale up when remaining-work estimate exceeds reserved capacity or queue age exceeds 100 ms for two windows, and retain a 10-minute scale-down stabilization window for stateful/GPU pools. Because these control loops are slower than the 2-second live objective, maintain warm headroom and use mission reservations/forecast schedules. These settings are tuning inputs, not guarantees.

Dedicated GPU workloads request vendor GPU resources and use device-plugin-enabled nodes [S5]. Pod replicas without available GPU nodes remain pending; increasing replicas is not evidence of increased serving capacity. Request deadlines, maximum Triton queue delay, warmup readiness, GPU memory and model loading all participate in admission. MIG/time slicing, if later used, must be supported on selected hardware and benchmarked; never assume fractional GPU isolation.

## 4.4 Backpressure and every-frame policy

Default strict mode processes every received/admitted RGB frame through required detection. Admission reserves expected resources, source burst tolerance and one chosen failure reserve. If a runtime failure exceeds that reserve, mark missed deadlines honestly and retain originals for replay. Strict mode never silently changes to sampled inference to meet a latency chart.

An explicit operator-approved adaptive profile may lower analysis FPS or resolution when capacity/link degrades. Changes are versioned mission events with effective frame boundaries; observations carry the effective cadence. Playback FPS, tracking FPS and fresh inference FPS are different metrics. Optional species/vegetation analysis may be suspended first according to declared policy; thermal calculations and fire/smoke analysis retain their priority.

All queues have count, byte and age bounds. A service refuses excess work with a retryable/degraded signal rather than allocating unbounded memory. Live deadlines follow events across retries. Expired work records a failure/accounting outcome and is eligible for isolated replay; it is not kept ahead of fresh work indefinitely. Source/gateway spools have configured storage limits and report exact overwritten/lost intervals if full.

## 4.5 Database and storage scaling

Start with PostgreSQL/PostGIS primary + standby and read replicas. Tenant/mission/time partitioning of large observation history tables improves maintenance/query pruning, but does not turn one PostgreSQL primary into a horizontally scalable writer. Introduce application-level database shards by tenant/mission once measured write throughput, recovery time or storage limits require them. A directory maps a mission to its storage shard; migration is a fenced drain/copy/catch-up/cutover with a new routing epoch.

P07 writes bounded tile deltas in batches; do not execute a transaction per pixel. Separate latest-state tables from append-only observation history. Retain large masks/raster arrays in object storage and relational indexes for time/location/model metadata. Connection pools are capped across autoscaled replicas. Query limits prevent an unbounded map request from exhausting all database connections.

Object storage is independently scaled for throughput and request rate. Record and benchmark small-object overhead; microbatch and compact where possible without exceeding latency. Backups and cross-region copies are distinct from storage replication. Verify restore checksums, encryption key availability and metadata/object consistency. Exported evidence keeps provenance and applicable source retention/usage terms.

## 4.6 Deployment, configuration and upgrades

- Infrastructure-as-code defines networking, identities, object stores, brokers, databases, node pools and observability. Service charts/manifests pin image digests; this design package does not include production-ready deployment manifests.
- Environments: development, staging, production and isolated replay/evaluation. Separate credentials, topics and storage namespaces; production field devices cannot publish to an arbitrary tenant.
- Node pools: CPU APIs/context; media/decode; inference GPU; stateful broker/database if self-managed; batch/replay. Apply disruption budgets, placement constraints and failure-zone spread consistent with measured capacity.
- Startup/readiness/liveness are different. GPU model readiness runs a representative inference after weights load. Liveness does not kill a healthy pod merely because its downstream weather provider is unavailable.
- Drain protocol: stop new admissions, allow bounded in-flight completion, commit checkpoint/outbox, relinquish lease, then terminate. Stateful/GPU grace periods exceed measured drain time; forced shutdown emits a recoverable gap.
- Schema migrations use expand/backfill/contract. Rollback cannot depend on deleting a field an old consumer still needs. Ordered topic migration uses the barrier procedure in 01-architecture.md.
- Model rollouts use shadow evaluation first, then limited cohort, then promotion. Shadow results cannot emit live notifications. Track calibration/version drift separately from application deployments.

## 4.7 Security and tenant boundaries

Device mTLS and short-lived session grants bind tenant/device/mission/sensor capabilities. User tokens carry role and mission scope. Every object lookup, database query, event consumer and live subscription must enforce that scope. Tenant identifiers in untrusted payloads are cross-checked against authenticated identity. Database row policies or equivalent scoped access are defense in depth; they do not replace service authorization.

Internal workloads use scoped identities and encrypted transport. Broker ACLs constrain producer/consumer topics; no routine service has administrative wildcard access. Object grants are short-lived; signed URLs are generated on demand and not persisted in event logs. Encrypt storage and backups; secret rotation must not require rewriting historical events.

Image/text content is untrusted input to any optional VLM explanation service. It cannot alter alert rules, access policy, tool permissions or flight controls. Administrative policies and model manifests are signed/versioned artifacts. Media decoding occurs in constrained workloads with updated decoders, input size/rate limits and no unnecessary outbound network access.

## 4.8 Observability and failure matrix

| Failure | Required behavior | Recovery proof |
|---|---|---|
| Field link drops | Gateway records locally; stale modality markers; no false clear | Reconnect/new session/gap records reconcile with original frame counts |
| Thermal missing | Continue RGB observations; temperatures unavailable | Thermal resumes with new valid capture/calibration boundary |
| RGB missing | Continue thermal anomalies; no invented species/flame mask | Vision resumes and temporal association records reset if needed |
| Model timeout/OOM | Failed frame accounting, partial fusion, bounded retry | Model readiness and backlog return to target without duplicate state |
| Kafka broker loss | RF/ISR policy determines durable availability; bounded spool | No committed ready event lost within tested quorum assumptions |
| PostgreSQL failover | Fenced writers pause/retry; outbox survives | Old owner rejected; inbox prevents repeated transition |
| Hot payload lost/unreadable | No false successful inference; evidence unavailable/gap | Restore from archive mapping or explicitly unrecoverable interval |
| Weather outage | Use labelled last snapshot or unavailable context | New provider run retains issue/valid times |
| Clock drift | Disable unreliable joins/geolocation; retain arrival-time metrics | Known clock correction restores bounded uncertainty |
| Slow browser | Coalesce grid changes; resync-required at buffer cap | Snapshot+cursor returns coherent state |
| Zone loss | Drain/fence failed owners; reserved surviving capacity takes load | Data gaps/latency/recovery measured in a drill |
| Region loss | Explicit failover epoch and recovered watermark | No split-brain writer; RPO gap visible to users |

Metrics include accepted/received/source-missing/late/failed frame counts, capture and backend latency, clock skew, pairing skew, inference queue age, model memory, GPU cold-start duration, grid age, per-shard lag, database pool wait, object write/read tails, archive watermark, webhook retry age and WebSocket resyncs. High-cardinality frame/cell IDs belong in traces/logs, not metric labels.

## 4.9 Acceptance and release gates

1. **Contract gate:** schemas validate examples; negative cases fail; source units/coordinate axes/version semantics checked; no cross-tenant access through any event or evidence path.
2. **Radiometry gate:** source/converted temperatures agree with supported SDK/reference fixtures; saturation, missing calibration and invalid pixels produce declared output states. This verifies conversion plumbing, not field accuracy by itself.
3. **Geometry gate:** registered camera fixtures and surveyed targets verify footprint error; no metric area output when projection is invalid; RGB/thermal alignment error retained.
4. **Every-frame gate:** replay a known 30 FPS source with duplicates, gaps and out-of-order results. Reconcile source, received and stage outcome counts exactly; fresh inference is distinguishable from tracking.
5. **State gate:** kill/restart owners during transactions, outbox publication and lease expiry. No old owner commit, regressed grid revision or duplicated incident state transition.
6. **Load gate:** realistic encoded RGB, radiometric bandwidth, model ensembles, viewers and archive writes together; sustain target load for two hours, run burst tests and a 24-hour soak. Validate latency and coverage together.
7. **Scale gate:** step through 10/100/target drone workloads; prove proportional useful capacity until documented bottlenecks. Record why scaling stops: partition count, one hot mission, database writer, GPU memory or network fabric.
8. **Resilience gate:** lose one worker, GPU, broker, database primary and failure zone in separate controlled drills. Test reconnect, snapshot recovery, retention pins and backup restores.
9. **Model gate:** held-out incident/site evaluation of detection false alarms, recall, time-to-detection and vegetation errors. No production accuracy threshold is invented here; acceptance thresholds require labelled evaluation and product owners.
10. **Operational gate:** on-call ownership, alert thresholds, runbooks, cost/retention limits, tenant isolation and regional failover rehearsed. Latency promises require the actual field link and chosen hardware.

## 4.10 Implementation sequence and unresolved decisions

Phase A: one-drone vertical slice (I01/I02/I03 -> P01/P02 -> P06/P07 -> D03/D04), using recorded evidence and simulated telemetry explicitly labelled as such. P03/P04 require a selected model and measured inference. Missing pose/calibration keeps output in image coordinates.

Phase B: frame inference, fusion/tracking, incident review, evidence pinning, transactional reliability and replay. Annotate the required wildfire/material datasets and establish model gates.

Phase C: multi-drone partitioning, GPU pool, admission reservations, source reconnects, multi-view correlation and capacity profiling. Scale before selecting the final hardware purchase quantity.

Phase D: HA topology, operational drills, recovery-region capability and production tenants. Forecasting/crew-routing remains a separate product workstream requiring additional data and validation.

Open inputs: target fleet/concurrency, actual RGB/thermal capabilities, field bandwidth, expected flight hours, region/provider, accepted data loss and alert latency, model resolution/ensemble, ground-grid accuracy/resolution, retention budget, tenant isolation level and commercial data/model rights. These are parameterized assumptions, not reasons to block specification work.
