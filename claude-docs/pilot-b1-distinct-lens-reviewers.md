# Pilot B1 — Distinct-Lens Parallel Code-Review Gates

**Branch:** `pilot/b1-dogfood`
**Commit:** `234c4c8c`
**Scope:** `server/src/services/plan-gates.ts`, `server/src/services/plans.ts`, `server/src/routes/issues.ts`, `server/src/onboarding-assets/code-reviewer/AGENTS.md`, tests

---

## Problem

HIVA-17 audit surfaced two gaps the agent gate chain missed that a thorough human review caught:
- No pagination / unbounded list query (scalability)
- Missing board-actor test coverage (test_coverage)

Both the MyHive dev_team chain AND the `/dev-roles` generalist reviewer missed both gaps. The
root cause: one reviewer context covers all nine dimensions → correlated blind spots. When the
reviewer's attention is spread across 9 dimensions, subtle scalability issues or coverage gaps
get under-weighted.

---

## Fix: Per-lens isolation

Instead of one generalist code-review gate, `dev_team` plans now get **three isolated code-review
gates** — one per lens:

| Lens | Catches |
|---|---|
| `scalability` | Unbounded queries without `LIMIT`/cursor; N+1 patterns; missing pagination; index coverage gaps |
| `test_coverage` | Missing test cases for new code paths; untested edge/sad paths; boundary values; auth bypass with no test |
| `security_authz` | Auth gaps; IDOR; injection (NoSQL/SQL/path); info disclosure; timing-safe comparisons; input validation |

Each lens runs in a separate agent wake — isolated context (A1b cold-session rotation ensures no
cross-contamination). Gate passes when ALL lenses approve. One lens rejection blocks the chain.

`light` profile unchanged: single generalist code-review, no lensKey.

---

## Architecture

### `plan-gates.ts`

**New:**
- `REVIEW_GATE_LENSES = ["scalability", "test_coverage", "security_authz"]`
- `ReviewGateLens` type
- `lensKey?: ReviewGateLens` on `GateApprovalSpec`
- `ReviewGateWakeTarget { agentId, approvalId, lensKey }` interface

**Changed:**
- `buildGateApprovalsForActivation` for `dev_team`: 3 `code_review` specs per leaf (one per lens) instead of 1
- `reviewGateAgentIdsFromApprovals`: returns `ReviewGateWakeTarget[]` — one entry per pending approval, NOT deduplicated by agentId; carries `approvalId` + `lensKey` for targeted wakes

Old counts (dev_team, 1 leaf): 1 plan-approval + 1 code-review + 1 wiring = **3 specs**
New counts (dev_team, 1 leaf): 1 plan-approval + 3 code-review + 1 wiring = **5 specs**

### `plans.ts` — `createActivationGates`

Threads `spec.lensKey` into the approval payload:
```typescript
payload: {
  gate: true,
  planRootIssueId,
  designatedAgentId: spec.designatedAgentId,
  ...(spec.lensKey != null ? { lensKey: spec.lensKey } : {}),
},
```

### `issues.ts` — W5b wake loop

**Key change:** switched from `addWakeup` (Map keyed by `agentId:issueId`) to direct
`heartbeat.wakeup` per approval. The old Map would collapse 3 lens wakes for the same agent
+ issue into 1. Direct calls preserve all 3.

Each wake carries `approvalId` + `lensKey` in `contextSnapshot`:
```typescript
contextSnapshot: {
  issueId: issue.id,
  source: "issue.in_review.gate",
  approvalId,           // exact approval to decide
  lensKey,              // which dimension to review (if set)
}
```

### `code-reviewer` AGENTS.md

New **Lens mode** section: when `lensKey` is in context, review ONLY that dimension. Use
`approvalId` from context when posting the gate decision. Per-lens focus table included.

---

## Full execution trace

```
plans.ts:createActivationGates
  → buildGateApprovalsForActivation (dev_team, 1 leaf)
  → 3 code_review specs { lensKey: "scalability" | "test_coverage" | "security_authz" }
  → 3 approval rows in DB, each with lensKey in payload

issue.status → "in_review"
  → listApprovalsForIssue → 3 pending code_review approvals
  → reviewGateAgentIdsFromApprovals → 3 ReviewGateWakeTarget entries
  → heartbeat.wakeup × 3 (each with approvalId + lensKey in contextSnapshot)

code-reviewer agent wake (×3, isolated sessions via A1b):
  → reads lensKey from context
  → reviews only that dimension on the diff
  → POST /api/approvals/<approvalId>/agent-decide
  → approval row status → "approved" | "rejected"

evaluateDevTeamDoneReadiness:
  → reviewGateStatuses = [status of all 3 code_review + 1 wiring]
  → all "approved" → ready to done
```

---

## Tests

- `server/src/__tests__/gate-triage.test.ts` — updated for new spec counts + new return type
- `server/src/__tests__/review-gate-lens.test.ts` — 11 new B1-specific tests
- All 34 tests pass; typecheck clean

---

## AC

- `dev_team` plan activation creates 3 `code_review` approval rows with `lensKey` in payload
- W5b wake fires 3 targeted wakes per code-review (one per lens) with `approvalId` + `lensKey`
- Code-reviewer AGENTS.md instructs single-dimension focus when `lensKey` is in context
- Gate passes only when all 3 lenses + wiring approve
- `light` profile unchanged (1 generalist code-review, no lens)

---

## Files Changed

| File | Change |
|---|---|
| `server/src/services/plan-gates.ts` | REVIEW_GATE_LENSES, ReviewGateLens, lensKey on GateApprovalSpec, 3× code-review per leaf for dev_team, ReviewGateWakeTarget, per-approval reviewGateAgentIdsFromApprovals |
| `server/src/services/plans.ts` | Thread lensKey into approval payload |
| `server/src/routes/issues.ts` | W5b: direct heartbeat.wakeup per approval + lensKey/approvalId in contextSnapshot |
| `server/src/onboarding-assets/code-reviewer/AGENTS.md` | Lens-mode section + per-lens focus table |
| `server/src/__tests__/gate-triage.test.ts` | Updated counts + return type for B1 |
| `server/src/__tests__/review-gate-lens.test.ts` | 11 new B1 tests (new) |
