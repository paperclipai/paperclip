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
new generation; a repeated HTTP request cannot.

The existing exact-run retry endpoint retains its source-bound contract.
Connected conversations use their existing inbound authorization owner. A board
Retry changes the workspace strategy, not the external principal, source batch,
conversation access or publication authority.

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

Execution containment and file preservation are independent facts:

- Another agent needs authoritative containment of the old executor.
- Copyback needs a quiescent writer and a verified destination.
- A fresh attempt uses a new execution workspace and the separate
  `isolated-workspace-attempts` namespace. It does not modify the original
  directory or satisfy that source's preservation/cleanup obligation.

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
  src/services/workspace-recovery.test.ts \
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
