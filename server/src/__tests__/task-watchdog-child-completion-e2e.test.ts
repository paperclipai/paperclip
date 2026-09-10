import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issueThreadInteractions,
  issueWatchdogs,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const heartbeatDouble = vi.hoisted(() => ({
  wakeup: vi.fn(),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

vi.mock("../services/heartbeat.js", async () => {
  const actual = await vi.importActual<typeof import("../services/heartbeat.js")>("../services/heartbeat.js");
  return {
    ...actual,
    heartbeatService: () => heartbeatDouble,
  };
});

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping task-watchdog child-completion API/PostgreSQL tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("task-watchdog child-completion API/PostgreSQL boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-watchdog-child-completion-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
    heartbeatDouble.reportRunActivity.mockResolvedValue(undefined);
    heartbeatDouble.getRun.mockResolvedValue(null);
    heartbeatDouble.getActiveRunForAgent.mockResolvedValue(null);
    heartbeatDouble.cancelRun.mockResolvedValue(null);
    heartbeatDouble.wakeup.mockImplementation(async (agentId: string, options: Record<string, any> = {}) => {
      const agent = await db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (!agent) throw new Error(`Missing queued-wake agent ${agentId}`);

      if (typeof options.idempotencyKey === "string") {
        const existing = await db
          .select({ runId: agentWakeupRequests.runId })
          .from(agentWakeupRequests)
          .where(and(
            eq(agentWakeupRequests.companyId, agent.companyId),
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.idempotencyKey, options.idempotencyKey),
          ))
          .then((rows) => rows[0] ?? null);
        if (existing?.runId) return { id: existing.runId };
      }

      const wakeupRequestId = randomUUID();
      const runId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(agentWakeupRequests).values({
          id: wakeupRequestId,
          companyId: agent.companyId,
          agentId,
          source: options.source ?? "automation",
          triggerDetail: options.triggerDetail ?? null,
          reason: options.reason ?? null,
          payload: options.payload ?? null,
          status: "queued",
          requestedByActorType: options.requestedByActorType ?? null,
          requestedByActorId: options.requestedByActorId ?? null,
          idempotencyKey: options.idempotencyKey ?? null,
        });
        await tx.insert(heartbeatRuns).values({
          id: runId,
          companyId: agent.companyId,
          agentId,
          invocationSource: options.source ?? "automation",
          triggerDetail: options.triggerDetail ?? null,
          status: "queued",
          wakeupRequestId,
          contextSnapshot: options.contextSnapshot ?? options.payload ?? null,
        });
        await tx
          .update(agentWakeupRequests)
          .set({ runId, updatedAt: new Date() })
          .where(eq(agentWakeupRequests.id, wakeupRequestId));
      });
      return { id: runId };
    });
  });

  afterEach(async () => {
    await settleWakeups();
    await db.delete(activityLog);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueWatchdogs);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    app.use(errorHandler);
    return app;
  }

  async function settleWakeups() {
    let previousCallCount = -1;
    let stablePasses = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const wakeupPromises = heartbeatDouble.wakeup.mock.results
        .map((result) => result.value)
        .filter((value): value is Promise<unknown> => value instanceof Promise);
      await Promise.allSettled(wakeupPromises);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const callCount = heartbeatDouble.wakeup.mock.calls.length;
      stablePasses = callCount === previousCallCount ? stablePasses + 1 : 0;
      if (stablePasses >= 3) return;
      previousCallCount = callCount;
    }
    throw new Error("Deferred issue wakeups did not settle");
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog child-completion e2e",
      issuePrefix: `W${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Issue",
      status: overrides.status ?? "todo",
      priority: overrides.priority ?? "medium",
      createdAt: overrides.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
      ...overrides,
    });
    return id;
  }

  async function patchStatus(app: express.Express, issueId: string, body: Record<string, unknown>) {
    const response = await request(app).patch(`/api/issues/${issueId}`).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await settleWakeups();
    return response;
  }

  async function addApprovalComment(app: express.Express, issueId: string) {
    const response = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "## Review: APPROVED\n\nWatchdog disposition accepted." });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    await settleWakeups();
    return response;
  }

  async function wakeRows(companyId: string, issueId: string, reason: string) {
    const rows = await db
      .select({
        id: agentWakeupRequests.id,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
        runId: agentWakeupRequests.runId,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    return rows.filter((row) => row.reason === reason && row.payload?.issueId === issueId);
  }

  async function sourceRunIds(companyId: string, agentId: string, issueId: string) {
    const rows = await db
      .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    return rows
      .filter((row) => row.contextSnapshot?.issueId === issueId || row.contextSnapshot?.taskId === issueId)
      .map((row) => row.id)
      .sort();
  }

  async function sourceSnapshot(input: {
    companyId: string;
    sourceIssueId: string;
    sourceAgentId: string;
    interactionId?: string;
  }) {
    const source = await db
      .select({ status: issues.status, updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, input.sourceIssueId))
      .then((rows) => rows[0]!);
    const watchdog = await db
      .select({ lastObservedFingerprint: issueWatchdogs.lastObservedFingerprint })
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.companyId, input.companyId),
        eq(issueWatchdogs.issueId, input.sourceIssueId),
      ))
      .then((rows) => rows[0]!);
    const interaction = input.interactionId
      ? await db
        .select({ status: issueThreadInteractions.status, result: issueThreadInteractions.result })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, input.interactionId))
        .then((rows) => rows[0] ?? null)
      : null;
    return {
      status: source.status,
      updatedAt: source.updatedAt.toISOString(),
      interaction,
      lastObservedFingerprint: watchdog.lastObservedFingerprint,
      sourceRunIds: await sourceRunIds(input.companyId, input.sourceAgentId, input.sourceIssueId),
    };
  }

  it("keeps blocked/review waits, pending interaction, source runs, and stop fingerprints stable across watchdog lifecycles", async () => {
    const companyId = await seedCompany();
    const reviewSourceAgentId = await seedAgent(companyId, "Review source agent");
    const blockedSourceAgentId = await seedAgent(companyId, "Blocked source agent");
    const watchdogAgentId = await seedAgent(companyId, "Watchdog agent");
    const humanBlockerId = await seedIssue(companyId, {
      title: "Human decision",
      status: "todo",
      assigneeUserId: "cloud-user-1",
      issueNumber: 1,
    });
    const reviewSourceId = await seedIssue(companyId, {
      title: "Source waiting in review",
      status: "in_review",
      assigneeAgentId: reviewSourceAgentId,
      issueNumber: 2,
      updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    const blockedSourceId = await seedIssue(companyId, {
      title: "Source waiting on a human blocker",
      status: "blocked",
      assigneeAgentId: blockedSourceAgentId,
      issueNumber: 3,
      updatedAt: new Date("2026-08-01T11:00:00.000Z"),
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: humanBlockerId,
      relatedIssueId: blockedSourceId,
      type: "blocks",
      createdByUserId: "cloud-user-1",
    });
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId: reviewSourceId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Approve the current source result?",
        supersedeOnUserComment: false,
      },
      createdByUserId: "cloud-user-1",
    });

    const reviewPolicy = normalizeIssueExecutionPolicy({
      stages: [{
        id: randomUUID(),
        type: "review",
        approvalsNeeded: 1,
        participants: [{ type: "user", userId: "cloud-user-1" }],
      }],
    })!;
    const reviewWatchdogId = await seedIssue(companyId, {
      title: "Review-source watchdog",
      status: "todo",
      parentId: reviewSourceId,
      assigneeAgentId: watchdogAgentId,
      issueNumber: 4,
      originKind: "task_watchdog",
      originId: reviewSourceId,
      originFingerprint: "bootstrap",
      executionPolicy: reviewPolicy,
    });
    const blockedWatchdogId = await seedIssue(companyId, {
      title: "Blocked-source watchdog",
      status: "in_progress",
      parentId: blockedSourceId,
      assigneeAgentId: watchdogAgentId,
      issueNumber: 5,
      originKind: "task_watchdog",
      originId: blockedSourceId,
      originFingerprint: "bootstrap",
    });
    await db.insert(issueWatchdogs).values([
      {
        companyId,
        issueId: reviewSourceId,
        watchdogAgentId,
        watchdogIssueId: reviewWatchdogId,
        status: "active",
      },
      {
        companyId,
        issueId: blockedSourceId,
        watchdogAgentId,
        watchdogIssueId: blockedWatchdogId,
        status: "active",
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        companyId,
        agentId: reviewSourceAgentId,
        status: "succeeded",
        contextSnapshot: { issueId: reviewSourceId },
      },
      {
        companyId,
        agentId: blockedSourceAgentId,
        status: "succeeded",
        contextSnapshot: { issueId: blockedSourceId },
      },
    ]);

    await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId });
    const reviewBefore = await sourceSnapshot({
      companyId,
      sourceIssueId: reviewSourceId,
      sourceAgentId: reviewSourceAgentId,
      interactionId,
    });
    const blockedBefore = await sourceSnapshot({
      companyId,
      sourceIssueId: blockedSourceId,
      sourceAgentId: blockedSourceAgentId,
    });
    expect(reviewBefore.lastObservedFingerprint).toMatch(/^task_watchdog_stop:/);
    expect(blockedBefore.lastObservedFingerprint).toMatch(/^task_watchdog_stop:/);

    const app = createApp(companyId);
    await patchStatus(app, blockedWatchdogId, { status: "cancelled" });
    await patchStatus(app, blockedWatchdogId, { status: "cancelled" });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await patchStatus(app, reviewWatchdogId, { status: "in_review" });
      await addApprovalComment(app, reviewWatchdogId);
      if (cycle < 2) {
        await patchStatus(app, reviewWatchdogId, {
          status: "todo",
          assigneeAgentId: watchdogAgentId,
          assigneeUserId: null,
        });
      }
    }

    expect(await sourceSnapshot({
      companyId,
      sourceIssueId: reviewSourceId,
      sourceAgentId: reviewSourceAgentId,
      interactionId,
    })).toEqual(reviewBefore);
    expect(await sourceSnapshot({
      companyId,
      sourceIssueId: blockedSourceId,
      sourceAgentId: blockedSourceAgentId,
    })).toEqual(blockedBefore);
    expect(await wakeRows(companyId, reviewSourceId, "issue_children_completed")).toHaveLength(0);
    expect(await wakeRows(companyId, blockedSourceId, "issue_children_completed")).toHaveLength(0);

    const finalInteraction = await db
      .select({ status: issueThreadInteractions.status, result: issueThreadInteractions.result })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId))
      .then((rows) => rows[0]);
    expect(finalInteraction).toEqual({ status: "pending", result: null });
  });

  it("wakes actionable parents exactly once for the last normal child in either completion order and filters watchdog payload data", async () => {
    const companyId = await seedCompany();
    const parentAgentId = await seedAgent(companyId, "Parent agent");
    const app = createApp(companyId);

    for (const [caseIndex, completionOrder] of [[0, [0, 1]], [1, [1, 0]]] as const) {
      const parentId = await seedIssue(companyId, {
        title: `Mixed parent ${caseIndex}`,
        status: caseIndex === 0 ? "todo" : "in_progress",
        assigneeAgentId: parentAgentId,
        issueNumber: 10 + caseIndex * 10,
      });
      const normalChildIds = [randomUUID(), randomUUID()];
      await db.insert(issues).values([
        {
          id: normalChildIds[0],
          companyId,
          parentId,
          title: "Near-collision normal child",
          status: "todo",
          priority: "medium",
          issueNumber: 11 + caseIndex * 10,
          originKind: "task_watchdog_product_bug",
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        },
        {
          id: normalChildIds[1],
          companyId,
          parentId,
          title: "Arbitrary-origin normal child",
          status: "todo",
          priority: "medium",
          issueNumber: 12 + caseIndex * 10,
          originKind: "custom_automation",
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        },
        {
          companyId,
          parentId,
          title: "Synthetic watchdog sibling",
          status: caseIndex === 0 ? "in_progress" : "done",
          priority: "medium",
          issueNumber: 13 + caseIndex * 10,
          originKind: "task_watchdog",
          originId: parentId,
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      ]);

      const firstId = normalChildIds[completionOrder[0]];
      const lastId = normalChildIds[completionOrder[1]];
      await patchStatus(app, firstId, { status: "done" });
      expect(await wakeRows(companyId, parentId, "issue_children_completed")).toHaveLength(0);

      await patchStatus(app, lastId, { status: caseIndex === 0 ? "cancelled" : "done" });
      const rows = await wakeRows(companyId, parentId, "issue_children_completed");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({
        issueId: parentId,
        completedChildIssueId: lastId,
        childIssueIds: normalChildIds,
        childIssueSummaries: [
          expect.objectContaining({ id: normalChildIds[0], title: "Near-collision normal child" }),
          expect.objectContaining({ id: normalChildIds[1], title: "Arbitrary-origin normal child" }),
        ],
        childIssueSummaryTruncated: false,
      });
      expect(JSON.stringify(rows[0]?.payload)).not.toContain("Synthetic watchdog sibling");

      await patchStatus(app, lastId, { status: "done" });
      expect(await wakeRows(companyId, parentId, "issue_children_completed")).toHaveLength(1);
    }

    const normalOnlyParentId = await seedIssue(companyId, {
      title: "Normal-only parent",
      status: "todo",
      assigneeAgentId: parentAgentId,
      issueNumber: 40,
    });
    const normalOnlyChildId = await seedIssue(companyId, {
      title: "Only normal child",
      status: "in_progress",
      parentId: normalOnlyParentId,
      issueNumber: 41,
      originKind: "manual",
    });
    await patchStatus(app, normalOnlyChildId, { status: "done" });
    expect(await wakeRows(companyId, normalOnlyParentId, "issue_children_completed")).toHaveLength(1);

    for (const [offset, parentStatus] of [[50, "backlog"], [60, "done"]] as const) {
      const parentId = await seedIssue(companyId, {
        title: `${parentStatus} parent`,
        status: parentStatus,
        assigneeAgentId: parentAgentId,
        issueNumber: offset,
      });
      const childId = await seedIssue(companyId, {
        title: `Child of ${parentStatus} parent`,
        status: "todo",
        parentId,
        issueNumber: offset + 1,
      });
      await patchStatus(app, childId, { status: "done" });
      expect(await wakeRows(companyId, parentId, "issue_children_completed")).toHaveLength(0);
    }
  });

  it("preserves explicit issue_blockers_resolved while suppressing child completion and duplicate queue rows", async () => {
    const companyId = await seedCompany();
    const sourceAgentId = await seedAgent(companyId, "Blocked source agent");
    const watchdogAgentId = await seedAgent(companyId, "Watchdog agent");
    const sourceId = await seedIssue(companyId, {
      title: "Source explicitly blocked by watchdog",
      status: "blocked",
      assigneeAgentId: sourceAgentId,
      issueNumber: 70,
      updatedAt: new Date("2026-08-02T10:00:00.000Z"),
    });
    const watchdogId = await seedIssue(companyId, {
      title: "Explicit blocker watchdog",
      status: "in_progress",
      assigneeAgentId: watchdogAgentId,
      parentId: sourceId,
      issueNumber: 71,
      originKind: "task_watchdog",
      originId: sourceId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: watchdogId,
      relatedIssueId: sourceId,
      type: "blocks",
      createdByUserId: "cloud-user-1",
    });
    const sourceBefore = await db
      .select({ status: issues.status, updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, sourceId))
      .then((rows) => rows[0]!);

    const app = createApp(companyId);
    await patchStatus(app, watchdogId, { status: "done" });
    expect(await wakeRows(companyId, sourceId, "issue_blockers_resolved")).toHaveLength(1);
    expect(await wakeRows(companyId, sourceId, "issue_children_completed")).toHaveLength(0);
    expect(await sourceRunIds(companyId, sourceAgentId, sourceId)).toHaveLength(1);

    await patchStatus(app, watchdogId, { status: "done" });
    await patchStatus(app, watchdogId, {
      status: "todo",
      assigneeAgentId: watchdogAgentId,
      assigneeUserId: null,
    });
    await patchStatus(app, watchdogId, { status: "done" });
    const dependencyRows = await wakeRows(companyId, sourceId, "issue_blockers_resolved");
    expect(dependencyRows).toHaveLength(1);
    expect(dependencyRows[0]?.idempotencyKey).toMatch(/^issue_blockers_resolved:/);
    expect(await wakeRows(companyId, sourceId, "issue_children_completed")).toHaveLength(0);
    expect(await sourceRunIds(companyId, sourceAgentId, sourceId)).toHaveLength(1);

    const sourceAfter = await db
      .select({ status: issues.status, updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, sourceId))
      .then((rows) => rows[0]!);
    expect(sourceAfter.status).toBe(sourceBefore.status);
    expect(sourceAfter.updatedAt.toISOString()).toBe(sourceBefore.updatedAt.toISOString());
  });
});
