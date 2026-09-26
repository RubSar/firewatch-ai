# 3. Data contracts, APIs and consistency

## 3.1 Canonical event envelope

All events use the Firewatch envelope, an internal contract rather than a claim of formal CloudEvents compliance. Live topics use `fw.live.<event-type>.v1`; replay uses a separate `fw.replay.<run-id>.<event-type>.v1` namespace or equivalent isolated cluster/ACL boundary. Production consumers have no wildcard replay subscriptions.

| Field | Type / rule |
|---|---|
| schema_version | String; major/minor contract version. Unknown major rejected; additive optional minor fields require registered compatibility policy. |
| event_id | Stable identifier derived from semantic identity, not retry attempt or publication time. |
| event_type | Logical event name, such as frame.ready. |
| tenant_id / mission_id | Tenant mandatory; mission nullable only for explicitly tenant-level context/control events. |
| session_id | Mandatory for sensor/stream events; null for non-session product/context events. |
| analysis_run_id | Live or replay run identity; never infer live/replay mode from wall-clock time. |
| region_epoch | Monotonic mission-region generation; checked against C02 routing state. |
| owner_epoch | Shard-writer fencing generation; stateless producers may use zero. |
| occurred_at / received_at | UTC RFC3339 timestamps or null capture time if clock mapping is unavailable; source clock fields still retained for inputs. |
| produced_at | UTC time of this result. Does not replace observation time. |
| source_sequence | Nonnegative integer per sensor session where relevant; not a global ordering key. |
| trace_id / causation_id | Trace correlation and triggering event ID; trace IDs are not authorization. |
| payload | Versioned typed payload. Oversize records use a reference to a validated immutable object. |

Metadata ceiling: proposed 256 KiB/event; target ordinary events <=2 KiB. Payloads are UTF-8 JSON initially; Protobuf/Avro is a later wire optimization with registered evolution and equivalent semantics. `NaN` and infinity are prohibited in JSON. Missing measurements use null plus a reason/status; actual zero is distinct. Reject invalid lengths, units, encodings and maximum array sizes before allocations.

The `contracts/` directory contains executable JSON Schemas and examples for four core events: telemetry.normalized, frame.ready, grid.updated and incident.changed. Remaining contracts below are normative field-level specifications to be converted to schemas before implementing their producers. This is not a complete generated client SDK.

## 3.2 Sensor and binary payload contract

Frame identity is `(tenant, mission, session, sensor, source_sequence)`. A source sequence reused with different bytes is a conflict and quarantine condition. Image timestamps represent exposure time when available; a gateway-estimated capture time is explicitly labelled with its error bound. Time mappings preserve raw boot/device timestamps, drift estimate, synchronization source and maximum uncertainty.

Binary references contain `object_key`, `object_version`, `sha256`, `byte_length`, content type, encoding and optional byte range. A frame reference additionally specifies width/height, pixel stride, row stride, endianness, frame index and `decode_dependencies` when encoded media is not independently decodable. Ready publication requires all dependencies to be readable. The selected codec/frame reader validates offsets against object size and rejects decompression bombs and absurd dimensions.

Permitted thermal encodings are adapter-specific RAW16 with documented conversion, temperature-linear UINT16 with gain/scale/offset, or FLOAT32 Celsius. Compression must be lossless for numerical measurements. Colorized PNG/JPEG belongs to `preview`, never `radiometric`. Preserve invalid-pixel/saturation masks and radiometry settings. RGB H.264/H.265 byte streams are a different data type from decoded RGB888 tensors. Recorded R-JPEG files are processed by the camera-specific SDK and do not imply a live full-frame radiometric capability.

Calibration and evidence records are immutable references, not arbitrary embedded external URLs. Consumers cannot fetch a source-supplied URL without validating its registered storage namespace and tenant authorization.

## 3.3 Temporal join policy

P01 creates a bundle for each admitted RGB frame; thermal-only operation creates bundles at thermal cadence. Proposed live pairing tolerance: 100 ms; maximum wait for counterpart/pose data: 150 ms. A mission may use stricter values after calibration and motion testing. A match stores both capture times, skew, source frame IDs and interpolation method. A thermal frame reused across RGB frames counts once for thermal persistence statistics.

Pose interpolation is allowed only between valid bracketing samples whose gap and uncertainty fall within configured limits. Quaternion interpolation must account for rotation representation; geographic distance calculations must use the declared reference system. Unsupported extrapolation yields unavailable pose. Time tolerance does not prove geometric registration.

P05 holds out-of-order inference results within its configured reorder window. At the deadline it publishes partial evidence and accounts for the missing result. A late result can produce a new historical observation revision but cannot regress the current grid. Corrections are distinct events with a `supersedes` link and cannot resend an old alert as though it were fresh.

## 3.4 Product data entities

| Entity | Minimum contents | Identity / lifecycle |
|---|---|---|
| ThermalObservation | Source thermal frame, calibration, image mask, min/mean/p95/max, validity and saturation, uncertainty status | Thermal frame + algorithm + calibration + run |
| VisionObservation | Model/deployment, preprocessing, class taxonomy, scores, masks/bboxes, original-image transform, fresh/tracked flag | Frame + model + tile/merge version + run |
| FusedObservation | Source observations, time skew, registration quality, visual/thermal evidence, track ID/generation | Session + track generation + observation revision |
| GeoObservation | Image footprint, geographic geometry or null, projected CRS, pose/terrain references, horizontal error/status | Observation + projection version |
| GridDelta | Grid/CRS/tile version, changed cells, spatial coverage, temperature summaries, class fractions, latest source times and provenance | Mission + grid + tile + monotonic revision + run |
| Incident | Canonical ID, aliases, state, observed boundary/coverage, first/last seen, evidence, rule version, revision, review history | Mission-owned; never equate missing coverage with resolved |
| WeatherSnapshot | Provider/model run, issue/valid/fetched times, resolution, height, wind convention, units and uncertainty | Provider cell + issue run + valid time |
| FrameAccounting | Expected/received frame ID, processing stage, outcome, reason, completion time/deadline | Frame + required stage + run; one current outcome plus history |
| DeliveryAttempt | Incident revision, destination, delivery key, attempts, provider receipt/status | Stable delivery key across retries |

Large grid deltas contain a `cells_ref` rather than exceeding the metadata ceiling. A delta identifies its base revision; clients unable to apply that base fetch a snapshot. Cells carry `observed_at`, `updated_at`, valid coverage, age/stale state and geometry quality. Image-grid row/column and metric-ground-grid coordinates are separate identifiers.

Material mixtures are fractions with an unknown remainder, not one compulsory label per cell. Material-specific temperature needs a valid mask/registration intersection. Species, moisture and ignition conditions remain nullable separate attributes. No fixed-temperature threshold directly produces an ignition probability. Weather fields attached to cells retain their source resolution; they are not reclassified as cell-level measurements.

## 3.5 Remaining event payloads

| Event | Required semantic fields beyond the envelope |
|---|---|
| session.command | Command ID, intended state, admission profile, device/capability references, caller scope |
| session.changed | Session revision, state, admitted rates, model/calibration manifest, home region, capacity reservation |
| calibration.changed | Sensor ID, old/new immutable versions, validation status, effective source boundary |
| deployment.changed | Deployment ID/revision, artifact/runtime hashes, approved policy, readiness and activation boundary |
| media.segment.ready | Segment/chunk ID, stream offset/time range, codec, keyframe dependencies, committed object reference |
| thermal.ready | Sensor sequence/time, raster reference, shape/dtype, calibration/gain, invalid/saturation references |
| input.gap | Sensor, first/last missing sequence or unknown range, reason, detected time, recovery status |
| stream.health | Expected/actual cadence, last-seen times, clock quality, reconnect and buffering status |
| archive.request | Stable asset ID, payload/source references, capture interval, requested retention/pins |
| evidence.ready | Asset ID, committed object reference, checksum, frame index, retention policy and replication watermark |
| frame.accounted | Frame ID, required stage, outcome, deadline, reason, fresh inference or propagated state |
| thermal.observation | ThermalObservation fields above; validity cannot be inferred from a maximum value alone |
| vision.observation | VisionObservation fields above; score calibration status explicit |
| fused.observation | FusedObservation fields above; missing modalities named |
| track.reset | Track namespace, old/new generation, cause, checkpoint/recovery boundary |
| geo.observation | GeoObservation fields above; split multi-tile output identifies common original observation |
| grid.stale | Tile/cells, last observation time, expiry rule, visibility/coverage reason |
| weather.snapshot | WeatherSnapshot fields above; local observations remain separate inputs |
| context.changed | Dataset and tile IDs, old/new version, licence/provenance and applicable spatial/time bounds |
| notification.requested | Incident ID/revision, delivery key, authorized destination ID, severity rationale, evidence state, expiry |
| notification.delivery | Delivery key, attempt count, sent/acknowledged times, provider receipt, retry/terminal reason |
| replay.request | Run ID, immutable input manifest, model/rule/calibration versions, time bounds and isolated output namespace |
| replay.completed | Run ID, coverage, completion/error counts, report references and artifact hashes |
| audit.event | Actor/service, action, object ID/revision, authorization decision, time and causation; secret values excluded |
| health.changed | Mission health revision, component/modalities affected, data age, reason and recovery status |

## 3.6 Topic catalog, partitions and routing

`topics.json` records 29 logical topics with producers, consumers, proposed partition counts, retention and key templates. These are initial design values, not tuned broker configuration. Control/audit topics are included. Production topic names must include environment and region through cluster/namespace configuration; live and replay identities are mandatory.

Shared-source topics may be consumed by separate service consumer groups. Within one service group, partitions limit active ordered consumer parallelism. P03 can process several independent inference tasks concurrently within an assigned partition; its results may arrive out of order and P05 joins by identity/time. Do not infer temporal order from Kafka arrival across vision, thermal and telemetry topics.

Routing transformations are explicit: session-keyed fused observations become tile-keyed geo observations after P06. P07 emits tile-keyed grid deltas; a repartition stream for D01 uses mission key. Both the original event ID and the derived routing event ID are retained. Large cell arrays are coalesced into bounded tile deltas before mission-level decisions; D01 does not ingest raw pixel arrays.

The table's consumer subscriptions are logical dependencies; a bootstrap compiler must create the required repartition/join topics and ACLs. That compiler is an implementation deliverable, not provided deployment code. Weather snapshots fan out only to intersecting active mission shards using a context-subscription index; every tile worker does not scan the global weather topic.

## 3.7 API behavior

All paths are illustrative versioned public contracts to implement. Tenant comes from verified credentials, not a trusted arbitrary request-body field. Internal APIs use mTLS service identities and explicit authorization.

| Endpoint | Input | Success output | Important errors |
|---|---|---|---|
| POST /v1/missions | Name, AOI/CRS, policy ID, region preference | 201 mission ID, revision and capability needs | 422 invalid AOI; 403 tenant policy |
| POST /v1/missions/{id}/sessions | Device ID, sensor capabilities, rates, analysis mode, calibration IDs, idempotency key | 201 session and admitted profile, or 202 STARTING with readiness URL | 409 capacity/profile conflict; 503 no ready capacity |
| POST /v1/sessions/{id}/close | Expected revision and reason | 202 DRAINING; final stream watermarks later | 409 stale revision |
| POST /v1/calibrations | Calibration metadata and approved upload references | 201 immutable version, initially unapproved | 422 sensor/format mismatch |
| POST /v1/deployments | Approved model/policy manifest and target cohort | 202 rollout ID | 409 incompatible deployment; 403 unapproved artifact |
| GET /v1/missions/{id}/snapshot | Bounded bbox, layers, grid version, optional observation time | Snapshot, freshness, coverage and composite cursor | 422 overly broad request; 410 expired history |
| GET /v1/missions/{id}/observations | Time window, kind, cursor, page size <=1,000 | Ordered bounded page, next cursor, query watermark | 422 invalid range |
| GET /v1/incidents/{id} | Optional revision | Incident, evidence states, aliases and review history | 404 scoped not found |
| POST /v1/incidents/{id}/reviews | If-Match revision, action, note, idempotency key | 200 new revision or 202 committed pending projection | 409 revision conflict; 403 insufficient role |
| GET /v1/evidence/{id}/access | Authorized asset ID and intended operation | Short-lived read grant plus media type/checksum | 409 evidence pending; 410 expired |
| GET /v1/maps/{mission}/{grid}/{z}/{x}/{y} | Authorized tile and optional revision | Versioned raster/vector tile with coverage metadata | 404 no coverage, not a no-fire assertion |
| WS /v1/live | Token, mission scope, layers, composite resume cursor | Snapshot-aligned deltas, incident transitions and health | resync_required; access_revoked; slow_consumer |
| POST /v1/replays | Immutable input/time/version manifest | 202 replay run ID and isolated output path | 422 missing evidence; 409 quota |
| GET /v1/replays/{id} | Scoped run ID | Progress, coverage, reports and failures | 404 scoped not found |

Mutations accept `Idempotency-Key`; the service stores key + tenant + route + body hash for the configured retry horizon. Same key/different body returns 409. Errors use a consistent JSON object with `code`, `message`, `retryable`, `trace_id` and optional validation details. Never expose credentials, internal object paths from another tenant or raw vendor error bodies.

## 3.8 Transaction and delivery semantics

Default: at-least-once processing and idempotent effects. The durable database transaction contains inbox deduplication, epoch check when needed, updated state/revision and outbox event. Offset acknowledgement occurs after that commit. If a crash occurs after commit but before acknowledgement, replay sees the inbox record and does not repeat the state transition. If an outbox relay publishes twice, downstream uses the same event ID. Event IDs are derived from semantic transition identity; replacing a random ID on every retry defeats this design.

Objects cannot participate in the PostgreSQL transaction. Write immutable object first, verify it, then commit the manifest/outbox. A crash between those steps leaves an orphan, not a broken ready event; a reconciliation job removes unreferenced objects after a grace period. A crash after manifest commit is recoverable from the outbox. Compaction uses a new object/version and atomic manifest pointer update, preserving old active read leases.

Kafka transactions can help Kafka-to-Kafka processors, but do not automatically cover PostgreSQL commits, object storage or an external webhook [S3]. Never advertise end-to-end exactly-once external alerts. D02 includes a stable delivery idempotency key so recipients can deduplicate; provider/network failures may still create repeat delivery attempts.

Inbox deduplication records and delivery-key tombstones outlive the maximum accepted live redelivery horizon, including broker retention and recovery grace. Initial policy: retain for at least 45 days where the relevant live/audit topic retains 30 days, and reject older live inputs unless an explicit migration policy permits them. Aged data is evaluated in a new isolated replay run rather than bypassing deduplication. Outbox records are deleted only after publication is confirmed and the reconciliation grace period has elapsed. Incident history/evidence retention is separate from this processing ledger policy.

## 3.9 Compatibility and evolution

New optional fields with explicit defaults may be a compatible minor update after registry checks. Changed units, coordinate axes, class meaning, event ordering key or field type require a new major schema/topic or an explicit conversion service. Old input is never silently reinterpreted under a new model taxonomy.

Contract tests run consumer examples against producer schemas in CI. Required cases include null clocks, missing modalities, thermal saturation, unknown species, duplicate event IDs, sequence reset, out-of-order inference, tile boundary geometry, future weather and invalid tenant references. The included sample checker exercises the subset of JSON Schema used by the four supplied contracts; adopt a full standards-compliant validator and registry in implementation CI.

## 3.10 Units and telemetry vector conventions

The compact telemetry example uses a typed `value` array. Producer adapters and full runtime validators must enforce the kind-specific arity/unit combinations below; the baseline structural schema alone does not enforce these cross-field rules.

| Kind | Unit | Value layout |
|---|---|---|
| wind | m/s | Three elements: north/east/down for NED, east/north/up for ENU, or forward/right/down for BODY. Unknown components are null. Body-relative airflow is not earth-relative wind until motion/attitude correction is applied. |
| air_temperature | degC | One element: local air sensor measurement, or null when unavailable. |
| humidity | percent | One element in [0,100], or null when unavailable. |
| pose | pose_v1 | Fifteen elements: latitude degrees, longitude degrees, altitude MSL meters, altitude AGL meters or null, velocity north/east/down m/s, body-to-NED quaternion w/x/y/z, camera-optical-to-body quaternion w/x/y/z. |

Body axes are forward/right/down. Camera optical axes are right/down/forward; the camera-to-body quaternion explicitly transforms between them. Quaternion order is w/x/y/z and valid orientations are normalized. Latitude must be in [-90,90], longitude in [-180,180]. Pose covariance/accuracy, elevation datum, GNSS quality and calibration context are retained in the immutable `location_ref` pose snapshot; the compact vector is not the complete sensor record. Runtime validation rejects pose_v1 with a non-NED earth reference and rejects incompatible field counts.

Weather wind direction fields, if preserved as an angle, are meteorological direction-from degrees clockwise from true north. Internal north/east vector components describe motion-toward. Adapter conversion must test cardinal cases to prevent a 180-degree error. Report sensor height and its datum; do not mix MSL altitude with height above ground.
