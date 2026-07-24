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
  issueInboxArchives,
  issues,
  principalPermissionGrants,
  userInboxAgentPolicies,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("inbox archive routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbox-archive-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(userInboxAgentPolicies);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  async function seed(input: { lowTrust?: boolean } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const responsibleUserId = `user-${randomUUID()}`;
    const targetUserId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: `Inbox ${companyId}`,
      issuePrefix: `IA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(authUsers).values([
      {
        id: responsibleUserId,
        name: "Responsible",
        email: `${responsibleUserId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: targetUserId,
        name: "Target",
        email: `${targetUserId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "user",
        principalId: responsibleUserId,
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId,
        principalType: "user",
        principalId: targetUserId,
        status: "active",
        membershipRole: "operator",
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "InboxAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: input.lowTrust
        ? {
            trustPreset: LOW_TRUST_REVIEW_PRESET,
            authorizationPolicy: {
              trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId },
            },
          }
        : {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      responsibleUserId,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Archive me",
      status: "todo",
      priority: "medium",
      createdByUserId: responsibleUserId,
    });
    return { companyId, agentId, runId, issueId, responsibleUserId, targetUserId };
  }

  function agentActor(seed: Awaited<ReturnType<typeof seed>>): Express.Request["actor"] {
    return {
      type: "agent",
      source: "agent_jwt",
      agentId: seed.agentId,
      companyId: seed.companyId,
      runId: seed.runId,
      onBehalfOfUserId: seed.responsibleUserId,
      onBehalfOfMemberships: [{
        companyId: seed.companyId,
        membershipRole: "operator",
        status: "active",
      }],
    };
  }

  it("preserves board idempotency and returns the resolved user", async () => {
    const seeded = await seed();
    const app = appFor({
      type: "board",
      source: "session",
      userId: seeded.responsibleUserId,
      companyIds: [seeded.companyId],
      memberships: [{ companyId: seeded.companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: false,
    });

    const first = await request(app).post(`/api/issues/${seeded.issueId}/inbox-archive`).send({}).expect(200);
    const second = await request(app).post(`/api/issues/${seeded.issueId}/inbox-archive`).send({}).expect(200);
    expect(first.body).toMatchObject({ userId: seeded.responsibleUserId, archivedByActorType: "user" });
    expect(second.body.id).toBe(first.body.id);
    expect(await db.select().from(issueInboxArchives)).toHaveLength(1);

    await request(app).delete(`/api/issues/${seeded.issueId}/inbox-archive`).send({}).expect(200);
    await request(app)
      .delete(`/api/issues/${seeded.issueId}/inbox-archive`)
      .send({})
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({ ok: true, userId: seeded.responsibleUserId }));
  });

  it("archives for the responsible user with agent/run attribution and resurfaces after new activity", async () => {
    const seeded = await seed();
    const app = appFor(agentActor(seeded));

    await request(app)
      .post(`/api/issues/${seeded.issueId}/inbox-archive`)
      .send({})
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        userId: seeded.responsibleUserId,
        archivedByActorType: "agent",
        archivedByAgentId: seeded.agentId,
        archivedByRunId: seeded.runId,
      }));

    const [audit] = await db.select().from(activityLog);
    expect(audit).toMatchObject({
      action: "issue.inbox_archived",
      actorType: "agent",
      agentId: seeded.agentId,
      runId: seeded.runId,
      details: {
        userId: seeded.responsibleUserId,
        targetResolvedFrom: "responsible_user",
        policyMode: "open",
      },
    });

    const archivedList = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ touchedByUserId: seeded.responsibleUserId })
      .expect(200);
    expect(archivedList.body[0]).toMatchObject({
      id: seeded.issueId,
      archivedByActorType: "agent",
      archivedByAgentId: seeded.agentId,
      archivedByRunId: seeded.runId,
    });

    const boardApp = appFor({
      type: "board",
      source: "session",
      userId: seeded.responsibleUserId,
      companyIds: [seeded.companyId],
      memberships: [{ companyId: seeded.companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: false,
    });
    await request(boardApp)
      .get(`/api/issues/${seeded.issueId}`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        id: seeded.issueId,
        archivedAt: expect.any(String),
        archivedByActorType: "agent",
        archivedByAgentId: seeded.agentId,
        archivedByRunId: seeded.runId,
      }));

    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorUserId: seeded.targetUserId,
      body: "New work arrived",
      createdAt: new Date(Date.now() + 1000),
      updatedAt: new Date(Date.now() + 1000),
    });
    const resurfaced = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({
        touchedByUserId: seeded.responsibleUserId,
        inboxArchivedByUserId: seeded.responsibleUserId,
      })
      .expect(200);
    expect(resurfaced.body[0]).toMatchObject({ id: seeded.issueId });
    expect(resurfaced.body[0].archivedByAgentId).toBeUndefined();
    await request(boardApp)
      .get(`/api/issues/${seeded.issueId}`)
      .expect(200)
      .expect(({ body }) => expect(body.archivedByAgentId).toBeUndefined());
  });

  it("returns stable typed denials for unresolved, disabled, allowlist, and low-trust actors", async () => {
    const unresolved = await seed();
    const unresolvedActor = agentActor(unresolved);
    unresolvedActor.onBehalfOfUserId = null;
    unresolvedActor.onBehalfOfMemberships = [];
    await request(appFor(unresolvedActor))
      .post(`/api/issues/${unresolved.issueId}/inbox-archive`)
      .send({})
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe("inbox_target_user_unresolved"));

    const disabled = await seed();
    await db.insert(userInboxAgentPolicies).values({
      companyId: disabled.companyId,
      userId: disabled.responsibleUserId,
      mode: "disabled",
    });
    await request(appFor(agentActor(disabled)))
      .post(`/api/issues/${disabled.issueId}/inbox-archive`)
      .send({})
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe("inbox_management_disabled"));

    const allowlist = await seed();
    await db.insert(userInboxAgentPolicies).values({
      companyId: allowlist.companyId,
      userId: allowlist.responsibleUserId,
      mode: "allowlist",
      allowedAgentIds: [],
    });
    await request(appFor(agentActor(allowlist)))
      .post(`/api/issues/${allowlist.issueId}/inbox-archive`)
      .send({})
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe("inbox_agent_not_allowed"));
    await db
      .update(userInboxAgentPolicies)
      .set({ allowedAgentIds: [allowlist.agentId] })
      .where(eq(userInboxAgentPolicies.companyId, allowlist.companyId));
    await request(appFor(agentActor(allowlist)))
      .post(`/api/issues/${allowlist.issueId}/inbox-archive`)
      .send({})
      .expect(200);

    const lowTrust = await seed({ lowTrust: true });
    await request(appFor(agentActor(lowTrust)))
      .post(`/api/issues/${lowTrust.issueId}/inbox-archive`)
      .send({})
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe("inbox_agent_not_allowed"));
  });

  it("requires a scoped grant for cross-user archive and unarchive", async () => {
    const seeded = await seed();
    const app = appFor(agentActor(seeded));

    await request(app)
      .post(`/api/issues/${seeded.issueId}/inbox-archive`)
      .send({ userId: seeded.targetUserId })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe("inbox_cross_user_grant_required"));

    await db.insert(companyMemberships).values({
      companyId: seeded.companyId,
      principalType: "agent",
      principalId: seeded.agentId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: seeded.companyId,
      principalType: "agent",
      principalId: seeded.agentId,
      permissionKey: "inbox:manage",
      scope: { userIds: [seeded.targetUserId] },
    });
    await db.insert(userInboxAgentPolicies).values({
      companyId: seeded.companyId,
      userId: seeded.targetUserId,
      mode: "disabled",
    });

    await request(app)
      .post(`/api/issues/${seeded.issueId}/inbox-archive`)
      .send({ userId: seeded.targetUserId })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ userId: seeded.targetUserId }));
    await request(app)
      .delete(`/api/issues/${seeded.issueId}/inbox-archive`)
      .send({ userId: seeded.targetUserId })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ userId: seeded.targetUserId }));

    const auditRows = await db.select().from(activityLog);
    expect(auditRows.find((row) => row.action === "issue.inbox_unarchived")).toMatchObject({
      actorType: "agent",
      agentId: seeded.agentId,
      runId: seeded.runId,
    });
    expect(auditRows.map((row) => row.details)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userId: seeded.targetUserId,
        targetResolvedFrom: "explicit",
        policyMode: "grant_override",
      }),
    ]));
  });
});
