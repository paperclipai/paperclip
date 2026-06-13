# Productivity Monitor

Paperclip's productivity monitor watches active agent issues and spawns a review issue when an agent shows signs of stalling, looping, or excessive churn. This document describes how the evaluator works, its triggers, its guard rails, and the metrics it emits.

## When Reconciliation Runs

`reconcileProductivityReviews()` is called on a cron schedule. It scans all `todo`/`in_progress` agent-assigned issues and evaluates each against the configured thresholds.

## Triggers

Each candidate issue is evaluated for three independent triggers. The first matching trigger wins:

| Trigger | Default | Description |
|---|---|---|
| `no_comment_streak` | 10 consecutive terminal runs | The last N completed runs for this issue produced no agent-authored comment. |
| `high_churn` | 10 runs/1h or 30 runs/6h | The agent is cycling through runs too fast relative to comment output. |
| `long_active_duration` | 6 hours | The issue has been in `in_progress` continuously for too long. |

## Review Issue Lifecycle

When a trigger fires, a child review issue is created under the source issue and assigned to the agent's manager (CTO/CEO fallback). The review issue uses `originKind: issue_productivity_review` and an `originFingerprint` keyed to the source issue.

Subsequent reconciliation passes refresh the open review with updated evidence up to `maxRefreshComments` times (default 3) at no more than one refresh per `refreshIntervalMs` (default 1 hour).

If a review is resolved (`done`) within the snooze window (default 6 hours), re-evaluation is suppressed for that window.

A creation cap prevents more than `maxCreationsPerWindow` (default 3) non-cancelled reviews per source issue within `creationWindowMs` (default 24 hours).

## Billing Cascade Guard

### Problem

A shared-account plan-cap exhaustion (e.g., Anthropic `out of extra usage · resets <time>`) causes all agent runs to fail immediately with zero useful output. The no-comment streak and high-churn detectors cannot distinguish this from genuinely unproductive behavior, leading to cascading productivity-review issues.

### Guard Behavior

Before computing streaks, `collectEvidence()` inspects the terminal runs in the sampled window. If the fraction of runs classified as billing/quota errors meets or exceeds `billingCascadeThreshold` (default **0.5**, i.e. 50%), the review is suppressed entirely and no review issue is created.

A run is classified as a billing/quota error if any of the following match:

- `errorCode === "claude_plan_cap_exhausted"` (set by the adapter-side classifier per TAP-979)
- `error`, `stderrExcerpt`, or `stdoutExcerpt` matches one of these patterns:
  - `out of extra usage`
  - `resets <digits>` (e.g., "resets 11am ET")
  - `try again at `
  - `upgrade to pro`
  - `usage limit`
  - `plan…cap` (within 20 chars)
  - `claude_plan_cap_exhausted`

### Suppression Metric

When the guard fires, a structured log entry is emitted at `INFO` level:

```json
{
  "metric": "productivity_review.suppressed_billing_cascade",
  "companyId": "...",
  "issueId": "...",
  "agentId": "...",
  "billingCascadeRatio": 1.0,
  "billingCascadeCount": 10,
  "totalTerminalRuns": 10,
  "billingCascadeThreshold": 0.5
}
```

Search logs for `productivity_review.suppressed_billing_cascade` to audit how often the guard fires.

### Tuning

The threshold is configurable via `thresholds.billingCascadeThreshold` passed to `reconcileProductivityReviews()` or `collectEvidence()`. Valid range is `[0, 1]`; values outside that range fall back to the default.

- Set to `0` to disable suppression (every window triggers a review regardless of billing errors).
- Set to `1` to suppress only when **all** terminal runs are billing errors.
- Default `0.5` means a majority (≥50%) of billing errors suppresses the review.

## Configuration Reference

All thresholds can be overridden per reconciliation call via the `thresholds` parameter:

| Key | Default | Description |
|---|---|---|
| `noCommentStreakRuns` | 10 | Consecutive terminal runs with no comment to trigger. |
| `longActiveMs` | 21600000 (6h) | Active duration in ms to trigger `long_active_duration`. |
| `highChurnHourly` | 10 | Runs or assignee-run comments per 1-hour window. |
| `highChurnSixHours` | 30 | Runs or assignee-run comments per 6-hour window. |
| `resolvedSnoozeMs` | 21600000 (6h) | Snooze window after a review is resolved. |
| `refreshIntervalMs` | 3600000 (1h) | Minimum interval between refresh comments on an open review. |
| `maxRefreshComments` | 3 | Maximum refresh comments before the review stops updating. |
| `creationWindowMs` | 86400000 (24h) | Rolling window for the creation cap. |
| `maxCreationsPerWindow` | 3 | Max non-cancelled reviews per source issue per window. |
| `billingCascadeThreshold` | 0.5 | Billing-error fraction needed to suppress the review. |

## Soft-Stop Holds

For `no_comment_streak` and `high_churn` triggers, the runtime can hold a new heartbeat from starting if an open review exists for the same issue. Long-active reviews do **not** hold continuations. Check `isProductivityReviewContinuationHoldActive()` before queuing a retry.
