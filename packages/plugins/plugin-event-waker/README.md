# @paperclipai/plugin-event-waker

In-process replacement for the bash `paperclip-event-waker.sh` poller.

## What it does

Subscribes to `issue.updated` events and wakes the assignee whenever an issue
transitions to an actionable state — `todo`, `in_progress`, `in_review`,
`blocked` — or is reassigned while in one of those states.

## Why

The previous external poller had three problems:

1. **Polling latency** — checks every 10s, so the average wake delay was ~5s on
   top of curl + jq overhead.
2. **Process fragility** — the bash daemon hangs on slow API calls and dies on
   its first unhandled error; no auto-restart unless you babysit the PID.
3. **Per-company config** — the bash script takes one company UUID; running
   against multiple companies needs N daemons.

This plugin replaces it with an in-process event subscription. No polling, no
PIDs, structured logging, per-instance config.

## Configuration

`instanceConfigSchema` accepts:

- `wakeOnTransitions` — array of `"<prev>:<curr>"` patterns. `"*"` matches any
  side. Defaults match the bash script's wake list.
- `debounceMs` — collapse a burst of state changes on the same issue into a
  single wake. Defaults to 500ms.
- `optOutAgentIds` — agents that should never be auto-woken (e.g. agents on
  long backoff).

## Capabilities

- `events.subscribe` — to listen to `issue.updated`.
- `issues.read` — to read assignee from the event payload.
- `issues.wakeup` — to fire the wake.

## Equivalence to the bash poller

| `prev_status:curr_status` | bash | plugin |
|---|---|---|
| `*:todo`, `*:in_progress`, `*:in_review`, `*:blocked` | yes | yes |
| `blocked:todo`, `blocked:in_progress` | yes | yes |
| `*:done` | NO | NO |
| Reassignment with status ∈ actionable | yes | yes |

The plugin's defaults are functionally identical to the bash script.
