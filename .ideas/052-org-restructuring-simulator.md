# 052 — Org Restructuring Simulator

## Suggestion

A company's org structure — who reports to whom — drives routing, escalation, approval paths, and
boundary/assignability decisions (`agent-assignability.ts`, the org chart rendered by
`org-chart-svg.ts`). But reorganizing it is a **blind, manual, risky** edit: an operator moves an
agent under a new manager or dissolves a team with no preview of the consequences. In an autonomous
company those consequences are real and immediate — escalation paths reroute, in-flight approvals
land on a different person, an agent's assignable scope changes, work mid-flight may be orphaned.
There's no way to see "what will this reorg actually do?" before committing it.

Add an **org restructuring simulator**: model a proposed reorg, preview its impact, and apply it
safely (or roll it back).

## How it could be achieved

1. **Edit a draft, not the live org.** Let the operator build a proposed structure (move agents,
   change reporting lines, add/dissolve teams) against a draft copy rather than mutating production.
2. **Impact preview.** Compute and show the diff of consequences from data that already exists:
   reassignments implied, approvals that would reroute, escalation chains that change, agents whose
   assignable scope (`agent-assignability.ts`) widens/narrows, and any in-flight work that would be
   orphaned or cross a new boundary. Visualize old vs new on the org-chart renderer.
3. **Warnings.** Flag risky outcomes — an agent left with no manager, a team with no members, a
   reviewer removed from a path with pending approvals, a span-of-control blowout — before apply.
4. **Atomic, audited apply.** Commit the reorg as a single transaction (auto-Drain first, idea 014,
   so it doesn't race live runs), logged to the audit trail (idea 023), with a one-click revert to
   the prior structure (reuses the snapshot idea from company rewind, idea 015).
5. **Compose with staffing.** Pair with job postings (idea 048) and reliability SLOs (idea 044):
   a reorg that leaves a role unstaffed can auto-open a posting; restructuring becomes part of the
   self-organizing loop.

## Perceived complexity

**Medium.** The org data, the assignability logic, and the chart renderer all exist, so the
simulator is largely a draft model + an impact-diff computation + visualization — read-heavy, not
new core machinery. The harder parts are enumerating *all* the consequence types accurately (a
missed one undermines trust in the preview) and the atomic apply/rollback semantics around live
work. Ship the draft + impact preview first (pure insight, zero risk), then the safe atomic apply
and revert.
