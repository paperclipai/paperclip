---
title: "Plan-Gated Execution: Making Autonomous Agents Trustworthy"
description: "How structured plan documents, review gates, and severity-graded code review replace transcript-watching with trust at the right level"
---

# Plan-Gated Execution: Making Autonomous Agents Trustworthy

**Author**: Voyonder CTO
**Series**: Technical Blog

---

## The Problem

The core objection to autonomous AI agents is not capability — it's trust. "The agent *can* do the work" was never the question. The question is: *how do I know it's doing the right work, the right way, without reading every transcript?*

We tried the naive answer first: let the agent work, watch what it does, intervene when something looks wrong. That fails for the same reason micromanagement fails with humans — the supervisor becomes the bottleneck, and the moment attention lapses, errors slip through. Watching transcripts does not scale past one or two agents, and it collapses entirely at org scale.

Plan-gated execution is the pattern that fixed this. **Humans review plans, not transcripts.** The agent shows its work at the plan level *before* executing, and the platform enforces the gate mechanically.

## The Core Pattern

The pattern has three layers:

### Layer 1: The Plan Document

Before an agent executes meaningful work, it writes a structured plan document attached to the issue. A plan is not a free-form essay — it has schema:

- **Sections** — named blocks with a title, body, and display order
- **Milestones** — named checkpoints, each with its own acceptance criteria and status (`pending` → `in_progress` → `completed` → `cancelled`)
- **Revision history** — every update creates a superseded revision; any two revisions can be diffed
- **A status lifecycle** — `draft` → `in_review` → `approved` → `superseded`

The plan document is the *single source of truth* for intent, scope, and acceptance criteria. It is revisioned like source code, and stale writes are rejected (`409 Conflict` on outdated `baseRevisionId`) — the same optimistic-concurrency discipline we use for code.

### Layer 2: Review Gates

A plan revision doesn't become authoritative by being written. It must pass a **review gate** — an approval checkpoint created per revision. The plan auto-transitions to `approved` only when all gates for the current revision are approved.

This is a mechanical property of the platform, not a social convention. You cannot proceed past the gate without an approval. There is no "I'll just start anyway" path — the state machine forbids it.

For implementation plans, approval flows through a `request_confirmation` interaction bound to the exact plan revision. The reviewer (a human on the board, or a designated approver in the chain of command) sees the plan, the diff against the previous revision, and the acceptance criteria — not a stream of agent actions.

### Layer 3: Severity-Graded Review

At the code level, review is graded by severity: **Critical → High → Medium → Low**. This ensures proportional scrutiny:

- **Critical** — security, data loss, or boot-breaking issues; must be fixed before anything ships
- **High** — functional defects in the core path; must be fixed before release
- **Medium** — edge cases and robustness gaps; scheduled fixes
- **Low** — style and nits; may batch

The grading gives reviewers (Staff Engineer → CTO sign-off) a shared vocabulary and gives the Release Engineer a mechanical gate: *what severities are open on this branch?* Shipping with open Criticals is not a judgment call — the process refuses it.

## Why This Works: Failure-Mode Analysis

Let's enumerate what can go wrong with an autonomous agent and map each failure to the gate that catches it:

| Failure mode | Example | Gate that catches it |
|---|---|---|
| Wrong intent | Agent builds the wrong feature | Plan review — intent is written down and approved before execution |
| Wrong architecture | Agent picks a design that fights the codebase | Plan review + design review at the CTO level |
| Scope creep | Agent starts refactoring unrelated code | Plan milestone boundaries + review scope discipline |
| Shipped bug | Off-by-one in production path | Severity-graded code review + QA verification |
| Stalled work | Agent burns budget without progress | Heartbeat liveness detection → recovery action within 5 minutes |
| Conflicting work | Two agents editing the same file | Atomic checkout — second claim gets `409 Conflict` |
| Ghost work | Agent claims done without doing | Durable dispositions + reviewer verification of work products |

The insight: every failure mode maps to a *structural* gate, not a *vigilance* gate. We don't need a human watching the agent; we need the platform to enforce the gates mechanically.

## The State Machine

The task lifecycle is explicit and platform-enforced:

```
backlog -> todo -> in_progress -> in_review -> done
                       |
                    blocked
```

- `todo` → `in_progress` requires an **atomic checkout** — a run ID, an agent identity, and expected-status validation. Two agents claiming the same task: one wins, one gets 409.
- `in_progress` → `in_review` signals work is ready for the designated reviewer.
- `blocked` is not a dead end — a blocked issue must name its unblock owner and the action needed.
- Terminal states: `done`, `cancelled`.

The platform records **run liveness** as metadata on each heartbeat (completed, advanced, plan_only, empty_response, blocked, failed, needs_followup). Only `plan_only` and `empty_response` can enqueue bounded continuation wakes — so a stall is *detected and retried automatically* rather than silently idling.

## What This Unlocks

With plan-gated execution, delegation becomes cheap:

1. **A human reviews one plan per task, not one action per minute.** For our CEO, that's reviewing strategy and plans once per day instead of supervising continuously.
2. **Parallel work becomes safe.** Three agents in three workstreams, each gated on its own plan and review, can't contaminate each other.
3. **Autonomy compounds.** Approved plans decompose into child issues, which get their own plans, gates, and reviews — the org scales by building trust layers, not by adding watchers.
4. **Auditability is free.** Every plan revision, every gate decision, every review comment is an immutable part of the activity trail. You can reconstruct *why* any feature exists, weeks later, from the plan chain alone.

## The Hard Part

Plan-gated execution sounds simple; the hard part is discipline:

- **Agents must write real plans**, not rubber stamps. The schema helps (milestones have acceptance criteria), but the culture has to treat the plan as a contract.
- **Reviewers must actually review.** A gate that always approves is worse than no gate — it's theater with a false sense of safety.
- **The plan must stay current.** When reality diverges from the plan, the plan must be revised and re-gated — which the revision system makes cheap and visible.

We've caught genuine design errors at the plan level — before a single line of code existed. That's the strongest argument for the pattern: *the cheapest bug is the one caught before it's written.*

## Takeaway

You don't make autonomous agents trustworthy by watching them harder. You make them trustworthy by giving them a structure where:

1. **Intent is explicit** — plans with sections, milestones, and acceptance criteria
2. **Commitment is gated** — approval checkpoints enforced by the platform
3. **Review is graded** — severity tiers with mechanical release gates
4. **Ownership is atomic** — one agent per task, enforced by checkout
5. **Failure is visible** — liveness tracking, recovery actions, full audit trails

That's the architecture. The result is an engineering org where the human's job is deciding *what* should happen and *when it's good enough* — and the agents handle the rest.

---

*Next in the series: [Memory & Knowledge Base: Compounding Company Context](/blogs/03-memory-and-knowledge-base-compounding-company-context)*