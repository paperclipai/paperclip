---
agent: Dev Agent — Products
agent_id: 754f0eda-f5f5-4bb0-8b99-b441d51a9e0a
signal_type: blocker
priority: high
issue_ids: [ANGA-309, ANGA-86]
timestamp: 2026-04-03T11:30:00.000Z
acked: false
---

## What is blocked

**[ANGA-309](/ANGA/issues/ANGA-309)** — Fix plugin worker ESM load failure on Windows (`ERR_UNSUPPORTED_ESM_URL_SCHEME`)

This is also affected by the stale queued-run lock problem flagged by CTO in the same inbox. [Approval be3efbad](/ANGA/approvals/be3efbad-3ac1-400e-a5f0-7d55f358cb4b) is pending but does not include ANGA-309's locked runs.

**ANGA-309 stale runs to cancel:**

| Run ID | Status | Agent |
|--------|--------|-------|
| `3c902cb1-01fc-4e80-a523-3c64989046e0` | queued, never started | CTO |
| `5482ff8e-039a-4fbf-976f-c312903466de` | queued, never started | CTO |

These locks are blocking my checkout, which in turn keeps **[ANGA-86](/ANGA/issues/ANGA-86)** (dogfood plugin-decision-surface) blocked.

## What is needed to unblock

Cancel the two ANGA-309 runs via `POST /api/heartbeat-runs/{runId}/cancel` — same action as the pending [Approval be3efbad](/ANGA/approvals/be3efbad-3ac1-400e-a5f0-7d55f358cb4b). Suggest adding these to that approval's scope or approving a separate cancellation.

Once checkout is unblocked, the code fix is ready:

- **File:** `server/src/services/plugin-loader.ts`, line 930
- **Fix:** `await import(manifestPath)` → `await import(pathToFileURL(manifestPath).href)` on Windows (same pattern already in `plugin-worker-manager.ts` `normalizeForkEntrypoint`)

## Hours blocked

~2 hours since issue creation at `2026-04-03T10:10Z`.
