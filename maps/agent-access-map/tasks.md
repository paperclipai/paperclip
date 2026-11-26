# Task creation and lifecycle — agent access

Product map: [Task creation and lifecycle](../feature-map/tasks.md).

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `create`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/issues`.

Agent access: `available` — Native create_task; REST / CLI / MCP.

Policy: Company/task visibility, assignment/change policy, active-run checkout ownership
and lifecycle rules. Ordinary Board comments preserve queued/running retries;
only a parked retry can be superseded. Explicit Stop/Interrupt retain their
existing actor and execution authority. Agent comment tools do not acquire Board
identity or cancellation authority through this behavior.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Creation is implemented; agent/user assignment and attachments may need
narrower/different APIs.

## `organize`

`GET /api/companies/{companyId}/issues/summaries?ids=...` reads up to five exact
UUIDs and returns only navigation summaries. Normal company and task-read
permissions apply to ordinary agent REST calls; task-bridge keys are denied.
Hidden, missing, foreign and private inaccessible IDs are omitted without an
existence disclosure. No dedicated CLI/native tool is added. Embedded database
route tests cover same-company agent access and company/task-bridge denials;
this does not establish a live native `call_api` journey.

The issue-list API accepts optional `includeAgentCreatedTasks`; false restricts
independent results to human creation before search/pagination. Omission retains
existing agent/API behavior. `includeParticipatedTasks=true` requires a board user
and retains only that authenticated user's existing participation as a creation
visibility exception. Company/private-task access checks still apply. Collection
preferences and hierarchy presentation are browser state, not additional authority.
Source-reviewed behavior; live agent access verification remains separate.

All `chat_channel` origins count as bot-created for creation visibility, including
human-initiated conversations. Existing inbox participation remains independent.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/issues`.

Agent access: `available` — Native search_tasks; REST / CLI; UI grouping/navigation
state separately.

Policy: Company/task visibility, assignment/change policy, active-run checkout ownership
and lifecycle rules.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Search/filter API exists; sorting/grouping/presentation defaults are not
necessarily shared server preferences.

## `properties`

Review: `baseline`.

Agent REST callers can promote a prepared backlog task with
`PATCH /api/issues/{id}` and exactly `{ "status": "todo", "expectedStatusVersion": N }`.
The optional nonnegative integer version comes from the current task response.
The server checks both the version and backlog state under the task row lock;
status or ownership changes, including changes back to their earlier values,
return `409` without promoting or waking the task. Mixed mutation fields return
`422`. Existing company, task, assignment and run authority still apply.
Route and real-PostgreSQL service tests cover the contract; no live agent journey
or dedicated native tool is claimed.

API: `present` — representative operation IDs:

- `PATCH /api/issues/{id}`.
- `PUT /api/issues/{id}/title`.

Agent access: `available` — Native set_task_title/reassign_task/set_dependencies and
set_task_monitor; `call_api` for REST-authorized fields; agent REST. Monitor
scheduling is a dedicated native tool, not a generic `call_api` operation.

Policy: Company/task visibility, assignment/change policy, active-run checkout ownership
and lifecycle rules. A legacy run can assign its own task to a human without
cancelling itself only with its signed run token and matching active run, agent,
company and task. The outgoing run cannot mutate its human-owned task afterward,
including through a late update already admitted before the handoff. Agent keys,
native runs, board reassignment and transfers to
another agent retain verified-stop requirements.

Native monitors require standard work mode and an agent-owned task in progress
or review. The responsible user's current permissions also apply. A malformed
request is rejected before mutation; bounded schema guidance lets the provider
correct it without exposing submitted values. Receipt replay never re-arms a
consumed schedule.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability. Focused route
regressions in [ownership tests](../../server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts)
cover a human handoff and stop enforcement for other actors, runtimes and targets;
they use mocked services and do not claim live execution proof.

Queue and HTTP/2 sandbox callbacks admit `GET /api/issues/{id}/diagnostics/wakes`
and `POST /api/issues/{id}/monitor/check-now`. The controller still checks task
read access or monitor-management permission and assignment ownership. Recovery
resolution and scheduled-retry controls remain outside this bridge surface.

Monitor verification: submit flat scheduling fields, observe the schema rejection
and unchanged task, then retry with the nested `monitor` object and the same
idempotency key. Inspect the saved schedule and audit, yield, and verify exactly
one `issue_monitor_due` wake. [Scheduler integration coverage](../../server/src/__tests__/issue-monitor-scheduler.test.ts)
uses real PostgreSQL, the native tool authority, and the heartbeat scheduler with
a no-op process agent. It does not prove live model recovery.

Monitor deferral diagnostics: an unresolved execution-recovery hold keeps a due
schedule intact and prevents execution. Read `issue.monitor_deferred` activity
for the safe blocker cause; unexpected dispatch failures record
`issue.monitor_dispatch_failed`. Repeated identical diagnostics are throttled for
five minutes. The scheduler regression proves that a held source does not replay
and that clearing the hold permits one later wake. This is local PostgreSQL
evidence, not live provider recovery.

Gaps: Dedicated tools differ in scope and fields. Generic `call_api` forwards
status, assignment and dependency fields to existing route authorization.

## `discussion`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/issues/{id}/comments`.
- `POST /api/companies/{companyId}/issues/{issueId}/attachments`.

Agent access: `available` — Native report_progress/comment_on_task/register_deliverable;
REST / CLI / MCP.

Policy: Company/task visibility, assignment/change policy, active-run checkout ownership
and lifecycle rules.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Other-task comments and active-task progress have separate scopes. Generic
`call_api` forwards explicit reopen/resume/interrupt fields to the existing route
checks; it cannot impersonate a user.

## `completion`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/issues/{id}`.

Agent access: `available` — Native paperclip_finish/paperclip_block through runner
protocol; agent REST / native `call_api` disposition under route permissions.

Policy: Company/task visibility, assignment/change policy, active-run checkout ownership
and lifecycle rules.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: The server governs whether a reported result becomes done/review/blocked.
Generic lifecycle PATCH uses existing REST authorization, checkout and approval rules.
