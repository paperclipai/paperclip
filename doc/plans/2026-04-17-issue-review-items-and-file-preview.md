# Issue Review Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a review-board-first issue detail surface that promotes detectable issue items into ranked review cards, adds compact inline item rendering in comments, and supports safe preview of referenced workspace files.

**Architecture:** Add a server-side review-item extraction layer on top of issue detail, expose a bounded file preview endpoint for project-local paths, and render the new normalized item model in both the issue board and the comment thread. Keep extraction logic server-owned so grouping, dedupe, provenance, and fallback states stay consistent across surfaces.

**Tech Stack:** Express, TypeScript, React, TanStack Query, Vitest, existing issue/document/work-product APIs

---

## File Map

- Modify: `packages/shared/src/types/issue.ts`
  Add shared review item and file preview types to the issue contract.
- Modify: `ui/src/api/issues.ts`
  Add issue review item and file preview client methods.
- Create: `server/src/services/issue-review-items.ts`
  Parse issue data sources, normalize/dedupe/group/rank review items, and resolve first-class source references.
- Modify: `server/src/routes/issues.ts`
  Return review items on issue detail and add bounded file preview route.
- Modify: `server/src/routes/issues.ts` or create helper module under `server/src/routes/`
  Implement safe path resolution for issue-scoped file previews.
- Create: `server/src/__tests__/issue-review-items.test.ts`
  Cover parser, dedupe, grouping, ranking, and fallback states.
- Create: `server/src/__tests__/issue-file-preview-route.test.ts`
  Cover traversal rejection, scoping, and text/image preview behavior.
- Create: `ui/src/lib/review-items.ts`
  Small UI helpers for card labeling, action prioritization, and display grouping.
- Create: `ui/src/lib/review-items.test.ts`
  Cover UI grouping and helper logic.
- Create: `ui/src/components/IssueReviewBoard.tsx`
  Render the top-of-page board and card groups.
- Create: `ui/src/components/IssueReviewItemDrawer.tsx`
  Shared detail drawer for board cards and inline chips, owned by `IssueDetail.tsx`.
- Modify: `ui/src/components/IssueChatThread.tsx`
  Render compact inline detected items beneath comment bodies.
- Modify: `ui/src/pages/IssueDetail.tsx`
  Own review-item selection state, place the board above the thread, and wire the shared drawer.
- Modify: `ui/src/lib/queryKeys.ts`
  Add a stable query key for issue-scoped file previews if the drawer fetches them via React Query.
- Create: `ui/src/components/IssueReviewBoard.test.tsx`
  Cover board rendering, collapsed hidden context, and interaction wiring.
- Modify: `ui/src/components/IssueChatThread.test.tsx`
  Cover inline chips and source navigation behavior.
- Modify: `doc/PRODUCT.md`
  Document output-first review surfaces more explicitly if behavior changes materially.
- Modify: `doc/SPEC-implementation.md`
  Document issue detail review-board behavior and supported preview sources.
- Modify: `doc/DEVELOPING.md`
  Document the safe file preview behavior if it affects local review workflows.

## Task 1: Add Shared Review Item Types

**Files:**
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `ui/src/api/issues.ts`
- Test: `ui/src/api/issues.test.ts`

- [ ] **Step 1: Write the failing type/API contract test**

Add or extend a test that expects issue detail payload handling to include typed `reviewItems` and file preview API helpers.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui test -- --run ui/src/api/issues.test.ts`
Expected: FAIL because the new fields/helpers do not exist yet.

- [ ] **Step 3: Add minimal shared types**

Define `IssueReviewItem`, `IssueReviewItemSourceRef`, grouped enums, and bounded file preview response types in `packages/shared/src/types/issue.ts`, then wire UI API helpers in `ui/src/api/issues.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui test -- --run ui/src/api/issues.test.ts`
Expected: PASS.

## Task 2: Build Server-Side Review Item Extraction

**Files:**
- Create: `server/src/services/issue-review-items.ts`
- Modify: `server/src/routes/issues.ts`
- Test: `server/src/__tests__/issue-review-items.test.ts`

- [ ] **Step 1: Write the failing extraction tests**

Cover:
- markdown links/images
- plain URLs
- workspace file paths like `ops/cocktail-machine-sale/listing-templates/wallapop.txt`
- known marketplace links
- dedupe across repeated mentions
- grouping into `review_now`, `references`, and `hidden_context`

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test -- --run server/src/__tests__/issue-review-items.test.ts`
Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement minimal extractor**

Create a focused service that:
- accepts issue description/comments/attachments/documents/work products
- emits normalized items with source refs
- dedupes by canonical URL/path/first-class source id
- applies grouping/ranking rules
- preserves unavailable/missing states

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter server test -- --run server/src/__tests__/issue-review-items.test.ts`
Expected: PASS.

## Task 3: Expose Review Items on Issue Detail

**Files:**
- Modify: `server/src/routes/issues.ts`
- Modify: `server/src/__tests__/issues-goal-context-routes.test.ts` or create route-focused issue detail test

- [ ] **Step 1: Write the failing route test**

Assert that `GET /api/issues/:id` returns `reviewItems` built from issue data and preserves company scoping.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test -- --run server/src/__tests__/issues-goal-context-routes.test.ts`
Expected: FAIL because `reviewItems` is missing.

- [ ] **Step 3: Implement route wiring**

Call the extractor from issue detail assembly, passing the existing issue, comments/documents/attachments/work products as needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter server test -- --run server/src/__tests__/issues-goal-context-routes.test.ts`
Expected: PASS.

## Task 4: Add Safe Workspace File Preview Route

**Files:**
- Modify: `server/src/routes/issues.ts`
- Create: `server/src/__tests__/issue-file-preview-route.test.ts`

- [ ] **Step 1: Write the failing preview route tests**

Cover:
- text preview under project root
- image preview metadata under project root
- traversal rejection
- missing file fallback
- issue without project/codebase rejection
- company access enforcement

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test -- --run server/src/__tests__/issue-file-preview-route.test.ts`
Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement minimal safe preview route**

Add a bounded endpoint like `GET /api/issues/:id/file-preview?path=...` that:
- resolves only inside the issue project `effectiveLocalFolder`
- caps preview bytes
- classifies text/image/unsupported
- returns structured fallback states

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter server test -- --run server/src/__tests__/issue-file-preview-route.test.ts`
Expected: PASS.

## Task 5: Add UI Review Item Helpers

**Files:**
- Create: `ui/src/lib/review-items.ts`
- Create: `ui/src/lib/review-items.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Cover display grouping, action ordering, compact card labels, and hidden-context collapse behavior.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui test -- --run ui/src/lib/review-items.test.ts`
Expected: FAIL because helpers do not exist.

- [ ] **Step 3: Implement minimal helpers**

Keep the file small and purely presentational.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui test -- --run ui/src/lib/review-items.test.ts`
Expected: PASS.

## Task 6: Render the Review Board

**Files:**
- Create: `ui/src/components/IssueReviewBoard.tsx`
- Create: `ui/src/components/IssueReviewItemDrawer.tsx`
- Create: `ui/src/components/IssueReviewBoard.test.tsx`
- Modify: `ui/src/pages/IssueDetail.tsx`

- [ ] **Step 1: Write the failing component test**

Assert that:
- the board renders above the thread
- groups appear in order
- hidden context is collapsed
- clicking a card opens drawer content

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui test -- --run ui/src/components/IssueReviewBoard.test.tsx`
Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement minimal board**

Render:
- full-width board
- `Review now`, `References`, `Hidden context`
- compact card variants by item kind
- card selection callbacks into shared page state

- [ ] **Step 4: Implement shared drawer + page wiring**

Place the board above the chat/activity tabs, keep selection state in `IssueDetail.tsx`, and render one shared right-side drawer used by both the board and inline chips.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter ui test -- --run ui/src/components/IssueReviewBoard.test.tsx`
Expected: PASS.

## Task 7: Add Compact Inline Comment Item Rendering

**Files:**
- Modify: `ui/src/components/IssueChatThread.tsx`
- Modify: `ui/src/components/IssueChatThread.test.tsx`

- [ ] **Step 1: Write the failing inline rendering tests**

Assert that:
- detected items can appear as compact chips/cards beneath the comment body
- clicking inline items opens the same drawer or source navigation

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui test -- --run ui/src/components/IssueChatThread.test.tsx`
Expected: FAIL because inline item rendering is missing.

- [ ] **Step 3: Implement minimal inline rendering**

Keep comment prose readable. Do not fully expand previews inline by default.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui test -- --run ui/src/components/IssueChatThread.test.tsx ui/src/components/MarkdownBody.test.tsx`
Expected: PASS.

## Task 8: Update Docs

**Files:**
- Modify: `doc/PRODUCT.md`
- Modify: `doc/SPEC-implementation.md`
- Modify: `doc/DEVELOPING.md`

- [ ] **Step 1: Update product/spec docs**

Document:
- review-board-first issue detail behavior
- detectable item classes
- safe file preview constraints

- [ ] **Step 2: Verify docs reflect implementation**

Manually compare route names, behavior, and limits against the code.

## Task 9: Full Verification

**Files:**
- Modify: any touched files as needed

- [ ] **Step 1: Run focused server tests**

Run: `pnpm --filter server test -- --run server/src/__tests__/issue-review-items.test.ts server/src/__tests__/issue-file-preview-route.test.ts server/src/__tests__/issues-goal-context-routes.test.ts`

- [ ] **Step 2: Run focused UI tests**

Run: `pnpm --filter ui test -- --run ui/src/components/IssueReviewBoard.test.tsx ui/src/components/IssueChatThread.test.tsx ui/src/components/MarkdownBody.test.tsx ui/src/lib/review-items.test.ts`

- [ ] **Step 3: Run repo-required verification**

Run:
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

- [ ] **Step 4: Manually inspect the issue detail page**

Open the local app and verify the issue detail flow using a real issue such as `ATHA-15`.

- [ ] **Step 5: Summarize actual results**

Record any commands not run, failures, or scope adjustments before hand-off.
