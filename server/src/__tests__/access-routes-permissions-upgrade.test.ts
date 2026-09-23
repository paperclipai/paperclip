import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createApp(
  db: Db,
  companyId: string,
  userId: string,
  actorOverride?: Express.Request["actor"],
) {
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actorOverride ?? {
      type: "board",
      userId,
      source: "local_implicit",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function createCompanyWithOwner(db: Db) {
  const company = await db
    .insert(companies)
    .values({
      name: `Access Routes ${randomUUID()}`,
      issuePrefix: `AR${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  const owner = await db
    .insert(companyMemberships)
    .values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    })
    .returning()
    .then((rows) => rows[0]!);
  return { company, owner };
}

describeEmbeddedPostgres("access routes permissions upgrade compatibility", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-routes-permissions-upgrade-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rejects owner self-lockout through the member route after the permissions upgrade", async () => {
    const { company, owner } = await createCompanyWithOwner(db);

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${owner.id}`)
      .send({ membershipRole: "admin" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("You cannot remove yourself");

    const unchanged = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, owner.id))
      .then((rows) => rows[0]!);
    expect(unchanged.membershipRole).toBe("owner");
  }, 10_000);

  it("keeps custom grants when the role-only member route changes a member role", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const member = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `admin-${randomUUID()}`,
        status: "active",
        membershipRole: "admin",
      })
      .returning()
      .then((rows) => rows[0]!);
    const customScope = { projectIds: ["project-1"] };
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: member.principalId,
      permissionKey: "tasks:assign_scope",
      scope: customScope,
      grantedByUserId: owner.principalId,
    });

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}`)
      .send({ membershipRole: "operator" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.membershipRole).toBe("operator");

    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, company.id),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, member.principalId),
        ),
      );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      permissionKey: "tasks:assign_scope",
      scope: customScope,
      grantedByUserId: owner.principalId,
    });
  });

  it("sets and removes only an exact direct-report config-read grant for an agent manager", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const manager = await db.insert(agents).values({
      companyId: company.id,
      name: `Manager ${randomUUID()}`,
      role: "general",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning().then((rows) => rows[0]!);
    const directReport = await db.insert(agents).values({
      companyId: company.id,
      name: `Direct report ${randomUUID()}`,
      role: "devops",
      reportsTo: manager.id,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning().then((rows) => rows[0]!);
    const unrelatedAgent = await db.insert(agents).values({
      companyId: company.id,
      name: `Unrelated ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: manager.id,
      status: "active",
      membershipRole: "member",
    });

    const app = await createApp(db, company.id, owner.principalId);
    const path = `/api/companies/${company.id}/agents/${manager.id}/direct-report-config-read-grant`;
    const applied = await request(app).put(path).send({ directReportAgentIds: [directReport.id] });

    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({
      permissionKey: "agents:suggest-changes",
      mode: "direct_reports",
      directReportAgentIds: [directReport.id],
    });
    const grant = await db.select().from(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.companyId, company.id),
      eq(principalPermissionGrants.principalType, "agent"),
      eq(principalPermissionGrants.principalId, manager.id),
    )).then((rows) => rows[0]!);
    expect(grant).toMatchObject({
      permissionKey: "agents:suggest-changes",
      scope: { directReportAgentIds: [directReport.id] },
      grantedByUserId: owner.principalId,
    });
    const activity = await db.select().from(activityLog).where(eq(
      activityLog.action,
      "agent.direct_report_config_read_grant.updated",
    )).then((rows) => rows[0]!);
    expect(activity).toMatchObject({ actorType: "user", actorId: owner.principalId });

    const unrelated = await request(app).put(path).send({ directReportAgentIds: [unrelatedAgent.id] });
    expect(unrelated.status, JSON.stringify(unrelated.body)).toBe(400);
    const readBack = await request(app).get(path);
    expect(readBack.status).toBe(200);
    expect(readBack.body.directReportAgentIds).toEqual([directReport.id]);

    const removed = await request(app).put(path).send({ directReportAgentIds: [] });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const afterRemove = await db.select().from(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.companyId, company.id),
      eq(principalPermissionGrants.principalType, "agent"),
      eq(principalPermissionGrants.principalId, manager.id),
    ));
    expect(afterRemove).toHaveLength(0);
  }, 10_000);

  it("rejects an agent with users:manage_permissions from the Board-only grant route", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const manager = await db.insert(agents).values({
      companyId: company.id,
      name: `Manager ${randomUUID()}`,
      role: "general",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning().then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: manager.id,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: manager.id,
      permissionKey: "users:manage_permissions",
      scope: null,
    });

    const app = await createApp(db, company.id, owner.principalId, {
      type: "agent",
      agentId: manager.id,
      companyId: company.id,
      source: "agent_key",
    });
    const path = `/api/companies/${company.id}/agents/${manager.id}/direct-report-config-read-grant`;
    await request(app).get(path).expect(401);
    await request(app).put(path).send({ directReportAgentIds: [] }).expect(401);

    const grants = await db.select().from(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.companyId, company.id),
      eq(principalPermissionGrants.principalType, "agent"),
      eq(principalPermissionGrants.principalId, manager.id),
    ));
    expect(grants).toHaveLength(1);
    expect(grants[0]?.permissionKey).toBe("users:manage_permissions");
    const activity = await db.select().from(activityLog).where(eq(
      activityLog.action,
      "agent.direct_report_config_read_grant.updated",
    ));
    expect(activity).toHaveLength(0);
  }, 10_000);
});
