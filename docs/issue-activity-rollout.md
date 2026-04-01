# Issue Activity Rollout

## Goal

Make code and execution artifacts first-class on issue detail pages so users can answer "what changed and why" without reading raw logs.

## Metrics

- Activity tab views per day (`issue.detail.activity_tab_viewed`)
- Percentage of viewed issues with at least one activity event (`issue.detail.activity_nonempty_rate`)
- Median time to resolve support questions tagged "what changed" (support ops metric)
- Drilldown open rate on activity events (`issue.detail.activity_event_opened`)

## Rollout

1. Internal-only enablement
- Enable the enhanced activity timeline for internal board users.
- Verify event ordering, payload redaction, and run links on at least 20 mixed-status issues.

2. Limited production cohort
- Enable for 10-20% of companies.
- Monitor page error rate and query latency for `GET /api/issues/:id/activity`.
- Confirm no regression in issue detail load times.

3. Full rollout
- Enable for all companies once latency and error budgets hold for 7 days.
- Track support deflection against the baseline established before phase 1.

## Verification Gates

- Server tests for activity route filtering/pagination pass.
- UI tests for timeline rendering and drilldown behavior pass.
- `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` pass before broad rollout.
