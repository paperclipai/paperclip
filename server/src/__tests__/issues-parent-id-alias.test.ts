import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { isNotNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue list parentIssueId query alias", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-parent-id-alias-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues).where(isNotNull(issues.parentId));
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(companyId: string, userId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "session",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "operator", status: "active" }],
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const parentId = randomUUID();
    const otherParentId = randomUUID();
    const childId = randomUUID();
    const otherChildId = randomUUID();
    const blockedChildId = randomUUID();
    const blockedOtherChildId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `Parent alias ${companyId}`,
      issuePrefix: `PA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Parent", status: "todo", priority: "medium" },
      { id: otherParentId, companyId, title: "Other parent", status: "todo", priority: "medium" },
    ]);
    await db.insert(issues).values([
      { id: childId, companyId, title: "Child", status: "todo", priority: "medium", parentId },
      {
        id: otherChildId,
        companyId,
        title: "Other child",
        status: "todo",
        priority: "medium",
        parentId: otherParentId,
      },
      {
        id: blockedChildId,
        companyId,
        title: "Blocked child",
        status: "blocked",
        priority: "medium",
        parentId,
      },
      {
        id: blockedOtherChildId,
        companyId,
        title: "Blocked other child",
        status: "blocked",
        priority: "medium",
        parentId: otherParentId,
      },
    ]);

    return {
      companyId,
      userId,
      parentId,
      otherParentId,
      childId,
      blockedChildId,
    };
  }

  it("filters children by ?parentId=", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded.companyId, seeded.userId))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ parentId: seeded.parentId })
      .expect(200);
    expect((res.body as { id: string }[]).map((issue) => issue.id).sort())
      .toEqual([seeded.childId, seeded.blockedChildId].sort());
  });

  it("filters children by ?parentIssueId=", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded.companyId, seeded.userId))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ parentIssueId: seeded.parentId })
      .expect(200);
    expect((res.body as { id: string }[]).map((issue) => issue.id).sort())
      .toEqual([seeded.childId, seeded.blockedChildId].sort());
  });

  it("prefers ?parentId= when both spellings are present", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded.companyId, seeded.userId))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ parentId: seeded.parentId, parentIssueId: seeded.otherParentId })
      .expect(200);
    expect((res.body as { id: string }[]).map((issue) => issue.id).sort())
      .toEqual([seeded.childId, seeded.blockedChildId].sort());
  });

  it("returns the whole company list when neither spelling is present", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded.companyId, seeded.userId))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .expect(200);
    expect(res.body).toHaveLength(6);
  });

  it("filters the blocked count by ?parentIssueId=", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded.companyId, seeded.userId))
      .get(`/api/companies/${seeded.companyId}/issues/count`)
      .query({ attention: "blocked", parentIssueId: seeded.parentId })
      .expect(200);
    expect(res.body).toEqual({ count: 1 });
  });

  it("matches the blocked count for both spellings", async () => {
    const seeded = await seed();
    const app = appFor(seeded.companyId, seeded.userId);
    const byShortForm = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues/count`)
      .query({ attention: "blocked", parentId: seeded.parentId })
      .expect(200);
    const byAlias = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues/count`)
      .query({ attention: "blocked", parentIssueId: seeded.parentId })
      .expect(200);
    expect(byAlias.body).toEqual(byShortForm.body);
  });
});
