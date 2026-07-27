# LAB-39 — Agent Manager development log

**Branch:** `feature/LAB-39-agent-manager`  
**Upstream:** `paperclipai/paperclip` (`server/src/services/agent-manager/`)

## Context

Implements event-driven Agent Manager supervision per approved tech design ([LAB-40](/LAB/issues/LAB-40)).

## Decisions

1. **Service module layout** — `gates`, `evaluate`, `reflection`, `escalation`, `service` per tech design §2.1.
2. **Judge invoker** — Injectable `invokeJudge` for tests; default production invoker is a stub until LAB-42 enables supervisor agent + model wiring.
3. **Presentation** — Issue comments use `system_notice` presentation (existing schema) with structured metadata sections.
4. **Hook placement** — Fire-and-forget from heartbeat finalization after successful-run handoff and adapter-failure finalization paths.
5. **Wake payload** — `buildPaperclipWakePayload` extended with `agentManagerReflection` / `agentManagerEscalation` blocks.

## Progress

- [x] DB migration `0193_agent_manager_foundation` (settings, supervision state, evaluations)
- [x] `agentManagerService` orchestration + activity log actions
- [x] Heartbeat hooks on terminal runs
- [x] Unit + integration tests
- [ ] PR opened on `paperclipai/paperclip`

## Verification

```bash
cd packages/db && pnpm run check:migrations
pnpm --filter @paperclipai/server exec vitest run src/services/agent-manager
```

## Edge cases

- Company `enabled=false` by default — no judge spend until explicitly enabled.
- Recovery-owned issues skip evaluation (gate #5).
- Judge invocation failure after retry escalates (AC-4).
- Parse failures record `judge_error` and fail open (no reflection).
