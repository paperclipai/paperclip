import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { authUsers, companies, companyMemberships, issueRelations, issues } from "@paperclipai/db";
import { boardSessionApp, seedBoardRouteFixture } from "./helpers/route-census-fixture.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";
import { createStatementCensus, formatStatementCensus } from "./helpers/statement-census.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const GOLDEN = new URL("./fixtures/issue-detail-response.json", import.meta.url);

function normalizeResponse(body: unknown, issuePrefix: string) {
  const ids = new Map<string, string>();
  const text = JSON.stringify(body, null, 2)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
      if (!ids.has(id)) ids.set(id, `<id:${ids.size}>`);
      return ids.get(id)!;
    })
    .replace(/"[^"]*\/instances\/[^/"]+\//g, "\"<home>/")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>")
    .replaceAll(issuePrefix, "<prefix>")
    .replace(/user-<id:\d+>/g, "<user>");
  return `${text}\n`;
}

describeEmbeddedPostgres("GET /api/issues/:id statements per request", () => {
  const ctx = useEmbeddedPostgres("issue-detail-statements-");

  async function seed() {
    const fixture = await seedBoardRouteFixture(ctx.db, "Detail");
    const [grandparent] = await ctx.db.insert(issues).values({
      companyId: fixture.companyId, title: "Detail grandparent", status: "todo", projectId: fixture.project.id,
      createdByUserId: fixture.userId, createdAt: new Date("2026-10-30T00:00:00.000Z"), updatedAt: new Date("2026-10-30T00:00:00.000Z"),
    }).returning();
    await ctx.db.update(issues).set({ parentId: grandparent!.id }).where(eq(issues.id, fixture.parent.id));
    const [blocker] = await ctx.db.insert(issues).values({
      companyId: fixture.companyId, title: "Detail blocker", status: "todo", createdByUserId: fixture.userId,
      createdAt: new Date("2026-10-31T00:00:00.000Z"), updatedAt: new Date("2026-10-31T00:00:00.000Z"),
    }).returning();
    await ctx.db.insert(issueRelations).values({
      companyId: fixture.companyId, issueId: blocker!.id, relatedIssueId: fixture.issue.id, type: "blocks",
    });
    await ctx.db.update(issues).set({ description: `Uses [@Detail project](project://${fixture.project.id})` })
      .where(eq(issues.id, fixture.issue.id));
    const [company] = await ctx.db.select({ issuePrefix: companies.issuePrefix }).from(companies)
      .where(eq(companies.id, fixture.companyId));
    return { ...fixture, grandparent: grandparent!, blocker: blocker!, issuePrefix: company!.issuePrefix };
  }

  it("answers the issue detail with the same JSON in fewer statements", async () => {
    const census = createStatementCensus(ctx.db);
    try {
      const fixture = await seed();
      const app = boardSessionApp(ctx.db, () => fixture.userId);
      const path = `/api/issues/${fixture.issue.id}`;
      await request(app).get(path).expect(200);
      let response: request.Response | undefined;
      const measured = await census.measure(async () => {
        response = await request(app).get(path).expect(200);
      }, { stacks: true });

      const normalized = normalizeResponse(response!.body, fixture.issuePrefix);
      if (process.env.PAPERCLIP_WRITE_ISSUE_DETAIL_GOLDEN) writeFileSync(GOLDEN, normalized);
      expect(normalized).toBe(readFileSync(GOLDEN, "utf8"));
      expect(response!.body.ancestors.map((ancestor: { id: string }) => ancestor.id))
        .toEqual([fixture.parent.id, fixture.grandparent.id]);
      expect(response!.body.blockedBy.map((relation: { id: string }) => relation.id)).toEqual([fixture.blocker.id]);
      expect(response!.body.mentionedProjects.map((project: { id: string }) => project.id)).toEqual([fixture.project.id]);
      expect(measured.statements, formatStatementCensus(path, measured, 80)).toBeLessThanOrEqual(64);
    } finally {
      census.uninstall();
    }
  }, 60_000);

  it("keeps the access rules: another company's user, a missing issue and a hidden issue", async () => {
    const fixture = await seed();
    const outsider = await seedBoardRouteFixture(ctx.db, "Outsider");
    const [hidden] = await ctx.db.insert(issues).values({
      companyId: fixture.companyId, title: "Hidden", status: "todo", hiddenAt: new Date(),
    }).returning();
    const memberApp = boardSessionApp(ctx.db, () => fixture.userId);
    const outsiderApp = boardSessionApp(ctx.db, () => outsider.userId);
    const anonymousApp = boardSessionApp(ctx.db, () => null);

    const statuses = {
      outsiderReadsMemberIssue: (await request(outsiderApp).get(`/api/issues/${fixture.issue.id}`)).status,
      memberReadsOtherCompanyIssue: (await request(memberApp).get(`/api/issues/${outsider.issue.id}`)).status,
      memberReadsMissingIssue: (await request(memberApp).get(`/api/issues/${randomUUID()}`)).status,
      anonymousReadsMemberIssue: (await request(anonymousApp).get(`/api/issues/${fixture.issue.id}`)).status,
    };
    expect(statuses).toEqual({
      outsiderReadsMemberIssue: 404,
      memberReadsOtherCompanyIssue: 404,
      memberReadsMissingIssue: 404,
      anonymousReadsMemberIssue: 404,
    });
    const hiddenResponse = await request(memberApp).get(`/api/issues/${hidden!.id}`);
    expect(hiddenResponse.status).toBe(200);
    expect(hiddenResponse.body.hiddenAt).not.toBeNull();
  }, 60_000);

  it("denies the very next request after the membership is removed", async () => {
    const fixture = await seed();
    const app = boardSessionApp(ctx.db, () => fixture.userId);
    await request(app).get(`/api/issues/${fixture.issue.id}`).expect(200);
    await ctx.db.delete(companyMemberships).where(eq(companyMemberships.principalId, fixture.userId));
    await request(app).get(`/api/issues/${fixture.issue.id}`).expect(404);
    await ctx.db.delete(authUsers).where(eq(authUsers.id, fixture.userId));
  }, 60_000);
  it("walks the ancestor chain nearest first, stops at a cycle and ignores a task that is its own parent", async () => {
    const fixture = await seed();
    const svc = issueService(ctx.db);
    await ctx.db.update(issues).set({ parentId: fixture.parent.id }).where(eq(issues.id, fixture.grandparent.id));
    const expected = [fixture.parent.id, fixture.grandparent.id];
    expect((await svc.getAncestors(fixture.issue.id)).map((ancestor) => ancestor.id)).toEqual(expected);
    expect((await svc.getAncestors(fixture.issue.id, { parentId: fixture.parent.id })).map((ancestor) => ancestor.id)).toEqual(expected);
    await ctx.db.update(issues).set({ parentId: fixture.blocker.id }).where(eq(issues.id, fixture.blocker.id));
    expect(await svc.getAncestors(fixture.blocker.id)).toEqual([]);
  }, 60_000);
  it("answers the interactions poll without reading the issue again", async () => {
    const census = createStatementCensus(ctx.db);
    try {
      const fixture = await seed();
      const app = boardSessionApp(ctx.db, () => fixture.userId);
      const path = `/api/issues/${fixture.issue.id}/interactions`;
      await request(app).get(path).expect(200);
      let response: request.Response | undefined;
      const measured = await census.measure(async () => {
        response = await request(app).get(path).expect(200);
      });
      const expected = await issueThreadInteractionService(ctx.db).listForIssue(fixture.issue.id);
      expect(response!.body).toEqual(JSON.parse(JSON.stringify(expected)));
      expect(measured.shapes.filter((shape) => shape.shape.startsWith('select "status", "company_id", "execution_workspace_id" from "issues"'))).toEqual([]);
      expect(measured.statements, formatStatementCensus(path, measured, 20)).toBeLessThanOrEqual(10);
    } finally {
      census.uninstall();
    }
  }, 60_000);
});
