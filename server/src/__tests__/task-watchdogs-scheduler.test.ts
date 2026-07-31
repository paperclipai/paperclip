import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueApprovals,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  issueWatchdogs,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { taskWatchdogService } from "../services/task-watchdogs.ts";

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
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueThreadInteractions);
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
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

  async function seedWatchdog(
    companyId: string,
    issueId: string,
    agentId: string,
    overrides: Partial<typeof issueWatchdogs.$inferInsert> = {},
  ) {
    const [row] = await db.insert(issueWatchdogs).values({
      companyId,
      issueId,
      watchdogAgentId: agentId,
      instructions: "Verify stopped work.",
      status: "active",
      ...overrides,
    }).returning();
    return row;
  }

  function createService() {
    const wakes: Array<{ agentId: string; opts: Record<string, unknown> | undefined }> = [];
    const wakeIdsByIdempotencyKey = new Map<string, string>();
    const service = taskWatchdogService(db, {
      enqueueWakeup: async (agentId, opts) => {
        return db.transaction(async (tx) => {
          await opts?.beforeIssueLock?.(tx);
          const idempotencyKey = typeof opts?.idempotencyKey === "string" ? opts.idempotencyKey : null;
          if (idempotencyKey?.startsWith("task_watchdog_self:")) {
            const existingId = wakeIdsByIdempotencyKey.get(idempotencyKey);
            if (existingId) {
              await opts?.onWakeAccepted?.(tx, {
                wakeupRequestId: existingId,
                runId: existingId,
              });
              return { id: existingId };
            }
          }
          const id = randomUUID();
          await opts?.onWakeAccepted?.(tx, { wakeupRequestId: id, runId: id });
          if (idempotencyKey?.startsWith("task_watchdog_self:")) wakeIdsByIdempotencyKey.set(idempotencyKey, id);
          wakes.push({ agentId, opts });
          return { id };
        });
      },
    });
    return { service, wakes };
  }

  it("creates one reusable watchdog issue and wakes the watchdog on the initial stopped state", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-1", status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.agentId).toBe(agentId);
    expect(wakes[0]?.opts?.reason).toBe("task_watchdog_stopped_subtree");
    expect(wakes[0]?.opts?.idempotencyKey).toMatch(/^task_watchdog:[^:]+:task_watchdog_stop:/);
    expect(wakes[0]?.opts?.contextSnapshot).toMatchObject({
      taskWatchdog: {
        watchedIssueId: sourceId,
        watchedIssueIdentifier: "WDOG-1",
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
    expect(watchdog?.lastObservedFingerprint).toMatch(/^task_watchdog_stop:/);
    expect(watchdog?.lastObservedStopSnapshot).toMatchObject({
      version: 2,
      fingerprint: watchdog?.lastObservedFingerprint,
      materialLeaves: [],
      waitsByIssueId: {},
    });
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

  it("self mode posts the review on the watched issue and wakes the agent directly on it", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-SELF",
      status: "done",
      assigneeAgentId: agentId,
    });
    await seedWatchdog(companyId, sourceId, agentId, {
      mode: "self",
      instructions: "Verify the report exists and passes lint.",
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(result.watchdogIssueIds).toEqual([sourceId]);

    // No separate watchdog sub-task in self mode.
    const watchdogIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(0);

    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.agentId).toBe(agentId);
    expect(wakes[0]?.opts?.reason).toBe("task_watchdog_self_review");
    expect(wakes[0]?.opts?.idempotencyKey).toMatch(
      new RegExp(`^task_watchdog_self:[^:]+:${agentId}:task_watchdog_stop:`),
    );
    expect(wakes[0]?.opts?.contextSnapshot).toMatchObject({
      issueId: sourceId,
      taskId: sourceId,
      wakeReason: "task_watchdog_self_review",
      taskWatchdogSelfReview: {
        watchedIssueId: sourceId,
        watchedIssueIdentifier: "WDOG-SELF",
        goalInstructions: "Verify the report exists and passes lint.",
      },
    });
    // Self wakes must not carry the restricted task-watchdog mutation scope key.
    expect((wakes[0]?.opts?.contextSnapshot as Record<string, unknown>).taskWatchdog).toBeUndefined();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Self-watchdog review triggered");
    expect(comments[0]?.body).toContain("Verify the report exists and passes lint.");

    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.lastObservedFingerprint).toMatch(/^task_watchdog_stop:/);
    expect(watchdog?.lastReviewedFingerprint).toBe(watchdog?.lastObservedFingerprint);
    expect(watchdog?.watchdogIssueId).toBeNull();
    expect(watchdog?.triggerCount).toBe(1);

    // The same stopped state is reviewed-at-trigger: no re-wake, no comment churn.
    const second = await service.reconcileTaskWatchdogs({ companyId });
    expect(second).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(1);
    const commentsAfter = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceId));
    expect(commentsAfter).toHaveLength(1);
  });

  it("self mode atomically claims a stopped fingerprint across concurrent reconciliations", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-SELF-RACE",
      status: "done",
      assigneeAgentId: agentId,
    });
    await seedWatchdog(companyId, sourceId, agentId, {
      mode: "self",
      instructions: "Verify the report exists and passes lint.",
    });
    const { service, wakes } = createService();

    const results = await Promise.all([
      service.reconcileTaskWatchdogs({ companyId }),
      service.reconcileTaskWatchdogs({ companyId }),
    ]);

    expect(results.reduce((total, result) => total + result.triggered, 0)).toBe(1);
    expect(results.reduce((total, result) => total + result.alreadyReviewed, 0)).toBe(1);
    expect(wakes).toHaveLength(1);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceId));
    expect(comments).toHaveLength(1);
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.triggerCount).toBe(1);
  });

  it("rolls back the self-review wake when claim bookkeeping fails", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-SELF-ATOMIC-WAKE",
      status: "done",
      assigneeAgentId: agentId,
    });
    await seedWatchdog(companyId, sourceId, agentId, { mode: "self" });
    const failingService = taskWatchdogService(db, {
      enqueueWakeup: async (wakeAgentId, opts) => db.transaction(async (tx) => {
        await opts?.beforeIssueLock?.(tx);
        const [wakeupRequest] = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId,
            agentId: wakeAgentId,
            source: opts?.source ?? "automation",
            triggerDetail: opts?.triggerDetail,
            reason: opts?.reason,
            payload: opts?.payload,
            status: "queued",
            idempotencyKey: opts?.idempotencyKey,
          })
          .returning();
        const [run] = await tx
          .insert(heartbeatRuns)
          .values({
            companyId,
            agentId: wakeAgentId,
            invocationSource: opts?.source ?? "automation",
            triggerDetail: opts?.triggerDetail,
            status: "queued",
            wakeupRequestId: wakeupRequest!.id,
            contextSnapshot: opts?.contextSnapshot,
          })
          .returning();
        await tx
          .update(agentWakeupRequests)
          .set({ runId: run!.id })
          .where(eq(agentWakeupRequests.id, wakeupRequest!.id));
        await opts?.onWakeAccepted?.(tx, {
          wakeupRequestId: wakeupRequest!.id,
          runId: run!.id,
        });
        throw new Error("force self-review transaction rollback");
      }),
    });

    await expect(failingService.reconcileTaskWatchdogs({ companyId }))
      .rejects.toThrow("force self-review transaction rollback");

    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, sourceId))).toHaveLength(0);
    const [unclaimed] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(unclaimed).toMatchObject({
      lastReviewedFingerprint: null,
      triggerCount: 0,
    });

    const { service, wakes } = createService();
    const retried = await service.reconcileTaskWatchdogs({ companyId });
    expect(retried).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
  });

  it("retargets a self-mode watchdog to the current assignee before waking", async () => {
    const companyId = await seedCompany();
    const formerAssigneeId = await seedAgent(companyId, { name: "Former Assignee" });
    const currentAssigneeId = await seedAgent(companyId, { name: "Current Assignee" });
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-SELF-REASSIGNED",
      status: "done",
      assigneeAgentId: currentAssigneeId,
    });
    await seedWatchdog(companyId, sourceId, formerAssigneeId, { mode: "self" });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.agentId).toBe(currentAssigneeId);
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.watchdogAgentId).toBe(currentAssigneeId);
  });

  it("re-wakes the current assignee when reassignment overlaps self-review dispatch", async () => {
    const companyId = await seedCompany();
    const formerAssigneeId = await seedAgent(companyId, { name: "Former Assignee" });
    const currentAssigneeId = await seedAgent(companyId, { name: "Current Assignee" });
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-SELF-REASSIGN-RACE",
      status: "done",
      assigneeAgentId: formerAssigneeId,
    });
    await seedWatchdog(companyId, sourceId, formerAssigneeId, { mode: "self" });

    let signalWakeStarted!: () => void;
    const wakeStarted = new Promise<void>((resolve) => {
      signalWakeStarted = resolve;
    });
    let releaseWake!: () => void;
    const wakeCanFinish = new Promise<void>((resolve) => {
      releaseWake = resolve;
    });
    const firstWakes: string[] = [];
    const firstService = taskWatchdogService(db, {
      enqueueWakeup: async (agentId, opts) => {
        return db.transaction(async (tx) => {
          await opts?.beforeIssueLock?.(tx);
          firstWakes.push(agentId);
          const [wakeupRequest] = await tx
            .insert(agentWakeupRequests)
            .values({
              companyId,
              agentId,
              source: opts?.source ?? "automation",
              triggerDetail: opts?.triggerDetail,
              reason: opts?.reason,
              payload: opts?.payload,
              status: "running",
              claimedAt: new Date(),
              idempotencyKey: opts?.idempotencyKey,
            })
            .returning();
          const [run] = await tx
            .insert(heartbeatRuns)
            .values({
              companyId,
              agentId,
              invocationSource: opts?.source ?? "automation",
              triggerDetail: opts?.triggerDetail,
              status: "running",
              startedAt: new Date(),
              wakeupRequestId: wakeupRequest!.id,
              contextSnapshot: opts?.contextSnapshot,
            })
            .returning();
          await tx
            .update(agentWakeupRequests)
            .set({ runId: run!.id })
            .where(eq(agentWakeupRequests.id, wakeupRequest!.id));
          signalWakeStarted();
          await wakeCanFinish;
          await opts?.onWakeAccepted?.(tx, {
            wakeupRequestId: wakeupRequest!.id,
            runId: run!.id,
          });
          return { id: run!.id };
        });
      },
    });

    const firstReconcile = firstService.reconcileTaskWatchdogs({ companyId });
    await wakeStarted;
    const heartbeat = heartbeatService(db);
    const reassignment = issueService(db, {
      finalizeCancelledHeartbeatRun: heartbeat.finalizeCancelledRun,
    }).update(sourceId, { assigneeAgentId: currentAssigneeId });
    releaseWake();
    await Promise.all([firstReconcile, reassignment]);

    expect(firstWakes).toEqual([formerAssigneeId]);
    const [retargeted] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(retargeted).toMatchObject({
      watchdogAgentId: currentAssigneeId,
      lastReviewedFingerprint: null,
    });
    const [cancelledRun] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, formerAssigneeId));
    expect(cancelledRun).toMatchObject({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });
    const [cancelledWake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, formerAssigneeId));
    expect(cancelledWake).toMatchObject({ status: "cancelled" });

    const { service, wakes } = createService();
    const second = await service.reconcileTaskWatchdogs({ companyId });

    expect(second).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.agentId).toBe(currentAssigneeId);
    expect(wakes[0]?.opts?.idempotencyKey).toContain(currentAssigneeId);
  });

  it("rolls back self-review cancellation when reassignment fails", async () => {
    const companyId = await seedCompany();
    const formerAssigneeId = await seedAgent(companyId, { name: "Rollback Former Assignee" });
    const currentAssigneeId = await seedAgent(companyId, { name: "Rollback Current Assignee" });
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-SELF-REASSIGN-ROLLBACK",
      status: "done",
      assigneeAgentId: formerAssigneeId,
    });
    const watchdog = await seedWatchdog(companyId, sourceId, formerAssigneeId, { mode: "self" });
    const [wakeupRequest] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId,
        agentId: formerAssigneeId,
        source: "automation",
        triggerDetail: "system",
        reason: "task_watchdog_self_review",
        status: "running",
        claimedAt: new Date(),
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: formerAssigneeId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date(),
        wakeupRequestId: wakeupRequest!.id,
        contextSnapshot: {
          issueId: sourceId,
          taskWatchdogSelfReview: { watchdogId: watchdog!.id },
        },
      })
      .returning();
    await db
      .update(agentWakeupRequests)
      .set({ runId: run!.id })
      .where(eq(agentWakeupRequests.id, wakeupRequest!.id));

    await db.execute(sql`
      create or replace function fail_watchdog_reassignment_test()
      returns trigger as $$
      begin
        raise exception 'forced reassignment failure';
      end;
      $$ language plpgsql
    `);
    await db.execute(sql`
      create trigger fail_watchdog_reassignment_test_trigger
      before update on issues
      for each row execute function fail_watchdog_reassignment_test()
    `);
    const finalizedRunIds: string[] = [];
    try {
      await expect(issueService(db, {
        finalizeCancelledHeartbeatRun: async (runId) => {
          finalizedRunIds.push(runId);
        },
      }).update(sourceId, { assigneeAgentId: currentAssigneeId }))
        .rejects.toThrow("Failed query: update \"issues\"");
    } finally {
      await db.execute(sql`drop trigger if exists fail_watchdog_reassignment_test_trigger on issues`);
      await db.execute(sql`drop function if exists fail_watchdog_reassignment_test()`);
    }

    const [unchangedIssue] = await db.select().from(issues).where(eq(issues.id, sourceId));
    const [unchangedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    const [unchangedWake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequest!.id));
    expect(unchangedIssue?.assigneeAgentId).toBe(formerAssigneeId);
    expect(unchangedRun?.status).toBe("running");
    expect(unchangedWake?.status).toBe("running");
    expect(finalizedRunIds).toEqual([]);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run!.id))).toHaveLength(0);
  });

  it("retries a self review when the wake was not queued", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-SELF-RETRY",
      status: "done",
      assigneeAgentId: agentId,
    });
    await seedWatchdog(companyId, sourceId, agentId, { mode: "self" });
    const suppressedService = taskWatchdogService(db, {
      enqueueWakeup: async () => null,
    });

    const suppressed = await suppressedService.reconcileTaskWatchdogs({ companyId });

    expect(suppressed).toMatchObject({ checked: 1, triggered: 0, skipped: 1 });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, sourceId))).toHaveLength(0);
    const [unreviewed] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(unreviewed?.lastReviewedFingerprint).toBeNull();
    expect(unreviewed?.triggerCount).toBe(0);

    const { service, wakes } = createService();
    const retried = await service.reconcileTaskWatchdogs({ companyId });

    expect(retried).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, sourceId))).toHaveLength(1);
  });

  it("claims a deferred self-review wake without duplicating it on reconciliation", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-SELF-DEFERRED",
      status: "done",
      assigneeAgentId: agentId,
    });
    await seedWatchdog(companyId, sourceId, agentId, { mode: "self" });
    const service = taskWatchdogService(db, {
      enqueueWakeup: async (wakeAgentId, opts) => db.transaction(async (tx) => {
        await opts?.beforeIssueLock?.(tx);
        const [deferred] = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId,
            agentId: wakeAgentId,
            source: opts?.source ?? "automation",
            triggerDetail: opts?.triggerDetail,
            reason: opts?.reason,
            payload: {
              ...(opts?.payload ?? {}),
              issueId: sourceId,
              _paperclipWakeContext: opts?.contextSnapshot,
            },
            status: "deferred_issue_execution",
            idempotencyKey: opts?.idempotencyKey,
          })
          .returning();
        await opts?.onWakeAccepted?.(tx, {
          wakeupRequestId: deferred!.id,
          runId: null,
        });
        return null;
      }),
    });

    const first = await service.reconcileTaskWatchdogs({ companyId });
    const second = await service.reconcileTaskWatchdogs({ companyId });

    expect(first).toMatchObject({ checked: 1, triggered: 1 });
    expect(second).toMatchObject({ checked: 1, triggered: 0, live: 1 });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, sourceId))).toHaveLength(1);
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.lastReviewedFingerprint).not.toBeNull();
    expect(watchdog?.triggerCount).toBe(1);
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
    expect(reviewedWatchdog?.lastReviewedStopSnapshot).toEqual(firstWatchdog?.lastObservedStopSnapshot);

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

  it("suppresses a shrink-only stop after review when the snapshot round-trips through jsonb", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-SHRINK", status: "in_review" });
    const waitingLeafId = await seedIssue(companyId, { parentId: sourceId, status: "in_review" });
    const siblingLeafId = await seedIssue(companyId, { parentId: sourceId, status: "in_progress" });
    const agentId = await seedAgent(companyId);
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId: waitingLeafId,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Confirm the stop." },
      createdByAgentId: agentId,
    });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    const [triggeredWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, triggeredWatchdog!.watchdogIssueId!));
    const reviewed = await service.reconcileTaskWatchdogs({ companyId });
    expect(reviewed).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    const [reviewedWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(reviewedWatchdog?.lastReviewedStopSnapshot).not.toBeNull();

    // The sibling completing shrinks the material leaf set while the wait set
    // is unchanged; the reviewed snapshot loaded back from jsonb (which does
    // not preserve object key order) must still suppress the wake.
    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(issues.id, siblingLeafId));
    const afterShrink = await service.reconcileTaskWatchdogs({ companyId });

    expect(afterShrink).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(1);
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
    expect(reviewedWatchdog?.lastReviewedStopSnapshot).toBeNull();
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

  it("keeps watchdog mutation scope valid across metadata-only source evidence", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-REVALIDATE", status: "blocked" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const originalFingerprint = watchdog!.lastObservedFingerprint!;
    expect(originalFingerprint).toMatch(/^task_watchdog_stop:/);

    const later = new Date(Date.now() + 60_000);
    await db.insert(issueComments).values({
      companyId,
      issueId: sourceId,
      authorType: "agent",
      body: "Fresh source evidence.",
      updatedAt: later,
      createdAt: later,
    });
    await seedIssueDocument(companyId, sourceId, new Date(later.getTime() + 1_000));
    await seedIssueWorkProduct(companyId, sourceId, new Date(later.getTime() + 2_000));

    const revalidated = await service.revalidateMutationScope({
      kind: "watchdog",
      watchdogId: watchdog!.id,
      companyId,
      watchedIssueId: sourceId,
      stopFingerprint: originalFingerprint,
    });

    expect(revalidated.allowed).toBe(true);
    expect(revalidated.classification?.state).toBe("stopped");
    if (revalidated.classification?.state !== "stopped") throw new Error("Expected stopped classification");
    expect(revalidated.classification.stopFingerprint).toBe(originalFingerprint);
    expect(revalidated.classification.stoppedLeaves[0]).toMatchObject({
      latestCommentAt: later.toISOString(),
      latestDocumentAt: new Date(later.getTime() + 1_000).toISOString(),
      latestWorkProductAt: new Date(later.getTime() + 2_000).toISOString(),
    });
  });

  it("surfaces pending interaction kinds and approval ids in the wake and watchdog comment", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-WAITS", status: "in_review" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const interactionId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId: sourceId,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Confirm the reviewed stop." },
      createdByAgentId: agentId,
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      requestedByAgentId: agentId,
      status: "pending",
      payload: { summary: "Approve the reviewed stop." },
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId: sourceId,
      approvalId,
      linkedByAgentId: agentId,
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes[0]?.opts?.contextSnapshot).toMatchObject({
      taskWatchdog: {
        pendingInteractions: {
          [sourceId]: [{ id: interactionId, kind: "request_confirmation" }],
        },
        pendingApprovals: {
          [sourceId]: [approvalId],
        },
      },
    });
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.lastObservedStopSnapshot).toMatchObject({
      waitsByIssueId: {
        [sourceId]: {
          pendingInteractionIds: [interactionId],
          pendingApprovalIds: [approvalId],
        },
      },
    });
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdog!.watchdogIssueId!));
    expect(comments.at(-1)?.body).toContain(`pending request_confirmation ${interactionId.slice(0, 8)}…`);
    expect(comments.at(-1)?.body).toContain(`approval ${approvalId.slice(0, 8)}…`);
    const metadata = comments.at(-1)?.metadata as { sections?: Array<{ rows?: unknown[] }> } | null;
    expect(metadata?.sections?.[0]?.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Pending waits", text: "2" }),
    ]));
  });

  it("revalidates a stale watchdog review as live when the source gets a fresh run path", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-LIVE-REVALIDATE", status: "blocked" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const originalFingerprint = watchdog!.lastObservedFingerprint!;
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: sourceId },
    });

    const revalidated = await service.revalidateMutationScope({
      kind: "watchdog",
      watchdogId: watchdog!.id,
      companyId,
      watchedIssueId: sourceId,
      stopFingerprint: originalFingerprint,
    });

    expect(revalidated.allowed).toBe(false);
    expect(revalidated.reason).toContain("now has a live");
    expect(revalidated.classification?.state).toBe("live");
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
