# Run log and provider trace object storage

Instances configured for S3-compatible file storage automatically use the
`s3_segments` backend for new run logs and opted-in provider traces. Postgres
retains the existing run/trace references and lifecycle rows.
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

No additional storage configuration is required. The existing instance
`storage.provider` setting, or `PAPERCLIP_STORAGE_PROVIDER`, selects storage.
The same config-file S3 fields and `PAPERCLIP_STORAGE_S3_*` overrides select the
bucket, endpoint, region, prefix, and path style used by product files. Credentials
use the same AWS SDK chain. Local-disk instances keep `local_file` logs and traces.

The instance's existing S3 prefix is preserved. The folders underneath it are:

```text
<existing-prefix>/run-logs/segments-v1/<company>/<agent>/<run>/
<existing-prefix>/provider-traces/segments-v1/<company>/<run>/<trace>/<channel>/
<existing-prefix>/<company>/...    existing product files
```

Cloud's existing provisioning supplies a separate bucket and bucket-scoped
credentials for each stack, plus the stack's encryption key. The app reuses that
boundary rather than selecting a global customer bucket. Within a stack, journal
keys remain company/run scoped. Cleanup lists only the resource's own prefix;
it cannot sweep other companies, other stacks' prefixes, or product files.
Folders are organization, not a substitute for bucket permissions or API access
checks. Shared-bucket self-hosted deployments must retain their existing distinct
instance prefixes and appropriate storage credentials.

Legacy run rows retain their recorded backend until verified migration. Their
pre-existing `RUN_LOG_S3_*` mirror settings and key paths remain supported for
legacy reads and writes. They do not override instance storage for new journals.
Use stable bucket/prefix settings across replacements and releases.
As with existing product files, changing the instance bucket or prefix is a
separate storage move and requires copying the complete namespace and preserving
its keys before changing configuration. Switching to local storage does not move
existing S3 evidence. Readers reject an unavailable external store; they never
substitute an empty local log. Restore the original stack's storage profile to
read its history. This upgrade migrates legacy local evidence into the existing
stack store; it does not introduce bucket relocation or reverse migration.

Raw capture still requires its existing explicit capture request. Its encryption
uses the existing vault key, from `PAPERCLIP_SECRETS_MASTER_KEY` or the existing
configured key file. Cloud already supplies the environment key. No separate
trace key is introduced, and a missing vault key fails rather than creating a
replacement. Disposable deployments must preserve the existing vault key along
with their other secrets.
Raw payload and index objects
use AES-GCM with a key derived for the particular company/run/trace/channel.
The bounded head holds only ownership, range, digest, and publication metadata.
Existing capture opt-in, redaction, instance-admin access, task/company access,
reveal/download auditing, and the 24-hour capture expiry remain in effect.

The provider must enforce `If-None-Match: *` and ETag `If-Match`, return ETags,
and support prefix-scoped paginated listing. Claiming the first journal performs
a conditional-write capability probe. A backend which ignores preconditions is
rejected. Before deploying this release to an S3-configured production instance,
qualify the provider's conditional writes, range/read consistency, encryption,
object versions, and cleanup. AWS API compatibility alone is insufficient evidence.

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

Trace expiry and failed-deletion recovery remain registered when
`HEARTBEAT_SCHEDULER_ENABLED=false`. Disabling agent scheduling does not disable
retained-data cleanup. The worker still respects warm standby, admission drain,
actual deadlines, and shutdown.

## History migration and rollback

S3-configured servers automatically migrate retained local history in the background.
No command or extra configuration is required. The existing delivery coordinator
starts the upgrade outside request handling, independently of the heartbeat
scheduler toggle. Each batch processes at most one log and one trace, then yields
for one second. Existing references are the durable work inventory. Restarting
reconstructs unfinished work from those references; already migrated rows are
excluded. No new payload or job table is added.

Active writers, missing files, corrupt data, and storage failures leave history
unresolved. Other pages continue. The server logs each blocked resource and a
pass summary. Unresolved passes retry after five minutes, with backoff up to
30 minutes. Transport failures retry through the shared coordinator. After all
retained history is migrated, the worker stops querying and contacting storage.
Trace source hashing and remote verification stream bounded chunks instead of
loading a complete capture into server memory. The worker cancellation signal
reaches file reads, trace opening, conditional probing, uploads and verification.
Local-disk instances do not register this worker. Outstanding migration conservatively
blocks instance sleep, and shutdown aborts the batch and waits for owned work.

Deploy compatible readers and stop old binaries from starting new local runs.
The upgrade waits for existing writers to settle and their leases to expire.
Keep the source volume attached until migration completes and clean-filesystem
reads pass. Automatic copying cannot recover a file after its only copy is lost.

`server/scripts/migrate-run-evidence.ts` remains an optional diagnostic and repair
tool. Its default is a read-only inventory; `--apply` runs the same verified
importer used by the automatic worker. `--company`, `--after-run`, `--after-trace`
and `--limit` allow scoped investigation against an explicitly selected
`DATABASE_URL`. Normal upgrades do not require this tool. It does not stop agents,
select a production target, delete source files, or certify volume removal.

For logs, migration verifies exact local bytes or a mirror with proven length
and digest, compares any previously uploaded prefix, verifies remote SHA-256,
then conditionally changes the run's backend/reference. Unknown-completeness
mirrors, missing/corrupt payloads, and active writers block publication. Existing
trace bytes, download ordering, integrity state and original expiry are retained.
Neither path fabricates missing historical data or extends trace retention.
For finalized native logs, matching the recorded size and SHA-256 proves the
complete legacy file, including display chunks truncated by the existing 64 KiB
formatter. Migration preserves those exact bytes and records the settled source
cursor. If either completeness field is absent, a bounded NDJSON scan must prove
ordered coverage of the existing canonical source records. Missing ranges or
chunks whose identities cannot be verified block publication as
`native_log_source_coverage_unproven`. A database's latest event cursor alone
does not establish completeness. Publication checks that the original reference,
completeness metadata, and source cursor have not changed. Keep the original
volume and resolve blocked inventory before cutover.
An interrupted trace import keeps an `s3-import-v1:` reference: reads still use
the original local sidecars, while deletion and expiry retain responsibility for
the staged object prefix. The automatic worker resumes the verified switch after restart or retry.
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
