import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  crossCompanyAgentGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR, TWX_CROSS_COMPANY_SOURCE_COMPANY_ID } from "../services/cross-company-agent-grants.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
const TEST_SOURCE_COMPANY_ID = "11111111-1111-4111-8111-111111111111";

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
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

async function seedCompany(db: Db, id: string | undefined, label: string) {
  return db
    .insert(companies)
    .values({
      ...(id ? { id } : {}),
      name: `Grant Routes ${label} ${randomUUID()}`,
      issuePrefix: `CG${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedAgent(db: Db, companyId: string, label: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${label} ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("cross-company agent grant admin routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousAllowedSourceCompanyIds =
    process.env[CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-company-grant-routes-");
    db = createDb(tempDb.connectionString);
    process.env[CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR] = TEST_SOURCE_COMPANY_ID;
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(crossCompanyAgentGrants);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousAllowedSourceCompanyIds === undefined) {
      delete process.env[CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR];
    } else {
      process.env[CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR] =
        previousAllowedSourceCompanyIds;
    }
    await tempDb?.cleanup();
  });

  it("lets instance-admin board actors create, list, and revoke cross-company read grants", async () => {
    const sourceCompany = await seedCompany(db, TEST_SOURCE_COMPANY_ID, "Source");
    const targetCompany = await seedCompany(db, undefined, "Target");
    const sourceAgent = await seedAgent(db, sourceCompany.id, "Source");
    const app = await createApp(db, {
      type: "board",
      userId: "admin-user",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const createRes = await request(app)
      .post("/api/admin/cross-company-agent-grants")
      .send({
        sourceCompanyId: sourceCompany.id,
        principalId: sourceAgent.id,
        targetCompanyId: targetCompany.id,
        capability: "read",
      });

    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    expect(createRes.body).toMatchObject({
      sourceCompanyId: sourceCompany.id,
      principalId: sourceAgent.id,
      targetCompanyId: targetCompany.id,
      capability: "read",
      status: "active",
    });

    const listRes = await request(app)
      .get("/api/admin/cross-company-agent-grants")
      .query({ sourceCompanyId: sourceCompany.id, targetCompanyId: targetCompany.id });
    expect(listRes.status, JSON.stringify(listRes.body)).toBe(200);
    expect(listRes.body.grants).toEqual([
      expect.objectContaining({
        id: createRes.body.id,
        sourceCompanyId: sourceCompany.id,
        targetCompanyId: targetCompany.id,
        principalId: sourceAgent.id,
        status: "active",
      }),
    ]);

    const revokeRes = await request(app)
      .post("/api/admin/cross-company-agent-grants/revoke")
      .send({ grantId: createRes.body.id });
    expect(revokeRes.status, JSON.stringify(revokeRes.body)).toBe(200);
    expect(revokeRes.body).toMatchObject({
      id: createRes.body.id,
      status: "revoked",
    });

    const stored = await db
      .select()
      .from(crossCompanyAgentGrants)
      .where(eq(crossCompanyAgentGrants.id, createRes.body.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("revoked");
    expect(stored.revokedByUserId).toBe("admin-user");

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          inArray(activityLog.companyId, [sourceCompany.id, targetCompany.id]),
          eq(activityLog.entityId, createRes.body.id),
        ),
      );
    expect(activityRows.map((row) => row.action).sort()).toEqual([
      "cross_company_agent_grant.created",
      "cross_company_agent_grant.created",
      "cross_company_agent_grant.revoked",
      "cross_company_agent_grant.revoked",
    ]);
  }, 15_000);

  it("rejects non-instance-admin board actors", async () => {
    const sourceCompany = await seedCompany(db, TEST_SOURCE_COMPANY_ID, "SourceDenied");
    const targetCompany = await seedCompany(db, undefined, "TargetDenied");
    const sourceAgent = await seedAgent(db, sourceCompany.id, "Denied");
    const app = await createApp(db, {
      type: "board",
      userId: "operator-user",
      source: "session",
      companyIds: [sourceCompany.id],
      memberships: [{ companyId: sourceCompany.id, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/admin/cross-company-agent-grants")
      .send({
        sourceCompanyId: sourceCompany.id,
        principalId: sourceAgent.id,
        targetCompanyId: targetCompany.id,
        capability: "read",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin");
  }, 15_000);
});
