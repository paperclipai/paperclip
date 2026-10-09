import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  userInboxAgentPolicies,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { inboxAgentPolicyRoutes } from "../routes/inbox-agent-policy.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("inbox agent policy routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbox-agent-policy-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
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
    app.use(inboxAgentPolicyRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const otherUserId = `user-${randomUUID()}`;
    const agentId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: `Policy ${companyId}`,
      issuePrefix: `IP${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(authUsers).values([
      {
        id: userId,
        name: "User",
        email: `${userId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherUserId,
        name: "Other",
        email: `${otherUserId}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId,
        principalType: "user",
        principalId: otherUserId,
        status: "active",
        membershipRole: "operator",
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Allowed agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, userId, otherUserId, agentId };
  }

  function boardActor(companyId: string, userId: string): Express.Request["actor"] {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: false,
    };
  }

  it("returns the open default and lets users update their own policy", async () => {
    const seeded = await seed();
    const app = appFor(boardActor(seeded.companyId, seeded.userId));

    await request(app)
      .get(`/companies/${seeded.companyId}/users/me/inbox-agent-policy`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        companyId: seeded.companyId,
        userId: seeded.userId,
        mode: "open",
        allowedAgentIds: [],
        materialized: false,
      }));

    await request(app)
      .put(`/companies/${seeded.companyId}/users/me/inbox-agent-policy`)
      .send({ mode: "allowlist", allowedAgentIds: [seeded.agentId] })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        mode: "allowlist",
        allowedAgentIds: [seeded.agentId],
        materialized: true,
      }));

    const [audit] = await db.select().from(activityLog);
    expect(audit).toMatchObject({
      action: "inbox.agent_policy_updated",
      actorType: "user",
      entityType: "user_inbox_agent_policy",
      entityId: seeded.userId,
      details: {
        userId: seeded.userId,
        previousMode: "open",
        mode: "allowlist",
        allowedAgentIds: [seeded.agentId],
      },
    });
  });

  it("gates the admin variant with users:manage_permissions", async () => {
    const seeded = await seed();
    const actor = boardActor(seeded.companyId, seeded.userId);
    const app = appFor(actor);

    await request(app)
      .put(`/companies/${seeded.companyId}/users/${seeded.otherUserId}/inbox-agent-policy`)
      .send({ mode: "disabled", allowedAgentIds: [] })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe("inbox_agent_policy_admin_required"));

    await db.insert(principalPermissionGrants).values({
      companyId: seeded.companyId,
      principalType: "user",
      principalId: seeded.userId,
      permissionKey: "users:manage_permissions",
    });

    await request(app)
      .put(`/companies/${seeded.companyId}/users/${seeded.otherUserId}/inbox-agent-policy`)
      .send({ mode: "disabled", allowedAgentIds: [] })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        userId: seeded.otherUserId,
        mode: "disabled",
        allowedAgentIds: [],
      }));
  });

  it("rejects admin policies for users without an active company membership", async () => {
    const seeded = await seed();
    const actor = boardActor(seeded.companyId, seeded.userId);
    await db.insert(principalPermissionGrants).values({
      companyId: seeded.companyId,
      principalType: "user",
      principalId: seeded.userId,
      permissionKey: "users:manage_permissions",
    });

    await request(appFor(actor))
      .put(`/companies/${seeded.companyId}/users/user-missing/inbox-agent-policy`)
      .send({ mode: "disabled", allowedAgentIds: [] })
      .expect(404);
  });

  it("rejects agent IDs outside allowlist mode", async () => {
    const seeded = await seed();
    await request(appFor(boardActor(seeded.companyId, seeded.userId)))
      .put(`/companies/${seeded.companyId}/users/me/inbox-agent-policy`)
      .send({ mode: "disabled", allowedAgentIds: [seeded.agentId] })
      .expect(400);
  });

  it("rejects allowlist agents from another company", async () => {
    const seeded = await seed();
    await request(appFor(boardActor(seeded.companyId, seeded.userId)))
      .put(`/companies/${seeded.companyId}/users/me/inbox-agent-policy`)
      .send({ mode: "allowlist", allowedAgentIds: [randomUUID()] })
      .expect(422)
      .expect(({ body }) => expect(body.code).toBe("inbox_agent_policy_invalid_agents"));
  });
});
