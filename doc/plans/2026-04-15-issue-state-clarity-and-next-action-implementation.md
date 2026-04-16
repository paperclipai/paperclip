# Issue State Clarity And Next Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make issue surfaces tell the board what is happening, who acts next, and where to click by enforcing real dependency blockers and exposing a server-computed board-facing state.

**Architecture:** Keep the existing internal issue workflow model for orchestration, but add a server-owned `boardState` layer that interprets raw issue status, blocker relations, QA/recovery context, and assignee context into a single headline plus primary action. Enforce strict `blocked` semantics in the issue service, compute `primaryBlocker` / `rootBlockers` / `blockerPath` / `nextAction` on the backend, and update issue detail plus list surfaces to render those computed fields instead of ambiguous raw status combinations.

**Tech Stack:** TypeScript, Express, Drizzle ORM, React 19, TanStack Query, Vitest, Testing Library

---

## Scope Check

Do not split this into separate feature plans. The invariant, computed API contract, and UI consumption must land together; shipping only one layer would leave the product in another ambiguous intermediate state.

## Working Rules

- Use `@test-driven-development` on every task.
- Use `@verification-before-completion` before claiming the feature is done.
- Implement in a dedicated git worktree; the current root workspace is already dirty.
- No DB migration is needed for this slice.
- Keep `blocked` in the internal status enum for now, but make it valid only when blocker relations exist.

## File Structure

### Shared Contract

- Modify `packages/shared/src/constants.ts`
  - add `ISSUE_BOARD_STATE_KINDS`
  - add `ISSUE_STALL_REASON_CODES`
  - add `ISSUE_NEXT_ACTION_TYPES`
- Modify `packages/shared/src/types/issue.ts`
  - add `IssueBoardState`
  - add `IssueBoardStateAction`
  - add `IssuePrimaryBlocker`
  - add `IssueRootBlocker`
  - add `IssueBlockerPathNode`
  - extend `Issue` with optional computed fields
- Modify `packages/shared/src/index.ts`
  - export the new constants and types

### Server

- Create `server/src/services/issue-board-state.ts`
  - batch graph traversal
  - root blocker ranking
  - stall-reason derivation
  - next-action derivation
- Modify `server/src/services/issues.ts`
  - enforce strict `blocked` semantics
  - normalize blocked issues out of `blocked` when their last blocker is removed
- Modify `server/src/routes/issues.ts`
  - decorate issue `get` / `list` / mutation responses with computed board-state fields
- Create `server/src/__tests__/issue-board-state-service.test.ts`
  - service-level graph/ranking/stall-reason coverage
- Modify `server/src/__tests__/issues-service.test.ts`
  - invariant and normalization coverage
- Create `server/src/__tests__/issue-board-state-routes.test.ts`
  - route payload coverage for `boardState`, `primaryBlocker`, and invalid blocked writes
- Modify `server/src/services/heartbeat.ts`
  - stop treating raw `blocked` as generic “something is wrong” truth when a typed stall reason is more accurate
- Modify `server/src/__tests__/operations-heartbeat-routing.test.ts`
  - keep operations routing aligned with the new invariant

### UI

- Create `ui/src/lib/issue-board-state-presentation.ts`
  - map `boardState` kinds/reasons to UI copy and tone
- Create `ui/src/components/IssueBoardStatePanel.tsx`
  - detail-page action panel
- Create `ui/src/components/IssueBoardStateSummary.tsx`
  - compact list/inbox summary
- Create `ui/src/components/IssueBoardStatePanel.test.tsx`
- Create `ui/src/components/IssueBoardStateSummary.test.tsx`
- Modify `ui/src/pages/IssueDetail.tsx`
  - render the action panel near the top of the page
- Modify `ui/src/components/IssueProperties.tsx`
  - treat the property block as dependency metadata, not the primary explanation layer
- Modify `ui/src/components/IssuesList.tsx`
  - render the compact summary from `boardState`
  - stop synthesizing “Waiting on …” from raw `blockedBy` on the client
- Modify `ui/src/components/IssuesList.test.tsx`
- Modify `ui/src/pages/Inbox.tsx`
  - render the same compact summary in inbox issue rows
- Modify `ui/src/pages/Inbox.test.tsx`

### Docs

- Modify `docs/api/issues.md`
  - document computed issue-state fields and strict blocked semantics
- Modify `doc/SPEC-implementation.md`
  - document that `blocked` requires real dependency blockers
- Keep `docs/superpowers/specs/2026-04-15-issue-blocker-clarity-design.md` as the approved design source

## Normalization Policy

When an issue loses its last blocker and is currently `blocked`, normalize it automatically:

1. if the same mutation explicitly sets a non-blocked status, honor that status
2. otherwise, if the issue would remain `blocked` after the last blocker is removed, normalize it to `todo`
3. do not infer `in_review` or `in_progress` inside the service from partial context

Do not invent a new stored wait status in this slice. The board-facing explanation layer handles the softer “Waiting on …” messaging.

## Mutation Ordering Requirement

The blocked invariant must be checked against the final blocker set, not against transient row state or the raw request payload.

Implementation rule:

1. derive the post-mutation blocker ids first
2. validate `status` against that derived set
3. persist the issue row and sync blocker relations inside the same transaction

For create:

- validate incoming `blockedByIssueIds` before insert
- insert the issue row
- write the blocker relations

For update:

- merge current blocker relations with the request payload to derive the final blocker set
- if the final set is empty and the issue would otherwise stay `blocked`, rewrite status to `todo` unless the caller explicitly chose another non-blocked status
- then persist the row and relation changes atomically

## API Shape To Ship

Add these optional computed fields to issue payloads returned by issue routes:

```ts
issue.boardState = {
  kind: "blocked" | "waiting" | "ready" | "done" | "system_error",
  headline: "Blocked by COMA-1098",
  reasonCode: "review" | "board_decision" | "assignee_followup" | "recovery" | "invalid_state" | null,
  actorType: "issue" | "agent" | "board" | "system" | null,
  actorId: string | null,
  primaryAction: {
    type: "open_issue" | "open_blocker" | "open_agent",
    label: string,
    targetEntity: "issue" | "agent",
    targetId: string,
  } | null;
};

issue.primaryBlocker = {
  issueId: string,
  identifier: string | null,
  title: string,
  blockedIssueCount: number,
  pathLength: number,
};

issue.rootBlockers = [...];
issue.blockerPath = [...];
```

On list endpoints, `boardState` and `primaryBlocker` are required for UI consumption. `rootBlockers` and `blockerPath` can be omitted unless the route is returning a single issue detail or an explicit include flag is present.

### Primary Action Mapping

Slice 1 must only emit actions that map to pages or entities the app already has:

- dependency blocker
  - type: `open_blocker`
  - targetEntity: `issue`
  - targetId: root blocker issue id
  - label: `Go to blocker`
- review wait
  - type: `open_issue`
  - targetEntity: `issue`
  - targetId: current issue id
  - label: `Review QA state`
- board-decision wait
  - type: `open_issue`
  - targetEntity: `issue`
  - targetId: current issue id
  - label: `Review decision`
- recovery wait
  - type: `open_issue`
  - targetEntity: `issue`
  - targetId: current issue id
  - label: `Review recovery state`
- assignee-followup wait
  - type: `open_agent` when `assigneeAgentId` exists, otherwise `open_issue`
  - targetEntity: `agent` or `issue`
  - targetId: assignee agent id or current issue id
  - label: `Open assignee` or `Inspect issue`
- invalid state
  - type: `open_issue`
  - targetEntity: `issue`
  - targetId: current issue id
  - label: `Inspect issue state`

### Task 1: Enforce Strict `blocked` Semantics In The Issue Service

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `server/src/services/issues.ts`
- Test: `server/src/__tests__/issues-service.test.ts`

- [ ] **Step 1: Write the failing service tests**

Add focused cases to `server/src/__tests__/issues-service.test.ts` for:

```ts
it("rejects creating a blocked issue without blocker relations", async () => {
  await expect(
    svc.create(companyId, { title: "Broken", status: "blocked" }),
  ).rejects.toThrow(/blocked/i);
});

it("normalizes a blocked issue to todo when the last blocker is removed without an explicit status", async () => {
  const issueId = await createBlockedIssueWithAssigneeAndBlocker();
  const updated = await svc.update(issueId, { blockedByIssueIds: [] });
  expect(updated.status).toBe("todo");
});

it("keeps an explicit non-blocked status when clearing the last blocker", async () => {
  const issueId = await createBlockedIssueWithAssigneeAndBlocker();
  const updated = await svc.update(issueId, { status: "in_review", blockedByIssueIds: [] });
  expect(updated.status).toBe("in_review");
});
```

- [ ] **Step 2: Run the focused test file and verify it fails**

Run: `pnpm vitest run server/src/__tests__/issues-service.test.ts`

Expected: new blocked-invariant assertions fail because the service currently accepts `status: "blocked"` with zero blockers and leaves cleared blocked issues in `blocked`.

- [ ] **Step 3: Implement the minimal invariant and normalization logic**

Add helper logic in `server/src/services/issues.ts` so create/update paths:

```ts
function assertBlockedStatusMatchesRelations(status: IssueStatus, blockedByIssueIds: string[]) {
  if (status === "blocked" && blockedByIssueIds.length === 0) {
    throw unprocessable("Blocked issues require at least one blocker relation");
  }
}

function normalizeStatusAfterLastBlockerRemoval(explicitStatus?: IssueStatus): IssueStatus {
  if (explicitStatus && explicitStatus !== "blocked") return explicitStatus;
  return "todo";
}
```

Use the actual post-mutation blocker set, not the raw request payload, when checking validity.

Inside the transaction, require this ordering:

1. derive the final blocker ids
2. validate `status` against that derived set
3. write the issue row
4. sync the blocker relations

Do not validate `status=blocked` before computing the final blocker set, and do not rely on transient inserted-but-unsynced relation state.

- [ ] **Step 4: Run the service test file again**

Run: `pnpm vitest run server/src/__tests__/issues-service.test.ts`

Expected: PASS for the new invariant and normalization cases.

- [ ] **Step 5: Commit the service invariant slice**

```bash
git add packages/shared/src/constants.ts packages/shared/src/types/issue.ts packages/shared/src/index.ts server/src/services/issues.ts server/src/__tests__/issues-service.test.ts
git commit -m "feat: enforce strict blocked issue semantics"
```

### Task 2: Add The Server-Owned Board-State Computation Layer

**Files:**
- Create: `server/src/services/issue-board-state.ts`
- Test: `server/src/__tests__/issue-board-state-service.test.ts`
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing board-state service tests**

Create `server/src/__tests__/issue-board-state-service.test.ts` with focused cases:

```ts
it("picks the highest-impact root blocker for a multi-level dependency chain", async () => {
  const result = await computeIssueBoardStateMap(db, companyId, [leafIssueId], { includePaths: true });
  expect(result.get(leafIssueId)?.boardState.headline).toBe("Blocked by COMA-1098");
  expect(result.get(leafIssueId)?.primaryBlocker?.identifier).toBe("COMA-1098");
  expect(result.get(leafIssueId)?.blockerPath?.map((node) => node.identifier)).toEqual(["COMA-1114", "COMA-1107", "COMA-1098"]);
});

it("returns Waiting on QA when review context exists without dependency blockers", async () => {
  expect(result.boardState.headline).toBe("Waiting on QA");
  expect(result.boardState.primaryAction?.type).toBe("open_issue");
  expect(result.boardState.primaryAction?.label).toBe("Review QA state");
});

it("returns system_error for blocked issues with no blockers", async () => {
  expect(result.boardState.kind).toBe("system_error");
});
```

- [ ] **Step 2: Run the new service test file and verify it fails**

Run: `pnpm vitest run server/src/__tests__/issue-board-state-service.test.ts`

Expected: FAIL because `issue-board-state.ts` and the shared response types do not exist yet.

- [ ] **Step 3: Implement the minimal board-state service**

Create `server/src/services/issue-board-state.ts` with a batched entrypoint:

```ts
export async function computeIssueBoardStateMap(
  db: Db,
  companyId: string,
  issueIds: string[],
  opts?: { includePaths?: boolean },
): Promise<Map<string, ComputedIssueBoardState>> { /* ... */ }
```

Implement:

- blocker graph traversal from `issue_relations(type = "blocks")`
- cycle-safe root-blocker discovery
- impact ranking by downstream blocked count, priority, then staleness
- stall-reason derivation for review / board / assignee / recovery / invalid state
- next-action derivation for each non-done state

Keep all copy-facing strings centralized in one place so route and UI tests do not need to duplicate business rules.

- [ ] **Step 4: Run the board-state service tests again**

Run: `pnpm vitest run server/src/__tests__/issue-board-state-service.test.ts`

Expected: PASS with stable primary blocker selection and non-blocked waiting-state headlines.

- [ ] **Step 5: Commit the board-state service slice**

```bash
git add packages/shared/src/constants.ts packages/shared/src/types/issue.ts packages/shared/src/index.ts server/src/services/issue-board-state.ts server/src/__tests__/issue-board-state-service.test.ts
git commit -m "feat: compute board-facing issue state"
```

### Task 3: Wire Board-State Fields Into Issue Routes

**Files:**
- Modify: `server/src/routes/issues.ts`
- Create: `server/src/__tests__/issue-board-state-routes.test.ts`

- [ ] **Step 1: Write the failing route tests**

Create `server/src/__tests__/issue-board-state-routes.test.ts` covering:

```ts
it("includes boardState and primaryBlocker on GET /issues/:id", async () => {
  const res = await request(app).get(`/api/issues/${issueId}`);
  expect(res.body.issue.boardState.headline).toBe("Blocked by COMA-1098");
  expect(res.body.issue.primaryBlocker.identifier).toBe("COMA-1098");
});

it("includes boardState headlines in company issue lists", async () => {
  const res = await request(app).get(`/api/companies/${companyId}/issues`);
  expect(res.body[0].boardState.headline).toMatch(/Blocked by|Waiting on/);
});

it("returns 422 when a mutation tries to persist blocked without blockers", async () => {
  const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "blocked", blockedByIssueIds: [] });
  expect(res.status).toBe(422);
});
```

- [ ] **Step 2: Run the route test file and verify it fails**

Run: `pnpm vitest run server/src/__tests__/issue-board-state-routes.test.ts`

Expected: FAIL because route payloads do not yet include computed board-state fields.

- [ ] **Step 3: Implement route decoration and error plumbing**

In `server/src/routes/issues.ts`, after assembling issue payloads:

```ts
const boardStateMap = await computeIssueBoardStateMap(db, companyId, issueIds, { includePaths: isDetailRoute });
const issueWithBoardState = { ...issue, ...boardStateMap.get(issue.id) };
```

Keep `rootBlockers` and `blockerPath` on detail responses by default. For list responses, include `boardState` and `primaryBlocker` so the row UI can render useful summaries without extra requests.

- [ ] **Step 4: Run the route tests again**

Run: `pnpm vitest run server/src/__tests__/issue-board-state-routes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the route integration slice**

```bash
git add server/src/routes/issues.ts server/src/__tests__/issue-board-state-routes.test.ts
git commit -m "feat: expose computed issue board state in routes"
```

### Task 4: Add The Detail-Page Board Action Panel

**Files:**
- Create: `ui/src/lib/issue-board-state-presentation.ts`
- Create: `ui/src/components/IssueBoardStatePanel.tsx`
- Create: `ui/src/components/IssueBoardStatePanel.test.tsx`
- Modify: `ui/src/pages/IssueDetail.tsx`
- Modify: `ui/src/components/IssueProperties.tsx`

- [ ] **Step 1: Write the failing UI tests**

Create `ui/src/components/IssueBoardStatePanel.test.tsx` with cases such as:

```tsx
it("renders the root blocker headline and CTA for blocked issues", () => {
  render(<IssueBoardStatePanel issue={blockedIssue} />);
  expect(screen.getByText("Blocked by COMA-1098")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Go to blocker" })).toHaveAttribute("href", "/issues/COMA-1098");
});

it("renders a system inconsistency warning instead of No blockers for invalid blocked state", () => {
  render(<IssueBoardStatePanel issue={invalidBlockedIssue} />);
  expect(screen.getByText("System error in issue state")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the panel test file and verify it fails**

Run: `pnpm vitest run ui/src/components/IssueBoardStatePanel.test.tsx`

Expected: FAIL because the panel component does not exist yet.

- [ ] **Step 3: Implement the detail panel and wire it into `IssueDetail`**

Create a focused component that consumes `issue.boardState`, `issue.primaryBlocker`, `issue.rootBlockers`, and `issue.blockerPath`.

Use a structure like:

```tsx
<IssueBoardStatePanel
  issue={issue}
  onOpenBlocker={(id) => navigate(createIssueDetailPath(id))}
/>
```

Place it near the top of `ui/src/pages/IssueDetail.tsx`, before the properties/chat-heavy sections. In `IssueProperties.tsx`, keep the dependency editor, but make its empty state read as metadata (`None`) rather than the primary explanation for why work is stalled.

- [ ] **Step 4: Run the panel tests again**

Run: `pnpm vitest run ui/src/components/IssueBoardStatePanel.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the detail-panel slice**

```bash
git add ui/src/lib/issue-board-state-presentation.ts ui/src/components/IssueBoardStatePanel.tsx ui/src/components/IssueBoardStatePanel.test.tsx ui/src/pages/IssueDetail.tsx ui/src/components/IssueProperties.tsx
git commit -m "feat: add issue detail next-action panel"
```

### Task 5: Reuse The Same Computed State In Issue Lists And Inbox

**Files:**
- Create: `ui/src/components/IssueBoardStateSummary.tsx`
- Create: `ui/src/components/IssueBoardStateSummary.test.tsx`
- Modify: `ui/src/components/IssuesList.tsx`
- Modify: `ui/src/components/IssuesList.test.tsx`
- Modify: `ui/src/pages/Inbox.tsx`
- Modify: `ui/src/pages/Inbox.test.tsx`

- [ ] **Step 1: Write the failing compact-summary tests**

Create `ui/src/components/IssueBoardStateSummary.test.tsx` and extend the existing list/inbox tests:

```tsx
it("renders blocked row copy from boardState instead of raw blockedBy", () => {
  render(<IssueBoardStateSummary issue={blockedIssue} />);
  expect(screen.getByText("Blocked by COMA-1098")).toBeInTheDocument();
});

it("renders Waiting on QA in inbox rows", () => {
  render(<IssueBoardStateSummary issue={qaIssue} />);
  expect(screen.getByText("Waiting on QA")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the relevant UI test files and verify they fail**

Run: `pnpm vitest run ui/src/components/IssueBoardStateSummary.test.tsx ui/src/components/IssuesList.test.tsx ui/src/pages/Inbox.test.tsx`

Expected: FAIL because list and inbox rows still derive waiting copy from raw blocker arrays.

- [ ] **Step 3: Implement the compact summary component and replace client-side guesswork**

In `ui/src/components/IssuesList.tsx`, remove client-generated strings like:

```ts
return `Waiting on ${blockers[0].identifier ?? blockers[0].title}`;
```

Replace them with:

```tsx
<IssueBoardStateSummary issue={issue} />
```

Do the same in `ui/src/pages/Inbox.tsx` for issue rows so board-facing state is consistent across surfaces.

- [ ] **Step 4: Run the list and inbox tests again**

Run: `pnpm vitest run ui/src/components/IssueBoardStateSummary.test.tsx ui/src/components/IssuesList.test.tsx ui/src/pages/Inbox.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the list/inbox slice**

```bash
git add ui/src/components/IssueBoardStateSummary.tsx ui/src/components/IssueBoardStateSummary.test.tsx ui/src/components/IssuesList.tsx ui/src/components/IssuesList.test.tsx ui/src/pages/Inbox.tsx ui/src/pages/Inbox.test.tsx
git commit -m "feat: show computed issue state in lists and inbox"
```

### Task 6: Align Automation And Docs With The New Truth Model

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/__tests__/operations-heartbeat-routing.test.ts`
- Modify: `docs/api/issues.md`
- Modify: `doc/SPEC-implementation.md`

- [ ] **Step 1: Write the failing automation/doc-adjacent tests**

Add focused cases to `server/src/__tests__/operations-heartbeat-routing.test.ts` to verify operations logic does not treat raw `status === "blocked"` as actionable blocker truth when the computed board state is `waiting` or `system_error`.

Example:

```ts
it("does not describe a non-dependency waiting issue as blocked assigned work", async () => {
  const target = await resolveOperationsHeartbeatTarget(db, { companyId, operationsAgentId });
  expect(target?.reason).not.toContain("status is blocked");
});
```

- [ ] **Step 2: Run the automation test file and verify it fails**

Run: `pnpm vitest run server/src/__tests__/operations-heartbeat-routing.test.ts`

Expected: FAIL because operations routing still emits generic blocked-language reasons.

- [ ] **Step 3: Implement the minimal automation and doc updates**

Update `server/src/services/heartbeat.ts` so operations recovery logic prefers the computed interpretation:

- dependency blocker: mention the blocker issue
- review/board/assignee wait: mention the typed wait state
- invalid state: mention inconsistency, not blocker truth

Then update docs:

- `docs/api/issues.md` with the new computed fields and strict blocked invariant
- `doc/SPEC-implementation.md` so V1 issue semantics say blocked requires a real dependency

- [ ] **Step 4: Run the automation tests again**

Run: `pnpm vitest run server/src/__tests__/operations-heartbeat-routing.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the automation/docs slice**

```bash
git add server/src/services/heartbeat.ts server/src/__tests__/operations-heartbeat-routing.test.ts docs/api/issues.md doc/SPEC-implementation.md
git commit -m "feat: align automation and docs with computed issue state"
```

### Task 7: Final Verification And Cleanup

**Files:**
- Review: `packages/shared/src/constants.ts`
- Review: `packages/shared/src/types/issue.ts`
- Review: `server/src/services/issues.ts`
- Review: `server/src/services/issue-board-state.ts`
- Review: `server/src/routes/issues.ts`
- Review: `server/src/services/heartbeat.ts`
- Review: `ui/src/components/IssueBoardStatePanel.tsx`
- Review: `ui/src/components/IssueBoardStateSummary.tsx`
- Review: `ui/src/pages/IssueDetail.tsx`
- Review: `ui/src/components/IssuesList.tsx`
- Review: `ui/src/pages/Inbox.tsx`
- Review: `docs/api/issues.md`
- Review: `doc/SPEC-implementation.md`

- [ ] **Step 1: Run the focused test suite**

Run:

```bash
pnpm vitest run \
  server/src/__tests__/issues-service.test.ts \
  server/src/__tests__/issue-board-state-service.test.ts \
  server/src/__tests__/issue-board-state-routes.test.ts \
  server/src/__tests__/operations-heartbeat-routing.test.ts \
  ui/src/components/IssueBoardStatePanel.test.tsx \
  ui/src/components/IssueBoardStateSummary.test.tsx \
  ui/src/components/IssuesList.test.tsx \
  ui/src/pages/Inbox.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `pnpm -r typecheck`

Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test:run`

Expected: PASS. If unrelated failures already exist, document them clearly before handoff.

- [ ] **Step 4: Run the production build**

Run: `pnpm build`

Expected: PASS.

- [ ] **Step 5: Commit the final integrated slice**

```bash
git add packages/shared/src/constants.ts packages/shared/src/types/issue.ts packages/shared/src/index.ts server/src/services/issues.ts server/src/services/issue-board-state.ts server/src/routes/issues.ts server/src/services/heartbeat.ts server/src/__tests__/issues-service.test.ts server/src/__tests__/issue-board-state-service.test.ts server/src/__tests__/issue-board-state-routes.test.ts server/src/__tests__/operations-heartbeat-routing.test.ts ui/src/lib/issue-board-state-presentation.ts ui/src/components/IssueBoardStatePanel.tsx ui/src/components/IssueBoardStatePanel.test.tsx ui/src/components/IssueBoardStateSummary.tsx ui/src/components/IssueBoardStateSummary.test.tsx ui/src/components/IssueProperties.tsx ui/src/components/IssuesList.tsx ui/src/components/IssuesList.test.tsx ui/src/pages/IssueDetail.tsx ui/src/pages/Inbox.tsx ui/src/pages/Inbox.test.tsx docs/api/issues.md doc/SPEC-implementation.md
git commit -m "feat: clarify issue state and next actions"
```

## Expected End State

When this plan is complete:

- `blocked` only appears when a real blocker issue exists
- every issue surface shows computed board-facing meaning instead of raw ambiguous state
- blocked issues highlight the highest-impact root blocker first
- non-dependency waits render as `Waiting on ...`
- invalid issue state is called out as a system error instead of pushing interpretation work onto the board
