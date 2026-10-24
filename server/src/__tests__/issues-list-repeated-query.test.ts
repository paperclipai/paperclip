import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import { issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue list and count with a repeated query parameter", () => {
  const ctx = useEmbeddedPostgres("paperclip-issues-repeated-query-", {
    resetEach: resetCompanyIssueFixtures,
  });

  async function seed() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Repeated query");
    const companyId = company.companyId;
    const parentId = randomUUID();
    const otherParentId = randomUUID();
    const alphaChildId = randomUUID();
    const blockedChildId = randomUUID();

    await ctx.db.insert(issues).values([
      { id: parentId, companyId, title: "First parent", status: "todo", priority: "medium" },
      { id: otherParentId, companyId, title: "Second parent", status: "todo", priority: "medium" },
    ]);
    await ctx.db.insert(issues).values([
      { id: alphaChildId, companyId, title: "Alpha report", status: "todo", priority: "medium", parentId },
      { id: blockedChildId, companyId, title: "Blocked child", status: "blocked", priority: "medium", parentId },
      {
        id: randomUUID(),
        companyId,
        title: "Beta report",
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
      {
        id: randomUUID(),
        companyId,
        title: "Second blocked other child",
        status: "blocked",
        priority: "medium",
        parentId: otherParentId,
      },
    ]);

    return { ...company, parentId, otherParentId, alphaChildId, blockedChildId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  function getList(seeded: Seeded, search: string) {
    return request(routeApp(ctx.db, seeded.actor, issueRoutes)).get(
      `/api/companies/${seeded.companyId}/issues?${search}`,
    );
  }

  function getBlockedCount(seeded: Seeded, search: string) {
    return request(routeApp(ctx.db, seeded.actor, issueRoutes)).get(
      `/api/companies/${seeded.companyId}/issues/count?attention=blocked&${search}`,
    );
  }

  it("filters the list by the first value of a repeated ?q=", async () => {
    const seeded = await seed();
    const res = await getList(seeded, "q=Alpha&q=Beta").expect(200);
    expect((res.body as { id: string }[]).map((issue) => issue.id)).toEqual([seeded.alphaChildId]);
  });

  it("filters the list by the first value of a repeated ?parentId=", async () => {
    const seeded = await seed();
    const res = await getList(seeded, `parentId=${seeded.parentId}&parentId=${seeded.otherParentId}`).expect(200);
    expect((res.body as { id: string }[]).map((issue) => issue.id).sort()).toEqual(
      [seeded.alphaChildId, seeded.blockedChildId].sort(),
    );
  });

  it("filters the blocked count by the first value of a repeated ?parentId=", async () => {
    const seeded = await seed();
    const res = await getBlockedCount(seeded, `parentId=${seeded.parentId}&parentId=${seeded.otherParentId}`).expect(200);
    expect(res.body).toEqual({ count: 1 });
  });

  const uuidA = "00000000-0000-4000-8000-00000000000a";
  const uuidB = "00000000-0000-4000-8000-00000000000b";

  it.each([
    ["q", "alpha", "beta"],
    ["participantAgentId", uuidA, uuidB],
    ["touchedByUserId", "user-a", "user-b"],
    ["inboxArchivedByUserId", "user-a", "user-b"],
    ["unreadForUserId", "user-a", "user-b"],
    ["projectId", uuidA, uuidB],
    ["workspaceId", uuidA, uuidB],
    ["executionWorkspaceId", uuidA, uuidB],
    ["parentId", uuidA, uuidB],
    ["descendantOf", uuidA, uuidB],
    ["labelId", uuidA, uuidB],
  ])("answers the list with 200 when ?%s= repeats", async (key, first, second) => {
    const seeded = await seed();
    await getList(seeded, `${key}=${first}&${key}=${second}`).expect(200);
  });

  it.each([
    ["assigneeAgentId", uuidA, uuidB],
    ["participantAgentId", uuidA, uuidB],
    ["projectId", uuidA, uuidB],
    ["workspaceId", uuidA, uuidB],
    ["executionWorkspaceId", uuidA, uuidB],
    ["parentId", uuidA, uuidB],
    ["descendantOf", uuidA, uuidB],
    ["labelId", uuidA, uuidB],
  ])("answers the blocked count with 200 when ?%s= repeats", async (key, first, second) => {
    const seeded = await seed();
    await getBlockedCount(seeded, `${key}=${first}&${key}=${second}`).expect(200);
  });
});
