import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const [{ activityRoutes }, { issueRoutes }] = await Promise.all([
    import("../routes/activity.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as never));
  app.use("/api", activityRoutes(db));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message ?? "Internal server error" });
  });
  return app;
}

describeEmbeddedPostgres("issue comment attribution and patch audit routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-attribution-audit-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const company = await db.insert(companies).values({
      name: "Attribution Company",
      issuePrefix: `AT${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const [actorAgent, targetAgent] = await db.insert(agents).values(["Actor", "Target"].map((name) => ({
      companyId: company.id,
      name,
      role: "engineer",
      status: "active" as const,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }))).returning();
    const responsibleUserId = `responsible-${randomUUID()}`;
    const boardUserId = `board-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values([
      {
        id: responsibleUserId,
        name: "Responsible User",
        email: `${responsibleUserId}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: boardUserId,
        name: "Board User",
        email: `${boardUserId}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "member",
    });
    const [sourceIssue, issue] = await db.insert(issues).values([
      {
        companyId: company.id,
        identifier: `${company.issuePrefix}-1`,
        title: "Source issue",
        status: "in_progress" as const,
        priority: "medium" as const,
        assigneeAgentId: actorAgent.id,
      },
      {
        companyId: company.id,
        identifier: `${company.issuePrefix}-2`,
        title: "Foreign issue",
        status: "done" as const,
        priority: "medium" as const,
        assigneeAgentId: targetAgent.id,
      },
    ]).returning();
    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: actorAgent.id,
      status: "running",
      responsibleUserId,
      contextSnapshot: { issueId: sourceIssue.id },
    }).returning().then((rows) => rows[0]!);

    return { company, actorAgent, responsibleUserId, boardUserId, run, issue };
  }

  function agentActor(input: Awaited<ReturnType<typeof seed>>): Express.Request["actor"] {
    return {
      type: "agent",
      agentId: input.actorAgent.id,
      companyId: input.company.id,
      runId: input.run.id,
      onBehalfOfUserId: input.responsibleUserId,
      onBehalfOfMemberships: [{
        companyId: input.company.id,
        membershipRole: "member",
        status: "active",
      }],
      source: "agent_jwt",
    };
  }

  it("attributes foreign-issue agent comments and emits complete agent and human PATCH receipts", async () => {
    const fixture = await seed();
    const agentApp = await createApp(db, agentActor(fixture));

    const commentResponse = await request(agentApp)
      .post(`/api/issues/${fixture.issue.id}/comments`)
      .send({ body: "Cross-issue collaboration note" });
    expect(commentResponse.status, JSON.stringify(commentResponse.body)).toBe(201);
    expect(commentResponse.body).toMatchObject({
      authorAgentId: fixture.actorAgent.id,
      onBehalfOfUserId: fixture.responsibleUserId,
      createdByRunId: fixture.run.id,
      metadata: {
        authorizationReason: "allow_visible_issue_write",
      },
    });

    const agentPatch = await request(agentApp)
      .patch(`/api/issues/${fixture.issue.id}`)
      .send({ priority: "high" });
    expect(agentPatch.status, JSON.stringify(agentPatch.body)).toBe(200);
    expect(agentPatch.body.changes).toMatchObject({
      priority: { from: "medium", to: "high" },
    });

    const boardApp = await createApp(db, {
      type: "board",
      userId: fixture.boardUserId,
      companyIds: [fixture.company.id],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    const humanPatch = await request(boardApp)
      .patch(`/api/issues/${fixture.issue.id}`)
      .send({ title: "Human-edited issue" });
    expect(humanPatch.status, JSON.stringify(humanPatch.body)).toBe(200);

    const patchEvents = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.entityId, fixture.issue.id),
        eq(activityLog.action, "issue.updated"),
      ))
      .orderBy(desc(activityLog.createdAt));
    expect(patchEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorType: "agent",
        actorId: fixture.actorAgent.id,
        agentId: fixture.actorAgent.id,
        runId: fixture.run.id,
        responsibleUserId: fixture.responsibleUserId,
        details: expect.objectContaining({
          authorizationReason: "allow_visible_issue_write",
          changes: expect.objectContaining({
            priority: { from: "medium", to: "high" },
          }),
        }),
      }),
      expect.objectContaining({
        actorType: "user",
        actorId: fixture.boardUserId,
        agentId: null,
        runId: null,
        responsibleUserId: fixture.boardUserId,
        details: expect.objectContaining({
          authorizationReason: "allow_board_actor",
          changes: expect.objectContaining({
            title: { from: "Foreign issue", to: "Human-edited issue" },
          }),
        }),
      }),
    ]));

    const activityResponse = await request(boardApp).get(`/api/issues/${fixture.issue.id}/activity`);
    expect(activityResponse.status, JSON.stringify(activityResponse.body)).toBe(200);
    expect(activityResponse.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "issue.updated",
        responsibleUserId: fixture.responsibleUserId,
        details: expect.objectContaining({ authorizationReason: "allow_visible_issue_write" }),
      }),
    ]));
  }, 30_000);

  it("rejects and audits an agent-supplied onBehalfOfUserId", async () => {
    const fixture = await seed();
    const response = await request(await createApp(db, agentActor(fixture)))
      .post(`/api/issues/${fixture.issue.id}/comments`)
      .send({ body: "Spoof attempt", onBehalfOfUserId: "someone-else" });

    expect(response.status).toBe(422);
    // Plan §6: the refusal says the write itself was fine and names the fix.
    expect(response.body.details.code).toBe("issue_write_attribution_spoof_rejected");
    expect(response.body.details.sanctionedPath).toContain("onBehalfOfUserId");
    expect(response.body.error).toContain("Who can act:");
    expect(await db.select().from(issueComments)).toHaveLength(0);
    const event = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.attribution_spoof_rejected"))
      .then((rows) => rows[0]);
    expect(event).toMatchObject({
      actorId: fixture.actorAgent.id,
      runId: fixture.run.id,
      responsibleUserId: fixture.responsibleUserId,
      details: {
        identifier: fixture.issue.identifier,
        surface: "issue.comment.create",
        field: "onBehalfOfUserId",
        requestedValue: "someone-else",
        derivedFrom: "authenticated_actor",
      },
    });
  }, 30_000);
});
