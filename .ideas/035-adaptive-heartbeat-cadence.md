# 035 — Adaptive Heartbeat Cadence

## Suggestion

Agents run on **heartbeats** — periodic wake-ups where they check for work and act
(`heartbeat.ts`). Today cadence is essentially fixed per agent. That's wasteful at both ends: an
idle agent with an empty queue still wakes on schedule, spends tokens loading context only to
find nothing to do, and goes back to sleep — pure burn for zero output, multiplied across a
24/7 company. Meanwhile an agent with a deep, urgent backlog waits out its interval between
runs, hurting responsiveness exactly when it matters. A fixed cadence can't be right for both.

Add **adaptive heartbeat cadence**: tune each agent's wake frequency dynamically from its actual
workload — back off when idle, speed up when there's a backlog or time-sensitive work.

## How it could be achieved

1. **Signals already available.** Queue depth for the agent (assigned/ready issues), recent
   "woke up with nothing to do" outcomes, and pending wake triggers
   (`issue-assignment-wakeup.ts` already does event-driven wakeups). These drive the cadence.
2. **Backoff when idle.** After consecutive empty heartbeats, exponentially lengthen the
   interval (with a cap), so idle agents cost almost nothing — but keep them reachable by the
   existing event-driven wakeup so new work still pulls them in immediately.
3. **Speed up under load.** When queue depth or priority crosses a threshold, shorten the
   interval (down to a floor) so busy agents iterate faster. Respect the Fleet Concurrency
   Governor (idea 001) and per-run caps (idea 024) so "faster" never means "unbounded."
4. **Event-first, timer-fallback.** Make the timer a safety net and prefer event-driven
   wakeups (assignment, mention, blocker cleared). The cadence is just the heartbeat for when no
   event fires — mirroring how a well-designed poll loop leans on events.
5. **Bounds & visibility.** Operator-set min/max intervals per agent/tier, and a readout of each
   agent's current effective cadence and *why* ("idle ×6 → backed off to 30m").

## Perceived complexity

**Medium.** The heartbeat scheduler and an event-driven wakeup path already exist, so this is a
control policy layered on top rather than new machinery — compute a next-interval from workload
signals instead of using a constant. The subtle parts are avoiding oscillation (needs hysteresis/
smoothing, like the budget breaker in idea 002) and guaranteeing a backed-off idle agent still
responds instantly to a real event, so backoff never feels like the agent "went to sleep on the
job." Idle-backoff alone is a high-ROI first slice — it directly cuts wasted spend with little
risk.
