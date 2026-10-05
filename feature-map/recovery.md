# Recovery

People can see why a task stopped, who owns the next action, and whether a safe
continuation is available. Recovery retains task context and ownership, honors
pause and budget gates, and distinguishes confirmed failure from an uncertain
external outcome. A retry acknowledgement alone is not proof that work resumed.

## Sub-features

- `diagnosis`: a task/run exposes the recorded cause, evidence, owner, attempt
  progress, and next action without requiring a raw-log interpretation.
- `bounded-continuation`: supported interrupted work continues with preserved
  conversation context and bounded attempts, without blindly replaying tools.
- `source-action`: source-scoped recovery actions remain attached to the task;
  independent repair work may have its own issue and return owner.
- `exhaustion`: exhausted or overdue recovery exposes the current gate and
  permitted operator action; it does not claim an automatic path is still live.
- `workspace`: workspace divergence/export failures show the applicable repair,
  reconcile, or isolated reissue action with evidence and authority checks.
- `unknown-outcome`: uncertain external side effects require inspection and
  an explicit decision, not automatic replay.
- `user-continuation`: saved user messages after a stop are reconsidered once
  cleanup proves the old execution is stopped; duplicate wakes are avoided.
- `reconnect`: browser stream recovery refreshes persisted state without claiming
  the agent itself restarted or that a failed run succeeded.

## How to get to it (user POV)

### `source-task`

Open the affected task from Tasks, Inbox/Blocked, search, or a direct task link.
Inspect the recovery notice/card in its history, expand details if needed, and
use the currently offered action. Follow any linked repair task and return owner.

### `run-detail`

Open the agent's run (`/agents/:agentId/runs/:runId`) from activity or the task's
run link. The run page hosts workspace recovery controls only for a failed run
with error code `workspace_validation_failed` and a linked source task that still
has a live `workspace_validation` recovery action. Use the source task for other
stopped-run recovery checks.

### `operator-retry`

On an exhausted disposition or workspace recovery card, inspect the current
reason and use the permitted retry/repair/reconcile action. Some repairs require
confirmation; unavailable actions must explain the gate or remain absent.

### `post-stop-message`

After a stop, send a new instruction on the same task or inspect one already
saved while cleanup was pending. Observe the waiting message, continuation, and
eventual result rather than manually changing the task status to look complete.

### `browser-reconnect`

While viewing an active or recovering task, interrupt the browser connection
and restore it, or suspend and return to the tab. Reload is a separate check.
The current task and run state should reconcile with the server.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey).
Use a disposable instance and reproducible failure. Record source task/run,
adapter/runtime mode, cause, attempt count, current owner, and verified stop
evidence. Do not kill an unrelated server or induce provider side effects just
to get a failure screen. Use the existing deterministic recovery suite first.

### `source-task`

Automated: [recovery actions](../server/src/__tests__/issue-recovery-actions.test.ts)
covers source scoping, bounded attempts, operator stops, quota monitoring,
ownership, stale action retirement, and continuation deduplication.
[Recovery cards](../ui/src/components/IssueRecoveryActionCard.test.tsx) cover
diagnosis, retry progress, exhaustion, and action availability. The fixture-backed
[execution-recovery journeys](../tests/e2e/execution-recovery/recovery.spec.ts)
start their own test-drive instances and exercise safe, uncertain, restart,
manager-lineage, and legacy-unknown paths:

```sh
pnpm exec vitest run server/src/__tests__/issue-recovery-actions.test.ts ui/src/components/IssueRecoveryActionCard.test.tsx
pnpm exec playwright test -c tests/e2e/execution-recovery/playwright.config.ts recovery.spec.ts
```

Manual: open a stopped task through each affected navigation path. Confirm its
explanation, original owner, recovery owner if different, and next action. Follow
the supported recovery until the source task produces a useful result or a
specific escalation. Reload and verify that resolved notices retire and attempt
history remains. A fixture pass does not qualify every live harness/provider.

### `run-detail`

Automated: [run workspace recovery](../ui/src/components/RunWorkspaceRecoverySurface.test.tsx)
tests this host; it is component coverage, not an end-to-end repair.

Manual: prepare a failed run with error code `workspace_validation_failed`, a
linked source task, and a live `workspace_validation` recovery action on that
task. Open that exact run and compare its recovery diagnosis to the source task.
Use an eligible action from the run surface, return to the task,
and verify the same action state, persisted outcome, and restored execution.
Repeat with an actor who lacks authority. Verify that the run-page controls are
absent for other error codes or after the source action retires; continue other
recovery checks on the source task. Full run-detail navigation remains a manual
gap.

### `operator-retry`

Automated: [disposition notices](../ui/src/components/DispositionRecoveryNotice.test.tsx)
tests pending/error/gated states and waiting for the real retry acknowledgement.
The recovery-card suite covers workspace divergence, reissue, reconcile, and
confirmation. [Workspace export](../ui/src/components/WorkspaceExportRecovery.test.tsx)
covers its separate repair surface.

Manual: reproduce an exhausted disposable action. Click once, verify pending
state prevents repeated clicks, and inspect a successful continuation or an
explicit rejection. Reload to confirm the durable outcome. For a workspace
repair, record the compared branches/revisions and preserve uncommitted work;
confirm the repair's actual result before resuming. Check the denied and stale
action paths. A changed card label is insufficient proof of workspace integrity.

### `post-stop-message`

Automated: [legacy continuation](../server/src/services/recovery/legacy-continuation.test.ts),
[queue routes](../server/src/__tests__/issue-queued-comments-routes.test.ts), and
[native restart recovery](../server/src/services/native-runtime/native-restart-recovery.test.ts)
cover their respective recovery paths. [Legacy failure continuation](../tests/e2e/legacy-failure-continuation.spec.ts)
adds a browser journey; it is not native runtime proof.

Manual: stop a disposable run, submit a distinguishable follow-up, and observe
any cleanup wait. After confirmed stop, verify the follow-up reaches one eligible
continuation and produces the requested answer. Repeat with a task/ancestor
pause and a budget hold: recovery must not bypass the gate. For unknown external
outcomes, inspect the provider before authorizing another operation.

### `browser-reconnect`

Automated: [live-update recovery](../ui/src/context/LiveUpdatesProvider.recovery.test.tsx)
covers client transport recovery with mocks. It does not prove runner restart.

Manual: go offline during a disposable run, let the server reach a new state,
then reconnect. Confirm task/run/attention data refresh without duplicate
comments or decisions; reload and compare. A healthy websocket proves transport
only. Separately inspect the underlying execution if it is still stuck.

## Gotchas

- Legacy and native runtimes have different ownership and restart paths. Record
  which one was exercised instead of inferring coverage from the adapter name.
- A process disappearance, elapsed timeout, or successful API retry does not
  prove an external tool operation never happened. Unknown outcomes stay unknown
  until corroborated; automatic replay can duplicate a side effect.
- Active-run watchdogs, task watchdogs, reviewers, and recovery owners have
  different authority. No recovery card grants board permission by itself.
- Idle Agent Chat is not stranded work. An intentional operator stop must not
  silently trigger recovery that fights the user's instruction.
- Source inspection and mocked component tests do not qualify real server
  restart continuity. Use the appropriate runtime suite for that claim.
- See [execution semantics](../doc/execution-semantics.md) for the governing
  recovery contract and [steering](./steering.md) for saved follow-ups.
