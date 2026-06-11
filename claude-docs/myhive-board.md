# MyHive — Board-First Agent Control on Paperclip (in-place)

## Context

User ran the product-research-team on "MyHive": reframing Paperclip (agent company orchestrator at `~/sourceControl/paperclip`) into a single-operator delivery board. Trigger incident: a "hired" QA agent spawned unbounded tasks and burned ~1M tokens; the UI only exposed *pause* — no discoverable hard-stop, no delete for tasks/plans. Research (CPO-approved requirements at `claude-teams/product-research-team/output/requirements-myhive-2026-06-09.md`) confirmed the backend already has terminate / cancel-run / delete / tree-holds / budget hard-stop — the UI hides them.

**User decisions:** build in-place on a paperclip branch (no fork); full research MVP (M1–M12); runaway controls = per-plan/per-task token budget with auto-stop + global kill switch + live budget meter (no task-creation approval gate); Plans column supports both user-authored and CTO-agent-drafted plans, nothing executes until user clicks Activate.

**Board (user spec → status projection):**
| Column | Backend statuses |
|---|---|
| Plans | issues with `workMode='planning'` (plan cards; children hidden pre-activation) |
| Open | `backlog`, `todo` |
| In Development | `in_progress`, `blocked` (badge) |
| In Review | `in_review` |
| Done | `done`, `cancelled` (greyed) |

Review loopback (In Review → In Development on `changes_requested`) already exists server-side at `server/src/services/issue-execution-policy.ts:751-770`, wired into PATCH at `server/src/routes/issues.ts:4832` — surface it, don't build it.

## Backend

### 1. Schema (migration 0099 — latest is 0098)
- **NEW `packages/db/src/schema/plan_details.ts`**: 1:1 sidecar to plan-root issue. `issueId` PK/FK cascade, `state` (`draft|activating|active|stopped|completed`), `tiers` jsonb (phases/waves as data), `budgetCapCents`/`budgetCapTokens`, `activatedAt`/`stoppedAt`/`stopReason`, creator, timestamps. Plan root stays an issue (`workMode='planning'`) so assignment/heartbeat/comments/docs/tree-holds all work for free — this is what makes the agent-drafted path zero-cost.
- **CHANGED `issues`**: nullable `plan_root_issue_id` uuid + index, inherited at child creation; gives O(1) board descendant-exclusion and O(1) per-plan spend aggregation. Backfill statement in migration.
- **No schema for per-task budgets**: reuse `budget_policies` — `scopeType`/`metric` are text columns; add `'issue'` scope + `'total_tokens'` metric in `packages/shared/src/constants.ts:600-607`.

### 2. Plans API — NEW `server/src/routes/plans.ts` + `server/src/services/plans.ts`
- `POST /companies/:companyId/plans` — create plan issue + plan_details; optional `assigneeAgentId` triggers existing `queueIssueAssignmentWakeup` → CTO agent drafts.
- `GET /plans/:issueId` — card/drawer payload: issue + details + decomposition + tier progress + live spend.
- `PUT /plans/:issueId/tiers` — manual authoring while `state='draft'`.
- `POST /plans/:issueId/activate` — single transaction: assert draft, assert tier-1 non-empty (E9, 422, no partial emit), materialize tier-1 children at `todo` reusing the decomposition fan-out (`routes/issues.ts:4420`), stamp `plan_root_issue_id`, set `active`, emit WS event.
- `POST /plans/:issueId/stop` — tree-hold cancel via `services/issue-tree-control.ts` (cancels subtree runs + wakeups); safe no-op response `{stopped:true, runsCancelled:0, message:"nothing running"}`.
- `DELETE /plans/:issueId` — subtree delete: tree-hold cancel first, then leaves-first transactional delete (issues.parentId FK has no cascade). Card-level `DELETE /issues/:id` (`routes/issues.ts:5621`) untouched.
- CHANGED: `POST /issues/:id/accepted-plan-decompositions` gains `deferred:true` mode — records children into tiers WITHOUT creating issues (how agent-drafted plans wait for user activation).

### 3. Runaway controls (flagship)
- **Budget enforcement** in `server/src/services/budgets.ts` only — no heartbeat.ts edits:
  - `computeObservedAmount` (:144): `'issue'` scope filters cost_events by issue ∪ descendants (via `plan_root_issue_id` join); `'total_tokens'` metric sums input+cached+output.
  - `getInvocationBlock` (:717): use the **already-passed-but-unused** `context.issueId` to check task + plan-root issue-scoped policies. Zero changes at the 5 heartbeat call sites. Site `heartbeat.ts:6643` already cancels a blocked running run → mid-flight enforcement free.
  - `evaluateCostEvent` (:648) hard branch: add issue scope; `pauseAndCancelScopeForBudget` (:252) issue branch = tree-hold cancel subtree + `plan_details.state='stopped'` (`stopReason='budget_cap'`) + activity log + WS event.
  - Decision: cached input tokens count toward `total_tokens` (real usage pressure).
- **Kill switch**: `POST /companies/:companyId/kill-switch` — `heartbeat.cancelInvocationsForAgents(allCompanyAgents)` (`heartbeat.ts:11107`) + set company `status='paused'` (`pauseReason='manual_kill_switch'`) so the existing company-paused branch in `getInvocationBlock` blocks future invocations. `/kill-switch/release` clears. Returns cancelled counts.
- **Live meter**: `GET /companies/:companyId/budgets/live-meter` in `routes/costs.ts` — company window spend + per-active-plan spend vs cap.
- `PUT /issues/:id/budget` — upsert issue-scoped budget policy (mirrors agent-budget pattern in `routes/costs.ts:~368`).

### 4. Stage machine (M12/E3)
NEW `server/src/services/issue-stage-machine.ts`: column order backlog/todo=0 → in_progress=1 → in_review=2 → done=3; `blocked`↔`in_progress` ok; `cancelled` from anywhere. Reject backward moves for board/user actors unless produced by `applyIssueExecutionPolicyTransition` or engine actors (recovery/heartbeat/routines bypass — enforce ONLY in HTTP PATCH route, never in `services/issues.ts` core). ~20-line insertion in PATCH (~:4860) delegating to the module (keeps upstream merge surface small). Gate behind flag.

### 5. Solo-mode (M11) + WS events
- `soloMode` (+ optional `strictBoardTransitions`) added to `instanceExperimentalSettingsSchema` (`server/src/services/instance-settings.ts:40-68`); precedent `enableIssuePlanDecompositions`. UI-only hiding; no routes disabled.
- Extend `LIVE_EVENT_TYPES` (`packages/shared/src/constants.ts:666-677`): `issue.status.changed` (with `decisionOutcome`/`returnAssigneeAgentId`/`reviewerAgentId` — the M5 loopback motion event), `plan.state.changed`, `budget.threshold`, `killswitch.engaged/released`. Transport/bus unchanged.

## Frontend (ui/src/)

### 6. New board — do NOT modify `KanbanBoard.tsx`
Borrow its mechanics (dnd-kit sensors, DragOverlay, column paging) into new `components/hive/`. Old `/issues` board untouched.

- **Pure logic first**: `lib/hive-board.ts` (+tests) — `projectIssuesToHiveColumns` (incl. E7 descendant hiding), `canDropOnColumn` (strictly-forward only; Plans column locked), `targetStatusForColumn`; `lib/hive-loopback.ts` — diff projections to detect in_review→in_development moves for the animated loopback chip.
- **Components**: `HiveBoard/HiveColumn/HiveCard/HivePlanCard/HiveCardActions/ReviewFeedbackChip`, `PlanDetailDrawer` (Sheet, `?plan=` search param; shows phases/waves/children + Activate + budget cap), `NewPlanDialog` (manual OR assign-to-team), `BudgetMeterWidget` (QuotaBar reuse), `GlobalKillSwitch`, `ConfirmActionDialog`.
- **Pages/routes**: `pages/HiveBoardPage.tsx` at `/:companyPrefix/board` — index redirect flips `dashboard`→`board` (`App.tsx:71`); `pages/Monitor.tsx` (active agents + run log stream via `heartbeatsApi.log` offset polling, 2s; "no output captured" empty state).
- **Data**: board query key `[...queryKeys.issues.list(companyId), "hive-board", ...]` → existing WS invalidation in `LiveUpdatesProvider.tsx:665` works with zero provider changes. Live runs polled 5s (Issues.tsx pattern). Budget meter 30s + WS.
- **Mutations**: `hooks/useStageTransition.ts` with **mandatory `onError` → error toast + invalidate** (fixes the silent-swallow bug class from `Issues.tsx:169-175`; never optimistic status write without rollback). 422s (non-reviewer advance, comment-required) get explanatory copy.
- **Card controls**: Stop = cancel live run (no run → "Nothing running — no action taken" info toast); Cancel = transition to `cancelled`; Delete = confirm dialog → `issuesApi.remove`. Plan Stop = `previewTreeControl` count shown in confirm → `POST /plans/:id/stop`. Kill switch → backend atomic endpoint (no client fan-out).
- **A11y**: real buttons, aria-labels, focus-visible (not hover-only), KeyboardSensor drag, ARIA-labeled column regions, dnd-kit announcements. Cancelled/blocked styles contrast-checked.
- **Sidebar**: "Board" first nav item; `soloMode` hides Companies/Org/Goals/Approvals nav (precedent `Sidebar.tsx:55`).

## Build order

1. Migration 0099 + schema + shared constants (budget scope/metric, WS types, soloMode) — everything depends on it.
2. Solo-mode flag end-to-end (tiny; unblocks UI).
3. Stage machine + `issue.status.changed` WS emission.
4. `lib/hive-board.ts` logic + read-only 5-column board + landing flip.
5. Plan entity: plans routes, deferred decomposition, `plan_root_issue_id` inheritance; `NewPlanDialog` + `PlanDetailDrawer`.
6. Activation (M4/E7/E9) + descendant hiding verified.
7. Stop/Cancel/Delete everywhere (M6) + drag-through-stage-machine with error surfacing.
8. Runaway controls: budget enforcement branches, kill switch, live meter, `BudgetMeterWidget`, `GlobalKillSwitch`, per-plan cap input.
9. Review loopback visibility (chip + animation) + Monitor page.
10. WCAG audit + 500-issue render benchmark + test sweep.

## Risks

- `routes/issues.ts` is a 256KB hot upstream file — keep PATCH insertion ~20 lines delegating out.
- Subtree delete must cancel runs first + delete leaves-first (no FK cascade on parentId) or orphaned processes write to deleted issues.
- Stage guard must never run for engine actors (recovery/heartbeat) or unattended recovery breaks.
- Mid-run budget cap cancels at next heartbeat continuation boundary, not instantly — 10s SLA applies only to explicit Stop (process-group kill). Test this expectation.
- E8 feedback chip on 500 cards needs list-payload enrichment (`lastChangesRequested`) or lazy fetch — decide at step 9.
- Cost events with `issueId=NULL` can't count toward plan caps (still count toward agent/company caps) — documented gap.

## Verification

1. `npm test` in server + ui; new unit tests: hive-board projection/drag rules, stage-machine transitions, budget issue-scope aggregation.
2. Integration: activate plan → tier-1 tickets appear in Open, descendants hidden pre-activation; budget cap hit → subtree auto-cancelled within one heartbeat tick + board shows stopped + activity log entry; kill switch → all runs cancelled, new invocations blocked until release; backward drag → rejected with toast; `changes_requested` → card animates back to In Development with reviewer chip.
3. Manual loop (MVP success metric): create team → assignment → Plan card → Activate → Open → In Development → In Review → Done, stopping/deleting cards along the way, all from the board, zero CLI/DB touches.
