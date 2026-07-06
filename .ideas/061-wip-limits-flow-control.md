# 061 — WIP Limits & Flow Control

## Suggestion

Paperclip can limit **compute** concurrency (per-agent `maxConcurrentRuns`, the proposed Fleet
Governor idea 001, per-run caps idea 024), but it has no concept of **work-in-progress (WIP)
limits** — a cap on how many issues are *actively in progress* at once per agent, team, or
workflow stage. A code scan finds no WIP/flow-limit notion anywhere. These are different levers:
concurrency governs how much *machine* runs at once; WIP governs how much *work* is open at once.
Without WIP limits, autonomous agents start far more than they finish — dozens of half-done
issues, constant context-switching, ballooning cycle time, and a board that looks busy while
little actually ships. WIP limits are the core flow-control discipline of every kanban system,
and they're missing.

Add **WIP limits**: configurable caps on in-progress work per agent / team / stage, with "stop
starting, start finishing" enforcement so the company optimizes for *throughput*, not *activity*.

## How it could be achieved

1. **Limits per scope.** Configurable max in-progress issues per agent, per team, and per workflow
   stage (status column). Issues already carry status, so "how many are in progress for X" is a
   direct count.
2. **Enforce at pull, not push.** When an agent would pick up new work but is at its WIP limit,
   block the *start* and steer it to finish (or unblock) existing work instead — surfaced as a soft
   signal to the agent, and factored into the admission/assignment path (ideas 001, 025) so blocked
   work isn't handed to a maxed-out agent.
3. **Flow metrics.** With WIP bounded, compute the flow numbers that actually matter — cycle time,
   throughput, and flow efficiency (active vs waiting time) — surfaced per agent/team. These are the
   leading indicators the Org Bottleneck Heatmap (idea 006) and operator digest (idea 029) want.
4. **Detect WIP thrash.** Flag agents/teams chronically at their limit (under-capacity) or starting
   far more than finishing (a "start/finish ratio" alarm) — a different signal than the
   Diminishing-Returns detector (idea 003), aimed at *flow* rather than *productivity per issue*.
5. **Operator tuning.** Sensible defaults with per-company override; let operators experiment with
   tighter limits and watch cycle time respond (pairs with the experiment framework, idea 056).

## Perceived complexity

**Low–Medium.** Issue status and counts already exist, so the core — counting in-progress work per
scope and gating starts against a limit — is small and has no new execution machinery. The flow
metrics are straightforward aggregations. The subtle parts are behavioral: making the "stop
starting" steer feel natural to autonomous agents (they must understand *why* they're being asked
to finish rather than start), and choosing default limits that improve flow without starving a
genuinely parallel team. Ship per-agent WIP limits + flow metrics first; team/stage limits and the
start/finish alarms follow.
