# 2. Microservice catalog

> Design proposal, 2026-09-26. Services and acceptance targets below are not a deployed
> or benchmarked system. See the [specification status](README.md).

23 logical microservices. Pilot deployments may co-host compatible services; these contracts remain separate. All latency values are proposed allocations requiring load tests. Service-specific transactions use the inbox/outbox and fencing rules in 01-architecture.md.

Each service exposes readiness, liveness and bounded shutdown hooks. Authenticated internal calls carry tenant/mission identity, trace context and a deadline. Service-owned database schemas are not writable by other services. Shared clusters are permitted; ownership is still enforced by database roles.

| ID | Service | Layer |
|---|---|---|
| C01 | Identity and API gateway | Control |
| C02 | Mission, session and admission registry | Control |
| C03 | Sensor calibration registry | Control |
| C04 | Model and policy registry | Control |
| I01 | Media session gateway | Ingestion |
| I02 | Telemetry and environmental ingress | Ingestion |
| I03 | Radiometric ingress | Ingestion |
| I04 | Evidence archive and lifecycle | Ingestion |
| P01 | Decode, frame accounting and synchronization | Processing |
| P02 | Thermal measurement and hotspot candidates | Processing |
| P03 | Vision inference orchestration | Processing |
| P04 | GPU model serving | Processing |
| P05 | Evidence fusion and temporal tracking | Processing |
| P06 | Georeferencing and footprint projection | Processing |
| P07 | Spatial grid materialization | Processing |
| X01 | Weather ingestion and cache | Context |
| X02 | Terrain, fuel and reference-data catalog | Context |
| D01 | Incident correlation and decision rules | Delivery |
| D02 | Notification dispatcher | Delivery |
| D03 | Query, map and evidence API | Delivery |
| D04 | Live subscriptions and preview delivery | Delivery |
| O01 | Replay, backfill and evaluation | Operations |
| O02 | Audit and operational health projection | Operations |

## C01 — Identity and API gateway

| Contract | Specification |
|---|---|
| Interfaces | HTTPS /v1/*; OIDC user tokens; device mTLS; upstream tenant identity propagated in verified service credentials. |
| Consumed events | None; synchronous interface or scheduled work. |
| Produced events | audit.event |
| State and persistence | External identity provider plus versioned device grants; no application-session affinity. |
| Ownership key | Stateless request / connection. |
| Horizontal scaling | HPA on in-flight requests, request latency and connection count; minimum two production replicas. |
| Failure behavior | Fail closed for new sessions if authorization cannot be established. Existing short-lived grants work only until expiry; revocation bounds documented. |
| Proposed budget | 20 ms internal gateway overhead; excludes identity-provider login. |
| Acceptance criteria | Forged tenant header rejected; cross-tenant object/mission access denied; expired device grant cannot renew. |

Implementation requirements:

- Authenticate people and devices separately; users receive mission-scoped read/review/admin roles.
- Reject oversized bodies, unapproved content types and invalid identifiers before queueing. Rate limits per tenant and device.
- Device data channels cannot invoke aircraft controls. Operator review writes require scope and an audit entry.
- Use workload mTLS internally. Secrets stay out of URLs, telemetry, evidence paths and logs.

## C02 — Mission, session and admission registry

| Contract | Specification |
|---|---|
| Interfaces | POST /v1/missions; POST /v1/missions/{id}/sessions; POST /v1/sessions/{id}/close; internal ClaimShard/HeartbeatShard RPC. |
| Consumed events | session.command |
| Produced events | session.changed, session.command, audit.event |
| State and persistence | PostgreSQL missions, sessions, capacity reservations, region directory, shard_leases and transactional outbox. |
| Ownership key | Tenant + mission; unique session IDs and service-specific shard leases. |
| Horizontal scaling | Stateless API replicas, transactional primary. Capacity reservations use CAS to avoid overbooking; DB sharding by tenant/mission when measured limits are reached. |
| Failure behavior | No new session when reservation/lease persistence unavailable. Existing workers retain cached policy only while their leases remain valid. |
| Proposed budget | Session admission p95 <=500 ms excluding device authentication and model warmup. |
| Acceptance criteria | Two simultaneous admissions cannot consume the same last capacity slot; expired old owner cannot commit state. |

Implementation requirements:

- Session admission negotiates exact source rates, frame accounting mode, calibration, model manifest and recovery policy.
- Return NOT_READY with retry information when models/storage are not warm; never advertise unreserved every-frame capacity.
- Increment mission region epoch on failover and owner epoch on stateful worker transfer.
- Active sessions: STARTING, ACTIVE, DEGRADED, DRAINING, CLOSED; transitions are versioned and audited.

## C03 — Sensor calibration registry

| Contract | Specification |
|---|---|
| Interfaces | POST /v1/calibrations; GET /v1/calibrations/{id}; internal immutable GetCalibration. |
| Consumed events | None; synchronous interface or scheduled work. |
| Produced events | calibration.changed, audit.event |
| State and persistence | Immutable calibration metadata in PostgreSQL; calibration files in object storage. |
| Ownership key | Tenant + sensor + calibration version. |
| Horizontal scaling | Stateless replicas and immutable read caches; write workload small. |
| Failure behavior | Missing or incompatible calibration marks measurements/projection unavailable; never substitute another camera calibration. |
| Proposed budget | Cache-hit lookup <=10 ms; not called remotely for every frame. |
| Acceptance criteria | Wrong sensor serial, lens, gain mode or validity interval rejected; old results retain original calibration reference. |

Implementation requirements:

- Store camera intrinsics, distortion, inter-sensor extrinsics, gimbal/body transforms, time offsets and uncertainty.
- Radiometry includes conversion definition, supported gain/range, emissivity assumptions, reflected/atmospheric settings and saturation values.
- Approval creates a new immutable version; activation takes effect at a recorded frame boundary.
- Retain field validation status; possession of a calibration file does not prove current measurement accuracy.

## C04 — Model and policy registry

| Contract | Specification |
|---|---|
| Interfaces | POST /v1/deployments; GET /v1/deployments/{id}; internal model readiness/status. |
| Consumed events | None; synchronous interface or scheduled work. |
| Produced events | deployment.changed, audit.event |
| State and persistence | Signed artifact manifests; object-store model weights; PostgreSQL approved deployments and evaluation links. |
| Ownership key | Model family + immutable version + hardware profile. |
| Horizontal scaling | Stateless control replicas; downloads cached per inference node; pre-warm bounded rollout waves. |
| Failure behavior | Retain previous approved model on failed rollout; no live fallback to random weights or unapproved model. |
| Proposed budget | Off critical path; activation only after readiness and canary gates. |
| Acceptance criteria | Artifact hash failure blocks activation; incompatible class map rejected; rollback restores exact preprocessing and model set. |

Implementation requirements:

- Manifest pins weights, runtime/container digest, class taxonomy, normalization, input shape, thresholds and license/provenance.
- Temporal models require explicit state schema and sequence recovery support. Baseline models are stateless.
- Switching versions creates a processing boundary; P05 resets incompatible state and reports the reset.
- Species, smoke and flame models have independent availability and evaluation gates.

## I01 — Media session gateway

| Contract | Specification |
|---|---|
| Interfaces | Vendor adapter / RTSP / RTMP / SRT as negotiated; internal session route; separate browser preview egress. |
| Consumed events | session.changed |
| Produced events | archive.request, media.segment.ready, stream.health, audit.event |
| State and persistence | Connection and codec state on one worker; durable session ownership in C02; local bounded spool. |
| Ownership key | Tenant + mission + session + RGB sensor. |
| Horizontal scaling | Add session workers based on admitted stream count, bitrate and measured decoder capacity. Existing connections drain; they are not moved by ordinary HTTP load balancing. |
| Failure behavior | Reconnect creates explicit sequence discontinuity. No arbitrary mid-GOP resume; request/await keyframe. Record source gaps and buffering age. |
| Proposed budget | Ingress framing/dispatch allocation 100 ms; transport budget measured separately. |
| Acceptance criteria | Worker termination yields a visible gap/reconnect; no two active writers under the same ownership epoch. |

Implementation requirements:

- Validate codec, dimensions, frame rates and decoder resource limits against the mission contract.
- Pass the low-latency encoded stream to the assigned P01 decoder; evidence segments are committed through I04 before ready events.
- Keep live display fan-out separate from analytical decoding so slow viewers cannot block analysis.
- RTMP/RTSP alone does not establish live radiometric access; I03 uses its own capability negotiation.

## I02 — Telemetry and environmental ingress

| Contract | Specification |
|---|---|
| Interfaces | MQTT/TLS device topics or SDK adapter; optional gRPC batch ingestion; ACK includes highest durably accepted sequence. |
| Consumed events | None; synchronous interface or scheduled work. |
| Produced events | input.gap, stream.health, telemetry.normalized, audit.event |
| State and persistence | Deduplication window and durable source-sequence index; Kafka normalized stream. |
| Ownership key | Tenant + mission + session + sensor. |
| Horizontal scaling | Replicas scale by messages/s, connections and broker lag; distributed MQTT broker or connection routing handles client placement. |
| Failure behavior | Reject impossible units/shape, preserve invalid measurement flags. Broker outage causes bounded gateway spool; acknowledge only durable acceptance. |
| Proposed budget | Normalize and durable publish <=100 ms under admitted load. |
| Acceptance criteria | Duplicate sequence is idempotent; boot-time clocks remain distinguishable from UTC; estimated wind cannot be labelled measured. |

Implementation requirements:

- Normalize pose, GNSS accuracy, gimbal attitude, velocity, air temperature, humidity and wind, preserving original vendor fields in evidence.
- Specify coordinate conventions: NED/ENU/body axes, quaternion order, height datum and wind toward/from convention.
- Maintain per-source clock mapping and uncertainty; report reset/wrap events instead of forcing monotonic wall-clock values.
- No hard-coded relationship between API weather and local wind observations.

## I03 — Radiometric ingress

| Contract | Specification |
|---|---|
| Interfaces | Vendor radiometry SDK / USB-UVC Y16 gateway / authenticated binary gRPC; optional R-JPEG upload path explicitly labelled still-image mode. |
| Consumed events | None; synchronous interface or scheduled work. |
| Produced events | archive.request, input.gap, stream.health, thermal.ready, audit.event |
| State and persistence | Immutable binary batches in hot store; sequence manifest and original sensor settings. |
| Ownership key | Tenant + mission + session + thermal sensor. |
| Horizontal scaling | CPU/I/O workers scale by pixels/s, ingest bandwidth and storage latency; stream order tracked per source. |
| Failure behavior | Unknown encoding or gain setting quarantines measurement conversion. Saturated/invalid pixels retain masks. Partial uploads never publish ready. |
| Proposed budget | Batch dwell <=100 ms; durable upload/read publication within measured ingest budget. |
| Acceptance criteria | Truncated payload and checksum mismatch rejected; colorized image cannot satisfy radiometric capability. |

Implementation requirements:

- Preserve original raw counts when supplied; derived Celsius arrays include exact conversion and calibration references.
- Specify dtype, shape, row stride, endianness, compression, invalid-value mask and range/gain for every batch.
- Support multipart/retried uploads by stable payload identity and digest; same ID with different bytes is an error.
- Validate sensor-specific formats through adapters rather than one universal counts-to-Celsius formula.

## I04 — Evidence archive and lifecycle

| Contract | Specification |
|---|---|
| Interfaces | Internal CommitEvidence / PinEvidence / ResolveEvidence; object read tokens issued through authorized API. |
| Consumed events | archive.request |
| Produced events | evidence.ready, stream.health, audit.event |
| State and persistence | Object store originals, immutable manifests, PostgreSQL retention pins and archive outbox. |
| Ownership key | Tenant + mission + session + segment ID. |
| Horizontal scaling | Stateless writers scale by bytes/s and upload age; lifecycle jobs shard by tenant/time prefix. |
| Failure behavior | Retry with the same object identity; media backlog is bounded and explicitly signalled. Durable object-write ACK is distinct from merely queued archive work. |
| Proposed budget | Live short analysis batches do not await closed multi-second archive segments. |
| Acceptance criteria | Object exists/checksum validated before ready event; retention cannot delete pinned evidence or active replay inputs. |

Implementation requirements:

- Keep original RGB encoded segments, raw thermal data, telemetry and mappings from frame IDs to source offsets.
- Publish evidence state as pending, committed, unavailable or expired; never show a broken link as available evidence.
- Archive high-water marks make recovery gaps visible; offsite replication has its own completion watermark.
- Garbage-collect orphaned uploads only after a grace period and manifest reconciliation.

## P01 — Decode, frame accounting and synchronization

| Contract | Specification |
|---|---|
| Interfaces | Assigned live media channel from I01; consume source metadata; publish durable frame-batch references. |
| Consumed events | media.segment.ready, thermal.ready, telemetry.normalized, input.gap |
| Produced events | archive.request, frame.accounted, frame.ready, input.gap, audit.event |
| State and persistence | Codec state, bounded event-time buffers, source indices, pose cache and checkpoint/outbox per shard. |
| Ownership key | Tenant + mission + session + analysis run. |
| Horizontal scaling | Scale sessions across CPU/media nodes; each decoder has measured codec/resolution capacity. GPU decode may use a distinct media pool. |
| Failure behavior | Wait up to configured synchronization deadline, then publish partial bundle with missing modalities. Late data enters revision/replay flow, never an unmarked old live update. |
| Proposed budget | Proposed pairing tolerance 100 ms and wait cap 150 ms; both are configurable and must be validated against motion and camera timing. |
| Acceptance criteria | Out-of-order telemetry pairs by capture time; pose outside interpolation bounds is unavailable; every RGB sequence has an accounting record. |

Implementation requirements:

- Decode all admitted RGB frames. Strict mode schedules fire/smoke inference for every received frame; vegetation sampling is separately declared.
- Thermal reuse for nearby RGB frames carries its original timestamp, thermal frame ID and delta; reused data is not a new temperature measurement.
- Nearest-frame and pose interpolation policies record temporal uncertainty and do not extrapolate across unbounded gaps.
- Publish durable encoded-source frame references with keyframe dependency ranges; decoded tensors remain bounded transient cache entries. Cross-node tensor transfers are counted in capacity.py.
- Live deadline failures produce explicit failed/late records. Deferred replay must not claim the original live deadline was met.

## P02 — Thermal measurement and hotspot candidates

| Contract | Specification |
|---|---|
| Interfaces | Consume bundles with radiometric references; no LLM dependency. |
| Consumed events | frame.ready |
| Produced events | thermal.observation, audit.event |
| State and persistence | Stateless raster calculations; immutable thermal observation output and input deduplication ledger. |
| Ownership key | Thermal frame ID + calibration version + thermal algorithm version + analysis run. |
| Horizontal scaling | CPU workers scale on megapixels/s and queue age; vectorized NumPy/C++ implementation; GPU optional only after profiling. |
| Failure behavior | Calibration missing: preserve raw evidence and mark Celsius unavailable. Saturation produces bounds/flags, not a precise false maximum. |
| Proposed budget | Thermal computation allocation <=50 ms per frame at benchmarked resolution. |
| Acceptance criteria | Known raster fixtures reproduce cell statistics; invalid/saturated pixels and all-invalid cells handled explicitly. |

Implementation requirements:

- Calculate min, mean, p95, max, valid fraction and configurable anomaly masks; never replace raw measurements with VLM estimates.
- Thresholds are versioned candidate-generation rules, not universal ignition temperatures.
- Image-space cell aggregation covers every source pixel exactly once under a documented edge policy.
- A thermal frame reused in six RGB bundles computes once; duplicate derived observations do not inflate persistence.

## P03 — Vision inference orchestration

| Contract | Specification |
|---|---|
| Interfaces | Consumes tasks and invokes Triton HTTP/gRPC with immutable model ID, request ID and deadline. |
| Consumed events | frame.ready |
| Produced events | frame.accounted, vision.observation, audit.event |
| State and persistence | Stateless requests; durable idempotent output identity and accounting outbox. |
| Ownership key | Analysis run + model deployment + frame ID + tile ID. |
| Horizontal scaling | Worker replicas scale by remaining-deadline backlog; GPU serving capacity is separately controlled. Bound in-flight calls per GPU endpoint. |
| Failure behavior | One bounded retry only when enough deadline remains. Timeout yields failed inference state; never publish an empty successful detection set. |
| Proposed budget | Combined vision queue/inference/postprocess allocation <=350 ms; model-dependent target, not benchmark result. |
| Acceptance criteria | Delayed inference cannot overwrite newer observations; failed model does not become no-fire; tiling inverse transform checked. |

Implementation requirements:

- Fire/smoke fresh inference follows strict frame coverage contract; vegetation/species cadence is independently reported.
- Preprocessing preserves aspect ratio, color space and inverse mapping into original pixels.
- Merge overlapping tile detections/masks deterministically and record model score semantics.
- Unsupported or out-of-distribution species identification returns unknown; preserve broad vegetation classes separately.

## P04 — GPU model serving

| Contract | Specification |
|---|---|
| Interfaces | Triton model inference endpoints; health/readiness/metrics; only approved P03 service identities. |
| Consumed events | None; synchronous interface or scheduled work. |
| Produced events | audit.event |
| State and persistence | Loaded immutable weights, engines, GPU memory and bounded scheduler queues. No mission truth stored here. |
| Ownership key | Model version + hardware/shape profile; requests distributed among ready replicas. |
| Horizontal scaling | Dedicated GPU requests per pod; scale by deadline backlog, inference queue age and measured throughput. Warm minimum replicas and provision nodes before admission. |
| Failure behavior | OOM/unhealthy model instance removed from routing; drain endpoints before shutdown; failed calls return explicit error. |
| Proposed budget | Batching delay initial ceiling 10 ms; tune from measured p95/p99 latency and throughput. |
| Acceptance criteria | Real model warmup precedes readiness; loaded artifact hash matches registry; overload rejects promptly instead of unbounded queueing. |

Implementation requirements:

- Use dynamic batching for stateless models. Do not route sequence-dependent models as independent requests [S2].
- No assumed linear scaling from GPU utilization alone; record memory, queue age, batch size and request rate.
- Budget cold-start/model-download time in capacity reservations. Active critical deployments do not scale to zero.
- TensorRT engines and precision changes require numerical and detection-quality regression evaluation.

## P05 — Evidence fusion and temporal tracking

| Contract | Specification |
|---|---|
| Interfaces | Event consumer with result join by bundle/source IDs and bounded event-time reorder buffer. |
| Consumed events | vision.observation, thermal.observation, input.gap |
| Produced events | fused.observation, track.reset, audit.event |
| State and persistence | PostgreSQL checkpoint, tracker state blob, inbox and outbox under fenced shard ownership. |
| Ownership key | Tenant + mission + session + analysis run. |
| Horizontal scaling | One owner per session/run; scale across sessions. Batch transactions where safe; one hot session remains a measured limit. |
| Failure behavior | Join deadline produces partial result with missing evidence. Recovered tracker resets are explicit. Gap/stale evidence cannot clear an active fire candidate. |
| Proposed budget | Fusion/reorder allowance <=150 ms; publish partial evidence without waiting for optional vegetation model. |
| Acceptance criteria | Duplicate thermal reference does not count as repeated confirmation; camera motion is not reported as ground fire motion. |

Implementation requirements:

- Combine visual and thermal evidence without requiring both for every observation.
- Track candidates across frames with source-specific timestamps and visibility; unknown/occluded is distinct from absent.
- Correlated adjacent frames do not count as independent probability evidence; scores require calibration before probabilistic labels.
- Checkpoint references model/calibration versions and next expected frame; late updates receive an observation revision.

## P06 — Georeferencing and footprint projection

| Contract | Specification |
|---|---|
| Interfaces | Consumes observations; reads immutable calibration, terrain and pose snapshots. |
| Consumed events | fused.observation |
| Produced events | geo.observation, audit.event |
| State and persistence | Stateless projection tasks, bounded terrain/calibration caches and immutable results. |
| Ownership key | Observation ID + projection version + analysis run. |
| Horizontal scaling | CPU replicas scale by projection cost and terrain-cache hit rate; terrain tiles prefetched along mission AOI. |
| Failure behavior | Missing ground intersection, stale pose or excessive error returns image-space-only result and explicit reason. |
| Proposed budget | Projection allowance <=100 ms on cached terrain. |
| Acceptance criteria | Known surveyed targets verify error; degrees are never used as meters for area or distance; elevation datum mismatches rejected. |

Implementation requirements:

- Combine sensor intrinsics, gimbal/body transforms, GNSS/RTK pose and DEM/DSM; drone GPS alone is insufficient.
- Record horizontal error estimate, calibration version, terrain version and geometry validity.
- Image quadrants are not cardinal directions. Ground footprint can be null even with a valid thermal observation.
- Use a suitable projected CRS for mission calculations; transform published GeoJSON into longitude/latitude order.

## P07 — Spatial grid materialization

| Contract | Specification |
|---|---|
| Interfaces | Tile-keyed reducers; latest/history read projections served by D03. |
| Consumed events | geo.observation, weather.snapshot, context.changed |
| Produced events | grid.stale, grid.updated, audit.event |
| State and persistence | PostGIS tile/cell state, observation contribution index, revisions, inbox/outbox; large masks/raster tiles in object storage. |
| Ownership key | Tenant + mission + grid version + tile ID + analysis run. |
| Horizontal scaling | Scale reducers by occupied tile keys and queue age; fixed tile ownership; batch sparse deltas rather than per-cell DB roundtrips. |
| Failure behavior | Late contributions cannot regress current observation time. Missing coverage marks stale/unknown; version changes rebuild into a separate namespace. |
| Proposed budget | Grid commit and outbox allowance <=100 ms per bounded delta batch. |
| Acceptance criteria | Overlapping drones do not double-count area; stale packets cannot overwrite newer current cells; tile-edge objects retained. |

Implementation requirements:

- Preserve per-source contributions and uncertainty; max/mean temperature fusion must be explicitly defined and time-qualified.
- Attach local weather references without inventing meter-scale wind from a kilometer-scale forecast.
- Material fractions and material-specific temperatures require verified RGB/thermal registration; otherwise keep them separate.
- Publish changed cells and coverage masks. All cells include observation age, footprint and grid resolution.

## X01 — Weather ingestion and cache

| Contract | Specification |
|---|---|
| Interfaces | Provider HTTPS APIs; internal GetWeather for AOI/time; scheduled refresh with single-flight request deduplication. |
| Consumed events | None; synchronous interface or scheduled work. |
| Produced events | weather.snapshot, audit.event |
| State and persistence | Versioned provider responses in object storage; PostGIS metadata by provider/grid/time; quota and refresh schedule. |
| Ownership key | Provider + source grid cell + model run + valid time. |
| Horizontal scaling | Workers scale by unique requested provider cells, not by drone count; shared requests amortized; honor provider quotas. |
| Failure behavior | Provider outage returns last available snapshot with age/stale flag. Forecast never relabelled as a local sensor observation. |
| Proposed budget | Off per-frame critical path; cache lookup target <=20 ms. |
| Acceptance criteria | Original issue/valid/fetch times preserved; historical replay cannot read a forecast issued after the replay decision time. |

Implementation requirements:

- Normalize wind vector/convention/height, air temperature, humidity, precipitation and available gusts.
- Retain model resolution, provider, source licence/attribution and unit conversion version.
- Refresh on actual provider publication cadence; polling every second does not generate new weather evidence [S8].
- Local sensor disagreement is exposed; no silent averaging with forecast output.

## X02 — Terrain, fuel and reference-data catalog

| Contract | Specification |
|---|---|
| Interfaces | Internal immutable tile/reference retrieval; administrative dataset import and validation endpoints. |
| Consumed events | None; synchronous interface or scheduled work. |
| Produced events | context.changed, audit.event |
| State and persistence | Object-store terrain/fuel tiles; PostGIS footprint/version metadata and source attribution. |
| Ownership key | Dataset version + tile + coordinate/elevation reference system. |
| Horizontal scaling | Read replicas/cache/CDN for immutable tiles; imports separate from real-time serving. |
| Failure behavior | Missing/incompatible tiles produce unavailable context; never assume flat ground without explicit degraded-mode policy. |
| Proposed budget | Prefetch outside hot path; cache-hit target <=20 ms. |
| Acceptance criteria | Vertical datum and spatial resolution preserved; unlicensed/unapproved datasets cannot become active defaults. |

Implementation requirements:

- Terrain supports projection; vegetation/fuel maps provide contextual priors rather than current drone measurements.
- Future ignition references distinguish material identity and test conditions; no universal ignition threshold is returned.
- Dataset corrections create a version and optional backfill, not silent mutation of old evidence.
- Expose uncertainty and date of collection so operators can distinguish outdated land cover.

## D01 — Incident correlation and decision rules

| Contract | Specification |
|---|---|
| Interfaces | POST /v1/incidents/{id}/reviews via gateway; mission-owned event processor; optimistic If-Match revision checks. |
| Consumed events | grid.updated, grid.stale, fused.observation, stream.health |
| Produced events | incident.changed, notification.requested, audit.event |
| State and persistence | Incident state/history, operator reviews, association/alias graph and outbox in PostgreSQL. |
| Ownership key | Tenant + mission + analysis run; one fenced decision owner per mission. |
| Horizontal scaling | Scale across missions. Coalesce repeated cell evidence before decision evaluation; validated per-mission throughput is an admission limit. |
| Failure behavior | Duplicate events are idempotent. Lost coverage marks uncertain/stale, not resolved. Rule/model failure cannot silently close incidents. |
| Proposed budget | Immediate candidate publication <=100 ms after qualified input; confirmation may require a separate configured evidence window. |
| Acceptance criteria | Repeated adjacent frames cannot create alert storms; mission-edge candidates deduplicated; stale/occluded region cannot auto-resolve. |

Implementation requirements:

- States: CANDIDATE, CORROBORATED, OPERATOR_CONFIRMED, MONITORING, RESOLVED, DISMISSED. Corroborated is not operator confirmed.
- Store severity rationale and evidence independently of raw model score. Human reviews include author/time/revision.
- Associate cross-drone evidence inside the mission; keep per-drone track IDs and canonical incident aliases.
- No automatic dispatch of crews or flight commands. Future forecast results remain typed separately from observed boundaries.

## D02 — Notification dispatcher

| Contract | Specification |
|---|---|
| Interfaces | Signed customer webhooks; optional configured channels with tenant-approved destinations. |
| Consumed events | notification.requested |
| Produced events | notification.delivery, audit.event |
| State and persistence | Delivery attempts/receipts and unique delivery key in PostgreSQL; outbox state. |
| Ownership key | Tenant + incident ID + incident revision + channel + destination ID. |
| Horizontal scaling | Stateless dispatchers scale by pending delivery age; per-destination concurrency/rate limits. |
| Failure behavior | Retry transient failures with exponential backoff/jitter and TTL; terminal failures go to review. External exactly-once delivery cannot be guaranteed. |
| Proposed budget | First delivery attempt p95 <=1 second after request; recipient network time tracked separately. |
| Acceptance criteria | Crash after recipient ACK does not create a new event ID; retries use same idempotency key; replay cannot contact production endpoints. |

Implementation requirements:

- Sign body and timestamp; receiver can reject stale/replayed messages. Destinations configured by authorized tenant admin.
- Include observation age and evidence link; do not promise a link before evidence is committed.
- Persist request intent before sending. Support acknowledge/failure audit and rate-limited escalation policies.
- Notification retry queues cannot backpressure ingestion or GPU analysis.

## D03 — Query, map and evidence API

| Contract | Specification |
|---|---|
| Interfaces | GET /v1/missions/{id}/snapshot; GET /v1/missions/{id}/observations; GET /v1/incidents/{id}; GET /v1/evidence/{id}/access; map tile routes. |
| Consumed events | None; synchronous interface or scheduled work. |
| Produced events | audit.event |
| State and persistence | Read projections from PostGIS/read replicas; version-aware caches. No direct ownership of processing state. |
| Ownership key | Tenant + mission + query/viewport; cache keys always include access scope and data version. |
| Horizontal scaling | Stateless replicas, database read replicas and bounded viewport queries. Limit time range, geometry size and page size. |
| Failure behavior | Replica lag and projection watermark returned to client. Stale cache never represented as current live data. |
| Proposed budget | Snapshot p95 <=300 ms for bounded requested AOI under reference load. |
| Acceptance criteria | Tenant-scoped access checked on every geometry/evidence link; oversized bbox/time queries rejected with useful error. |

Implementation requirements:

- Return GeoJSON only for validated geographic outputs; image-space evidence remains a different schema.
- Use cursor pagination and revision-based conditional requests. Signed media access is short-lived and authorized at issuance.
- Return data watermark, generated time, freshness and available coverage with every map snapshot.
- Read-after-review uses primary/commit token when replicas have not reached the operator review revision.

## D04 — Live subscriptions and preview delivery

| Contract | Specification |
|---|---|
| Interfaces | WebSocket /v1/live; mission-scoped subscriptions with durable cursors; WebRTC preview via media gateway. |
| Consumed events | grid.updated, incident.changed, stream.health |
| Produced events | audit.event |
| State and persistence | Local connection buffers; durable change-log cursors and authorization context; no authoritative incident state. |
| Ownership key | Tenant + mission + connection; change-log source retains per-shard cursor components. |
| Horizontal scaling | Connection-sharded pods with a fan-out routing layer. A single consumer group cannot be assumed to broadcast every message to every pod. |
| Failure behavior | Slow client: coalesce replaceable grid updates, keep incident transitions, then send resync-required and disconnect at bounded buffer limit. |
| Proposed budget | Update delivery p95 <=200 ms after read-model commit; preview latency measured independently. |
| Acceptance criteria | Reconnect obtains coherent snapshot plus cursor and catches up without silently missing changes; token expiry closes access. |

Implementation requirements:

- Snapshot API returns a composite cursor at its projection watermark; subscribe replays later changes; expired cursors require a fresh snapshot.
- Avoid unbounded per-client Kafka groups; use shared partition readers and route authorized mission events to pods with subscribers.
- Reauthorize long-lived sessions on token refresh and mission access revocation.
- Preview frame rate is independent from analytical frame coverage and is labelled accordingly.

## O01 — Replay, backfill and evaluation

| Contract | Specification |
|---|---|
| Interfaces | POST /v1/replays; GET /v1/replays/{id}; admin/evaluator scopes. |
| Consumed events | replay.request |
| Produced events | replay.completed, replay.request, audit.event |
| State and persistence | Job manifests, evidence leases, isolated result namespaces and evaluation reports. |
| Ownership key | Tenant + replay run + mission segment; deterministic input identities retained. |
| Horizontal scaling | Separate CPU/GPU pools or hard reserved quota; batch jobs cannot consume reserved live capacity. |
| Failure behavior | Resume checkpointed work; incomplete evidence is reported in coverage denominator. No production notification credentials. |
| Proposed budget | Throughput-oriented; no live latency SLO. |
| Acceptance criteria | Same archive replay cannot alter live incidents; future-issued weather unavailable to historical decision; missing frames included in coverage report. |

Implementation requirements:

- Pin source assets, model/calibration versions, rules and environment digest; use original capture timeline.
- Compare precision/recall, false alarms per camera-hour, time-to-detection, temperature accuracy where references exist and map error.
- Record non-deterministic inference differences; replay idempotence does not imply bitwise identical floating-point outputs.
- Training/evaluation dataset splits separate whole sites/incidents, not adjacent frames.

## O02 — Audit and operational health projection

| Contract | Specification |
|---|---|
| Interfaces | Internal OpenTelemetry metrics/logs/traces; tenant status API through D03; operator audit queries. |
| Consumed events | audit.event, stream.health, frame.accounted, notification.delivery |
| Produced events | health.changed |
| State and persistence | Append-only audit archive, telemetry backend and health read projections. |
| Ownership key | Service/region for metrics; tenant + mission for health; audit retention independent from debug logs. |
| Horizontal scaling | Collectors and projections horizontally partitioned; enforce metric cardinality budgets and sampling. |
| Failure behavior | Telemetry sink outage buffers within limits; core processing does not depend on a remote log write. Security/decision audit intents use durable outbox. |
| Proposed budget | Stale-input detection initial target <=5 seconds; thresholds depend on expected sensor cadence. |
| Acceptance criteria | Source frame gaps and processing deadline misses visible separately; no tokens or imagery in ordinary logs. |

Implementation requirements:

- Measure capture-to-result, ingest-to-result, source clock quality, queue age, rejected/late frames, GPU warmup and archive durability watermarks.
- Do not put frame IDs or cell IDs into metric labels; use trace/log correlation for individual evidence.
- Track latency and coverage together: dropping slow frames must not falsely improve the service quality report.
- Alerts distinguish link outage, modality loss, backlog, calibration failure, storage outage and model failure.

## Shared implementation requirements

- The service catalog is logical: broker, database, identity provider, object store and telemetry backend are platform dependencies, not hidden in-process substitutes.
- Stateless workers acknowledge consumed events only after durable output/idempotency state is recorded. Stateful workers additionally enforce ownership epoch in the commit transaction.
- Retry only transient failures, propagate deadlines, bound concurrency and use jitter. Permanent schema/calibration errors produce a rejected record and quarantine reference.
- Poison events go to a versioned per-topic DLQ with reason, original event ID and evidence reference. Recovery requires an explicit replay run; DLQ replay is never automatic live notification.
- CPU/memory requests are set from measured peak working set and per-pod capacity; GPU pods request explicit GPU resources. Do not copy arbitrary resource limits into production.
- No direct database joins across service-owned schemas in application code. Queries use projections/events; administrative forensic queries are audited.
- All public endpoints require authorization and tenant quotas; webhooks are outbound only to configured destinations.
- S1–S8 source links are in 01-architecture.md. Service rules and timings are Firewatch design proposals.
