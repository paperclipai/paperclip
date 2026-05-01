# Phase 67: Multica Runtime Execution Alignment - Research

**Date:** 2026-05-01
**Mode:** inline research because Codex subagent spawning was not explicitly requested.
**Status:** Ready for planning

## Research Complete

Phase 67 should be implemented as a brownfield hardening of the existing RT2 execution attempt layer. The repo already has the right substrate:

- `rt2_v33_execution_attempts` stores task/todo/workspace/runtime/heartbeat links and current lifecycle timestamps.
- `rt2TaskExecutionService` owns transition guards and domain events.
- `heartbeatService` already has queued/running/scheduled retry handling, cancellation, stale queued-run invalidation, orphan reaping, and `heartbeatRunEvents`.
- `workspace-runtime.ts` stores runtime service status, health, `lastUsedAt`, provider, scope, and leases.
- `Rt2TaskPanel`, `Rt2TaskList`, and `Rt2DailyBoard` already expose execution or work evidence in product surfaces.

The missing part is not a new engine. It is alignment: state vocabulary, runtime-owned dispatch, cancellation/cleanup, and a normalized execution timeline that work cards and Jarvis can read.

## Findings

### Current RT2 Execution Layer

`server/src/services/rt2-task-execution.ts` currently supports:

- `enqueue`: creates a queued attempt and appends `rt2.execution.enqueued`.
- `claim`: moves `queued -> claimed`, records executor/workspace/runtime/heartbeat, and appends `rt2.execution.claimed`.
- `start`: moves `claimed -> running`.
- `complete`: moves `running -> completed` and requires result work product or missing deliverable reason.
- `fail`: moves `claimed/running -> failed`.
- `retry`: creates a new `queued` attempt from failed/cancelled/blocked source.

This was enough for Phase 3, but Phase 67 requires `dispatched` rather than `claimed`, explicit cancellation, runtime health/capacity checks, cleanup evidence, and progress/tool/message stream visibility.

### Multica Reference Mechanics To Adapt

From `_refs/multica/server/pkg/db/queries/agent.sql`:

- Claim candidates are runtime-scoped and `queued` only.
- Claim updates `queued -> dispatched` atomically with priority and age ordering.
- Start updates `dispatched -> running`.
- Stale `dispatched/running` tasks are failed with reason evidence.
- Cancel is legal from `queued`, `dispatched`, or `running`.
- Active duplicate work is prevented for the same issue/agent.

From `_refs/multica/server/pkg/protocol/messages.go` and `events.go`:

- Progress carries task id, summary, step, total.
- Task messages carry seq, type, tool, content, input, output.
- Event vocabulary includes queued, dispatch, progress, completed, failed, message, cancelled.

RT2 should not import Multica. It should adapt these mechanics to existing RT2 task/execution objects.

### Existing Heartbeat/Runtime Fit

`server/src/services/heartbeat.ts` already provides:

- `heartbeatRuns` statuses `queued`, `running`, `scheduled_retry`, `succeeded`, `failed`, `cancelled`, `timed_out`.
- `CANCELLABLE_HEARTBEAT_RUN_STATUSES`.
- `cancelRun`, `cancelActiveForAgent`, queued stale invalidation, orphan reaping, liveness classification.
- `appendRunEvent` into `heartbeatRunEvents`.

`server/src/services/workspace-runtime.ts` already provides:

- `RuntimeServiceRef` with `status`, `healthStatus`, `lastUsedAt`, `startedAt`, `stoppedAt`, `provider`, `scopeType`, and `executionWorkspaceId`.
- runtime service start/stop/reuse semantics.

The smallest reliable Phase 67 path is to join RT2 execution attempts to these records rather than creating a separate runtime registry.

### UI/Jarvis Fit

`Rt2TaskPanel` and `Rt2TaskList` currently render only a single execution state string. `Rt2DailyBoard` already has support evidence sections for Jarvis/knowledge/graph/economy and card progress. Phase 67 should add compact execution timeline/freshness evidence to these existing surfaces.

Jarvis task advice already gathers task, todo, deliverable, wiki, and graph evidence in `server/src/services/rt2-jarvis.ts`. Adding current execution timeline summary there gives Jarvis grounded runtime context without creating a new surface.

## Recommended Technical Approach

1. Add `dispatched` to shared execution state and compatibility-map old `claimed`.
2. Extend validators/API for dispatch, cancel, cleanup, and timeline.
3. Extend `rt2TaskExecutionService` with:
   - `dispatch` / `dispatchNextForRuntime`
   - `cancel`
   - `cleanupStale`
   - `listTimeline`
4. Add route coverage:
   - existing `/claim` can become compatibility wrapper returning `dispatched`.
   - new `/dispatch` or `/dispatch-next` route proves runtime-aware assignment.
   - `/cancel`, `/cleanup-stale`, and `/timeline` expose required behavior.
5. Reuse `heartbeatRunEvents` for timeline enrichment and domain events for non-heartbeat lifecycle.
6. Update UI task surfaces and Daily cockpit with Korean-first runtime evidence.
7. Update DevPlan alignment row after tests prove the feature.

## Risks And Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `claimed` compatibility breaks old data/tests | Existing Phase 3 tests fail | Accept `claimed` as read-compatible and migrate service outputs/tests to `dispatched`. |
| Runtime dispatch becomes too broad | Could claim work for unhealthy or unrelated runtime | Require company scope, running runtime service, non-failed health, and active-count capacity guard. |
| Timeline duplicates raw logs | UI becomes noisy and control-plane-shaped | Normalize only lifecycle/progress/message/tool/error events needed by RT2 surfaces. |
| DevPlan overclaims engine parity | Repeats Phase 65 issue | Gate `multica-runtime` complete only with code, route/schema, UI, tests, and engine audit anchor. |

## Validation Architecture

### Automated Tests

- Shared contract:
  - `packages/shared/src/rt2-task.test.ts`
  - validates `dispatched`, dispatch/cancel/timeline/cleanup payload schemas.
- Server route/service:
  - `server/src/__tests__/rt2-task-routes.test.ts`
  - covers `queued -> dispatched -> running -> completed/failed/cancelled`, duplicate dispatch guard, runtime capacity guard, stale cleanup, and timeline.
- UI:
  - `ui/src/components/Rt2TaskPanel.test.tsx`
  - `ui/src/components/Rt2TaskList.test.tsx`
  - optionally `ui/src/components/Rt2DailyBoard.test.tsx` if Daily cockpit receives execution evidence props.
- DevPlan gate:
  - `scripts/rt2-devplan-alignment-gate.test.mjs`
  - `pnpm run rt2:devplan-alignment-gate`

### Verification Commands

- `pnpm exec vitest run --project @paperclipai/shared packages/shared/src/rt2-task.test.ts`
- `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/rt2-task-routes.test.ts`
- `pnpm exec vitest run --project @paperclipai/ui ui/src/components/Rt2TaskPanel.test.tsx ui/src/components/Rt2TaskList.test.tsx`
- `node scripts/rt2-devplan-alignment-gate.test.mjs`
- `pnpm run rt2:devplan-alignment-gate`
- `pnpm typecheck`
- `pnpm test`

### Manual Checks

None required for Phase 67. Browser e2e is not default per `AGENTS.md`.

## Open Questions

No user input required in `--auto` mode. The planner should choose exact stale thresholds and compatibility migration mechanics conservatively.

---

*Research complete: 2026-05-01*
