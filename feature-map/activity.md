# Dashboards, activity, and audit trails

People inspect company health, recent activity, run history, and routine activity, then follow evidence back to the task or agent responsible.

Implementation: [dashboard](../ui/src/pages/Dashboard.tsx), [live dashboard](../ui/src/pages/DashboardLive.tsx), [audit hub](../ui/src/pages/audit/AuditHub.tsx).

## Sub-features

- `overview`: inspect the company dashboard and live-work summary.
- `activity`: filter and page through recorded actor/resource events.
- `runs`: find executions and follow their task/agent context.
- `routine-audit`: inspect routine execution activity separately from its definition.
- `timeline`: use the available timeline view to understand work over time.

## How to get to it (user POV)

### `dashboard`

Open `/dashboard` or `/dashboard/live`.

### `activity-audit`

Open `/activity`, `/activity/runs`, or `/activity/timeline` in the streamlined shell; legacy routes may redirect.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Prepare known task mutations and completed/failed runs in a disposable company, recording their IDs and actors.

### `dashboard`

Automated: [dashboard service](../server/src/__tests__/dashboard-service.test.ts) covers server aggregation; [dashboard helpers](../ui/src/pages/Dashboard.test.ts) is narrower UI helper coverage.

Manual: Compare the dashboard with the known fixture tasks and runs. Start and finish a small task, refresh/reload, and verify the summary changes and links reach the right records. Exercise empty data and a failed fetch.

### `activity-audit`

Automated: [activity service](../server/src/__tests__/activity-service.test.ts), [audit runs](../ui/src/pages/audit/AuditRuns.test.tsx), and [routine audit](../ui/src/pages/audit/RoutineAuditActivity.test.tsx) cover these separate data/host layers.

Manual: Find a known mutation by actor/resource and a known run by status. Change filters, load more, and follow the source links. Reload the chosen view and verify no company leakage or duplicate events. Inspect a routine run from its audit entry.

## Gotchas

- Audit/activity events, run-log rows, first-party Telemetry, and operator OpenTelemetry traces are separate data paths.
- A healthy stream or dashboard counter alone does not prove task success.
- Cost and budget reports have their own [recipe](./budgets-costs.md).
