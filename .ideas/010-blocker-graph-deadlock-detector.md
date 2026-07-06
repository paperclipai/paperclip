# 010 — Blocker-Graph Deadlock Detector

## Suggestion

The issue model supports **blockers** and parent/sub-issues (per `doc/PRODUCT.md`). With
autonomous agents decomposing work and marking dependencies on their own, it's easy to create
a **deadlock**: issue A blocked on B, B blocked on C, C blocked on A — a cycle where every
agent involved is "correctly" waiting and nothing ever moves. Worse are silent stalls: a whole
subtree blocked on one issue that was abandoned or assigned to a paused agent. Nobody is
crashed, nobody is looping, so the watchdogs (`task-watchdogs.ts`) and the Diminishing-Returns
Detector (idea 003, which is per-issue) won't catch it — the work is just frozen.

Add a **deadlock/stall detector** that periodically analyzes the blocker graph for cycles and
dead-end dependency chains, then escalates them.

## How it could be achieved

1. **Build the dependency graph.** From the issues table, construct a directed graph of
   `blocked-by` edges (plus parent/sub-issue edges where relevant) per company.
2. **Cycle detection.** Run a standard DFS/Tarjan SCC pass to find any strongly-connected
   component of size > 1 — those are deadlocks. Cheap; runs on a routine (`routines.ts`).
3. **Dead-end detection.** Flag chains terminating on an issue that is (a) unassigned,
   (b) assigned to a paused/removed agent, or (c) untouched beyond a threshold age, while
   descendants wait on it. This is the more common real-world stall.
4. **Auto-resolution / escalation.** On a cycle, post a comment on each member, pause further
   wakeups for the loop, and raise one inbox item that visualizes the cycle and suggests the
   edge to cut. For a dead-end, route to the blocking issue's assignee's manager via the org
   chart.
5. **Visualization.** Surface stalls on the Org Bottleneck Heatmap (idea 006) — a deadlocked
   cluster is the ultimate bottleneck and should glow red there.

## Perceived complexity

**Medium.** The graph algorithms are textbook and fast at realistic issue counts, so the core
detector is small. The effort is in edge-case correctness (self-blocks, cross-tree blockers,
issues that are legitimately waiting on a human) and in making the escalation *actionable*
rather than noisy — a deadlock alert is only useful if it names the exact edge to cut. Pure
read-model + escalation; no changes to the execution engine.
