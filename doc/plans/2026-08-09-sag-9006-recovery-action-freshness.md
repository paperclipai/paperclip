# SAG-9006 Recovery-Action Freshness Implementation Plan

> **For agentic workers:** Execute this bounded repair task task-by-task with the repository's test-first and verification-before-completion skills.

**Goal:** Fold an active source-scoped recovery action when a source issue is reassigned, including blocked issues, so stale recovery-owner metadata cannot reach the next sweeper nudge.

**Architecture:** Preserve the existing explicit recovery lifecycle: resolve/cancel the action with `outcome` and `resolutionNote`, retain the activity-log receipt, and keep the sweeper's owner resolution unchanged. Correct the source-revalidation decision at the blocked-assignee handoff boundary and add a recovery-service backstop for source-scoped actions observed after direct service-level changes.

**Tech Stack:** TypeScript, Express issue routes, Drizzle/Postgres, Vitest, Paperclip recovery-action service.

---

### Task 1: Add the blocked-source assignee handoff regression

**Files:**
- Modify: `server/src/__tests__/issue-recovery-actions.test.ts`

- [ ] Seed a blocked source issue assigned to agent A and an active `wake_owner` action owned by A.
- [ ] PATCH the source issue to agent B and assert the response no longer exposes an active action.
- [ ] Assert the persisted action is cancelled with an audit note and that a read projection contains no stale owner action.
- [ ] Run the focused test and confirm it fails because the blocked revalidation branch currently returns early.

The regression should exercise this concrete handoff shape:

```ts
await db.update(issues).set({ status: "blocked", assigneeAgentId: ownerA }).where(eq(issues.id, sourceIssueId));
const action = await issueRecoveryActionService(db).upsertSourceScoped({
  companyId, sourceIssueId, kind: "issue_graph_liveness", ownerType: "agent",
  ownerAgentId: ownerA, previousOwnerAgentId: ownerA, cause: "issue_graph_liveness",
  fingerprint: "graph-liveness:assignee-handoff", nextAction: "Restore a live execution path.",
  wakePolicy: { type: "wake_owner" },
});
await request(app).patch(`/api/issues/${sourceIssueId}`).send({ assigneeAgentId: ownerB }).expect(200);
expect(await issueRecoveryActionService(db).getActiveForIssue(companyId, sourceIssueId)).toBeNull();
expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0])
  .toMatchObject({ status: "cancelled", outcome: "cancelled" });
```

### Task 2: Implement the smallest revalidation fix

**Files:**
- Modify: `server/src/routes/issues.ts`

- [ ] When `assigneeChanged` is true, classify the source-scoped action as stale before the blocked-issue blocker check, preserving the existing cancellation/outcome/activity-log path.
- [ ] Add a recovery-service reconciliation pass that selects active/escalated actions with a recorded prior owner and resolves actions where `previousOwnerAgentId !== sourceIssue.assigneeAgentId`.
- [ ] Do not alter `scripts/recovery_sweeper.py` target resolution or any 2-nudge/403/source-write behavior.
- [ ] Run the focused regression and the existing recovery-action tests.

The service pass should retain the existing lifecycle call rather than deleting rows:

```ts
await recoveryActionsSvc.resolveActiveForIssue({
  companyId: action.companyId,
  sourceIssueId: action.sourceIssueId,
  actionId: action.id,
  status: "cancelled",
  outcome: "cancelled",
  resolutionNote: "Recovery action became stale because the source issue assignee changed.",
});
```

### Task 3: Verify the recovery sweep invariants

**Files:**
- No additional production files.

- [ ] Run `server/src/__tests__/recovery-sweeper.test.ts` and the focused recovery-action suite.
- [ ] Run the smallest applicable typecheck for the changed server code.
- [ ] Review the diff for unrelated changes, then report evidence and residual risk to the named CTO reviewer.

Expected commands:

```bash
pnpm exec vitest run server/src/__tests__/recovery-sweeper.test.ts server/src/__tests__/issue-recovery-actions.test.ts
pnpm --filter @paperclipai/server typecheck
git diff --check
```
