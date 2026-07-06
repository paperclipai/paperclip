# 026 — Goal-Drift Alignment Auditor

## Suggestion

Paperclip's defining principle is **"all work traces to the goal"** — every task exists in
service of a parent, up to the company goal (`doc/PRODUCT.md`, `goals.ts`, the parent/sub-issue
tree). But this invariant is asserted at creation, not *maintained*. Autonomous agents
continuously spawn sub-issues, and over time the tree drifts: orphaned branches whose parent
goal was completed or abandoned, sub-issues that no longer actually serve their stated parent,
whole sub-trees of busywork that have quietly decoupled from the mission. Nothing detects this —
so a company can spend real money working hard on things that no longer matter, which is the
single most insidious failure mode of an autonomous business.

Add a **goal-drift auditor** that periodically verifies the alignment invariant and flags work
that has decoupled from a live company goal.

## How it could be achieved

1. **Trace every active issue to a goal.** Walk the parent chain for each open issue to its
   root. Flag issues whose chain terminates on a goal that is completed, cancelled, deprioritized,
   or no longer exists — *orphaned work*. This is a pure graph walk over data that exists.
2. **Semantic alignment check (deeper tier).** For active branches, use a cheap model (local —
   idea 008) to judge whether a sub-issue's content plausibly serves its stated parent. Low
   alignment → flag as *drifted*. Run sparingly (on a routine, on new branches) to control cost.
3. **Quantify drift.** Per company: "% of active work tracing to a live top-priority goal" and
   "estimated spend on orphaned/drifted work this week." That second number is a powerful
   operator wake-up call and feeds the Unit-Economics Dashboard (idea 013) as "misaligned spend."
4. **Act.** Route flagged work to the responsible manager agent (via the org chart) or the board
   inbox: re-parent it, re-prioritize it, or close it. Auto-pause obviously-orphaned branches so
   they stop burning budget while awaiting a decision.
5. **Visualize.** Highlight drifted/orphaned branches on the goal tree and the Org Bottleneck
   Heatmap (idea 006) — cold, decoupled branches are as important to see as hot, blocked ones.

## Perceived complexity

**Medium.** The structural check (orphaned-work detection) is a straightforward tree walk over
existing data and delivers most of the value immediately. The semantic alignment tier is more
involved — it needs a careful, cheap judging prompt and tuning to avoid false "drift" flags on
legitimately exploratory work — but it's optional and incremental. No execution-engine changes;
it's an analyzer plus escalation, with an auto-pause action reusing existing wakeup suppression.
