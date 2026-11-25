# Durable run logs and provider traces for disposable web servers

Status: implementation and PR qualification in progress. Runtime storage,
history migration, and canonical native source replay are implemented using the
instance's existing storage selection. Production-provider qualification remains
a rollout gate.
Owner: this Codex chat, through the reviewable PR. Date: 2026-10-30.
Revision: object-storage-first, following Dotta's operational correction on 2026-10-30.
Source revision inspected: `0c70cedce9a803bdc201324528abb35e423e7cd0`.
Parent effort: near-zero-downtime Railway deployment of the main web/API server.

## Goal and boundary

After the main Paperclip web server and its local filesystem disappear, a
replacement connected to the same Postgres, object storage, and secrets can
read all acknowledged run-log output and retained provider traces, then continue
recording the same remote execution without gaps or duplicate records.

The ordinary journey is: open a task's run, inspect its output, replace the web
server while its remote agent is working, and continue reading the run. An
authorized administrator can still inspect, reveal, download, and delete a
captured provider trace. Existing consumers of run output continue working.

This is the **run logs and provider traces** slice of the parent plan. Railway
still documents that volume-backed deployments cannot overlap, which makes
removing durable filesystem dependencies necessary. This slice alone does not
remove every volume dependency or prove zero-downtime HTTP deploys.
[Railway volume limitations](https://docs.railway.com/volumes/reference#caveats).

Firm requirements:

- All retained historical logs and unexpired traces survive migration. Dotta
  explicitly selected this on 2026-10-30. Do not shorten existing retention.
- A successful durable append survives abrupt process and disk loss. An orderly
  shutdown flush is useful but insufficient evidence.
- Preserve company/task authorization, redaction, stable log byte offsets,
  trace integrity checks, opt-in capture, existing limits, expiry, and deletion.
- Store log and raw trace payloads directly in S3-compatible object storage.
  Postgres holds small ownership/lifecycle/reference records only; no new
  per-token or per-frame SQL, payload tables, or DB-to-S3 payload compaction.
  Local files may be caches or unacknowledged buffers. Preserve local mode.
- Keep task results, usage settlement, and optional diagnostics independent.
- Preserve bounded work and existing sleep behavior.
- Reuse existing instance storage settings and per-stack bucket credentials.
  New logs and opted-in traces follow S3 file storage automatically, with their
  own folders beneath the existing prefix. Add no required configuration.

Dotta approved implementation on 2026-10-30. Delivery ends at a reviewable PR
with relevant checks and review findings resolved. Deployment, volume removal,
and production history migration require the parent effort's target and cutover.
The acceptance matrix below remains the full storage-slice contract; an
implemented primitive does not establish that every row has passed.

Deferred to the parent effort: managed agent files, workspace recovery,
accounting/credential journals, workspace-operation logs, readiness/draining,
global live-event fanout, scheduler ownership, volume detach, and fleet rollout.
These remain blockers to claiming the entire web server disposable. No changes
to first-party Telemetry or operator OpenTelemetry export are proposed. Raw
provider protocol traces here are a separate, restricted diagnostic store.

## Current implementation and implications

| Owner | Current behavior | Required change |
| --- | --- | --- |
| `server/src/services/run-log-store.ts` | Only `local_file`; local NDJSON append; best-effort final/in-flight S3 mirroring; local-first reads | Add an explicit external store with shared durable append and reads |
| `server/src/services/heartbeat/run-output.ts` | Redacts/compacts before append; process-local output sequence; progress persisted on a 60-second cadence | Preserve stable source identities; batch output to S3; distinguish live delivery from durable receipts |
| `server/src/services/heartbeat-run-events.ts` | Structured events already use atomic DB sequence allocation and native source deduplication | Preserve this authority; do not turn its event table into a duplicate blob store |
| `server/src/services/provider-trace-store.ts` | DB metadata points to local native and `.rehydration` sidecars; 24-hour retention and 64 MiB capture limit | Remote payload storage, recoverable capture cursors, durable expiry/deletion obligations |
| Runner trace sinks and `runnerd-codex-transport.ts` | Rust/TypeScript capture and interpretation producers use paths; TypeScript capture is bounded and fire-and-forget | Introduce a durable capture delivery boundary and preserve channel/frame lineage |
| `doc/testing-native-remote-continuity.md` | Sparse checkpoints deliberately omit streaming output; acknowledged display output may be lost before app projection | Qualify replay/retention through web replacement without restoring per-token DB checkpoint writes |
| Run readers | Heartbeat, issues, feedback, and customer-success inspection assume `local_file` | Resolve each persisted backend, including historical records, through one reader |

Do not infer cloud durability from `RunLogStore.append()` succeeding today, or
from a trace's local `acknowledgedDebugSequence`. Neither proves remote commit.
Generic stdout/stderr and raw traces cannot be reconstructed from
`heartbeat_run_events`. The implementation investigation found a narrower
surviving source: native control ingestion already commits the exact validated
PRP event before ACK. Its canonical `paperclip.prp.event` log export can replay
that existing source with an S3 cursor, without adding payload writes. This
replaces the tentative second Runner spool below for canonical native output.

## Operational decision

The original proposal used Postgres for payload chunks and then copied them to
S3. That choice was premature. It adds payload writes, WAL/replication/backup
bytes, index churn, deletion/vacuum work, and extra database connections to the
same database serving the control plane. Batching would reduce transaction
count but would not remove the byte load. No workload measurement justified it.

Use **S3 as the durable payload store from the first persisted batch**. Local
append files remain useful for buffering and cache speed; the web server's disk
cannot be their only acknowledged durable home. Existing S3 mirroring is a useful
starting point, but repeatedly uploading the entire growing file amplifies
network and storage work. Upload each newly sealed segment once instead.

| Location | Responsibility |
| --- | --- |
| Browser live stream / bounded server memory | Immediate progress display; not a durable receipt |
| Existing native control event source / Runner outbox | Existing committed native records survive ACK; unacknowledged events remain replayable at the Runner |
| S3-compatible storage | Immutable log/trace segments and bounded manifest/index pages |
| Postgres | Existing company/run ownership, backend/reference, final status and expiry/deletion state; no per-batch writes |
| Disposable web disk | Optional bounded buffer/read cache; never the only acknowledged copy |

Existing structured `heartbeat_run_events`, task results, usage, and controller
checkpoints retain their contracts. This is not a rewrite of those data paths.

### Cost model and the first gate

Let `A` be actively producing streams, `r` output records/second/stream, `b`
bytes/second/stream, `T` maximum dirty-buffer age, and `S` target segment bytes.
For a steady stream, approximate segment rate is
`A × max(1/T, b/S)`; record rate is `A × r`. Empty streams emit no segments.
Bursts, final flushes, retries, indexes, and trace channels add work and must be
counted separately. A stream is not necessarily an agent: raw tracing can add
multiple streams to one run.

Illustrative arithmetic, **not a fleet measurement or chosen production setting**:
100 continuously active streams at 10 records/second give 1,000 records/second.
If five-second flushing dominates, they produce 20 segments/second, or 72,000
segments/hour. With one small metadata publication transaction per segment,
that is still 20 transactions/second. A 30-second interval gives about 3.3
segments/second but retains more pending output. S3 index PUTs, GETs, retries,
and transfer costs are additional. Neither option is free.

The first gate measures real output sizes/rates and concurrency, then compares
candidate size/age thresholds (initial experiment: 256 KiB–1 MiB and 5–30
seconds, not defaults). Include quiet text, bursty tool output, raw tracing,
long runs, slow S3, and the expected concurrent-run envelope. Record:

- Incremental Postgres transactions, row updates, WAL bytes, connections, and
  application p95 latency; no log/trace payload bytes inserted into Postgres.
- S3 PUT/GET/HEAD/LIST counts, index overhead, object count, stored bytes,
  compression CPU, transfer volume, and upload/read p95 latency.
- Pending bytes, upload lag, read recovery time, and behavior at queue limits.
- A daily/monthly cost projection using the **actual configured provider's**
  rates and observed workload/duty cycle; do not substitute AWS prices for an
  S3-compatible vendor or assume 24-hour production.
- Zero added recurring SQL/network work after buffers and obligations settle.

Record a concrete operating envelope, request-rate/backlog limits, and latency
budget from this evidence before enabling the feature. If the batched metadata
load is material, evaluate an object-store manifest head with conditional writes
and lifecycle-only SQL. Choose one publication scheme for the release; do not
ship two unqualified distributed state machines. Do not return to DB payload
buffering as an automatic workaround for S3 latency or failure.

## Design

### 1. External backend and batched publication

Keep local mode and add a versioned S3-backed store. Inject the existing object
provider plus narrow metadata/ownership operations. Readers dispatch from the
persisted backend/version, including historical records. Remove hardcoded
`local_file` checks in heartbeat, issues, feedback, and customer-success
inspection together. Preserve current `RUN_LOG_S3_*` mirror configuration for
legacy mode, without redirecting unrelated product file storage.

Reuse the existing instance storage configuration without additional switches.
Cloud already provisions a bucket and bucket-scoped credentials per stack.
Preserve any configured storage prefix and place journals in `run-logs/` and
`provider-traces/`, with company/run namespaces underneath. New journals must not
use a separately configured legacy mirror bucket. Configuration
errors fail explicitly; never select local-only persistence silently. Add only
small company/run-bound stream metadata, with unique identities and constraints.
There are **no proposed run-log payload-chunk or raw-trace payload tables**.

Selected publication protocol after the local operational experiment:

1. Redact/compact log output through the existing owner and enqueue exact NDJSON
   bytes with stable source/attempt identities in a bounded buffer. A buffered
   enqueue and a durable receipt are different results.
2. Seal on byte threshold, the first dirty buffer's actual deadline, explicit
   flush, completion, or graceful handoff. Allocate sequence/byte offsets within
   the current writer generation; do not write SQL per record. Seal channels
   separately when their trace ordering requires it.
3. Upload a new immutable segment with digest, length, source range, and logical
   byte range. Then upload the bounded immutable index/manifest update. Keep
   manifest pages bounded; do not rewrite a growing full-history JSON document
   every few seconds. Retain exact logical bytes even when compressing storage.
4. Publish one bounded head with S3 ETag `If-Match` (or `If-None-Match` for
   creation). The head carries owner generation, committed cursor, and at most
   53 immutable index roots. Check the admitted database execution authority
   before claiming a new generation. No per-batch SQL or new stream table is
   needed. Conditional head publication fences stale generations and tombstones.
5. Release durable receipts for the published contiguous range. Reconcile a
   lost object response from the exact head before retrying. Same-source replay
   must not duplicate bytes; conflicting replay fails explicitly.

Upload/index retries reuse immutable identities and verify ambiguous results.
Do not hold a DB transaction or connection during network upload. New immutable
index nodes combine completed binary subtrees; all normally published nodes
remain referenced, avoiding an obsolete index object for every flush. Metadata must
not grow with the number or size of individual text records: segment descriptors
and source indexes live in S3. Keep lifecycle/audit metadata bounded.

Use a company/agent/run prefix with a generation-fenced head. A stale owner may finish an upload,
but cannot publish it after takeover. A successor adopts the last published
manifest and replays its uncommitted tail. Per-stream prefix tracking plus scoped,
paginated enumeration must recover unpublished-object cleanup after a crash;
never expose bucket-wide listing through public APIs. Do not garbage-collect a
pending publication merely because one DB query did not find its result.

AWS supports conditional object creation and ETag-based updates, but the current
storage interface does not expose them and compatible vendors need verification.
If eliminating per-segment SQL becomes necessary, qualify conditional writes,
ownership fencing, and manifest recovery explicitly before selecting that design.
[Conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).

### 2. Live viewing, durability, and the pending tail

Live output need not wait for an S3 PUT to appear in the browser. Preserve its
stable source identity so reconnect/reload can reconcile it with durable history.
An open viewer can see the pending tail; a different server can read the published
S3 prefix. Do not promise zero-lag cross-server tail reads until a replay/relay
path proves them. The flush threshold bounds normal durable-read lag, not a
promise that storage is always available.

The hard problem is **who retains output until publication**, not which database
column it uses. A timer uploading from disposable web memory alone cannot
preserve the pending tail after a crash. Distinguish these boundaries:

- Store durable receipt: only after the segment/index and metadata publication.
- Runner control-protocol ACK: currently may allow streaming output to leave
  replay retention before log projection. Inspect and qualify this exact path.
- Live browser delivery: presentation, not permission to discard the source.

Selected after inspecting the real ACK path: reuse the native control port's
already-durable canonical event rows. The S3 head advances their export cursor
atomically with the log bytes. Takeover reads later native rows in bounded
16-row pages, verifies source identity and hash, then uses the same formatter,
redaction and compaction as live recording. The ordinary contiguous stream adds
no SQL. Startup, missing callback ranges, and interrupted settled archives use
bounded recovery reads; settled repair waits for the old native lease to expire.
This avoids a second payload copy, new per-record DB writes, and a new Runner
retention protocol. Other stdout and raw trace bytes are not inferred from this
source. A retained native control row remains readable after Runner cleanup.
The existing Runner outbox retains unacknowledged records. No second spool,
broker, always-on logging service, or full transcript checkpoint is added.

An alternative is holding the existing transport ACK until a batch is published,
but use it only if a real protocol experiment proves bounded pipelining and
prompt Stop/control handling. Serial awaited callbacks plus a five-second timer
can become a five-second wait per record; that is unacceptable. Do not rebuild
full transcript checkpoints in Postgres to sidestep this issue.

For server-only diagnostics with no surviving source, successful durable receipts
still require S3 publication. Local enqueue alone is never advertised as durable.
Missing uncommitted optional diagnostics are explicitly incomplete. Preserve the
original strict guarantee for every acknowledged durable record; any proposal
to accept a bounded crash-loss window for ordinary output is a separate product
decision, not an automatic relaxation in this revision. Host-local agent-process
survival remains outside the web-server replacement guarantee.

On S3 failure, retain bounded pending work at the source, back off, and surface
capture/persistence state without falsely completing the log. At capacity,
backpressure or stop new admission according to the existing execution owner;
do not allocate unbounded memory/disk or switch payloads into Postgres. Optional
trace overflow can become incomplete/truncated. Preserve essential control,
Stop, task results, and usage settlement. Runner cleanup cannot destroy a pending
required-output obligation; either finish export or leave a durable cleanup hold.

### 3. Reading and storage amplification

Read the published pointer, then bounded manifest/index pages and the segments
covering the requested byte range. Cache immutable contents by digest. Preserve
byte offsets, NDJSON/UTF-8 alignment, EOF, cancellation, and bounded memory.
Compressed segments need logical offset metadata and bounded decompression;
HTTP ranges over compressed bytes are not logical log offsets. Preserve exact
full-stream digest semantics when finalizing.

The first release can serve a finalized log by streaming its segments. Do not
require a full re-upload or database compaction pass at every completion. Add
optional segment coalescing only if measured read/request savings justify its
extra I/O, publication/cleanup complexity, and temporary storage. Retention and
read-path limits must account for small-object growth and indexes. Avoid one
object per token/frame and repeated whole-log mirroring.

S3 publication is not atomic with Postgres; object upload precedes pointer
publication. An orphan object is recoverable cleanup, not proof of an accepted
append. A missing/corrupt published object is a storage integrity error, not an
empty log. Verify the actual provider's PUT/GET/range/checksum behavior rather
than assuming AWS guarantees for every compatible backend.
[S3 consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel).

### 4. Provider trace boundaries

Use the same batched object-payload mechanism with trace-specific ownership.
Keep capture opt-in, existing secret/identity suppression, admin access,
company/task-read checks, no-store responses, reveal/download audit, and trusted
workspace-diff reprojection. Raw bytes never enter ordinary events, live logs,
activity payloads, or general attachments. Provider parsing remains in drivers.

Preserve native and rehydration channels, frame IDs, source/debug sequences,
interpretation links, and raw digests. Capture transport must retain pending
records outside disposable web storage until a storage receipt. Reconstruct
frame lookup on takeover. A complete trace requires all required channel ranges
and terminal records durably published and the integrity assessment passing.
Capture failure yields incomplete/truncated without restarting the provider or
blocking task/accounting settlement. Qualify all currently supported producer
families; do not silently advertise a legacy path-only producer as durable.

Encrypt raw trace objects with the existing stable-key facilities and bind them
to company/trace/channel/segment identity. Keep only metadata and the appropriate
key reference in Postgres. Preserve the existing 24-hour expiry from original
capture and 64 MiB capture limit, with separate bounds for encoded/index overhead.
Restart/import never extends expiry. Historical imports preserve exact bytes,
including native-then-rehydration download ordering and digest.

Expiry/deletion first creates a durable tombstone and fences publication, then
cleans segments, index pages, abandoned uploads, and caches. Retain unresolved
cleanup obligations through restart and concurrent uploads; no resurrection.
Preserve `{ok:true}` only after required payload cleanup. Verify object-version
behavior for the actual bucket, and document historical backup retention
separately. Restore must honor expiry/deletion receipts before exposing traces.
Audit contains content-free metadata only.

### 5. Idle behavior and recovery

A nonempty buffer schedules one actual flush deadline; successful settlement
cancels it. Use the existing coordinator/scheduler for server-owned work and the
Runner lifecycle for producer-owned work. Retries exist only for unresolved
uploads/publications/deletes. Coalesce work and bound global as well as per-run
upload concurrency; prevent many runs flushing at once from starving HTTP or
connection pools. Do not create per-agent storage clients or idle keepalives.

Start/resume/takeover reconciles active stream metadata, source retention, and
unfinished cleanup. Existing DB work signals are process-local; do not rely on
them to wake another server. Until the parent's cross-instance wake mechanism
exists, retain explicit owner/recovery/sleep obligations. Completed history alone
creates no recurring scan. Trace expiry uses its real deadline and the existing
supported wake/blocker contract.

## Delivery slices

| Slice | Useful result and owned surfaces | Evidence/dependency |
| --- | --- | --- |
| 1. Operational and durability prototype | Workload measurement, S3 segments, publication/cost model, actual Runner pending-tail/ACK experiment | Select batching and one publication scheme; demonstrate acceptable cost and control responsiveness before schema commitment |
| 2. S3-backed run logs | Store/readers, bounded buffering/indexes, small metadata schema, replay/ownership, cleanup and local compatibility | Slice 1; two-process replacement, ambiguous PUT/commit, stale-writer and backlog tests |
| 3. S3-backed provider traces | Producer sinks/rehydration, trace store/routes, expiry/deletion | Slice 2 primitives; actual capture integrity, access and cleanup races |
| 4. History migration and qualification | Resumable importer, compatibility/authority switch, documentation and staging evidence | All retained inventory accounted for; empty-disk reads and supported rollback after new writes |

These are reviewable boundaries, not a fixed PR count. Keep each usable with the
existing instance storage profile. Raw trace capture remains opt-in. Keep storage
logic in its owners, not large heartbeat/executor additions.
Generate necessary additive metadata migrations with `pnpm db:generate` and
follow snapshot-retention rules. There is no DB payload migration or compactor.

Update `doc/run-log-events.md`, `doc/DATABASE.md`, `doc/DEVELOPING.md`, and
`doc/testing-native-remote-continuity.md` with actual guarantees and operating
limits. Update affected run/inspection feature/access map entries and run
`node scripts/check-maps.mjs`. Change shared types/UI only when their contract
changes; keep incidental storage mechanics out of normal product controls.

## Migration and rollback

1. Ship a compatibility release that reads both stores, understands new formats,
   and enforces the persisted minimum reader/writer capability on external runs.
   Keep the volume and legacy writing enabled initially. Record this release as
   the rollback floor before switching any authority; an environment flag alone
   cannot stop an old binary from mishandling new rows. The deployment/rollback
   preflight must reject binaries older than that floor: a pre-feature binary
   cannot be expected to understand a newly introduced DB guard.
2. Inventory every retained run log and unexpired trace by company/run. Classify
   local complete files, remote mirrors, active files, missing payloads, conflicting
   copies, and expired/deleted traces. A mirror may be a partial prefix: verify
   against authoritative bytes/metadata, never assume it is complete.
3. Backfill settled resources with bounded indexed keyset batches and resumable
   receipts. Preserve original bytes, offsets, digests, attempt information,
   source attribution, and trace expiry. Expired/deleted traces stay unavailable.
4. Under the parent's permitted one-time maintenance window, stop admission and
   settle/fence remaining legacy writers. Copy final active tails and both trace
   channels. Recheck hashes and byte totals after fencing; no copy-while-writing
   race can establish completion.
5. Publish each resource's backend/reference transactionally. Record a migration
   manifest of migrated, already-remote, expired/deleted, and unresolved resources.
   Missing/conflicting retained bytes block the preservation gate. Report genuine
   pre-existing loss; neither fabricate history nor quietly waive Dotta's choice.
6. Start B with the log/trace directories absent and old storage inaccessible.
   Read historical data and append new data through normal APIs. Confirm every
   in-scope inventory item has a valid disposition. Keep the old volume retained
   under the parent's recovery policy; this slice does not detach/delete it.
7. Roll back to the compatibility release against the same external data and
   prove it reads writes made after cutover. Do not switch authoritative reads
   back to stale local files. Defer destructive schema cleanup until rollback
   readers have retired.

## Acceptance matrix

| Case | Observable finish condition | Evidence |
| --- | --- | --- |
| Operational envelope | No new payload/per-token SQL; batch metadata and object traffic fit measured budgets | Real workload baseline, WAL/transactions, request/storage/transfer model and app/control latency |
| Active/completed run | B retrieves every durable receipt exactly once after A and its disk disappear | Separate processes/directories; normal authorized reader; byte/digest comparison |
| Pending tail | Web replacement retains/replays required output without duplicating provider work | Actual Runner spool/ACK experiment; kill between generation, upload and publication |
| Existing history | All retained inventory preserved under original retention | Full checksums, resumable manifest; missing/conflicting data blocks cutover |
| Ambiguous PUT/commit | Retry reconciles publication and never duplicates bytes | Fault after object PUT or DB commit but before response |
| Ownership | Stale A cannot publish/finalize after B takes over | Concurrent server and manifest-generation tests |
| Reads | Stable offsets/digests across segments, compression, caches and replacement | UTF-8/boundary/EOF/cancellation; bounded memory and GET counts |
| Storage failure | No unbounded queues or SQL-payload fallback; Stop/API remain usable | Slow/failed S3, queue capacity, recovery and source cleanup hold |
| Traces | Accepted frames survive; completeness and privacy remain truthful | All producer families, channel hashes, disabled capture and denied actors |
| Downstream consumers | Issue previews, feedback, inspection and reprojection keep working | Normal routes and current authorization checks |
| Expiry/delete | Deny after tombstone; clean payloads; no late-upload resurrection | Capture/upload/delete races, restart, actual bucket version behavior |
| Rollback/local mode | Compatible release reads post-cutover writes; local defaults unchanged | Adjacent-version and local-store tests |
| Idle | No recurring SQL/network work after settlement; real work wakes owners | Configured idle, completed history, retry/drain/resume observations |

## First useful experiment and qualification order

Use real Postgres, the existing S3 provider implementation against a disposable
S3-compatible target, and two actual service processes with separate temporary
directories. Produce representative output through the production recorder,
including repeated chunks, multibyte text, and tool bursts. Measure the candidate
batch settings and baseline API traffic. Test both published data and the pending
tail: kill A at each boundary and read/replay through B. Never pre-populate the
storage result being tested. Record revision, configuration, receipts, timing,
SQL/WAL and object-operation evidence.

Use the existing remote-continuity harness with a deterministic provider and
actual Runner to qualify retention independently of control ACKs and responsive
Stop. The decisive question is whether durable batching can coexist with ongoing
provider execution and web replacement. Do not commit to a protocol mechanism
based on a mocked callback or a successful single PUT.

Before staging, record the chosen publication scheme, batching/concurrency
limits, backlog capacity, supported recovery behavior, and measured cost/latency
operating envelope. If those fail, revise the design before a broad schema or
migration implementation. No production sizing/cost has yet been measured.

Then verify the actual staging bucket and remote capture path with a bounded
live provider run, normal UI/inspection/download, and post-replacement reads.
Make the old web filesystem inaccessible. Preserve prior failures alongside
successful retries. Full Railway HTTP handoff and volume removal remain parent
plan gates.

Run narrow storage/output/trace/continuity/auth/migration checks while iterating.
At implementation PR handoff run `pnpm -r typecheck`, `pnpm test:run`, and
`pnpm build`, plus affected Runner checks and user-journey verification. Do not
claim live-provider or fleet evidence from deterministic fixtures.

## Implementation state and remaining gates

- Configuration follow-up: shared storage resolution now serves product files,
  run logs and traces. S3 instances need no extra switches or connection fields.
  Cloud's existing per-stack bucket and credentials remain the isolation
  boundary; existing prefixes and company/run subfolders are preserved. The
  configuration regression failed before the change, then 70 affected tests
  passed, including real S3-compatible bucket/prefix isolation and cleanup tests.
  Four existing Cloud environment-contract tests also passed without Cloud code
  or deployment changes.
- User follow-up: remove the added run/adapters map sections. Retained-history
  conversion now belongs to an automatic, bounded delivery worker; the command
  is optional diagnosis/repair. Existing local references remain durable work.
  Startup reconstructs it, active or blocked history retries with backoff, and
  completed history has no recurring SQL/network scan. Migration stays with its
  owning service; index.ts only registers its lifecycle, and the shared delivery
  registry adds the queue name. The source volume must survive until all retained
  history is verified. Mixed versions must stop creating new local-file runs.
- Trace encryption reuses either existing vault key source, including the
  configured key file, and never creates a replacement key for external traces.
  Both strict missing-key and file-key round-trip regressions failed before the fix.
  The configuration/storage regression run passed 91 tests. Automatic migration
  and retention passed 10 tests, including a real Postgres/S3 upgrade followed by
  source-directory deletion. Harness failures remain in the local evidence: a
  cold import exceeded a test deadline (moved module setup into the fixture), a
  sandbox denied localhost access (rerun with network permission), and the first
  automatic fixture bucket name exceeded S3's length limit (shortened the name).
- Shutdown review: automatic trace import now propagates cancellation through
  source reads, opening, conditional-write qualification, upload and verification.
  Five real-SDK stalled-request regressions failed before the fix, then passed.
  A shared capability probe survives one cancelled claimant and aborts when its
  last claimant leaves. Source and remote trace hashing stream bounded chunks.
  A multi-chunk native sidecar without a final newline retains exact download
  ordering and digest. Existing file-key and empty-web-home app checks passed at
  a142424fc9; subsequent changes affect copy cancellation and verification only.
- Base integration: 879ba0d1fd reached Greptile 5/5 and all CI checks passed,
  then master advanced and produced two append-only documentation conflicts.
  Preserve both documentation sections and integrate the new Cloud snapshot
  startup contract. The startup regression reproduced a redundant config read;
  worker registration now accepts only the already-loaded storage-provider value.
  All 103 startup controls plus storage/lifecycle controls passed (112 tests),
  including saved Cloud profile reuse after the legacy config file is absent.
  A further combined run passed all 124 storage and real-Postgres Cloud runtime
  configuration controls on the merged source.
- Further review: trace retention now registers independently of heartbeat
  scheduling, and optional issue-comment attribution reads the published log
  prefix after a failed best-effort native repair. Both defects reproduced red;
  all 116 selected startup, retention, attribution and cancellation controls pass.
  The 19f702d780 browser session-recovery check timed out; its job log is retained.
  No UI behavior or browser assertion was changed to suppress that failure.
- Branch: `codex/external-run-logs-traces`; this chat owns integration and PR review.
- S3 holds payloads from the first committed batch. Conditional object heads
  hold cursors and writer generations. Existing Postgres rows hold lifecycle and
  references only. No schema change, per-record SQL, or DB payload compactor.
- Implemented: stored-backend reader dispatch, bounded batching and I/O,
  immutable binary range indexes, exact digest/range reads, ownership fencing,
  encrypted optional trace channels, durable deletion/expiry obligations, and a
  bounded resumable history importer. Local defaults remain unchanged.
- Exercised locally with real Postgres and Moto 5.2.5 through the real AWS SDK:
  encrypted trace replacement/deletion and history import with original source
  directories removed. Missing, corrupt, and active history blocks migration.
- Abrupt process qualification: a writer commits 1,000 records, receives storage
  receipts, dies by `SIGKILL`, and loses its working directory. A separate
  process reads every record exactly and continues the same journal.
- App journey: create a deterministic process agent, click Run now, open its
  run history, kill the web process, restart against the same external services,
  and reload the viewer. All 31 NDJSON records remained byte-identical through
  the normal authorized API (6,206 bytes; SHA-256
  `3e8415c79379c583b1c4c37902187593fd69ebe85db78d6486d6077f205bacba`).
- Local workload qualification reports burst and eight-stream steady request,
  transfer, stored-object, and timing counts. It is a synthetic envelope,
  not a fleet cost forecast. The first index prototype left obsolete COW
  objects; the selected immutable binary index removes that normal growth.
- Full workspace typecheck and build passed after native replay and the storage
  review fixes. The pushed server revision was rebuilt for the final app check.
  The native Postgres package initially lacked its postinstall-created library
  symlinks; its standard hydration helper repaired that local test prerequisite.
- Native pending-tail qualification passed with the real Rust recovery fixture,
  `PaperclipControlPlanePort`, production recorder, real Postgres and Moto. A
  received ACK released 32 records from the Runner while S3's source cursor was
  still zero. After `SIGKILL` and deletion of the old controller directory, B
  exported all 64 records once while the same Runner PID continued. Snapshot and
  Stop commands completed in 453 ms and 122 ms. The first attempt failed because
  its new controller directory had mode 0755; the fixture now creates mode 0700.
  Both failed and successful evidence remain in this chat's temporary artifacts.
  This is a deterministic protocol experiment, not a live model or Railway test.
- Final app verification used a new web home on `c2cedcd116`. Retained history
  remained byte-identical (31 records, 6,206 bytes), and a new UI-triggered process
  run succeeded with every generated record present in its S3-backed transcript.
  The browser initially reached the listener before startup completed; after
  readiness, the normal page and API checks passed.
- Durable log receipts and live log messages follow S3 publication. The native
  export reuses existing control rows, adds no payload writes, and repairs missing
  callback ranges. Interrupted settled archives can be repaired on normal reads
  after the old native lease expires. Optional raw capture and server-only
  diagnostics without a surviving source can remain incomplete after a crash.
- Review fixes cover absent-head deletion fencing, shared capture ownership,
  abort/drain on deletion, local expiry deadlines and multi-page cleanup, bounded
  transient retries and admission backpressure, partial-startup cleanup, and
  explicit trace-import cleanup markers. A source integrity failure leaves the
  native archive's final size unknown instead of certifying a partial result.
- Full local Vitest could not run on host embedded Postgres because concurrent
  clusters exhausted macOS SysV semaphores. Affected suites are running against
  isolated Docker databases. One local full typecheck attempt also lacked sandbox
  permission for tsx IPC; the authorized rerun uses the normal workspace command.
  The isolated Docker run then passed 1,014 affected storage/native tests and
  all 27 privacy-route tests. Subsequent targeted review regressions passed for
  native source classification, native import coverage, shared-reader repair
  cancellation, serving the published prefix on repair conflicts, and a failed
  local-file cleanup retaining its deadline. Live and recovered native output
  redact existing agent identity material; runtime log secrets are registered
  once through the existing encrypted redaction registry, without copying agent
  private keys into run contexts.
- Native history migration accepts finalized files whose recorded size and
  digest match, preserving the existing formatter's truncated large display
  chunks. Files missing either completeness field still require ordered source
  coverage. Corrupt metadata blocks publication; the conditional switch checks
  that the original completeness fields have not changed.
- PR: https://github.com/paperclipai/paperclip/pull/18327. Initial CI passed 51
  checks with one E2E teardown lock timeout. That E2E shard passed on the next
  revision; its Runner shard then failed the Antigravity authentication fixture.
  These failures are retained, and fresh-head CI remains required.
- Production remains disabled. Railway Buckets are the parent fleet's current
  S3 provider; their conditional-write, version/deletion, workload cost, remote
  capture, and sleep/wake behavior need actual-target qualification. No fleet
  environment or volume was changed.
- Next gate: finish fresh-source checks and PR review; retain actual-provider,
  live remote capture, and parent cutover gates before any volume-free rollout.
- No Paperclip issue/run context was supplied. This repository plan is the state
  record; no issue work product or production migration is claimed.
