import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers,
  companyMemberships,
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale execution lock route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("stale issue execution lock routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-execution-lock-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueExecutionDecisions);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAgentAndRuns() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const currentRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({ id: "board-user", name: "Board", email: "board@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "admin" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date(),
      },
      {
        id: currentRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return { companyId, agentId, failedRunId, currentRunId };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  function boardActor(
    companyId: string,
    userId = "board-user",
  ): Express.Request["actor"] {
    return {
      type: "board",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  it("allows an assigned agent PATCH to recover a terminal stale executionRunId", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale execution lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, currentRunId));

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Recovered execution lock" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Recovered execution lock");

    const row = await db
      .select({
        title: issues.title,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      title: "Recovered execution lock",
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it.each([
    { status: "done" as const, title: "Done release preserves owner", completedAt: new Date(), retainAssignee: true },
    { status: "cancelled" as const, title: "Cancelled release preserves owner", cancelledAt: new Date(), retainAssignee: true },
    { status: "in_review" as const, title: "In review release preserves status" },
    { status: "blocked" as const, title: "Blocked release preserves status" },
    { status: "backlog" as const, title: "Backlog release relinquishes ownership" },
    { status: "todo" as const, title: "Todo release relinquishes ownership" },
    { status: "in_progress" as const, title: "Active release requeues work", expectedStatus: "todo" },
  ])(
    "$title and clears execution locks",
    async ({ status, title, completedAt, cancelledAt, retainAssignee, expectedStatus = status }) => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title,
        status,
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: currentRunId,
        executionRunId: currentRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
        ...(completedAt ? { completedAt } : {}),
        ...(cancelledAt ? { cancelledAt } : {}),
      });

      const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
        .post(`/api/issues/${issueId}/release`)
        .send();

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const expectedAssignee = retainAssignee ? agentId : null;
      expect(res.body).toMatchObject({ status: expectedStatus, assigneeAgentId: expectedAssignee });

      const row = await db
        .select({
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
          completedAt: issues.completedAt,
          cancelledAt: issues.cancelledAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row).toEqual({
        status: expectedStatus,
        assigneeAgentId: expectedAssignee,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        completedAt: completedAt ?? null,
        cancelledAt: cancelledAt ?? null,
      });

      const events = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
      expect(events).toContainEqual(expect.objectContaining({
        action: "issue.released", companyId, agentId, runId: currentRunId,
      }));

      if (retainAssignee) {
        // Repeated cleanup, including by the board, must not erase attribution.
        const retried = await request(createApp(boardActor(companyId)))
          .post(`/api/issues/${issueId}/release`)
          .send();
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        expect(retried.body).toMatchObject({ status, assigneeAgentId: agentId, checkoutRunId: null, executionRunId: null });
        const [saved] = await db.select().from(issues).where(eq(issues.id, issueId));
        expect(saved).toMatchObject(row);
      }
    },
  );

  it("allows the rightful assignee to release after the owning run failed", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Failed run release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("lets the current assignee recover a timed_out stale checkout owner during PATCH", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const timedOutRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: timedOutRunId,
      companyId,
      agentId,
      status: "timed_out",
      invocationSource: "manual",
      finishedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: timedOutRunId,
      executionRunId: timedOutRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, currentRunId));

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Recovered stale checkout lock" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("still returns 409 when a different live checkout owner is active", async () => {
    const { companyId, agentId, failedRunId } = await seedCompanyAgentAndRuns();
    const liveOwnerRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveOwnerRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live checkout lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: liveOwnerRunId,
      executionRunId: liveOwnerRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, failedRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should fail" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error).toBe("Issue run ownership conflict");
  });

  it("preserves live checkout ownership on checkout conflicts without retry side effects", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const contenderRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: contenderRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live checkout race",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, contenderRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Issue checkout conflict",
    });

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });

    const checkoutActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.checked_out"));
    expect(checkoutActivity).toHaveLength(0);
  });

  it("preserves in_review when the live staged reviewer checks out", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const stageId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Staged review checkout",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          participants: [{ type: "agent", agentId }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["in_review"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: "in_review",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
    expect(res.body.startedAt).toBeTruthy();
  });

  it("rejects a stale concurrent stage decision without duplicating or rewinding execution", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const reviewStageId = randomUUID();
    const approvalStageId = randomUUID();
    const approverUserId = "second-board-user";
    await db.insert(authUsers).values({
      id: approverUserId,
      name: "Second Board User",
      email: "second-board@example.test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: approverUserId,
      status: "active",
      membershipRole: "admin",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Concurrent staged decision",
      status: "in_review",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: "board-user",
      checkoutRunId: null,
      executionRunId: null,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: reviewStageId,
            type: "review",
            participants: [{ type: "user", userId: "board-user" }],
          },
          {
            id: approvalStageId,
            type: "approval",
            participants: [{ type: "user", userId: approverUserId }],
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "user", userId: "board-user" },
        returnAssignee: { type: "agent", agentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    let resolveRowLocked!: () => void;
    let releaseRowLock!: () => void;
    const rowLocked = new Promise<void>((resolve) => {
      resolveRowLocked = resolve;
    });
    const rowLockRelease = new Promise<void>((resolve) => {
      releaseRowLock = resolve;
    });
    const lockHolder = db.transaction(async (tx) => {
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, issueId))
        .for("update");
      resolveRowLocked();
      await rowLockRelease;
    });
    await rowLocked;

    const decide = (comment: string) =>
      request(createApp(boardActor(companyId)))
        .patch(`/api/issues/${issueId}`)
        .send({ executionDecision: "approve", expectedExecutionStageId: reviewStageId, expectedExecutionLastDecisionId: null, comment })
        .then((response) => response);
    const firstDecision = decide("First concurrent approval");
    const secondDecision = decide("Second concurrent approval");

    try {
      const deadline = Date.now() + 5_000;
      let lockWaiters = 0;
      while (Date.now() < deadline) {
        const rows = await db.execute(sql`
          select count(*)::int as count
          from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
        `);
        lockWaiters = Number(rows[0]?.count ?? 0);
        if (lockWaiters >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(lockWaiters).toBeGreaterThanOrEqual(2);
    } finally {
      releaseRowLock();
      await lockHolder;
    }

    const responses = await Promise.all([firstDecision, secondDecision]);
    const successful = responses.filter((response) => response.status === 200);
    const stale = responses.filter((response) => response.status === 409);
    expect(successful).toHaveLength(1);
    expect(
      stale,
      JSON.stringify(
        responses.map((response) => ({
          status: response.status,
          body: response.body,
        })),
      ),
    ).toHaveLength(1);
    expect(stale[0]?.body.details).toMatchObject({
      code: "execution_stage_changed",
    });

    const [saved] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(saved).toMatchObject({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: approverUserId,
      executionState: {
        status: "pending",
        currentStageId: approvalStageId,
        currentStageIndex: 1,
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: approverUserId },
        completedStageIds: [reviewStageId],
        lastDecisionOutcome: "approved",
      },
    });
    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      stageId: reviewStageId,
      outcome: "approved",
    });
  });

  it.each([
    { decision: "approve" as const, expectedStatus: "in_review", expectedOutcome: "approved" },
    { decision: "request_changes" as const, expectedStatus: "in_progress", expectedOutcome: "changes_requested" },
  ])(
    "commits a checked-out reviewer's $decision after its exact self-stop releases the run locks",
    async ({ decision, expectedStatus, expectedOutcome }) => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const issueId = randomUUID();
      const reviewStageId = randomUUID();
      const approvalStageId = randomUUID();
      const approvalAgentId = randomUUID();
      const returnAgentId = randomUUID();
      await db.insert(agents).values([
        {
          id: approvalAgentId,
          companyId,
          name: "NextStageAgent",
          role: "reviewer",
          status: "paused",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: returnAgentId,
          companyId,
          name: "ReturnAgent",
          role: "engineer",
          status: "paused",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
      ]);
      await db.update(heartbeatRuns)
        .set({ contextSnapshot: { issueId } })
        .where(eq(heartbeatRuns.id, currentRunId));
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Checked-out reviewer ${decision}`,
        status: "in_review",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: currentRunId,
        executionRunId: currentRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [
            { id: reviewStageId, type: "review", participants: [{ type: "agent", agentId }] },
            { id: approvalStageId, type: "approval", participants: [{ type: "agent", agentId: approvalAgentId }] },
          ],
        },
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId },
          returnAssignee: { type: "agent", agentId: returnAgentId },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      });

      const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
        .patch(`/api/issues/${issueId}`)
        .send({
          executionDecision: decision,
          expectedExecutionStageId: reviewStageId,
          expectedExecutionLastDecisionId: null,
          comment: decision === "approve" ? "Review approved" : "Please revise this work",
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        status: expectedStatus,
        assigneeAgentId: decision === "approve" ? approvalAgentId : returnAgentId,
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionState: decision === "approve"
          ? {
              status: "pending",
              currentStageId: approvalStageId,
              currentParticipant: { type: "agent", agentId: approvalAgentId },
              lastDecisionOutcome: "approved",
            }
          : {
              status: "changes_requested",
              currentStageId: reviewStageId,
              lastDecisionOutcome: "changes_requested",
            },
      });
      expect(
        await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, currentRunId)).then((rows) => rows[0]?.status),
      ).toBe("cancelled");
      expect(
        await db.select().from(issueExecutionDecisions)
          .where(eq(issueExecutionDecisions.issueId, issueId)),
      ).toEqual([
        expect.objectContaining({ stageId: reviewStageId, outcome: expectedOutcome }),
      ]);
      // The route publishes the next assignment after commit. Let its skipped
      // wake settle before this disposable database removes the participant.
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  );

  it("preserves a native run across consecutive stages owned by the same agent", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const reviewStageId = randomUUID();
    const approvalStageId = randomUUID();
    await db.update(heartbeatRuns)
      .set({ runtimeMode: "native", contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, currentRunId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Consecutive same-agent native stages",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          { id: reviewStageId, type: "review", participants: [{ type: "agent", agentId }] },
          { id: approvalStageId, type: "approval", participants: [{ type: "agent", agentId }] },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({
        executionDecision: "approve",
        expectedExecutionStageId: reviewStageId,
        expectedExecutionLastDecisionId: null,
        comment: "Review approved; continue to approval",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: "in_review",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionState: {
        status: "pending",
        currentStageId: approvalStageId,
        currentStageIndex: 1,
        currentParticipant: { type: "agent", agentId },
        completedStageIds: [reviewStageId],
        lastDecisionOutcome: "approved",
      },
    });
    expect(
      await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, currentRunId)).then((rows) => rows[0]?.status),
    ).toBe("running");
  });

  it.each([
    { finalStage: false, title: "intermediate" },
    { finalStage: true, title: "final" },
  ])(
    "lets a recovered native reviewer approve an $title stage after adopting a failed run's locks",
    async ({ finalStage }) => {
      const { companyId, agentId, failedRunId, currentRunId } =
        await seedCompanyAgentAndRuns();
      const issueId = randomUUID();
      const reviewStageId = randomUUID();
      const approvalStageId = randomUUID();
      await db.update(heartbeatRuns)
        .set({ runtimeMode: "native", contextSnapshot: { issueId } })
        .where(eq(heartbeatRuns.id, currentRunId));
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Recovered native ${finalStage ? "final" : "intermediate"} approval`,
        status: "in_review",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: failedRunId,
        executionRunId: failedRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [
            {
              id: reviewStageId,
              type: "review",
              participants: [{ type: "agent", agentId }],
            },
            ...(!finalStage
              ? [{
                  id: approvalStageId,
                  type: "approval" as const,
                  participants: [{ type: "agent" as const, agentId }],
                }]
              : []),
          ],
        },
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId },
          returnAssignee: null,
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      });

      const res = await request(
        createApp(agentActor(companyId, agentId, currentRunId)),
      )
        .patch(`/api/issues/${issueId}`)
        .send({
          executionDecision: "approve",
          expectedExecutionStageId: reviewStageId,
          expectedExecutionLastDecisionId: null,
          comment: finalStage
            ? "Final review approved; report through paperclip_finish"
            : "Review approved; advance to the next stage",
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject(
        finalStage
          ? {
              status: "in_review",
              assigneeAgentId: agentId,
              checkoutRunId: currentRunId,
              executionRunId: currentRunId,
              executionState: {
                status: "completed",
                completedStageIds: [reviewStageId],
                lastDecisionOutcome: "approved",
              },
            }
          : {
              status: "in_review",
              assigneeAgentId: agentId,
              checkoutRunId: currentRunId,
              executionRunId: currentRunId,
              executionState: {
                status: "pending",
                currentStageId: approvalStageId,
                currentStageIndex: 1,
                currentParticipant: { type: "agent", agentId },
                completedStageIds: [reviewStageId],
                lastDecisionOutcome: "approved",
              },
            },
      );
      expect(
        await db.select().from(issueExecutionDecisions)
          .where(eq(issueExecutionDecisions.issueId, issueId)),
      ).toEqual([
        expect.objectContaining({ stageId: reviewStageId, outcome: "approved" }),
      ]);
      expect(
        await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, currentRunId)).then((rows) => rows[0]?.status),
      ).toBe("running");
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  );

  it("rejects a cancellation authorized by a stage that advances before the row-locked write", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const reviewStageId = randomUUID();
    const approvalStageId = randomUUID();
    const approverUserId = "second-board-user";
    await db.insert(authUsers).values({
      id: approverUserId,
      name: "Second Board User",
      email: "second-board@example.test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: approverUserId,
      status: "active",
      membershipRole: "admin",
    });
    const executionPolicy = {
      mode: "normal" as const,
      commentRequired: true,
      stages: [
        { id: reviewStageId, type: "review" as const, participants: [{ type: "user" as const, userId: "board-user" }] },
        { id: approvalStageId, type: "approval" as const, participants: [{ type: "user" as const, userId: approverUserId }] },
      ],
    };
    const reviewState = {
      status: "pending" as const,
      currentStageId: reviewStageId,
      currentStageIndex: 0,
      currentStageType: "review" as const,
      currentParticipant: { type: "user" as const, userId: "board-user" },
      returnAssignee: { type: "agent" as const, agentId },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancellation versus stage advance",
      status: "in_review",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: "board-user",
      executionPolicy,
      executionState: reviewState,
    });

    let notifyRowLocked!: () => void;
    let allowStageAdvance!: () => void;
    const rowLocked = new Promise<void>((resolve) => { notifyRowLocked = resolve; });
    const stageAdvanceAllowed = new Promise<void>((resolve) => { allowStageAdvance = resolve; });
    const stageAdvance = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      notifyRowLocked();
      await stageAdvanceAllowed;
      await tx.update(issues).set({
        assigneeUserId: approverUserId,
        executionState: {
          ...reviewState,
          currentStageId: approvalStageId,
          currentStageIndex: 1,
          currentStageType: "approval",
          currentParticipant: { type: "user", userId: approverUserId },
          completedStageIds: [reviewStageId],
          lastDecisionId: randomUUID(),
          lastDecisionOutcome: "approved",
        },
      }).where(eq(issues.id, issueId));
    });
    await rowLocked;

    const cancellation = request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled", comment: "Cancel the review" })
      .then((response) => response);
    try {
      const deadline = Date.now() + 5_000;
      let lockWaiters = 0;
      while (Date.now() < deadline) {
        const rows = await db.execute(sql`
          select count(*)::int as count
          from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
        `);
        lockWaiters = Number(rows[0]?.count ?? 0);
        if (lockWaiters >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(lockWaiters).toBeGreaterThanOrEqual(1);
    } finally {
      allowStageAdvance();
      await stageAdvance;
    }

    const res = await cancellation;
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({ code: "execution_stage_changed" });
    expect(await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]))
      .toMatchObject({
        status: "in_review",
        assigneeUserId: approverUserId,
        executionState: {
          status: "pending",
          currentStageId: approvalStageId,
          currentParticipant: { type: "user", userId: approverUserId },
        },
      });
  });

  it("does not let a lost-response retry approve the next stage owned by the same principal", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const reviewStageId = randomUUID();
    const approvalStageId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Sequential staged-decision retry",
      status: "in_review",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: "board-user",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          { id: reviewStageId, type: "review", participants: [{ type: "user", userId: "board-user" }] },
          { id: approvalStageId, type: "approval", participants: [{ type: "user", userId: "board-user" }] },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "user", userId: "board-user" },
        returnAssignee: { type: "agent", agentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    const decision = {
      executionDecision: "approve",
      expectedExecutionStageId: reviewStageId,
      expectedExecutionLastDecisionId: null,
      comment: "Approve the review stage",
    };

    const first = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send(decision);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.executionState).toMatchObject({
      status: "pending",
      currentStageId: approvalStageId,
      completedStageIds: [reviewStageId],
    });

    const retry = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send(decision);
    expect(retry.status, JSON.stringify(retry.body)).toBe(409);
    expect(retry.body.details).toMatchObject({ code: "execution_stage_changed" });

    const [saved] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(saved).toMatchObject({
      status: "in_review",
      executionState: {
        status: "pending",
        currentStageId: approvalStageId,
        completedStageIds: [reviewStageId],
      },
    });
    const decisions = await db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ stageId: reviewStageId, outcome: "approved" });
  });

  it("does not let a retry from the previous review round decide resubmitted work", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const reviewStageId = randomUUID();
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, currentRunId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review-round retry binding",
      status: "in_review",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: "board-user",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: reviewStageId,
          type: "review",
          participants: [{ type: "user", userId: "board-user" }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "user", userId: "board-user" },
        returnAssignee: { type: "agent", agentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    const staleDecision = {
      executionDecision: "request_changes",
      expectedExecutionStageId: reviewStageId,
      expectedExecutionLastDecisionId: null,
      comment: "Please revise the implementation",
    };

    const requestedChanges = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send(staleDecision);
    expect(requestedChanges.status, JSON.stringify(requestedChanges.body)).toBe(200);
    expect(requestedChanges.body.executionState).toMatchObject({
      status: "changes_requested",
      currentStageId: reviewStageId,
      lastDecisionId: expect.any(String),
    });
    const reviewRoundDecisionId = requestedChanges.body.executionState.lastDecisionId;

    const resubmitted = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Revision ready for another review" });
    expect(resubmitted.status, JSON.stringify(resubmitted.body)).toBe(200);
    expect(resubmitted.body.executionState).toMatchObject({
      status: "pending",
      currentStageId: reviewStageId,
      lastDecisionId: reviewRoundDecisionId,
    });

    const staleRetry = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send(staleDecision);
    expect(staleRetry.status, JSON.stringify(staleRetry.body)).toBe(409);
    expect(staleRetry.body.details).toMatchObject({ code: "execution_stage_changed" });

    const [saved] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(saved).toMatchObject({
      status: "in_review",
      executionState: {
        status: "pending",
        currentStageId: reviewStageId,
        lastDecisionId: reviewRoundDecisionId,
      },
    });
    const decisions = await db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ stageId: reviewStageId, outcome: "changes_requested" });
  });

  it("rejects a staged decision from a different live run of the same agent", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const secondRunId = randomUUID();
    const issueId = randomUUID();
    const reviewStageId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, currentRunId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Staged decision run ownership",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: reviewStageId,
          type: "review",
          participants: [{ type: "agent", agentId }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId },
        returnAssignee: { type: "agent", agentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const res = await request(createApp(agentActor(companyId, agentId, secondRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({
        executionDecision: "approve",
        expectedExecutionStageId: reviewStageId,
        expectedExecutionLastDecisionId: null,
        comment: "Decision from the non-owning run",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue run ownership conflict");
    const [saved] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(saved).toMatchObject({
      status: "in_review",
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionState: { status: "pending", currentStageId: reviewStageId },
    });
    const decisions = await db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(0);
  });

  it("rejects a non-current board done override without closing or skipping stages", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const reviewStageId = randomUUID();
    const approvalStageId = randomUUID();
    const differentBoardUserId = "different-board-user";
    await db.insert(authUsers).values({
      id: differentBoardUserId,
      name: "Different Board User",
      email: "different-board@example.test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: differentBoardUserId,
      status: "active",
      membershipRole: "admin",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Board done bypass",
      status: "in_review",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: "board-user",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: reviewStageId,
            type: "review",
            participants: [{ type: "user", userId: "board-user" }],
          },
          {
            id: approvalStageId,
            type: "approval",
            participants: [{ type: "user", userId: differentBoardUserId }],
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "user", userId: "board-user" },
        returnAssignee: { type: "agent", agentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const res = await request(
      createApp(boardActor(companyId, differentBoardUserId)),
    )
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: "Attempt to close before the active reviewer decides",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "execution_stage_decision_required",
    });
    const [saved] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(saved).toMatchObject({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "board-user",
      executionState: {
        status: "pending",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentParticipant: { type: "user", userId: "board-user" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(0);
  });

  it("cancels a pending staged issue with a timestamp and no live execution", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const stageId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancel staged approval",
      status: "in_review",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: "board-user",
      checkoutRunId: null,
      executionRunId: null,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "approval",
          participants: [{ type: "user", userId: "board-user" }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: "board-user" },
        returnAssignee: { type: "agent", agentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled", comment: "Cancel this staged task" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: "cancelled",
      executionState: null,
      checkoutRunId: null,
      executionRunId: null,
    });
    expect(res.body.cancelledAt).toBeTruthy();
  });

  it("restricts admin force-release to board users with company access and writes an audit event", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Admin force release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .expect(403);
    await request(createApp({
      type: "board",
      userId: "outside-user",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
      source: "session",
    }))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .expect(404);

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/admin/force-release?clearAssignee=true`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.issue).toMatchObject({
      id: issueId,
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(res.body.previous).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: failedRunId,
    });

    const audit = await db
      .select({
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.admin_force_release"))
      .then((rows) => rows[0]);
    expect(audit).toMatchObject({
      action: "issue.admin_force_release",
      actorType: "user",
      actorId: "board-user",
      details: {
        issueId,
        actorUserId: "board-user",
        prevCheckoutRunId: currentRunId,
        prevExecutionRunId: failedRunId,
        clearAssignee: true,
      },
    });
  });

  it("self-heals a stale checkoutRunId via clearCheckoutRunIfTerminal on checkout (Fix B path)", async () => {
    // Reproduces the recurrence pattern: prior owning run died, executionRunId
    // was cleared by releaseIssueExecutionAndPromote, but checkoutRunId stayed
    // pinned to the dead run. The new agent's POST /checkout would 409 forever
    // without the clearCheckoutRunIfTerminal helper in svc.checkout.
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout lock after reassignment",
      // Status off in_progress + checkoutRunId still set — adoptStaleCheckoutRun
      // cannot recover from this; only clearCheckoutRunIfTerminal can.
      status: "todo",
      priority: "high",
      assigneeAgentId: otherAgentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const res = await request(createApp(agentActor(companyId, otherAgentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId: otherAgentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId: otherAgentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });
});
