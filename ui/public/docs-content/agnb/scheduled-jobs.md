---
title: Scheduled Jobs
summary: 35 workers that keep the pipeline warm
---

AGNB runs 35 scheduled jobs that handle the deterministic grind. They fire on their own cadence — from every 30 minutes to daily — and feed the cockpit.

## How jobs work

Each job is registered with a key, an interval, and a handler. Jobs are **idempotent** and self-skip when their required env keys are unset.

```
GET  /api/agnb/jobs                  # scheduler state for all jobs
POST /api/agnb/jobs/:key/run         # run one on demand
POST /api/agnb/jobs/:key/toggle      # enable / disable (?enabled=true)
```

## Default-off side effects

Any job that sends, posts, or spends externally ships **disabled by default**. Enable it deliberately, per instance. Read-only and draft jobs are safe to run on a timer.

## Examples

| Job | Cadence | What it does |
| --- | --- | --- |
| `inbox-sync` | 30m | Pull replies and inbound |
| `negative-signal-watch` | 1h | Flag bad reviews + negative mentions |
| `reviews-sync` | daily | Refresh ratings via SerpAPI |
| `gsc-rank-tracker` | daily | Track keyword rank |
| `hubspot-deals-sync` | hourly | Mirror HubSpot deals |
| `cross-channel-repurpose` | daily | One content gap → blog + LinkedIn + YouTube |
| `bofu-refresh-feedback` | daily | Brief a refresh for slipping money pages |

## Activation by key presence

A job comes alive the moment its key is set as a secret — no setup wizard. See [Integrations](/agnb/integrations).
