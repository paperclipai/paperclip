import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  instanceActivityLog,
  instanceUserRoles,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  instanceActorFromRequest,
  logInstanceActivity,
} from "../services/instance-activity-log.js";
import { accessRoutes } from "../routes/access.js";
import { activityRoutes } from "../routes/activity.js";
import { companyRoutes } from "../routes/companies.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describe("instanceActorFromRequest", () => {
  function reqWithActor(actor: Express.Request["actor"]) {
    return { actor } as unknown as express.Request;
  }

  it("models unauthenticated callers as an explicit pre_auth actor", () => {
    expect(instanceActorFromRequest(reqWithActor({ type: "none", source: "none" }))).toEqual({
      actorType: "pre_auth",
      actorId: "unauthenticated",
      actorSource: "unauthenticated",
      agentId: null,
      runId: null,
      responsibleUserId: null,
    });
  });

  it("maps agent actors with run and on-behalf-of attribution", () => {
    const agentId = randomUUID();
    const runId = randomUUID();
    expect(instanceActorFromRequest(reqWithActor({
      type: "agent",
      agentId,
      runId,
      source: "agent_jwt",
      onBehalfOfUserId: "human-1",
    }))).toEqual({
      actorType: "agent",
      actorId: agentId,
      actorSource: "agent_jwt",
      agentId,
      runId,
      responsibleUserId: "human-1",
    });
  });

  it("maps board users and stamps them as responsible", () => {
    expect(instanceActorFromRequest(reqWithActor({
      type: "board",
      userId: "user-1",
      source: "session",
    }))).toMatchObject({
      actorType: "user",
      actorId: "user-1",
      actorSource: "session",
      responsibleUserId: "user-1",
    });
  });
});

describeEmbeddedPostgres("instance activity stream", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-instance-activity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(instanceActivityLog);
    await db.delete(activityLog);
    await db.delete(instanceUserRoles);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const instanceAdminActor: Express.Request["actor"] = {
    type: "board",
    userId: "admin-user",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [],
  };

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api/companies", companyRoutes(db));
    instance.use("/api", instanceSettingsRoutes(db));
    instance.use("/api", activityRoutes(db));
    instance.use("/api", accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name = "Audit Co") {
    const [company] = await db.insert(companies).values({
      name,
      issuePrefix: `A${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    }).returning();
    return company;
  }

  async function instanceRows(action?: string) {
    const rows = await db.select().from(instanceActivityLog);
    return action ? rows.filter((row) => row.action === action) : rows;
  }

  it("logInstanceActivity persists a sanitized row without FK coupling", async () => {
    const orphanCompanyId = randomUUID();
    await logInstanceActivity(db, {
      actorType: "pre_auth",
      actorId: "unauthenticated",
      actorSource: "unauthenticated",
      action: "smoke_lab.oauth_token_issued",
      entityType: "smoke_lab_oauth",
      entityId: orphanCompanyId,
      // No company row exists for this id: the stream must accept it anyway.
      companyId: orphanCompanyId,
      details: { grantType: "authorization_code", accessToken: "super-secret-token" },
    });

    const [row] = await instanceRows();
    expect(row).toMatchObject({
      actorType: "pre_auth",
      actorId: "unauthenticated",
      action: "smoke_lab.oauth_token_issued",
      companyId: orphanCompanyId,
    });
    // Secret-ish detail keys are redacted by the shared sanitizer.
    expect(JSON.stringify(row.details)).not.toContain("super-secret-token");
    expect((row.details as Record<string, unknown>).grantType).toBe("authorization_code");
  });

  it("records company deletion in the instance stream after the company audit trail is purged", async () => {
    const company = await seedCompany("Doomed Co");

    const response = await request(app({
      type: "board",
      userId: "admin-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
    })).delete(`/api/companies/${company.id}`);
    expect(response.status).toBe(200);

    const remaining = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(remaining).toHaveLength(0);

    const [row] = await instanceRows("company.deleted");
    expect(row).toMatchObject({
      actorType: "user",
      actorId: "admin-user",
      responsibleUserId: "admin-user",
      entityType: "company",
      entityId: company.id,
      companyId: company.id,
    });
    expect((row.details as Record<string, unknown>).name).toBe("Doomed Co");
  });

  it("records instance-admin promote and demote", async () => {
    await db.insert(instanceUserRoles).values({ userId: "admin-user", role: "instance_admin" });

    const promote = await request(app(instanceAdminActor))
      .post("/api/admin/users/target-user/promote-instance-admin");
    expect(promote.status).toBe(201);

    const demote = await request(app(instanceAdminActor))
      .post("/api/admin/users/target-user/demote-instance-admin");
    expect(demote.status).toBe(200);

    const promoted = await instanceRows("instance_admin.promoted");
    const demoted = await instanceRows("instance_admin.demoted");
    expect(promoted).toHaveLength(1);
    expect(demoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({
      actorType: "user",
      actorId: "admin-user",
      entityType: "user",
      entityId: "target-user",
    });
  });

  it("still audits instance settings updates when the instance has zero companies", async () => {
    const response = await request(app(instanceAdminActor))
      .patch("/api/instance/settings/general")
      .send({ keyboardShortcuts: false });
    expect(response.status).toBe(200);

    // Zero companies -> the per-company fan-out writes nothing...
    expect(await db.select().from(activityLog)).toHaveLength(0);
    // ...but the instance stream still records the change.
    const rows = await instanceRows("instance.settings.general_updated");
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe("admin-user");
  });

  it("records pre-auth CLI auth challenge creation", async () => {
    const response = await request(app({ type: "none", source: "none" }))
      .post("/api/cli-auth/challenges")
      .send({ clientName: "paperclip-cli", command: "login" });
    expect(response.status).toBe(201);

    const [row] = await instanceRows("cli_auth.challenge_created");
    expect(row).toMatchObject({
      actorType: "pre_auth",
      actorId: "unauthenticated",
      entityType: "cli_auth_challenge",
    });
    expect((row.details as Record<string, unknown>).clientName).toBe("paperclip-cli");
  });

  it("serves the instance stream to instance admins only", async () => {
    await logInstanceActivity(db, {
      actorType: "system",
      actorId: "system",
      action: "instance.database_backup_triggered",
      entityType: "instance_database_backup",
      entityId: "manual",
    });

    const denied = await request(app({
      type: "board",
      userId: "plain-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [],
    })).get("/api/instance/activity");
    expect(denied.status).toBe(403);

    const allowed = await request(app(instanceAdminActor))
      .get("/api/instance/activity")
      .query({ action: "instance.database_backup_triggered" });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toHaveLength(1);
    expect(allowed.body[0].action).toBe("instance.database_backup_triggered");
  });
});
