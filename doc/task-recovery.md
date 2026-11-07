# Automatic task recovery

Infrastructure recovery belongs to the system. A task shows one working state,
one scheduled retry, or an ordinary **Retry** action. Approval, credentials,
assignment, budget and deliberate pause remain separate user decisions.

## Admission and execution

`POST /api/issues/:id/retry` accepts `{ idempotencyKey, observedRunId }`.
It requires authenticated board task-mutation authority. It records an
`agent_wakeup_requests` receipt before physical work. Company/key uniqueness
covers completed and failed receipts as well as pending ones. Concurrent clicks
attach to accepted work. A new deliberate click after exhaustion can create a
new generation; a repeated HTTP request cannot. A click does not renew an
exhausted generation that already requires an alternative strategy and has no
fresh attempt. The click binds to that generation and continues without
repeating the failed step. A Retry never silently drops the agent's work:

- If the task's own local workspace (a git worktree or isolated directory) is
  safe to reuse, the Retry continues there with a fresh session. Uncommitted
  files, Git history and the task branch stay in place. Reuse requires the same
  one local directory the failed run used, still bound to and owned by this
  task, not a shared project workspace, and not under remote storage authority.
  The prior executor must be stopped, its leases released, and the recovery
  generation settled. No other lease, failed cleanup or running workspace
  operation may hold the directory. A restart orphan does not count: an
  operation of the stopped source that started before the source settled and
  before the current server process started. Operations with no run, of
  another run, or started in the current process still block reuse. Its Git status must still be readable from
  that directory itself. Workspace-export failures keep their repair path.
- Otherwise the Retry continues in a fresh isolated attempt seeded from
  committed files. The previous directory is retained unmodified. The retried
  run's continuation context names it in `priorWorkspace`: its path, branch
  and a bounded list of its uncommitted files, read without Git optional locks.
  This hint is given only for a task-owned local directory with a settled
  recovery generation, no pending workspace repair and no other writer. The
  file list is given only when Git resolves to that directory itself.

Either choice consumes the generation's one alternative attempt. Preparing the
same attempt again after a restart reuses the directory that attempt already
created and bound; it does not ask for another fresh directory.

The existing exact-run retry endpoint retains its source-bound contract.
Connected conversations use their existing inbound authorization owner. A board
Retry preserves external principal, conversation access and publication checks.
A GitHub Retry selects already-saved, undelivered input before replaying the
failed run's older request. The selected receipts transfer to the retry owner
under the dispatch transaction. They link to its one successor, including after
a restart or a lost dispatch response. Rejected, unadmitted retries release the
saved input for another deliberate Retry.

A deliberate GitHub Retry can admit saved input after the same App reconnects.
It verifies the App binding in the accepted delivery or its historical working
comment receipt, then checks current sender, repository, conversation and task
access. The retry records the current runtime generation and credential-reference
fingerprint. Another reconnect invalidates that admission. Historical deliveries,
stale webhook callbacks and the exact-run retry contract retain their fences.
Legacy input that predates saved App IDs can also use an earlier processed
response ledger from the same company, endpoint, conversation and agent. Its
server-owned App binding must predate that input and retain a processed delivery
and inbound source link. The endpoint's non-null App claim cannot be replaced;
this proves historical identity without replaying the earlier response. Missing
proof or an explicit conflicting App binding still rejects Retry.

Task Retry keeps the complete saved-input batch, including batches larger than
the exact-run endpoint's limit. Source rows, receipts and invalidations are read
in batches. Within one transaction, messages with the same principal and automatic
policy context share a current-access check; every message still proves its App,
destination, comment link and immutable source. Different automatic policy contexts
receive separate access checks. Input in another conversation remains queued.

A connected-conversation Retry can save its exact request while the matching
system recovery generation verifies the old executor. Saving that wait grants
no execution authority. The chat owner rechecks the same board intent, external
principal and source batch when it resumes the deferred receipt. Containment,
current access, task eligibility, pause and budget gates must still pass before
one successor starts. Restarts reuse the receipt; they do not create another
Retry generation or another external publication.

Resuming a chat Retry preserves its exact authorized input batch. Independent
board messages keep their own queue receipts and enter a separate turn. If an
older queue merged those messages and dispatch refused the batch before any
provider work, a new deliberate Retry can restore the undelivered receipts.
Restoration requires the exact bootstrap failure, no execution or allocation,
current chat authority, unchanged board input and no prior delivery. It records
an audit event and retains the failed run and original skipped receipts.

Several retained recovery holds can describe the same failed execution. A
historical hold without a system recovery record uses the current exact Retry's
workspace strategy for that run. It does not borrow another run's strategy or
skip any hold's independent containment and effect checks. Attaching a Retry to
active automatic recovery preserves its generation, attempt count and deadline.

A deliberate Retry can bind that intent to failed historical predecessors within
a 32-run chain of persisted retry edges. Every run must retain the same company, task and
agent, a terminal state and an ordered creation time. Missing, cyclic, contradictory
or overlong lineage stays held; transcript hints confer no authority. Completed
ancestors retain their existing recovery generation. A failed historical native
source with an inherited session requires verified saved work, settled ownership
and exact stop receipts before a fresh user turn. Its bounded host preparation
settlement must prove no provider work; input, result, process, output and provider
usage evidence still prevent admission. Prior action outcomes remain recorded and
are never replayed by this authorization.

A new user message, a saved undelivered message, or a deliberate board Retry can
continue a failed native preparation after its saved remote workspace is verified.
The source must retain its unresolved native adapter claim and the server's
failed-preparation settlement records, with no
provider execution, session, input or result evidence, and no active controller
or native coordinator. An inherited `sessionIdBefore` is prior context, not proof
that this attempt started a provider. An admitted continuation starts a fresh
session. The saved message is consumed once when execution starts, and the new
run clears the prior failure notice.
Every source lease must have exact stop and cleanup proof. The saved snapshot
must match the source, workspace epoch, generation and clean writer state. Resolving the
preservation action does not discard the canonical Retry source. The same
request resumes through normal admission and current repository access checks.
Unknown execution, operator Stop, changed ownership and missing receipts keep
the request held. Preservation alone does not authorize automatic replay.

Preparation can initialize an object run log before provider dispatch. A finalized
log with zero bytes and the SHA-256 digest of empty content is compatible with
the no-output proof when its reference binds the exact company, agent and run.
Output progress and nonempty excerpts still block admission. Unknown size or
digest, another log backend, and incomplete preparation settlement remain held.

Agent Chat additionally requires the current conversation owner and enabled
Agent Chat. Admission and dispatch both recheck these conditions under the
issue lock. An unadmitted receipt from a former owner cannot own the current
owner's Retry.

The normal dispatch queue rechecks task eligibility and claims saved input.
An accepted native result goes back to its existing finalizer. Recovery does
not create a second agent to reproduce that result.

## Files, ownership and effects

The source recovery action holds a validated `systemRecovery` record. Its
revision and generation fence late bookkeeping writes. Physical exports still
use the existing workspace ownership lock and controller stop receipts.

The export owner can reopen its exact stopped sandbox through the environment
runtime's recovery path. This path checks the current source action, run,
environment, allocation, stop-only intent, and physical ownership claim before
calling the provider. The retained-source fence still blocks ordinary resume
and destruction. Recovery does not clear it to gain access to the saved files.

The reopen moves the original stop receipt into the stop-only intent before it
calls the provider. The lease shows no receipt while the reopen is in progress.
When the provider returns the reopened allocation, recovery discards the old
receipt, and the allocation needs a fresh stop. If the reopen fails, recovery
asks the provider to stop the allocation. If that stop also fails, recovery
restores the original receipt and lease state, so a stopped source never stays
without a receipt. A reopen that fails because the sandbox disk is full ends the
generation with `source_unavailable`. Saved input and Retry then continue in a
fresh isolated workspace.

Execution containment and file preservation are independent facts:

- Another agent needs authoritative containment of the old executor.
- Copyback needs a quiescent writer and a verified destination.
- A fresh attempt uses a new execution workspace and the separate
  `isolated-workspace-attempts` namespace. It does not modify the original
  directory or satisfy that source's preservation/cleanup obligation. It is
  used only when the task's own workspace cannot safely continue the work.

A missing managed sandbox cannot answer another stop request. Core can request
a signed absence observation from Cloud under a host-bound server capability.
Cloud reads the exact allocation in the historical credential's organization.
Only a fresh signature for the exact stack, company, issue, run, lease,
allocation and physical recovery owner can settle execution absence. Permission
failures, a changed organization, unsigned answers and provider timeouts remain
inconclusive. This protocol requires Cloud support before the Core consumer.

An absence receipt does not recover files or complete the task. The original run
stays failed and its source remains protected. Existing authorized input may use
normal fresh workspace admission only after every executor is contained. Known
publications and uncertain external effects retain their normal receipt fences.

Fresh attempts currently require Core-managed storage. Plugin-owned storage
does not yet support importing these preserved snapshots. Preparation stops
before calling that provider or acquiring an environment. It retains the
original workspace rather than reopening it as a fresh attempt.

Valid native baselines use the existing merge. A bound historical source
without a merge baseline is exported to configured storage as an immutable,
verified snapshot. Upload operations have stable identities and manifests.
Recovered snapshots attach separately with provenance; they never become an
invented baseline for overwriting newer files.

When that owned files-only export reports a full sandbox disk, recovery can
reclaim a verified inactive native provider installation and retry the same save
once. The failed source must have a terminal coordinator with no controller
owner or resumable failure, and its Core-verified provider-pack admission must
match the exact run, company, agent, workspace and lease. Unverified historical
installations remain held for operator repair.

Only the reserved provider-pack `node_modules` and `provider-assets` directories
are eligible. The installation manifest, task files, Git history, sessions,
checkpoints and action receipts stay intact. A read-only inspection supplies
manifest and directory identities for a source-bound journal in Core's database.
That journal commits before cache contents change. Where directory creation
times are available, cleanup needs only reads and deletion, so it can start even
when archive-helper writes fail for lack of space.

On filesystems without creation times, deleting children changes the directory's
fallback timestamp. Recovery first releases blocks by truncating only regular
installation files with no additional hard links through verified file handles. It
skips files without write permission and stops scanning as soon as marker space
is available, including when an earlier eligible cache supplied that space. It
then moves the cache to an operation-specific path and pins a small identity
marker in the existing Core journal before recursive deletion. An interrupted
cleanup can resume against that marker without accepting a new installation,
a replacement staged directory or a copied marker. The emptied staged directory
and its marker remain in reserved runtime storage as generation evidence; the
canonical installation path stays absent so later installation rebuilds it.
Neither task files nor sessions enter this staging path. Changed identities or
symlinks keep the original export failure.

Inspection, optional staging and deletion each have a bounded remote call. The
block-release scan visits at most 8,192 entries across the eligible caches and
stops once 256 KiB is available for the markers. If capacity cannot be read, it
uses a bounded 256 KiB estimate of released blocks. Journal creation and
cleanup record separate terminal operations; neither is a file-save receipt or
a new background obligation. An uncertain acknowledgement never proves that
files were saved. This adds no provider turn, recovery generation or retry budget,
and the normal save and stop receipts still govern continuation.

Known publication receipts and exact API mutation receipts carry forward.
Uncertain API mutations and upstream tool mutations remain fenced across run
replacement. Reads and independent work remain available. Generic upstream
tools have no universal result-query protocol, so their unknown mutations
require authoritative reconciliation rather than a new call key. Existing
GitHub publication reconciliation stays with its dedicated receipt owner.

## Retry policy and historical adoption

Maintenance allows an initial attempt and five retries at 30, 60, 120, 240 and
480 seconds with persisted ±20% jitter. Scheduling stops 30 minutes after the
first failure. A longer provider cooldown takes precedence. Restarts, phase
changes and rescans do not replenish the budget. Existing stricter execution
retry limits remain separate.

The maintenance sweep classifies at most 50 historical records per tick.
Indexed source queries and durable policy markers prevent repeat adoption.
It includes retained leases, legacy runs without native descriptors, exhausted
actions and resolved actions that still owe preservation. Historical failure
evidence remains intact.

Saved authorized follow-ups may continue through normal dispatch. A task with
no waiting request requires Retry before another agent turn. Completed,
cancelled, deliberately paused and superseded tasks do not reopen merely
because old files need maintenance.

`historicalRecoveryCounts` reports classification, preservation, input delivery,
waiting-for-Retry and unresolved-source counts for protected diagnostics.
Adoption alone is not proof that files were recovered.

## Local diagnostics and presentation

Recovery and its durable failure evidence stay inside the stack. Exhausted
attempts remain on the system-owned source recovery record with their failure
code, evidence fingerprint and retry budget. The existing local server log
records preservation failures. Recovery does not add a Cloud incident endpoint,
notification worker or outbound reporting channel.

The task interruption projection drives thread, composer and list status.
Thinking is optimistic presentation, not a fake run or provider-start record.
Unknown admission reconciles the same request key. Backoff and real user gates
replace Thinking when work is not active. Saved input is editable; Steer and
Interrupt require a live target. Technical diagnostics remain inspectable.

## Qualification

Run the focused PostgreSQL/filesystem suites from `server/`:

```sh
../node_modules/.bin/vitest run --config vitest.config.ts \
  src/services/system-recovery-state.test.ts \
  src/services/task-retry.test.ts \
  src/services/workspace-recovery-retry-copyback.test.ts \
  src/services/workspace-recovery-preparation.test.ts \
  src/services/workspace-recovery-preparation-proof.test.ts \
  src/services/workspace-recovery-preparation-dispatch.test.ts \
  src/services/workspace-recovery-preparation-gates.test.ts \
  src/services/workspace-recovery-warm-handoff.test.ts \
  src/services/workspace-recovery-admission.test.ts \
  src/services/explicit-native-continuation.test.ts \
  src/services/heartbeat/workspace-preparation.test.ts \
  src/services/native-runtime/native-chat-workspace.test.ts
```

`server/scripts/workspace-recovery-provider.test.mjs` is an opt-in controlled
Daytona probe. It requires `PAPERCLIP_RECOVERY_LIVE=1`, `DAYTONA_API_KEY`,
`PAPERCLIP_DAYTONA_SDK_PATH` and an immutable `PAPERCLIP_RECOVERY_IMAGE`.
An immutable provider snapshot UUID in `PAPERCLIP_RECOVERY_SNAPSHOT_ID` can
replace the image digest. The probe checks its ID and active state first.
It interrupts export,
joins the first controller, starts a second controller and verifies files,
preservation receipts, agent-start count and external-operation count before
cleanup. It does not claim an abrupt controller kill or a live LLM/GitHub test.

The local browser fixture uses the actual API, PostgreSQL and native runner
with a deterministic model process. Verify immediate Thinking with delayed
HTTP, one successor, the independent directory, unchanged source files, a
useful result and stable completion after reload.

Neither this probe nor a green build proves hosted recovery. Hosted acceptance
requires the actual served revision, the original saved input, readable
preserved files, and confirmation that completed publications were not repeated.
