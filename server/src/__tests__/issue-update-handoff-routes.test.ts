import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  companies,
  createDb,
  documentRevisions,
  heartbeatRuns,
  instanceUserRoles,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

const mockHeartbeatWakeup = vi.hoisted(() => vi.fn(async () => null));
const mockReportRunActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
  return {
    ...actual,
    heartbeatService: (db: any) => ({
      ...actual.heartbeatService(db),
      reportRunActivity: mockReportRunActivity,
      wakeup: mockHeartbeatWakeup,
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue update route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue update handoff routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-update-handoff-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`
        TRUNCATE TABLE
          activity_log,
          document_revisions,
          issue_documents,
          documents,
          issue_comments,
          issue_inbox_archives,
          issues,
          heartbeat_run_events,
          heartbeat_runs,
          agent_wakeup_requests,
          agent_runtime_state,
          execution_workspaces,
          project_workspaces,
          projects,
          agents,
          instance_user_roles,
          companies,
          instance_settings
        RESTART IDENTITY CASCADE
      `);
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createRouteApp(opts?: {
    deploymentMode?: "local_trusted" | "authenticated";
    resolveSession?: Parameters<typeof actorMiddleware>[1]["resolveSession"];
  }) {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, {
      deploymentMode: opts?.deploymentMode ?? "local_trusted",
      resolveSession: opts?.resolveSession,
    }));
    app.use(boardMutationGuard());
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedHandoffFixture(input?: { executionAgentId?: string }) {
    const companyId = randomUUID();
    const qaAgentId = randomUUID();
    const staffAgentId = randomUUID();
    const builderAgentId = input?.executionAgentId ?? randomUUID();
    const issueId = randomUUID();
    const qaRunId = randomUUID();
    const builderRunId = randomUUID();
    const executionAgentId = input?.executionAgentId ?? qaAgentId;
    const executionRunId = executionAgentId === qaAgentId ? qaRunId : builderRunId;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: qaAgentId,
        companyId,
        name: "QA Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: staffAgentId,
        companyId,
        name: "Staff Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: builderAgentId,
        companyId,
        name: "Builder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: qaRunId,
        companyId,
        agentId: qaAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-11T14:30:00.000Z"),
      },
      {
        id: builderRunId,
        companyId,
        agentId: builderAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-11T14:31:00.000Z"),
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "QA handoff to Staff review",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: qaAgentId,
      checkoutRunId: executionRunId,
      executionRunId,
      executionAgentNameKey: executionAgentId === qaAgentId ? "qa-engineer" : "builder",
      executionLockedAt: new Date("2026-04-11T14:30:00.000Z"),
      startedAt: new Date("2026-04-11T14:30:00.000Z"),
    });

    return {
      companyId,
      issueId,
      qaAgentId,
      staffAgentId,
      builderAgentId,
      qaRunId,
      builderRunId,
      executionRunId,
    };
  }

  async function seedForeignExecutionFixture(input?: {
    status?: "todo" | "in_progress" | "in_review";
    checkoutRunId?: string | null | "foreign";
  }) {
    const companyId = randomUUID();
    const assignedAgentId = randomUUID();
    const foreignAgentId = randomUUID();
    const issueId = randomUUID();
    const staleRunId = randomUUID();
    const foreignRunId = randomUUID();
    const agentToken = `agent-token-${assignedAgentId}`;
    const lockedAt = new Date("2026-04-11T15:40:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: assignedAgentId,
        companyId,
        name: "Assigned Builder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: foreignAgentId,
        companyId,
        name: "Foreign Builder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentApiKeys).values({
      agentId: assignedAgentId,
      companyId,
      name: "test key",
      keyHash: hashToken(agentToken),
    });

    await db.insert(heartbeatRuns).values([
      {
        id: staleRunId,
        companyId,
        agentId: assignedAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-11T15:30:00.000Z"),
        finishedAt: new Date("2026-04-11T15:35:00.000Z"),
      },
      {
        id: foreignRunId,
        companyId,
        agentId: foreignAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: lockedAt,
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Forged run id must not clear foreign execution",
      status: input?.status ?? "in_progress",
      priority: "high",
      assigneeAgentId: assignedAgentId,
      checkoutRunId:
        input?.checkoutRunId === undefined
          ? staleRunId
          : input.checkoutRunId === "foreign"
            ? foreignRunId
            : input.checkoutRunId,
      executionRunId: foreignRunId,
      executionAgentNameKey: "foreign-builder",
      executionLockedAt: lockedAt,
      startedAt: new Date("2026-04-11T15:30:00.000Z"),
    });

    return {
      issueId,
      assignedAgentId,
      staleRunId,
      foreignRunId,
      agentToken,
      lockedAt,
    };
  }

  async function seedSameAgentSplitLockFixture() {
    const companyId = randomUUID();
    const assignedAgentId = randomUUID();
    const issueId = randomUUID();
    const oldRunId = randomUUID();
    const retryRunId = randomUUID();
    const lockedAt = new Date("2026-04-11T16:10:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: assignedAgentId,
      companyId,
      name: "Assigned Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values([
      {
        id: oldRunId,
        companyId,
        agentId: assignedAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-04-11T16:00:00.000Z"),
      },
      {
        id: retryRunId,
        companyId,
        agentId: assignedAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId },
        startedAt: lockedAt,
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Same-agent split lock must preserve retry execution",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: assignedAgentId,
      checkoutRunId: oldRunId,
      executionRunId: retryRunId,
      executionAgentNameKey: "assigned-builder",
      executionLockedAt: lockedAt,
      startedAt: new Date("2026-04-11T16:00:00.000Z"),
    });

    return {
      companyId,
      issueId,
      assignedAgentId,
      oldRunId,
      retryRunId,
      lockedAt,
    };
  }

  async function seedBoardActivityFixture(userId: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const checkoutIssueId = randomUUID();
    const releaseIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(instanceUserRoles).values({
      userId,
      role: "instance_admin",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: checkoutIssueId,
        companyId,
        title: "Board checkout activity",
        status: "todo",
        priority: "high",
      },
      {
        id: releaseIssueId,
        companyId,
        title: "Board release activity",
        status: "todo",
        priority: "high",
        assigneeUserId: userId,
      },
    ]);

    return {
      agentId,
      checkoutIssueId,
      releaseIssueId,
    };
  }

  function hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  function setLocalAgentJwtSecret(secret: string) {
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = secret;
    return () => {
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    };
  }

  async function getPersistedIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  it("clears execution ownership for a local-board PATCH carrying the owning run id", async () => {
    const { issueId, staffAgentId, qaRunId } = await seedHandoffFixture();

    const res = await request(createRouteApp())
      .patch(`/api/issues/${issueId}`)
      .set("X-Paperclip-Run-Id", qaRunId)
      .send({
        status: "in_review",
        assigneeAgentId: staffAgentId,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      id: issueId,
      status: "in_review",
      assigneeAgentId: staffAgentId,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    }));

    await expect(getPersistedIssue(issueId)).resolves.toEqual(expect.objectContaining({
      status: "in_review",
      assigneeAgentId: staffAgentId,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    }));
  });

  it("preserves execution ownership when the local-board run header belongs to a different live agent", async () => {
    const builderAgentId = randomUUID();
    const { issueId, staffAgentId, builderRunId } = await seedHandoffFixture({
      executionAgentId: builderAgentId,
    });

    const res = await request(createRouteApp())
      .patch(`/api/issues/${issueId}`)
      .set("X-Paperclip-Run-Id", builderRunId)
      .send({
        status: "in_review",
        assigneeAgentId: staffAgentId,
      });

    expect(res.status).toBe(200);

    await expect(getPersistedIssue(issueId)).resolves.toEqual(expect.objectContaining({
      status: "in_review",
      assigneeAgentId: staffAgentId,
      checkoutRunId: builderRunId,
      executionRunId: builderRunId,
      executionAgentNameKey: "builder",
    }));
  });

  it("treats authenticated board run headers as audit context only", async () => {
    const { issueId, staffAgentId, qaRunId } = await seedHandoffFixture();
    const userId = "board-user";
    await db.insert(instanceUserRoles).values({
      userId,
      role: "instance_admin",
    });

    const res = await request(createRouteApp({
      deploymentMode: "authenticated",
      resolveSession: async () => ({
        session: { id: "session-1", userId },
        user: { id: userId },
      }),
    }))
      .patch(`/api/issues/${issueId}`)
      .set("Origin", "http://localhost:3100")
      .set("X-Paperclip-Run-Id", qaRunId)
      .send({
        status: "in_review",
        assigneeAgentId: staffAgentId,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      id: issueId,
      status: "in_review",
      assigneeAgentId: staffAgentId,
      checkoutRunId: qaRunId,
      executionRunId: qaRunId,
      executionAgentNameKey: "qa-engineer",
    }));
    expect(mockReportRunActivity).not.toHaveBeenCalled();

    await expect(getPersistedIssue(issueId)).resolves.toEqual(expect.objectContaining({
      status: "in_review",
      assigneeAgentId: staffAgentId,
      checkoutRunId: qaRunId,
      executionRunId: qaRunId,
      executionAgentNameKey: "qa-engineer",
    }));

    const commentRes = await request(createRouteApp({
      deploymentMode: "authenticated",
      resolveSession: async () => ({
        session: { id: "session-1", userId },
        user: { id: userId },
      }),
    }))
      .post(`/api/issues/${issueId}/comments`)
      .set("Origin", "http://localhost:3100")
      .set("X-Paperclip-Run-Id", qaRunId)
      .send({ body: "Audit-only board comment" });

    expect(commentRes.status).toBe(201);
    expect(commentRes.body).toEqual(expect.objectContaining({
      body: "Audit-only board comment",
      createdByRunId: null,
    }));
    expect(mockReportRunActivity).not.toHaveBeenCalled();

    const documentRes = await request(createRouteApp({
      deploymentMode: "authenticated",
      resolveSession: async () => ({
        session: { id: "session-1", userId },
        user: { id: userId },
      }),
    }))
      .put(`/api/issues/${issueId}/documents/plan`)
      .set("Origin", "http://localhost:3100")
      .set("X-Paperclip-Run-Id", qaRunId)
      .send({
        title: "Plan",
        format: "markdown",
        body: "Audit-only board document",
        baseRevisionId: null,
      });

    expect(documentRes.status).toBe(201);
    expect(mockReportRunActivity).not.toHaveBeenCalled();

    const revisionRows = await db.select().from(documentRevisions);
    expect(revisionRows).toHaveLength(1);
    expect(revisionRows[0]?.createdByRunId).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    const updateActivity = activityRows.find((row) => row.action === "issue.updated");
    const commentActivity = activityRows.find((row) => row.action === "issue.comment_added");
    const documentActivity = activityRows.find((row) => row.action === "issue.document_created");
    expect(updateActivity?.runId).toBeNull();
    expect(commentActivity?.runId).toBeNull();
    expect(documentActivity?.runId).toBeNull();
  });

  it("keeps authenticated board run headers audit-only when reopening from a comment", async () => {
    const { issueId, qaRunId } = await seedHandoffFixture();
    const userId = "board-user";
    await db.insert(instanceUserRoles).values({
      userId,
      role: "instance_admin",
    });
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, issueId));

    const res = await request(createRouteApp({
      deploymentMode: "authenticated",
      resolveSession: async () => ({
        session: { id: "session-1", userId },
        user: { id: userId },
      }),
    }))
      .post(`/api/issues/${issueId}/comments`)
      .set("Origin", "http://localhost:3100")
      .set("X-Paperclip-Run-Id", qaRunId)
      .send({ body: "Reopen without trusting board run header", reopen: true });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      body: "Reopen without trusting board run header",
      createdByRunId: null,
    }));
    expect(mockReportRunActivity).not.toHaveBeenCalled();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    const reopenedUpdate = activityRows.find((row) =>
      row.action === "issue.updated" && (row.details as { reopened?: boolean } | null)?.reopened === true);
    const commentActivity = activityRows.find((row) => row.action === "issue.comment_added");
    expect(reopenedUpdate?.runId).toBeNull();
    expect(commentActivity?.runId).toBeNull();
  });

  it("keeps authenticated board run headers audit-only for checkout and release activity", async () => {
    const userId = "board-user";
    const { agentId, checkoutIssueId, releaseIssueId } = await seedBoardActivityFixture(userId);
    const untrustedRunId = randomUUID();
    const app = createRouteApp({
      deploymentMode: "authenticated",
      resolveSession: async () => ({
        session: { id: "session-1", userId },
        user: { id: userId },
      }),
    });

    const checkoutRes = await request(app)
      .post(`/api/issues/${checkoutIssueId}/checkout`)
      .set("Origin", "http://localhost:3100")
      .set("X-Paperclip-Run-Id", untrustedRunId)
      .send({
        agentId,
        expectedStatuses: ["todo"],
      });

    expect(checkoutRes.status).toBe(200);

    const releaseRes = await request(app)
      .post(`/api/issues/${releaseIssueId}/release`)
      .set("Origin", "http://localhost:3100")
      .set("X-Paperclip-Run-Id", untrustedRunId)
      .send({});

    expect(releaseRes.status).toBe(200);

    const activityRows = await db.select().from(activityLog);
    const checkoutActivity = activityRows.find((row) =>
      row.entityId === checkoutIssueId && row.action === "issue.checked_out");
    const releaseActivity = activityRows.find((row) =>
      row.entityId === releaseIssueId && row.action === "issue.released");
    expect(checkoutActivity?.runId).toBeNull();
    expect(releaseActivity?.runId).toBeNull();
  });

  it("rejects an agent PATCH when the run header belongs to a foreign live execution owner", async () => {
    const builderAgentId = randomUUID();
    const { companyId, issueId, qaAgentId, builderRunId } = await seedHandoffFixture({
      executionAgentId: builderAgentId,
    });
    const agentToken = "qa-agent-token";
    const lockedAt = new Date("2026-04-11T14:30:00.000Z");

    await db.insert(agentApiKeys).values({
      agentId: qaAgentId,
      companyId,
      name: "test key",
      keyHash: hashToken(agentToken),
    });

    const res = await request(createRouteApp({ deploymentMode: "authenticated" }))
      .patch(`/api/issues/${issueId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .set("X-Paperclip-Run-Id", builderRunId)
      .send({
        status: "done",
      });

    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({
      error: "Issue run ownership conflict",
    }));

    await expect(getPersistedIssue(issueId)).resolves.toEqual(expect.objectContaining({
      status: "in_progress",
      assigneeAgentId: qaAgentId,
      checkoutRunId: builderRunId,
      executionRunId: builderRunId,
      executionAgentNameKey: "builder",
      executionLockedAt: lockedAt,
    }));
  });

  it("keeps forged agent API-key run headers out of execution decision provenance", async () => {
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const builderAgentId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const participantId = randomUUID();
    const foreignRunId = randomUUID();
    const agentToken = "reviewer-agent-token";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: builderAgentId,
        companyId,
        name: "Builder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentApiKeys).values({
      agentId: reviewerAgentId,
      companyId,
      name: "reviewer key",
      keyHash: hashToken(agentToken),
    });

    await db.insert(heartbeatRuns).values({
      id: foreignRunId,
      companyId,
      agentId: builderAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date("2026-04-11T20:50:00.000Z"),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review decision provenance",
      status: "in_review",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [
              {
                id: participantId,
                type: "agent",
                agentId: reviewerAgentId,
                userId: null,
              },
            ],
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: {
          type: "agent",
          agentId: reviewerAgentId,
          userId: null,
        },
        returnAssignee: {
          type: "agent",
          agentId: builderAgentId,
          userId: null,
        },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const res = await request(createRouteApp({ deploymentMode: "authenticated" }))
      .patch(`/api/issues/${issueId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .set("X-Paperclip-Run-Id", foreignRunId)
      .send({
        status: "done",
        comment: "Approved.",
      });

    expect(res.status).toBe(200);
    expect(mockReportRunActivity).not.toHaveBeenCalled();

    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.createdByRunId).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activityRows.find((row) => row.action === "issue.updated")?.runId).toBeNull();
    expect(activityRows.find((row) => row.action === "issue.comment_added")?.runId).toBeNull();
  });

  it("rejects agent checkout adoption when the run header belongs to a foreign live execution owner", async () => {
    const { issueId, assignedAgentId, staleRunId, foreignRunId, agentToken, lockedAt } =
      await seedForeignExecutionFixture();

    const res = await request(createRouteApp({ deploymentMode: "authenticated" }))
      .post(`/api/issues/${issueId}/checkout`)
      .set("Authorization", `Bearer ${agentToken}`)
      .set("X-Paperclip-Run-Id", foreignRunId)
      .send({
        agentId: assignedAgentId,
        expectedStatuses: ["in_progress"],
      });

    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({
      error: "Issue checkout conflict",
    }));

    await expect(getPersistedIssue(issueId)).resolves.toEqual(expect.objectContaining({
      status: "in_progress",
      assigneeAgentId: assignedAgentId,
      checkoutRunId: staleRunId,
      executionRunId: foreignRunId,
      executionAgentNameKey: "foreign-builder",
      executionLockedAt: lockedAt,
    }));
  });

  it("rejects direct agent checkout when checkout is unlocked but execution belongs to a foreign live run", async () => {
    const { issueId, assignedAgentId, foreignRunId, agentToken, lockedAt } =
      await seedForeignExecutionFixture({
        status: "todo",
        checkoutRunId: null,
      });

    const res = await request(createRouteApp({ deploymentMode: "authenticated" }))
      .post(`/api/issues/${issueId}/checkout`)
      .set("Authorization", `Bearer ${agentToken}`)
      .set("X-Paperclip-Run-Id", foreignRunId)
      .send({
        agentId: assignedAgentId,
        expectedStatuses: ["todo"],
      });

    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({
      error: "Issue checkout conflict",
    }));

    await expect(getPersistedIssue(issueId)).resolves.toEqual(expect.objectContaining({
      status: "todo",
      assigneeAgentId: assignedAgentId,
      checkoutRunId: null,
      executionRunId: foreignRunId,
      executionAgentNameKey: "foreign-builder",
      executionLockedAt: lockedAt,
    }));
  });

  it("rejects direct agent checkout when checkout and execution both belong to a foreign live run", async () => {
    const { issueId, assignedAgentId, foreignRunId, agentToken, lockedAt } =
      await seedForeignExecutionFixture({
        checkoutRunId: "foreign",
      });

    const res = await request(createRouteApp({ deploymentMode: "authenticated" }))
      .post(`/api/issues/${issueId}/checkout`)
      .set("Authorization", `Bearer ${agentToken}`)
      .set("X-Paperclip-Run-Id", foreignRunId)
      .send({
        agentId: assignedAgentId,
        expectedStatuses: ["in_progress"],
      });

    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({
      error: "Issue checkout conflict",
    }));

    await expect(getPersistedIssue(issueId)).resolves.toEqual(expect.objectContaining({
      status: "in_progress",
      assigneeAgentId: assignedAgentId,
      checkoutRunId: foreignRunId,
      executionRunId: foreignRunId,
      executionAgentNameKey: "foreign-builder",
      executionLockedAt: lockedAt,
    }));
  });

  it("rejects same-agent split-lock checkout when a local JWT run is overridden by header", async () => {
    const { companyId, issueId, assignedAgentId, oldRunId, retryRunId, lockedAt } =
      await seedSameAgentSplitLockFixture();
    const restoreJwtSecret = setLocalAgentJwtSecret("test-secret");

    try {
      const token = createLocalAgentJwt(assignedAgentId, companyId, "codex_local", oldRunId);
      expect(token).toBeTypeOf("string");

      const res = await request(createRouteApp({ deploymentMode: "authenticated" }))
        .post(`/api/issues/${issueId}/checkout`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Paperclip-Run-Id", retryRunId)
        .send({
          agentId: assignedAgentId,
          expectedStatuses: ["in_progress"],
        });

      expect(res.status).toBe(409);
      expect(res.body).toEqual(expect.objectContaining({
        error: "Issue checkout conflict",
      }));

      await expect(getPersistedIssue(issueId)).resolves.toEqual(expect.objectContaining({
        status: "in_progress",
        assigneeAgentId: assignedAgentId,
        checkoutRunId: oldRunId,
        executionRunId: retryRunId,
        executionAgentNameKey: "assigned-builder",
        executionLockedAt: lockedAt,
      }));
    } finally {
      restoreJwtSecret();
    }
  });

  it("rejects agent release when the run header belongs to a foreign live execution owner", async () => {
    const { issueId, assignedAgentId, foreignRunId, agentToken, lockedAt } =
      await seedForeignExecutionFixture({
        status: "in_review",
        checkoutRunId: null,
      });

    const res = await request(createRouteApp({ deploymentMode: "authenticated" }))
      .post(`/api/issues/${issueId}/release`)
      .set("Authorization", `Bearer ${agentToken}`)
      .set("X-Paperclip-Run-Id", foreignRunId)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({
      error: "Issue still owned by active run",
    }));

    await expect(getPersistedIssue(issueId)).resolves.toEqual(expect.objectContaining({
      status: "in_review",
      assigneeAgentId: assignedAgentId,
      checkoutRunId: null,
      executionRunId: foreignRunId,
      executionAgentNameKey: "foreign-builder",
      executionLockedAt: lockedAt,
    }));
  });
});
