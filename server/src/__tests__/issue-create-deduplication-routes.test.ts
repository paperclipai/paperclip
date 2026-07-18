import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueCreateIdempotencyKeys,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
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
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(options: Parameters<typeof issueRoutes>[2] = {}) {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any, options));
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

  async function seedAgent(companyId: string) {
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Planner",
      role: "planner",
      adapterType: "process",
      adapterConfig: {},
      status: "idle",
    }).returning();
    return agent;
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

  it("returns a durable canonical receipt for an external source after transient key expiry", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    const body = {
      title: "Plan customer newsletter",
      status: "backlog",
      workMode: "planning",
      allowDuplicate: true,
      idempotencyKey: "meteor:conversation-1:turn-1",
      sourceRef: { namespace: "meteor", kind: "conversation_turn", id: "conversation-1:turn-1" },
    };

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(body)
      .expect(201);

    await db.delete(issueCreateIdempotencyKeys);

    const replay = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ ...body, idempotencyKey: "meteor:replacement-transient-key" })
      .expect(200);

    expect(first.body.receipt).toEqual({
      version: 1,
      companyId,
      issueId: first.body.id,
      identifier: first.body.identifier,
      created: true,
      deduplicationReason: null,
      idempotencyKey: body.idempotencyKey,
      sourceRef: body.sourceRef,
    });
    expect(replay.body).toMatchObject({
      id: first.body.id,
      deduplicated: true,
      deduplicationReason: "source_ref",
      receipt: {
        issueId: first.body.id,
        created: false,
        deduplicationReason: "source_ref",
        idempotencyKey: "meteor:replacement-transient-key",
        sourceRef: body.sourceRef,
      },
    });
    const [stored] = await db.select().from(issues).where(eq(issues.id, first.body.id));
    expect(stored).toMatchObject({
      originKind: "external:meteor:conversation_turn",
      originId: "conversation-1:turn-1",
    });
    expect(stored.originFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    const repairedActivities = await db.select().from(activityLog).where(eq(activityLog.entityId, first.body.id));
    expect(repairedActivities.filter((row) => row.action === "issue.created")).toHaveLength(1);
  });

  it("serializes concurrent external-source submissions into one issue", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    const body = {
      title: "Prepare launch proposal",
      status: "backlog",
      workMode: "planning",
      sourceRef: { namespace: "meteor", kind: "conversation_turn", id: "conversation-2:turn-4" },
      allowDuplicate: true,
    };

    const responses = await Promise.all([
      request(app).post(`/api/companies/${companyId}/issues`).send(body),
      request(app).post(`/api/companies/${companyId}/issues`).send(body),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(responses[0].body.id).toBe(responses[1].body.id);
    expect(await db.select().from(issues)).toHaveLength(1);
  });

  it("rejects changed content for an already-linked external source", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    const sourceRef = { namespace: "meteor", kind: "conversation_turn", id: "conversation-3:turn-2" };
    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Create a proposal", status: "backlog", sourceRef, allowDuplicate: true })
      .expect(201);

    const conflict = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Create a different proposal", status: "backlog", sourceRef, allowDuplicate: true })
      .expect(409);

    expect(conflict.body).toMatchObject({
      code: "source_ref_conflict",
      details: { issueId: first.body.id, sourceRef },
    });
    expect(await db.select().from(issues)).toHaveLength(1);
  });

  it("binds the durable source receipt to the caller's canonical payload fingerprint", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    const baseSource = { namespace: "meteor", kind: "conversation_turn", id: "conversation-3:turn-3" };
    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Create a proposal",
        status: "backlog",
        sourceRef: { ...baseSource, payloadFingerprint: `sha256:${"a".repeat(64)}` },
        allowDuplicate: true,
      })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Create a proposal",
        status: "backlog",
        sourceRef: { ...baseSource, payloadFingerprint: `sha256:${"b".repeat(64)}` },
        allowDuplicate: true,
      })
      .expect(409);
  });

  it("does not merge different source turns that have the same title", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Create newsletter",
        status: "backlog",
        sourceRef: { namespace: "meteor", kind: "conversation_turn", id: "conversation-4:turn-1" },
      })
      .expect(201);
    const second = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Create newsletter",
        status: "backlog",
        sourceRef: { namespace: "meteor", kind: "conversation_turn", id: "conversation-4:turn-2" },
      })
      .expect(201);

    expect(second.body.id).not.toBe(first.body.id);
    expect(await db.select().from(issues)).toHaveLength(2);
  });

  it("rejects malformed external source references at the API edge", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Invalid source",
        sourceRef: { namespace: "Meteor Org", kind: "conversation/turn", id: "" },
      })
      .expect(400);
    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("allows only one concurrent update for a canonical issue revision", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Plan customer launch",
        status: "backlog",
        workMode: "planning",
        sourceRef: { namespace: "meteor", kind: "conversation_turn", id: "conversation-5:turn-1" },
      })
      .expect(201);

    const responses = await Promise.all([
      request(app)
        .patch(`/api/issues/${created.body.id}`)
        .send({ title: "Plan customer launch A", expectedUpdatedAt: created.body.updatedAt }),
      request(app)
        .patch(`/api/issues/${created.body.id}`)
        .send({ title: "Plan customer launch B", expectedUpdatedAt: created.body.updatedAt }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)?.body).toMatchObject({
      error: "Issue update conflict",
      details: {
        code: "issue_update_conflict",
        issueId: created.body.id,
        expectedUpdatedAt: created.body.updatedAt,
      },
    });
    const [stored] = await db.select().from(issues).where(eq(issues.id, created.body.id));
    expect(["Plan customer launch A", "Plan customer launch B"]).toContain(stored.title);
  });

  it("atomically activates planning once and reuses the durable wake on a concurrent retry", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const enqueueWakeup = vi.fn(async (agentId: string, options: Record<string, any>) => {
      const [wake] = await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: options.source,
        triggerDetail: options.triggerDetail,
        reason: options.reason,
        payload: options.payload,
        status: "queued",
        requestedByActorType: options.requestedByActorType,
        requestedByActorId: options.requestedByActorId,
        idempotencyKey: options.idempotencyKey,
      }).returning();
      return wake;
    });
    const app = createApp({ activationEnqueueWakeup: enqueueWakeup as any });
    const contractBody = JSON.stringify({
      version: "meteor.work.v1",
      phase: "ready",
      planningAgentId: agent.id,
      completionPolicy: "issue_done_and_all_evidence_verified",
      source: {
        channel: "agent_chat",
        conversationId: "conversation-6",
        turnId: "turn-1",
        capturedAt: "2026-07-18T10:00:00.000Z",
      },
    });
    const contractFingerprint = `sha256:${createHash("sha256").update(contractBody).digest("hex")}`;
    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Plan launch",
        status: "backlog",
        workMode: "planning",
        sourceRef: {
          namespace: "meteor",
          kind: "conversation_turn",
          id: "conversation-6:turn-1",
          payloadFingerprint: contractFingerprint,
        },
      })
      .expect(201);
    await request(app)
      .put(`/api/issues/${created.body.id}/documents/work-contract`)
      .send({ title: "Work Contract", format: "markdown", body: contractBody })
      .expect(201);
    const activation = {
      agentId: agent.id,
      expectedUpdatedAt: created.body.updatedAt,
      activationKey: "meteor-work-v1:activation-1",
    };

    const responses = await Promise.all([
      request(app).post(`/api/issues/${created.body.id}/activate-planning`).send(activation),
      request(app).post(`/api/issues/${created.body.id}/activate-planning`).send(activation),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.every((response) => response.body.status === "todo")).toBe(true);
    expect(responses.every((response) => response.body.assigneeAgentId === agent.id)).toBe(true);
    expect(responses.map((response) => response.body.activation.wakeEnqueued).sort()).toEqual([false, true]);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);

    const replay = await request(app)
      .post(`/api/issues/${created.body.id}/activate-planning`)
      .send({ agentId: agent.id, activationKey: "a-different-client-retry-key" })
      .expect(200);
    expect(replay.body.activation.wakeEnqueued).toBe(false);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);

    const [firstWake] = await db.select().from(agentWakeupRequests);
    await db.update(agentWakeupRequests).set({ status: "failed" }).where(eq(agentWakeupRequests.id, firstWake.id));
    const repaired = await request(app)
      .post(`/api/issues/${created.body.id}/activate-planning`)
      .send({ agentId: agent.id, activationKey: "repair-after-failed-wake" })
      .expect(200);
    expect(repaired.body.activation.wakeEnqueued).toBe(true);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, created.body.id));
    expect(activities.filter((row) => row.action === "issue.created")).toHaveLength(1);
    expect(activities.filter((row) => row.action === "issue.planning_activated")).toHaveLength(1);
  });

  it("refuses activation when the source-bound document is not a valid planning contract", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const enqueueWakeup = vi.fn();
    const app = createApp({ activationEnqueueWakeup: enqueueWakeup as any });
    const contractBody = "{}";
    const contractFingerprint = `sha256:${createHash("sha256").update(contractBody).digest("hex")}`;
    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Reject invalid planning contract",
        status: "backlog",
        workMode: "planning",
        sourceRef: {
          namespace: "meteor",
          kind: "conversation_turn",
          id: "conversation-invalid:turn-1",
          payloadFingerprint: contractFingerprint,
        },
      })
      .expect(201);
    await request(app)
      .put(`/api/issues/${created.body.id}/documents/work-contract`)
      .send({ title: "Work Contract", format: "markdown", body: contractBody })
      .expect(201);

    await request(app)
      .post(`/api/issues/${created.body.id}/activate-planning`)
      .send({
        agentId: agent.id,
        expectedUpdatedAt: created.body.updatedAt,
        activationKey: "invalid-contract-attempt",
      })
      .expect(409, { error: "Persisted work-contract is not a valid planning contract" });

    expect(enqueueWakeup).not.toHaveBeenCalled();
    const [stored] = await db.select().from(issues).where(eq(issues.id, created.body.id));
    expect(stored.status).toBe("backlog");
    expect(stored.assigneeAgentId).toBeNull();
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
