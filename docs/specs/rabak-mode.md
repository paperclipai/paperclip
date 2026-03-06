---
id: paperclip-feature-rabak-mode
title: Rabak Mode — Continuous Agent Sprint
doc_type: spec
owner: paperclip
status: active
version: 1.0.0
updated: 2026-03-06
applies_to:
  - server
  - ui
depends_on: []
toc: auto
---

"Rabak Mode" enables an agent to run continuously — after each heartbeat run completes, a new run is automatically queued. The agent never sleeps between runs until the mode is disabled.

## Configuration

Stored in `runtimeConfig.heartbeat.autoRestart: true` on the agent record (JSONB, no migration required).

## Backend Behavior

| Detail | Value |
|--------|-------|
| Config key | `runtimeConfig.heartbeat.autoRestart` (boolean, default `false`) |
| Parsed by | `parseHeartbeatPolicy()` in `server/src/services/heartbeat.ts` |
| Trigger | After `finalizeAgentStatus()` in both the success path and the catch (failure) path of `executeRun()` |
| Re-queue call | `enqueueWakeup(agent.id, { source: "automation", triggerDetail: "system", reason: "auto_restart" })` |
| Cancellation | Outcome `cancelled` skips the auto-restart in the success path |
| Error safety | Fire-and-forget (`void ...catch(logger.warn)`) — failure to enqueue does not crash the current run |

## UI

### Agent Detail Page

| Element | Behavior |
|---------|----------|
| **Rabak** button (header) | Toggles `autoRestart` via `PATCH /api/agents/:id` with merged `runtimeConfig` |
| Button state OFF | Outline variant, gray Flame icon |
| Button state ON | Orange filled, pulsing Flame icon, label "Rabak ON" |
| Heartbeat row | Shows orange `🔥 Rabak` badge next to interval when enabled |

### Implementation

| File | Role |
|------|------|
| `server/src/services/heartbeat.ts` | `parseHeartbeatPolicy` + auto-restart hooks in `executeRun` |
| `ui/src/pages/AgentDetail.tsx` | `isRabakMode`, `toggleRabakMode` mutation, Flame button, Heartbeat row badge |

## Safety Notes

- Rabak Mode respects `maxConcurrentRuns` — if the agent is already at its run limit, `enqueueWakeup` will coalesce or queue normally
- Paused agents: `enqueueWakeup` throws `conflict` if the agent is paused, which is caught by the `.catch` logger — no infinite loop
- To stop a sprinting agent: either disable Rabak Mode or Pause the agent
- `wakeOnDemand` guard bypass: `enqueueWakeup` normally blocks non-timer sources when `wakeOnDemand` is disabled. Auto-restart bypasses this by setting `reason: "auto_restart"` — agents that only run on schedule still sprint correctly in Rabak Mode.
