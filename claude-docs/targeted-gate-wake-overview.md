# Targeted Gate Wake — W5a (shipped) Overview

> Written 2026-06-14. Covers fix-backlog **#9 (W5)**, which decomposed on
> contact: **W5a** (architect wake on activation) shipped; **W5b** (reviewer wake
> on in_review) and **W5c** (cadence raise) deferred with reasons. Background,
> solution, flow, and why the split. Commit: `17476dbd`.

---

## Background — why this work exists

dev-team gate agents (architect, code-reviewer, wiring-expert) had **no wake of
their own**. A gate was materialized as a pending approval at activation, and the
designated agent only discovered it on its next **global heartbeat** tick — up to
the per-agent interval (1h by default). So a plan could sit unreviewed for an
hour after activation, purely waiting for a poll.

The fix-backlog framed W5 as "make gate creation wake the designated agent, then
raise the global cadence." On contact with the code, that single idea split into
three pieces with different actionability and risk.

---

## Why W5 decomposes — gate actionability differs by type

A gate agent should be woken only when its gate is **actually actionable**:

| Gate | Designated | Actionable when | Wake trigger |
|---|---|---|---|
| plan-approval | architect | **plan activates** (plan exists, reviewable) | **activation** ✅ W5a |
| code-review | code-reviewer | the leaf is **implemented** (in_review) | in_review 🔜 W5b |
| wiring-review | wiring-expert | the leaf is **implemented** (in_review) | in_review 🔜 W5b |

Waking the reviewers at *activation* would be wrong — there is nothing to review
until the implementor finishes. So only the **plan-approval** gate can be woken
at activation; the reviewers must be woken on the **in_review** transition.

And the **cadence raise** (W5c) is only safe **after** the reviewer wake (W5b)
lands: if reviewers still depend on the timer to discover work, lengthening the
interval would make them wait *longer*, not shorter. So W5c follows W5b.

---

## W5a — what shipped

Wake the plan-approval gate agent(s) directly at activation.

- `plan-gates.ts` gains a pure helper `planApprovalAgentIds(specs)` — the unique
  designated agents of the **plan-approval** gate only. Returns `[]` for
  `solo`/`light`/`none` (which carry no plan gate), so only `dev_team`
  activations wake an architect.
- `createActivationGates` returns those ids alongside the approval ids.
- The activate route wakes each via an **assignment-source** wakeup
  (`reason: "gate_plan_approval_requested"`), so the W2 idle short-circuit (which
  only skips *timer* wakes) never suppresses it.

Effect: architect plan-review latency drops from **≤ 1h → immediate**.

---

## Flow

```
POST /plans/:id/activate
  → plans.activate
       → createActivationGates(profile)
            → buildGateApprovalsForActivation → specs
            → planApprovalAgentIds(specs)   // architect for dev_team; [] otherwise
       → return { gateApprovalIds, planApprovalWakeAgentIds }
  → for each planApprovalWakeAgentId:
       heartbeat.wakeup(architect, {
         source: "assignment",                  // W2 never skips an assignment wake
         reason: "gate_plan_approval_requested",
         payload: { issueId, mutation: "plan_activated" },
       })
  → architect runs now, sees its pending plan-approval gate
```

Pairs with the gate-triage work: only `dev_team` plans have a plan-approval gate,
so only they trigger this wake — `solo`/`light` activations wake no architect.

---

## Deferred (with reasons)

- **W5b — reviewer wake on in_review.** Wake the code-review + wiring agents for a
  leaf when it transitions to `in_review`. Requires integrating into the issues
  PATCH-update wake flow (a large handler with its own wake-batching); doing it
  correctly needs that flow mapped, so it is left for a focused follow-up rather
  than rushed. This is the bulk of the gate-wake value (2 of 3 gate types,
  per-leaf).
- **W5c — raise the default heartbeat cadence** (`company-portability.ts:667`,
  currently `3600s`). Only safe **after** W5b — until reviewers are push-woken,
  a longer interval would slow their discovery. Also low marginal value once W2
  makes idle timer wakes free skips. Deferred behind W5b.

---

## Verification

- `server/src/__tests__/gate-triage.test.ts` (extended): `planApprovalAgentIds`
  returns the architect for `dev_team`, `[]` for `light`/`solo`, and ignores an
  unstaffed (null) architect role.
- Regression: `plan-gate-activation` / `plan-gate-workspace-cleanup` green; the
  extended `activate` return is back-compatible with existing destructures.

No DB migration.
