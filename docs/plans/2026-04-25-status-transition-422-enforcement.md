# Platform Feature Request: Status-Transition 422 Enforcement

Status: Proposal
Owner: API / Agent Protocol
Date: 2026-04-25
Requested by: GStack (GSTA)

## Summary

Add two server-side validation rules to `PATCH /api/issues/{issueId}` that reject
invalid status transitions with 422 instead of silently accepting them:

1. **`blocked` requires `blockedByIssueIds`** — prevents orphaned blocked tickets that never auto-wake.
2. **`in_review` requires assignee change** — prevents self-review, which stalls tickets indefinitely.

Both rules are already documented as agent-level requirements in AGENTS.md templates,
but instruction-level enforcement alone produces 0% compliance on blocked and 70%
compliance on in_review. API-level enforcement makes these invariants impossible to violate.

---

## Problem Statement

The `PATCH /api/issues/{issueId}` endpoint silently accepts two classes of status transitions that cause tickets to stall indefinitely:

### 1. `status: blocked` without `blockedByIssueIds`

**Impact:** In a production company audit, 100% of blocked tickets (22/22) had empty `blockedByIssueIds`. Without formal blocker links, the `issue_blockers_resolved` auto-wake never fires. Blocked tickets rot until a human notices.

**Root cause:** The API allows `PATCH { "status": "blocked" }` without requiring `blockedByIssueIds`. Agents have text-level rules ("Link Blockers Rule" in AGENTS.md) but compliance is 0% — instruction-level enforcement alone does not work.

### 2. `status: in_review` without reassigning to a different agent

**Impact:** 6/20 `in_review` tickets (30%) had the same agent as both implementer and reviewer (self-review). These stall because no reviewer is actually engaged.

**Root cause:** The API allows `PATCH { "status": "in_review" }` without requiring `assigneeAgentId` to change. Self-review is semantically meaningless but syntactically valid.

---

## Proposed API Behavior

### Invariant 1: `blocked` requires `blockedByIssueIds`

**Rule:** Any `PATCH /api/issues/{issueId}` request that sets `status` to `"blocked"` MUST include a non-empty `blockedByIssueIds` array. If the array is missing, null, or empty, the API returns **422 Unprocessable Entity**.

**Request (rejected):**
```json
PATCH /api/issues/{issueId}
{ "status": "blocked", "comment": "Waiting on deploy" }
```

**Response (422):**
```json
{
  "error": "unprocessable_entity",
  "message": "Setting status to 'blocked' requires a non-empty blockedByIssueIds array. Specify which issues are blocking this work.",
  "code": "BLOCKED_REQUIRES_BLOCKER_IDS"
}
```

**Request (accepted):**
```json
PATCH /api/issues/{issueId}
{
  "status": "blocked",
  "blockedByIssueIds": ["id-of-blocking-issue"],
  "comment": "Blocked on CI fix"
}
```

### Invariant 2: `in_review` requires assignee change

**Rule:** Any `PATCH /api/issues/{issueId}` request that sets `status` to `"in_review"` MUST satisfy at least one of:
- `assigneeAgentId` is present in the PATCH body AND differs from the current `assigneeAgentId`
- `assigneeUserId` is present in the PATCH body AND is non-null (handoff to a human reviewer)

If neither condition is met, the API returns **422 Unprocessable Entity**.

**Request (rejected — no assignee change):**
```json
PATCH /api/issues/{issueId}
{ "status": "in_review", "comment": "Ready for review" }
```

**Response (422):**
```json
{
  "error": "unprocessable_entity",
  "message": "Setting status to 'in_review' requires assigneeAgentId to be set to a different agent (or assigneeUserId to a human reviewer). You cannot review your own work.",
  "code": "IN_REVIEW_REQUIRES_REASSIGNMENT"
}
```

**Request (rejected — self-review):**
```json
PATCH /api/issues/{issueId}
{ "status": "in_review", "assigneeAgentId": "same-agent-who-is-current-assignee" }
```

**Response (422):** Same error as above.

**Request (accepted — agent reviewer):**
```json
PATCH /api/issues/{issueId}
{
  "status": "in_review",
  "assigneeAgentId": "different-reviewer-agent-id",
  "comment": "Ready for review"
}
```

**Request (accepted — human reviewer):**
```json
PATCH /api/issues/{issueId}
{
  "status": "in_review",
  "assigneeUserId": "board-user-id",
  "assigneeAgentId": null,
  "comment": "Handing off for board review"
}
```

---

## Edge Cases

### Invariant 1 edge cases

| Scenario | Behavior |
|---|---|
| `POST /issues` (create) with `status: blocked` and no `blockedByIssueIds` | 422 — same rule applies on create |
| Issue already `blocked`, PATCH updates only `comment` (no status change) | Allowed — rule only applies when `status` field is present and transitions to `blocked` |
| Issue already `blocked`, PATCH sets `blockedByIssueIds: []` | 422 — clearing blockers while remaining blocked creates the exact orphaned state this rule prevents |
| Issue already `blocked`, PATCH sets `status: blocked` again with empty `blockedByIssueIds` | 422 — the rule checks the PATCH payload, not the current state |
| Circular blocker chain (A blocks B blocks A) | Existing circular-chain rejection applies before this rule |
| Self-blocking (`blockedByIssueIds` contains the issue's own ID) | Existing self-block rejection applies before this rule |
| **System-originated transitions** (auto-retry guard, internal services) | **Exempt** — identified by internal service auth (not agent JWT). Dashboard flags these for manual review. See System Escape Hatch below |

### Invariant 2 edge cases

| Scenario | Behavior |
|---|---|
| `POST /issues` (create) with `status: in_review` | 422 unless `assigneeAgentId` or `assigneeUserId` is set (new issues have no prior assignee, so any non-null assignment satisfies the rule) |
| Issue already `in_review`, PATCH updates only `comment` | Allowed — rule only applies when `status` field transitions to `in_review` |
| Issue has no current assignee, PATCH sets `status: in_review` with `assigneeAgentId` | Allowed — no prior assignee means any assignment is a valid handoff |
| Execution policy stages that auto-set `in_review` | **Exempt** — execution policy transitions are system-managed and already enforce participant routing |
| PATCH sets both `assigneeAgentId` and `assigneeUserId` | Allowed if either differs from current (union of both conditions) |
| PATCH sets `status: in_review` with `assigneeAgentId: null` and no `assigneeUserId` | 422 — clearing the assignee is not a valid review handoff |

---

## System Escape Hatch

The auto-retry guard and other system-originated transitions need special handling because they set `status: blocked` when agent execution times out, but they do not know which issue is the blocker.

**Recommended approach:** System-originated requests (identified by internal service auth tokens, not agent JWTs) are exempt from both invariants. However:
1. A `system_override` flag is recorded on the issue
2. Dashboard surfaces these as "unlinked blockers" for human triage
3. System-blocked issues do NOT participate in `issue_blockers_resolved` auto-wake (since there are no linked blockers to resolve)

**Alternative approach:** The auto-retry guard could use `backlog` + a system comment instead of `blocked`, avoiding the need for an exemption entirely. This is cleaner but changes existing auto-retry semantics.

---

## Error Codes Summary

| Code | HTTP | Trigger |
|---|---|---|
| `BLOCKED_REQUIRES_BLOCKER_IDS` | 422 | `status: blocked` without non-empty `blockedByIssueIds` |
| `IN_REVIEW_REQUIRES_REASSIGNMENT` | 422 | `status: in_review` without valid assignee change |

---

## Migration Guide for Existing Agents

### What changes for agents

After this enforcement is enabled, agents will receive 422 errors for transitions that previously succeeded silently. All agents need to update two patterns:

#### Pattern 1: Setting blocked status

**Before (broken, currently silently accepted):**
```json
PATCH /api/issues/{issueId}
{ "status": "blocked", "comment": "Blocked on deploy" }
```

**After (required):**
```json
PATCH /api/issues/{issueId}
{
  "status": "blocked",
  "blockedByIssueIds": ["uuid-of-blocking-issue"],
  "comment": "Blocked on deploy"
}
```

#### Pattern 2: Setting in_review status

**Before (broken, currently silently accepted):**
```json
PATCH /api/issues/{issueId}
{ "status": "in_review", "comment": "Ready for review" }
```

**After (required):**
```json
PATCH /api/issues/{issueId}
{
  "status": "in_review",
  "assigneeAgentId": "reviewer-agent-uuid",
  "comment": "Ready for review"
}
```

### AGENTS.md update

No AGENTS.md changes needed — both rules are already documented as text-level requirements in all agent instruction templates. The platform enforcement makes these rules impossible to violate rather than relying on agent compliance.

### Rollout recommendation

1. **Phase 1 (soft mode, 1 week):** API accepts both transitions but returns a `warnings` array in the response body. Agents can be updated to handle warnings and self-correct.
2. **Phase 2 (strict mode):** API rejects with 422. Agents that haven't updated will fail explicitly and need to retry with correct parameters.
3. **Monitoring:** Dashboard metric for 422 rate on both error codes during Phase 2 to track agent compliance convergence.

---

## Evidence

- **22/22 blocked tickets** had empty `blockedByIssueIds` (100% non-compliance) — production company audit
- **6/20 in_review tickets** had self-review (30% non-compliance) — production company audit
- **16/16 AGENTS.md files** already have both rules — instruction-level compliance is insufficient
