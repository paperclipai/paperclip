import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it, vi } from "vitest";
import * as services from "../services/index.js";
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

  it.each([
    ["status=todo&status=todo&status=done", ["todo", "done"]],
    ["status=blocked,blocked,in_review", ["blocked", "in_review"]],
    ["status=done,in_review&status=done", ["done", "in_review"]],
  ])("passes distinct statuses to list and count for %s", async (query, expected) => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Distinct statuses");
    const service = services.issueService(ctx.db);
    const list = vi.spyOn(service, "list").mockResolvedValue([]);
    const count = vi.spyOn(service, "count").mockResolvedValue(0);
    const factory = vi.spyOn(services, "issueService").mockReturnValue(service);
    try {
      const app = routeApp(ctx.db, company.actor, issueRoutes);
      await request(app).get(`/api/companies/${company.companyId}/issues?${query}`).expect(200);
      expect(list).toHaveBeenCalledWith(company.companyId, expect.objectContaining({ status: expected }));
      await request(app).get(`/api/companies/${company.companyId}/issues/count?attention=blocked&${query}`).expect(200);
      expect(count).toHaveBeenCalledWith(company.companyId, expect.objectContaining({ status: expected }));
    } finally {
      factory.mockRestore();
      list.mockRestore();
      count.mockRestore();
    }
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
});
