---
title: Feature Support Case Assessment — Status Compare-and-Set
summary: Support reference for the Status Compare-and-Set feature (RBR-929/950/951/953)
version: v2026.626.0
commit: 0526be129c
---

# Support Case Assessment: Status Compare-and-Set

## Feature Summary

**Status Compare-and-Set (CAS)** is a database-level concurrency guard for issue status transitions. It ensures that an issue status update only succeeds if the issue is currently in one of the expected statuses. This prevents stale-snapshot writes from silently reverting a completed issue — a bug class known as RBR-864.

### The Problem It Solves

Consider a race condition in the recovery path:

1. The recovery path reads an issue and sees it as `in_progress`
2. It decides the agent's run was lost and prepares to write `blocked`
3. Before the write lands, the run actually completes and commits `done`
4. The recovery path's snapshot-derived write overwrites `done` with `blocked`
5. The completed issue is silently reverted — the work is lost

CAS prevents this by rejecting the stale write with a clear 409 Conflict error.

## User-Facing Behavior

Status Compare-and-Set is a **backend mechanism** — there is no direct UI surface for it. However, its effects are visible in two ways:

1. **API Responses** — When a CAS check fails, the API returns `409 Conflict` with the actual status of the issue. Callers should re-read the issue and retry with the current status.
2. **Data Integrity** — Users never see a completed issue mysteriously revert to an earlier status due to a race condition.

### API Usage

When updating an issue via `PATCH /api/issues/{issueId}`, callers can optionally include CAS fields:

```json
PATCH /api/issues/{issueId}
{
  "status": "blocked",
  "expectedStatus": "in_progress"
}
```

Or with multiple acceptable statuses:

```json
PATCH /api/issues/{issueId}
{
  "status": "done",
  "expectedStatuses": ["todo", "in_progress"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `expectedStatus` | string (optional) | A single status the issue must currently be in for the write to proceed |
| `expectedStatuses` | string[] (optional) | A list of statuses the issue must currently be in for the write to proceed |

Rules:
- If neither field is provided, the write proceeds without CAS protection (except for terminal status regressions, which are always guarded)
- If both are provided, they are merged into a single set of acceptable statuses
- An empty `expectedStatuses` array is rejected with a 422 error
- If the actual status doesn't match, the API returns `409 Conflict` with `details.actualStatus`

### Terminal Status Regression Guard

Independent of the CAS opt-in, **all** writes that would regress a terminal status (`done` or `cancelled`) to a non-terminal status are blocked unless the caller explicitly opts in with `allowTerminalReopen: true`. This prevents accidental reversion of completed issues by callers that don't supply CAS keys.

The two opt-ins are orthogonal:
- **CAS keys** (`expectedStatus`/`expectedStatuses`) prevent stale-snapshot writes between non-terminal statuses
- **`allowTerminalReopen`** prevents accidental reopening of terminal issues

## Known Issues & Limitations

### 1. Opt-In Only

CAS must be explicitly enabled per-write by supplying `expectedStatus` or `expectedStatuses`. Existing callers that don't supply these keys continue to get the previous unguarded behavior (except for terminal regression, which is always guarded).

### 2. Not a Lock

CAS does not prevent the race from happening — it detects and rejects the losing write after the fact. The caller must handle the 409 and retry with the current status.

### 3. Works with Non-Terminal Transitions Only

The CAS guard applies to non-terminal status transitions. Terminal regression is handled by a separate guard (`allowTerminalReopen`).

## Troubleshooting

### API returns 409 Conflict

```
409 Conflict
{
  "error": "Conflict",
  "details": {
    "issueId": "...",
    "actualStatus": "done",
    "expectedStatuses": ["in_progress"]
  }
}
```

This means the issue's current status does not match the expected status(es) you supplied. The issue has moved on from the status you read.

**Resolution:** Re-read the issue to get the current status, then retry your write with the updated `expectedStatus`/`expectedStatuses`.

### API returns 409 with terminal regression error

```
{
  "error": "Conflict",
  "details": {
    "code": "issue_terminal_status_regression"
  }
}
```

This means you attempted to move an issue from `done` or `cancelled` back to a non-terminal status without setting `allowTerminalReopen: true`.

**Resolution:** If you intentionally want to reopen a terminal issue, add `"allowTerminalReopen": true` to your request.

## Support Escalation Path

| Issue | Escalate To |
|-------|-------------|
| CAS permits a stale write (false negative) | CTO — SQL predicate bug in `issuesSvc.update` |
| CAS blocks a legitimate write (false positive) | CTO — CAS logic or status comparison issue |
| 409 errors visible to end users via UI | CTO — UI missing CAS retry logic |
| Terminal regression guard blocks intentional reopen | CTO — `allowTerminalReopen` propagation issue |

## Related Code Locations

- `server/src/services/issues.ts` (lines 5615-5870) — `expectedStatus`/`expectedStatuses` handling and CAS SQL predicate
- `server/src/__tests__/rbr929-update-status-cas.test.ts` — full test coverage for RBR-929 AC1/AC2/AC4, RBR-950, RBR-953
- `server/src/routes/issues.ts` (line 1622) — inline compare-and-set on locked row for recovery path
- `packages/shared/src/constants.ts` — `isTerminalIssueStatus()` helper
