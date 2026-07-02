import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  issueInboxArchives,
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
    `Skipping embedded Postgres issue delete route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue delete routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-delete-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueInboxArchives);
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

  it("deletes an archived issue and clears inbox archive rows", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Delete test tenant",
      issuePrefix: "DEL",
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 12,
      identifier: "DEL-12",
      title: "Archived routine cleanup candidate",
      status: "done",
      priority: "medium",
      createdByUserId: "cloud-user-1",
    });
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId,
      userId: "cloud-user-1",
      archivedAt: new Date("2026-06-30T05:51:12.211Z"),
    });

    const app = createApp(companyId);
    const res = await request(app).delete(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: issueId,
      companyId,
      identifier: "DEL-12",
    });

    const remainingIssue = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(remainingIssue).toBeNull();

    const remainingArchive = await db
      .select({ id: issueInboxArchives.id })
      .from(issueInboxArchives)
      .where(eq(issueInboxArchives.issueId, issueId))
      .then((rows) => rows[0] ?? null);
    expect(remainingArchive).toBeNull();
  });
});
