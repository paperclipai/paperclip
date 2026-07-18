# Paperclip Operational Audit 2026 — Sprint 4
## 10 ROUTINES AND TRIGGER SYSTEM

**Evidence date:** 2026-07-15  
**Scope:** Routine definition schema, trigger types, scheduling, webhook firing, concurrency policies, catch-up behavior, issue creation, assignment, agent wakeup, completion, and history.

---

## 1. Routine Definition Schema

### 1.1 `routines` table
**File:** `packages/db/src/schema/routines.ts`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `company_id` | uuid FK → companies | Company-scoped |
| `project_id` | uuid FK → projects | Optional |
| `goal_id` | uuid FK → goals | Optional |
| `parent_issue_id` | uuid FK → issues | Optional |
| `title` | text | Required; supports template variables |
| `description` | text | Optional; supports template variables |
| `assignee_agent_id` | uuid FK → agents | Agent assigned to execute |
| `priority` | text | Default `medium` |
| `status` | text | `active`, `paused`, `archived` |
| `concurrency_policy` | text | `coalesce_if_active` (default), `always_enqueue`, `skip_if_active` |
| `catch_up_policy` | text | `skip_missed` (default), `enqueue_missed_with_cap` |
| `variables` | jsonb | Array of `RoutineVariable` definitions |
| `created_by_agent_id` / `created_by_user_id` | | Audit |
| `updated_by_agent_id` / `updated_by_user_id` | | Audit |
| `last_triggered_at` | timestamp | |
| `last_enqueued_at` | timestamp | |

### 1.2 `routineTriggers` table
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `company_id` | uuid FK → companies | |
| `routine_id` | uuid FK → routines | |
| `kind` | text | `schedule`, `webhook`, `api` |
| `label` | text | Human-readable |
| `enabled` | boolean | Default `true` |
| `cron_expression` | text | For `schedule` kind |
| `timezone` | text | For `schedule` kind |
| `next_run_at` | timestamp | Computed by scheduler |
| `last_fired_at` | timestamp | |
| `public_id` | text | For webhook URL |
| `secret_id` | uuid FK → company_secrets | For webhook auth |
| `signing_mode` | text | `bearer`, `hmac_sha256`, `github_hmac`, `none` |
| `replay_window_sec` | integer | Default 300s |
| `last_rotated_at` | timestamp | |
| `last_result` | text | Human-readable result summary |

### 1.3 `routineRuns` table
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `company_id` | uuid FK → companies | |
| `routine_id` | uuid FK → routines | |
| `trigger_id` | uuid FK → routineTriggers | Nullable |
| `source` | text | `schedule`, `manual`, `api`, `webhook` |
| `status` | text | `received`, `coalesced`, `skipped`, `issue_created`, `completed`, `failed` |
| `triggered_at` | timestamp | |
| `idempotency_key` | text | For deduplication |
| `trigger_payload` | jsonb | Input payload + resolved variables |
| `dispatch_fingerprint` | text | SHA-256 of canonical dispatch inputs |
| `linked_issue_id` | uuid FK → issues | Created execution issue |
| `coalesced_into_run_id` | uuid | If coalesced |
| `failure_reason` | text | |
| `completed_at` | timestamp | |

**Key symbols:**
- `packages/db/src/schema/routines.ts`
- `packages/shared/src/types/routine.ts`
- `packages/shared/src/validators/routine.ts`

**Confidence: HIGH**

---

## 2. Trigger Types

### 2.1 Schedule triggers (`kind: "schedule"`)
- Cron expression + timezone.
- `nextRunAt` computed via `nextCronTickInTimeZone()` (minute-granularity, zoned).
- Scheduler tick (`tickScheduledTriggers`) queries for `nextRunAt <= now`.

### 2.2 Webhook triggers (`kind: "webhook"`)
- Public URL: `{PAPERCLIP_API_URL}/api/routine-triggers/public/{publicId}/fire`
- Authentication modes:
  - `none` — publicId is the only secret
  - `bearer` — `Authorization: Bearer {secret}`
  - `hmac_sha256` — `X-Paperclip-Signature` + `X-Paperclip-Timestamp` with replay window
  - `github_hmac` — `X-Hub-Signature-256` or `X-Paperclip-Signature` with HMAC-SHA256
- Secret stored in `company_secrets`; rotated via `rotateTriggerSecret()`.

### 2.3 API triggers (`kind: "api"`)
- Triggered by `POST /routines/:id/run` (manual run) or programmatic API calls.
- No persistent trigger row required; the routine itself can be run on-demand.

**Key symbols:**
- `server/src/services/routines.ts::tickScheduledTriggers()`
- `server/src/services/routines.ts::firePublicTrigger()`
- `server/src/routes/routines.ts::POST /routines/:id/run`

**Confidence: HIGH**

---

## 3. Schedule Representation

- Standard 5-field cron: `minute hour day-of-month month day-of-week`
- Timezone-aware using `Intl.DateTimeFormat` for zoned minute matching.
- `nextCronTickInTimeZone()` advances minute-by-minute from `after` until a match is found (safety limit: 5 years).

**Key symbols:**
- `server/src/services/routines.ts::nextCronTickInTimeZone()`
- `server/src/services/cron.ts::parseCron()` / `nextCronTick()`

**Confidence: HIGH**

---

## 4. Input Payload Handling

### 4.1 Variable resolution order
1. Workspace-derived automatic variables (e.g., `workspaceBranch`) — **authoritative, cannot be overridden**
2. Payload-provided variables (`payload.variables` for API/webhook; nested `variables` for manual)
3. Default values from routine definition
4. Required variables without defaults → `422 Unprocessable`

### 4.2 Variable types
- `text`, `textarea`, `number`, `boolean`, `select`
- `select` requires `options` array.

### 4.3 Template interpolation
- `routine.title` and `routine.description` are interpolated with resolved variables.
- Uses `interpolateRoutineTemplate()`.

**Key symbols:**
- `server/src/services/routines.ts::resolveRoutineVariableValues()`
- `server/src/services/routines.ts::dispatchRoutineRun()`
- `packages/shared/src/routine-variables.ts::interpolateRoutineTemplate()`

**Confidence: HIGH**

---

## 5. Idempotency

- `idempotencyKey` is accepted for API and webhook triggers.
- Deduplication scope: `(routineId, source, triggerId, idempotencyKey)`.
- Checked inside the dispatch transaction. If a matching run exists, the existing run is returned instead of creating a new one.

**Key symbols:**
- `server/src/services/routines.ts::dispatchRoutineRun()` — idempotency check inside `db.transaction`

**Confidence: HIGH**

---

## 6. Concurrency Behavior

| Policy | Behavior |
|--------|----------|
| `coalesce_if_active` (default) | If a live execution issue exists, mark run `coalesced` and link to active issue |
| `always_enqueue` | Always create a new execution issue, even if one is active |
| `skip_if_active` | If a live execution issue exists, mark run `skipped` |

### 6.1 Live execution issue detection
```sql
SELECT issues.*
FROM issues
INNER JOIN heartbeatRuns ON heartbeatRuns.id = issues.executionRunId
WHERE issues.companyId = ?
  AND issues.originKind = 'routine_execution'
  AND issues.originId = routine.id
  AND issues.status IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
  AND issues.hiddenAt IS NULL
  AND (issues.originFingerprint = dispatchFingerprint OR issues.originFingerprint = 'default')
ORDER BY issues.updatedAt DESC, issues.createdAt DESC
LIMIT 1
```

Two query paths exist:
1. `executionRunId` direct join (primary)
2. Legacy `contextSnapshot ->> 'issueId'` join (fallback for pre-migration data)

### 6.2 Database-level unique constraint
`issues_open_routine_execution_uq` enforces at most one open execution issue per `(companyId, originKind, originId, originFingerprint)` when `originKind = 'routine_execution'`.

**Key symbols:**
- `server/src/services/routines.ts::findLiveExecutionIssue()`
- `packages/db/src/schema/issues.ts::openRoutineExecutionIdx`

**Confidence: HIGH**

---

## 7. Catch-Up Policy

### 7.1 `skip_missed` (default)
- Only one run dispatched per tick per trigger.
- Missed windows are dropped.

### 7.2 `enqueue_missed_with_cap`
- When `tickScheduledTriggers()` finds a due trigger, it computes how many windows were missed:
```
cursor = trigger.nextRunAt
runCount = 0
while cursor <= now and runCount < MAX_CATCH_UP_RUNS:
    runCount += 1
    cursor = nextCronTick(expression, timezone, cursor)
```
- `MAX_CATCH_UP_RUNS = 25`
- The trigger's `nextRunAt` is advanced by a single DB update (optimistic lock on `nextRunAt = oldValue`).
- Then `runCount` dispatches happen sequentially in a `for` loop.

### 7.3 No persistent catch-up queue
The "catch-up" runs are executed **synchronously within the scheduler tick**, not enqueued to a background queue. This means:
- A catch-up burst may delay other triggers in the same tick.
- If the server restarts mid-catch-up, the remaining runs are lost (but `nextRunAt` is already advanced).

**Key symbols:**
- `server/src/services/routines.ts::tickScheduledTriggers()` — lines 1572-1636

**Confidence: HIGH**

---

## 8. Issue Creation

### 8.1 Dispatch transaction flow
1. `SELECT ... FOR UPDATE` on `routines` row.
2. Idempotency check.
3. Insert `routineRuns` row with `status: "received"`.
4. Check for live execution issue (concurrency policy).
5. If no active issue (or `always_enqueue`), create `issues` row:
   - `originKind: "routine_execution"`
   - `originId: routine.id`
   - `originRunId: run.id`
   - `originFingerprint: dispatchFingerprint`
   - `title`: interpolated from routine template
   - `description`: interpolated from routine template
   - `status: "todo"`
   - `priority`: routine.priority
   - `assigneeAgentId`: routine.assigneeAgentId
   - `executionWorkspaceId`: from input
6. If unique constraint violation (`issues_open_routine_execution_uq`), retry live-issue detection and coalesce/skip.
7. Queue issue assignment wakeup (`queueIssueAssignmentWakeup`).
8. Update run status to `issue_created`.

### 8.2 Failure handling
- If issue creation fails after the run row is inserted, the issue (if created) is deleted, and the run is finalized as `failed`.
- `updateRoutineTouchedState()` updates `lastTriggeredAt` and `lastEnqueuedAt`.

**Key symbols:**
- `server/src/services/routines.ts::dispatchRoutineRun()` — lines 761-1009

**Confidence: HIGH**

---

## 9. Assignment and Wakeup

When a routine execution issue is created:
- `queueIssueAssignmentWakeup()` is called with:
  - `heartbeat.wakeup(assigneeAgentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned", mutation: "create", contextSource: "routine.dispatch" })`
- This creates a heartbeat run for the assigned agent with the issue in its context snapshot.

**Key symbols:**
- `server/src/services/issue-assignment-wakeup.ts::queueIssueAssignmentWakeup()`
- `server/src/services/routines.ts::dispatchRoutineRun()` — wakeup call

**Confidence: HIGH**

---

## 10. Completion and History

### 10.1 Run finalization
- `finalizeRun(runId, patch)` updates `routine_runs` with status, `failureReason`, `completedAt`.

### 10.2 Issue-status-driven completion
`syncRunStatusForIssue(issueId)`:
- If issue status → `done`: run → `completed`
- If issue status → `blocked` or `cancelled`: run → `failed` with reason

### 10.3 History queries
- `GET /routines/:id/runs` — lists up to 50 (capped to 200) recent runs with trigger and linked issue summaries.
- `RoutineDetail` includes `recentRuns` (last 25) and `activeIssue`.

**Key symbols:**
- `server/src/services/routines.ts::finalizeRun()`
- `server/src/services/routines.ts::syncRunStatusForIssue()`
- `server/src/services/routines.ts::listRuns()`

**Confidence: HIGH**

---

## 11. Company, Project, Goal, and Agent Relationships

| Entity | Relationship |
|--------|-------------|
| Company | Required; all routines are company-scoped |
| Project | Optional; execution issue gets `projectId` from routine or override |
| Goal | Optional; execution issue gets `goalId` from routine |
| Parent Issue | Optional; execution issue gets `parentId` from routine |
| Assignee Agent | Required for `active` status; validated to belong to same company; cannot be `pending_approval` or `terminated` |

**Key symbols:**
- `server/src/services/routines.ts::assertAssignableAgent()`
- `server/src/services/routines.ts::assertProject()`
- `server/src/services/routines.ts::assertGoal()`

**Confidence: HIGH**

---

## 12. Failure Behavior

| Failure | Behavior |
|---------|----------|
| Missing required variables | `422 Unprocessable` before dispatch |
| No assignee agent | `422 Unprocessable` (must have default or override) |
| Agent not in company | `422 Unprocessable` |
| Agent pending/terminated | `409 Conflict` |
| Live execution exists + `skip_if_active` | Run `skipped`; no new issue |
| Live execution exists + `coalesce_if_active` | Run `coalesced`; linked to active issue |
| Unique constraint on open execution | Retry detection; coalesce/skip |
| Issue creation failure | Run `failed`; created issue deleted |
| Wakeup failure | Logged; run still `issue_created` |
| Webhook auth failure | `401 Unauthorized`; no run created |
| Webhook replay window exceeded | `401 Unauthorized` |

**Confidence: HIGH**

---

## 13. Activity Events

Automated routine runs log activity:
- `actorType: "system"`
- `actorId: "routine-scheduler"` (schedule) or `"routine-webhook"` (webhook)
- `action: "routine.run_triggered"`
- `entityType: "routine_run"`
- Details include `routineId`, `triggerId`, `source`, `status`

Manual/API runs log activity via the routes layer with the actual actor.

**Key symbols:**
- `server/src/services/routines.ts::dispatchRoutineRun()` — activity logging at end
- `server/src/routes/routines.ts` — manual run activity logging

**Confidence: HIGH**

---

## 14. UI Management Surfaces

- `GET /companies/:companyId/routines` — list routines with triggers, last run, active issue
- `GET /routines/:id` — detail view with triggers, recent runs, active issue
- `POST /companies/:companyId/routines` — create routine
- `PATCH /routines/:id` — update routine
- `POST /routines/:id/triggers` — create trigger
- `PATCH /routine-triggers/:id` — update trigger
- `DELETE /routine-triggers/:id` — delete trigger
- `POST /routine-triggers/:id/rotate-secret` — rotate webhook secret
- `POST /routines/:id/run` — manual run
- `POST /routine-triggers/public/:publicId/fire` — webhook ingress (unauthenticated at route level; auth checked inside)

**Key symbols:**
- `server/src/routes/routines.ts`
- `ui/src/pages/Routines.tsx`
- `ui/src/pages/RoutineDetail.tsx`

**Confidence: HIGH**

---

## 15. Related Tests

- `server/src/__tests__/routines-service.test.ts`
- `server/src/__tests__/routines-routes.test.ts`
- `server/src/__tests__/routines-e2e.test.ts`
- `server/src/__tests__/routine-run-telemetry.test.ts`
- `packages/shared/src/routine-variables.test.ts`
- `ui/src/lib/routine-trigger-patch.test.ts`
- `cli/src/__tests__/routines.test.ts`

**Confidence: HIGH**

---

## 16. Architectural Contradictions

### 16.1 `catchUpPolicy = "enqueue_missed_with_cap"` creates synchronous burst dispatches, not a true queue
The implementation fires up to `MAX_CATCH_UP_RUNS` dispatches sequentially within the tick loop. This can create a burst of issue creation and agent wakeups without rate limiting or deferral. The UI description says "Catch up missed schedule windows in capped batches after recovery," which implies a queue, but the implementation is immediate burst.

**Severity:** Low — `coalesce_if_active` mitigates for most use cases; burst bounded by 25.

### 16.2 `ROUTINE_CATCH_UP_POLICIES` is validated at the Zod schema level, but `tickScheduledTriggers` does not enforce `catchUpPolicy` for triggers that become due while the routine is `paused`
If a routine is `paused`, its trigger rows still have `enabled = true` (triggers are independently enabled). The scheduler checks `routines.status = 'active'` but does not check if the routine was paused during the missed window. The `skip_missed` policy naturally handles this (only current window fires), but `enqueue_missed_with_cap` would attempt to catch up all missed windows since the last tick, even if the routine was paused for days.

**Wait — re-reading evidence:**
Actually, `tickScheduledTriggers` filters by `eq(routines.status, "active")`. So a paused routine's triggers are ignored entirely. When reactivated, the `nextRunAt` is whatever it was before pausing. The first tick after reactivation will find `nextRunAt <= now`. For `skip_missed`, only one run fires. For `enqueue_missed_with_cap`, it catches up from `nextRunAt` to `now`. This means a long pause followed by reactivation with `enqueue_missed_with_cap` could trigger up to 25 runs immediately.

**Severity:** Low — documented behavior; admin-visible in UI.

### 16.3 Webhook triggers have `enabled` and `signing_mode` but no `lastResult` update on auth failure
`lastResult` is only updated when a run is successfully dispatched. If webhook auth fails, `firePublicTrigger()` throws before `dispatchRoutineRun()` is called, so `last_fired_at` and `last_result` are not updated. The operator cannot see failed webhook attempts in the trigger history.

**Severity:** Low — auth failures are logged at server level.

### 16.4 `dispatchFingerprint` includes `executionWorkspaceId` but the open execution unique constraint does not include it
The `issues_open_routine_execution_uq` constraint is on `(companyId, originKind, originId, originFingerprint)`. Since `executionWorkspaceId` is part of the fingerprint, different workspaces for the same routine will have different fingerprints. However, if two triggers (e.g., schedule and webhook) fire with the same fingerprint but different sources, they share the same open execution constraint. This is by design (same work should not be duplicated), but it means `always_enqueue` can still hit the unique constraint and fall back to coalesce behavior.

**Severity:** Low — `always_enqueue` is edge-case; fallback is safe.

---

*No other contradictions identified from current evidence.*
