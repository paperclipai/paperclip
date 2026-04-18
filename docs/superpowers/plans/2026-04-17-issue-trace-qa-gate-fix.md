# Issue Trace And QA Gate Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make issue timelines stop showing fake `None -> done` transitions, and make the `in_review -> done` gate enforce the canonical QA closer contract.

**Architecture:** Keep the existing issue activity model, but make no-op issue patches idempotent at the route/service boundary so they do not emit misleading `issue.updated` events. Keep the current QA routing flow, but replace the broad "any QA agent" closer rule with a single resolved release-gate QA owner and harden the UI timeline parser so old malformed events are ignored.

**Tech Stack:** Express, TypeScript, Drizzle ORM, React, Vitest, Supertest

---

### Task 1: Add Regression Tests For Bad Trace Inputs

**Files:**
- Modify: `server/src/__tests__/issue-comment-reopen-routes.test.ts`
- Modify: `server/src/__tests__/issue-qa-gate-routes.test.ts`
- Modify: `ui/src/lib/issue-timeline-events.test.ts`

- [ ] **Step 1: Add a route test proving a no-op `status: "done"` patch does not log `issue.updated`**
- [ ] **Step 2: Add route tests proving only the resolved release-gate QA owner can move `in_review` work to `done`**
- [ ] **Step 3: Add a timeline test proving malformed legacy `issue.updated` rows with no previous status are ignored**
- [ ] **Step 4: Run the focused test command and confirm the new expectations fail against the current code**

### Task 2: Make Issue Updates Idempotent

**Files:**
- Modify: `server/src/routes/issues.ts`
- Modify: `server/src/services/issues.ts`

- [ ] **Step 1: Compute effective field deltas after normalization instead of logging raw request fields**
- [ ] **Step 2: Skip `issue.updated` activity writes when the patch produces no persisted change**
- [ ] **Step 3: Preserve reopen, interrupt, and real status-transition activity details**
- [ ] **Step 4: Run the focused route test command and confirm the no-op status test passes**

### Task 3: Enforce The Canonical QA Release Gate

**Files:**
- Modify: `server/src/routes/issues.ts`
- Modify: `server/src/__tests__/issue-qa-gate-routes.test.ts`

- [ ] **Step 1: Add a helper that resolves the single release-gate QA agent, preferring `QA and Release Engineer`**
- [ ] **Step 2: Use that helper for `in_review` routing and `done` validation instead of raw `role === "qa"` checks**
- [ ] **Step 3: Keep a compatibility fallback only when there is exactly one healthy QA agent and no canonical agent**
- [ ] **Step 4: Run the focused QA gate test command and confirm the new closer rules pass**

### Task 4: Harden Timeline Parsing For Old Bad Events

**Files:**
- Modify: `ui/src/lib/issue-timeline-events.ts`
- Modify: `ui/src/lib/issue-timeline-events.test.ts`

- [ ] **Step 1: Ignore status events that lack both `_previous.status` and `reopenedFrom`**
- [ ] **Step 2: Keep valid reopen and assignee events unchanged**
- [ ] **Step 3: Run the focused UI test command and confirm malformed legacy events are filtered**

### Task 5: Sync Documentation And Verify

**Files:**
- Modify: `doc/SPEC-implementation.md`

- [ ] **Step 1: Update the V1 workflow contract so the QA closer rule matches the implementation**
- [ ] **Step 2: Run `pnpm vitest run server/src/__tests__/issue-comment-reopen-routes.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts ui/src/lib/issue-timeline-events.test.ts`**
- [ ] **Step 3: If the focused tests pass, run `pnpm -r typecheck` and review the exact result before reporting status**
