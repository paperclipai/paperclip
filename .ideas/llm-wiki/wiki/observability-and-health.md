---
title: Observability & Company Health
type: concept
status: reviewed
sources: [003, 006, 010, 026, 031, 044, 059, combo-03, xcombo-15, research-sources]
updated: 2026-06-24
---

# Observability & Company Health

Paperclip's watchdogs catch *crashed/silent* runs. They miss the expensive failures that **look healthy**:
an agent thrashing with no progress, a dependency deadlock, work that decoupled from a live goal, a badly
decomposed plan, a flaky agent. This is *observability* (health now) — distinct from
[[security-governance|auditability]] (defending a past decision).

## The Health Sentinel (combo-03)

One analyzer service + one surface, fed by one instrumentation layer:
- **Tracing backbone (031)** — semantic OTel spans for the run lifecycle, trace context propagated across
  handoffs. The clean data source every detector reads (and [[economics-and-finance|unit economics]] too).
- **Detectors** — diminishing-returns (003, per-issue thrash), deadlock/dead-end on the blocker graph
  (010, Tarjan SCC), goal-drift/orphaned work (026), decomposition quality (059), reliability SLOs (044).
- **Surface** — overlay all pressure on the org-chart heatmap (006): hot blocked nodes *and* cold
  decoupled branches both glow.

## Closed-loop run efficiency (xcombo-15, queued)

Tracing (031) + adaptive heartbeat (035) + diminishing-returns (003) + per-run caps (024) → a real-time
control loop that tunes *how* runs execute for cost/throughput, not just whether they start.

## Links

Feeds [[agent-quality-and-staffing]] (reliability → assignment/trust), the [[self-healing-org]] (detectors
are the "detect" stage), and [[economics-and-finance]] (idle/misaligned spend).

## Provenance

- Ideas `003,006,010,026,031,044,059`; combo `combo-03`; queued `xcombo-15`.

## Open questions for human review

- Heuristic tuning: catch genuine loops without killing slow-but-legitimate work — default thresholds?
- Semantic tiers (drift/decomposition) run on a local model — confidence threshold before auto-pause?
