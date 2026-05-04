# Phase 78: Multica Runtime Alignment - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the analysis.

**Date:** 2026-05-04
**Phase:** 78-multica-runtime-alignment
**Mode:** auto

---

## Auto-Selected Decisions

### Queue State Machine (Phase 67 Carry-Forward)
- **[auto]** `claimed` → `dispatched` alias mapping via `normalizeExecutionState()` — Selected: recommended default (Phase 67 D-01/D-02)

### Runtime-Aware Dispatch (Phase 67 Carry-Forward)
- **[auto]** Runtime capacity and health checks in dispatch path — Selected: recommended default (Phase 67 D-04/D-05)

### Heartbeat, Cancellation, And Cleanup (Phase 67 Carry-Forward)
- **[auto]** Cancellation emits `rt2.execution.cancelled` with idempotency key — Selected: recommended default (Phase 67 D-06)
- **[auto]** Stale dispatched/running cleanup with stable reason code — Selected: recommended default (Phase 67 D-07)
- **[auto]** Stale queued cleanup for terminal-state tasks — Selected: recommended default (Phase 67 D-08)

### Progress, Message, And Tool Stream (Phase 67 Carry-Forward)
- **[auto]** `heartbeat_run_events` reused as durable stream for timeline — Selected: recommended default (Phase 67 D-09)
- **[auto]** Timeline route exposing execution evidence by task/attempt — Selected: recommended default (Phase 67 D-10)

### Work Card And Jarvis Evidence Surfaces (Phase 67 Carry-Forward)
- **[auto]** Work cards show execution state, executor/runtime, freshness, failure reason, progress — Selected: recommended default (Phase 67 D-11)
- **[auto]** `claimed` → `dispatched` mapping in Jarvis surfaces (line 586) — Selected: recommended default (Phase 67 D-12)

---

## Gray Areas Auto-Resolved

All gray areas for Phase 78 were resolved via `--auto` mode, applying Phase 67 decisions as defaults:

1. **claimed vs dispatched distinction** — Phase 67 established `claimed` is a compatibility alias. Auto-resolved with `normalizeExecutionState()` as the implementation.
2. **Runtime dispatch capacity enforcement** — Phase 67 specified it. Auto-resolved as existing implementation or gap to verify.
3. **Stale cleanup evidence** — Phase 67 specified cleanup with observable evidence. Auto-resolved as verification-required.
4. **Timeline route existence** — Phase 67 specified API timeline exposure. Auto-resolved as route must exist and be tested.
5. **Jarvis claimed→dispatched mapping** — Phase 67 already showed this at line 586 of rt2-jarvis.ts. Auto-resolved as confirmed correct.

---

## the agent's Discretion

- Exact migration strategy for `claimed` to `dispatched` in CHECK constraint — alias at read time is approved
- Exact stale thresholds — agent discretion, must be explicit and test-covered
- Exact UI placement — agent discretion, must expose required evidence
- New tests vs validating existing tests — agent discretion

---

*Phase: 78-multica-runtime-alignment*
*Context gathered: 2026-05-04*
*Mode: auto (--auto --chain)*
