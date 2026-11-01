# Dashboards, activity, and audit trails — agent access

Product map: [Dashboards, activity, and audit trails](../feature-map/activity.md).

Feature ID: `activity`.

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `overview`

Capability ID: `activity/overview`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/dashboard`.

Agent access: `available` — REST / native call_api / CLI dashboard.

Policy: Same company plus visibility/audit/cost/run permissions where the route requires
them.

Evidence: `source-only` — [implementation](../../server/src/routes/activity.ts#L224) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Dashboard data is accessible; live-work rendering and event streaming are separate
surfaces.

## `activity`

Capability ID: `activity/activity`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/activity`.
- `GET /api/issues/{id}/activity` (UUID or issue identifier).
- `GET /api/companies/{companyId}/audit/agent-actions?actorScope=all&entityType=case&entityId={caseRef}`
  (case UUID or identifier).

Agent access: `partial` — REST / native call_api / CLI activity for company
activity. Sandbox agents can use GET issue activity through the default
[callback bridge](../../packages/adapter-utils/src/sandbox-callback-bridge.ts).
The bridge still rejects company activity and company audit routes.

Policy: Company activity requires same-company access and `company_scope:read`,
with issue visibility filtering. Issue activity requires same-company resource
access and `issue:read` for the resolved issue. The sandbox transport does not
replace those controller checks or permit activity writes.

Evidence: `source-only` — [activity routes](../../server/src/routes/activity.ts),
[agent authorization tests](../../server/src/__tests__/activity-routes.test.ts),
and [bridge tests](../../packages/adapter-utils/src/sandbox-callback-bridge.test.ts).
Issue activity transport reviewed at `89770ba707fb1ebd4cabd184eec2e7fee226e0c3`;
other operations retain the baseline source review above.

Verification: `not-run` — no live agent-credential proof. Local route and bridge
regressions pass: permitted agent issue read, denied company/resource scope,
denied writes, extra path segments, and company audit routes. With a real
sandbox agent, read an authorized issue's activity, then verify denial for an
inaccessible issue, another company, and company-wide audit.

Gaps: Audit export and raw activity creation have extra restrictions; do not
equate them with issue activity reading. Live sandbox access remains unverified.

Working-tree case history update (2026-10-20): the all-actors Audit endpoint
accepts case resource/action/date filters for ordinary company readers who can
read those cases. Agent, responsible-person and run attribution filters still
require `audit:view_agent_actions`; the basic tier still strips those fields and
details. `case_events` mutations lacking an activity-log counterpart are merged
with logged case events before the retained-source permission predicate and
cursor limit. Case snippets are enriched only after that filter. Missing,
inaccessible and other-company cases return no rows; exact identifiers are
case-insensitive. The raw company activity API remains its existing stored-log
view.

Local verification: real temporary-Postgres
[audit route regressions](../../server/src/__tests__/agent-action-audit-routes.test.ts)
cover historical creation/fields, UUID/identifier filters, one-row cursor
pagination, hidden private sources, and duplicate handoff suppression. This is
local transport/database evidence, not a deployed agent run or a sandbox bridge
qualification.

## `runs`

Capability ID: `activity/runs`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/heartbeat-runs`.
- `GET /api/companies/{companyId}/live-runs`.
- `GET /api/heartbeat-runs/{runId}`.
- `GET /api/heartbeat-runs/{runId}/events`.
- `GET /api/heartbeat-runs/{runId}/log`.
- `GET /api/heartbeat-runs/{runId}/workspace-operations`.
- `GET /api/heartbeat-runs/{runId}/issues`.
- `GET /api/issues/{id}/runs`.
- `GET /api/issues/{id}/recovery-actions`.

Agent access: `available` — REST / native call_api / CLI run. Sandbox agents can
use these diagnostic GET paths through the default queue and HTTP/2
[callback bridge](../../packages/adapter-utils/src/sandbox-callback-bridge.ts).
Use the injected run credential; see the [bounded read workflow](../../skills/paperclip/references/run-diagnostics.md).

Policy: Same-company and `company_scope:read` checks apply to company run
inventory. Run content requires run/task visibility; private run list entries
may be redacted stubs. Task run/recovery reads require `issue:read`. Run-linked
tasks also pass the caller's task-read SQL predicate individually, including
activity links and the original task. Existing credential redaction remains.
Bridge admission grants no cancellation, retry, recovery resolution or
provider-trace administration authority.

The recovery-actions GET also accepts `inspectSourceRunId` and optional
`inspectSourceActionId`. The explicit path requires the same readable task and
exact company/task/run/action binding, including resolved retained actions.
Run-only selection lists at most 20 actions; action selection observes current
recorded-source identity with an eight-lease ceiling. This path does not run
read revalidation, mutate recovery/Retry state, call providers or inspect files.
Only closed reason/policy values supplement the existing recorded failure;
the observation is neither historical cause nor permission to execute. Local
[HTTP/database regressions](../../server/src/services/workspace-recovery-source.test.ts)
cover exact selection, foreign action denial, reused allocations, redaction,
bounded lookup and unchanged persisted state. Deployed agent use is unverified.

Evidence: `source-only` — scoped review of `f10210990a3c9cad1a4359318388f237de3169dd`:
[run routes](../../server/src/routes/agents.ts),
[task links](../../server/src/routes/activity.ts),
[task filtering](../../server/src/services/activity.ts),
[bridge regressions](../../packages/adapter-utils/src/sandbox-callback-bridge.test.ts),
[HTTP/2 transport regressions](../../packages/adapter-utils/src/http2-bridge-server.test.ts),
and [private-run regressions](../../server/src/__tests__/heartbeat-run-privacy-routes.test.ts).

Verification: `not-run` for a deployed sandbox agent with these new routes.
Isolated regressions cover admitted GETs, denied writes/extra segments, query
forwarding, controller denials, private run stubs, and mixed public/private task
links. They do not qualify a live run. After deployment, use a real agent run to
read an authorized failure and assert denial/redaction for another company,
private tasks and restricted key modes. Do not count a skipped database suite
as successful verification.

Gaps: Telemetry/run visibility is checked independently from seeing the source task.
Company heartbeat history defaults to 200 rows and caps explicit limits at 1,000
in both the route and service. The response remains an array. Scope, visibility,
and secret redaction checks apply to the bounded result set.
Live updated-bridge admission and useful incident diagnosis remain unverified.

## `routine-audit`

Capability ID: `activity/routine-audit`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/routines/{id}/runs`.

Agent access: `available` — REST / native call_api / CLI routine runs.

Policy: Same company plus visibility/audit/cost/run permissions where the route requires
them.

Evidence: `source-only` — [implementation](../../server/src/routes/activity.ts#L224) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Routine execution history is distinct from configuration revisions and scheduling
changes.

## `timeline`

Capability ID: `activity/timeline`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/timeline`.

Agent access: `available` — REST / native call_api.

Policy: Same company plus visibility/audit/cost/run permissions where the route requires
them.

Evidence: `source-only` — [implementation](../../server/src/routes/activity.ts#L224) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: API exists; no dedicated timeline tool is necessary for this requirement.

## `agent-commentary`

Capability ID: `activity/agent-commentary`.

Review: `baseline`.

API: `present` — `GET /api/companies/{companyId}/agent-commentary` and
`GET /api/companies/{companyId}/agent-commentary/{id}`.

Agent access: `restricted` — the browsing API is board-only. Agent submission
continues through the existing POST and native submit tools.

Policy: Company membership, `commentary:view`, and source-task visibility. All human company roles,
including viewers, receive the permission by default, with an upgrade grant for existing active human members.
Human invitation approval adds the default to older saved grant lists without widening existing scopes.
Agent-action audit access remains separate. Counts and previews
use the same visibility predicate as full messages; cross-company IDs return 404.
Feedback stays hidden after source-task deletion, even when its task foreign key clears.

Evidence: `source-only` — [routes](../../server/src/routes/agent-commentary.ts) and
[reader](../../server/src/services/agent-commentary-reader.ts).

Verification: `not-run` for a deployed instance. Test list/detail denials with
agent credentials, another company, and an unreadable task.

Gaps: Storybook simulates the API and does not qualify deployed authorization.
