import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import { issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres, resetCompanyIssueFixtures, routeApp,
  seedCompanyWithBoardAccess, useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue totals without card pagination", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-count-", { resetEach: resetCompanyIssueFixtures });

  it("counts past 200 while preserving visibility, status, and search", async () => {
    const a = await seedCompanyWithBoardAccess(ctx.db, "Count owner");
    const b = await seedCompanyWithBoardAccess(ctx.db, "Other company");
    await ctx.db.insert(issues).values([
      ...Array.from({ length: 258 }, (_, i) => ({ id: randomUUID(), companyId: a.companyId, title: `Completed task ${i}`, status: "done" })),
      { id: randomUUID(), companyId: a.companyId, title: "Hidden completed task", status: "done", hiddenAt: new Date() },
      { id: randomUUID(), companyId: a.companyId, title: "Open task", status: "todo" },
      { id: randomUUID(), companyId: b.companyId, title: "Foreign completed task", status: "done" },
    ]);
    const app = routeApp(ctx.db, a.actor, issueRoutes);
    const path = `/api/companies/${a.companyId}/issues`;
    const page = await request(app).get(path).query({ status: "done", limit: 200, view: "compact" }).expect(200);
    expect(page.body).toHaveLength(200);
    expect((await request(app).get(`${path}/count`).query({ status: "done" }).expect(200)).body).toEqual({ count: 258 });
    expect((await request(app).get(`${path}/count`).query({ status: "todo" }).expect(200)).body).toEqual({ count: 1 });
    expect((await request(app).get(`${path}/count`).query({ status: "done", q: "Completed task 257" }).expect(200)).body).toEqual({ count: 1 });
    for (const query of [
      { status: "done,todo" },
      { status: "done", parentId: randomUUID() },
      { status: "done", labelId: randomUUID() },
      { status: "done", includeAgentCreatedTasks: "false" },
      { status: "done", touchedByUserId: "me" },
      { status: "done", inboxArchivedByUserId: "me" },
      { status: "done", unreadForUserId: "me" },
      { status: "done", assigneeUserId: "me" },
      { status: "done", updatedSince: "2099-01-01T00:00:00Z" },
    ]) {
      const listed = await request(app).get(path).query(query).expect(200);
      const counted = await request(app).get(`${path}/count`).query(query).expect(200);
      expect(counted.body.count).toBe(listed.body.length);
    }
    await request(app).get(`${path}/count`).query({ updatedSince: "invalid" }).expect(400);
    await request(app).get(`${path}/count`).query({ status: "done", limit: 200 }).expect(400);
    await request(app).get(`${path}/count`).query({ attention: "invalid" }).expect(400);
  });
});
