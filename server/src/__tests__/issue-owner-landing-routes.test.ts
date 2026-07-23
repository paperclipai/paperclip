import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  principalPermissionGrants,
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
    `Skipping embedded Postgres owner landing route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue owner landing routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-owner-landing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
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

  async function seedCompany(
    userIds: string[] = ["board-user"],
    membershipRole: "admin" | "viewer" = "admin",
  ) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    for (const userId of userIds) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole,
      });
    }

    return { companyId };
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Backend Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  function boardActor(
    companyId: string,
    userId = "board-user",
    membershipRole: "admin" | "viewer" = "admin",
  ): Express.Request["actor"] {
    return {
      type: "board",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole, status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
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

  it("lets a board user without tasks:assign create a child issue assigned to self", async () => {
    const { companyId } = await seedCompany();
    const parentId = randomUUID();
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "high",
    });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${parentId}/children`)
      .send({
        title: "Blocked dependent lane",
        status: "blocked",
        priority: "high",
        assigneeUserId: "board-user",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.assigneeAgentId).toBeNull();
    expect(res.body.assigneeUserId).toBe("board-user");
    expect(res.body.status).toBe("blocked");
  });

  it("lets a board user without tasks:assign land an existing unassigned issue on self", async () => {
    const { companyId } = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Unowned blocked lane",
      status: "blocked",
      priority: "high",
    });

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeUserId: "board-user" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.assigneeAgentId).toBeNull();
    expect(res.body.assigneeUserId).toBe("board-user");

    const stored = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(stored).toEqual({
      assigneeAgentId: null,
      assigneeUserId: "board-user",
    });
  });

  it("still rejects viewer-owned assignment to another user without tasks:assign", async () => {
    const { companyId } = await seedCompany(["board-user", "other-user"], "viewer");
    const parentId = randomUUID();
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "high",
    });

    const res = await request(createApp(boardActor(companyId, "board-user", "viewer")))
      .post(`/api/issues/${parentId}/children`)
      .send({
        title: "Other-user assignment should fail",
        status: "blocked",
        priority: "high",
        assigneeUserId: "other-user",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Viewer access is read-only");
  });

  it("lets an agent checkout a user-owned issue and clear the user landing owner", async () => {
    const { companyId } = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "User-owned ready issue",
      status: "blocked",
      priority: "high",
      assigneeUserId: "board-user",
    });

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.assigneeAgentId).toBe(agentId);
    expect(res.body.assigneeUserId).toBeNull();
    expect(res.body.status).toBe("in_progress");

    const stored = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        status: issues.status,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(stored).toEqual({
      assigneeAgentId: agentId,
      assigneeUserId: null,
      checkoutRunId: runId,
      executionRunId: runId,
      status: "in_progress",
    });
  });
});
