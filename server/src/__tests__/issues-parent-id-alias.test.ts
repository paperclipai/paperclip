import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  issueRouteApp,
  resetIssueRouteData,
  seedIssueRouteCompany,
} from "./helpers/issue-route-app.js";

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
    await resetIssueRouteData(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const company = await seedIssueRouteCompany(db, "Parent alias");
    const companyId = company.companyId;
    const parentId = randomUUID();
    const otherParentId = randomUUID();
    const childId = randomUUID();
    const blockedChildId = randomUUID();

    await db.insert(issues).values([
      { id: parentId, companyId, title: "Parent", status: "todo", priority: "medium" },
      { id: otherParentId, companyId, title: "Other parent", status: "todo", priority: "medium" },
    ]);
    await db.insert(issues).values([
      { id: childId, companyId, title: "Child", status: "todo", priority: "medium", parentId },
      { id: blockedChildId, companyId, title: "Blocked child", status: "blocked", priority: "medium", parentId },
      {
        id: randomUUID(),
        companyId,
        title: "Other child",
        status: "todo",
        priority: "medium",
        parentId: otherParentId,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Blocked other child",
        status: "blocked",
        priority: "medium",
        parentId: otherParentId,
      },
    ]);

    return { ...company, parentId, otherParentId, childId, blockedChildId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function listIds(seeded: Seeded, query: Record<string, string>) {
    const res = await request(issueRouteApp(db, seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query(query)
      .expect(200);
    return (res.body as { id: string }[]).map((issue) => issue.id).sort();
  }

  async function blockedCount(seeded: Seeded, query: Record<string, string>) {
    const res = await request(issueRouteApp(db, seeded))
      .get(`/api/companies/${seeded.companyId}/issues/count`)
      .query({ attention: "blocked", ...query })
      .expect(200);
    return res.body as { count: number };
  }

  function childrenOfParent(seeded: Seeded) {
    return [seeded.childId, seeded.blockedChildId].sort();
  }

  it("filters children by ?parentId=", async () => {
    const seeded = await seed();
    expect(await listIds(seeded, { parentId: seeded.parentId })).toEqual(childrenOfParent(seeded));
  });

  it("filters children by ?parentIssueId=", async () => {
    const seeded = await seed();
    expect(await listIds(seeded, { parentIssueId: seeded.parentId })).toEqual(childrenOfParent(seeded));
  });

  it("prefers ?parentId= when both spellings are present", async () => {
    const seeded = await seed();
    const ids = await listIds(seeded, {
      parentId: seeded.parentId,
      parentIssueId: seeded.otherParentId,
    });
    expect(ids).toEqual(childrenOfParent(seeded));
  });

  it("returns the whole company list when neither spelling is present", async () => {
    const seeded = await seed();
    expect(await listIds(seeded, {})).toHaveLength(6);
  });

  it("filters the blocked count by ?parentIssueId=", async () => {
    const seeded = await seed();
    expect(await blockedCount(seeded, { parentIssueId: seeded.parentId })).toEqual({ count: 1 });
  });

  it("returns the same blocked count for both spellings", async () => {
    const seeded = await seed();
    const byShortForm = await blockedCount(seeded, { parentId: seeded.parentId });
    const byAlias = await blockedCount(seeded, { parentIssueId: seeded.parentId });
    expect(byAlias).toEqual(byShortForm);
  });
});
