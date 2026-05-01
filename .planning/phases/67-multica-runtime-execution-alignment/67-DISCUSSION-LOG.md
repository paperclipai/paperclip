# Phase 67: Multica Runtime Execution Alignment - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-01T12:00:00+09:00
**Phase:** 67-multica-runtime-execution-alignment
**Mode:** auto
**Areas discussed:** Queue state machine, Runtime-aware dispatch, Heartbeat/cancellation/cleanup, Progress/message/tool stream, Work card/Jarvis evidence, DevPlan verification

---

## Queue State Machine

| Option | Description | Selected |
|--------|-------------|----------|
| Migrate canonical state to `dispatched` | Match Multica and Phase 67 success criteria exactly while compatibility-mapping old `claimed` data. | yes |
| Keep `claimed` as canonical | Lower churn, but would leave Phase 67 claiming Multica parity while using a different public state machine. | |
| Add `dispatched` as alias only in UI | Cosmetic fix; service/schema guards would still not prove the desired lifecycle. | |

**Auto choice:** Migrate canonical state to `dispatched`.
**Notes:** Selected because `.planning/ROADMAP.md` and `.planning/REQUIREMENTS.md` explicitly require `queued -> dispatched -> running -> completed/failed/cancelled`.

---

## Runtime-Aware Dispatch

| Option | Description | Selected |
|--------|-------------|----------|
| Add server-owned runtime dispatch path | Runtime/service health and capacity decide which queued attempt moves to `dispatched`. | yes |
| Keep caller-supplied claim | Existing API is simple, but the caller can assert runtime identity without runtime evidence. | |
| Defer dispatch to heartbeat only | Would not close RT2 task execution queue alignment in this phase. | |

**Auto choice:** Add server-owned runtime dispatch path.
**Notes:** Selected because Multica's key difference is runtime-scoped claim with concurrency and stale protection.

---

## Heartbeat, Cancellation, And Cleanup

| Option | Description | Selected |
|--------|-------------|----------|
| Add cancel and stale cleanup evidence | Queued/dispatched/running attempts can be cancelled/reconciled with reason codes and domain events. | yes |
| Only add cancel endpoint | Handles explicit stop but not stale runtime/task cleanup. | |
| Only rely on heartbeat internals | Leaves RT2 execution attempts active when heartbeat/runtime state changes. | |

**Auto choice:** Add cancel and stale cleanup evidence.
**Notes:** Selected because `RUNTIME-02` requires runtime capacity, heartbeat, stale cleanup, and cancellation polling evidence.

---

## Progress, Message, And Tool Stream

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse `heartbeat_run_events` with RT2 timeline read model | Avoids duplicate raw logs while exposing product-facing lifecycle/progress/message/tool evidence. | yes |
| Create a separate RT2 raw stream table | More isolation but duplicates an existing durable stream and increases migration scope. | |
| UI reads heartbeat internals directly | Fast but leaks control-plane implementation details into product components. | |

**Auto choice:** Reuse `heartbeat_run_events` with RT2 timeline read model.
**Notes:** Selected because `heartbeatRunId` is already on RT2 execution attempts and `heartbeat_run_events` already stores sequence, stream, level, message, and payload.

---

## Work Card And Jarvis Evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Extend existing RT2 task/Daily/Jarvis surfaces | Keeps runtime evidence in the daily work loop and preserves RealTycoon2 product identity. | yes |
| Create a Multica runtime page | Would violate the engine/reference boundary and split the cockpit. | |
| Keep runtime evidence server-only | Would not satisfy work card and Jarvis evidence visibility. | |

**Auto choice:** Extend existing RT2 task/Daily/Jarvis surfaces.
**Notes:** Selected from Phase 65 identity boundary and Phase 66 cockpit decisions.

---

## DevPlan Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Gate Multica row on code/route/UI/test anchors | Keeps v3.1 score conservative and evidence-backed. | yes |
| Mark row complete after docs/context only | Would repeat the overclaim problem Phase 65 fixed. | |
| Defer gate update to Phase 71 only | Phase 71 owns final score delta, but Phase 67 should update its own evidence row when complete. | |

**Auto choice:** Gate Multica row on code/route/UI/test anchors.
**Notes:** Selected from Phase 65 completion claim evidence rule.

---

## the agent's Discretion

- Exact compatibility migration path for `claimed` data.
- Exact stale thresholds and runtime freshness defaults, if explicit and tested.
- Exact compact UI placement for timeline evidence.

## Deferred Ideas

- Full external Multica daemon import or remote worker marketplace.
- wikiLLM, Graphify v3, economy loop, and final v3.1 acceptance gate work.
