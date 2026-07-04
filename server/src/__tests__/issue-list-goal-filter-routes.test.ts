import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, goals, issues, principalPermissionGrants } from "@paperclipai/db";
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
    `Skipping embedded Postgres issue list goal filter route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Regression coverage for the `goalId` list filter on
 * `GET /api/companies/:companyId/issues`.
 *
 * Pre-fix, `goalId` had no entry in `IssueFilters` and the route handler
 * never forwarded `req.query.goalId` to `svc.list()`. Express's default `qs`
 * parser silently drops unrecognized query keys, so `?goalId=<id>` executed
 * as an *unfiltered* list query — returning every issue in the company
 * (sorted by priority/updated-at) instead of erroring or filtering. That
 * looked like a data-integrity bug ("wrong issue returned") rather than the
 * missing-filter gap it actually was.
 */
describeEmbeddedPostgres("issue list routes goalId filter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-goal-filter-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
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

  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
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

  it("returns only issues under the requested goal, not the whole company", async () => {
    const companyId = randomUUID();
    const targetGoalId = randomUUID();
    const otherGoalId = randomUUID();
    const targetIssueId = randomUUID();
    const otherGoalIssueId = randomUUID();
    const noGoalIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(goals).values([
      { id: targetGoalId, companyId, title: "Target goal", level: "task", status: "active" },
      { id: otherGoalId, companyId, title: "Other goal", level: "task", status: "active" },
    ]);
    await db.insert(issues).values([
      {
        id: targetIssueId,
        companyId,
        goalId: targetGoalId,
        title: "In target goal",
        status: "todo",
        priority: "high",
      },
      {
        id: otherGoalIssueId,
        companyId,
        goalId: otherGoalId,
        // Higher priority than the target issue so an unfiltered query would
        // sort this first and mask the bug (mirrors the "returns DRO-350
        // instead of DRO-300" report, where the wrong row won by sort order).
        title: "In other goal",
        status: "todo",
        priority: "critical",
      },
      {
        id: noGoalIssueId,
        companyId,
        goalId: null,
        title: "No goal at all",
        status: "todo",
        priority: "critical",
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ goalId: targetGoalId, limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([targetIssueId]);
  });

  it("returns an empty list for a goalId with no matching issues, not an unfiltered page", async () => {
    const companyId = randomUUID();
    const emptyGoalId = randomUUID();
    const populatedGoalId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(goals).values([
      { id: emptyGoalId, companyId, title: "Empty goal", level: "task", status: "active" },
      { id: populatedGoalId, companyId, title: "Populated goal", level: "task", status: "active" },
    ]);
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      goalId: populatedGoalId,
      title: "Belongs to a different goal",
      status: "todo",
      priority: "medium",
    });

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ goalId: emptyGoalId, limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("combines goalId with status filtering", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const otherGoalId = randomUUID();
    const todoIssueId = randomUUID();
    const doneIssueId = randomUUID();
    const otherGoalTodoIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(goals).values([
      { id: goalId, companyId, title: "Goal", level: "task", status: "active" },
      { id: otherGoalId, companyId, title: "Other goal", level: "task", status: "active" },
    ]);
    await db.insert(issues).values([
      { id: todoIssueId, companyId, goalId, title: "Todo in goal", status: "todo", priority: "medium" },
      { id: doneIssueId, companyId, goalId, title: "Done in goal", status: "done", priority: "medium" },
      // Same status as the target row but a different goal — without the
      // goalId condition actually applied, this would also match `status=todo`
      // and the assertion below would see two rows instead of one.
      {
        id: otherGoalTodoIssueId,
        companyId,
        goalId: otherGoalId,
        title: "Todo in other goal",
        status: "todo",
        priority: "medium",
      },
    ]);


    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ goalId, status: "todo", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([todoIssueId]);
  });

  it("issues/count with attention=blocked also honors goalId", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const otherGoalId = randomUUID();
    const blockerId = randomUUID();
    const otherBlockerId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(goals).values([
      { id: goalId, companyId, title: "Goal", level: "task", status: "active" },
      { id: otherGoalId, companyId, title: "Other goal", level: "task", status: "active" },
    ]);
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        goalId,
        title: "Blocked in goal",
        status: "blocked",
        priority: "medium",
      },
      {
        id: otherBlockerId,
        companyId,
        goalId: otherGoalId,
        title: "Blocked in other goal",
        status: "blocked",
        priority: "medium",
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "blocked", goalId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ count: 1 });
  });
});
