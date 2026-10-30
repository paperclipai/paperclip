# Durable run logs and provider traces for disposable web servers

Status: revised implementation plan; operational qualification required before
implementation design is finalized. No runtime changes or deployment performed.
Owner: this Codex chat, through planning. Date: 2026-10-30.
Revision: object-storage-first, following Dotta's operational correction on 2026-10-30.
Source revision inspected: `0c70cedce9a803bdc201324528abb35e423e7cd0`.
Parent: [Explore zero-downtime Railway deploy](codex://threads/01a1836e-8c8e-7b83-b09c-5db49a5e89de).

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

Planning ends with this reviewable design, delivery boundaries, migration
procedure, and acceptance matrix. Implementation, PRs, and deployment are not
part of this planning turn.

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
Do not reconstruct logs from `heartbeat_run_events`: raw/log presentation and
structured event histories are different contracts.

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
| Remote Runner spool, where supported | Replayable pending output across web replacement until storage receipt |
| S3-compatible storage | Immutable log/trace segments and bounded manifest/index pages |
| Postgres | Company/run ownership, backend/version, writer generation, committed manifest pointer/end cursor, final status and expiry/deletion state |
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

Align opt-in with the parent's external-persistence profile. Configuration
errors fail explicitly; never select local-only persistence silently. Add only
small company/run-bound stream metadata, with unique identities and constraints.
There are **no proposed run-log payload-chunk or raw-trace payload tables**.

Recommended initial publication protocol, subject to the cost gate:

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
4. Publish the manifest pointer/end cursor in one small DB transaction that
   checks current writer generation, prior pointer/cursor, run binding, and any
   tombstone. Only that committed pointer is authoritative. Avoid updating the
   main heartbeat row per segment: use an owned small stream record.
5. Release durable receipts for the published contiguous range. Reconcile a
   lost DB response from the pointer/manifest before retrying. Same-source replay
   must not duplicate bytes; conflicting replay fails explicitly.

Upload/index retries reuse immutable identities and verify ambiguous results.
Do not hold a DB transaction or connection during network upload. Metadata must
not grow with the number or size of individual text records: segment descriptors
and source indexes live in S3. Keep lifecycle/audit metadata bounded.

Use generation-specific object prefixes. A stale owner may finish an upload,
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

Prefer a bounded remote Runner spool whose log-export retention advances only
on a storage receipt, independently of control-protocol ACKs. That keeps the
source available while the web server is replaced and allows batching without
making each token await S3. This retention/cursor capability must be implemented
and qualified; it is **not claimed to exist today**. Reuse the existing remote
log/outbox mechanisms where they meet the contract. Do not add a new broker or
always-on logging service without evidence that the existing mechanisms fail.

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

These are reviewable boundaries, not a fixed PR count. Keep each usable and
opt-in. Keep storage logic in its owners, not large heartbeat/executor additions.
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

## Current state and next action

- Revised after Dotta's operational concern: S3 holds payloads from the first
  stored batch; Postgres holds small metadata. The DB-live-tail proposal is
  superseded, including its payload tables and DB-to-S3 compaction.
- Retained requirements: preserve all retained history, durable-receipt survival,
  privacy/retention/deletion, local compatibility, bounded work, and sleep.
- Recommended initial mechanism: batched S3 segment/index uploads followed by a
  small fenced metadata publication. Its steady-state SQL cost remains an
  explicit measurement gate, not an assumed negligible cost.
- Unresolved engineering choices: measured batch/queue limits; whether metadata
  publication needs to move off the per-batch SQL path; actual Runner retention
  versus ACK batching. Resolve in slice 1 before committing the final schema.
- Implemented/exercised/deployed: none. This is a plan revision only.
- Next action: operational/durability prototype and actual-provider capability
  qualification, before broad implementation or migration.
- Plan checks: repository references and whitespace validated. Application tests,
  typecheck, and build are not claimed for this document-only change.
- No Paperclip issue/run context was supplied; this remains a repository plan in
  the current Codex worktree, not a registered Paperclip issue work product.
