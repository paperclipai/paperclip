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

const mockHeartbeat = vi.hoisted(() => ({
  wakeup: vi.fn(async () => null),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, heartbeatService: () => mockHeartbeat };
});

const mockExternalObjects = vi.hoisted(() => ({
  syncCommentSafely: vi.fn(async () => undefined),
}));

vi.mock("../services/external-objects.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    externalObjectService: (...args: Parameters<typeof actual.externalObjectService>) => ({
      ...actual.externalObjectService(...args),
      syncCommentSafely: mockExternalObjects.syncCommentSafely,
    }),
  };
});

const receiptFinalizationControl = vi.hoisted(() => ({
  beforeNext: null as null | (() => Promise<void>),
}));

vi.mock("../services/issue-comment-receipt.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    completeIssueCommentReceipt: async (
      ...args: Parameters<typeof actual.completeIssueCommentReceipt>
    ) => {
      const before = receiptFinalizationControl.beforeNext;
      receiptFinalizationControl.beforeNext = null;
      if (before) await before();
      return actual.completeIssueCommentReceipt(...args);
    },
  };
});

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
    res.status(error.status ?? 500).json({
      error: error.message ?? "Internal server error",
      ...(error.details === undefined ? {} : { details: error.details }),
    });
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
    vi.clearAllMocks();
    receiptFinalizationControl.beforeNext = null;
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
      issueCounter: 2,
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

    return { company, actorAgent, targetAgent, responsibleUserId, boardUserId, run, issue };
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

  function noRunAgentActor(
    input: Awaited<ReturnType<typeof seed>>,
    overrides: { agentId?: string; companyId?: string } = {},
  ): Express.Request["actor"] {
    return {
      ...agentActor(input),
      ...overrides,
      runId: undefined,
      source: "agent_key",
    };
  }

  it("records the human recipient for REST task and child creation", async () => {
    const fixture = await seed();
    const app = await createApp(db, agentActor(fixture));
    for (const [path, action] of [
      [`/api/companies/${fixture.company.id}/issues`, "issue.created"],
      [`/api/issues/${fixture.issue.id}/children`, "issue.child_created"],
    ]) {
      const response = await request(app).post(path!).send({
        title: "Task for the human", status: "todo", assigneeUserId: fixture.responsibleUserId,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const events = await db.select().from(activityLog).where(and(
        eq(activityLog.entityId, response.body.id), eq(activityLog.action, action!),
      ));
      expect(events).toEqual([expect.objectContaining({
        actorType: "agent", actorId: fixture.actorAgent.id,
        details: expect.objectContaining({ assigneeAgentId: null, assigneeUserId: fixture.responsibleUserId }),
      })]);
    }
  });

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

  it("accepts and replays a plain no-run comment on the key agent's own created issue", async () => {
    const fixture = await seed();
    await db.update(issues).set({
      status: "todo",
      createdByAgentId: fixture.actorAgent.id,
      createdByUserId: null,
    }).where(eq(issues.id, fixture.issue.id));
    const app = await createApp(db, noRunAgentActor(fixture));
    const clientRequestId = randomUUID();
    const input = { body: "Polling produced a durable receipt", clientRequestId };

    const first = await request(app).post(`/api/issues/${fixture.issue.id}/comments`).send(input);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      authorAgentId: fixture.actorAgent.id,
      createdByRunId: null,
      clientRequestId,
      body: input.body,
      presentation: null,
    });
    await vi.waitFor(() => expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(1));
    const wakeOptions = mockHeartbeat.wakeup.mock.calls[0]![1];

    const replay = await request(app).post(`/api/issues/${fixture.issue.id}/comments`).send(input);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(2);
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, fixture.issue.id),
      eq(activityLog.action, "issue.comment_added"),
    ))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.agentId, fixture.actorAgent.id),
      eq(activityLog.action, "issue.runless_agent_comment_admitted"),
    ))).toHaveLength(1);
    expect(wakeOptions.idempotencyKey).toBe(
      `issue-comment:${first.body.id}:${fixture.targetAgent.id}`,
    );

    const changed = await request(app).post(`/api/issues/${fixture.issue.id}/comments`)
      .send({ ...input, body: "Changed content for the same receipt" });
    expect(changed.status).toBe(409);
    expect(await db.select().from(issueComments)).toHaveLength(1);
  }, 30_000);

  it("caps fresh no-run comments across app instances and keeps saturation replays free", async () => {
    const fixture = await seed();
    await db.update(issues).set({
      status: "todo",
      createdByAgentId: fixture.actorAgent.id,
      createdByUserId: null,
    }).where(eq(issues.id, fixture.issue.id));
    const secondIssue = await db.insert(issues).values({
      companyId: fixture.company.id,
      title: "Second creator issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: fixture.targetAgent.id,
      createdByAgentId: fixture.actorAgent.id,
    }).returning().then((rows) => rows[0]!);
    const secondDb = createDb(tempDb!.connectionString);
    try {
      const actor = noRunAgentActor(fixture);
      const [firstApp, secondApp] = await Promise.all([
        createApp(db, actor),
        createApp(secondDb, actor),
      ]);
      const inputs = Array.from({ length: 21 }, (_, index) => ({
        body: `fresh creator comment ${index}`,
        clientRequestId: randomUUID(),
      }));
      const responses = await Promise.all(inputs.map((input, index) =>
        request(index % 2 === 0 ? firstApp : secondApp)
          .post(`/api/issues/${index % 2 === 0 ? fixture.issue.id : secondIssue.id}/comments`)
          .send(input),
      ));

      expect(responses.map((response) => response.status).sort()).toEqual([
        ...Array.from({ length: 20 }, () => 201),
        429,
      ]);
      const rejected = responses.find((response) => response.status === 429)!;
      expect(rejected.body).toMatchObject({
        details: {
          code: "runless_agent_comment_rate_limited",
          limit: 20,
          windowSeconds: 60,
          retryAfterSeconds: expect.any(Number),
        },
      });
      expect(await db.select().from(issueComments).where(
        eq(issueComments.authorAgentId, fixture.actorAgent.id),
      )).toHaveLength(20);
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.agentId, fixture.actorAgent.id),
        eq(activityLog.action, "issue.runless_agent_comment_admitted"),
      ))).toEqual(Array.from({ length: 20 }, () => expect.objectContaining({
        responsibleUserId: fixture.responsibleUserId,
      })));
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.agentId, fixture.actorAgent.id),
        eq(activityLog.action, "issue.comment_added"),
      ))).toHaveLength(20);
      expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(20);

      const acceptedIndex = responses.findIndex((response) => response.status === 201);
      const replay = await request(acceptedIndex % 2 === 0 ? firstApp : secondApp)
        .post(`/api/issues/${acceptedIndex % 2 === 0 ? fixture.issue.id : secondIssue.id}/comments`)
        .send(inputs[acceptedIndex]);
      expect(replay.status, JSON.stringify(replay.body)).toBe(201);
      expect(await db.select().from(issueComments).where(
        eq(issueComments.authorAgentId, fixture.actorAgent.id),
      )).toHaveLength(20);
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.agentId, fixture.actorAgent.id),
        eq(activityLog.action, "issue.runless_agent_comment_admitted"),
      ))).toHaveLength(20);
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.agentId, fixture.actorAgent.id),
        eq(activityLog.action, "issue.comment_added"),
      ))).toHaveLength(20);
      expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(21);

      const rotatedKey = await request(secondApp)
        .post(`/api/issues/${secondIssue.id}/comments`)
        .send({ body: "A different key must share the agent quota", clientRequestId: randomUUID() });
      expect(rotatedKey.status, JSON.stringify(rotatedKey.body)).toBe(429);
      expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(21);
    } finally {
      await secondDb.$client.end({ timeout: 5 });
    }
  }, 30_000);

  it("wakes when a retry finalizes a receipt whose initial finalization failed", async () => {
    const fixture = await seed();
    await db.update(issues).set({
      status: "todo",
      createdByAgentId: fixture.actorAgent.id,
      createdByUserId: null,
    }).where(eq(issues.id, fixture.issue.id));
    const app = await createApp(db, noRunAgentActor(fixture));
    const input = { body: "Retry finalizes the receipt", clientRequestId: randomUUID() };
    receiptFinalizationControl.beforeNext = async () => {
      throw new Error("receipt finalization failed");
    };

    const failed = await request(app).post(`/api/issues/${fixture.issue.id}/comments`).send(input);
    expect(failed.status).toBe(500);
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(
      activityLog.action,
      "issue.runless_agent_comment_admitted",
    ))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.comment_added"))).toHaveLength(0);
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();

    const retry = await request(app).post(`/api/issues/${fixture.issue.id}/comments`).send(input);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(1));
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, fixture.issue.id),
      eq(activityLog.action, "issue.comment_added"),
    ))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(
      activityLog.action,
      "issue.runless_agent_comment_admitted",
    ))).toHaveLength(1);
    expect(mockExternalObjects.syncCommentSafely).toHaveBeenCalledTimes(1);
    expect(mockExternalObjects.syncCommentSafely).toHaveBeenCalledWith(retry.body.id);
  }, 30_000);

  it("accepts a durable no-run comment when the assignee wake is policy-refused", async () => {
    const fixture = await seed();
    await db.update(issues).set({
      status: "todo",
      createdByAgentId: fixture.actorAgent.id,
      createdByUserId: null,
    }).where(eq(issues.id, fixture.issue.id));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, fixture.targetAgent.id));
    const app = await createApp(db, noRunAgentActor(fixture));

    const response = await request(app)
      .post(`/api/issues/${fixture.issue.id}/comments`)
      .send({ body: "Persist while the assignee is paused", clientRequestId: randomUUID() });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("retries a committed receipt when durable wake admission fails", async () => {
    const fixture = await seed();
    await db.update(issues).set({
      status: "todo",
      createdByAgentId: fixture.actorAgent.id,
      createdByUserId: null,
    }).where(eq(issues.id, fixture.issue.id));
    const app = await createApp(db, noRunAgentActor(fixture));
    const input = {
      body: "Recover the comment wake after admission fails",
      clientRequestId: randomUUID(),
    };
    mockHeartbeat.wakeup.mockRejectedValueOnce(new Error("wake admission failed"));

    const failed = await request(app)
      .post(`/api/issues/${fixture.issue.id}/comments`)
      .send(input);
    expect(failed.status).toBe(500);
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(
      activityLog.action,
      "issue.runless_agent_comment_admitted",
    ))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, fixture.issue.id),
      eq(activityLog.action, "issue.comment_added"),
    ))).toHaveLength(1);

    const retry = await request(app)
      .post(`/api/issues/${fixture.issue.id}/comments`)
      .send(input);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(2);
    expect(mockHeartbeat.wakeup.mock.calls.map((call) => call[1]?.idempotencyKey))
      .toEqual([
        `issue-comment:${retry.body.id}:${fixture.targetAgent.id}`,
        `issue-comment:${retry.body.id}:${fixture.targetAgent.id}`,
      ]);
    expect(await db.select().from(activityLog).where(eq(
      activityLog.action,
      "issue.runless_agent_comment_admitted",
    ))).toHaveLength(1);
  }, 30_000);

  it("wakes only the replay that finalizes receipt activity before the original request", async () => {
    const fixture = await seed();
    await db.update(issues).set({
      status: "todo",
      createdByAgentId: fixture.actorAgent.id,
      createdByUserId: null,
    }).where(eq(issues.id, fixture.issue.id));
    const app = await createApp(db, noRunAgentActor(fixture));
    const input = { body: "Replay wins receipt finalization", clientRequestId: randomUUID() };
    const originalAtReceipt = Promise.withResolvers<void>();
    const releaseOriginal = Promise.withResolvers<void>();
    receiptFinalizationControl.beforeNext = async () => {
      originalAtReceipt.resolve();
      await releaseOriginal.promise;
    };

    const original = request(app).post(`/api/issues/${fixture.issue.id}/comments`).send(input)
      .then((response) => response);
    await originalAtReceipt.promise;
    const replay = await (async () => {
      try {
        return await request(app).post(`/api/issues/${fixture.issue.id}/comments`).send(input);
      } finally {
        releaseOriginal.resolve();
      }
    })();
    const originalResponse = await original;

    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(originalResponse.status, JSON.stringify(originalResponse.body)).toBe(201);
    expect(originalResponse.body.id).toBe(replay.body.id);
    await vi.waitFor(() => expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(2));
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, fixture.issue.id),
      eq(activityLog.action, "issue.comment_added"),
    ))).toHaveLength(1);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(2);
    expect(mockHeartbeat.wakeup.mock.calls.map((call) => call[1]?.idempotencyKey))
      .toEqual([
        `issue-comment:${replay.body.id}:${fixture.targetAgent.id}`,
        `issue-comment:${replay.body.id}:${fixture.targetAgent.id}`,
      ]);
  }, 30_000);

  it("keeps no-run comments and updates denied for non-creators and other companies", async () => {
    const fixture = await seed();
    const app = await createApp(db, noRunAgentActor(fixture));
    const input = { body: "Unrelated no-run write", clientRequestId: randomUUID() };

    const userCreated = await request(app).post(`/api/issues/${fixture.issue.id}/comments`).send(input);
    expect(userCreated.status).toBe(403);

    await db.update(issues).set({ createdByAgentId: fixture.targetAgent.id }).where(eq(issues.id, fixture.issue.id));
    const otherAgentCreated = await request(app).post(`/api/issues/${fixture.issue.id}/comments`).send(input);
    expect(otherAgentCreated.status).toBe(403);

    await db.update(issues).set({ createdByAgentId: fixture.actorAgent.id }).where(eq(issues.id, fixture.issue.id));
    const otherCompany = await request(await createApp(db, noRunAgentActor(fixture, { companyId: randomUUID() })))
      .post(`/api/issues/${fixture.issue.id}/comments`).send(input);
    expect(otherCompany.status).toBe(404);

    const patch = await request(app).patch(`/api/issues/${fixture.issue.id}`).send({ title: "Still denied" });
    expect(patch.status).toBe(403);
    expect(await db.select().from(issueComments)).toHaveLength(0);
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
  }, 30_000);

  it("does not widen the no-run creator exception to attachments, lifecycle, structure, or attribution", async () => {
    const fixture = await seed();
    await db.update(issues).set({
      status: "todo",
      createdByAgentId: fixture.actorAgent.id,
      createdByUserId: null,
    }).where(eq(issues.id, fixture.issue.id));
    const app = await createApp(db, noRunAgentActor(fixture));
    const cases: Array<Record<string, unknown>> = [
      { attachmentIds: [randomUUID()] },
      { reopen: true },
      { resume: true },
      { interrupt: true },
      { presentation: null },
      { metadata: null },
      { authorType: "user" },
      { onBehalfOfUserId: "someone-else" },
      { clientRequestId: undefined },
    ];

    for (const extra of cases) {
      const response = await request(app).post(`/api/issues/${fixture.issue.id}/comments`).send({
        body: "Must remain a plain keyed comment",
        clientRequestId: randomUUID(),
        ...extra,
      });
      expect([400, 401, 403, 409, 422], JSON.stringify(response.body)).toContain(response.status);
    }
    expect(await db.select().from(issueComments)).toHaveLength(0);
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
  }, 30_000);

  it("leaves one comment and activity across concurrent creator retries", async () => {
    const fixture = await seed();
    await db.update(issues).set({
      status: "todo",
      createdByAgentId: fixture.actorAgent.id,
      createdByUserId: null,
    }).where(eq(issues.id, fixture.issue.id));
    const app = await createApp(db, noRunAgentActor(fixture));
    const input = { body: "Concurrent poller receipt", clientRequestId: randomUUID() };

    const responses = await Promise.all(Array.from({ length: 4 }, () =>
      request(app).post(`/api/issues/${fixture.issue.id}/comments`).send(input),
    ));
    for (const response of responses) {
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.id).toBe(responses[0]!.body.id);
    }
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, fixture.issue.id),
      eq(activityLog.action, "issue.comment_added"),
    ))).toHaveLength(1);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(4);
    expect(new Set(mockHeartbeat.wakeup.mock.calls.map((call) => call[1]?.idempotencyKey)))
      .toEqual(new Set([
        `issue-comment:${responses[0]!.body.id}:${fixture.targetAgent.id}`,
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
