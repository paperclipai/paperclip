# Native-controller recovery during webserver upgrades

Date: 2026-10-30. Status: implementation delivered; final qualification is tracked
in [PR #18343](https://github.com/paperclipai/paperclip/pull/18343).
Source inspected: `0c70cedce9a803bdc201324528abb35e423e7cd0` in the current task worktree.

## Goal and finish line

Make native controller state independent of the main Paperclip webserver's disk,
as one prerequisite for zero-downtime webserver deployments. A person starts a
task, the webserver is replaced, and the same remote execution continues. After
completion, another replacement can continue the retained session without the
previous webserver's files. Recovery must preserve Stop, current authorization,
accepted results, pending tool decisions, and single-owner execution.

The implementation endpoint is a tested, reviewable PR for the native-controller
portion only. General HTTP readiness, traffic switching, request draining,
browser delivery, storage migration and Railway rollout belong to other chats.
Native shutdown integrates with the existing server lifecycle coordinator.

Initial supported environment: native remote Runner execution, external Postgres,
a stable externally supplied instance encryption key, surviving remote sandbox
storage, and mutually compatible server/Runner releases. Qualify the existing
Daytona path, including its prepared-task transport. Preserve local/self-hosted
behavior. No new database, queue service, or shared filesystem is needed.

Keep the existing outage contract: a 300-second controller outage, with recovery
completed within the Runner's existing 420-second reconnect grace. The remote
controller lease is currently 60 seconds. The 300-second fault-tolerance test is
not the permitted downtime of the webserver deployment. Do not shorten it or renew the Runner's
disconnected lifetime on each retry to make a test pass. This contract permits
server-dependent tools to wait; it does not promise uninterrupted HTTP service.

## What already exists

The earlier [Explore zero-downtime Railway deploy](codex://threads/01a1836e-8c8e-7b83-b09c-5db49a5e89de)
plan included remotely persisted native controller checkpoints. Much of that work
has since landed. Build on it instead of introducing another checkpoint store.

| Existing capability | Owner / evidence inspected |
| --- | --- |
| Encrypted, company/task/run-bound PRP checkpoints in Postgres | [`native-runner-checkpoint.ts`](../../server/src/services/native-runtime/native-runner-checkpoint.ts), [`native_runner_checkpoints`](../../packages/db/src/schema/native_runner_checkpoints.ts); landed in `09ad9adce2` / PR #17439 |
| Opaque checkpoint codec, restore, authenticated replay cursor and persistence-before-effect barriers | [`durable-prp-control-plane.ts`](../../packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts) |
| Expiring ownership, controller generations, stale-writer fencing and isolated renewal/checkpoint pools | [`native-restart-recovery.ts`](../../server/src/services/native-runtime/native-restart-recovery.ts), [`native-execution-lease.ts`](../../server/src/services/native-runtime/native-execution-lease.ts) |
| Active remote reattachment from DB state and the admitted Runner artifact | [`native-session-executor.ts`](../../server/src/services/native-runtime/native-session-executor.ts), `executePaperclipNativeSessionWithinScope` |
| Bounded database discovery of prior task/session checkpoints | [`native-session-resume.ts`](../../server/src/services/native-runtime/native-session-resume.ts) |
| Empty-controller-directory, receipt-recovery, concurrency, retention and SQL-cost tests | [`native-runner-restart-recovery.integration.test.ts`](../../server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts), [continuity runbook](../testing-native-remote-continuity.md) |
| Read-only active-run upgrade eligibility | [`heartbeat/upgrade-readiness.ts`](../../server/src/services/heartbeat/upgrade-readiness.ts); landed in `567c043b17` / PR #18037 |

The related [Enable uninterrupted agent upgrades](codex://threads/01a15e84-545f-7023-a854-9a642cbc76e1)
chat reports actual PAP staging replacements preserving active executions. It is
also working on broader default enablement. Those are reported results from that
chat, not a new qualification of this checkout or proof that the entire webserver
filesystem can be discarded. Reconcile that work before implementing overlapping
changes; do not duplicate its rollout or configuration work.

## Remaining dependencies and evidence gaps

1. **Ordinary continuation still discovers PRP state through local identity.**
   `restoreWarmRunnerdController` and `restorePerTurnRunnerdController` first read
   the local full state or external marker. They return when neither supplies a
   matching identity. Active restart recovery instead starts from a DB run
   binding. Extend that approach to ordinary continuation without skipping the
   existing prior-owner, session, configuration, and suspended-state checks.
2. **Warm supervisor state has its own local persistence path.**
   `persistWarmNativeCheckpoint` writes `paperclip.native-session-supervisor.v1`
   with the snapshot, configuration digest, and process-configuration digest;
   `loadWarmNativeCheckpoint` and warm process reuse read that file. The separate
   Postgres PRP restore writes only `control-plane-state.json`. Existing saved
   `runnerProfileJson.sessionCheckpoint` and admitted execution input provide
   reusable data, but the complete warm reuse decision must become reconstructible.
3. **Current focused tests do not establish the whole application contract.**
   The empty-directory transport fixture restores explicitly and sets the old
   lease expired. It is valuable protocol evidence, but does not prove normal
   admission with no markers, natural ownership expiry, HTTP routing during
   overlap, or a second fresh-server continuation. Existing supervisor/Product
   E2E coverage may prove some of these; reconcile it before adding new cells.
4. **Upgrade eligibility is narrower than disk independence.**
   The current report checks active runs and bounded PRP headers. It does not
   certify completed retained sessions or dereference workspace recovery files.
   An empty active-run list must not imply that all controller history is safe
   to discard.

These are inspected dependencies and missing proof, not newly reproduced
production failures. Begin with characterization tests to determine which paths
already reconstruct sufficient state through their callers.

## Design

### One durable source for each kind of state

| State | Durable owner | Local treatment |
| --- | --- | --- |
| PRP authentication, command receipts, control events and replay state | Existing encrypted `native_runner_checkpoints` | Reconstructed cache/marker |
| Run authority and finalization | Existing `native_run_finalizations`, run and issue locks | No local substitute |
| Provider/session snapshot and native reuse compatibility | Existing run profile plus a versioned native recovery envelope where fields are missing | Reconstructed supervisor projection |
| Session lookup | Existing task-session pointer and bounded prior-run selection | Never depends on directory enumeration or a marker |
| Provider process, provider history and unacknowledged outbox | Surviving remote Runner/sandbox | Never copied from an older controller cache over live state |
| Workspace descriptors, manifests, archives and provider backup blobs | Their existing workspace/backup owners, with remote durability supplied by that workstream | Logical references; independent eligibility requirement |

Keep Runner's codec and opaque record contract in the Runner package. Native
runtime owns session selection, compatibility, and the server-side recovery
envelope. The database adapter owns encryption and transactional fencing.
Heartbeat only coordinates these contracts. Extract the affected persistence and
lookup responsibility from the large executor into a cohesive native-runtime
module rather than expanding the executor or creating a generic recovery system.

### Reconstruct from durable identity

Use the exact active run for restart adoption. For a subsequent turn, use the
existing task/session pointer and `native-session-resume.ts` selection policy to
locate the eligible prior run. Validate company, task, agent, normalized session,
workspace scope, admitted execution, provider configuration and current authority.
Retain the existing progress barriers: a newer incompatible or incomplete record
must not make recovery select an older convenient checkpoint.

Load and validate the PRP checkpoint and native snapshot before materializing
local projections. The destination is computed from the replacement's local
root; absolute paths recorded by the old controller never identify durable data.
An existing local projection must agree with the selected committed state or be
replaced under the same authority. Missing, corrupt, undecodable or mismatched
state remains a specific recovery hold, without a fresh provider turn.

Default persistence design: reuse `runnerProfileJson.sessionCheckpoint` and add
only a private, versioned native recovery envelope for missing compatibility and
checkpoint-binding metadata. Persist the snapshot and its metadata together
under the current run's fenced ownership. Do not duplicate the PRP journal or
store server-specific fields as arbitrary Runner checkpoint parts. If existing
profile metadata already supplies a field, reference it instead of copying it.
Use a schema migration only if characterization demonstrates that the existing
run/session records cannot express a required durable lookup or concurrency check.

The private `nativeControllerRecovery` envelope is limited to 4 KiB serialized.
It contains a format version, digest of the exact redacted stored snapshot,
native configuration digest, process-configuration digest or explicit absence,
and PRP attachment/checkpoint binding. Run/company/task/agent/session identity is
validated against existing records and the snapshot, not duplicated execution
inputs. Keep credentials in the
existing encrypted authority; persist logical resource identities, not secret
values or host paths. Any newly sensitive recovery material uses the existing
encryption provider and remains excluded from public run projections.

`PaperclipControlPlanePort.checkpointSession` already persists the snapshot before
the local supervisor callback. Add the envelope to that same transaction and
update; do not introduce a second snapshot writer. Compute stable compatibility
inputs once per admission/attachment, preserve unrelated profile fields, and
recheck durable ownership after lock waits with the established lock ordering.
Keep legitimate post-result suspension/cleanup checkpoints permitted. The generic
Runner persistence port must not learn Paperclip database fields. Remote local
files become projections; local-only consumers retain authoritative files.

The recovery owner resolves, validates, materializes and attaches through existing
owners. Outcomes distinguish recoverable, waiting for an owner with its actual
deadline, missing/inconsistent evidence, unsupported format/capability, dependency
unavailable and proven no-prior-execution. Missing evidence is not fresh bootstrap.
Keep the 32-candidate selection window and newer-progress barriers; fetch the full
payload only for the selected source. PRP attachment identity and current business
run write authority differ during warm handoff and must remain explicit.

Publish a resumable snapshot only after its referenced PRP boundary is durable.
Across separate commits, interruption may leave a pending obligation, never a
false ready state. Recovery reconciles that exact obligation without rerunning
the provider. Completion acceptance, workspace settlement, session reuse, and
cleanup remain separate facts.

### Preserve ownership during replacement

The new server may load recovery data while the old server serves, but it cannot
send commands, acknowledge events, or settle results until it owns the execution.
Reuse the existing boot identity, generation and lease-owner fences. Cross-host
takeover uses DB lease authority, never a local check of another container's PID.

Graceful shutdown fences new local controller work, completes outstanding durable
barriers, detaches supported sessions, and releases only its own authority. A
crash uses natural expiry. The successor takes the existing fenced claim,
restores state, revalidates permissions and attaches to the exact remote process.
Lost authority detaches the stale controller without killing the surviving Runner.

Retain wake/recovery obligations while the previous lease is live. Reconcile at
startup and the actual lease/retry deadline through the shared scheduler. Cover
a lost local release notification with durable state and the deadline. Add no
permanent checkpoint scans or independent polling timers. A future shared
cross-instance notification mechanism can accelerate this path without becoming
its source of truth.

Exercise Stop and tool decisions arriving at either instance. Use existing durable
intents and receipts; fix a demonstrated missing native delivery path in its
owner. Never retransmit an uncertain external mutation just because its HTTP
response was lost. Current access, pause, cancellation and budget controls still
apply; restoring an admitted run is not a new grant of authority.

### Compatibility, adoption and retention

Use additive readers/writers. Before an ephemeral deployment is eligible, its
rollback target must understand the recovery envelope, sparse checkpoint policy
and authenticated cursor. A v2 decoder alone is insufficient. Preserve the
original Runner artifact identity; an old running binary does not gain new
capabilities merely because the webserver upgraded.

For existing file-backed sessions, allow the current legitimate owner to publish
a validated durable snapshot at a normal checkpoint boundary. A bounded explicit
backfill may import retained supervisor state while the disk is still available,
after rechecking the same bindings and ownership. Never fabricate missing
credentials, checkpoints or remote process evidence. Unprovable sessions remain
ineligible until normal completion/retirement or explicit recovery.

Keep local mode intact. Require the same externally supplied encryption key on
replacement; a recovery read must not generate a new key. Broad external-mode
startup validation belongs to the parent persistence workstream.

Extend existing retention reference checks for any new envelope references.
Retain active owners, unresolved handoffs/finalization and selected continuation
sources. Cleanup must not race a new continuation claim or allow a late writer to
resurrect deleted authority. Preserve bounded startup cleanup and zero idle SQL.

Expose an additive, versioned **native controller durability** diagnostic through
the existing internal upgrade report, with explicit unknown/ineligible reasons.
It must distinguish active adoption from retained-session continuation, and it
must never claim whole-instance volume removal readiness. Keep the existing
`ready` meaning compatible; the broader deploy coordinator composes this evidence
with workspace and other persistence checks. Derive eligibility from committed
records and supported readers, not a persisted boolean that can become stale.
Report active adoption, selected retained continuation, outstanding persistence or
handoff obligations and unsupported evidence separately. Include observation time,
bounded reason counts and coverage/truncation. Use bounded batched metadata/header
reads and pagination, and report incomplete inventory as unknown coverage. Add no
public endpoint. Establish the first envelope-capable release as the rollback
floor; an older local-only reader is not a valid empty-disk rollback target.

## PostgreSQL load contract

- Text streaming adds zero recovery SQL, transactions or checkpoint rows per chunk.
- Ordinary usage remains coalesced into control checkpoints. Preserve changed-part
  PRP writes and exact removals; do not add a journal, transcript or archive copy.
- Snapshot metadata rides the existing snapshot transaction, including unchanged
  metadata; no parallel writer, per-agent connection or new pool.
- Idle servers add no recurring SQL/network work once obligations settle.
- Scoped candidate selection fetches only the selected payload. Diagnostics use
  bounded headers/metadata, never an automatic scan of historical payloads.

Keep the existing dedicated checkpoint pool initially with its two-connection
default, lazy creation, idle release and shutdown fencing. Two is not an
architectural invariant. The invariant is bounded checkpoint traffic that meets
recovery deadlines without starving requests or renewals. Include both servers'
pools during overlap. Measure queue wait separately from SQL and lock wait. If
capacity fails acceptance, compare bounded sizes under the same workload and
choose the smallest passing size in a separately reviewable tuning change. Do not
increase the cap to conceal slow queries or lock contention.

Run paired baseline/candidate workloads with identical fixtures and counts and
all database clients included. Record statement/transaction classes, changed rows,
persisted bytes, WAL, CPU, memory, connections, request latency, checkpoint queue/
lock/execution latency, renewal latency/deadlines, throughput, retries and failures.
Use the existing 8/512-chunk test plus a stream beyond the retained-event window;
require exactly zero extra recovery SQL during text-only intervals. Repeat the
documented 300-controller/10,000-historical-task steady and aligned-burst workload,
alternating order and including actual session snapshot persistence.

Gates: unchanged lifecycle sequence has no additional normal checkpoint
transactions; no new idle work, missed lease deadlines, lost owners, dropped
operations or premature ACKs; existing absolute latency/throughput gates pass.
Investigate any repeatable increase above 10% in steady CPU per completed operation,
WAL per completed operation or request p99 before handoff; report absolute values
too. Measure replacement bursts separately within the 420-second grace. Never
relax persistence-before-effect guarantees to meet a performance target.

## Implementation slices

| Slice | Owned surfaces and useful result | Dependency / review evidence |
| --- | --- | --- |
| 1. Complete native recovery state | Native checkpoint adapter, executor persistence/lookup, session-resume owner and focused tests. Normal active, warm and per-turn paths reconstruct with no local marker or supervisor file. | Reuse landed checkpoint work; first reproduce the exact missing path. Test current local mode and incompatible-session barriers. Add only demonstrated missing envelope fields. |
| 2. Replacement ownership and compatibility | Native lifecycle, shared recovery scheduling, shutdown wiring, retention and internal upgrade diagnostics. Competing servers hand off safely, and historical sessions have an honest eligibility path. | Slice 1; real Postgres ownership races, natural expiry, stale callbacks, Stop, migration/read compatibility and rollback tests. Keep heartbeat wiring small. |
| 3. Application and hosted qualification | Existing restart supervisor/Product E2E suites, continuity docs and acceptance evidence. Two replacements preserve execution and later continuation. | Slices 1–2; workspace durability dependency for full-home cases. Real immutable A/B releases and compatible rollback; no synthetic claims of Daytona qualification. |

Tests and documentation travel with the behavior they verify. These are review
boundaries, not a fixed PR count. Combine tightly coupled implementation where
splitting would create an unusable intermediate state. Rebase onto the current
default branch and reconcile the active upgrades chat before writing source.

## Acceptance matrix

| Scenario | Required result and independently inspectable evidence |
| --- | --- |
| Fresh active remote run; graceful replacement | Same run, Runner process/start identity, provider session and active turn; one provider start, one final result |
| SIGKILL and absent controller storage | Normal startup claims after natural expiry; no manually edited lease, injected recovery marker or manual restore call |
| Output-only gap and pending tool/decision | Authenticated cursor recovers; pending input settles once; independent business receipt/effect count confirms no duplicate mutation |
| Completion while disconnected or during shutdown | Accepted result, accounting and finalization survive; incomplete persistence resumes without another provider turn |
| Completed warm and per-turn sessions | B can discover the correct source from DB; a later C continues it after B's controller storage is removed; no new provider session solely because a marker was missing |
| Warm config changes | Verified close/suspend and permitted saved-history resume; never incorrectly reuse changed credentials, tool contract or workspace |
| Old and new server overlap | B respects A's live lease; only one successor wins; delayed A cannot checkpoint, ACK, dispatch or finalize after losing ownership |
| Stop, revoked access, pause and cross-company attempts | Saved intent and current authorization prevail; no recovery bypass or delayed mutation |
| Corrupt/missing checkpoint, key or unsupported version | Precise ineligibility/hold; no silent fallback, replay, key generation or destruction of the last recoverable copy |
| Existing records and rollback | Valid local state can be imported under authority; unsupported state stays explicit; compatible prior release reads newly written records |
| Cleanup and idle | Selected checkpoints survive cleanup races; settled/idle states issue no new recurring SQL or network work; next legitimate producer reactivates recovery |
| Full application with empty homes | A → B → C uses the normal API/admission path and independently verifies the saved result; blocked until required workspace/backup dependencies are remotely durable |

## Feedback path and verification

First experiment: extend the existing real-Postgres remote continuation fixture
with a completed warm turn, remove both PRP marker and supervisor directories,
then submit the next turn through normal admission. Keep the remote Runner alive.
Assert the prior run/session chosen, process identity, one new turn and a useful
result. Also run the per-turn control. Do not prepopulate the desired recovery
state. This distinguishes a lookup/envelope gap from missing workspace material.

Use the existing local Linux/container harness and scripted provider initially;
it avoids paid model calls while preserving database locks and process lifetime.
Measure setup separately from edit → run → inspected evidence. Start with a short
outage; run the real 300-second outage after the narrow behavior passes. Record
elapsed time and the exact revision in this plan when implementation begins.

Then exercise separate compatible application revisions with distinct native roots
and shared Postgres, through normal startup/admission. Remove access to A's native
controller storage. Identify surviving non-native dependencies explicitly: this
is not evidence of whole-webserver filesystem loss. Test both SIGTERM and SIGKILL, B starting
while A still owns the run, decisions/Stop during handoff, and a second B → C
replacement. Retain an independent effects ledger and process identity evidence.
If this reaches a workspace/backup dependency, keep that failure as explicit
parent-workstream evidence; do not hide it with a copied controller directory.

Qualify one disposable Daytona environment using the existing Product E2E path,
including completion and follow-up, plus a compatible rollback. Record server
revisions, Runner artifacts, run/session/sandbox identities, lease timestamps,
receipt counts, recovery latency and cleanup. Reuse an existing healthy campaign
only after checking its owner and exact revision. No fleet rollout is part of
this checkpoint feature.

Required handoff checks for implementation: focused affected suites, then
`pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`. If schema changes prove
necessary, use `pnpm db:generate` and the migration/snapshot checks. Update
`doc/execution-semantics.md`, `doc/testing-native-remote-continuity.md`, relevant
developer/database documentation and affected capability maps. Run
`node scripts/check-maps.mjs` after map edits. PRs use the complete repo template.
Report skipped or unavailable checks without promoting older evidence to a pass.

## Parent-workstream dependencies and non-goals

Native checkpoint success alone does not permit removing the webserver volume.
Workspace sync still resolves local descriptors/manifests in
[`native-workspace-sync.ts`](../../server/src/services/native-runtime/native-workspace-sync.ts).
That owner must provide durable logical recovery references and saved generations;
this plan consumes that contract rather than moving workspace archives into PRP.
Provider backup blobs and prepared resources needed after a process has suspended
must likewise resolve without the old server disk.

Agent files/instructions, logs and accounting journals, imports, mutable packages,
global background-work claims, browser live-event delivery, HTTP readiness/drain,
and Cloud/Railway volume migration retain their own slices in the broader plan.
Do not turn native checkpoints into a second transcript: the existing sparse
checkpoint excludes display-only output, and this work does not strengthen the
run log's durability guarantee. Destroyed sandbox recovery, legacy local stdio
continuity and permanent horizontal scaling are outside this release.

Railway still prevents overlapping deployments on a service with an attached
volume. Its separate overlap/drain controls become useful after all required
volume dependencies and concurrent-server behavior are qualified. Sources checked
2026-10-30: [volume caveats](https://docs.railway.com/volumes/reference#caveats),
[deployment teardown](https://docs.railway.com/deployments/deployment-teardown).

## Current state and next action

The observations below retain earlier qualification attempts and their limits.
The PR's Verification section is the current acceptance record. The final native
runtime candidate is `eaef0d56552c087aaa4fa68a8655282ffbd12667`; documentation-only
updates do not change those runtime bytes. Its CI and fresh 5/5 review passed.
The corrected source-process test has completed active adoption and a fresh
retained follow-up. Distinct compatible rollback, installed-application and live
Daytona gates remain under verification as of 2026-10-30 20:28 UTC. Preserve failed
attempts when adding later passes. The rollback floor must include the idle-goal
reader fix; an envelope-only reader is insufficient.

Implementation is underway on `codex/native-controller-disk-independent-recovery`.
The related Cloud policy work merged as paperclip-cloud PR #1048; it retains
compatibility checks and drain fallback and does not implement this component.
Verified locally: metadata/source-selection/lock-wait checks (21 tests), readiness
and recovery scheduling (55 tests), durable discovery/import/inventory (7 tests),
and the complete native executor suite. The combined executor/selection/retention
run passed 1,063 tests and exposed two overbroad retention guards; those guards
were corrected and all 75 retention cases then passed. The snapshot fence test
also checks stale result acceptance and lease expiry during a run-row lock wait.

Both warm and per-turn fixtures passed three separate controller processes,
deleting both native controller directories before B and again before C. They
check provider history, Runner identity, invocation counts, and the existing
suspension policy. Per-turn uses the production admission selector and snapshot
rebinder. These processes use the same candidate source, not distinct release
artifacts. Workspace and remote sandbox storage remain available. This is not
full-webserver filesystem-loss evidence.

Both direct and prepared-task transport cases passed the 300-second outage with
natural lease expiry. The 8/512/8,192-chunk SQL test passed: each sample used seven
control transactions and twelve changed checkpoint records, with zero recovery
SQL/transactions/rows during the text interval and zero idle SQL. The long sample
included normal lease renewals. Its cluster-wide WAL values include simultaneous
test migrations and are diagnostic only, not a load acceptance measurement.

Workspace typecheck, build, and map structural checks passed on the earlier
candidate; the later check dispositions are recorded below. The paired
300-controller/10,000-task workload now includes actual snapshot persistence.
Its initial host pilot missed throughput gates; the subsequent isolated Linux
measurements are recorded below. Database cost acceptance, distinct-release application startup,
compatible rollback, and native Daytona qualification remain open. The published Daytona qualification image was independently resolved from successful
workflow 40709784515 to `sha256:b38ed051d00fed409092d354eea9ae1b01fb232bcb7d5a187ed763382dda2d0b`
(source `8fe5d5defcdfb55a1b9049a801cfa5498629cebc`). The exact Linux Runner was
extracted from that image. The local attempt failed during the environment probe before agent creation. A read-only lookup independently returned `DaytonaAuthenticationError: Invalid credentials`. The private database and cleanup obligation remain preserved. The protected single-cell workflow [41093316372](https://github.com/paperclipai/paperclip/actions/runs/41093316372), targeting `512cc6d6dc`, was cancelled during image/artifact builds before provider allocation so acceptance can use the rebased candidate. Its protected secret is separate from the invalid local fixture.
No production deployment or complete zero-downtime acceptance is claimed.

Failures retained in the implementation record: sandbox listener denial and host
embedded-Postgres startup limits; a corrected missing `phase` in a new fixture;
a corrected unexecuted clock query in result persistence; Linux fixture builds
first failed on shared build storage and then missing protocol source files,
resolved by a container-local build with the complete inputs. The 8,192-chunk
case exposed a test-provider cap of 4,096 (expanded in the test binary), then
exceeded the old short-stream wait limit. Its longer measurement now uses the
normal 60-second lease and renewal rather than an artificially long owner lease.
The long-stream renewal fixture initially omitted the controller PID/start identity;
renewal correctly rejected it. Complete fixture identity fixed the test. Per-turn
characterization then exposed the missing remote suspended-lifecycle projection;
that is now verified against the bound surviving sandbox. The fixture also now
uses the existing admission snapshot rebinder, which its warm-only predecessor
omitted. The first benchmark attempts lacked ES-module setup and the observer's
pg_stat_statements extension; the isolated Linux pilot needed its native Sharp
dependency. No database-load acceptance claim has been made from failed attempts.
There is no Paperclip issue bound to this local chat; this versioned source plan
is the handoff, rather than an upload to an unrelated company or issue.

The remaining native qualification and compatibility cells require reproducible
measurements and a reviewed PR. Full-home application
acceptance remains dependent on workspace/backup durability; no controller-only
test can waive that gate.

Qualification update: the legacy and changed-process-configuration warm cases
exposed a marker left by suspension before authority rotation. Restoring the
committed PRP checkpoint before constructing the replacement backend fixes both;
both real-process cases pass. The initial rerun used the wrong fixture executable
path and failed before provider startup; its log is retained. All 59 control-plane
port tests pass after narrowing the snapshot read to the binding and profile
columns it actually needs. The initial paired 300-controller ABBA comparison
completed every offered operation with no ownership losses, but candidate latency
and CPU increased above the investigation threshold. It is not performance
acceptance. A new paired run will measure the narrower snapshot projection.


Qualification update at `512cc6d6dc`: the snapshot port now combines coordinator
and run locks into one statement, with a database-clock check after both waits.
All 59 real-Postgres port tests pass. Snapshot and PRP transaction counts remain
unchanged; the first completed 300-controller baseline/candidate pair each issued
74,790 total statements and 7,800 control transactions across all pools. The
candidate adds the metadata bytes but no SQL per streamed chunk.

The dedicated Daytona suite now fixes the active outage at 300 seconds and adds
normal UI follow-up after a second replacement following completion. Its oracle
requires a new successful native run, retained native/provider session identity,
a completed tool receipt and correct saved-project output. Focused E2E support
checks passed (56 tests, one optional external-database case skipped), plus all
137 Node support tests and E2E typecheck. The explicit external-database fixture
was separately exercised against owned Postgres earlier. The broad E2E unit
attempt lacked local listener permissions and was stopped; that failure remains
in `/tmp/native-controller-e2e-unit.log`, and broad qualification is still open.

Database load remains **unqualified**. The narrowed-read and combined-query ABBA
runs became heavily contended as other local checks ran, including our E2E support
suite during the final pair. Both baseline and candidate lost absolute gates;
dropped operations invalidate relative comparisons. The combined-query first
pair completed all work, but its candidate p99 was 303 ms versus 131 ms and PG CPU
35.69 s versus 25.89 s. Unchanged business queries also slowed. These observations
require a quiet-host paired rerun; they are neither a performance pass nor proof
that the implementation caused all observed regression. The connection limit
remains unchanged. Summarized counters are retained in the adjacent
`2026-10-30-native-controller-load-evidence.json`; raw measurements remain under
`/tmp/native-controller-load/`. The reproducible script records failed absolute
and relative gates and marks unequal-operation comparisons ineligible.

Remaining critical path: finish the protected Daytona attempt and cleanup;
complete full repository checks on the final rebased revision; finish the quiet
steady/burst/replacement load gates and explicit lock-wait latency measurement;
qualify distinct installed A/B/A artifacts; then resolve review on the draft
PR. Current server startup smoke and three-controller component tests are useful
layer-specific evidence, not substitutes for those remaining gates.


The full local `pnpm test:run` attempt was stopped after roughly 45 minutes while
still progressing through the general chat suite. Its output is retained at
`/tmp/native-controller-full-tests.log`; it is incomplete, not a pass. Broad
checks will run on hosted Linux for the rebased candidate. The broad E2E support
rerun with two workers was also stopped before rebasing; focused support checks
remain the completed evidence. A separate `server-config.test.ts` diagnostic
confirmed the original restricted run's `listen EPERM` cause.


### Rebased review and qualification follow-up

Draft implementation: https://github.com/paperclipai/paperclip/pull/18343.
At rebased head `3aa90fbf0b5553ffa66a9cdc0fb153f348b56d75`, all 66 focused
persistence/discovery cases and full `pnpm -r typecheck` passed. The PR's general
server shard found 190 executor unit failures where synthetic IDs and a partial
Db double reached the new real discovery boundary. That fixture boundary is
being corrected; no production validation is relaxed. Greptile scored 3/5 and
identified missing prepared-task lifecycle reconstruction and retry after a
failed lifecycle read. Corrections and regression cases are under verification.
A separately identified retained-owner admission wait now uses the existing
same-run retry record/deadline, with unstarted-run and current-authority fences.

Protected Daytona workflow `41094539946` failed before any test cell ran: the
image publisher exhausted disk (`No space left on device`, exit 102), including
its cleanup/log writes. It is not live recovery evidence, and repeating the
same build without a capacity fix is not justified. The default-branch workflow
has no per-run disk-capacity or upgrade-manifest override. CI infrastructure owns
that dependency. The invalid local credential attempt remains unresolved evidence.

Local review-check attempts also encountered exhausted macOS Postgres semaphores;
only these owned test processes were stopped and moved to dedicated Docker
Postgres fixtures. One additional direct-read retry scenario timed out during
its source-controller fixture startup before a Runner appeared. Fixture import
readiness is now measured separately from the unchanged 60-second admission
limit. These failed/incomplete attempts remain distinct from subsequent passes.

Review-fix verification: all 1,066 cases across native executor, durable
discovery, startup recovery and heartbeat runtime execution passed against owned
Docker Postgres. After the final database-clock and operator-Stop fences, all
nine durable discovery/import/wait tests passed and server typecheck passed.
The direct per-turn failed-read regression passed through normal admission with
three real controller processes: the failed read leaves the reconstructed PRP
projection, the next admission reconstructs the missing lifecycle receipt, and
the next replacement still continues the same provider history. Prepared-task
resumed and failed-read/retry cases also pass for Codex and Claude fixtures.
These are scripted-provider component results with remote workspace storage
available, not live Daytona or distinct-release acceptance.


### Bounded qualification campaign on October 30

The follow-up campaign began at 18:33 UTC with an approximately one-hour budget.
Three GPT-6.1 Sol workers own live Daytona, database load, and distinct-reader
replacement/rollback; the coordinator owns integration, artifact builds and review.
The exact native implementation under test is `a0ef3ce7493c8bb76c4766ff007e8a390118d145`.
Qualification commit `da8c7f6e1837ddd896dfe83a7524812fee813487` adds measurement and
installed-journey admission only; its native runtime, Runner, shared and database
production files are byte-identical to that implementation.

The independent Linux database campaign uses an eight-vCPU, 32 GiB disposable
host, with PostgreSQL and its Node workload each limited to two CPUs and 1536 MiB.
It preserves the existing 10/2/2 request/renewal/checkpoint pool caps per logical
server. Steady and aligned-burst ABBA comparisons passed the existing absolute,
correctness and 10% relative regression gates with 300 controllers and 10,000
historical tasks. Neither changes snapshot/PRP transaction counts. The separate
claim-capacity probe waits for natural lease expiry, invokes the production
claim path for 300 synthetic executions, restores real encrypted checkpoints
under empty controller directories, and measures current-owner checkpoint and
renewal work. Synthetic provider references do not establish sandbox existence
or authenticated provider reattachment.

The closed, sanitized measurements and limits are recorded in
`2026-10-30-native-controller-qualification-evidence.json`. The earlier failed,
contended-host measurements remain in `2026-10-30-native-controller-load-evidence.json`.
Lock measurements use calibrated PostgreSQL wait-start timestamps and sampled
duration bounds. Observer traffic contributes to the measured database cost;
short unsampled waits and full HTTP latency remain outside that measurement.

Live qualification uses protected campaign
[41108162900](https://github.com/paperclipai/paperclip/actions/runs/41108162900).
Its initial catalog timeout occurred before provider allocation after Azure
reported a dependency-cache egress limit. A scoped exact-entry cache invalidation
and targeted retry forced a successful cold install. Only this campaign's
ephemeral image publisher received a larger, delete-on-termination disk; image
identity, source admission and provider authorization gates remain in force.

Provider-free package builds pin first reader `59ff89a18fe1312b5f0bb908439bbdb1237b0252`
and candidate `a0ef3ce7493c8bb76c4766ff007e8a390118d145` in runs
[41108342354](https://github.com/paperclipai/paperclip/actions/runs/41108342354) and
[41108352138](https://github.com/paperclipai/paperclip/actions/runs/41108352138).
The source-process crash probe independently observed B waiting for A's live
lease and claiming the same execution after natural expiry, with no lease edits.
Its initial all-turns/single-provider-process assertion also crossed completion
contract revision 1 to revision 2. The existing Runner attachment policy can
retire a provider at a changed semantic contract while preserving its conversation;
phase-specific observations distinguish that boundary from same-contract rollback.
Earlier strict failures remain retained until that distinction is demonstrated.

The final live, reader, installed-artifact, cleanup and CI outcomes are maintained
in [PR #18343](https://github.com/paperclipai/paperclip/pull/18343), with their exact
revisions and evidence limits. Campaign registration, successful artifact builds
and this plan entry do not themselves certify that a live journey passed.
