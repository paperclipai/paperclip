import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueCreateIdempotencyKeys,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { intakeReceiverScopeGuard } from "../middleware/intake-receiver-scope.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS,
  issueService,
} from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue create deduplication route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue create deduplication routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-deduplication-routes-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentApiKeys);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function createAuthenticatedApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use(intakeReceiverScopeGuard());
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedParent(companyId: string) {
    const [parent] = await db.insert(issues).values({
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
    }).returning();
    return parent;
  }

  async function seedReceiverKey(input: {
    companyId: string;
    projectId: string;
    assigneeAgentId: string;
  }) {
    const agentId = randomUUID();
    const keyId = randomUUID();
    const token = `receiver-${randomUUID()}`;
    const responsibleUserId = `receiver-owner-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Receiver owner",
      email: `${responsibleUserId}@example.com`,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId: input.companyId,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: `Receiver ${keyId.slice(0, 8)}`,
      role: "uptime receiver",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentApiKeys).values({
      id: keyId,
      companyId: input.companyId,
      agentId,
      name: "uptime intake receiver",
      keyHash: createHash("sha256").update(token).digest("hex"),
      responsibleUserId,
      scopeConfig: {
        kind: "intake_receiver",
        projectId: input.projectId,
        assigneeAgentId: input.assigneeAgentId,
        priority: "medium",
      },
    });
    return { keyId, token };
  }

  function receiverIssue(projectId: string, assigneeAgentId: string, input: {
    title: string;
    idempotencyKey: string;
  }) {
    return {
      title: input.title,
      description: "Sanitized uptime transition",
      status: "todo",
      priority: "medium",
      projectId,
      assigneeAgentId,
      idempotencyKey: input.idempotencyKey,
    };
  }

  async function seedReceiverFixture() {
    const companyId = await seedCompany();
    const assigneeAgentId = randomUUID();
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Intake owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [project] = await db.insert(projects).values({
      companyId,
      name: "Uptime intake",
      status: "planned",
    }).returning();
    return { assigneeAgentId, companyId, project };
  }

  it("replays the existing issue for the same company idempotency key", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Prepare release", idempotencyKey: "run-1:prepare-release" })
      .expect(201);
    const replay = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        parentId: parent.id,
        title: "Different retry payload",
        idempotencyKey: "run-1:prepare-release",
        allowDuplicate: true,
      })
      .expect(200);

    expect(replay.body).toMatchObject({
      id: first.body.id,
      title: "Prepare release",
      deduplicated: true,
      deduplicationReason: "idempotency_key",
    });
    expect(await db.select().from(issueCreateIdempotencyKeys)).toHaveLength(1);
  });

  it("replays a receiver issue only for the same intake key", async () => {
    const { assigneeAgentId, companyId, project } = await seedReceiverFixture();
    const receiver = await seedReceiverKey({ companyId, projectId: project.id, assigneeAgentId });
    const app = createAuthenticatedApp();
    const body = receiverIssue(project.id, assigneeAgentId, {
      title: "[Uptime] staging API unavailable",
      idempotencyKey: "uptime-failure-intake:same-key-replay",
    });

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("Authorization", `Bearer ${receiver.token}`)
      .send(body)
      .expect(201);
    const replay = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("Authorization", `Bearer ${receiver.token}`)
      .send({ ...body, title: "[Uptime] retry payload ignored" })
      .expect(200);

    expect(replay.body).toMatchObject({
      id: first.body.id,
      deduplicated: true,
      deduplicationReason: "idempotency_key",
      originKind: "intake_receiver",
      originId: receiver.keyId,
    });
  });

  it("does not disclose or bind another receiver issue on a cross-key idempotency collision", async () => {
    const { assigneeAgentId, companyId, project } = await seedReceiverFixture();
    const firstReceiver = await seedReceiverKey({ companyId, projectId: project.id, assigneeAgentId });
    const secondReceiver = await seedReceiverKey({ companyId, projectId: project.id, assigneeAgentId });
    const app = createAuthenticatedApp();
    const idempotencyKey = "uptime-failure-intake:cross-key-collision";

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("Authorization", `Bearer ${firstReceiver.token}`)
      .send(receiverIssue(project.id, assigneeAgentId, {
        title: "[Uptime] first receiver event",
        idempotencyKey,
      }))
      .expect(201);
    const second = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("Authorization", `Bearer ${secondReceiver.token}`)
      .send(receiverIssue(project.id, assigneeAgentId, {
        title: "[Uptime] second receiver event",
        idempotencyKey,
      }))
      .expect(201);

    expect(second.body.id).not.toBe(first.body.id);
    expect(second.body).toMatchObject({
      originKind: "intake_receiver",
      originId: secondReceiver.keyId,
    });
    expect(await db.select().from(issueCreateIdempotencyKeys)).toHaveLength(2);
  });

  it("does not title-deduplicate a receiver create against another project", async () => {
    const { assigneeAgentId, companyId, project } = await seedReceiverFixture();
    const receiver = await seedReceiverKey({ companyId, projectId: project.id, assigneeAgentId });
    const [otherProject] = await db.insert(projects).values({
      companyId,
      name: "Other project",
      status: "planned",
    }).returning();
    const title = "[Uptime] predictable staging outage";
    const [unrelatedIssue] = await db.insert(issues).values({
      companyId,
      projectId: otherProject.id,
      title,
      status: "todo",
      priority: "medium",
    }).returning();
    const app = createAuthenticatedApp();

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("Authorization", `Bearer ${receiver.token}`)
      .send(receiverIssue(project.id, assigneeAgentId, {
        title,
        idempotencyKey: "uptime-failure-intake:title-collision",
      }))
      .expect(201);

    expect(created.body.id).not.toBe(unrelatedIssue.id);
    expect(created.body).toMatchObject({
      projectId: project.id,
      assigneeAgentId,
      originKind: "intake_receiver",
      originId: receiver.keyId,
    });
  });

  it("expires old idempotency keys before replay lookup", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();
    const oldIssueId = randomUUID();
    const idempotencyKey = "run-1:expired-retry";
    const expiredCreatedAt = new Date(
      Date.now() - (ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    await db.insert(issues).values({
      id: oldIssueId,
      companyId,
      parentId: parent.id,
      title: "Expired retry target",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueCreateIdempotencyKeys).values({
      companyId,
      idempotencyKey,
      issueId: oldIssueId,
      createdAt: expiredCreatedAt,
    });

    const recreated = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Expired retry creates new work", idempotencyKey })
      .expect(201);

    const rows = await db.select().from(issueCreateIdempotencyKeys);
    expect(recreated.body.id).not.toBe(oldIssueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      idempotencyKey,
      issueId: recreated.body.id,
    });
  });

  it("returns a recent open sibling whose normalized title matches", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Create   a single PR" })
      .expect(201);
    const duplicate = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "  create a SINGLE pr  " })
      .expect(200);

    expect(duplicate.body).toMatchObject({
      id: first.body.id,
      deduplicated: true,
      deduplicationReason: "recent_open_title",
    });
  });

  it("serializes keyed and title-only creates for the same issue", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const [keyed, titleOnly] = await Promise.all([
      request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ parentId: parent.id, title: "Coordinate launch", idempotencyKey: "run-2:coordinate-launch" }),
      request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ parentId: parent.id, title: "Coordinate launch" }),
    ]);

    expect([keyed.status, titleOnly.status].sort()).toEqual([200, 201]);
    expect(keyed.body.id).toBe(titleOnly.body.id);
    expect([keyed, titleOnly].find((response) => response.status === 200)?.body).toMatchObject({
      deduplicated: true,
      deduplicationReason: "recent_open_title",
    });
    expect(await db.select().from(issues).where(eq(issues.parentId, parent.id))).toHaveLength(1);
    expect(await db.select().from(issueCreateIdempotencyKeys)).toEqual([
      expect.objectContaining({ issueId: keyed.body.id, idempotencyKey: "run-2:coordinate-launch" }),
    ]);

    const replay = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Different title", idempotencyKey: "run-2:coordinate-launch" })
      .expect(200);
    expect(replay.body).toMatchObject({
      id: keyed.body.id,
      deduplicated: true,
      deduplicationReason: "idempotency_key",
    });
  });

  it("allows an explicit duplicate create", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Investigate incident" })
      .expect(201);
    const duplicate = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Investigate incident", allowDuplicate: true })
      .expect(201);

    expect(duplicate.body.id).not.toBe(first.body.id);
  });

  it("does not apply the route soft guard to internal service creates", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const svc = issueService(db);

    const first = await svc.create(companyId, {
      parentId: parent.id,
      title: "System-generated follow-up",
      status: "todo",
      priority: "medium",
    });
    const second = await svc.create(companyId, {
      parentId: parent.id,
      title: "System-generated follow-up",
      status: "todo",
      priority: "medium",
    });

    expect(second.id).not.toBe(first.id);
  });

  it("does not let closed or older issues block a recreate", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();
    const oldIssueId = randomUUID();
    const closedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: oldIssueId,
        companyId,
        parentId: parent.id,
        title: "Retry old work",
        status: "todo",
        priority: "medium",
        createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000),
      },
      {
        id: closedIssueId,
        companyId,
        parentId: parent.id,
        title: "Retry closed work",
        status: "done",
        priority: "medium",
      },
    ]);

    const recreatedOld = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Retry old work" })
      .expect(201);
    const recreatedClosed = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Retry closed work" })
      .expect(201);

    expect(recreatedOld.body.id).not.toBe(oldIssueId);
    expect(recreatedClosed.body.id).not.toBe(closedIssueId);
  });

  it("stores the request run header on manual creates", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();
    const runId = randomUUID();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Creating agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
    });

    const response = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ parentId: parent.id, title: "Attributed create" })
      .expect(201);
    const [created] = await db.select().from(issues).where(eq(issues.id, response.body.id));

    expect(created.originKind).toBe("manual");
    expect(created.originRunId).toBe(runId);
  });
});
