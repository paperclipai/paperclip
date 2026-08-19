import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
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
    `Skipping embedded Postgres issue list route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list routes staleHours filter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-stalehours-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
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

  async function seedCloudTenantMember(companyId: string) {
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
  }

  async function seedCompany(companyId: string) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
  }

  it("excludes an issue updated below the staleHours threshold", async () => {
    const companyId = randomUUID();
    const freshIssueId = randomUUID();
    await seedCompany(companyId);
    // Updated 10 hours ago -- below a 100h threshold, must be excluded.
    const recentUpdatedAt = new Date(Date.now() - 10 * 60 * 60 * 1000);
    await db.insert(issues).values({
      id: freshIssueId,
      companyId,
      title: "Recently touched issue",
      status: "todo",
      priority: "medium",
      updatedAt: recentUpdatedAt,
    });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ staleHours: "100", status: "todo,in_progress,in_review,blocked", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([]);
  });

  it("includes an issue with no activity beyond the staleHours threshold", async () => {
    const companyId = randomUUID();
    const staleIssueId = randomUUID();
    await seedCompany(companyId);
    // Updated 200 hours ago -- above a 100h threshold, must be included.
    const oldUpdatedAt = new Date(Date.now() - 200 * 60 * 60 * 1000);
    await db.insert(issues).values({
      id: staleIssueId,
      companyId,
      title: "Untouched issue",
      status: "in_progress",
      priority: "medium",
      updatedAt: oldUpdatedAt,
    });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ staleHours: "100", status: "todo,in_progress,in_review,blocked", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([staleIssueId]);
  });

  it("treats a recent comment as activity, excluding the issue even though updatedAt is old", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await seedCompany(companyId);
    const oldUpdatedAt = new Date(Date.now() - 200 * 60 * 60 * 1000);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Old row, recently commented",
      status: "in_progress",
      priority: "medium",
      updatedAt: oldUpdatedAt,
    });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorType: "user",
      authorUserId: "cloud-user-1",
      body: "still working on this",
      createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
    });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ staleHours: "100", status: "todo,in_progress,in_review,blocked", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([]);
  });

  it("treats a recent non-inbox activity log entry as activity, excluding the issue", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await seedCompany(companyId);
    const oldUpdatedAt = new Date(Date.now() - 200 * 60 * 60 * 1000);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Old row, recently logged",
      status: "in_progress",
      priority: "medium",
      updatedAt: oldUpdatedAt,
    });
    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: "agent-1",
      action: "issue.status_changed",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
    });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ staleHours: "100", status: "todo,in_progress,in_review,blocked", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([]);
  });

  it("rejects a non-positive staleHours with 400", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);

    const app = createApp(companyId);
    const resZero = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ staleHours: "0", limit: "20" });
    expect(resZero.status).toBe(400);
    expect(resZero.body).toMatchObject({ error: "staleHours must be a positive number when provided" });

    const resNegative = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ staleHours: "-5", limit: "20" });
    expect(resNegative.status).toBe(400);

    const resNonNumeric = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ staleHours: "not-a-number", limit: "20" });
    expect(resNonNumeric.status).toBe(400);
  });
});
