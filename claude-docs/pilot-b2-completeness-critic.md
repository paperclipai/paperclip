# Pilot B2 — Completeness Critic / Adversarial Final Pass

**Branch:** `pilot/b1-dogfood`
**Scope:** `packages/shared/src/types/issue.ts`, `server/src/services/plan-gates.ts`, `server/src/routes/approvals.ts`, `server/src/routes/issues.ts`, `server/src/services/issue-approvals.ts`, `server/src/onboarding-assets/completeness-critic/`, `packages/teams-catalog/…/dev-team/agents/completeness-critic/`

---

## Problem

Both the code-reviewer and wiring-expert run in independent contexts — they don't
see each other's verdicts. A shared blind spot (unchecked after both pass) has
no adversarial pressure. HIVA-17 showed that both the code-reviewer and the
wiring-expert missed two specific gaps on the same diff:
1. Unbounded `GET /companies/:id/plans` list query (no `LIMIT`)
2. No test exercising a board-actor or admin calling the endpoint

Neither reviewer caught the other's miss.

---

## Fix

A **completeness-critic** wakes *after* all code-review + wiring-review gates on a
leaf approve (W5c). It reads the diff and the combined reviewer verdicts and looks
specifically for gaps both reviewers left.

### 1. New gate type: `gate_completeness_review`

Added to `GATE_APPROVAL_TYPES` in `@paperclipai/shared`. No DB migration needed
(the `approvals.type` column is `text`, not a DB enum).

`IssueBlockedInboxReason` gains `"pending_completeness_review"`.

### 2. `plan-gates.ts` — completeness gate spec

For `dev_team` profiles, `buildGateApprovalsForActivation` now adds one
`gate_completeness_review` spec per leaf (after the wiring gate). Designated
agent: `"completeness-critic"`.

Dev-team gate set per leaf:
- 3× `gate_code_review` (one per lens: scalability, test_coverage, security_authz) — woken at W5b
- 1× `gate_wiring_review` — woken at W5b
- 1× `gate_completeness_review` — woken at W5c (AFTER all others approve)

Total specs for 2-leaf plan: **11** (was 9 before B2).

### 3. W5c — critic wake trigger in `routes/approvals.ts`

After the `agent-decide` handler marks a `gate_code_review` or `gate_wiring_review`
as approved, it checks the sibling approvals:

```
criticGateWakeTarget(allApprovals) → { agentId, approvalId } | null
```

`criticGateWakeTarget` returns a wake target only when:
- All `gate_code_review` + `gate_wiring_review` approvals on the leaf are `"approved"`
- The `gate_completeness_review` approval is still `"pending"` with a designated agent

When the target exists, `heartbeat.wakeup` fires:
```typescript
{
  reason: "gate_completeness_review_requested",
  contextSnapshot: {
    source: "issue.review_gates_complete.critic",
    approvalId,  // critic decides using this
    prUrl,       // if available
  }
}
```

### 4. Done-gate includes completeness

`evaluateDevTeamDoneGate` in `routes/issues.ts` now includes
`gate_completeness_review` in the `reviewGateStatuses` filter alongside
code-review and wiring-review. A leaf cannot become `done` until the
completeness gate is also approved.

### 5. `AGENTS.md` — completeness-critic instructions

The critic's role: "what did both reviewers miss?"

Key checks it applies after reading both verdicts + diff:
- Unbounded queries without `LIMIT`/cursor
- Routes with no test exercising a board/admin actor
- Unverified reviewer claims ("no migration needed", "idempotent")
- Silent error swallows that slipped through wiring review
- Shared utilities modified but callers not in the diff

Rejection requires a specific `file:line` finding not already covered by an
existing reviewer verdict. The critic does not re-review covered ground.

Model: `opus` (adversarial final gate, highest-stakes pass).

---

## AC

- Dev_team leaf gets 5 gates: 3 code-review + 1 wiring + 1 completeness
- Completeness critic wakes only after all code-review + wiring-review approvals on its leaf are approved
- Leaf cannot reach `done` until completeness gate is also approved
- Critic's `AGENTS.md` instructs it to look for unbounded queries and missing board-actor test coverage — the two HIVA-17 gaps
- `criticGateWakeTarget` returns null when prerequisites unmet, gate already decided, or board-routed

---

## Files Changed

| File | Change |
|---|---|
| `packages/shared/src/types/issue.ts` | Add `completenessReview: "gate_completeness_review"` + `"pending_completeness_review"` inbox reason |
| `server/src/services/plan-gates.ts` | Add completeness gate to designated agents, reason, precedence, `buildGateApprovalsForActivation`, W5c constants, `criticGateWakeTarget` |
| `server/src/routes/approvals.ts` | W5c trigger: after code/wiring approve, check siblings and wake critic |
| `server/src/routes/issues.ts` | Include `completenessReview` in done-gate `reviewGateStatuses` filter |
| `server/src/services/issue-approvals.ts` | Add `prUrl` to `listIssuesForApproval` select |
| `server/src/onboarding-assets/completeness-critic/AGENTS.md` | New critic agent instructions |
| `packages/teams-catalog/…/completeness-critic/AGENTS.md` | Catalog copy (model: opus) |
| `server/src/__tests__/gate-triage.test.ts` | Dev_team spec count 9→11, B2 `criticGateWakeTarget` tests |
