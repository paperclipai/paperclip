import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, companyMemberships, createDb, issueRelations, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-by update route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue PATCH blockedByIssueIds persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocked-by-routes-");
    db = createDb(tempDb.connectionString);
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
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  let prefixCounter = 0;

  async function seedCompany() {
    const companyId = randomUUID();
    prefixCounter += 1;
    const prefix = `BB${prefixCounter}`;
    await db.insert(companies).values({
      id: companyId,
      name: `Blocked-by tenant ${prefixCounter}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      membershipRole: "owner",
      status: "active",
    });
    return { companyId, prefix };
  }

  async function seedIssue(companyId: string, prefix: string, issueNumber: number, title: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber,
      identifier: `${prefix}-${issueNumber}`,
      title,
      status: "todo",
      priority: "medium",
      createdByUserId: "cloud-user-1",
    });
    return issueId;
  }

  it("persists blockedByIssueIds set via PATCH and surfaces both sides", async () => {
    const { companyId, prefix } = await seedCompany();
    const blockedId = await seedIssue(companyId, prefix, 1, "Blocked issue");
    const blockerId = await seedIssue(companyId, prefix, 2, "Blocker issue");
    const app = createApp(companyId);

    const res = await request(app)
      .patch(`/api/issues/${blockedId}`)
      .send({ blockedByIssueIds: [blockerId] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockedBy?.map((r: { id: string }) => r.id)).toEqual([blockerId]);

    // The edge must exist in the DB.
    const rows = await db
      .select({ issueId: issueRelations.issueId, relatedIssueId: issueRelations.relatedIssueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks")));
    expect(rows).toEqual([{ issueId: blockerId, relatedIssueId: blockedId }]);

    // The other side's `blocks[]` must reflect it on read.
    const blockerRead = await request(app).get(`/api/issues/${blockerId}`);
    expect(blockerRead.status, JSON.stringify(blockerRead.body)).toBe(200);
    expect(blockerRead.body.blocks?.map((r: { id: string }) => r.id)).toEqual([blockedId]);

    const blockedRead = await request(app).get(`/api/issues/${blockedId}`);
    expect(blockedRead.body.blockedBy?.map((r: { id: string }) => r.id)).toEqual([blockerId]);
  });

  it("replacing blockedByIssueIds with a new array removes stale edges", async () => {
    const { companyId, prefix } = await seedCompany();
    const blockedId = await seedIssue(companyId, prefix, 10, "Blocked issue");
    const blockerA = await seedIssue(companyId, prefix, 11, "Blocker A");
    const blockerB = await seedIssue(companyId, prefix, 12, "Blocker B");
    const app = createApp(companyId);

    const first = await request(app)
      .patch(`/api/issues/${blockedId}`)
      .send({ blockedByIssueIds: [blockerA] });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.blockedBy?.map((r: { id: string }) => r.id)).toEqual([blockerA]);

    const second = await request(app)
      .patch(`/api/issues/${blockedId}`)
      .send({ blockedByIssueIds: [blockerB] });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.blockedBy?.map((r: { id: string }) => r.id)).toEqual([blockerB]);

    const rows = await db
      .select({ issueId: issueRelations.issueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.relatedIssueId, blockedId), eq(issueRelations.type, "blocks")));
    expect(rows.map((r) => r.issueId).sort()).toEqual([blockerB].sort());
  });

  it("clearing blockedByIssueIds with an empty array removes all edges", async () => {
    const { companyId, prefix } = await seedCompany();
    const blockedId = await seedIssue(companyId, prefix, 20, "Blocked issue");
    const blockerA = await seedIssue(companyId, prefix, 21, "Blocker A");
    const app = createApp(companyId);

    await request(app).patch(`/api/issues/${blockedId}`).send({ blockedByIssueIds: [blockerA] });
    const cleared = await request(app)
      .patch(`/api/issues/${blockedId}`)
      .send({ blockedByIssueIds: [] });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.blockedBy).toEqual([]);

    const rows = await db
      .select({ issueId: issueRelations.issueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.relatedIssueId, blockedId), eq(issueRelations.type, "blocks")));
    expect(rows).toEqual([]);
  });

  it("rejects dependency cycles with 422", async () => {
    const { companyId, prefix } = await seedCompany();
    const issueA = await seedIssue(companyId, prefix, 30, "Issue A");
    const issueB = await seedIssue(companyId, prefix, 31, "Issue B");
    const app = createApp(companyId);

    const first = await request(app)
      .patch(`/api/issues/${issueA}`)
      .send({ blockedByIssueIds: [issueB] });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const cycle = await request(app)
      .patch(`/api/issues/${issueB}`)
      .send({ blockedByIssueIds: [issueA] });
    expect(cycle.status, JSON.stringify(cycle.body)).toBe(422);
    expect(String(cycle.body.error ?? "")).toContain("Blocking relations cannot contain cycles");
  });
});
