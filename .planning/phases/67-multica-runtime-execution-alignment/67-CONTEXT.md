# Phase 67: Multica Runtime Execution Alignment - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 67 hardens the existing RealTycoon2 execution lifecycle against the concrete Multica runtime reference: runtime-aware queue dispatch, heartbeat/capacity-based claim, cancellation, stale runtime/task cleanup, and progress/message/tool event visibility.

This phase must build on the existing Phase 3 RT2 execution backbone rather than replacing it. The current `rt2_v33_execution_attempts` table, RT2 task/detail/list contracts, heartbeat runs, workspace runtime services, Daily cockpit, and Jarvis evidence surfaces are the integration substrate. The phase must not implement Phase 68 wikiLLM living memory, Phase 69 Graphify v3 corpus sidecar, Phase 70 economy loop, or Phase 71 final acceptance gate. It may update the DevPlan alignment gate only for the Multica runtime rows it proves with code, UI/API evidence, and focused tests.

</domain>

<decisions>
## Implementation Decisions

### Queue State Machine
- **D-01:** Align the canonical RT2 execution queue vocabulary to Multica's `queued -> dispatched -> running -> completed/failed/cancelled` lifecycle. The current Phase 3 `claimed` state should be migrated or compatibility-mapped to `dispatched`; downstream product/API copy should use `dispatched`.
- **D-02:** Keep transition guards in the service/database path, not only UI. Legal warm path is `queued -> dispatched -> running -> completed/failed/cancelled`; retry creates a new `queued` attempt linked to the failed/cancelled source attempt.
- **D-03:** Treat `blocked` as task/issue/dependency policy evidence, not as a canonical runtime queue state for Phase 67 completion. Existing `blocked` data may be read for compatibility, but new runtime completion claims should prove the Multica-style terminal set.
- **D-04:** Domain events must be emitted for every runtime lifecycle edge: enqueued, dispatched, started, completed, failed, cancelled, retried, stale-cleaned, and progress/message recorded.

### Runtime-Aware Dispatch
- **D-05:** Add a server-owned dispatch/claim path that selects queued RT2 executions by runtime, rather than trusting the caller to provide executor fields directly. Manual board claim may remain for human work, but Multica parity is proven by a runtime-aware path.
- **D-06:** Runtime dispatch must check `workspace_runtime_services` health before assigning work: running service, healthy or non-failed health state, fresh `lastUsedAt`/heartbeat evidence, and matching company/workspace scope.
- **D-07:** Dispatch capacity must be enforced before moving work to `dispatched`. Use existing heartbeat/agent concurrency policy where available and fall back to an explicit runtime capacity value only when no stronger config exists.
- **D-08:** The queue selection should be deterministic and concurrency-safe: priority/age ordering, same-task duplicate-active protection, and an atomic update/transaction pattern equivalent in spirit to Multica's `FOR UPDATE SKIP LOCKED` claim path.
- **D-09:** Runtime assignment should set executor/runtime identity at dispatch time: `executorType`, `executorId`, `runtimeServiceId`, optional `heartbeatRunId`, and `executionWorkspaceId` must be inspectable from the execution summary.

### Heartbeat, Cancellation, And Cleanup
- **D-10:** Add first-class cancellation for queued/dispatched/running RT2 executions. Cancellation must write `cancelledAt`/completion timestamp, reason, actor, domain event, and user-visible evidence.
- **D-11:** Running RT2 executions linked to heartbeat runs must respect control-plane cancellation and scheduled retry invalidation. If a heartbeat run is cancelled, timed out, orphaned, or reaped, linked RT2 execution state should be reconciled rather than left active.
- **D-12:** Add stale runtime cleanup evidence for dispatched/running attempts whose runtime service is stopped, failed, missing, or stale. Cleanup should fail or cancel the attempt with a stable reason code and preserve retryability where appropriate.
- **D-13:** Add stale queued cleanup for attempts whose task/todo reached terminal state, was reassigned incompatibly, or lost its execution workspace/runtime scope before dispatch.
- **D-14:** Cleanup behavior must be observable through tests and reports; do not hide it as an internal cron with no artifact. A focused service method plus tests is enough for this phase.

### Progress, Message, And Tool Stream
- **D-15:** Reuse existing `heartbeat_run_events` as the durable low-level stream for heartbeat-backed execution instead of creating a parallel raw log table. Add RT2-specific event typing/read-model glue only where task/Jarvis surfaces need it.
- **D-16:** Add shared RT2 execution event/timeline types that normalize lifecycle, progress, text message, tool use, tool result, error, and cleanup events into a product-facing shape.
- **D-17:** The API should expose execution timeline evidence by task/attempt so UI surfaces do not parse raw heartbeat internals directly.
- **D-18:** For executions without `heartbeatRunId`, lifecycle domain events still produce a minimal timeline. Heartbeat-backed attempts enrich that timeline from `heartbeat_run_events`.

### Work Card And Jarvis Evidence Surfaces
- **D-19:** Surface runtime execution evidence inside existing RealTycoon2 work surfaces: `Rt2TaskPanel`, task list/cards, and the Phase 66 Daily cockpit. Do not create a separate Multica-branded product page.
- **D-20:** Product-facing labels remain Korean-first and RealTycoon2/Jarvis/work oriented. `Multica` may appear only in internal docs/planning/reference boundaries, not as the operator-facing runtime product name.
- **D-21:** Work cards should show execution state, executor/runtime, heartbeat/run freshness, cancellation/failure reason, latest progress, and latest tool/message evidence compactly.
- **D-22:** Jarvis evidence surfaces should consume the same timeline/read model so Jarvis recommendations can cite current execution state, not stale prose.

### DevPlan Alignment And Verification
- **D-23:** Update `scripts/rt2-devplan-alignment-gate.mjs` so the `Multica-style runtime execution` row becomes `complete` only after lifecycle transition guards, runtime-aware dispatch/heartbeat cleanup, cancellation, stream evidence, and UI/API evidence are all anchored.
- **D-24:** Focused verification should include shared execution contract tests, server RT2 execution route/service tests, heartbeat cleanup/reconciliation tests where touched, UI task/work-card timeline tests, and the DevPlan alignment gate test.
- **D-25:** Default verification remains `pnpm typecheck && pnpm test`; do not run `pnpm test:e2e` as the default Phase 67 gate.

### the agent's Discretion
- Exact migration strategy for `claimed` to `dispatched`, provided existing data/tests stay compatible and the new public contract uses `dispatched`.
- Exact stale thresholds and config defaults, provided they are explicit, test-covered, and recorded in evidence.
- Exact UI placement and compact styling for execution timeline details, provided Daily cockpit/task surfaces expose the required runtime evidence without a new product page.
- Exact report filename if a small runtime cleanup evidence report is useful, provided DevPlan alignment uses concrete code/test/UI anchors rather than a report-only claim.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Milestone Truth
- `AGENTS.md` - Korean-first workflow, RealTycoon2 terminology, verification command policy, lockfile policy, and no-overplanning guidance.
- `.planning/PROJECT.md` - v3.1 DevPlan Core Convergence goal, RealTycoon2-first identity, Multica engine boundary, and brownfield constraints.
- `.planning/REQUIREMENTS.md` - `RUNTIME-01`, `RUNTIME-02`, and `RUNTIME-03`.
- `.planning/ROADMAP.md` - Phase 67 goal, success criteria, and v3.1 dependency chain.
- `.planning/STATE.md` - Phase 67 current position and next-session instruction.
- `.planning/phases/65-devplan-truth-and-identity-cleanup/65-CONTEXT.md` - Evidence-backed completion rule and Multica product-facing boundary.
- `.planning/phases/66-daily-work-and-okr-cockpit-convergence/66-CONTEXT.md` - Daily cockpit/work card/Jarvis evidence surface decisions.
- `.planning/devplan-alignment-runs/2026-05-01T01-34-28-588Z/report.md` - Baseline row marking Multica runtime as Phase 67 tech debt.

### Multica Reference Boundary
- `.planning/research/ENGINE-REFERENCE-AUDIT.md` - Canonical Multica engine findings and RT2 integration direction.
- `_refs/multica/server/pkg/db/queries/agent.sql` - Multica queue claim, start, stale failure, cancellation, and runtime-scoped pending task queries.
- `_refs/multica/server/pkg/protocol/events.go` - Multica event vocabulary for task queued/dispatch/progress/message/completed/failed/cancelled.
- `_refs/multica/server/pkg/protocol/messages.go` - Progress and task message payload shapes.
- `_refs/multica/server/internal/daemon/client.go` - Daemon claim/start/progress/messages/complete/fail/status/heartbeat client contract.
- `_refs/multica/server/internal/daemon/daemon.go` - Runtime registration, heartbeat, recovery, polling, and cancellation behavior reference.
- `_refs/multica/server/internal/service/task.go` - Task service broadcast, progress, retry, failure handling, and task availability patterns.

### Existing RT2 Runtime Code
- `.planning/phases/03-multica-execution-backbone/03-CONTEXT.md` - Phase 3 execution model and deferred daemon/runtime parity.
- `.planning/phases/03-multica-execution-backbone/03-VERIFICATION.md` - Current verified lifecycle baseline and test anchors.
- `packages/db/src/schema/rt2_v33_execution_attempts.ts` - Existing RT2 execution attempt persistence to migrate/extend.
- `packages/shared/src/types/rt2-task.ts` - Current shared execution summary/state contract.
- `packages/shared/src/validators/rt2-task.ts` - Current enqueue/claim/start/complete/fail payload schemas.
- `packages/shared/src/rt2-task.test.ts` - Current shared execution lifecycle contract tests.
- `server/src/services/rt2-task-execution.ts` - Main RT2 execution lifecycle service and transition guard location.
- `server/src/routes/rt2-tasks.ts` - Current RT2 execution API routes.
- `server/src/__tests__/rt2-task-routes.test.ts` - Current execution lifecycle route tests.
- `server/src/services/heartbeat.ts` - Heartbeat run queue, cancellation, stale queued-run invalidation, liveness, and run event storage.
- `server/src/services/workspace-runtime.ts` - Runtime service lifecycle, status, health, reuse, release, and persisted service records.
- `packages/db/src/schema/heartbeat_run_events.ts` - Durable heartbeat event stream for progress/message/tool evidence.
- `server/src/services/live-events.ts` - Existing live event publisher to reuse for UI refresh signals if needed.

### Existing RT2 UI And Jarvis Surfaces
- `ui/src/api/rt2-tasks.ts` - Current task/execution client API bindings to extend with cancel/timeline/dispatch calls.
- `ui/src/components/Rt2TaskList.tsx` - Current task card execution state surface.
- `ui/src/components/Rt2TaskPanel.tsx` - Current task detail execution surface.
- `ui/src/components/Rt2TaskList.test.tsx` - Task card execution rendering tests.
- `ui/src/components/Rt2TaskPanel.test.tsx` - Task detail execution rendering tests.
- `ui/src/pages/rt2/DailyWorkPage.tsx` - Daily cockpit query orchestration and board integration.
- `ui/src/components/Rt2DailyBoard.tsx` - Three-panel cockpit, work card, Jarvis/knowledge/graph/economy evidence panels.
- `ui/src/api/rt2-jarvis-runtime.ts` - Existing Jarvis runtime client API surface.
- `server/src/services/rt2-jarvis.ts` - Current Jarvis task evidence aggregation and advice surface.
- `server/src/routes/rt2-jarvis.ts` - Jarvis route integration point if timeline evidence is surfaced through Jarvis.

### DevPlan Gate
- `scripts/rt2-devplan-alignment-gate.mjs` - v3.1 score and Multica runtime completion truth.
- `scripts/rt2-devplan-alignment-gate.test.mjs` - Focused alignment gate tests to update.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2TaskExecutionService` already owns enqueue, claim, start, complete, fail, retry, transition guards, domain event appends, and latest execution summaries.
- `rt2_v33_execution_attempts` already links task/todo, work products, execution workspace, runtime service, heartbeat run, executor identity, and timestamps.
- `heartbeatService` already has queued/running/scheduled retry statuses, cancellation paths, stale queued-run invalidation, orphaned run reaping, liveness classification, and durable `heartbeatRunEvents`.
- `workspace-runtime.ts` already persists runtime service status, `healthStatus`, `lastUsedAt`, provider, scope, and run leases.
- `Rt2TaskPanel`, `Rt2TaskList`, and `Rt2DailyBoard` already expose execution/work evidence in operator surfaces.
- `rt2JarvisService.getTaskAdvice` already gathers task/todo/deliverable/wiki/graph evidence and can be extended to include execution timeline state.

### Established Patterns
- RealTycoon2 product surfaces are Korean-first; internal API/package compatibility identifiers may remain English/Paperclip-oriented.
- RT2 execution is a thin layer over existing Paperclip execution workspaces, heartbeat runs, runtime services, and work products.
- Completion truth must be evidence-backed through code path, route/schema, UI surface, test, or generated report; no unsupported engine parity claims.
- Focused service/route/component tests are the right proof for this phase; Playwright e2e is not default.
- Domain events and activity log entries are already the preferred durable evidence trail for RT2 product actions.

### Integration Points
- Extend `packages/shared/src/types/rt2-task.ts` and `packages/shared/src/validators/rt2-task.ts` before updating server and UI consumers.
- Migrate or compatibility-map `claimed` to `dispatched` in `packages/db/src/schema/rt2_v33_execution_attempts.ts`, migrations, service transition guards, tests, and UI labels.
- Add runtime-aware dispatch, cancel, cleanup, and timeline methods to `server/src/services/rt2-task-execution.ts`.
- Add corresponding routes in `server/src/routes/rt2-tasks.ts` while preserving board actor/company access checks.
- Read heartbeat run events from `packages/db/src/schema/heartbeat_run_events.ts` to build RT2 execution timelines.
- Surface timeline/freshness evidence through `ui/src/api/rt2-tasks.ts`, `Rt2TaskPanel`, `Rt2TaskList`, and `Rt2DailyBoard`.
- Update `scripts/rt2-devplan-alignment-gate.mjs` and its tests after focused runtime evidence exists.

</code_context>

<specifics>
## Specific Ideas

- Multica's `ClaimAgentTask` is the reference pattern for deterministic atomic dispatch: queued-only candidate list, priority/age ordering, duplicate active-task protection, and an atomic update.
- A useful RT2 timeline event shape is `{ id, attemptId, kind, seq, label, message, toolName, status, createdAt, source }`, where `source` can be `rt2_domain_event`, `heartbeat_run_event`, or `cleanup`.
- Runtime freshness should be visible as product evidence: latest heartbeat/run event time, runtime service health, active attempt count, configured capacity, and stale reason if cleanup acted.
- DevPlan alignment should keep the row name `Multica-style runtime execution`, but the evidence must point to RT2 files and tests rather than claiming upstream Multica was imported.

</specifics>

<deferred>
## Deferred Ideas

- Phase 68 owns wikiLLM file model, Jarvis citation/update loop, and living memory export/materialization.
- Phase 69 owns Graphify v3 corpus graph sidecar, file cache, provenance, clustering, and graph query/report parity.
- Phase 70 owns Marketplace, P&L, amoeba economy, and CareerMate progression.
- Phase 71 owns the final v3.1 score delta and acceptance gate.
- Full external Multica daemon import or remote worker marketplace remains future scope; Phase 67 should adapt concrete runtime mechanics into RT2's existing execution substrate.

</deferred>

---

*Phase: 67-multica-runtime-execution-alignment*
*Context gathered: 2026-05-01*
