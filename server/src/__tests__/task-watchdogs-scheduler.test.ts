import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueWorkProducts,
  issues,
  issueWatchdogs,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { taskWatchdogService } from "../services/task-watchdogs.ts";
import { resolveTaskWatchdogMutationScope } from "../services/task-watchdog-scope.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task watchdog scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("task watchdog scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-watchdogs-scheduler-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueWatchdogs);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog Co",
      issuePrefix: `WD${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      issueCounter: 0,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: overrides.name ?? "Watchdog Agent",
      role: overrides.role ?? "engineer",
      status: overrides.status ?? "active",
      adapterType: overrides.adapterType ?? "codex_local",
      adapterConfig: overrides.adapterConfig ?? {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: overrides.permissions ?? {},
      reportsTo: overrides.reportsTo,
    });
    return id;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Watched issue",
      status: overrides.status ?? "done",
      priority: overrides.priority ?? "medium",
      identifier: overrides.identifier ?? `WDOG-${Math.floor(Math.random() * 10_000)}`,
      issueNumber: overrides.issueNumber ?? Math.floor(Math.random() * 10_000),
      parentId: overrides.parentId,
      assigneeAgentId: overrides.assigneeAgentId,
      originKind: overrides.originKind,
      originId: overrides.originId,
      originFingerprint: overrides.originFingerprint,
      updatedAt: overrides.updatedAt,
      // Default to an "established" issue (created well before the first-run
      // grace window) so the pending-first-run guard does not defer it. Tests
      // exercising the create-race pass an explicit recent `createdAt`.
      createdAt: overrides.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  }

  async function seedIssueDocument(companyId: string, issueId: string, updatedAt: Date) {
    const [document] = await db.insert(documents).values({
      companyId,
      title: "Plan",
      latestBody: "Plan body",
      updatedAt,
    }).returning();
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId: document!.id,
      key: "plan",
      updatedAt,
    });
  }

  async function seedIssueWorkProduct(companyId: string, issueId: string, updatedAt: Date) {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "artifact",
      provider: "test",
      title: "Report",
      status: "ready",
      updatedAt,
    });
  }

  async function seedWatchdog(companyId: string, issueId: string, agentId: string) {
    const [row] = await db.insert(issueWatchdogs).values({
      companyId,
      issueId,
      watchdogAgentId: agentId,
      instructions: "Verify stopped work.",
      status: "active",
    }).returning();
    return row;
  }

  function createService() {
    const wakes: Array<{ agentId: string; opts: Record<string, unknown> | undefined }> = [];
    const service = taskWatchdogService(db, {
      enqueueWakeup: async (agentId, opts) => {
        wakes.push({ agentId, opts });
        return { id: randomUUID() };
      },
    });
    return { service, wakes };
  }

  it("creates one reusable watchdog issue and wakes the watchdog on the initial stopped state", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-1", status: "done" });
    const agentId = await seedAgent(companyId);
    const seededWatchdog = await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.agentId).toBe(agentId);
    expect(wakes[0]?.opts?.reason).toBe("task_watchdog_stopped_subtree");
    expect(wakes[0]?.opts?.contextSnapshot).toMatchObject({
      taskWatchdog: {
        version: 1,
        watchdogId: seededWatchdog?.id,
        watchedIssueId: sourceId,
        companyId,
        agentId,
        watchedIssueIdentifier: "WDOG-1",
        recoveryCursor: {
          version: 1,
          state: "open",
          fingerprint: expect.stringMatching(/^task_watchdog_stop:/),
          lastMutationReceipt: null,
        },
        capabilities: {
          targetScope: {
            watchedIssueId: sourceId,
            includeNonWatchdogDescendants: true,
            excludedOriginKinds: ["task_watchdog"],
          },
          operations: expect.arrayContaining([
            "comment_on_watched_subtree_issues",
            "create_child_issues_under_non_watchdog_watched_subtree",
            "create_product_bug_followups_outside_watched_subtree",
            "update_reusable_watchdog_issue",
          ]),
          deniedOperations: expect.arrayContaining([
            "create_visible_probe_issues_or_throwaway_tasks",
            "create_product_bug_followups_as_source_tree_children",
            "mutate_task_watchdog_descendants",
          ]),
        },
      },
    });

    const watchdogIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(1);
    expect(watchdogIssues[0]).toMatchObject({
      parentId: sourceId,
      originId: sourceId,
      assigneeAgentId: agentId,
      status: "todo",
    });

    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.watchdogIssueId).toBe(watchdogIssues[0]?.id);
    expect(wakes[0]?.opts?.contextSnapshot).toMatchObject({
      taskWatchdog: { watchdogIssueId: watchdogIssues[0]?.id },
    });
    expect(watchdog?.lastObservedFingerprint).toMatch(/^task_watchdog_stop:/);
    expect(watchdog?.triggerCount).toBe(1);
  });

  it("does not append duplicate review comments for an already-open same-fingerprint review", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-DUPE", status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const initialComments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdogIssueId));
    expect(initialComments).toHaveLength(1);

    const second = await service.reconcileTaskWatchdogs({ companyId });

    expect(second).toMatchObject({ checked: 1, triggered: 0, live: 1 });
    expect(wakes).toHaveLength(1);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdogIssueId));
    expect(comments).toHaveLength(1);
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.lastObservedFingerprint).toBe(firstWatchdog?.lastObservedFingerprint);
    expect(watchdog?.triggerCount).toBe(1);
  });

  it("re-wakes a same-fingerprint watchdog review stuck in stale in_review", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-STALE", status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: null,
        executionState: null,
        monitorNextCheckAt: null,
      })
      .where(eq(issues.id, watchdogIssueId));

    const second = await service.reconcileTaskWatchdogs({ companyId });

    expect(second).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(2);
    const [watchdogIssue] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(watchdogIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: agentId,
      originFingerprint: firstWatchdog?.lastObservedFingerprint,
    });
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdogIssueId));
    expect(comments).toHaveLength(2);
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.triggerCount).toBe(2);
  });

  it("does not trigger while a non-watchdog descendant has live work", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-2", status: "in_progress" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "in_progress" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      contextSnapshot: { issueId: childId },
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 0, live: 1 });
    expect(wakes).toHaveLength(0);
    const watchdogIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(0);
  });

  it("does not trigger while a descendant has a queued assignment wake", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-WAKE", status: "in_progress" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "todo" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      status: "queued",
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: childId },
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 0, live: 1 });
    expect(wakes).toHaveLength(0);
    const watchdogIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(0);
  });

  it("does not keep the source live for runs under a nested task-watchdog issue", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-NEST", status: "done" });
    const agentId = await seedAgent(companyId);
    const nestedWatchdogIssueId = await seedIssue(companyId, {
      parentId: sourceId,
      status: "in_progress",
      originKind: "task_watchdog",
      originId: sourceId,
      originFingerprint: `task_watchdog:${companyId}:${sourceId}`,
    });
    const nestedChildId = await seedIssue(companyId, {
      parentId: nestedWatchdogIssueId,
      status: "in_progress",
    });
    await seedWatchdog(companyId, sourceId, agentId);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: nestedChildId },
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1, live: 0 });
    expect(wakes).toHaveLength(1);
  });

  it("reconciles ancestor watchdogs for a descendant issue mutation", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-ANCESTOR", status: "done" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileForIssueAndAncestors(companyId, childId);

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
  });

  it("marks a completed watchdog fingerprint reviewed, then reuses the same issue for a later stopped state", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-3", status: "done" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const [firstWatchdogIssue] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(firstWatchdogIssue?.originFingerprint).toBe(firstWatchdog?.lastObservedFingerprint);
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, watchdogIssueId));

    const reviewed = await service.reconcileTaskWatchdogs({ companyId });
    expect(reviewed).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    const [reviewedWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(reviewedWatchdog?.lastReviewedFingerprint).toBe(firstWatchdog?.lastObservedFingerprint);

    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(issues.id, childId));
    const retriggered = await service.reconcileTaskWatchdogs({ companyId });

    expect(retriggered).toMatchObject({ checked: 1, triggered: 1 });
    const watchdogIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(1);
    expect(watchdogIssues[0]).toMatchObject({ id: watchdogIssueId, status: "todo" });
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdogIssueId));
    expect(comments.some((comment) => comment.body.includes("Stopped fingerprint"))).toBe(true);
    expect(wakes.length).toBe(2);
  });

  it("does not let an old terminal watchdog review mark a newer observed fingerprint reviewed", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-STALE", status: "done" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const oldFingerprint = firstWatchdog!.lastObservedFingerprint!;
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const watchdogRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: watchdogRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: watchdogIssueId },
    });

    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(issues.id, childId));
    const changedWhileReviewLive = await service.reconcileTaskWatchdogs({ companyId });
    expect(changedWhileReviewLive).toMatchObject({ checked: 1, triggered: 0, live: 1 });

    const [observedWhileLive] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const newerFingerprint = observedWhileLive!.lastObservedFingerprint!;
    expect(newerFingerprint).not.toBe(oldFingerprint);
    const [stillBoundReview] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(stillBoundReview?.originFingerprint).toBe(oldFingerprint);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, watchdogRunId));
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, watchdogIssueId));
    const afterOldReviewCompletes = await service.reconcileTaskWatchdogs({ companyId });

    expect(afterOldReviewCompletes).toMatchObject({ checked: 1, triggered: 1 });
    const [reviewedWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(reviewedWatchdog?.lastReviewedFingerprint).toBe(oldFingerprint);
    expect(reviewedWatchdog?.lastReviewedFingerprint).not.toBe(newerFingerprint);
    const [reopenedWatchdogIssue] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(reopenedWatchdogIssue).toMatchObject({
      status: "todo",
      originFingerprint: newerFingerprint,
    });
    const reviewActivities = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, sourceId), eq(activityLog.action, "issue.task_watchdog_fingerprint_reviewed")));
    expect(reviewActivities).toHaveLength(1);
    expect(reviewActivities[0]?.details).toMatchObject({
      reviewedFingerprint: oldFingerprint,
      lastObservedFingerprint: newerFingerprint,
    });
    expect(wakes.length).toBe(2);
  });

  it("atomically advances the run cursor, then seals a compound recovery status and comment", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-CURSOR",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const contextSnapshot = wakes[0]?.opts?.contextSnapshot as Record<string, unknown>;
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot,
    });
    const actor = { type: "agent", agentId, companyId, runId };
    const initialScope = await resolveTaskWatchdogMutationScope(db, actor);
    expect(initialScope.kind).toBe("watchdog");
    if (initialScope.kind !== "watchdog") throw new Error("Expected watchdog scope");

    const first = await service.executeSourceMutation(initialScope, {
      operationKind: "issue_comment",
      method: "POST",
      path: `/api/issues/${sourceId}/comments`,
      targetIssueId: sourceId,
      body: { body: "Cleared stale recovery evidence." },
    }, async (tx) => {
      const [comment] = await tx.insert(issueComments).values({
        companyId,
        issueId: sourceId,
        authorAgentId: agentId,
        authorType: "agent",
        body: "Cleared stale recovery evidence.",
        createdByRunId: runId,
      }).returning();
      await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, sourceId));
      return { value: comment, receiptResult: { commentId: comment!.id } };
    });
    expect(first.replayed).toBe(false);
    expect(first.receipt.cursorState).toBe("open");
    expect(first.receipt.newFingerprint).not.toBe(initialScope.cursorFingerprint);

    const advancedScope = await resolveTaskWatchdogMutationScope(db, actor);
    expect(advancedScope.kind).toBe("watchdog");
    if (advancedScope.kind !== "watchdog") throw new Error("Expected advanced watchdog scope");
    const compoundRequest = {
      operationKind: "issue_update",
      method: "PATCH",
      path: `/api/issues/${sourceId}`,
      targetIssueId: sourceId,
      body: { status: "todo", comment: "Recovery path restored." },
      establishesContinuationPath: true,
    };
    const second = await service.executeSourceMutation(advancedScope, compoundRequest, async (tx) => {
      const [updated] = await tx.update(issues).set({ status: "todo", updatedAt: new Date() })
        .where(eq(issues.id, sourceId)).returning();
      const [comment] = await tx.insert(issueComments).values({
        companyId,
        issueId: sourceId,
        authorAgentId: agentId,
        authorType: "agent",
        body: "Recovery path restored.",
        createdByRunId: runId,
      }).returning();
      return {
        value: { issue: updated, comment },
        receiptResult: { issueId: sourceId, commentId: comment!.id },
      };
    });
    expect(second.replayed).toBe(false);
    expect(second.receipt.cursorState).toBe("sealed");
    const [updatedSource] = await db.select().from(issues).where(eq(issues.id, sourceId));
    expect(updatedSource?.status).toBe("todo");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceId));
    expect(comments.map((comment) => comment.body)).toEqual([
      "Cleared stale recovery evidence.",
      "Recovery path restored.",
    ]);

    const sealedScope = await resolveTaskWatchdogMutationScope(db, actor);
    expect(sealedScope.kind).toBe("watchdog");
    if (sealedScope.kind !== "watchdog") throw new Error("Expected sealed watchdog scope");
    let replayApplied = false;
    const replay = await service.executeSourceMutation(sealedScope, compoundRequest, async () => {
      replayApplied = true;
      throw new Error("exact replay must not execute");
    });
    expect(replay.replayed).toBe(true);
    expect(replayApplied).toBe(false);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, sourceId))).toHaveLength(2);
    const mutationActivities = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.runId, runId),
        eq(activityLog.action, "issue.task_watchdog_source_mutation_committed"),
      ));
    expect(mutationActivities).toHaveLength(2);

    await expect(service.executeSourceMutation(sealedScope, {
      ...compoundRequest,
      body: { status: "blocked", comment: "A different request after sealing." },
    }, async () => {
      throw new Error("sealed cursor must reject a different request before applying");
    })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, sourceId))).toHaveLength(2);
    expect(await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.runId, runId),
        eq(activityLog.action, "issue.task_watchdog_source_mutation_committed"),
      ))).toHaveLength(2);
  });

  it("serializes concurrent same-run mutations so exactly one cursor claimant commits", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-CURSOR-CAS", status: "blocked" });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: wakes[0]?.opts?.contextSnapshot as Record<string, unknown>,
    });
    const scope = await resolveTaskWatchdogMutationScope(db, {
      type: "agent",
      agentId,
      companyId,
      runId,
    });
    expect(scope.kind).toBe("watchdog");
    if (scope.kind !== "watchdog") throw new Error("Expected watchdog scope");

    const mutate = (label: string) => service.executeSourceMutation(scope, {
      operationKind: "issue_comment",
      method: "POST",
      path: `/api/issues/${sourceId}/comments`,
      targetIssueId: sourceId,
      body: { body: label },
    }, async (tx) => {
      const [comment] = await tx.insert(issueComments).values({
        companyId,
        issueId: sourceId,
        authorAgentId: agentId,
        authorType: "agent",
        body: label,
        createdByRunId: runId,
      }).returning();
      return { value: comment, receiptResult: { commentId: comment!.id } };
    });

    const results = await Promise.allSettled([mutate("claim-a"), mutate("claim-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, sourceId))).toHaveLength(1);
    expect(await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.runId, runId),
        eq(activityLog.action, "issue.task_watchdog_source_mutation_committed"),
      ))).toHaveLength(1);
  });

  it("fails closed on external fingerprint changes and reusable watchdog identity rotation", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-STALE-CURSOR", status: "blocked" });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: wakes[0]?.opts?.contextSnapshot as Record<string, unknown>,
    });
    const actor = { type: "agent", agentId, companyId, runId };
    const scope = await resolveTaskWatchdogMutationScope(db, actor);
    expect(scope.kind).toBe("watchdog");
    if (scope.kind !== "watchdog") throw new Error("Expected watchdog scope");

    await db.insert(issueComments).values({
      companyId,
      issueId: sourceId,
      authorType: "system",
      body: "Concurrent external evidence.",
    });
    let applied = false;
    await expect(service.executeSourceMutation(scope, {
      operationKind: "issue_update",
      method: "PATCH",
      path: `/api/issues/${sourceId}`,
      targetIssueId: sourceId,
      body: { status: "todo" },
    }, async () => {
      applied = true;
      return { value: null, receiptResult: null };
    })).rejects.toMatchObject({ status: 409 });
    expect(applied).toBe(false);

    const replacementIssueId = await seedIssue(companyId, {
      identifier: "WDOG-ROTATED",
      status: "todo",
      parentId: sourceId,
      assigneeAgentId: agentId,
      originKind: "task_watchdog",
    });
    await db.update(issueWatchdogs).set({ watchdogIssueId: replacementIssueId }).where(eq(issueWatchdogs.id, watchdog!.id));
    const rotated = await resolveTaskWatchdogMutationScope(db, actor);
    expect(rotated).toMatchObject({
      kind: "invalid",
      detail: "Task-watchdog run context is not backed by an active persisted watchdog.",
    });

    const rotatedContext = structuredClone(
      wakes[0]?.opts?.contextSnapshot as Record<string, unknown>,
    ) as { taskWatchdog: Record<string, unknown> };
    rotatedContext.taskWatchdog.watchdogIssueId = replacementIssueId;
    const rotatedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: rotatedRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: rotatedContext,
    });
    await expect(resolveTaskWatchdogMutationScope(db, {
      type: "agent",
      agentId,
      companyId,
      runId: rotatedRunId,
    })).resolves.toMatchObject({
      kind: "watchdog",
      watchdogIssueId: replacementIssueId,
      runId: rotatedRunId,
    });
  });

  it("rejects missing cursor identity, inactive watchdogs, and wrong actor identity", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-IDENTITY", status: "blocked" });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const completeContext = structuredClone(
      wakes[0]?.opts?.contextSnapshot as Record<string, unknown>,
    ) as { taskWatchdog: Record<string, unknown> };
    const missingCursorContext = structuredClone(completeContext);
    delete missingCursorContext.taskWatchdog.recoveryCursor;
    const missingCursorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: missingCursorRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: missingCursorContext,
    });
    await expect(resolveTaskWatchdogMutationScope(db, {
      type: "agent",
      agentId,
      companyId,
      runId: missingCursorRunId,
    })).resolves.toMatchObject({
      kind: "invalid",
      detail: "Task-watchdog run context is missing its immutable identity or recovery cursor.",
    });

    const validRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: validRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: completeContext,
    });
    await expect(resolveTaskWatchdogMutationScope(db, {
      type: "agent",
      agentId: randomUUID(),
      companyId,
      runId: validRunId,
    })).resolves.toMatchObject({
      kind: "invalid",
      detail: "Task-watchdog run context does not belong to this agent.",
    });
    await expect(resolveTaskWatchdogMutationScope(db, {
      type: "agent",
      agentId,
      companyId: randomUUID(),
      runId: validRunId,
    })).resolves.toMatchObject({
      kind: "invalid",
      detail: "Task-watchdog run context does not belong to this agent.",
    });

    await db.update(issueWatchdogs).set({ status: "disabled" }).where(eq(issueWatchdogs.issueId, sourceId));
    await expect(resolveTaskWatchdogMutationScope(db, {
      type: "agent",
      agentId,
      companyId,
      runId: validRunId,
    })).resolves.toMatchObject({
      kind: "invalid",
      detail: "Task-watchdog run context is not backed by an active persisted watchdog.",
    });
  });

  it("rolls back source writes on failure and rejects an expired run without applying", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-ROLLBACK", status: "blocked" });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: wakes[0]?.opts?.contextSnapshot as Record<string, unknown>,
    });
    const actor = { type: "agent", agentId, companyId, runId };
    const scope = await resolveTaskWatchdogMutationScope(db, actor);
    expect(scope.kind).toBe("watchdog");
    if (scope.kind !== "watchdog") throw new Error("Expected watchdog scope");
    const request = {
      operationKind: "issue_comment",
      method: "POST",
      path: `/api/issues/${sourceId}/comments`,
      targetIssueId: sourceId,
      body: { body: "must roll back" },
    };

    await expect(service.executeSourceMutation(scope, request, async (tx) => {
      await tx.insert(issueComments).values({
        companyId,
        issueId: sourceId,
        authorAgentId: agentId,
        authorType: "agent",
        body: "must roll back",
        createdByRunId: runId,
      });
      throw new Error("simulated route failure");
    })).rejects.toThrow("simulated route failure");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, sourceId))).toHaveLength(0);

    const unchangedScope = await resolveTaskWatchdogMutationScope(db, actor);
    expect(unchangedScope).toMatchObject({ kind: "watchdog", cursorFingerprint: scope.cursorFingerprint });
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, runId));
    let expiredApplyCalled = false;
    await expect(service.executeSourceMutation(scope, request, async () => {
      expiredApplyCalled = true;
      return { value: null, receiptResult: null };
    })).rejects.toMatchObject({ status: 409 });
    expect(expiredApplyCalled).toBe(false);
  });

  it("does not raise a stopped-subtree review while a freshly-created assigned issue's first run is starting", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    // Issue + watchdog created in the same flow; the assignment run row is not
    // yet visible to this evaluation (create-race).
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-RACE",
      status: "todo",
      assigneeAgentId: agentId,
      createdAt: new Date(),
    });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 0, pendingFirstRun: 1 });
    expect(wakes).toHaveLength(0);
    const watchdogIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(0);
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.triggerCount).toBe(0);
  });

  it("still triggers a genuinely idle assigned issue once it is past the first-run grace window", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    // Established issue (default createdAt is an hour ago), assigned, non-terminal,
    // with no live run or queued wake.
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-IDLE",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
  });

  it("does not defer once the freshly-created issue has a terminal run on record", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-RAN",
      status: "blocked",
      assigneeAgentId: agentId,
      createdAt: new Date(),
    });
    await seedWatchdog(companyId, sourceId, agentId);
    // A run for this issue already reached a terminal status, so the stop is
    // genuine even though the issue was just created.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "assignment",
      contextSnapshot: { issueId: sourceId },
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
  });

  it("does not recursively trigger a watchdog configured on a task-watchdog issue", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-4", status: "done" });
    const watchdogIssueId = await seedIssue(companyId, {
      parentId: sourceId,
      status: "done",
      originKind: "task_watchdog",
      originId: sourceId,
      originFingerprint: `task_watchdog:${companyId}:${sourceId}`,
    });
    await seedIssue(companyId, { parentId: watchdogIssueId, status: "done" });
    await seedWatchdog(companyId, watchdogIssueId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 0 });
    expect(wakes).toHaveLength(0);
    const watchdogIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(1);
  });

  it("handles an armed cutoff when no watchdogs are active", async () => {
    const companyId = await seedCompany();
    const { service } = createService();

    const result = await service.reconcileTaskWatchdogs({
      companyId,
      issueCreatedAtGte: new Date(),
    });

    expect(result).toMatchObject({ checked: 0, triggered: 0 });
  });
});
