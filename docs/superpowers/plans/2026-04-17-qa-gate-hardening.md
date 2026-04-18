# QA Gate Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `done` trustworthy by blocking shipping when the latest QA verdict is incomplete, failing, or missing explicit verification evidence, and by enforcing the same rule in QA-triggered auto-merge.

**Architecture:** Tighten the server-side QA gate in one place, then reuse that gate from both explicit issue status updates and QA comment auto-merge. Keep the UX aligned by extending shared reason codes and updating issue-detail/error copy rather than inventing a new workflow surface.

**Tech Stack:** TypeScript, Express routes/services, Vitest, React

---

### Task 1: Define and lock the stricter gate behavior with tests

**Files:**
- Modify: `server/src/__tests__/qa-gate.test.ts`
- Modify: `server/src/__tests__/issue-qa-gate-routes.test.ts`

- [ ] **Step 1: Write the failing unit tests**
  Add coverage for:
  - latest QA comment missing Smart Review summary blocks shipping
  - latest QA comment with failing Smart Review summary blocks shipping even when `[QA PASS]` and `[RELEASE CONFIRMED]` are present
  - latest QA comment missing verification tokens blocks shipping

- [ ] **Step 2: Run the focused tests to verify they fail**
  Run: `pnpm vitest server/src/__tests__/qa-gate.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts`
  Expected: FAIL on the newly added stricter gate assertions

### Task 2: Implement stricter QA gate evaluation

**Files:**
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `server/src/services/qa-gate.ts`
- Modify: `server/src/routes/issues.ts`

- [ ] **Step 1: Add shared reason codes for the new server-enforced failures**
  Extend `IssueQaGateReasonCode` with explicit reasons for:
  - missing Smart Review summary on the latest QA verdict
  - failing latest QA verdict
  - missing verification evidence on the latest QA verdict

- [ ] **Step 2: Implement minimal gate changes in `qa-gate.ts`**
  Update gate evaluation so shipping depends on the latest QA-authored comment carrying:
  - Smart Review summary tokens
  - non-failing review outcome
  - verification tokens for required repo checks plus smoke status

- [ ] **Step 3: Align comment-triggered auto-merge with the same gate**
  Make QA comment auto-merge call the synthesized QA gate and bail out when `canShip` is false.

- [ ] **Step 4: Run the focused tests to verify they pass**
  Run: `pnpm vitest server/src/__tests__/qa-gate.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts`
  Expected: PASS

### Task 3: Make the new failures legible to operators

**Files:**
- Modify: `ui/src/lib/issue-update-errors.ts`
- Modify: `ui/src/pages/IssueDetail.tsx`

- [ ] **Step 1: Add labels and error copy for the new gate reasons**
  Keep the existing issue detail warning box and mutation error handling, but add strings for the new reason codes.

- [ ] **Step 2: Run targeted UI tests if coverage needs updates**
  Run: `pnpm vitest ui/src/lib/issue-update-errors.test.ts ui/src/lib/qa-gate-presentation.test.ts`
  Expected: PASS

### Task 4: Update QA workflow documentation

**Files:**
- Modify: `server/src/onboarding-assets/qa/AGENTS.md`
- Modify: `doc/SPEC-implementation.md`

- [ ] **Step 1: Document the enforced QA verdict requirements**
  Update QA instructions and the implementation spec so the required summary/verification evidence matches the server gate.

- [ ] **Step 2: Run the repo-required verification**
  Run:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`
  Expected: exit code 0 for all commands, or a precise report of any pre-existing/unrelated failure
