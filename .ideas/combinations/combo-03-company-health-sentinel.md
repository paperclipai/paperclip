# Combo 03 — Autonomous Company Health Sentinel

**Combines:** 003 Diminishing-Returns Detector · 010 Blocker-Graph Deadlock Detector ·
026 Goal-Drift Alignment Auditor · 059 Goal Decomposition Quality Assistant ·
044 Agent Reliability SLOs · 006 Org Bottleneck Heatmap · 031 Agent-Run Distributed Tracing

## The unified idea

Paperclip's watchdogs catch runs that are *crashed or silent*. They miss every **expensive failure
that looks healthy**: an agent thrashing on one issue with no progress (003), a dependency cycle
where everyone is "correctly" waiting (010), whole sub-trees working hard on work that decoupled
from a live goal (026), a goal that was *badly broken down in the first place* (059), and an agent
that's simply *flaky*, burning recovery cycles (044). These are five analyzers over the same data —
the issue tree, run history, and outcomes — and they all want the same two things: **a place to get
clean signal from, and a place to show the result.**

Build a single **Health Sentinel**: one analyzer service that runs these checks on a routine and
escalates *actionably*, fed by one instrumentation layer and surfaced on one visualization.

- **Instrumentation backbone (031).** Emit semantic OTel spans for the run lifecycle (agent, issue,
  model, cost, tokens, tool-calls, sub-issue creation, handoffs), with trace context propagated
  across handoffs. This one layer becomes the clean data source every detector reads — instead of
  each re-stitching logs, transcripts, and cost rows.
- **The detectors, unified (003, 010, 026, 044, 059).** Per-issue progress fingerprints (003);
  Tarjan SCC + dead-end detection on the blocker graph (010); parent-chain + semantic alignment walk
  for orphaned/drifted work (026); structural + completeness/overlap checks on decomposition (059);
  rolling success/recovery rates vs an error budget per agent (044). Semantic tiers run on a free
  local model (combo 02 / idea 008).
- **One escalation contract.** Every trip names the *specific* thing to fix (the edge to cut, the
  orphan to re-parent, the agent to constrain), auto-pauses where safe, and routes to the manager
  agent or operator inbox.
- **One surface (006).** Overlay all of it on the org-chart renderer as a bottleneck heatmap — hot
  blocked nodes *and* cold decoupled branches both glow — with critical-path highlighting and
  optional hourly trend snapshots.

## Why combining wins

Each detector alone is "an analyzer + an escalation + a viz." Built together they share the trace
data source (031), the routine scheduler, the local-model judge, the org-chart overlay (006), and
one escalation/auto-pause path — and the heatmap becomes genuinely useful only when it shows *all*
pressure types at once. Reliability (044) and unit economics (combo 04) also consume the same spans.

## Phasing

1. Semantic run spans (031) — the data backbone; ship first, reuse the existing OTel exporter.
2. Deterministic structural detectors (003 fingerprints, 010 cycle/dead-end, 026 orphan walk, 059
   structural, 044 rates) + the heatmap surface (006).
3. Semantic tiers (026 drift, 059 completeness/overlap) on a local model behind confidence thresholds.

## Ratings

- **Difficulty:** Medium–High — the graph algorithms and aggregations are textbook; the real work is
  threading trace context across adapters/handoffs and *tuning heuristics* so they catch genuine
  waste without killing slow-but-legitimate work.
- **Estimated time to complete:** ~5–7 engineer-weeks (deterministic tier ~3 weeks, high value alone).
- **Importance:** 9/10 — these are the most expensive failure modes precisely because they look fine;
  catching them is the difference between an autonomous company that compounds value and one that
  quietly burns money.
