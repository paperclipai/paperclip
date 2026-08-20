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
  companySkills,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueCreateIdempotencyKeys,
  issueComments,
  issueDocuments,
  issuePlanDecompositions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS,
  issueService,
} from "../services/issues.js";
import { buildAgentUnblockWakeIntent } from "../services/routable-blocked.js";

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
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issuePlanDecompositions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(issues);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(opts: Parameters<typeof issueRoutes>[2] = {}) {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any, opts));
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

  async function seedParent(companyId: string, assigneeAgentId: string | null = null) {
    const [parent] = await db.insert(issues).values({
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId,
    }).returning();
    return parent;
  }

  async function seedAgent(
    companyId: string,
    reportsTo: string | null = null,
    status: "active" | "paused" = "active",
  ) {
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Unblock owner",
      role: "manager",
      status,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      reportsTo,
    }).returning();
    return agent;
  }

  async function seedAgentKey(companyId: string, agentId: string) {
    const token = `pcp_test_${randomUUID()}`;
    const responsibleUserId = `test-user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Route test operator",
      email: `${responsibleUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(agentApiKeys).values({
      companyId,
      agentId,
      name: "route-test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      responsibleUserId,
    });
    return token;
  }

  async function seedAcceptedPlanRevision(companyId: string, issueId: string) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "Plan body",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "Plan body",
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
        target: {
          type: "issue_document",
          issueId,
          documentId,
          key: "plan",
          revisionId,
          revisionNumber: 1,
        },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedAt: new Date(),
      createdByUserId: "local-board",
      resolvedByUserId: "local-board",
    });
    return revisionId;
  }

  function acceptedBlockedOwnerWakeup(companyId: string) {
    return async (
      agentId: string,
      options: Parameters<NonNullable<Parameters<typeof issueRoutes>[2]["blockedOwnerEnqueueWakeup"]>>[1],
    ) => {
      const [requestRow] = await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: options.source ?? "automation",
        triggerDetail: options.triggerDetail ?? null,
        reason: options.reason ?? null,
        payload: options.payload ?? null,
        status: "queued",
        idempotencyKey: options.idempotencyKey ?? null,
      }).returning();
      return { id: randomUUID(), wakeupRequestId: requestRow.id } as any;
    };
  }

  it("mints one idempotent unblock-owner wake when a root issue is created blocked", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const app = createApp({ blockedOwnerEnqueueWakeup: acceptedBlockedOwnerWakeup(companyId) });
    const idempotencyKey = "run-1:blocked-root";

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Review a blocking finding",
        status: "blocked",
        idempotencyKey,
        unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the finding" },
      })
      .expect(201);
    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Retry must reuse the original issue",
        status: "blocked",
        idempotencyKey,
        unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the finding" },
      })
      .expect(200);

    const [persisted] = await db.select().from(issues).where(eq(issues.id, first.body.id));
    expect(persisted).toMatchObject({
      status: "blocked",
      blockedTransitionAt: expect.any(Date),
      blockedOwnerNotifiedAt: expect.any(Date),
    });
    const wakeRequests = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, owner.id));
    const intent = buildAgentUnblockWakeIntent(persisted)!;
    expect(wakeRequests).toHaveLength(1);
    expect(wakeRequests[0]).toMatchObject({
      reason: "issue_unblock_requested",
      payload: intent.payload,
      idempotencyKey: intent.idempotencyKey,
    });
  });

  it("does not enqueue a second assignment wake when the accepted unblock owner is already the assignee", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const app = createApp({ blockedOwnerEnqueueWakeup: acceptedBlockedOwnerWakeup(companyId) });

    const response = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Owner-assigned blocked root",
        status: "blocked",
        assigneeAgentId: owner.id,
        unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the finding" },
      })
      .expect(201);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const wakes = await db
      .select({ reason: agentWakeupRequests.reason, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, owner.id));

    expect(response.body.blockedOwnerNotifiedAt).toEqual(expect.any(String));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ reason: "issue_unblock_requested" });
  });

  it("rejects a non-invokable unblock owner before blocked root creation", async () => {
    const companyId = await seedCompany();
    const pausedOwner = await seedAgent(companyId, null, "paused");
    const app = createApp({
      blockedOwnerEnqueueWakeup: async () => {
        throw new Error("scheduler must not be called");
      },
    });

    const response = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Paused owner blocked root",
        status: "blocked",
        priority: "medium",
        unblockDescriptor: {
          owner: { agentId: pausedOwner.id },
          action: "Review the unblock request",
        },
      })
      .expect(422);

    expect(response.body.error).toBe("Unblock owner agent must be invokable");
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("revalidates unblock-owner invokability inside the create transaction", async () => {
    const companyId = await seedCompany();
    const pausedOwner = await seedAgent(companyId, null, "paused");

    await expect(issueService(db).create(companyId, {
      title: "Transactionally guarded blocked issue",
      status: "blocked",
      unblockDescriptor: { owner: { agentId: pausedOwner.id }, action: "Review the unblock request" },
    })).rejects.toMatchObject({ status: 422 });

    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("revalidates the creator reporting line inside the create transaction", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const creator = await seedAgent(companyId);

    await expect(issueService(db).create(companyId, {
      title: "Transactionally guarded blocked owner authorization",
      status: "blocked",
      createdByAgentId: creator.id,
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the unblock request" },
    })).rejects.toMatchObject({ status: 422 });

    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("allows a creator to retain an invokable reporting-line manager as unblock owner", async () => {
    const companyId = await seedCompany();
    const manager = await seedAgent(companyId);
    const creator = await seedAgent(companyId, manager.id);

    const created = await issueService(db).create(companyId, {
      title: "Transactionally authorized blocked owner",
      status: "blocked",
      createdByAgentId: creator.id,
      unblockDescriptor: { owner: { agentId: manager.id }, action: "Review the unblock request" },
    });

    expect(created).toMatchObject({
      status: "blocked",
      createdByAgentId: creator.id,
    });
  });

  it("keeps a post-commit owner pause unnotified and recovers after resume", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const acceptedWakeup = acceptedBlockedOwnerWakeup(companyId);
    let attempts = 0;
    const app = createApp({
      blockedOwnerEnqueueWakeup: async (...args) => {
        attempts += 1;
        if (attempts === 1) {
          await db.update(agents).set({ status: "paused", updatedAt: new Date() }).where(eq(agents.id, owner.id));
          return null;
        }
        return acceptedWakeup(...args);
      },
    });
    const payload = {
      title: "Owner pauses after issue commit",
      status: "blocked",
      idempotencyKey: "owner-pauses-after-commit",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the unblock request" },
    };

    const first = await request(app).post(`/api/companies/${companyId}/issues`).send(payload).expect(201);
    expect(first.body.blockedOwnerNotifiedAt).toBeNull();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);

    await db.update(agents).set({ status: "active", updatedAt: new Date() }).where(eq(agents.id, owner.id));
    const replay = await request(app).post(`/api/companies/${companyId}/issues`).send(payload).expect(200);
    expect(replay.body.blockedOwnerNotifiedAt).toBeTypeOf("string");
    expect(attempts).toBe(2);
    expect(await db.select().from(issues)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });

  it("does not let an unrelated agent repair a deduplicated blocked root", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const unrelated = await seedAgent(companyId);
    const unrelatedToken = await seedAgentKey(companyId, unrelated.id);
    const app = createApp({ blockedOwnerEnqueueWakeup: async () => null });
    const payload = {
      title: "Board-owned blocked root",
      status: "blocked",
      idempotencyKey: "board:blocked-root",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review board context" },
    };

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(payload)
      .expect(201);
    const replay = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("Authorization", `Bearer ${unrelatedToken}`)
      .send({ title: payload.title, idempotencyKey: payload.idempotencyKey })
      .expect(403);

    expect(replay.body.error).toBe(
      "Agents may only name themselves or a reporting-line manager as an unblock owner",
    );
    expect(await db.select().from(issues)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("recovers an unnotified blocked create on idempotent replay", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const acceptedWakeup = acceptedBlockedOwnerWakeup(companyId);
    let attempts = 0;
    const app = createApp({
      blockedOwnerEnqueueWakeup: async (...args) => {
        attempts += 1;
        return attempts === 1 ? null : acceptedWakeup(...args);
      },
    });
    const payload = {
      title: "Recover a suppressed owner notification",
      status: "blocked",
      idempotencyKey: "run-1:recover-blocked-root",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the finding" },
    };

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(payload)
      .expect(201);
    expect(first.body.blockedOwnerNotifiedAt).toBeNull();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);

    const replay = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(payload)
      .expect(200);
    expect(replay.body).toMatchObject({
      id: first.body.id,
      deduplicated: true,
      blockedOwnerNotifiedAt: expect.any(String),
    });
    expect(attempts).toBe(2);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });

  it("recovers a committed blocked create after scheduling throws", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const acceptedWakeup = acceptedBlockedOwnerWakeup(companyId);
    let attempts = 0;
    const app = createApp({
      blockedOwnerEnqueueWakeup: async (...args) => {
        attempts += 1;
        if (attempts === 1) throw new Error("scheduler unavailable");
        return acceptedWakeup(...args);
      },
    });
    const payload = {
      title: "Recover a failed owner notification",
      status: "blocked",
      idempotencyKey: "run-1:failed-blocked-root",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the finding" },
    };

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(payload)
      .expect(201);
    const committed = await db
      .select()
      .from(issues)
      .where(eq(issues.title, payload.title))
      .then((rows) => rows[0]);
    expect(committed).toMatchObject({
      status: "blocked",
      blockedOwnerNotifiedAt: null,
    });

    const replay = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(payload)
      .expect(200);
    expect(replay.body).toMatchObject({
      id: committed.id,
      blockedOwnerNotifiedAt: expect.any(String),
    });
    expect(attempts).toBe(2);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });

  it("falls back to an assignee wake when the canonical owner scheduler rejects a blocked root", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const app = createApp({
      blockedOwnerEnqueueWakeup: async () => {
        throw new Error("canonical unblock scheduler unavailable");
      },
    });

    const response = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Fallback after blocked owner scheduler failure",
        status: "blocked",
        assigneeAgentId: owner.id,
        unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the finding" },
      })
      .expect(201);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const wakeRequests = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, owner.id));

    expect(response.body.blockedOwnerNotifiedAt).toBeNull();
    expect(wakeRequests).toContainEqual({ reason: "issue_assigned" });
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
  });

  it("reconciles an accepted wake after a pre-notification crash without duplicating it", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const issue = await issueService(db).create(companyId, {
      title: "Recover committed owner wake",
      status: "blocked",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the finding" },
    });
    const intent = buildAgentUnblockWakeIntent(issue)!;
    const idempotencyKey = intent.idempotencyKey;
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: owner.id,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_unblock_requested",
      payload: intent.payload,
      status: "queued",
      idempotencyKey,
    });
    let attempts = 0;
    const app = createApp({
      blockedOwnerEnqueueWakeup: async () => {
        attempts += 1;
        throw new Error("must not schedule a duplicate wake");
      },
    });

    const response = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ description: "Trigger durable notification reconciliation" })
      .expect(200);

    expect(response.body.blockedOwnerNotifiedAt).toEqual(expect.any(String));
    expect(attempts).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });

  it("retries an exact owner intent whose previously accepted request later failed", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const issue = await issueService(db).create(companyId, {
      title: "Retry failed owner wake",
      status: "blocked",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the failure" },
    });
    const intent = buildAgentUnblockWakeIntent(issue)!;
    const staleNotifiedAt = new Date("2026-07-28T20:00:00.000Z");
    await db.update(issues).set({ blockedOwnerNotifiedAt: staleNotifiedAt }).where(eq(issues.id, issue.id));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: owner.id,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_unblock_requested",
      payload: intent.payload,
      status: "failed",
      idempotencyKey: intent.idempotencyKey,
    });
    let attempts = 0;
    const acceptedWakeup = acceptedBlockedOwnerWakeup(companyId);
    const app = createApp({
      blockedOwnerEnqueueWakeup: async (...args) => {
        attempts += 1;
        await db.transaction((tx) =>
          tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issue.id)).for("update"),
        );
        return acceptedWakeup(...args);
      },
    });

    const response = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ description: "Retry the failed delivery" })
      .expect(200);

    expect(response.body.blockedOwnerNotifiedAt).toEqual(expect.any(String));
    expect(response.body.blockedOwnerNotifiedAt).not.toBe(staleNotifiedAt.toISOString());
    expect(attempts).toBe(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(2);
  });

  it("reconciles coalesced owner wakes after heartbeat rewrites their reason", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const issue = await issueService(db).create(companyId, {
      title: "Reconcile coalesced owner wake",
      status: "blocked",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review this" },
    });
    const intent = buildAgentUnblockWakeIntent(issue)!;
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: owner.id,
      status: "succeeded",
      invocationSource: "manual",
      triggerDetail: "manual",
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: owner.id,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_same_name",
      payload: intent.payload,
      status: "coalesced",
      idempotencyKey: intent.idempotencyKey,
      runId,
    });
    let attempts = 0;
    const app = createApp({
      blockedOwnerEnqueueWakeup: async () => {
        attempts += 1;
        throw new Error("must not duplicate a coalesced wake");
      },
    });

    const response = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ description: "Reconcile the coalesced request" })
      .expect(200);

    expect(response.body.blockedOwnerNotifiedAt).toEqual(expect.any(String));
    expect(attempts).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });

  it("retries a coalesced owner wake after its linked run fails", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const issue = await issueService(db).create(companyId, {
      title: "Retry failed coalesced owner wake",
      status: "blocked",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review this" },
    });
    const intent = buildAgentUnblockWakeIntent(issue)!;
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: owner.id,
      status: "failed",
      invocationSource: "manual",
      triggerDetail: "manual",
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: owner.id,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_same_name",
      payload: intent.payload,
      status: "coalesced",
      idempotencyKey: intent.idempotencyKey,
      runId,
    });
    let attempts = 0;
    const acceptedWakeup = acceptedBlockedOwnerWakeup(companyId);
    const app = createApp({
      blockedOwnerEnqueueWakeup: async (...args) => {
        attempts += 1;
        return acceptedWakeup(...args);
      },
    });

    await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ description: "Retry after linked failure" })
      .expect(200);

    expect(attempts).toBe(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(2);
  });

  it("does not deliver a persisted owner wake after the reporting line moves away", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const creator = await seedAgent(companyId, owner.id);
    // Service-layer create validates the owner against the current reporting
    // line but does not deliver; the marker stays null until a route call
    // re-drives delivery (create, PATCH, or replay).
    const created = await issueService(db).create(companyId, {
      title: "Blocked by a finding",
      status: "blocked",
      createdByAgentId: creator.id,
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the finding" },
    });
    expect(created.blockedOwnerNotifiedAt).toBeNull();

    // The reporting line changes before any delivery runs: the owner is no
    // longer the creator's manager, so the persisted owner must not receive
    // the wake.
    await db.update(agents).set({ reportsTo: null }).where(eq(agents.id, creator.id));
    let attempts = 0;
    const retriedApp = createApp({
      blockedOwnerEnqueueWakeup: async (...args) => {
        attempts += 1;
        return acceptedBlockedOwnerWakeup(companyId)(...args);
      },
    });

    const stale = await request(retriedApp)
      .patch(`/api/issues/${created.id}`)
      .send({ description: "Retry the blocked owner wake" })
      .expect(200);

    expect(stale.body.blockedOwnerNotifiedAt).toBeNull();
    expect(attempts).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);

    // Once the hierarchy is repaired, the same replay delivers the wake.
    await db.update(agents).set({ reportsTo: owner.id }).where(eq(agents.id, creator.id));
    const repaired = await request(retriedApp)
      .patch(`/api/issues/${created.id}`)
      .send({ description: "Retry after hierarchy repair" })
      .expect(200);

    expect(repaired.body.blockedOwnerNotifiedAt).toEqual(expect.any(String));
    expect(attempts).toBe(1);
    const wakes = await db.select().from(agentWakeupRequests);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ reason: "issue_unblock_requested", agentId: owner.id });
  });

  it("reconciles deferred owner wakes after heartbeat rewrites their reason", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const issue = await issueService(db).create(companyId, {
      title: "Reconcile deferred owner wake",
      status: "blocked",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review this later" },
    });
    const intent = buildAgentUnblockWakeIntent(issue)!;
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: owner.id,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: intent.payload,
      status: "deferred_issue_execution",
      idempotencyKey: intent.idempotencyKey,
    });
    let attempts = 0;
    const app = createApp({
      blockedOwnerEnqueueWakeup: async () => {
        attempts += 1;
        throw new Error("must not duplicate a deferred wake");
      },
    });

    const response = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ description: "Reconcile the deferred request" })
      .expect(200);

    expect(response.body.blockedOwnerNotifiedAt).toEqual(expect.any(String));
    expect(attempts).toBe(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });

  it("does not let an old accepted action satisfy a revised owner intent", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const issue = await issueService(db).create(companyId, {
      title: "Revise owner wake action",
      status: "blocked",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Old action" },
    });
    const oldIntent = buildAgentUnblockWakeIntent(issue)!;
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: owner.id,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_unblock_requested",
      payload: oldIntent.payload,
      status: "queued",
      idempotencyKey: oldIntent.idempotencyKey,
    });
    await db.update(issues).set({
      unblockDescriptor: { owner: { agentId: owner.id }, action: "New action" },
      blockedOwnerNotifiedAt: new Date("2026-07-28T20:00:00.000Z"),
    }).where(eq(issues.id, issue.id));
    const acceptedWakeup = acceptedBlockedOwnerWakeup(companyId);
    const app = createApp({ blockedOwnerEnqueueWakeup: acceptedWakeup });

    const response = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ description: "Use the revised action" })
      .expect(200);
    const updated = await db.select().from(issues).where(eq(issues.id, issue.id)).then((rows) => rows[0]);
    const newIntent = buildAgentUnblockWakeIntent(updated)!;
    const wakeRequests = await db.select().from(agentWakeupRequests);

    expect(response.body.blockedOwnerNotifiedAt).toEqual(expect.any(String));
    expect(newIntent.idempotencyKey).not.toBe(oldIntent.idempotencyKey);
    expect(wakeRequests).toHaveLength(2);
    expect(wakeRequests.map((row) => row.idempotencyKey)).toContain(newIntent.idempotencyKey);
  });

  it("serializes concurrent blocked-create owner notifications", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const acceptedWakeup = acceptedBlockedOwnerWakeup(companyId);
    let attempts = 0;
    const app = createApp({
      blockedOwnerEnqueueWakeup: async (...args) => {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return acceptedWakeup(...args);
      },
    });
    const payload = {
      title: "Serialize blocked owner notification",
      status: "blocked",
      idempotencyKey: "run-1:concurrent-blocked-root",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the finding" },
    };

    const [first, second] = await Promise.all([
      request(app).post(`/api/companies/${companyId}/issues`).send(payload),
      request(app).post(`/api/companies/${companyId}/issues`).send(payload),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(attempts).toBe(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
    expect(await db.select().from(issues)).toHaveLength(1);
  });

  it("mints an unblock-owner wake when a child issue is created blocked", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const owner = await seedAgent(companyId);
    const app = createApp({ blockedOwnerEnqueueWakeup: acceptedBlockedOwnerWakeup(companyId) });

    const response = await request(app)
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Review a blocked child",
        status: "blocked",
        unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the child finding" },
      })
      .expect(201);

    const [persisted] = await db.select().from(issues).where(eq(issues.id, response.body.id));
    expect(persisted).toMatchObject({
      status: "blocked",
      blockedTransitionAt: expect.any(Date),
      blockedOwnerNotifiedAt: expect.any(Date),
    });
    const wakeRequests = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, owner.id));
    const intent = buildAgentUnblockWakeIntent(persisted)!;
    expect(wakeRequests).toHaveLength(1);
    expect(wakeRequests[0]).toMatchObject({
      reason: "issue_unblock_requested",
      payload: intent.payload,
      idempotencyKey: intent.idempotencyKey,
    });
  });

  it("recovers a committed blocked child after scheduling throws", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const owner = await seedAgent(companyId);
    const acceptedWakeup = acceptedBlockedOwnerWakeup(companyId);
    let attempts = 0;
    const app = createApp({
      blockedOwnerEnqueueWakeup: async (...args) => {
        attempts += 1;
        if (attempts === 1) throw new Error("scheduler unavailable");
        return acceptedWakeup(...args);
      },
    });
    const payload = {
      title: "Recover failed blocked child",
      status: "blocked",
      idempotencyKey: "run-1:failed-blocked-child",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the child" },
    };

    const pending = await request(app)
      .post(`/api/issues/${parent.id}/children`)
      .send(payload)
      .expect(202);
    expect(pending.body).toMatchObject({ notificationPending: true });
    const committed = await db
      .select()
      .from(issues)
      .where(eq(issues.title, payload.title))
      .then((rows) => rows[0]);
    expect(committed).toMatchObject({ parentId: parent.id, blockedOwnerNotifiedAt: null });

    const replay = await request(app)
      .post(`/api/issues/${parent.id}/children`)
      .send(payload)
      .expect(200);
    expect(replay.body).toMatchObject({
      id: committed.id,
      deduplicated: true,
      deduplicationReason: "idempotency_key",
      blockedOwnerNotifiedAt: expect.any(String),
    });
    expect(attempts).toBe(2);
    expect(await db.select().from(issues)).toHaveLength(2);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });

  it("keeps a replayed child notification pending when stale-marker repair throws", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const owner = await seedAgent(companyId);
    const payload = {
      title: "Retry a stale blocked child marker",
      status: "blocked",
      idempotencyKey: "run-1:stale-blocked-child",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the child" },
    };
    const acceptedApp = createApp({ blockedOwnerEnqueueWakeup: acceptedBlockedOwnerWakeup(companyId) });
    const created = await request(acceptedApp)
      .post(`/api/issues/${parent.id}/children`)
      .send(payload)
      .expect(201);

    await db
      .update(agentWakeupRequests)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.agentId, owner.id));
    let attempts = 0;
    const failingApp = createApp({
      blockedOwnerEnqueueWakeup: async () => {
        attempts += 1;
        throw new Error("scheduler remains unavailable");
      },
    });

    const replay = await request(failingApp)
      .post(`/api/issues/${parent.id}/children`)
      .send(payload)
      .expect(202);

    expect(replay.body).toMatchObject({
      id: created.body.id,
      deduplicated: true,
      deduplicationReason: "idempotency_key",
      notificationPending: true,
      blockedOwnerNotifiedAt: null,
    });
    const persisted = await db
      .select({ blockedOwnerNotifiedAt: issues.blockedOwnerNotifiedAt })
      .from(issues)
      .where(eq(issues.id, created.body.id))
      .then((rows) => rows[0]);
    expect(persisted?.blockedOwnerNotifiedAt).toBeNull();
    expect(attempts).toBe(1);
  });

  it("does not let a cross-parent child key mutate blocker relations", async () => {
    const companyId = await seedCompany();
    const owner = await seedAgent(companyId);
    const firstParent = await seedParent(companyId);
    const secondParent = await seedParent(companyId);
    await issueService(db).create(companyId, {
      title: "Existing keyed child",
      parentId: firstParent.id,
      status: "blocked",
      idempotencyKey: "cross-parent-child-key",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review this" },
    });
    const app = createApp({ blockedOwnerEnqueueWakeup: acceptedBlockedOwnerWakeup(companyId) });

    await request(app)
      .post(`/api/issues/${secondParent.id}/children`)
      .send({
        title: "Cross-parent replay",
        idempotencyKey: "cross-parent-child-key",
        blockParentUntilDone: true,
      })
      .expect(409);

    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, secondParent.id));
    expect(blockerRelations).toHaveLength(0);
  });

  it("authorizes a same-parent deduplicated child before blocker mutation", async () => {
    const companyId = await seedCompany();
    const actor = await seedAgent(companyId);
    const unrelatedOwner = await seedAgent(companyId);
    const parent = await seedParent(companyId, actor.id);
    const token = await seedAgentKey(companyId, actor.id);
    await issueService(db).create(companyId, {
      title: "Existing unauthorized child",
      parentId: parent.id,
      status: "blocked",
      idempotencyKey: "same-parent-child-key",
      unblockDescriptor: { owner: { agentId: unrelatedOwner.id }, action: "Review this" },
    });
    const app = createApp({ blockedOwnerEnqueueWakeup: acceptedBlockedOwnerWakeup(companyId) });

    await request(app)
      .post(`/api/issues/${parent.id}/children`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Same-parent replay",
        idempotencyKey: "same-parent-child-key",
        blockParentUntilDone: true,
      })
      .expect(403);

    expect(await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, parent.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("repairs the 25th child by idempotent replay without reapplying the cap", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const owner = await seedAgent(companyId);
    for (let index = 0; index < 24; index += 1) {
      await issueService(db).create(companyId, {
        title: `Existing child ${index}`,
        parentId: parent.id,
      });
    }
    const acceptedWakeup = acceptedBlockedOwnerWakeup(companyId);
    let attempts = 0;
    const app = createApp({
      blockedOwnerEnqueueWakeup: async (...args) => {
        attempts += 1;
        if (attempts === 1) throw new Error("scheduler unavailable");
        return acceptedWakeup(...args);
      },
    });
    const payload = {
      title: "Twenty-fifth blocked child",
      status: "blocked",
      idempotencyKey: "twenty-fifth-child",
      unblockDescriptor: { owner: { agentId: owner.id }, action: "Review this" },
    };

    const pending = await request(app)
      .post(`/api/issues/${parent.id}/children`)
      .send(payload)
      .expect(202);
    const replay = await request(app)
      .post(`/api/issues/${parent.id}/children`)
      .send(payload)
      .expect(200);

    expect(replay.body).toMatchObject({ id: pending.body.id, deduplicated: true });
    const childIssues = await db.select().from(issues).where(eq(issues.parentId, parent.id));
    expect(childIssues).toHaveLength(25);
    expect(attempts).toBe(2);
  });

  it("rejects an unrelated agent as a blocked child owner before creation", async () => {
    const companyId = await seedCompany();
    const actorAgent = await seedAgent(companyId);
    const unrelatedOwner = await seedAgent(companyId);
    const parent = await seedParent(companyId, actorAgent.id);
    const token = await seedAgentKey(companyId, actorAgent.id);
    const app = createApp({ blockedOwnerEnqueueWakeup: acceptedBlockedOwnerWakeup(companyId) });

    const response = await request(app)
      .post(`/api/issues/${parent.id}/children`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Attempt unrelated owner routing",
        status: "blocked",
        unblockDescriptor: { owner: { agentId: unrelatedOwner.id }, action: "Review this" },
      })
      .expect(403);

    expect(response.body.error).toBe(
      "Agents may only name themselves or a reporting-line manager as an unblock owner",
    );
    expect(await db.select().from(issues)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("allows an agent to name its reporting-line manager as a blocked child owner", async () => {
    const companyId = await seedCompany();
    const manager = await seedAgent(companyId);
    const report = await seedAgent(companyId, manager.id);
    const parent = await seedParent(companyId, report.id);
    const token = await seedAgentKey(companyId, report.id);
    const app = createApp({ blockedOwnerEnqueueWakeup: acceptedBlockedOwnerWakeup(companyId) });

    const response = await request(app)
      .post(`/api/issues/${parent.id}/children`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Escalate to reporting-line manager",
        status: "blocked",
        unblockDescriptor: { owner: { agentId: manager.id }, action: "Review this" },
      })
      .expect(201);

    expect(response.body).toMatchObject({
      status: "blocked",
      blockedOwnerNotifiedAt: expect.any(String),
    });
    const wakeRequests = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, manager.id));
    expect(wakeRequests).toHaveLength(1);
    expect(wakeRequests[0]).toMatchObject({ reason: "issue_unblock_requested" });
  });

  it("does not reuse a same-title persisted child during accepted-plan decomposition", async () => {
    const companyId = await seedCompany();
    const actorAgent = await seedAgent(companyId);
    const unrelatedOwner = await seedAgent(companyId);
    const sourceIssue = await seedParent(companyId, actorAgent.id);
    const token = await seedAgentKey(companyId, actorAgent.id);
    const acceptedPlanRevisionId = await seedAcceptedPlanRevision(companyId, sourceIssue.id);
    const existingChild = await issueService(db).create(companyId, {
      title: "Same plan child title",
      parentId: sourceIssue.id,
      status: "blocked",
      unblockDescriptor: { owner: { agentId: unrelatedOwner.id }, action: "Privileged review" },
    });
    const app = createApp({ blockedOwnerEnqueueWakeup: acceptedBlockedOwnerWakeup(companyId) });

    const response = await request(app)
      .post(`/api/issues/${sourceIssue.id}/accepted-plan-decompositions`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        acceptedPlanRevisionId,
        children: [{ title: "Same plan child title" }],
      })
      .expect(200);

    expect(response.body.childIssueIds).toHaveLength(1);
    expect(response.body.childIssueIds[0]).not.toBe(existingChild.id);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("recovers an accepted-plan child notification on decomposition replay", async () => {
    const companyId = await seedCompany();
    const sourceIssue = await seedParent(companyId);
    const owner = await seedAgent(companyId);
    const acceptedPlanRevisionId = await seedAcceptedPlanRevision(companyId, sourceIssue.id);
    const acceptedWakeup = acceptedBlockedOwnerWakeup(companyId);
    let attempts = 0;
    const app = createApp({
      blockedOwnerEnqueueWakeup: async (...args) => {
        attempts += 1;
        return attempts === 1 ? null : acceptedWakeup(...args);
      },
    });
    const payload = {
      acceptedPlanRevisionId,
      children: [{
        title: "Review accepted-plan finding",
        status: "blocked",
        unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the plan finding" },
      }],
    };

    const first = await request(app)
      .post(`/api/issues/${sourceIssue.id}/accepted-plan-decompositions`)
      .send(payload)
      .expect(200);
    expect(first.body.newlyCreatedChildIssueIds).toHaveLength(1);
    const childIssueId = first.body.childIssueIds[0] as string;
    const childAfterFirstAttempt = await db
      .select()
      .from(issues)
      .where(eq(issues.id, childIssueId))
      .then((rows) => rows[0]);
    expect(childAfterFirstAttempt.blockedOwnerNotifiedAt).toBeNull();

    const replay = await request(app)
      .post(`/api/issues/${sourceIssue.id}/accepted-plan-decompositions`)
      .send(payload)
      .expect(200);
    expect(replay.body).toMatchObject({
      childIssueIds: [childIssueId],
      newlyCreatedChildIssueIds: [],
    });
    const childAfterReplay = await db
      .select()
      .from(issues)
      .where(eq(issues.id, childIssueId))
      .then((rows) => rows[0]);
    expect(childAfterReplay.blockedOwnerNotifiedAt).toEqual(expect.any(Date));
    expect(attempts).toBe(2);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
    expect(await db.select().from(issues)).toHaveLength(2);
  });

  it("falls back to an assignee wake when an accepted-plan child owner scheduler rejects", async () => {
    const companyId = await seedCompany();
    const sourceIssue = await seedParent(companyId);
    const owner = await seedAgent(companyId);
    const acceptedPlanRevisionId = await seedAcceptedPlanRevision(companyId, sourceIssue.id);
    const app = createApp({
      blockedOwnerEnqueueWakeup: async () => {
        throw new Error("canonical unblock scheduler unavailable");
      },
    });

    const response = await request(app)
      .post(`/api/issues/${sourceIssue.id}/accepted-plan-decompositions`)
      .send({
        acceptedPlanRevisionId,
        children: [{
          title: "Fallback after accepted-plan owner scheduler failure",
          status: "blocked",
          assigneeAgentId: owner.id,
          unblockDescriptor: { owner: { agentId: owner.id }, action: "Review the plan finding" },
        }],
      })
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const wakeRequests = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, owner.id));

    expect(response.body.newlyCreatedChildIssueIds).toHaveLength(1);
    expect(wakeRequests).toEqual([{ reason: "issue_assigned" }]);
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
  });

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
