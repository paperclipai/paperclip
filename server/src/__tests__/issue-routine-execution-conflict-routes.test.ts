import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
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
    `Skipping embedded Postgres routine execution conflict route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("routine execution conflict routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-execution-conflict-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
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

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    };
  }

  async function seedRoutineWithOrphanedExecution(options?: {
    slotFingerprint?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const slotRunId = randomUUID();
    const actorRunId = randomUUID();
    const routineId = randomUUID();
    const fingerprint = "dispatch-fingerprint-1";
    const slotFingerprint = options?.slotFingerprint ?? fingerprint;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({
      id: "board-user",
      name: "Board",
      email: "board@example.test",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "admin",
    });
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
        id: slotRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        id: actorRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    const slotIssueId = randomUUID();
    await db.insert(issues).values({
      id: slotIssueId,
      companyId,
      title: "Routine execution holding the slot",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: slotRunId,
      executionRunId: slotRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
      originKind: "routine_execution",
      originId: routineId,
      originFingerprint: slotFingerprint,
    });

    const orphanIssueId = randomUUID();
    await db.insert(issues).values({
      id: orphanIssueId,
      companyId,
      title: "Orphaned routine execution",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      originKind: "routine_execution",
      originId: routineId,
      originFingerprint: fingerprint,
    });

    return { companyId, agentId, slotRunId, actorRunId, slotIssueId, orphanIssueId };
  }

  it("answers 409 instead of 500 when a PATCH adopts a routine execution slot that is already taken", async () => {
    const { companyId, agentId, actorRunId, orphanIssueId } =
      await seedRoutineWithOrphanedExecution();

    const res = await request(createApp(agentActor(companyId, agentId, actorRunId)))
      .patch(`/api/issues/${orphanIssueId}`)
      .send({ title: "Should conflict" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error).toBe("Issue checkout conflict");
    expect(res.body?.code).toBe("routine_execution_conflict");

    const row = await db
      .select({
        title: issues.title,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, orphanIssueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      title: "Orphaned routine execution",
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("keeps the checkout route conflict body for the same routine execution invariant", async () => {
    const { companyId, agentId, actorRunId, orphanIssueId } =
      await seedRoutineWithOrphanedExecution();

    const res = await request(createApp(agentActor(companyId, agentId, actorRunId)))
      .post(`/api/issues/${orphanIssueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["in_progress"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toEqual({
      error: "Another execution for this routine is already in progress",
    });
  });

  it("answers 409 when a PATCH write reaches the unique index outside the adopt path", async () => {
    const { companyId, agentId, actorRunId, slotRunId, slotIssueId } =
      await seedRoutineWithOrphanedExecution();
    const routineId = await db
      .select({ originId: issues.originId })
      .from(issues)
      .where(eq(issues.id, slotIssueId))
      .then((rows) => rows[0]?.originId ?? null);
    expect(routineId).toBeTruthy();

    const closedIssueId = randomUUID();
    await db.insert(issues).values({
      id: closedIssueId,
      companyId,
      title: "Closed routine execution",
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: slotRunId,
      originKind: "routine_execution",
      originId: routineId!,
      originFingerprint: "dispatch-fingerprint-1",
    });

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${closedIssueId}`)
      .send({ status: "in_progress" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error).toBe("Issue checkout conflict");
    expect(res.body?.code).toBe("routine_execution_conflict");

    const row = await db
      .select({ status: issues.status, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, closedIssueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("done");
    expect(row?.executionRunId).toBe(slotRunId);
  });

  it("does not conflict when the same routine carries a different origin fingerprint", async () => {
    const { companyId, agentId, actorRunId, orphanIssueId } =
      await seedRoutineWithOrphanedExecution({
        slotFingerprint: "dispatch-fingerprint-other",
      });

    const res = await request(createApp(agentActor(companyId, agentId, actorRunId)))
      .patch(`/api/issues/${orphanIssueId}`)
      .send({ title: "Should be allowed" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body?.error).toBeUndefined();

    const row = await db
      .select({
        title: issues.title,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, orphanIssueId))
      .then((rows) => rows[0]);
    expect(row?.title).toBe("Should be allowed");
    expect(row?.executionRunId).toBe(actorRunId);
  });
});
