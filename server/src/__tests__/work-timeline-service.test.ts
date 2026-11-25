import { randomUUID } from "node:crypto";
import express from "express";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  documents,
  documentRevisions,
  issuePlanDecompositions,
  issueThreadInteractions,
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
import { issueRoutes } from "../routes/issues.js";
import { companyRoutes } from "../routes/companies.js";
import { buildOpenApiSpec } from "../routes/openapi.js";
import { registerTimelineReceiptBoundaryCases } from "./helpers/work-timeline-receipt-cases.js";
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
    await db.delete(issuePlanDecompositions);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actorUserId = "local-board", includeIssues = false, agentActor?: { companyId: string; agentId: string }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = agentActor ? { type: "agent", source: "agent_key", ...agentActor } : {
        type: "board",
        userId: actorUserId,
        companyIds: [],
        memberships: [],
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api/companies", companyRoutes(db, {} as any));
    if (includeIssues) app.use("/api", issueRoutes(db, {} as any));
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
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
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

  it("aggregates runs, human events, approvals, and recorded assignments", async () => {
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
        usageJson: { inputTokens: 120, cachedInputTokens: 30, outputTokens: 50 },
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
      expect.objectContaining({
        runId: contextRunId,
        issueId: childIssueId,
        end: null,
        status: "running",
        usage: { inputTokens: 120, cachedInputTokens: 30, outputTokens: 50, totalTokens: 200 },
      }),
      expect.objectContaining({ runId: activityRunId, issueId: parentIssueId, status: "completed" }),
    ]));
    expect(result.events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "created",
      "commented",
      "approved",
      "assigned",
    ]));
    expect(result.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assignment", issueId: childIssueId }),
    ]));
  });

  it("does not retain an inferred delegation when assignment history was recorded", async () => {
    const { companyId, agentAId, agentBId } = await seedBase();
    const parentId = randomUUID(), childId = randomUUID();
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Parent", status: "done", assigneeAgentId: agentAId,
        createdAt: new Date("2026-03-01T10:00:00Z"), updatedAt: new Date("2026-03-05T10:00:00Z") },
      { id: childId, companyId, parentId, title: "Child", status: "done", assigneeAgentId: agentBId,
        createdAt: new Date("2026-03-03T10:00:00Z"), updatedAt: new Date("2026-03-05T10:00:00Z") },
    ]);
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentAId,
      action: "issue.assigned", entityType: "issue", entityId: childId,
      details: { assigneeAgentId: agentBId }, createdAt: new Date("2026-03-05T12:00:00Z") });
    const response = await request(createApp()).get(`/api/companies/${companyId}/timeline`)
      .query({ from: "2026-03-05T00:00:00Z", to: "2026-03-06T00:00:00Z" });
    expect(response.status).toBe(200);
    expect(response.body.events).toContainEqual(expect.objectContaining({ issueId: childId, kind: "assigned" }));
    expect(response.body.events.filter((event: { kind: string }) => event.kind === "delegated")).toEqual([]);
    expect(response.body.edges.filter((edge: { kind: string }) => edge.kind === "delegation")).toEqual([]);
  });

  it("preserves delegation edges when parent and child cross a page boundary", async () => {
    const { companyId, userId, agentAId, agentBId } = await seedBase();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        title: "Parent",
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
        status: "in_progress",
        priority: "medium",
        parentId: parentIssueId,
        createdByAgentId: agentAId,
        assigneeAgentId: agentBId,
        createdAt: new Date("2026-03-01T11:00:00Z"),
        updatedAt: new Date("2026-03-01T11:00:00Z"),
      },
    ]);

    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentAId,
      action: "issue.created", entityType: "issue", entityId: childIssueId,
      createdAt: new Date("2026-03-01T11:00:00Z"), details: { parentId: parentIssueId,
        assigneeAgentId: agentBId, assigneeUserId: null, source: "paperclip_runner_protocol" } });

    const result = await workTimelineService(db).getTimeline({
      companyId,
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-03-02T00:00:00Z"),
      limit: 1,
    });

    expect(result.pagination).toEqual({
      limit: 1,
      offset: 0,
      totalIssues: 2,
      hasMore: true,
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      kind: "delegated",
      issueId: childIssueId,
    }));
    expect(result.edges).toContainEqual(expect.objectContaining({
      kind: "delegation",
      issueId: childIssueId,
      fromActorId: `agent:${agentAId}`,
      toActorId: `agent:${agentBId}`,
    }));
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

  it.each(["before", "after"] as const)("does not invent creation ownership from a reassignment %s the query window", async when => {
    const { companyId, userId, agentAId, agentBId } = await seedBase();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Historical launch owner",
      status: "done", priority: "medium", assigneeAgentId: agentBId, createdByUserId: userId,
      createdAt: new Date("2026-03-01T10:00:00Z"), updatedAt: new Date("2026-03-05T10:00:00Z") });
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: userId,
      entityType: "issue", entityId: issueId, action: "issue.updated",
      createdAt: new Date(when === "before" ? "2026-03-02T10:00:00Z" : "2026-03-06T10:00:00Z"),
      details: { assigneeAgentId: agentBId, changes: { assigneeAgentId: { from: agentAId, to: agentBId } } } });
    const response = await request(createApp()).get(`/api/companies/${companyId}/timeline`)
      .query({ issueId, from: "2026-03-05T00:00:00Z", to: "2026-03-06T00:00:00Z" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.edges.filter((edge: { kind: string }) => edge.kind === "assignment")).toEqual([]);
    expect(response.body.events.filter((event: { kind: string }) => event.kind === "assigned")).toEqual([]);
    expect(response.body.events).toContainEqual(expect.objectContaining({ issueId, kind: "created" }));
  });

  it.each([
    ["child", "2026-03-02T10:00:00Z"], ["child", "2026-03-05T12:00:00Z"],
    ["parent", "2026-03-02T10:00:00Z"], ["parent", "2026-03-06T10:00:00Z"],
  ] as const)("does not infer a creation delegation after %s ownership changed at %s", async (changedIssue, at) => {
    const { companyId, userId, agentAId, agentBId } = await seedBase();
    const parentId = randomUUID(), childId = randomUUID();
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Launch parent", status: "done", priority: "medium",
        createdByUserId: userId, assigneeAgentId: agentAId,
        createdAt: new Date("2026-03-01T10:00:00Z"), updatedAt: new Date("2026-03-05T10:00:00Z") },
      { id: childId, companyId, parentId, title: "Launch child", status: "done", priority: "medium",
        createdByAgentId: agentAId, assigneeAgentId: agentBId,
        createdAt: new Date("2026-03-03T10:00:00Z"), updatedAt: new Date("2026-03-05T10:00:00Z") },
    ]);
    const target = changedIssue === "parent" ? agentAId : agentBId;
    const previous = changedIssue === "parent" ? agentBId : agentAId;
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: userId,
      entityType: "issue", entityId: changedIssue === "parent" ? parentId : childId,
      action: "issue.updated", createdAt: new Date(at),
      details: { assigneeAgentId: target, changes: { assigneeAgentId: { from: previous, to: target } } } });
    const response = await request(createApp()).get(`/api/companies/${companyId}/timeline`)
      .query({ limit: 1, from: "2026-03-05T00:00:00Z", to: "2026-03-06T00:00:00Z" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.pagination).toMatchObject({ totalIssues: 2, hasMore: true });
    expect(response.body.edges.filter((edge: { kind: string }) => edge.kind === "delegation")).toEqual([]);
    expect(response.body.events.filter((event: { kind: string }) => event.kind === "delegated")).toEqual([]);
    if (changedIssue === "child" && at.startsWith("2026-03-05")) {
      expect(response.body.events).toContainEqual({ actorId: `user:${userId}`, issueId: childId, kind: "assigned", at: new Date(at).toISOString() });
      expect(response.body.edges).toContainEqual({ fromActorId: `user:${userId}`, toActorId: `agent:${agentBId}`, issueId: childId, kind: "assignment", at: new Date(at).toISOString() });
    }
  });

  it("reads creation and assignment receipts only inside the bounded readable page window", async () => {
    const { companyId, userId, agentAId, agentBId } = await seedBase();
    const parentId = randomUUID(), childId = randomUUID(), hiddenId = randomUUID(), unpagedId = randomUUID();
    const foreignCompanyId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign", issuePrefix: "TF" });
    await db.insert(issues).values([parentId, unpagedId, childId, hiddenId].map((id, index) => ({
      id, companyId, title: `Scoped ${index}`, status: "done", assigneeAgentId: id === parentId ? agentAId : agentBId,
      parentId: id === childId ? parentId : null, createdByUserId: userId,
      createdAt: new Date(Date.parse("2026-03-01T10:00:00Z") + index * 1000), updatedAt: new Date("2026-03-05T10:00:00Z"),
    })));
    const ownershipRow = (entityId: string, scopedCompanyId = companyId) => ({ companyId: scopedCompanyId,
      actorType: "user", actorId: userId, entityType: "issue", entityId, action: "issue.updated",
      createdAt: new Date("2026-03-02T10:00:00Z"), details: { changes: { assigneeAgentId: { from: agentBId, to: agentAId } } } });
    await db.insert(activityLog).values([ownershipRow(parentId), ownershipRow(hiddenId), ownershipRow(childId, foreignCompanyId),
      ...Array.from({ length: 1000 }, () => ownershipRow(unpagedId))]);
    const queries: Array<{ query: string; parameters: unknown[] }> = [];
    const previousDebug = db.$client.options.debug;
    let result;
    db.$client.options.debug = (_connection, query, parameters) => queries.push({ query, parameters });
    try {
      result = await workTimelineService(db).getTimeline({ companyId, limit: 1,
        from: new Date("2026-03-05T00:00:00Z"), to: new Date("2026-03-06T00:00:00Z"),
        canReadIssue: async issue => issue.id !== hiddenId });
    } finally { db.$client.options.debug = previousDebug; }
    expect(queries.some(row => /^select distinct /i.test(row.query) && row.query.includes('"activity_log"'))).toBe(false);
    const receipts = queries.filter(row => row.query.includes('from "activity_log"') && row.query.includes('"details"') && !row.query.includes("join"));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.query).toMatch(/"created_at" >=/);
    expect(receipts[0]!.query).toMatch(/"created_at" <=/);
    const scopedIds = receipts[0]!.parameters.filter(value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value));
    expect(new Set(scopedIds)).toEqual(new Set([companyId, childId]));
    expect(result.edges).toEqual([]);
    expect(result.events.every(event => event.issueId === childId)).toBe(true);

  });

  it("fails the route when bounded activity receipts cannot be read instead of inventing ownership", async () => {
    const { companyId, agentAId } = await seedBase();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "History failure", status: "done", assigneeAgentId: agentAId,
      createdAt: new Date("2026-03-05T10:00:00Z"), updatedAt: new Date("2026-03-05T10:00:00Z") });
    const select = db.select.bind(db);
    const fault = vi.spyOn(db, "select").mockImplementation(((fields: any) =>
      fields?.creationRecorded ? select({ ...fields, creationRecorded: sql`1 / 0` }) : select(fields)) as any);
    try {
      const response = await request(createApp()).get(`/api/companies/${companyId}/timeline`)
        .query({ issueId, from: "2026-03-05T00:00:00Z", to: "2026-03-06T00:00:00Z" });
      expect(fault).toHaveBeenCalled();
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty("edges");
    } finally { fault.mockRestore(); }
  });

  it("serves the recorded human reassignment instead of inferring the current owner at creation", async () => {
    const { companyId, userId, agentAId, agentBId } = await seedBase();
    const issueId = randomUUID();
    const createdAt = new Date("2026-03-05T10:00:00Z");
    const assignedAt = new Date("2026-03-05T11:00:00Z");
    await db.insert(issues).values({
      id: issueId, companyId, title: "Reassigned launch", identifier: "TL-10",
      status: "done", priority: "medium", createdByUserId: userId,
      assigneeAgentId: agentBId, createdAt, updatedAt: assignedAt,
    });
    await db.insert(activityLog).values([
      { companyId, actorType: "user", actorId: userId, action: "issue.updated",
        entityType: "issue", entityId: issueId, createdAt: assignedAt,
        details: { assigneeAgentId: agentBId, _previous: { assigneeAgentId: agentAId } } },
      { companyId, actorType: "agent", actorId: agentBId, action: "issue.updated",
        entityType: "issue", entityId: issueId, createdAt: new Date("2026-03-05T12:00:00Z"),
        details: { status: "done", _previous: { status: "in_progress" } } },
    ]);
    const res = await request(createApp()).get(`/api/companies/${companyId}/timeline`)
      .query({ from: "2026-03-05T00:00:00Z", to: "2026-03-06T00:00:00Z" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.events.filter((event: { kind: string }) => event.kind === "assigned")).toEqual([
      { actorId: `user:${userId}`, kind: "assigned", issueId, at: assignedAt.toISOString() },
    ]);
    expect(res.body.edges.filter((edge: { kind: string }) => edge.kind === "assignment")).toEqual([
      { fromActorId: `user:${userId}`, toActorId: `agent:${agentBId}`, issueId, at: assignedAt.toISOString(), kind: "assignment" },
    ]);
    expect(res.body.actors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `user:${userId}`, type: "user", name: "User One" }),
      expect.objectContaining({ id: `agent:${agentBId}`, type: "agent", name: "QA" }),
    ]));
  });

  it("distinguishes absent, null and unchanged owners and keeps same-actor assignment history", async () => {
    const { companyId, userId, agentAId, agentBId } = await seedBase();
    const createdAt = new Date("2026-03-05T10:00:00Z");
    const changedAt = new Date("2026-03-05T11:00:00Z");
    for (const kind of ["absent", "null", "unchanged", "canonical-empty", "canonical-unchanged", "self-assignment"] as const) {
      const issueId = randomUUID();
      const assigneeAgentId = kind === "null" ? null : kind === "self-assignment" ? agentBId : agentAId;
      await db.insert(issues).values({ id: issueId, companyId, title: kind, status: "done",
        priority: "medium", assigneeAgentId, createdByUserId: userId, createdAt, updatedAt: changedAt });
      await db.insert(activityLog).values({ companyId, actorType: "user", actorId: userId,
        action: "issue.created", entityType: "issue", entityId: issueId, createdAt,
        details: { parentId: null, assigneeAgentId: agentAId, assigneeUserId: null } });
      const details = kind === "absent" ? { status: "done" }
        : kind === "canonical-empty" ? { assigneeAgentId, changes: {} }
        : kind === "canonical-unchanged" ? { assigneeAgentId, changes: { assigneeAgentId: { from: agentAId, to: agentAId } } }
        : { assigneeAgentId, _previous: { assigneeAgentId: agentAId } };
      await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentAId,
        action: "issue.updated", entityType: "issue", entityId: issueId, details, createdAt: changedAt });
      const res = await request(createApp()).get(`/api/companies/${companyId}/timeline`)
        .query({ issueId, from: "2026-03-05T00:00:00Z", to: "2026-03-06T00:00:00Z" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const assigned = res.body.events.filter((event: { kind: string }) => event.kind === "assigned");
      const assignmentEdges = res.body.edges.filter((edge: { kind: string }) => edge.kind === "assignment");
      if (kind === "self-assignment") {
        expect(assigned).toEqual([{ actorId: `agent:${agentAId}`, kind: "assigned", issueId, at: changedAt.toISOString() }]);
        expect(assignmentEdges).toEqual(expect.arrayContaining([
          { fromActorId: `user:${userId}`, toActorId: `agent:${agentAId}`, issueId, at: createdAt.toISOString(), kind: "assignment" },
          { fromActorId: `agent:${agentAId}`, toActorId: `agent:${agentBId}`, issueId, at: changedAt.toISOString(), kind: "assignment" },
        ]));
      } else {
        expect(assigned).toEqual([]);
        expect(assignmentEdges).toHaveLength(1);
        expect(assignmentEdges[0]).toMatchObject({ at: createdAt.toISOString(), toActorId: `agent:${agentAId}` });
        expect(res.body.events.filter((event: { kind: string }) => event.kind === "unassigned")).toEqual(kind === "null"
          ? [{ actorId: `agent:${agentAId}`, kind: "unassigned", issueId, at: changedAt.toISOString() }] : []);
      }
    }
  });

  it("uses actual PATCH receipts to separate repeated owners from reassignment and unassignment", async () => {
    const { companyId, userId, agentAId, agentBId } = await seedBase();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.companyId, companyId));
    const issueId = randomUUID();
    const createdAt = new Date(Date.now() - 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Producer receipt launch",
      status: "todo", priority: "medium", assigneeAgentId: agentAId, createdByUserId: userId, createdAt, updatedAt: createdAt });
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: userId,
      action: "issue.created", entityType: "issue", entityId: issueId, createdAt,
      details: { parentId: null, assigneeAgentId: agentAId, assigneeUserId: null } });
    const app = createApp(userId, true);
    const repeated = await request(app).patch(`/api/issues/${issueId}`).send({ status: "backlog", assigneeAgentId: agentAId });
    expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
    const repeatedEvent = (await db.select().from(activityLog)).find(row => row.action === "issue.updated" && row.entityId === issueId)!;
    expect(repeatedEvent).toMatchObject({ actorType: "user", actorId: userId });
    const details = repeatedEvent.details as Record<string, any>;
    expect(details.assigneeAgentId).toBe(agentAId);
    expect(Object.keys(details.changes)).toContain("status");
    expect(details.changes).not.toHaveProperty("assigneeAgentId");
    expect(details._previous).not.toHaveProperty("assigneeAgentId");
    const timeline = async () => {
      const response = await request(app).get(`/api/companies/${companyId}/timeline`)
        .query({ issueId, from: new Date(createdAt.getTime() - 1000).toISOString(), to: new Date().toISOString() });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body;
    };
    const unchanged = await timeline();
    expect(unchanged.events.filter((event: { kind: string }) => event.kind === "assigned")).toEqual([]);
    expect(unchanged.edges.filter((edge: { kind: string }) => edge.kind === "assignment")).toEqual([
      { fromActorId: `user:${userId}`, toActorId: `agent:${agentAId}`, issueId, at: createdAt.toISOString(), kind: "assignment" },
    ]);
    const reassigned = await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: agentBId });
    expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);
    const changed = await timeline();
    expect(changed.events.filter((event: { kind: string }) => event.kind === "assigned")).toEqual([
      expect.objectContaining({ actorId: `user:${userId}`, issueId, kind: "assigned" }),
    ]);
    expect(changed.edges.filter((edge: { kind: string }) => edge.kind === "assignment")).toEqual(expect.arrayContaining([
      { fromActorId: `user:${userId}`, toActorId: `agent:${agentAId}`, issueId, at: createdAt.toISOString(), kind: "assignment" },
      expect.objectContaining({ fromActorId: `user:${userId}`, toActorId: `agent:${agentBId}`, issueId }),
    ]));
    const unassigned = await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: null });
    expect(unassigned.status, JSON.stringify(unassigned.body)).toBe(200);
    const cleared = await timeline();
    const removal = (await db.select().from(activityLog)).find(row => row.entityId === issueId
      && (row.details as any)?.changes?.assigneeAgentId?.to === null)!;
    expect(cleared.events).toContainEqual({ actorId: `user:${userId}`, kind: "unassigned", issueId, at: removal.createdAt.toISOString() });
    const responseSchema = (buildOpenApiSpec() as any).paths["/api/companies/{companyId}/timeline"]
      .get.responses["200"].content["application/json"].schema;
    const documentedKinds = responseSchema.properties.events.items.properties.kind.enum;
    expect(cleared.events.every((event: { kind: string }) => documentedKinds.includes(event.kind))).toBe(true);
    expect(cleared.edges.filter((edge: { kind: string }) => edge.kind === "assignment")).toEqual(changed.edges.filter((edge: { kind: string }) => edge.kind === "assignment"));
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
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
  it("uses immutable creation assignment and delegation receipts despite later ownership", async () => {
    const { companyId, userId, agentAId, agentBId } = await seedBase();
    const parentId = randomUUID(), issueId = randomUUID();
    const createdAt = new Date("2026-03-01T11:00:00Z");
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Parent", status: "done", createdByUserId: userId, assigneeAgentId: agentBId,
        createdAt: new Date("2026-03-01T10:00:00Z"), updatedAt: new Date("2026-03-03T10:00:00Z") },
      { id: issueId, companyId, title: "Child", parentId, status: "done", createdByAgentId: agentAId, assigneeAgentId: agentAId,
        createdAt, updatedAt: new Date("2026-03-03T10:00:00Z") },
    ]);
    // This is the immutable receipt shape written by the native create_task authority.
    await db.insert(activityLog).values([
      { companyId, actorType: "agent", actorId: agentAId, action: "issue.created", entityType: "issue", entityId: issueId,
        createdAt, details: { identifier: "TL-child", title: "Child", parentId, assigneeAgentId: agentBId,
          assigneeUserId: null, status: "todo", source: "paperclip_runner_protocol" } },
      { companyId, actorType: "user", actorId: userId, action: "issue.updated", entityType: "issue", entityId: issueId,
        createdAt: new Date("2026-03-03T10:00:00Z"), details: { changes: { assigneeAgentId: { from: agentBId, to: agentAId } } } },
    ]);
    const response = await request(createApp()).get(`/api/companies/${companyId}/timeline`)
      .query({ limit: 1, from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.edges).toEqual(expect.arrayContaining([
      { fromActorId: `agent:${agentAId}`, toActorId: `agent:${agentBId}`, issueId, at: createdAt.toISOString(), kind: "assignment" },
      { fromActorId: `agent:${agentAId}`, toActorId: `agent:${agentBId}`, issueId, at: createdAt.toISOString(), kind: "delegation" },
    ]));
    expect(response.body.events).toContainEqual({ actorId: `agent:${agentAId}`, issueId, at: createdAt.toISOString(), kind: "delegated" });
  });

  it("does not infer creation ownership when immutable assignment metadata is absent", async () => {
    const { companyId, userId, agentAId } = await seedBase();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Unknown creation owner", status: "done",
      createdByUserId: userId, assigneeAgentId: agentAId, createdAt: new Date("2026-03-01T10:00:00Z") });
    const response = await request(createApp()).get(`/api/companies/${companyId}/timeline`)
      .query({ from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.edges).toEqual([]);
  });

  it.each(["missing", "malformed", "ambiguous", "foreign-target", "foreign-actor"] as const)("rejects %s creation assignment metadata", async kind => {
    const { companyId, agentAId, agentBId } = await seedBase();
    const foreignCompanyId = randomUUID(), foreignAgentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign", issuePrefix: "FC" });
    await db.insert(agents).values({ id: foreignAgentId, companyId: foreignCompanyId, name: "Foreign", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Invalid creation receipt", status: "done", assigneeAgentId: agentBId,
      createdByAgentId: agentAId, createdAt: new Date("2026-03-01T10:00:00Z") });
    const details = kind === "missing" ? { parentId: null }
      : kind === "malformed" ? { parentId: null, assigneeAgentId: 42, assigneeUserId: null }
      : { parentId: null, assigneeAgentId: kind === "foreign-target" ? foreignAgentId : agentBId,
          assigneeUserId: kind === "ambiguous" ? "user-1" : null };
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: kind === "foreign-actor" ? foreignAgentId : agentAId,
      action: "issue.created", entityType: "issue", entityId: issueId, details, createdAt: new Date("2026-03-01T10:00:00Z") });
    const response = await request(createApp()).get(`/api/companies/${companyId}/timeline`)
      .query({ from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.edges).toEqual([]);
  });

  it("keeps explicit user creation targets without allowing fallback target fields to override them", async () => {
    const { companyId, userId, agentAId, agentBId } = await seedBase();
    const issueId = randomUUID(), createdAt = new Date("2026-03-01T10:00:00Z");
    await db.insert(issues).values({ id: issueId, companyId, title: "User creation owner", status: "done", createdByAgentId: agentAId, createdAt });
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentAId, action: "issue.created",
      entityType: "issue", entityId: issueId, createdAt,
      details: { parentId: null, assigneeAgentId: null, assigneeUserId: userId, toAgentId: agentBId } });
    const response = await request(createApp()).get(`/api/companies/${companyId}/timeline`)
      .query({ from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.edges).toEqual([{ fromActorId: `agent:${agentAId}`, toActorId: `user:${userId}`,
      issueId, at: createdAt.toISOString(), kind: "assignment" }]);
  });

  it.each([{}, { assigneeAgentId: 42 }, { changes: { assigneeAgentId: { from: "old", to: 42 } } }])("does not label missing or malformed assignment targets as unassignment: %j", async details => {
    const { companyId, userId } = await seedBase();
    const issueId = randomUUID(), createdAt = new Date("2026-03-01T10:00:00Z");
    await db.insert(issues).values({ id: issueId, companyId, title: "Unknown assignment target", status: "done", createdAt });
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: userId, action: "issue.assignment",
      entityType: "issue", entityId: issueId, createdAt, details });
    const response = await request(createApp()).get(`/api/companies/${companyId}/timeline`)
      .query({ from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.events.filter((event: { kind: string }) => event.kind === "unassigned")).toEqual([]);
    expect(response.body.edges).toEqual([]);
  });

  it.each(["unreadable-parent", "foreign-parent", "outside-window", "missing-parent", "malformed-parent"] as const)("does not fabricate delegation from %s creation evidence", async kind => {
    const { companyId, userId, agentAId, agentBId } = await seedBase();
    const issueId = randomUUID(), parentId = randomUUID(), foreignCompanyId = randomUUID();
    const createdAt = new Date("2026-03-01T11:00:00Z");
    await db.insert(companies).values({ id: foreignCompanyId, name: "Other", issuePrefix: "OP" });
    await db.insert(issues).values([
      { id: parentId, companyId: kind === "foreign-parent" ? foreignCompanyId : companyId,
        title: "Parent", status: "done", createdByUserId: userId, createdAt: new Date("2026-03-01T10:00:00Z") },
      { id: issueId, companyId, title: "Child", parentId, status: "done", createdByAgentId: agentAId, assigneeAgentId: agentBId,
        createdAt, updatedAt: new Date("2026-03-05T10:00:00Z") },
    ]);
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentAId,
      action: "issue.created", entityType: "issue", entityId: issueId, createdAt,
      details: { ...(kind === "missing-parent" ? {} : { parentId: kind === "malformed-parent" ? 42 : parentId }),
        assigneeAgentId: agentBId, assigneeUserId: null, source: "paperclip_runner_protocol" } });
    const result = await workTimelineService(db).getTimeline({ companyId,
      from: new Date(kind === "outside-window" ? "2026-03-05T00:00:00Z" : "2026-03-01T00:00:00Z"),
      to: new Date(kind === "outside-window" ? "2026-03-06T00:00:00Z" : "2026-03-02T00:00:00Z"),
      canReadIssue: async issue => kind !== "unreadable-parent" || issue.id !== parentId });
    expect(result.edges.filter(edge => edge.kind === "delegation")).toEqual([]);
    expect(result.events.filter(event => event.kind === "delegated")).toEqual([]);
    expect(result.edges.filter(edge => edge.kind === "assignment")).toHaveLength(kind === "outside-window" ? 0 : 1);
  });

  it.each([["agent", "alias"], ["agent", "primary"], ["user", "alias"], ["user", "primary"]] as const)("retains explicit legacy %s %s clears", async (owner, field) => {
    const { companyId, userId, agentAId } = await seedBase();
    const issueId = randomUUID(), at = new Date("2026-03-01T11:00:00Z");
    await db.insert(issues).values({ id: issueId, companyId, title: "Legacy clear", status: "done", createdAt: at });
    const primary = owner === "agent" ? "assigneeAgentId" : "assigneeUserId";
    const alias = owner === "agent" ? "toAgentId" : "toUserId";
    const target = owner === "agent" ? agentAId : userId;
    const details = field === "alias" ? { [alias]: null } : { [primary]: null, [alias]: target };
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: userId, action: "issue.assigned",
      entityType: "issue", entityId: issueId, createdAt: at, details });
    const response = await request(createApp()).get(`/api/companies/${companyId}/timeline`)
      .query({ from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.events.filter((event: { kind: string }) => event.kind !== "created")).toEqual([
      { actorId: `user:${userId}`, kind: "unassigned", issueId, at: at.toISOString() },
    ]);
    expect(response.body.edges).toEqual([]);
  });

  it("uses indexed UUID lookups for creation agent identities without unsafe casts", async () => {
    const { companyId, agentAId, agentBId } = await seedBase();
    await db.insert(agents).values(Array.from({ length: 1000 }, () => ({ companyId, name: "Other agent", role: "engineer", adapterType: "codex_local" })));
    await db.execute(sql`analyze agents`);
    const issueId = randomUUID(), at = new Date("2026-03-01T11:00:00Z");
    await db.insert(issues).values({ id: issueId, companyId, title: "Indexed creation", status: "done", createdAt: at });
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentAId, action: "issue.created",
      entityType: "issue", entityId: issueId, createdAt: at,
      details: { parentId: null, assigneeAgentId: agentBId, assigneeUserId: null } });
    const queries: { query: string; parameters: unknown[] }[] = [];
    const previousDebug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query, parameters) => queries.push({ query, parameters });
    try {
      await workTimelineService(db).getTimeline({ companyId, from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-03-02T00:00:00Z") });
    } finally { db.$client.options.debug = previousDebug; }
    const receipt = queries.find(row => row.query.includes('from "activity_log"') && row.query.includes('"details"') && !row.query.includes("join"))!;
    const explain = await db.$client.unsafe(`explain (analyze, format json) ${receipt.query}`, receipt.parameters as any[]);
    const nodes = (plan: any): any[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
    const scans = nodes(explain[0]!["QUERY PLAN"][0].Plan).filter(node => node["Relation Name"] === "agents");
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every(node => /Index/.test(node["Node Type"]) && /\bid\b\s*=/.test(node["Index Cond"] ?? ""))).toBe(true);
    expect(scans.some(node => node["Actual Loops"] > 0)).toBe(true);
    console.info("Creation agent identity plan", JSON.stringify(scans.map(node => ({ type: node["Node Type"], index: node["Index Name"], condition: node["Index Cond"], loops: node["Actual Loops"], rows: node["Actual Rows"] }))));
  });

  it("preserves the initial owner from the real ordinary REST create receipt without parent metadata", async () => {
    const { companyId, userId, agentAId } = await seedBase();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.companyId, companyId));
    const app = createApp(userId, true);
    const created = await request(app).post(`/api/companies/${companyId}/issues`)
      .send({ title: "Ordinary created owner", status: "backlog", assigneeAgentId: agentAId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const issueId = created.body.id;
    const receipt = (await db.select().from(activityLog)).find(row => row.action === "issue.created" && row.entityId === issueId)!;
    expect(receipt.details).toMatchObject({ assigneeAgentId: agentAId, assigneeUserId: null });
    expect(receipt.details).not.toHaveProperty("parentId");
    const response = await request(app).get(`/api/companies/${companyId}/timeline`).query({ issueId,
      from: new Date(receipt.createdAt.getTime() - 1000).toISOString(), to: new Date().toISOString() });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.edges).toEqual([{ fromActorId: `user:${userId}`, toActorId: `agent:${agentAId}`,
      issueId, at: receipt.createdAt.toISOString(), kind: "assignment" }]);
    expect(response.body.events.filter((event: { kind: string }) => event.kind === "delegated")).toEqual([]);
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
  });

  registerTimelineReceiptBoundaryCases({ getDb: () => db, seedBase, createApp });

});
