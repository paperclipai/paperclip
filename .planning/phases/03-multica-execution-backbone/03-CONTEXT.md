# Phase 3: Multica Execution Backbone - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Connect RT2 tasks and to-dos to a real execution lifecycle modeled after Multica: enqueue, claim, start, complete, fail, and retry. This phase makes execution state visible on RT2 work objects and links RT2 task identity to the existing Paperclip execution workspace, heartbeat, runtime service, and work product records. It does not introduce the Phase 4 append-only event stream, Phase 5 wiki/graph projections, or Phase 6 Jarvis quality intelligence.

</domain>

<decisions>
## Implementation Decisions

### Execution model
- **D-01:** Phase 3 implements a Multica-inspired lifecycle contract inside RealTycoon2, not a wholesale Multica runtime import.
- **D-02:** The canonical RT2 execution states are `queued`, `claimed`, `running`, `completed`, `failed`, `cancelled`, and `blocked`.
- **D-03:** Paperclip issue status remains the compatibility/control-plane status, but RT2 execution lifecycle state becomes the product-facing execution truth for RT2 tasks and to-dos.
- **D-04:** Lifecycle transitions must preserve explicit ownership. A task is not `claimed` unless a human, Jarvis agent, or runtime worker is recorded as the claimant.

### Runtime integration
- **D-05:** Existing `execution_workspaces`, `workspace_runtime_services`, heartbeat runs, and work products are the initial execution substrate.
- **D-06:** Phase 3 should add a thin RT2 execution layer over these existing records rather than replacing workspace-runtime or heartbeat internals.
- **D-07:** Local execution uses existing workspace realization and runtime service paths; remote or adapter-managed execution can be represented through provider metadata and nullable local paths.
- **D-08:** Execution runtime linkage must include stable identifiers for RT2 task or todo, underlying issue, execution workspace, runtime service or run, executor, and produced work product when available.

### Task and deliverable linkage
- **D-09:** RT2 task and to-do records created in Phase 2 remain the source work objects. Phase 3 augments them with execution context rather than introducing a parallel task model.
- **D-10:** Every execution attempt should be able to point back to the deliverable or work product it is expected to produce.
- **D-11:** Completion should not mean only “process exited.” It must record whether the expected deliverable was produced, submitted, or explicitly marked missing.
- **D-12:** Work products remain the durable output surface for PRs, previews, artifacts, documents, runtime URLs, and branches.

### Queue and claim behavior
- **D-13:** The first usable slice should support company-scoped enqueue, claim, start, complete, fail, and retry operations through service/API contracts.
- **D-14:** Claiming must be atomic enough to prevent duplicate active execution for the same RT2 task or to-do.
- **D-15:** Retry should create a new execution attempt while preserving the failed attempt history.
- **D-16:** Human-held work can be represented in the lifecycle, but automatic heartbeat recovery applies only to agent/Jarvis-owned execution.

### UI and operator visibility
- **D-17:** RT2 task detail and to-do surfaces should show execution lifecycle status beside deliverable status.
- **D-18:** Operators should be able to inspect current executor, last attempt, execution workspace, runtime service, failure reason, retry availability, and linked work products without dropping into raw logs.
- **D-19:** Raw Paperclip runtime/workspace details remain accessible as an advanced/control-plane drilldown, not the primary RT2 execution vocabulary.

### Safety and governance
- **D-20:** Company access checks and actor permissions are mandatory for all execution mutations.
- **D-21:** High-impact or externally visible execution actions, such as moving an AI executor into autonomous execution, must keep approval/audit boundaries intact.
- **D-22:** Phase 3 should log important lifecycle mutations through existing activity/audit mechanisms where available, but full event-sourced writes are deferred to Phase 4.

### the agent's Discretion
- Exact table names for the RT2 execution attempt layer, as long as they are stable, descriptive, and company-scoped.
- Whether the first slice stores lifecycle state on a dedicated execution table or through a narrowly scoped extension of existing RT2 task profiles, provided the API contract stays clear.
- Exact UI placement inside existing RT2 task/detail panels.
- Exact retry metadata shape, as long as prior attempts remain inspectable.

</decisions>

<specifics>
## Specific Ideas

- Treat Multica as the lifecycle reference: enqueue -> claim -> start -> complete.
- Treat Paperclip as the orchestration/control-plane substrate: issue status, heartbeat runs, execution workspaces, runtime services, approvals, and audit logs.
- In product language, prefer `Execution`, `Jarvis`, `Task`, `To-Do`, and `Deliverable` over Paperclip-specific terms.
- The first milestone outcome should be an inspectable execution backbone, not a full remote worker marketplace.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone source of truth
- `.planning/PROJECT.md` — RT2 refoundation goal and brownfield migration constraints.
- `.planning/REQUIREMENTS.md` — Phase 3 requirements `FOUND-01` and `FOUND-02`.
- `.planning/ROADMAP.md` — Phase 3 goal and success criteria.
- `.planning/STATE.md` — Current milestone state after Phase 2 completion.
- `AGENTS.md` — RealTycoon2 identity, Multica usage policy, execution layer responsibility, approval and audit constraints.

### Prior phase decisions
- `.planning/phases/01-rt2-shell-and-product-truth/01-CONTEXT.md` — RT2-first shell, Paperclip boundary, and reconstruction policy.
- `.planning/phases/01-rt2-shell-and-product-truth/02-SUMMARY.md` — Windows runtime/worktree stabilization and existing runtime substrate status.
- `.planning/phases/02-one-liner-and-deliverable-capture/02-CONTEXT.md` — Phase 2 boundary and deferred Multica execution lifecycle.
- `.planning/phases/02-one-liner-and-deliverable-capture/02-VERIFICATION.md` — Verified One-Liner/deliverable capture contract and full-suite gate.

### Existing execution and runtime semantics
- `doc/execution-semantics.md` — Current Paperclip ownership, issue status, checkout, wakeup, and recovery semantics.
- `doc/spec/agents-runtime.md` — Agent heartbeat runtime guide, wakeup modes, logs, sessions, and safety notes.
- `doc/plans/workspace-technical-implementation.md` — Execution workspace, work product, runtime service, and rollout model.
- `doc/plans/workspace-product-model-and-work-product.md` — Product model for workspaces and work products.
- `doc/SPEC-implementation.md` — Existing control-plane safety and behavior contract.

### Code integration anchors
- `server/src/services/rt2-task-engine.ts` — RT2 task/todo/deliverable service to augment with execution context.
- `server/src/routes/rt2-tasks.ts` — RT2 task API surface for task/detail execution fields.
- `server/src/services/execution-workspaces.ts` — Durable execution workspace records and close/readiness behavior.
- `server/src/services/workspace-runtime.ts` — Existing local runtime realization, runtime service persistence, and adapter-managed runtime reporting.
- `server/src/services/work-products.ts` — Durable output/work product service used for deliverables and execution results.
- `packages/db/src/schema/execution_workspaces.ts` — Existing execution workspace schema.
- `packages/db/src/schema/workspace_runtime_services.ts` — Runtime service persistence.
- `packages/db/src/schema/agent_task_sessions.ts` and `packages/db/src/schema/agent_runtime_state.ts` — Existing agent runtime/session state surfaces.
- `packages/shared/src/types/rt2-task.ts` and `packages/shared/src/validators/rt2-task.ts` — RT2 task contract to extend.
- `ui/src/components/Rt2TaskPanel.tsx` and `ui/src/components/Rt2TaskList.tsx` — RT2 task UI surfaces for execution visibility.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2TaskEngineService`: already owns RT2 task, to-do, participant, and deliverable creation. It is the right service boundary for adding execution summaries or delegating to a new RT2 execution service.
- `executionWorkspaceService`: already lists, summarizes, closes, and updates execution workspace records with runtime service linkage.
- `workspace-runtime.ts`: already realizes local/git-worktree execution contexts, starts runtime services, persists adapter-managed service reports, and restarts desired services.
- `workProductService`: already stores outputs that can represent deliverables, previews, runtime URLs, PRs, branches, artifacts, and documents.
- Existing route authz patterns around execution workspaces and workspace runtime should be reused for company-scoped execution mutations.

### Established Patterns
- RT2 task records are layered on Paperclip issues through `rt2V33TaskProfiles`; do not create a disconnected task identity.
- Work products are issue-first and can optionally link to execution workspaces or runtime services.
- Execution workspaces are runtime units; issues/tasks remain planning and ownership units.
- Runtime services can be local processes or adapter-managed reports and may be linked to execution workspaces.
- Windows runtime/worktree behavior is now test-covered and should not be destabilized by Phase 3.

### Integration Points
- Add or extend shared RT2 execution types in `packages/shared`.
- Add a company-scoped RT2 execution service under `server/src/services/`.
- Add RT2 execution routes under `server/src/routes/` or extend `rt2-tasks` where the resource is task-local.
- Update `rt2TaskEngineService.getDetail` and list summaries to include execution status and attempt counts.
- Update UI task/detail panels to expose lifecycle status, executor, workspace, runtime, and output links.
- Add focused tests for atomic claim behavior, lifecycle transitions, company authz, task detail execution summaries, and UI rendering.

</code_context>

<deferred>
## Deferred Ideas

- Full append-only event stream for all lifecycle writes — Phase 4.
- Projector-backed wiki, graph, search, and P&L read models from execution events — Phases 4 and 5.
- Jarvis-generated execution advice and quality evaluation modes — Phase 6.
- Ledger-backed rewards and marketplace reputation from execution outcomes — Phase 7.
- Full external Multica daemon or remote worker marketplace integration — future milestone unless the existing repo already exposes a narrow safe adapter.

</deferred>

---

*Phase: 03-multica-execution-backbone*
*Context gathered: 2026-04-24*
