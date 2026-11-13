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

/**
 * Regression coverage for https://github.com/paperclipai/paperclip/issues/4628.
 * Express's `qs` parser hands the list route either a string or an array for
 * `?status=`, and the route normalizes both shapes.
 */

describeEmbeddedPostgres("issue list status query parsing", () => {
  const ctx = useEmbeddedPostgres("paperclip-issues-list-query-parsing-", {
    resetEach: resetCompanyIssueFixtures,
  });

  async function listStatuses(query: string) {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Status parsing");
    const companyId = company.companyId;
    await ctx.db.insert(issues).values([
      { id: randomUUID(), companyId, title: "Todo", status: "todo", priority: "medium" },
      { id: randomUUID(), companyId, title: "In progress", status: "in_progress", priority: "medium" },
      { id: randomUUID(), companyId, title: "Done", status: "done", priority: "medium" },
    ]);
    const res = await request(routeApp(ctx.db, company.actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues${query}`)
      .expect(200);
    return (res.body as { status: string }[]).map((issue) => issue.status).sort();
  }

  it("accepts a single ?status=todo", async () => {
    expect(await listStatuses("?status=todo")).toEqual(["todo"]);
  });

  it("accepts comma-separated ?status=todo,in_progress", async () => {
    expect(await listStatuses("?status=todo,in_progress")).toEqual(["in_progress", "todo"]);
  });

  it("accepts repeated ?status=todo&status=in_progress", async () => {
    expect(await listStatuses("?status=todo&status=in_progress")).toEqual(["in_progress", "todo"]);
  });

  it("accepts mixed array and CSV ?status=todo,in_progress&status=done", async () => {
    expect(await listStatuses("?status=todo,in_progress&status=done"))
      .toEqual(["done", "in_progress", "todo"]);
  });

  it("returns every status when ?status is absent", async () => {
    expect(await listStatuses("")).toEqual(["done", "in_progress", "todo"]);
  });
  it.each(["", "&view=compact", "&view=compact&projection=index"])("rejects unsupported creation sorting for blocked attention (%s)", async projection => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Blocked sorting");
    await request(routeApp(ctx.db, actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues?attention=blocked&sortField=created&sortDir=asc${projection}`)
      .expect(422);
  });

  it.each(["", "&view=compact", "&view=compact&projection=index"])("sorts routine tasks by creation time before pagination (%s)", async (projection) => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Creation sorting");
    const ids = Array.from({ length: 4 }, (_, index) => `00000000-0000-4000-8000-00000000000${index}`);
    await ctx.db.insert(issues).values([
      ...ids.map((id, index) => ({ id, companyId, title: "Routine sorting", originKind: "routine_execution", status: "todo",
        createdAt: new Date(index < 2 ? "2026-01-01" : "2026-02-01"),
        updatedAt: new Date(index < 2 ? "2026-03-01" : "2026-02-01"), priority: index < 2 ? "critical" : "low" })),
      { companyId, title: "Routine sorting manual", originKind: "manual", createdAt: new Date("2026-04-01") },
    ]);
    const app = routeApp(ctx.db, actor, issueRoutes);
    const path = `/api/companies/${companyId}/issues?originKind=routine_execution&includeRoutineExecutions=true&sortField=created&limit=2${projection}`;
    for (const sortDir of ["asc", "desc"]) {
      const first = await request(app).get(`${path}&sortDir=${sortDir}`).expect(200);
      const second = await request(app).get(`${path}&sortDir=${sortDir}&offset=2`).expect(200);
      expect([...first.body, ...second.body].map((issue: { id: string }) => issue.id)).toEqual(sortDir === "asc" ? ids : [...ids].reverse());
    }
    await request(app).get(`${path}&sortDir=invalid`).expect(400);
  });

  it.each(["", "&view=compact", "&view=index", "&view=rows"])("reports a capped page and how to fetch the rest (%s)", async (projection) => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Capped pages");
    const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-00000000001${index}`);
    await ctx.db.insert(issues).values(ids.map((id) => ({ id, companyId, title: "Launch task", status: "todo", priority: "medium" })));
    const app = routeApp(ctx.db, actor, issueRoutes);
    const base = `/api/companies/${companyId}/issues?status=todo&sortField=id&sortDir=asc${projection}`;

    const first = await request(app).get(`${base}&limit=2`).expect(200);
    expect(first.body).toHaveLength(2);
    expect(first.headers["x-paperclip-has-more"]).toBe("true");
    expect(first.headers["x-paperclip-limit"]).toBe("2");
    expect(first.headers["x-paperclip-next-offset"]).toBe("2");
    expect(first.headers["x-paperclip-next-after-id"]).toBe(ids[1]);

    const byCursor = await request(app).get(`${base}&limit=2&afterId=${first.headers["x-paperclip-next-after-id"]}`).expect(200);
    expect(byCursor.body.map((issue: { id: string }) => issue.id)).toEqual(ids.slice(2, 4));
    expect(byCursor.headers["x-paperclip-has-more"]).toBe("true");
    expect(byCursor.headers["x-paperclip-next-offset"]).toBeUndefined();
    expect(byCursor.headers["x-paperclip-next-after-id"]).toBe(ids[3]);

    const last = await request(app).get(`${base}&limit=2&offset=4`).expect(200);
    expect(last.body.map((issue: { id: string }) => issue.id)).toEqual([ids[4]]);
    expect(last.headers["x-paperclip-has-more"]).toBe("false");
    expect(last.headers["x-paperclip-next-offset"]).toBeUndefined();
    expect(last.headers["x-paperclip-next-after-id"]).toBeUndefined();

    const exact = await request(app).get(`${base}&limit=5`).expect(200);
    expect(exact.body).toHaveLength(5);
    expect(exact.headers["x-paperclip-has-more"]).toBe("false");
    expect(exact.headers["x-paperclip-next-offset"]).toBeUndefined();
  });

  it("pages one-child-per-parent lists by offset, not an id cursor", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Grouped pages");
    const parentIds = ["00000000-0000-4000-8000-000000000021", "00000000-0000-4000-8000-000000000022"];
    await ctx.db.insert(issues).values(parentIds.map((id) => ({ id, companyId, title: "Parent", status: "todo", priority: "medium" })));
    // The first parent's child has the larger id, so an id cursor would skip the second parent.
    await ctx.db.insert(issues).values([
      { id: "00000000-0000-4000-8000-000000000032", companyId, parentId: parentIds[0], title: "Child", status: "todo", priority: "medium" },
      { id: "00000000-0000-4000-8000-000000000031", companyId, parentId: parentIds[1], title: "Child", status: "todo", priority: "medium" },
    ]);
    const res = await request(routeApp(ctx.db, actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues?view=index&parentIds=${parentIds.join(",")}&oneChildPerParent=true&sortField=id&sortDir=asc&limit=1`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.headers["x-paperclip-has-more"]).toBe("true");
    expect(res.headers["x-paperclip-next-offset"]).toBe("1");
    expect(res.headers["x-paperclip-next-after-id"]).toBeUndefined();
  });

  it("keeps the default response an array and marks a full-default page as capped", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(ctx.db, "Default cap");
    await ctx.db.insert(issues).values(Array.from({ length: 501 }, (_, index) => ({ companyId, title: `RUN-${index + 1}`, status: "todo", priority: "medium" })));
    const res = await request(routeApp(ctx.db, actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues?status=todo&view=index`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(500);
    expect(res.headers["x-paperclip-has-more"]).toBe("true");
    expect(res.headers["x-paperclip-next-offset"]).toBe("500");
  });

});
