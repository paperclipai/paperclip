# Inbox Archive Affordance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inbox list show explicit `Archive` and `Dismiss` actions in `Needs Action` and `Unread`, while demoting the blue unread dot to a passive status marker so operators stop reading it as the archive affordance.

**Architecture:** Keep the existing inbox composition and gesture shortcuts, but add persistent row-end actions where the archive/dismiss handlers already exist. Preserve the unread state signal while making it passive, keep retry/approve buttons and mobile layout intact, and ensure opening or acting on a row still clears unread state where relevant.

**Tech Stack:** React 19, TypeScript, Vitest, TanStack Query, Tailwind CSS

---

### Task 1: Document The Agreed UI Change

**Files:**
- Create: `docs/superpowers/specs/2026-04-17-inbox-archive-affordance-design.md`
- Create: `docs/superpowers/plans/2026-04-17-inbox-archive-affordance.md`

- [ ] **Step 1: Write the minimal approved design**
- [ ] **Step 2: Record the implementation plan for this session**

### Task 2: Add Failing UI Tests

**Files:**
- Modify: `ui/src/components/IssueRow.test.tsx`
- Modify: `ui/src/pages/Inbox.test.tsx`

- [ ] **Step 1: Add a test proving issue rows show a visible `Archive` action when configured**
- [ ] **Step 2: Add a test proving a non-issue inbox row shows a visible `Dismiss` action**
- [ ] **Step 3: Add a test proving unread renders as a passive indicator rather than a clickable control**
- [ ] **Step 4: Run the focused test command and confirm it fails for the missing affordance change**

### Task 3: Implement Explicit Inbox Actions

**Files:**
- Modify: `ui/src/components/IssueRow.tsx`
- Modify: `ui/src/pages/Inbox.tsx`

- [ ] **Step 1: Extend issue rows to render a persistent `Archive` action and a passive unread indicator**
- [ ] **Step 2: Extend non-issue rows to render persistent `Dismiss` actions in desktop and mobile layouts**
- [ ] **Step 3: Preserve read-state clearing when an unread row is opened or acted on**
- [ ] **Step 4: Pass the correct labels from the inbox page only for tabs with explicit row actions**
- [ ] **Step 5: Run the focused test command and confirm it passes**

### Task 4: Sync The UI Documentation

**Files:**
- Modify: `doc/spec/ui.md`

- [ ] **Step 1: Update the inbox spec to describe the passive unread indicator and explicit `Archive` / `Dismiss` actions in `Needs Action` and `Unread`**

### Task 5: Verify The Change

**Files:**
- Test: `ui/src/components/IssueRow.test.tsx`
- Test: `ui/src/pages/Inbox.test.tsx`

- [ ] **Step 1: Run `pnpm vitest run ui/src/components/IssueRow.test.tsx ui/src/pages/Inbox.test.tsx`**
- [ ] **Step 2: Review the output and only then report the exact verification result**
