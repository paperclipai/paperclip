---
navigation: {"section":"Oversight and operation","sectionOrder":70,"order":20}
---

# Dashboards and audit trails

People inspect company health, recent activity, run history, and routine activity, then follow evidence back to the task or agent responsible.

Feature ID: `activity`.

Implementation: [dashboard](../../ui/src/pages/Dashboard.tsx), [live dashboard](../../ui/src/pages/DashboardLive.tsx), [audit hub](../../ui/src/pages/audit/AuditHub.tsx).

Agent access: [companion](../agent-access-map/activity.md).

## Sub-features

- `overview`: `activity/overview` — inspect the company dashboard and live-work summary.
- `activity`: `activity/activity` — filter and page through recorded actor/resource events.
- `runs`: `activity/runs` — find executions and follow their task/agent context.
- `routine-audit`: `activity/routine-audit` — inspect routine execution activity separately from its definition.
- `timeline`: `activity/timeline` — use the available timeline view to understand work over time.
- `agent-commentary`: `activity/agent-commentary` — browse attributed agent suggestions and complaints.

## How to get to it (user POV)

### `dashboard`

Open `/dashboard` or `/dashboard/live`.

### `activity-audit`

Open `/activity`, `/activity/runs`, or `/activity/timeline` in the streamlined shell; legacy routes may redirect.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Prepare known task mutations and completed/failed runs in a disposable company, recording their IDs and actors.

### `dashboard`

Automated: [dashboard service](../../server/src/__tests__/dashboard-service.test.ts) covers server aggregation; [dashboard helpers](../../ui/src/pages/Dashboard.test.ts) is narrower UI helper coverage.

Manual: Compare the dashboard with the known fixture tasks and runs. Start and finish a small task, refresh/reload, and verify the summary changes and links reach the right records. Exercise empty data and a failed fetch.

### `activity-audit`

Automated: [activity service](../../server/src/__tests__/activity-service.test.ts), [audit runs](../../ui/src/pages/audit/AuditRuns.test.tsx), and [routine audit](../../ui/src/pages/audit/RoutineAuditActivity.test.tsx) cover these separate data/host layers.

Manual: Find a known mutation by actor/resource and a known run by status. Change filters, load more, and follow the source links. Reload the chosen view and verify no company leakage or duplicate events. Inspect a routine run from its audit entry.

On a native workspace export failure's run page, choose **Inspect recovery**,
then **Inspect current source** on the matching action. Compare the recorded
failure with the current recorded-source identity. Inspection is read-only and
does not confirm provider termination or file preservation. Resolved retained
actions remain inspectable. The control makes no inspection request until used.
[Source/HTTP regressions](../../server/src/services/workspace-recovery-source.test.ts)
cover current identity, rejected policy, foreign/reused allocation, bounded
lookup, redaction and unchanged recovery state; [component regressions](../../ui/src/components/RunWorkspaceRecoverySurface.test.tsx)
cover explicit selection, loading, failure and identity-only success. These
checks do not establish recovery of a deployed task.

Case detail's **View in Audit** opens `/activity?entityType=case&entityId=<case UUID>`.
The Activity filters include **Cases** actions and **Case** entities; the Case
search accepts a UUID or human identifier such as `CAS-C1` (Enter or blur applies
the search). Scoped history names and links the case, and agent actors use their
real avatars. Historical creation, field, status, link, attachment and label
events from `case_events` appear alongside the already recorded handoffs and
document events, without duplicating those mirrored records. Combined history
passes retained case access before cursor pagination.

Focused regressions: [Audit feed](../../ui/src/pages/audit/AuditFeed.test.tsx),
[Audit routing](../../ui/src/pages/audit/AuditHub.test.tsx), and
[Postgres audit routes](../../server/src/__tests__/agent-action-audit-routes.test.ts).
These prove the component/API boundaries separately; follow the case-to-Audit
link in the actual app to verify the assembled journey.

Issue activity is also available through `GET /api/issues/{id}/activity`.
[Agent authorization](../../server/src/__tests__/activity-routes.test.ts) and
[sandbox bridge](../../packages/adapter-utils/src/sandbox-callback-bridge.test.ts)
regressions cover this route separately from company-wide audit. Live sandbox
agent access remains unverified; use the companion recipe.

Audit-event Load more and run listings differ: Runs currently loads at most 200
entries without pagination. The tested RoutineAuditActivity component has no
registered activity-route host; inspect execution links actually offered by
the routine rather than treating that component test as a reachable journey.

### `agent-commentary`

Open Audit → Commentary (`/activity/commentary`). Search message text, filter by agent and suggestion/complaint,
page through 50-message previews, and open a row to read the full message with its task/run links.
Filters, page offsets and the selected entry are retained in the URL. Read access requires board company access and
`commentary:view`, granted by default to all human company roles and backfilled for existing active
human members. Task privacy applies to previews, counts and full messages; agent-action audit access is separate.
All Audit tab destinations resolve in both the classic and streamlined layouts.

Storybook: [production page and message journeys](../../ui/storybook/stories/activity/agent-commentary.stories.tsx)
covers populated, filtered, long-message, paginated, empty, loading, failed, denied,
linked-message, mobile and light states using synthetic API fixtures. These examples do
not prove live database filtering or authorization.

## Gotchas

- Audit/activity events, run-log rows, first-party Telemetry, and operator OpenTelemetry traces are separate data paths.
- A healthy stream or dashboard counter alone does not prove task success.
- Cost and budget reports have their own [recipe](./budgets-costs.md).

### Storybook verification

#### `runs`

Capability ID: `activity/runs`.

Scope: ui
Storybook: Mount AuditRuns selected status/agent/routine, linked task/agent, empty/loading/error/retry and 200-entry limit. Do not invent pagination.
Production: GET /companies/{id}/heartbeat-runs and /routines/{id}/runs require company/read/privacy checks; real browser follows context links and confirms the referenced execution.
Company run history defaults to 200 rows and caps explicit limits at 1,000.
Summary contexts omit stored prompts and expand JSON once per returned row.
The array response and run visibility/redaction checks remain in place.
Agent detail links resolve older runs by ID outside the recent history page.
Sources: Source: [AuditRuns.tsx](../../ui/src/pages/audit/AuditRuns.tsx), [heartbeats.ts](../../ui/src/api/heartbeats.ts), [routines.ts](../../ui/src/api/routines.ts). Tests: [AuditRuns.test.tsx](../../ui/src/pages/audit/AuditRuns.test.tsx), [heartbeat-run-privacy-routes.test.ts](../../server/src/__tests__/heartbeat-run-privacy-routes.test.ts), [routines-service.test.ts](../../server/src/__tests__/routines-service.test.ts)
