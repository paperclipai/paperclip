import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list parent filter route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list routes parentId/descendantOf filters", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-parent-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const prefix = uniqueIssuePrefix();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    return { companyId, prefix };
  }

  async function seedParentWithChild(companyId: string, prefix: string) {
    const parentId = randomUUID();
    const childId = randomUUID();
    const otherId = randomUUID();
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        identifier: `${prefix}-1`,
        title: "Parent issue",
        status: "in_progress",
        priority: "medium",
      },
      {
        id: childId,
        companyId,
        identifier: `${prefix}-2`,
        title: "Child issue",
        status: "todo",
        priority: "medium",
        parentId,
      },
      {
        id: otherId,
        companyId,
        identifier: `${prefix}-3`,
        title: "Unrelated issue",
        status: "todo",
        priority: "medium",
      },
    ]);
    return { parentId, childId };
  }

  it("resolves an issue identifier parentId filter to that parent's children", async () => {
    const { companyId, prefix } = await seedCompany();
    const { childId } = await seedParentWithChild(companyId, prefix);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ parentId: `${prefix}-1`, limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([childId]);
  });

  it("keeps UUID parentId filtering behavior unchanged", async () => {
    const { companyId, prefix } = await seedCompany();
    const { parentId, childId } = await seedParentWithChild(companyId, prefix);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ parentId, limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([childId]);
  });

  it("returns an empty list for an unknown but well-formed parentId identifier", async () => {
    const { companyId, prefix } = await seedCompany();
    await seedParentWithChild(companyId, prefix);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ parentId: `${prefix}-9999`, limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 422 for a parentId that is neither a UUID nor an issue identifier", async () => {
    const { companyId } = await seedCompany();

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ parentId: "2140b", limit: "20" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "parentId must be an issue UUID or identifier",
    });
  });

  it("returns 422 for a malformed descendantOf filter", async () => {
    const { companyId } = await seedCompany();

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ descendantOf: "not-a-ref", limit: "20" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "descendantOf must be an issue UUID or identifier",
    });
  });

  it("resolves identifier filters on the count endpoint and validates malformed ones", async () => {
    const { companyId, prefix } = await seedCompany();
    await seedParentWithChild(companyId, prefix);

    const app = createApp(companyId);

    const malformed = await request(app)
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "blocked", parentId: "2140b" });
    expect(malformed.status).toBe(422);

    const unknown = await request(app)
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "blocked", parentId: `${prefix}-9999` });
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(200);
    expect(unknown.body).toEqual({ count: 0 });
  });
});
