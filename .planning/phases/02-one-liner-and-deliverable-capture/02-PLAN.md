# Phase 2: One-Liner and Deliverable Capture

**Phase:** 2
**Status:** In execution
**Created:** 2026-04-24
**Requirements:** LOG-01, LOG-02, ECON-01

## Goal

Turn the RT2 One-Liner into a real operator input loop: accept one freeform work input, parse it deterministically into a compact structured draft, require deliverable and base-price review, and commit without dropping the user back into the large Paperclip issue dialog.

---

## Wave 1: Contract and Persistence Truth

### PLAN-01: Deliverable Contract with Base Price

**Objective:** Make RT2 deliverables carry base-price data across shared contracts, API payloads, and persisted metadata.

**Files Modified:**
- `packages/shared/src/validators/rt2-task.ts`
- `packages/shared/src/types/rt2-task.ts`
- `packages/shared/src/rt2-task.test.ts`
- `server/src/services/rt2-task-engine.ts`
- `server/src/__tests__/rt2-task-routes.test.ts`
- `ui/src/api/rt2-tasks.ts`

**Tasks:**

```yaml
- id: rt2-deliverable-contract
  objective: Require base-price data in RT2 deliverable inputs
  depends_on: []
  files_modified:
    - packages/shared/src/validators/rt2-task.ts
    - packages/shared/src/types/rt2-task.ts
    - packages/shared/src/rt2-task.test.ts
    - server/src/services/rt2-task-engine.ts
    - server/src/__tests__/rt2-task-routes.test.ts
    - ui/src/api/rt2-tasks.ts
  read_first:
    - packages/shared/src/validators/rt2-task.ts
    - packages/shared/src/types/rt2-task.ts
    - server/src/services/rt2-task-engine.ts
    - server/src/__tests__/rt2-task-routes.test.ts
    - .planning/phases/02-one-liner-and-deliverable-capture/02-CONTEXT.md
  action: |
    Update the RT2 task/todo contract so deliverables carry required base-price data.
    Persist the value in deliverable metadata instead of inventing a new ledger model in Phase 2.
    Keep company scope and existing task/todo APIs intact.
  acceptance_criteria:
    - "packages/shared/src/validators/rt2-task.ts defines basePrice on deliverable input"
    - "server/src/services/rt2-task-engine.ts persists the base-price into RT2 deliverable metadata"
    - "pnpm exec vitest run packages/shared/src/rt2-task.test.ts exits 0"
    - "pnpm exec vitest run server/src/__tests__/rt2-task-routes.test.ts exits 0"
```

---

## Wave 2: One-Liner Draft Surface

### PLAN-02: Deterministic Draft Parser and Review Surface

**Objective:** Replace the Phase 1 placeholder page with a real freeform-input draft flow.

**Files Modified:**
- `ui/src/pages/rt2/OneLinerPage.tsx`
- `ui/src/lib/one-liner-draft.ts` (new)
- `ui/src/lib/one-liner-draft.test.ts` (new)

**Tasks:**

```yaml
- id: one-liner-draft-surface
  objective: Build deterministic parse plus compact review on the One-Liner page
  depends_on: [rt2-deliverable-contract]
  files_modified:
    - ui/src/pages/rt2/OneLinerPage.tsx
    - ui/src/lib/one-liner-draft.ts
    - ui/src/lib/one-liner-draft.test.ts
  read_first:
    - ui/src/pages/rt2/OneLinerPage.tsx
    - ui/src/components/NewIssueDialog.tsx
    - ui/src/api/rt2-tasks.ts
    - .planning/phases/02-one-liner-and-deliverable-capture/02-CONTEXT.md
  action: |
    Rebuild the One-Liner page so it:
    - accepts one freeform input
    - parses it deterministically into task, todo-intent, daily-log, deliverable title, and base-price draft fields
    - surfaces warnings when deliverable/base-price data is missing or ambiguous
    - lets the user review and edit the compact draft inline
    - commits the reviewed draft through RT2 task creation instead of reopening the legacy issue dialog
  acceptance_criteria:
    - "ui/src/lib/one-liner-draft.ts exports a deterministic parse helper"
    - "ui/src/pages/rt2/OneLinerPage.tsx renders a freeform input and compact structured draft review"
    - "pnpm exec vitest run ui/src/lib/one-liner-draft.test.ts exits 0"
```

---

## Wave 3: Global Entry Unification

### PLAN-03: Route, Shortcut, and Quick-Create Alignment

**Objective:** Make the One-Liner route the single global entry point from shell actions.

**Files Modified:**
- `ui/src/components/Sidebar.tsx`
- `ui/src/components/CommandPalette.tsx`
- `ui/src/components/Layout.tsx`
- `ui/src/components/KeyboardShortcutsCheatsheet.tsx`

**Tasks:**

```yaml
- id: one-liner-global-entry
  objective: Route all global work-entry affordances into the same One-Liner flow
  depends_on: [one-liner-draft-surface]
  files_modified:
    - ui/src/components/Sidebar.tsx
    - ui/src/components/CommandPalette.tsx
    - ui/src/components/Layout.tsx
    - ui/src/components/KeyboardShortcutsCheatsheet.tsx
  read_first:
    - ui/src/components/Sidebar.tsx
    - ui/src/components/CommandPalette.tsx
    - ui/src/components/Layout.tsx
    - ui/src/hooks/useKeyboardShortcuts.ts
    - .planning/phases/02-one-liner-and-deliverable-capture/02-CONTEXT.md
  action: |
    Make the RT2 One-Liner route the single work-entry flow for:
    - sidebar "Log Work"
    - command palette "Log work"
    - keyboard shortcut C
    Keep company-prefixed routing and shell memory intact.
  acceptance_criteria:
    - "Sidebar log-work action routes to /one-liner"
    - "Command palette log-work action routes to /one-liner"
    - "Layout keyboard shortcut handler opens the One-Liner flow instead of NewIssueDialog"
```

---

## Wave 4: Backward-Compatible RT2 Dialog Path

### PLAN-04: RT2 Dialog Base-Price Backfill

**Objective:** Keep project-scoped RT2 task/todo creation truthful while the One-Liner becomes primary.

**Files Modified:**
- `ui/src/components/NewIssueDialog.tsx`
- `ui/src/components/NewIssueDialog.test.tsx`

**Tasks:**

```yaml
- id: rt2-dialog-backfill
  objective: Require deliverable base price in the remaining RT2 dialog flow
  depends_on: [rt2-deliverable-contract]
  files_modified:
    - ui/src/components/NewIssueDialog.tsx
    - ui/src/components/NewIssueDialog.test.tsx
  read_first:
    - ui/src/components/NewIssueDialog.tsx
    - ui/src/components/NewIssueDialog.test.tsx
    - .planning/phases/02-one-liner-and-deliverable-capture/02-CONTEXT.md
  action: |
    Add the minimum RT2-only base-price capture needed so the old project-level dialog
    no longer creates deliverable-aware RT2 tasks/todos without economic input.
    Do not expand the legacy dialog into the primary One-Liner experience.
  acceptance_criteria:
    - "ui/src/components/NewIssueDialog.tsx requires deliverable title and base price for RT2 task/todo submission"
    - "pnpm exec vitest run ui/src/components/NewIssueDialog.test.tsx exits 0"
```

---

## Wave 5: Verification

### PLAN-05: Verification and Regression Check

**Objective:** Verify the new One-Liner flow, shared contract, and global entry unification.

**Tasks:**

```yaml
- id: verify-targeted-ui
  objective: Run targeted UI and contract tests
  depends_on: [rt2-deliverable-contract, one-liner-draft-surface, one-liner-global-entry, rt2-dialog-backfill]
  command: pnpm exec vitest run packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts ui/src/lib/one-liner-draft.test.ts ui/src/components/NewIssueDialog.test.tsx
  acceptance_criteria:
    - "pnpm exec vitest run packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts ui/src/lib/one-liner-draft.test.ts ui/src/components/NewIssueDialog.test.tsx exits 0"

- id: verify-typecheck
  objective: Run monorepo typecheck
  depends_on: [verify-targeted-ui]
  command: pnpm -r typecheck
  acceptance_criteria:
    - "pnpm -r typecheck exits 0"

- id: verify-tests
  objective: Run default test suite
  depends_on: [verify-typecheck]
  command: pnpm test:run
  acceptance_criteria:
    - "pnpm test:run exits 0"

- id: verify-build
  objective: Build the app
  depends_on: [verify-tests]
  command: pnpm build
  acceptance_criteria:
    - "pnpm build exits 0"
```

---

## Dependency Order

```text
Wave 1:
  PLAN-01 Deliverable Contract with Base Price

Wave 2:
  PLAN-01 -> PLAN-02 Deterministic Draft Parser and Review Surface

Wave 3:
  PLAN-02 -> PLAN-03 Route, Shortcut, and Quick-Create Alignment

Wave 4:
  PLAN-01 -> PLAN-04 RT2 Dialog Base-Price Backfill

Wave 5:
  PLAN-01 + PLAN-02 + PLAN-03 + PLAN-04 -> PLAN-05 Verification
```

---

## Existing Reference Assets

| File | Why it matters |
|------|----------------|
| `ui/src/pages/rt2/OneLinerPage.tsx` | Current placeholder RT2 input page |
| `ui/src/components/NewIssueDialog.tsx` | Existing RT2 task/todo creation path and field contract |
| `ui/src/components/Sidebar.tsx` | Primary shell "Log Work" entry |
| `ui/src/components/CommandPalette.tsx` | Global keyboard-first entry |
| `ui/src/components/Layout.tsx` | Keyboard shortcut routing |
| `packages/shared/src/validators/rt2-task.ts` | RT2 task/todo API contract |
| `server/src/services/rt2-task-engine.ts` | RT2 deliverable persistence |
| `server/src/__tests__/rt2-task-routes.test.ts` | Server-side RT2 contract verification |
