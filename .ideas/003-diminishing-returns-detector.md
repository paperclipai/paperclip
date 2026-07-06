# 003 — Diminishing-Returns Detector

## Suggestion

Watchdogs (`task-watchdogs.ts`, `issue-liveness.ts`, `run-liveness.ts`) catch runs that are
**stuck or crashed**. They do not catch runs that are **busy but unproductive** — an agent
that keeps waking up, burns tokens, and makes no real progress on the same issue (the
classic autonomous-agent failure mode: re-reading the same files, re-proposing the same
plan, looping on a failing test). This is the most expensive failure because it *looks*
healthy.

Add a **Diminishing-Returns Detector** that flags an agent thrashing on an issue with no
state change, auto-pauses it, and escalates to a human (or its manager agent) instead of
letting it quietly spend.

## How it could be achieved

1. **Progress signal per issue.** Define a lightweight "progress fingerprint" updated on
   each run: issue status, comment/work-product count, diff size, sub-issue count. Store
   the last K fingerprints per issue (small table or reuse run metadata).
2. **Stall heuristic.** If the last N runs on an issue produced (a) no status change,
   (b) no new work products, and (c) cumulative cost over a threshold, mark the issue
   `diminishing_returns`. The recovery classifiers in `server/src/services/recovery/`
   and `recovery-classifiers.test.ts` are the natural home for this rule.
3. **Action.** On trip: pause further auto-wakeups for that issue, post an explanatory
   comment ("paused after 5 runs / $2.10 with no progress"), and raise an inbox item
   routed to the assignee's manager via the existing approval/review handoff path.
4. **Tunable.** Per-company thresholds (runs, spend, time) so cheap exploratory work isn't
   prematurely killed.
5. **Optional escalation ladder.** First trip → notify manager agent; second → notify
   human board. Reuses the org chart for routing.

## Perceived complexity

**Medium.** No new runtime or scheduler — it's an analyzer that reads existing run/issue
history plus a pause action that hooks the existing wakeup-suppression path. The real
design effort is the heuristic: tuning it so it catches genuine loops without killing slow-
but-legitimate work. Worth shipping behind a default-on-but-conservative threshold and
iterating from real telemetry.
