# Capability-Blocked Specialist Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make unstaffable specialist workflow lanes self-healing, explicitly visible, and automatically recoverable once staffing exists again.

**Architecture:** Add one canonical capability-block helper for specialist lanes, then reuse it in delivery integrity, heartbeat routing/repair, board state, and board brief generation. Keep the scope on persisted specialist lane requirements so the change is coherent and low-risk.

**Tech Stack:** TypeScript, Vitest, Express services, Drizzle-backed service tests, React board-state presentation helpers

---

### Task 1: Add canonical capability-block classification

**Files:**
- Create: `server/src/services/issue-capability-blocks.ts`
- Test: `server/src/__tests__/issue-capability-blocks.test.ts`

- [ ] **Step 1: Write the failing unit test**
- [ ] **Step 2: Run it and verify the missing helper behavior fails**
- [ ] **Step 3: Implement the minimal specialist-lane helper**
- [ ] **Step 4: Re-run the unit test and confirm green**

### Task 2: Reuse the helper in integrity and heartbeat routing

**Files:**
- Modify: `server/src/services/delivery-integrity.ts`
- Modify: `server/src/services/heartbeat.ts`
- Test: `server/src/__tests__/delivery-integrity.test.ts`
- Test: `server/src/__tests__/operations-heartbeat-routing.test.ts`

- [ ] **Step 1: Add or update failing coverage for capability-blocked routing/integrity behavior**
- [ ] **Step 2: Replace security-only checks with the canonical helper**
- [ ] **Step 3: Keep the repair path auto-unassigning unsupported specialist ownership**
- [ ] **Step 4: Re-run the focused tests**

### Task 3: Surface capability-blocked truth in board state and board brief

**Files:**
- Modify: `server/src/services/issue-board-state.ts`
- Modify: `server/src/services/board-brief.ts`
- Modify: `ui/src/lib/issue-board-state-presentation.ts`
- Modify: `server/src/services/issue-review-items.ts`
- Test: `server/src/__tests__/issue-board-state-service.test.ts`
- Test: `server/src/__tests__/board-brief-service.test.ts`
- Test: `ui/src/components/IssueBoardStatePanel.test.tsx`

- [ ] **Step 1: Add failing coverage for capability-blocked board state**
- [ ] **Step 2: Render explicit capability-blocked board state instead of ready/system-error drift**
- [ ] **Step 3: Reuse the same reason text in board brief attention items**
- [ ] **Step 4: Update UI/presentation copy for the new reason code**
- [ ] **Step 5: Re-run the focused tests**

### Task 4: Documentation and verification

**Files:**
- Modify: `doc/SPEC-implementation.md`

- [ ] **Step 1: Add the missing spec note describing capability-blocked specialist lanes**
- [ ] **Step 2: Run focused verification**
- [ ] **Step 3: Summarize what still could not be verified locally**
