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
    `Skipping embedded Postgres issue list identifier filter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list routes identifier filter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-identifier-");
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

  async function seedCompanyWithIssues(
    issueRows: Array<{ id: string; identifier: string; title: string }>,
  ) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values(
      issueRows.map((row) => ({
        id: row.id,
        companyId,
        identifier: row.identifier,
        title: row.title,
        status: "todo",
        priority: "medium",
      })),
    );
    return companyId;
  }

  it("returns only the issue with the exact identifier", async () => {
    const target = { id: randomUUID(), identifier: "TES-8", title: "Target" };
    const other = { id: randomUUID(), identifier: "TES-88", title: "Other" };
    const companyId = await seedCompanyWithIssues([target, other]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ identifier: "TES-8" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([target.id]);
  });

  it("rejects an empty identifier instead of returning the whole board", async () => {
    const only = { id: randomUUID(), identifier: "TES-1", title: "Only" };
    const companyId = await seedCompanyWithIssues([only]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ identifier: "" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatch(/identifier/);
  });

  it("rejects a whitespace-only identifier", async () => {
    const only = { id: randomUUID(), identifier: "TES-1", title: "Only" };
    const companyId = await seedCompanyWithIssues([only]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ identifier: "   " });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatch(/identifier/);
  });

  it("trims surrounding whitespace from a valid identifier", async () => {
    const target = { id: randomUUID(), identifier: "TES-8", title: "Target" };
    const companyId = await seedCompanyWithIssues([target]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ identifier: "  TES-8  " });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([target.id]);
  });

  it("does not treat the identifier as a prefix", async () => {
    const short = { id: randomUUID(), identifier: "TES-1", title: "Short" };
    const longer = { id: randomUUID(), identifier: "TES-100", title: "Longer" };
    const companyId = await seedCompanyWithIssues([short, longer]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ identifier: "TES-1" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([short.id]);
  });

  it("matches case-insensitively", async () => {
    const target = { id: randomUUID(), identifier: "TES-8", title: "Target" };
    const companyId = await seedCompanyWithIssues([target]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ identifier: "tes-8" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([target.id]);
  });

  it("returns 0 issues for an unknown identifier instead of the whole board", async () => {
    const only = { id: randomUUID(), identifier: "TES-1", title: "Only" };
    const companyId = await seedCompanyWithIssues([only]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ identifier: "TES-999" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("composes with another filter rather than replacing it", async () => {
    const target = { id: randomUUID(), identifier: "TES-8", title: "Target" };
    const companyId = await seedCompanyWithIssues([target]);
    const missingId = randomUUID();

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ identifier: "TES-8", assigneeAgentId: missingId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([]);
  });
});
