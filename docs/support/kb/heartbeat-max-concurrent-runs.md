---
title: Support KB — Heartbeat Timer Max Concurrent Runs Enforcement
summary: tickTimers enforces maxConcurrentRuns before enqueueing (PRA-553)
version: v0.3.1+
commit: b9d5299816
---

# Support KB: Heartbeat Timer Max Concurrent Runs Enforcement

**Applies to:** Paperclip v0.3.1+
**Commit:** `b9d5299816` (PRA-553)
**Date:** 2026-08-15

---

## Summary

The heartbeat timer (`tickTimers`) now checks per-agent `maxConcurrentRuns` and the instance-wide ceiling **before** enqueueing a new run, rather than only at claim time. This prevents queue bloat when an agent is saturated.

## Old Behavior

When an agent's timer interval elapsed, `tickTimers` always enqueued a new queued run regardless of whether the agent was already at its `maxConcurrentRuns` cap. The admission gate in `admitAndClaimQueuedRuns` caught this at claim time, but that still allowed queued runs to pile up every tick while the agent was saturated — creating a queue-growth-induced burst when a slot opened up.

## New Behavior

`tickTimers` now calls `evaluateRunAdmission()` before enqueueing. If:
- The agent is at its `maxConcurrentRuns` cap, **or**
- The instance-wide ceiling is hit, **or**
- The host is overloaded

...the timer skips this cycle and advances `lastHeartbeatAt` so the agent is reconsidered after a full interval. When a running run finishes, `finalizeRun` → `startNextQueuedRunForAgent` handles immediate promotion of any already-queued runs.

## What This Means for Support

- **Reduced queue bloat** during agent saturation — fewer queued runs means faster catch-up when a slot opens
- **No behavioral change** for agents running under their capacity — timers fire as normal
- **If an agent is chronically skipped**, check its `maxConcurrentRuns` policy and whether it has stuck/pending runs consuming its capacity
- The authoritative cap enforcement remains in `admitAndClaimQueuedRuns` — this is an optimization, not a replacement

## How to Detect

In agent logs, the skip is silent (no warning emitted — the timer simply moves on). To verify admission decisions:

1. Check the agent's `policy.maxConcurrentRuns` setting
2. Check `countRunningRunsForAgent(agent.id)` to see current run count
3. If the agent is at capacity but has no healthy running runs, investigate stuck runs

## Related

- PRA-553: enforce maxConcurrentRuns in tickTimers before enqueueing
- RBR-974: admission gate hardening
- `server/src/services/heartbeat.ts` — `tickTimers` and `evaluateRunAdmission`
