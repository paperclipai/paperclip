# Run log and provider trace object storage

The optional `s3_segments` backend stores payloads directly in S3-compatible
storage. Postgres retains the existing run/trace references and lifecycle rows.
It adds no payload table, per-record SQL, or database-to-object compactor.
Structured `heartbeat_run_events` retain their existing database path. Native
events already committed there before a Runner ACK also provide the recovery
source for an interrupted canonical native log export. No additional event copy
or payload write is introduced.
When native object logging uses runtime observability credentials, their log
redaction values are registered once in the existing encrypted run-secret
registry. This is bounded redaction metadata, not a transcript copy or a
per-event write. Agent identity private material stays in its existing key store.

## Configuration

Keep the default `local_file` backend for existing local/self-hosted installs.
To select object storage for new run logs, set:

```sh
RUN_LOG_STORE=s3_segments
RUN_LOG_S3_BUCKET=<bucket>
RUN_LOG_S3_REGION=<region>
RUN_LOG_S3_ENDPOINT=<S3-compatible-endpoint>
RUN_LOG_S3_PREFIX=run-logs
RUN_LOG_S3_FLUSH_MS=1000
```

The existing AWS credential chain and `RUN_LOG_S3_FORCE_PATH_STYLE` apply.
`RUN_LOG_S3_ENDPOINT` is optional for AWS. Use a stable bucket/prefix across
releases. An invalid selection or a missing required bucket fails explicitly.
Legacy run rows continue using their recorded backend until migrated.

Optional raw provider capture uses the same object provider and credentials:

```sh
PROVIDER_TRACE_STORE=s3_segments
PROVIDER_TRACE_S3_PREFIX=provider-traces
PAPERCLIP_SECRETS_MASTER_KEY=<stable-instance-key>
```

The trace key must be stable and supplied in the environment; this backend does
not create an encryption key on disposable disk. Raw payload and index objects
use AES-GCM with a key derived for the particular company/run/trace/channel.
The bounded head holds only ownership, range, digest, and publication metadata.
Existing capture opt-in, redaction, instance-admin access, task/company access,
reveal/download auditing, and the 24-hour capture expiry remain in effect.

The provider must enforce `If-None-Match: *` and ETag `If-Match`, return ETags,
and support prefix-scoped paginated listing. Claiming the first journal performs
a conditional-write capability probe. A backend which ignores preconditions is
rejected. Do not enable this mode on a production provider until its conditional
writes, range/read consistency, encryption, object versions, and cleanup have
been qualified. AWS API compatibility alone is insufficient evidence.

## Publication and operating limits

Each batch uploads immutable payload segments and merges equal-height index
roots into immutable binary nodes, then conditionally publishes one head object.
The head carries at most 53 ordered roots. Every normally published payload and
index node remains reachable; appends do not leave superseded index copies.
Interrupted or fenced uploads can leave unpublished objects, which remain inside
the resource prefix for scoped deletion. The head is the commit
boundary. A stale writer can upload an orphan but cannot replace the current
owner's published history. An uncertain response is reconciled against the exact
head before returning a durability receipt. Committed reads use immutable roots,
so publication cannot change the bytes behind an already selected snapshot.

An individual store `append` resolves only after publication. Heartbeat's
`onLog` diagnostic callback waits for bounded admission without serially
waiting for each network batch. At capacity it waits for space; admission beyond
the bounded waiting allowance is rejected without poisoning accepted batches.
Transient network, 409, 429 and server errors receive bounded retries. A 412
or a changed head fences the stale writer; a 409 alone does not prove ownership
loss or conditional-write support. Live log messages and progress are published
after storage confirmation. Finalization drains admitted writes before closing
and hashing the stream. Logging failure reports incomplete persistence and
leaves the final size/digest unknown rather than claiming a complete snapshot.
The original progress projection remains coarsely throttled; concurrent batch
completions share a single progress write.

Defaults and fixed safeguards:

| Limit | Value |
| --- | --- |
| Dirty batch deadline | 1 second, configurable from 1 ms to 30 seconds |
| Segment target | 1 MiB |
| Pending bytes per writer | 8 MiB |
| Pending run-log bytes per process | 64 MiB |
| Additional waiting admission | 8 MiB / 32 calls per process |
| Concurrent run-log flushes | 4 |
| Concurrent journal object operations | 8, with 32 queued operations |
| Object operation/batch cancellation deadline | 15 seconds |
| Current index fanout / maximum roots | 2 children / 53 roots |
| Journal head read bound | 64 KiB |
| Trace encoded payload bound per sidecar | 192 MiB, in addition to the existing raw capture limit |

A configured but empty log store sends no periodic request. Dirty buffers,
capture file-change events, and actual retention/retry obligations drive work.
Use request/transfer counts, byte volume, steady versus bursty producers,
concurrent runs, and control/API latency to size a deployment. The local S3
qualification is a synthetic workload, not a production cost forecast.

Finalization streams the committed bytes once to compute the existing complete
file SHA-256. It does not re-upload the entire log. Range indexes avoid loading
all segment descriptors to read a tail. Historical consumers, UTF-8/NDJSON record
alignment, issue previews, feedback, and customer-success inspection dispatch
through the persisted backend. Logical reads retain the existing authorization.
On-demand native repair closes its verified committed range with an exact byte
count and leaves an unavailable full-file SHA-256 null. It does not make a log
page request re-download the entire archive to compute that optional digest.

## Durability boundary

Committed log receipts and captured object prefixes survive web disk loss.
Output still buffered only by the current web process has no durable receipt.
The live log path waits for publication before showing that output. Raw sidecar
capture remains optional; a crash can leave an incomplete uncommitted tail, and
only durably closed channels plus valid terminal markers qualify as complete.

Native PRP events have a surviving source: the control port already commits
validated, redacted events before acknowledging them. The S3 head checkpoints
the highest exported database event cursor with the batch's bytes. A replacement
replays later native source rows in bounded 16-row pages, checks their identity
and canonical hash, and exports the same `paperclip.prp.event` representation
through normal log redaction/compaction. Late callbacks and duplicate delivery
cannot append the same source record again. This is a canonical native export;
generic stdout, stderr, and raw provider traces are not reconstructed from event
rows. The control ACK and sparse checkpoint formats remain unchanged.

Recovery runs before native execution reconnects. If the run settled before its
archive finished, the normal log API, issue preview, or feedback reader can repair
it after the native controller lease expires. Concurrent requests share recovery;
final metadata is saved only when no later native source remains. Read-only
customer-success inspection reads the currently published prefix. A failed
repair leaves final size/digest unknown and preserves the existing source.
Retained native events are not deleted by Runner cleanup. Recovery adds bounded
reads and one final metadata update, with no new per-record SQL on the normal
contiguous output path. Raw optional capture can still be incomplete after a crash.
Credential-update, retained-cleanup, and trace-reprojection records have separate
source namespaces and do not enter this log export. Corrupt canonical records
fail integrity validation. Shared on-demand repair has a 30-second lifetime;
cancellation removes a waiting reader and aborts storage work when no readers
remain. It preserves already published cursors so a later request can resume.
Live export and recovery both redact the existing agent identity and known run
secrets before publication. Recovery reads existing identity material without
provisioning a key. If best-effort repair loses ownership or fails, ordinary log
reads serve the published prefix and leave completion metadata unknown; request
cancellation still propagates.

The [remote continuity](testing-native-remote-continuity.md) protocol and the
parent deployment's other filesystem and HTTP handoff requirements still apply.

## Trace deletion, expiry, and sleep

Deletion/expiry denies reads through a database tombstone before payload cleanup.
Object journal tombstones prevent further publication. If an active writer may
have an in-flight upload, cleanup waits at least 30 seconds and remains a durable
retry obligation. A successful manual DELETE requires payload cleanup; an
unsettled cleanup returns a retryable failure, and the shared retention worker
retries it. Tombstones remain after object removal. Historical backups and
object-version retention need a separate operator policy; an ordinary DELETE
must not be mistaken for erasure of historical versions.

The shared coordinator restores expiry/cleanup work on startup and registers
actual deadlines for local and external captures. New local inserts also wake it;
expired backlogs drain in bounded pages. No completed-history polling is added. Trace expiry
is not yet part of Cloud's durable wake contract, so outstanding trace deadlines
conservatively block instance sleep. Removing that blocker requires qualification
of the corresponding external wake, not a longer polling interval.

## History migration and rollback

Deploy compatible readers before switching any authority. Drain legacy writers
for the final cutover; do not detach the volume while any retained resource is
unresolved. The importer uses indexed UUID keyset pages, accepts up to 100 rows
of each resource per invocation, and prints a resumable inventory:

```sh
node --import ./server/node_modules/tsx/dist/loader.mjs server/scripts/migrate-run-evidence.ts
node --import ./server/node_modules/tsx/dist/loader.mjs server/scripts/migrate-run-evidence.ts --apply --limit 50
```

Set `DATABASE_URL` and the storage environment explicitly for the intended
instance. Use `--company`, `--after-run`, and `--after-trace` for scoped pages.
The default is inventory-only. The command does not stop agents or select a
production target. Save every page's JSON, including blocked items; do not treat
a nonempty next cursor or a page with blocked resources as completed migration.
Retry blocked items after resolving their cause, starting from the relevant
cursor or the beginning. Already migrated resources are excluded.

For logs, migration verifies exact local bytes or a mirror with proven length
and digest, compares any previously uploaded prefix, verifies remote SHA-256,
then conditionally changes the run's backend/reference. Unknown-completeness
mirrors, missing/corrupt payloads, and active writers block publication. Existing
trace bytes, download ordering, integrity state and original expiry are retained.
Neither path fabricates missing historical data or extends trace retention.
For native logs, a bounded NDJSON scan must also prove ordered coverage of the
existing canonical source records. Missing ranges or canonical chunks whose
identities cannot be verified block publication as
`native_log_source_coverage_unproven`. A database's latest event cursor alone
does not establish that its output reached the local file. Keep the original
volume and resolve blocked inventory before cutover.
An interrupted trace import keeps an `s3-import-v1:` reference: reads still use
the original local sidecars, while deletion and expiry retain responsibility for
the staged object prefix. Resume the importer to finish its verified switch.
Ordinary local traces have no S3 cleanup dependency.

Keep the volume until every retained item has been verified from a clean web
filesystem. Rollback must use a compatible reader against the same remote state.
An older binary or stale local volume is not a valid rollback target after new
external writes. Enforce that floor in the owning deployment procedure.

## Qualification

Run the storage, recorder, migration, privacy and retention tests. The opt-in
S3/Postgres integration fixtures use `PAPERCLIP_LOG_TEST_S3_ENDPOINT` and a dedicated
`PAPERCLIP_RUN_EVIDENCE_MIGRATION_DATABASE_URL` ending in `_test`. They create
unique test buckets and schemas, and remove only those resources. The privacy
route suite also accepts `PAPERCLIP_RUN_LOG_PRIVACY_TEST_DATABASE_URL` for a
dedicated, fully migrated database ending in `_test`; it clears its fixtures.

`server/scripts/qualify-object-run-logs.ts` exercises the actual AWS SDK against
a loopback test backend, confirms exact replacement reads and stale-writer
rejection, and reports requests/bytes/timing. It uses synthetic credentials and
refuses a non-loopback target. This proves its tested transport and workload;
production-provider qualification and actual Railway deployment remain separate.

`server/scripts/qualify-native-log-recovery.ts` uses the real Rust
`recovery-fixture` example, real Postgres, the control port, production recorder,
and S3 backend. It kills the controller after Runner ACKs but before the S3
cursor catches up, deletes that controller's directory, and restores sparse
control state into a fresh controller. It checks exact source order, no duplicate
records, the same surviving Runner PID, and control/Stop responsiveness. Build
the example with `cargo build --locked --manifest-path packages/paperclip-runner/runner/Cargo.toml -p paperclip-runner-core --example recovery-fixture`.
It accepts the same two explicit loopback test endpoints and creates a private
schema and bucket. This deterministic protocol experiment does not qualify a
live provider, remote execution environment, or production S3 vendor.
