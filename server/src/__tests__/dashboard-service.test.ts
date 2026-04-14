import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  costEvents,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  invites,
  issues,
  joinRequests,
  projects,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping dashboard service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dashboardService executive brief", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-service-");
    db = createDb(tempDb.connectionString);
  }, 45_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(approvals);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  }, 45_000);

  it("builds a board-level brief with deterministic focus areas and attention items", async () => {
    const now = new Date();
    const companyId = randomUUID();
    const projectId = randomUUID();
    const checkoutRootId = randomUUID();
    const blockedChildId = randomUUID();
    const activeChildId = randomUUID();
    const quietIssueId = randomUUID();
    const activeAgentId = randomUUID();
    const erroredAgentId = randomUUID();
    const failedRunId = randomUUID();
    const inviteId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Comandero",
      issuePrefix: `COM${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      budgetMonthlyCents: 10_000,
    });

    await db.insert(agents).values([
      {
        id: activeAgentId,
        companyId,
        name: "Product Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: erroredAgentId,
        companyId,
        name: "QA Runner",
        role: "qa",
        status: "error",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Website",
      status: "in_progress",
    });

    await db.insert(issues).values([
      {
        id: checkoutRootId,
        companyId,
        projectId,
        title: "Checkout trust",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: activeAgentId,
        createdByUserId: "board-user",
        updatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      },
      {
        id: blockedChildId,
        companyId,
        projectId,
        parentId: checkoutRootId,
        title: "Blocked optimizer preview hides affected items",
        status: "blocked",
        priority: "high",
        createdByUserId: "board-user",
        updatedAt: new Date(now.getTime() - 60 * 60 * 1000),
      },
      {
        id: activeChildId,
        companyId,
        projectId,
        parentId: checkoutRootId,
        title: "QA re-audit after optimizer fixes",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: activeAgentId,
        createdByUserId: "board-user",
        updatedAt: new Date(now.getTime() - 30 * 60 * 1000),
      },
      {
        id: quietIssueId,
        companyId,
        title: "Minor copy cleanups",
        status: "todo",
        priority: "low",
        updatedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
      },
    ]);

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: activeAgentId,
        agentId: activeAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: blockedChildId,
        createdAt: new Date(now.getTime() - 55 * 60 * 1000),
        details: { summary: "Still blocked after latest run." },
      },
      {
        companyId,
        actorType: "agent",
        actorId: activeAgentId,
        agentId: activeAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: activeChildId,
        createdAt: new Date(now.getTime() - 25 * 60 * 1000),
        details: { summary: "Waiting for QA re-audit." },
      },
      {
        companyId,
        actorType: "agent",
        actorId: activeAgentId,
        agentId: activeAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: quietIssueId,
        createdAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
        details: { summary: "Non-urgent cleanup." },
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId: erroredAgentId,
      status: "failed",
      error: "Adapter failed",
      contextSnapshot: { issueId: activeChildId },
      createdAt: new Date(now.getTime() - 20 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 20 * 60 * 1000),
    });

    await db.insert(approvals).values([
      {
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: { title: "Hire QA lead" },
      },
      {
        companyId,
        type: "hire_agent",
        status: "approved",
        payload: { title: "Approved item should not surface" },
      },
    ]);

    await db.insert(invites).values({
      id: inviteId,
      companyId,
      tokenHash: "hash-1",
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    });

    await db.insert(joinRequests).values({
      inviteId,
      companyId,
      requestType: "human",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      requestEmailSnapshot: "exec@comandero.dev",
    });

    await db.insert(costEvents).values({
      companyId,
      agentId: activeAgentId,
      issueId: activeChildId,
      projectId,
      billingCode: null,
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 450,
      occurredAt: now,
    });

    const summary = await dashboardService(db).summary(companyId);

    expect((summary as any).brief).toBeDefined();
    expect((summary as any).brief.health).toBe("blocked");
    expect((summary as any).brief.snapshot).toEqual(
      expect.objectContaining({
        progress: expect.objectContaining({ headline: expect.any(String), tone: "healthy" }),
        risk: expect.objectContaining({ headline: expect.any(String) }),
        decisions: expect.objectContaining({ headline: expect.any(String) }),
        spend: expect.objectContaining({ headline: expect.any(String) }),
      }),
    );

    expect((summary as any).brief.focusAreas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Checkout trust",
          tone: "blocked",
          changedIssueCount: 2,
          blockedCount: 1,
          failedRunCount: 1,
          activeAgentCount: 1,
        }),
      ]),
    );

    const attentionKinds = new Set(((summary as any).brief.needsAttention as Array<{ kind: string }>).map((item) => item.kind));
    expect(attentionKinds).toEqual(new Set(["approval", "join_request", "run", "issue"]));
    const orderedKinds = ((summary as any).brief.needsAttention as Array<{ kind: string }>).map((item) => item.kind);
    expect(orderedKinds.indexOf("approval")).toBeLessThan(orderedKinds.indexOf("run"));
    expect(orderedKinds.indexOf("join_request")).toBeLessThan(orderedKinds.indexOf("run"));
    expect(orderedKinds.indexOf("run")).toBeLessThan(orderedKinds.indexOf("issue"));
    expect(((summary as any).brief.needsAttention as Array<{ title: string }>).some((item) =>
      item.title.includes("Minor copy cleanups")
    )).toBe(false);
  });

  it("returns a healthy empty brief when the company has no active work", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Quiet Co",
      issuePrefix: `QUI${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      budgetMonthlyCents: 25_000,
    });

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.brief.health).toBe("healthy");
    expect(summary.brief.focusAreas).toEqual([]);
    expect(summary.brief.needsAttention).toEqual([]);
    expect(summary.brief.snapshot.progress.value).toBe("0");
    expect(summary.brief.snapshot.decisions.value).toBe("0");
  });

  it("uses project and ops fallback buckets when no parent workstream exists", async () => {
    const now = new Date();
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectIssueId = randomUUID();
    const opsIssueId = randomUUID();
    const activeAgentId = randomUUID();
    const failedRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Fallback Co",
      issuePrefix: `FBK${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      budgetMonthlyCents: 15_000,
    });

    await db.insert(agents).values({
      id: activeAgentId,
      companyId,
      name: "Platform Engineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Growth",
      status: "in_progress",
    });

    await db.insert(issues).values([
      {
        id: projectIssueId,
        companyId,
        projectId,
        title: "Landing page relaunch",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: activeAgentId,
        updatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      },
      {
        id: opsIssueId,
        companyId,
        title: "Rotate broken API keys",
        status: "todo",
        priority: "medium",
        assigneeAgentId: activeAgentId,
        updatedAt: new Date(now.getTime() - 90 * 60 * 1000),
      },
    ]);

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: activeAgentId,
        agentId: activeAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: projectIssueId,
        createdAt: new Date(now.getTime() - 45 * 60 * 1000),
        details: { summary: "Project work moved." },
      },
      {
        companyId,
        actorType: "agent",
        actorId: activeAgentId,
        agentId: activeAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: opsIssueId,
        createdAt: new Date(now.getTime() - 30 * 60 * 1000),
        details: { summary: "Ops work moved." },
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId: activeAgentId,
      status: "failed",
      error: "Tool crashed",
      contextSnapshot: { issueId: projectIssueId },
      createdAt: new Date(now.getTime() - 20 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 20 * 60 * 1000),
    });

    const summary = await dashboardService(db).summary(companyId);
    const focusAreas = summary.brief.focusAreas;

    expect(focusAreas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Growth",
          changedIssueCount: 1,
          failedRunCount: 1,
          activeAgentCount: 1,
        }),
        expect.objectContaining({
          label: "Operational work",
          changedIssueCount: 1,
          failedRunCount: 0,
          activeAgentCount: 1,
          href: "/issues",
        }),
      ]),
    );
  });
});
