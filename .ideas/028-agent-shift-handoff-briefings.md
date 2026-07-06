# 028 — Agent Shift-Handoff Briefings

## Suggestion

Paperclip already preserves continuity *within* a single agent's work on an issue
(`issue-continuation-summary.ts` summarizes prior runs so the next run of the **same** agent
resumes with context). But work also moves **between** agents — reassignment, escalation to a
manager, a review handoff, a specialist pulled in — and at those moments the receiving agent
starts cold. It re-reads the whole issue history, re-derives what's already been tried, and
often repeats work or contradicts the prior owner. With a single-assignee model and autonomous
agents constantly rerouting work, these cold handoffs are a quiet, recurring tax on quality and
cost.

Add **shift-handoff briefings**: when an issue changes hands, auto-generate a structured
hand-off note — what's done, what's left, what was tried and failed, open decisions, gotchas —
so the receiving agent starts warm.

## How it could be achieved

1. **Trigger on transfer.** Hook the assignment-change / escalation / review-handoff paths
   (`agent-assignability.ts`, `issue-approvals.ts`, the reassignment mutation that already fires
   `issue-assignment-wakeup.ts`).
2. **Synthesize the briefing.** Reuse the continuation-summary machinery, but framed for a *new*
   reader: current state, prior approaches and outcomes, blockers, decisions pending, and "things
   the next owner should not redo." Generate cheaply on a local model (idea 008).
3. **Attach as first-class context.** Store the briefing on the issue and inject it into the
   receiving agent's run context, so it's used, not just filed. Keep prior briefings for an
   auditable chain of custody as work moves through the org.
4. **Human-readable too.** The same briefing helps an operator understand a reassignment at a
   glance and pairs with the run change-review surface (idea 017) and approval triage (idea 016).
5. **Manager rollups.** When work escalates up the org chart, a briefing lets the manager agent
   act on a summary instead of re-reading a deep sub-tree — directly supporting the alignment and
   bottleneck flows (ideas 026, 006).

## Perceived complexity

**Medium.** The summarization capability and the transfer hook points both already exist, so this
is composition: trigger on handoff, repurpose continuation-summary for a new-reader audience, and
thread the result into the receiving run's context. The main work is prompt/format design for a
genuinely useful briefing (not a vague recap) and keeping generation cheap enough to run on every
handoff — again a strong fit for a free local model.
