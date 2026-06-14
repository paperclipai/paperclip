# Reviewer Wake on in_review — W5b (shipped) Overview

> Written 2026-06-14. Covers fix-backlog #9 **W5b** — the second of the three
> gate-wake pieces (W5a architect-on-activation shipped earlier; W5c cadence raise
> still pending and rides this). Commit: `fb27162a`. Builds on
> `targeted-gate-wake-overview.md`.

---

## Background

W5a gave the **plan-approval** gate (architect) a direct wake at plan activation.
The **code-review** and **wiring-review** gates still had none: their designated
agents only discovered a ready leaf on the **global heartbeat** (up to ~1h). So a
finished leaf sat in `in_review` waiting on a poll before review even started.

Review gates are only actionable once the implementor finishes — i.e. at the
`in_review` transition — which is why they could not be woken at activation like
the plan gate. This is the wake that closes that gap.

## What shipped

- **Pure helper** — `plan-gates.ts` `reviewGateAgentIdsFromApprovals(approvals)`:
  given the issue's `listApprovalsForIssue` result, returns the de-duplicated
  `payload.designatedAgentId` of every **pending** `codeReview` / `wiringReview`
  gate. Plan-approval gates are excluded (woken at activation), decided gates are
  excluded (status !== "pending"), and board-routed gates (null designated agent)
  yield nothing. Twin of W5a's `planApprovalAgentIds`.
- **Wake branch** — in the issues `PATCH` wake-batching closure, a `becameInReview`
  branch (`existing.status !== "in_review" && issue.status === "in_review"`) looks
  up the issue's approvals and `addWakeup`s each designated reviewer with
  `source: "assignment"`, `reason: "gate_review_requested"`. `assignment` source
  means the **W2 timer-only idle short-circuit never suppresses it** (same trick as
  W5a). The wake merges into the existing per-agent `addWakeup` dedup + single
  flush loop — no new enqueue path.
- **Resilience guard** — the approval lookup is wrapped in `try/catch`: a mid-flight
  throw logs and continues so it can never skip the flush of the other queued
  wakeups (assignee / comment / blocker-resolved). This was a review-gate finding,
  fixed before merge.

## Why the redaction check mattered

`listApprovalsForIssue` runs each approval's payload through `redactEventPayload`.
Confirmed `designatedAgentId` is preserved: the secret-key pattern matches only
token/secret/key/auth-style names, and a UUID is not JWT-shaped — so the agent id
survives and the helper can read it. Had it been redacted, the feature would have
silently woken nobody.

## Flow

```
PATCH /issues/:id  (status → in_review)
  → svc.update → wake-batching closure
       becameInReview = existing.status !== "in_review" && issue.status === "in_review"
       try:
         linkedApprovals = issueApprovalsSvc.listApprovalsForIssue(issue.id)
         reviewGateAgentIdsFromApprovals(linkedApprovals)   // pending code+wiring designated, deduped
           → addWakeup(agentId, { source:"assignment", reason:"gate_review_requested",
                                  payload:{ issueId, mutation:"in_review" } })
       catch: logger.warn (flush still runs)
  → flush loop: heartbeat.wakeup(...) per agent
  → code-reviewer + wiring-expert run now, see their pending gate
```

Latency for the two review gates: **≤ 1h → immediate**.

## Verification

- `gate-triage.test.ts` (extended): helper returns code+wiring designated deduped;
  excludes plan-approval; ignores non-pending (approved/rejected); ignores
  null/empty/missing designatedAgentId; dedups a shared agent; `[]` when none.
- `tsc` clean. Plan-gate + done-gate suites green (26).
- Regression: the issues-PATCH suite has 12 **pre-existing** failures (executor-
  handoff tests, unrelated to this branch's gate work) — identical counts with and
  without this change (stash-verified), so W5b adds no regression. Those failures
  are tracked separately, not introduced here.
- No DB migration.

## Remaining in the gate-wake set

- **W5c — raise the default heartbeat cadence** (`company-portability.ts:667`,
  3600s). Now safe to consider: plan-approval (W5a) and both review gates (W5b) are
  push-woken, so reviewers no longer depend on the cadence to find work. Still a
  separate change; grep tests for hard-coded 3600 before flipping.
