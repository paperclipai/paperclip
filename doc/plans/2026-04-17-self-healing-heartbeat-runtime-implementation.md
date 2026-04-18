# Self-Healing Heartbeat Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing heartbeat runtime self-healing by default for lost and transiently failed runs without adding external queue infrastructure.

**Architecture:** Extend the current `heartbeat.ts` control loop instead of introducing a second recovery system. Reuse the existing retry metadata and retry-circuit tables, move liveness onto a dedicated `lastActivityAt` lease timestamp, and only surface failed runs in Inbox once recovery is terminal.

**Tech Stack:** TypeScript, Drizzle, Express services, Vitest, React

---

### Task 1: Document The Approved Runtime Contract

**Files:**
- Modify: `doc/spec/agents-runtime.md`
- Reference: `doc/plans/2026-04-17-self-healing-heartbeat-runtime-design.md`

- [ ] Add the self-healing runtime rules for suspect/lost detection, same-issue retry, and selective operator visibility.
- [ ] Keep the wording aligned with the existing same-issue recovery and ownership-correction rules.

### Task 2: Write Failing Recovery Tests

**Files:**
- Modify: `server/src/__tests__/heartbeat-process-recovery.test.ts`
- Modify: `ui/src/lib/inbox.test.ts`

- [ ] Add a failing server test for suspect-before-lost behavior.
- [ ] Add a failing server test for retry-state metadata on automatic process-loss recovery.
- [ ] Add a failing server test for adapter-level retry blocking after repeated transient loss.
- [ ] Add a failing server test for fresh dispatch pausing while an adapter circuit is open.
- [ ] Add a failing server test for thrown transient adapter failures that should still auto-retry.
- [ ] Add a failing UI test proving Inbox hides failed runs while `retryState` is `scheduled` or `retrying`.

### Task 3: Implement Heartbeat Self-Healing Control Loop

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/services/heartbeat-run-limit.ts`

- [ ] Refresh run activity timestamps from logs, events, process metadata, and explicit run activity reports.
- [ ] Mark stale runs as suspect before declaring them lost.
- [ ] Rework automatic retry planning to populate retry metadata consistently.
- [ ] Gate automatic recovery behind the existing `heartbeat_retry_circuits` table.
- [ ] Mark retry attempts as `retrying`, `recovered`, `blocked`, `exhausted`, or `non_retriable` as appropriate.

### Task 4: Surface Only Terminal Failed Runs

**Files:**
- Modify: `ui/src/lib/inbox.ts`

- [ ] Filter failed runs so Inbox ignores runs that are still self-healing.
- [ ] Keep the latest-failed-run-by-agent behavior intact for terminal recovery states.

### Task 5: Verify

**Files:**
- None

- [ ] Run targeted heartbeat recovery tests.
- [ ] Run targeted inbox tests.
- [ ] Run `pnpm --filter @paperclipai/server typecheck`.
- [ ] Run `pnpm build`.
- [ ] Report any unrelated existing failures instead of masking them.
