# Dashboard usage analytics time selector

Date: 2026-08-27
Surface: Dashboard → Usage quota

## Change

The dashboard usage panel now lets operators select the credential-usage
period independently from the live provider quota windows:

- Month to date
- Last 24 hours
- Last 7 days
- Last 30 days
- Last 90 days

The selected period drives the credential token, billed-spend, API-value,
cache, run-count, output-share, and top-model metrics. The panel also shows a
token-mix visualization for fresh input, cached input, and output tokens. The
Refresh data action refreshes both the live quota windows and the selected
usage ledger.

Live quota windows remain provider-reported windows and are not changed by the
usage-period selector; this distinction is shown in the panel copy.

## UX details

- The selector is keyboard accessible and has a visible `Usage period` label.
- Previous usage data remains visible while a new period is loading, with an
  `updating usage` state rather than a blank panel.
- Empty and unavailable usage states are explicit and do not hide live quota.
- The analytics strip is responsive: it becomes a stacked layout on small
  screens and keeps the per-credential quota details below it.

## Verification

- `DashboardQuotaCard.test.tsx`: focused render coverage passes.
- `pnpm -C ui typecheck`: passes.
- `pnpm -r typecheck`: passes.
- `pnpm build`: passes.
- Staging was deployed from `f6625d7a4`; `/api/health` returned HTTP 200 with
  bootstrap ready. Agent-browser confirmed all five selector options, period
  changes, the selected-period analytics, and the paired Refresh data requests
  (`quota-windows?refresh=true` and `usage?days=30`) returning HTTP 200.
- Production was deployed from
  `deploy/paper-prod-20260827-f6625d7a4` (`f6625d7a4`). The managed deployment
  completed successfully; after the normal container warm-up,
  `/api/health` returned HTTP 200 with bootstrap ready. Agent-browser confirmed
  the five selector options, `usage?days=7` returning HTTP 200, both paired
  Refresh data requests returning HTTP 200, populated token-mix/top-model/cache
  analytics, and no page errors.
- `pnpm check:token-gates` remains blocked by pre-existing repo-wide UI token
  debt; no new dashboard violations were reported by that check.
