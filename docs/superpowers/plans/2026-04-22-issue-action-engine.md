# Issue Action Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace status-patch and free-form comment workflow control with a canonical server-side issue action engine, while preserving compatibility through adapter routes during migration.

**Architecture:** Add shared typed issue action contracts, implement a server-side issue action engine that owns high-risk review and QA transitions, expose `POST /issues/:id/actions`, and route legacy `PATCH /issues/:id` and `POST /issues/:id/comments` workflow mutations through that engine instead of enforcing rules inline.

**Tech Stack:** TypeScript, Express, Zod, existing issue services, React/Vite issue API client, Vitest

---

### Task 1: Lock the action contract in tests first

**Files:**
- Create: `server/src/services/issue-actions.test.ts`
- Modify: `server/src/__tests__/issues-routes.test.ts` or the closest route coverage file for issue mutations
- Modify: `packages/shared/src/types/issue.ts` or create a dedicated shared action types module

- [ ] **Step 1: Add failing engine tests for the high-risk actions**
  Cover:
  - `enter_review` succeeds only from valid source states
  - `complete_issue` rejects when QA gate requirements are not satisfied
  - `reopen_issue` reopens closed issues to the expected non-terminal state
  - `append_note` does not change workflow state

- [ ] **Step 2: Add failing QA verdict action tests**
  Cover:
  - structured `submit_qa_verdict` accepts valid PASS verdict data
  - missing required verdict fields are rejected before mutation
  - passing verdicts generate canonical audit comment text
  - failing or incomplete verdicts do not silently complete the issue

- [ ] **Step 3: Add failing compatibility-route tests**
  Cover:
  - `PATCH /issues/:id` with `status=in_review` calls the engine
  - `PATCH /issues/:id` with `status=done` calls the engine and returns the engine error surface
  - `POST /issues/:id/comments` with legacy QA marker content maps to `submit_qa_verdict`
  - plain comments still behave as note-only writes

### Task 2: Add shared typed issue action contracts

**Files:**
- Create: `packages/shared/src/types/issue-actions.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: any shared validators/constants export surface needed by the server and UI

- [ ] **Step 1: Define the action type union**
  Add:
  - `IssueActionType`
  - `IssueActionRequest`
  - `IssueActionResult`
  - payload types for `enter_review`, `submit_qa_verdict`, `complete_issue`, `reopen_issue`, and `append_note`

- [ ] **Step 2: Add request validation helpers**
  Centralize payload validation so both the server route and any UI caller can rely on the same action schema.

- [ ] **Step 3: Export the new action contract from the shared package**
  Keep server and UI imports on one shared source of truth.

### Task 3: Implement the server-side issue action engine

**Files:**
- Create: `server/src/services/issue-actions.ts`
- Modify: `server/src/services/index.ts`
- Modify: any existing QA or issue workflow services only where the engine should delegate instead of duplicate behavior

- [ ] **Step 1: Build the engine entrypoint**
  Add a service API that accepts:
  - the current issue
  - actor context
  - typed action request
  and returns a normalized action result with updated issue state and any generated comment/activity side effects.

- [ ] **Step 2: Centralize validation for the initial action family**
  The engine should own:
  - transition validation
  - QA gate validation for typed verdicts
  - actor/permission checks specific to workflow mutation
  - canonical audit comment generation

- [ ] **Step 3: Reuse existing side-effect services instead of cloning logic**
  Delegate to current issue/QA services where that preserves behavior, but keep the engine as the only owner of workflow decision-making for the migrated actions.

### Task 4: Expose the typed action route

**Files:**
- Modify: `server/src/routes/issues.ts`
- Modify: shared route schema exports if they exist for issue APIs

- [ ] **Step 1: Add `POST /issues/:id/actions`**
  Validate the shared action request, load the issue, assert company access, call the engine, and return a normalized response.

- [ ] **Step 2: Keep route handlers thin**
  Avoid embedding workflow-specific business rules in the new route. If a rule is needed for a migrated action, it belongs in the engine.

### Task 5: Convert legacy routes into engine adapters

**Files:**
- Modify: `server/src/routes/issues.ts`

- [ ] **Step 1: Route high-risk status mutations through the engine**
  Map:
  - `status=in_review` to `enter_review`
  - `status=done` to `complete_issue`
  - reopen flows to `reopen_issue`

- [ ] **Step 2: Route workflow-affecting comments through the engine**
  Map:
  - legacy QA verdict comments to `submit_qa_verdict`
  - non-workflow comments to `append_note`

- [ ] **Step 3: Preserve compatibility without preserving duplicate logic**
  Legacy routes may translate inputs, but they must not re-implement the engine’s transition rules.

### Task 6: Update the UI/shared client surface

**Files:**
- Modify: `ui/src/api/issues.ts`
- Modify: issue detail flows that currently rely on raw status mutation or comment-authored workflow control

- [ ] **Step 1: Add a typed issue action client**
  Expose a client helper for `POST /issues/:id/actions`.

- [ ] **Step 2: Move at least one primary workflow path to typed actions**
  Prefer the issue detail review/QA flow first so the highest-risk operator path stops depending on legacy adapters immediately.

### Task 7: Update product and engineering docs

**Files:**
- Modify: `doc/SPEC-implementation.md`
- Modify: any agent/onboarding docs that currently instruct callers to encode workflow state in free-form prose

- [ ] **Step 1: Document the canonical action-engine workflow surface**
  Clarify that typed issue actions are the long-term control path and legacy status/comment workflow mutations are compatibility behavior during migration.

- [ ] **Step 2: Document any remaining legacy expectations explicitly**
  If compatibility parsing still exists, note it as transitional rather than normative behavior.

### Task 8: Verify the migration slice

**Files:**
- Modify only if verification exposes real fallout from the implementation above

- [ ] **Step 1: Run focused tests for the new engine and adapted routes**
  Run the issue action service and route tests added in Tasks 1 through 5.

- [ ] **Step 2: Run repo verification**
  Run:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`
  Expected: exit code 0 for all commands, or a precise report of any unrelated/pre-existing failure
