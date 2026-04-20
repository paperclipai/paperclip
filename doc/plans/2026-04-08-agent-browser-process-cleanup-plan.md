# PAP-1231 Agent Browser Process Cleanup Plan

Status: Proposed
Date: 2026-04-08
Related issue: `PAP-1231`
Audience: Engineering

## Goal

Explain why browser processes accumulate during local agent runs and define a cleanup plan that fixes the general process-ownership problem rather than treating `agent-browser` as a one-off.

## Short answer

Yes, there is a likely root cause in Paperclip's local execution model.

Today, heartbeat-run local adapters persist and manage only the top-level spawned PID. Their timeout/cancel path uses direct `child.kill()` semantics. That is weaker than the runtime-service path, which already tracks and terminates whole process groups.

If Codex, Claude, Cursor, or a skill launched through them starts Chrome or Chromium helpers, Paperclip can lose ownership of those descendants even when it still believes it handled the run correctly.

## Observed implementation facts

### 1. Heartbeat-run local adapters track only one PID

`packages/adapter-utils/src/server-utils.ts`

- `runChildProcess()` spawns the adapter command and records only `child.pid`
- timeout handling sends `SIGTERM` and then `SIGKILL` to the direct child
- there is no process-group creation or process-group kill path there today

`packages/db/src/schema/heartbeat_runs.ts`

- `heartbeat_runs` stores `process_pid`
- there is no persisted `process_group_id`

`server/src/services/heartbeat.ts`

- cancellation logic uses the in-memory child handle and calls `child.kill()`
- orphaned-run recovery checks whether the recorded direct PID is alive
- the recovery model is built around one tracked process, not a descendant tree

### 2. Workspace runtime already uses stronger ownership

`server/src/services/workspace-runtime.ts`

- runtime services are spawned with `detached: process.platform !== "win32"`
- the service record stores `processGroupId`
- shutdown calls `terminateLocalService()` with group-aware killing

`server/src/services/local-service-supervisor.ts`

- `terminateLocalService()` prefers `process.kill(-processGroupId, signal)` on POSIX
- it escalates from `SIGTERM` to `SIGKILL`

This is the clearest internal comparison point: Paperclip already has one local-process subsystem that treats process-group ownership as the right abstraction.

### 3. The current recovery path explains why leaks would be visible but hard to reason about

If the direct adapter process exits, hangs, or is cancelled after launching a browser subtree:

- Paperclip may think it cancelled the run because the parent process is gone
- descendant Chrome helpers may still be running
- orphan recovery has no persisted process-group identity to reconcile or reap later

That makes the failure look like an `agent-browser` problem when the more general bug is "executor descendants are not owned strongly enough."

## Why `agent-browser` makes the problem obvious

Inference:

- Chromium is intentionally multi-process
- browser automation often leaves a browser process plus renderer, GPU, utility, and crashpad/helper children
- skills that open browsers repeatedly amplify the symptom because each run can produce several descendant processes

So `agent-browser` is probably not the root cause. It is the workload that exposes the weak ownership model fastest.

## Success condition

This work is successful when Paperclip can:

1. start a local adapter run and own the full descendant tree it created
2. cancel, timeout, or recover that run without leaving Chrome descendants behind on POSIX
3. detect and clean up stale local descendants after server restarts
4. expose enough metadata that operators can see which run owns which spawned process tree

## Non-goals

Do not:

- special-case `agent-browser` only
- depend on manual `pkill chrome` cleanup as the primary fix
- require every skill author to add bespoke browser teardown logic before Paperclip can clean up correctly
- change remote/http adapter behavior as part of the first pass

## Proposed plan

### Phase 0: reproduce and instrument

Objective:

- make the leak measurable from Paperclip's side before changing execution semantics

Work:

- add a reproducible local test script or fixture that launches a child process which itself launches descendants and ignores normal parent exit
- capture parent PID, descendant PIDs, and run ID in logs during local adapter execution
- document current behavior separately for:
  - normal completion
  - timeout
  - explicit cancellation
  - server restart during run

Deliverable:

- one short repro note attached to the implementation issue or child issue

### Phase 1: give heartbeat-run local adapters process-group ownership

Objective:

- align adapter-run execution with the stronger runtime-service model

Work:

- update `runChildProcess()` to create a dedicated process group on POSIX
- persist both:
  - direct PID
  - process-group ID
- update the run cancellation and timeout paths to kill the group first, then escalate
- keep direct-PID fallback behavior for platforms where group kill is not available

Likely touched surfaces:

- `packages/adapter-utils/src/server-utils.ts`
- `packages/db/src/schema/heartbeat_runs.ts`
- `packages/shared/src/types/heartbeat.ts`
- `server/src/services/heartbeat.ts`

Important design choice:

- use the same ownership model for all local child-process adapters, not just Codex or Claude

### Phase 2: make restart recovery group-aware

Objective:

- prevent stale descendants from surviving server crashes or restarts indefinitely

Work:

- teach orphan reconciliation to inspect the persisted process-group ID, not only the direct PID
- if the direct parent is gone but the group still exists, mark the run as detached-orphaned with clearer metadata
- decide whether restart recovery should:
  - adopt the still-running group, or
  - terminate it as unrecoverable

Recommendation:

- for heartbeat runs, prefer terminating unrecoverable orphan groups rather than adopting them unless we can prove the adapter session remains safe and observable

Reason:

- runtime services are long-lived and adoptable
- heartbeat runs are task executions with stricter audit and cancellation semantics

### Phase 3: add operator-visible cleanup tools

Objective:

- make the system diagnosable when ownership still fails

Work:

- surface the tracked process metadata in run details or debug endpoints
- add a control-plane cleanup action or CLI utility for stale local run processes owned by Paperclip
- scope cleanup by run/agent/company instead of broad browser-name matching

This should replace ad hoc scripts as the general-purpose escape hatch.

### Phase 4: cover platform and regression cases

Objective:

- keep the fix from regressing and define platform behavior explicitly

Tests to add:

- unit tests around process-group-aware cancellation in adapter execution utilities
- heartbeat recovery tests for:
  - surviving descendant tree after parent loss
  - timeout cleanup
  - cancellation cleanup
- platform-conditional behavior notes for Windows, where negative-PID group kill does not apply

## Recommended first implementation slice

The first shipping slice should be narrow:

1. introduce process-group ownership for local heartbeat-run adapters on POSIX
2. persist group metadata on `heartbeat_runs`
3. switch timeout/cancel paths from direct-child kill to group kill
4. add one regression test that proves descendants die with the parent run

That should address the main Chrome accumulation path without taking on the full restart-recovery design in the same patch.

## Risks

### 1. Over-killing unrelated processes

If process-group boundaries are created incorrectly, cleanup could terminate more than the run owns.

Mitigation:

- create a fresh process group only for the spawned adapter command
- persist and target that exact group

### 2. Cross-platform differences

Windows does not support the POSIX negative-PID kill pattern used elsewhere in the repo.

Mitigation:

- ship POSIX-first
- keep direct-child fallback on Windows
- document Windows as partial until job-object or equivalent handling is designed

### 3. Session recovery complexity

Adopting a still-running orphaned group may look attractive but can break observability if stdout/stderr pipes are already gone.

Mitigation:

- default to deterministic cleanup for heartbeat runs unless adoption is explicitly proven safe

## Recommendation

Treat this as a Paperclip executor ownership bug, not an `agent-browser` bug.

`agent-browser` should remain a useful repro case, but the implementation should be shared across all local child-process adapters so any descendant process tree spawned by Codex, Claude, Cursor, Gemini, Pi, or OpenCode is owned and cleaned up consistently.
