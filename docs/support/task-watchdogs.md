---
title: Feature Support Case Assessment — Task Watchdogs
summary: Support reference for the Task Watchdog feature (shipped v2026.626.0)
version: v2026.626.0
commit: 0526be129c (server-side CAS updates)
---

# Support Case Assessment: Task Watchdogs

## Feature Summary

Task Watchdogs let you attach an automated monitoring agent to a task. The watchdog agent watches the issue subtree (the issue and its children) and:

- Periodically evaluates whether the subtree is making progress
- Flags **stopped subtrees** — issues where no active work is happening, no runs are queued, and no pending approvals/interactions exist
- Generates a review issue when work stalls
- Does not re-trigger if the same stopped state was already reviewed (fingerprint-based dedup)

## User-Facing Behavior

### Setting Up a Watchdog

- A watchdog is configured on any issue via the issue detail page
- You select a watchdog agent (must be an active agent in the company)
- Optional: provide instructions for the watchdog (e.g., "check for stalled PRs" or "alert if the API is down")
- The watchdog agent is assigned to monitor the issue and its entire subtree

### Watchdog Lifecycle

| State | Meaning |
|-------|---------|
| `active` | Watchdog is enabled and evaluating |
| `disabled` | Watchdog is paused |

### What the Watchdog Does

1. **Evaluates the subtree** — walks the issue tree from the watched issue downward
2. **Classifies the state** as one of:
   - `live` — subtree has active runs, pending interactions, or approvals in progress
   - `stopped` — subtree is idle with no pending work; creates a review issue
   - `already_reviewed` — same stopped state was already reviewed; no new issue
   - `not_applicable` — watched issue is missing or is itself a watchdog origin issue
   - `pending_first_run` — issue was created recently, first run may not have started yet
3. **Creates a review issue** when a `stopped` state is first detected
4. **Does not re-create** the review issue if the same fingerprint re-appears

### Watchdog Fingerprint

The watchdog uses a SHA-256 fingerprint of the stopped leaves to avoid re-creating review issues for the same state. If the state changes (e.g., a child issue is added or resolved), the fingerprint changes and a new review may be created.

## Known Issues & Limitations

### 1. Grace Window for First Runs

A newly created or assigned issue has a **15-second grace window** (`TASK_WATCHDOG_FIRST_RUN_GRACE_MS`) during which the watchdog suppresses a `stopped` verdict. This prevents false positives when the issue's first assignment run has been enqueued but is not yet visible. If the issue genuinely has no work started after the grace window, the watchdog will flag it.

### 2. Depth Limit

The watchdog subtree traversal is capped at **100 levels deep** (`TASK_WATCHDOG_SUBTREE_MAX_DEPTH`). Deeper subtrees are not evaluated. This is an architectural safeguard against infinite loops.

### 3. Watchdog Origin Issues Can't Be Watched

Issues with `originKind === "task_watchdog"` (i.e., review issues created by the watchdog itself) cannot themselves have watchdogs attached. This prevents infinite watchdog loops.

### 4. Periodic Reconciliation

The watchdog runs periodically via a reconciler. There is a small delay between when work stalls and when the watchdog detects it. The delay is bounded by the reconciler's tick interval.

### 5. Watchdog Does Not Escalate

The watchdog flags stopped subtrees by creating a review issue, but it does not automatically escalate or notify operators outside of the issue thread. Operators should monitor watchdog review issues or set up their own notification workflows.

## Troubleshooting

### Watchdog is not creating review issues

1. Check if the watchdog is `active` (not `disabled`)
2. Check if the subtree has any active runs, queued wake requests, pending interactions, or pending approvals — these suppress the `stopped` verdict
3. Check if the same stopped state was already reviewed (fingerprint match)
4. Check if the issue was created within the last 15 seconds (grace window)
5. Check if the subtree exceeds 100 levels deep

### Watchdog is creating too many review issues

1. This should not happen for the same stopped state — the fingerprint guard prevents duplicates
2. If the stopped state changes (e.g., a child issue is resolved and a new one stalls), a new review is expected
3. If the watchdog agent is cycling between active and stopped, check for transient state changes

### Watchdog agent is not running

1. Verify the watchdog agent is `active` (not paused/terminated/error)
2. Verify the watchdog agent has a heartbeat interval configured
3. Check the watchdog agent's heartbeat logs for errors

## Support Escalation Path

| Issue | Escalate To |
|-------|-------------|
| Watchdog creates review issues for active work | CTO — false positive in classifier |
| Watchdog misses stopped subtrees | CTO — false negative in classifier |
| Watchdog agent crashes or errors | CTO — agent heartbeat failure |
| Fingerprint collisions produce duplicate reviews | CTO — hash collision in fingerprint logic |
| Depth limit reached for legitimate deep subtrees | CTO — increase `TASK_WATCHDOG_SUBTREE_MAX_DEPTH` |

## Related Code Locations

- `server/src/services/task-watchdogs.ts` — main watchdog service
- `server/src/services/task-watchdog-scope.ts` — watchdog scope/origin enforcement
- `packages/shared/src/types/issue.ts` — `IssueWatchdogSummary` type
- `packages/shared/src/constants.ts` — watchdog origin kinds