import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { normalizeTimelineWindow, workTimelineService } from "../services/work-timeline.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres work timeline tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("work timeline aggregation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-timeline-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        companyIds: [],
        memberships: [],
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api/companies", companyRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedBase() {
    const companyId = randomUUID();
    const userId = "user-1";
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Timeline Co",
      issuePrefix: `T${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({
      id: userId,
      name: "User One",
      email: "user@example.com",
      emailVerified: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "QA",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, userId, agentAId, agentBId };
  }

  it("normalizes timeline windows with a 31 day cap", () => {
    const result = normalizeTimelineWindow({
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-03-15T00:00:00Z"),
    }, new Date("2026-03-15T00:00:00Z"));

    expect(result.capped).toBe(true);
    expect(result.from.toISOString()).toBe("2026-02-12T00:00:00.000Z");
  });

  it("aggregates runs, human events, approvals, and delegation edges", async () => {
    const { companyId, userId, agentAId, agentBId } = await seedBase();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();
    const contextRunId = randomUUID();
    const activityRunId = randomUUID();
    const approvalId = randomUUID();

    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        title: "Parent",
        identifier: "TL-1",
        status: "in_progress",
        priority: "medium",
        createdByUserId: userId,
        assigneeAgentId: agentAId,
        createdAt: new Date("2026-03-01T10:00:00Z"),
        updatedAt: new Date("2026-03-01T10:00:00Z"),
      },
      {
        id: childIssueId,
        companyId,
        title: "Child",
        identifier: "TL-2",
        status: "in_progress",
        priority: "medium",
        parentId: parentIssueId,
        createdByAgentId: agentAId,
        assigneeAgentId: agentBId,
        createdAt: new Date("2026-03-01T11:00:00Z"),
        updatedAt: new Date("2026-03-01T11:00:00Z"),
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: contextRunId,
        companyId,
        agentId: agentBId,
        status: "running",
        invocationSource: "issue_assigned",
        startedAt: new Date("2026-03-01T12:00:00Z"),
        finishedAt: null,
        contextSnapshot: { issueId: childIssueId },
      },
      {
        id: activityRunId,
        companyId,
        agentId: agentAId,
        status: "completed",
        invocationSource: "manual",
        startedAt: new Date("2026-03-01T12:30:00Z"),
        finishedAt: new Date("2026-03-01T12:45:00Z"),
        contextSnapshot: {},
      },
    ]);
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: agentAId,
        action: "issue.updated",
        entityType: "issue",
        entityId: parentIssueId,
        agentId: agentAId,
        runId: activityRunId,
        createdAt: new Date("2026-03-01T12:35:00Z"),
      },
      {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.assigned",
        entityType: "issue",
        entityId: childIssueId,
        details: { assigneeAgentId: agentBId },
        createdAt: new Date("2026-03-01T13:00:00Z"),
      },
    ]);
    await db.insert(issueComments).values({
      companyId,
      issueId: childIssueId,
      authorUserId: userId,
      body: "Looks good",
      createdAt: new Date("2026-03-01T13:30:00Z"),
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "approved",
      payload: {},
      decidedByUserId: userId,
      decidedAt: new Date("2026-03-01T14:00:00Z"),
    });
    await db.insert(issueApprovals).values({ companyId, issueId: childIssueId, approvalId });

    const result = await workTimelineService(db).getTimeline({
      companyId,
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-03-02T00:00:00Z"),
    });

    expect(result.actors.map((actor) => actor.name)).toEqual(expect.arrayContaining(["Coder", "QA", "User One"]));
    expect(result.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: contextRunId, issueId: childIssueId, end: null, status: "running" }),
      expect.objectContaining({ runId: activityRunId, issueId: parentIssueId, status: "completed" }),
    ]));
    expect(result.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "created",
      "commented",
      "approved",
      "delegated",
      "assigned",
    ]));
    expect(result.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "delegation", issueId: childIssueId }),
      expect.objectContaining({ kind: "assignment", issueId: childIssueId }),
    ]));
  });

  it("does not join activity rows to runs from another company", async () => {
    const { companyId, agentAId } = await seedBase();
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const foreignRunId = randomUUID();

    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Timeline Co",
      issuePrefix: `O${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "Foreign Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Local issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentAId,
      createdAt: new Date("2026-03-02T10:00:00Z"),
      updatedAt: new Date("2026-03-02T10:00:00Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: foreignRunId,
      companyId: otherCompanyId,
      agentId: otherAgentId,
      status: "completed",
      invocationSource: "manual",
      startedAt: new Date("2026-03-02T11:00:00Z"),
      finishedAt: new Date("2026-03-02T11:15:00Z"),
      contextSnapshot: {},
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentAId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      agentId: agentAId,
      runId: foreignRunId,
      createdAt: new Date("2026-03-02T11:05:00Z"),
    });

    const result = await workTimelineService(db).getTimeline({
      companyId,
      from: new Date("2026-03-02T00:00:00Z"),
      to: new Date("2026-03-03T00:00:00Z"),
    });

    expect(result.events.map((event) => event.issueId)).toContain(issueId);
    expect(result.spans.map((span) => span.runId)).not.toContain(foreignRunId);
  });

  it("applies the user lens as a transitive issue subtree", async () => {
    const { companyId, userId, agentAId, agentBId } = await seedBase();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const unrelatedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "User root",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        assigneeAgentId: agentAId,
        createdAt: new Date("2026-03-03T10:00:00Z"),
        updatedAt: new Date("2026-03-03T10:00:00Z"),
      },
      {
        id: childIssueId,
        companyId,
        title: "Delegated child",
        status: "todo",
        priority: "medium",
        parentId: rootIssueId,
        createdByAgentId: agentAId,
        assigneeAgentId: agentBId,
        createdAt: new Date("2026-03-03T11:00:00Z"),
        updatedAt: new Date("2026-03-03T11:00:00Z"),
      },
      {
        id: unrelatedIssueId,
        companyId,
        title: "Unrelated",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentBId,
        createdAt: new Date("2026-03-03T12:00:00Z"),
        updatedAt: new Date("2026-03-03T12:00:00Z"),
      },
    ]);

    const result = await workTimelineService(db).getTimeline({
      companyId,
      userId,
      from: new Date("2026-03-03T00:00:00Z"),
      to: new Date("2026-03-04T00:00:00Z"),
    });

    expect(result.events.map((event) => event.issueId)).toEqual(expect.arrayContaining([rootIssueId, childIssueId]));
    expect(result.events.map((event) => event.issueId)).not.toContain(unrelatedIssueId);
  });

  it("filters unreadable issues before emitting timeline rows", async () => {
    const { companyId, agentAId } = await seedBase();
    const visibleIssueId = randomUUID();
    const hiddenIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: visibleIssueId,
        companyId,
        title: "Visible",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentAId,
        createdAt: new Date("2026-03-04T10:00:00Z"),
        updatedAt: new Date("2026-03-04T10:00:00Z"),
      },
      {
        id: hiddenIssueId,
        companyId,
        title: "Denied",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentAId,
        createdAt: new Date("2026-03-04T11:00:00Z"),
        updatedAt: new Date("2026-03-04T11:00:00Z"),
      },
    ]);

    const result = await workTimelineService(db).getTimeline({
      companyId,
      from: new Date("2026-03-04T00:00:00Z"),
      to: new Date("2026-03-05T00:00:00Z"),
      canReadIssue: async (issue) => issue.id !== hiddenIssueId,
    });

    expect(result.events.map((event) => event.issueId)).toContain(visibleIssueId);
    expect(result.events.map((event) => event.issueId)).not.toContain(hiddenIssueId);
    expect(result.pagination.totalIssues).toBe(1);
  });

  it("bounds pre-pagination ACL checks", async () => {
    const { companyId, agentAId } = await seedBase();
    const issueCount = 40;
    await db.insert(issues).values(Array.from({ length: issueCount }, (_, index) => ({
      id: randomUUID(),
      companyId,
      title: `Visible ${index}`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentAId,
      createdAt: new Date(Date.parse("2026-03-04T10:00:00Z") + index * 1000),
      updatedAt: new Date(Date.parse("2026-03-04T10:00:00Z") + index * 1000),
    })));

    let activeChecks = 0;
    let maxActiveChecks = 0;
    const result = await workTimelineService(db).getTimeline({
      companyId,
      from: new Date("2026-03-04T00:00:00Z"),
      to: new Date("2026-03-05T00:00:00Z"),
      limit: issueCount,
      canReadIssue: async () => {
        activeChecks += 1;
        maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeChecks -= 1;
        return true;
      },
    });

    expect(result.pagination.totalIssues).toBe(issueCount);
    expect(maxActiveChecks).toBeLessThanOrEqual(16);
  });

  it("serves GET /api/companies/:companyId/timeline", async () => {
    const { companyId, agentAId } = await seedBase();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Route issue",
      identifier: "TL-9",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentAId,
      createdAt: new Date("2026-03-05T10:00:00Z"),
      updatedAt: new Date("2026-03-05T10:00:00Z"),
    });

    const res = await request(createApp())
      .get(`/api/companies/${companyId}/timeline`)
      .query({ from: "2026-03-05T00:00:00Z", to: "2026-03-06T00:00:00Z" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.events).toEqual([
      expect.objectContaining({ kind: "created", issueId }),
    ]);
    expect(res.body).toEqual(expect.objectContaining({
      actors: expect.any(Array),
      spans: expect.any(Array),
      edges: expect.any(Array),
      pagination: expect.objectContaining({ totalIssues: 1 }),
    }));
  });
});
