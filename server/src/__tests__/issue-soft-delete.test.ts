import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

// Regression coverage for AGE-770 / AGE-743: DELETE /issues/:id must soft-delete
// (set deleted_at) instead of hard-deleting the row, because issue creation
// mints the next issue_number/identifier from MAX(issue_number) across *all*
// issues for the company (including soft-deleted ones). Hard-deleting a row
// drops it out of that MAX() and lets a brand-new issue be minted with an
// identifier a merged/open PR may already cite in its title or body.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue soft-delete tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue soft delete (AGE-770)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-soft-delete-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

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

  async function seedCompanyOwner(companyId: string) {
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

  async function setupCompany(issuePrefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Soft delete test ${issuePrefix}`,
      issuePrefix,
      issueCounter: 0,
      requireBoardApprovalForNewAgents: false,
    });
    await seedCompanyOwner(companyId);
    return companyId;
  }

  it("DELETE sets deleted_at instead of removing the row", async () => {
    const issuePrefix = `SD${randomUUID().slice(0, 4).toUpperCase()}`;
    const companyId = await setupCompany(issuePrefix);
    const app = createApp(companyId);

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "First issue", status: "backlog" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id as string;
    const identifier = created.body.identifier as string;

    const deleted = await request(app).delete(`/api/issues/${issueId}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.deletedAt).toBeTruthy();

    const row = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(row, "row must still exist after DELETE").not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.identifier).toBe(identifier);
  });

  it("a new issue created after a delete does not reuse the deleted issue's number", async () => {
    const issuePrefix = `SD${randomUUID().slice(0, 4).toUpperCase()}`;
    const companyId = await setupCompany(issuePrefix);
    const app = createApp(companyId);

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "To be deleted", status: "backlog" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstIssueNumber = first.body.issueNumber as number;

    const deleteRes = await request(app).delete(`/api/issues/${first.body.id}`);
    expect(deleteRes.status, JSON.stringify(deleteRes.body)).toBe(200);

    const second = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Created after delete", status: "backlog" });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const secondIssueNumber = second.body.issueNumber as number;

    expect(secondIssueNumber).toBe(firstIssueNumber + 1);
    expect(second.body.identifier).not.toBe(first.body.identifier);
  });

  it("a deleted issue still resolves by identifier for provenance lookups", async () => {
    const issuePrefix = `SD${randomUUID().slice(0, 4).toUpperCase()}`;
    const companyId = await setupCompany(issuePrefix);
    const app = createApp(companyId);

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Cited by a PR", status: "backlog" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const identifier = created.body.identifier as string;

    const deleteRes = await request(app).delete(`/api/issues/${created.body.id}`);
    expect(deleteRes.status, JSON.stringify(deleteRes.body)).toBe(200);

    const lookup = await request(app).get(`/api/issues/${identifier.toLowerCase()}`);
    expect(lookup.status, JSON.stringify(lookup.body)).toBe(200);
    expect(lookup.body).toMatchObject({
      identifier,
      id: created.body.id,
    });
    expect(lookup.body.deletedAt).toBeTruthy();
  });

  it("a deleted issue is excluded from the default issue list", async () => {
    const issuePrefix = `SD${randomUUID().slice(0, 4).toUpperCase()}`;
    const companyId = await setupCompany(issuePrefix);
    const app = createApp(companyId);

    const kept = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Kept issue", status: "backlog" });
    expect(kept.status, JSON.stringify(kept.body)).toBe(201);

    const toDelete = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Deleted issue", status: "backlog" });
    expect(toDelete.status, JSON.stringify(toDelete.body)).toBe(201);

    const deleteRes = await request(app).delete(`/api/issues/${toDelete.body.id}`);
    expect(deleteRes.status, JSON.stringify(deleteRes.body)).toBe(200);

    const list = await request(app).get(`/api/companies/${companyId}/issues`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const listedIds = (Array.isArray(list.body) ? list.body : list.body.issues ?? []).map(
      (row: { id: string }) => row.id,
    );

    expect(listedIds).toContain(kept.body.id);
    expect(listedIds).not.toContain(toDelete.body.id);
  });
});
