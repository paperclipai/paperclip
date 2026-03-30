---
title: Stale-issue monitor
summary: Scheduled stale detection, daily grouping, and rollback
---

## Overview

When **Stale-issue monitor** is enabled under **Instance Settings → Experimental**, the server evaluates open issues on every heartbeat scheduler tick (same cadence as heartbeats and routine schedules). An issue is **stale** when its `updatedAt` is older than the idle threshold for its priority.

## Defaults

| Priority | Idle threshold |
|----------|----------------|
| Critical | 24 hours |
| High     | 48 hours |
| Medium   | 72 hours |
| Low      | 168 hours (7 days) |

Thresholds are configurable in the Experimental UI (hours, 1–8760).

## Outputs

- **Critical / high:** Structured `warn` logs plus one activity entry per issue per UTC day (`stale_issue.priority_alert`).
- **Daily (after 06:00 UTC):** One activity per company with groups by owner × status (`stale_issue.daily_report`), sorted by worst idle time.

Open issues are those in `backlog`, `todo`, `in_progress`, `in_review`, or `blocked`, excluding hidden, completed, or cancelled issues.

## Rollback

1. Open **Instance Settings → Experimental**.
2. Turn **Stale-issue monitor** off. The next tick skips scanning; no server restart is required.

## Operations notes

- The monitor shares the heartbeat scheduler (`HEARTBEAT_SCHEDULER_ENABLED`, default on). If the scheduler is disabled globally, stale detection does not run.
- Daily reports are emitted at most once per UTC calendar day after 06:00 UTC when at least one stale issue exists.
