# 2026-03-31 Flow Hardening Follow-ups

## Objective list from recent flow analysis

1. Reduce duplicate `technical_review_dispatch` tickets for the same PR diff.
2. Reduce noisy `agent_health_alert` reopen/cancel loops for transient failures.
3. Keep the native review dispatcher as the nominal path and keep the coordinator in audit/fallback mode only.

## What was implemented

### 1. Review dispatch now recognizes explicit head SHA in handoff comments

Files:

- `server/src/services/review-dispatch.ts`
- `server/src/__tests__/review-dispatch.test.ts`

Change:

- Handoff comments that include an explicit head marker such as `Head atual: 10215239` are now upgraded to head-based diff identity.
- This makes repeated handoffs for the same PR head reuse the existing review ticket instead of opening a new `technical_review_dispatch` issue.
- The generated review description now includes the head SHA when available, making reconciliation easier to audit.

Expected effect:

- Fewer duplicate review tickets when the PR work product lags behind the handoff comment.
- Better dedup in re-handoff and “same diff, new comment” situations.

### 2. Agent health alerts now use a short reopen cooldown

Files:

- `server/src/services/agent-health-monitor.ts`
- `server/src/__tests__/agent-health-monitor.test.ts`

Change:

- Non-review-queue `agent_health_alert` issues no longer reopen immediately after a transient auto-resolution.
- A short cooldown now suppresses reopen churn for flapping agent/runtime checks.
- Review-queue alerts keep their existing reopen behavior because they represent real workflow backlog rather than transient adapter/runtime instability.

Expected effect:

- Fewer open/cancel/reopen loops for command resolution, bootstrap, timeout, and similar transient agent health findings.
- Lower coordination noise for the `Coordenador`.

### 3. Dashboard observability now exposes the churn that was prevented

Files:

- `server/src/services/agent-health-monitor.ts`
- `server/src/__tests__/agent-health-monitor.test.ts`
- `ui/src/lib/dashboard-observability.ts`
- `ui/src/lib/dashboard-observability.test.ts`
- `ui/src/components/OperationalObservabilityPanel.tsx`
- `ui/src/pages/Dashboard.tsx`

Change:

- The agent health monitor now logs `issue.health_alert_reopen_suppressed` when a transient alert stays closed because the reopen cooldown is still active.
- The dashboard now derives two last-24-hour counters from activity:
  - `Review Dedup (24h)`
  - `Alert Suppressions (24h)`
- This turns dedup and churn suppression into visible operational signals instead of hidden behavior in logs only.

Expected effect:

- Operators can tell whether the runtime is actually preventing duplicate reviews and alert flapping.
- Flow hardening work becomes measurable from the dashboard without reconstructing state from raw issue history.

## Validation

Executed:

- `npx pnpm vitest run server/src/__tests__/review-dispatch.test.ts server/src/__tests__/agent-health-monitor.test.ts ui/src/lib/dashboard-observability.test.ts`
- `npx pnpm -r typecheck`
- `npx pnpm build`

Result:

- Focused test suites passed
- Monorepo typecheck passed
- Monorepo build passed

## Remaining follow-up candidates

These were identified but not changed in this patch:

1. Strengthen review dedup even further for same PR URL when the head SHA is unavailable and the comment does not declare `no new diff`.
2. Continue reducing coordinator-issued manual cleanup by moving more stale-state reconciliations into native self-healing paths.
