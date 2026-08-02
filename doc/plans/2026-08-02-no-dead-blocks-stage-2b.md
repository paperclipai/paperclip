# No-Dead-Blocks Stage 2b Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with verification after each behavior change.

**Goal:** Add a default-off hourly platform sweep that escalates leaderless or stale blocked issues to the company CEO exactly once per cooldown window.

**Architecture:** A focused server service will reuse `issueService.listBlockerAttention` for the existing blocked-chain classification, persist an anti-spam marker in a system-authored issue comment, and resolve the CEO from the current company agent graph. The existing routine scheduler will invoke the service through an internal action only when the feature flag is enabled; routine runs provide the operator-visible last-run and summary record.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest, existing Paperclip routines and issue services.

---

### Task 1: Candidate and message contracts

**Files:**
- Create: `server/src/services/blocked-issue-escalation.ts`
- Test: `server/src/services/blocked-issue-escalation.test.ts`

- [ ] Write failing unit tests for leaderless, stale, covered, fresh, terminal, and cooldown candidates, plus the CEO mention and point-by-point unblock message.
- [ ] Run the focused test and confirm it fails because the service contract is absent.
- [ ] Implement pure candidate filtering, cooldown marker parsing, CEO resolution, and message construction without database mutation.
- [ ] Run the focused test and confirm it passes.

### Task 2: Company-scoped sweep and persisted escalation

**Files:**
- Modify: `server/src/services/blocked-issue-escalation.ts`
- Modify: `server/src/services/index.ts`
- Test: `server/src/services/blocked-issue-escalation.test.ts`

- [ ] Add a company-scoped sweep that loads blocked issues, asks the existing issue service for blocker attention, reads system escalation markers, and inserts at most the configured per-run batch of system comments.
- [ ] Persist the issue identifier, decision set, decider, and timestamp in the marker so restarts do not duplicate a cooldown-protected escalation.
- [ ] Return companies scanned, candidates found, escalations posted, and cooldown suppressions for routine visibility.
- [ ] Run focused service tests, including company-boundary and duplicate-fire cases.

### Task 3: Hourly routine integration behind a flag

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/services/routines.ts`
- Test: `server/src/__tests__/blocked-issue-escalation-routine.test.ts`

- [ ] Register the internal action handler and only activate the scheduled routine when the explicit default-off feature flag is enabled.
- [ ] Reuse the existing hourly scheduler and routine run finalization so last-run and run summary are visible in the routine register.
- [ ] Verify disabled mode performs no sweep and enabled mode records a completed run summary.

### Task 4: Verification and handoff

**Files:**
- Modify: `doc/execution-semantics.md` only if the new flag or visibility behavior needs documentation.

- [ ] Run focused tests, typecheck, and the token-independent relevant server test suite.
- [ ] Review the diff for company scoping, default-off behavior, and no duplicate comments.
- [ ] Post evidence and route the issue to QA/reviewer; do not enable shared infrastructure.
