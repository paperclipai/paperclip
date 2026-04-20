import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  labels,
  projectLabels,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { currentUtcMonthWindow, dashboardService } from "../services/dashboard.js";

describe("dashboardService UTC month window", () => {
  it("derives month boundaries from UTC fields and ends at the next UTC month", () => {
    const now = {
      getFullYear: () => 2026,
      getMonth: () => 3,
      getUTCFullYear: () => 2026,
      getUTCMonth: () => 2,
    } as unknown as Date;

    const window = currentUtcMonthWindow(now);

    expect(window.start.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dashboardService.summary", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof dashboardService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-service-");
    db = createDb(tempDb.connectionString);
    svc = dashboardService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projectLabels);
    await db.delete(labels);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("adds stale issue, recent activity, and live run summaries for the company", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockedIssueId = randomUUID();
    const staleIssueId = randomUUID();
    const activeIssueId = randomUUID();
    const activeRunId = randomUUID();
    const fixedNow = new Date("2026-04-15T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      budgetMonthlyCents: 1_000,
      devValueHourlyRateCents: 20_000,
      devValueTokensPerHour: 100,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "OpenClawOps",
      role: "manager",
      status: "running",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked onboarding dependency",
        identifier: "PAP-10",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
        updatedAt: new Date("2026-04-15T10:40:00.000Z"),
      },
      {
        id: staleIssueId,
        companyId,
        title: "Stale implementation task",
        identifier: "PAP-11",
        status: "in_progress",
        priority: "critical",
        assigneeAgentId: agentId,
        updatedAt: new Date("2026-04-15T10:20:00.000Z"),
      },
      {
        id: activeIssueId,
        companyId,
        title: "Actively running task",
        identifier: "PAP-12",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        updatedAt: new Date("2026-04-15T11:50:00.000Z"),
      },
    ]);

    await db.insert(issueComments).values([
      {
        companyId,
        issueId: staleIssueId,
        authorAgentId: agentId,
        body: "Still waiting on the final review.",
        createdAt: new Date("2026-04-15T10:30:00.000Z"),
      },
      {
        companyId,
        issueId: activeIssueId,
        authorAgentId: agentId,
        body: "Preview server is up and healthy.",
        createdAt: new Date("2026-04-15T11:55:00.000Z"),
      },
    ]);

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: staleIssueId,
        agentId,
        details: { status: "in_progress" },
        createdAt: new Date("2026-04-15T10:15:00.000Z"),
      },
      {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: activeIssueId,
        agentId,
        details: { comment: "Preview server is up and healthy." },
        createdAt: new Date("2026-04-15T11:56:00.000Z"),
      },
      {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "heartbeat.invoked",
        entityType: "heartbeat_run",
        entityId: activeRunId,
        agentId,
        details: { issueId: activeIssueId },
        createdAt: new Date("2026-04-15T11:57:00.000Z"),
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "system",
      startedAt: new Date("2026-04-15T11:54:00.000Z"),
      createdAt: new Date("2026-04-15T11:54:00.000Z"),
      updatedAt: new Date("2026-04-15T11:58:00.000Z"),
      contextSnapshot: {
        issueId: activeIssueId,
      },
    });

    await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId: activeIssueId,
      heartbeatRunId: activeRunId,
      provider: "openai",
      biller: "openai",
      billingType: "tokens",
      model: "gpt-5.4",
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      costCents: 250,
      occurredAt: new Date("2026-04-15T11:58:00.000Z"),
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId: activeIssueId,
      heartbeatRunId: activeRunId,
      provider: "openai",
      biller: "openai",
      billingType: "tokens",
      model: "gpt-5.4",
      inputTokens: 900,
      outputTokens: 90,
      cachedInputTokens: 9,
      costCents: 999,
      occurredAt: new Date("2026-03-31T23:58:00.000Z"),
    });

    const summary = await svc.summary(companyId, fixedNow);

    expect(summary.costs.monthSpendCents).toBe(250);
    expect(summary.costs.workValue).toEqual(expect.objectContaining({
      companyId,
      totalTokens: 150,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      aiSpendCents: 250,
      estimatedDevHours: 1.5,
      estimatedDevValueCents: 30_000,
      estimatedSavingsCents: 29_750,
      roiMultiple: 120,
      devValueHourlyRateCents: 20_000,
      devValueTokensPerHour: 100,
    }));
    expect(summary.liveRuns).toEqual([
      expect.objectContaining({
        id: activeRunId,
        issueId: activeIssueId,
        agentId,
        agentName: "OpenClawOps",
      }),
    ]);
    expect(summary.recentActivity?.map((entry) => entry.action)).toEqual([
      "heartbeat.invoked",
      "issue.comment_added",
      "issue.updated",
    ]);
    expect(summary.recentActivity?.[1]).toEqual(
      expect.objectContaining({
        issueIdentifier: "PAP-12",
        issueTitle: "Actively running task",
      }),
    );
    expect(summary.staleIssues).toEqual([
      expect.objectContaining({
        id: blockedIssueId,
        staleReason: "blocked",
      }),
      expect.objectContaining({
        id: staleIssueId,
        staleReason: "inactive",
      }),
    ]);
    expect(summary.staleIssues?.some((issue) => issue.id === activeIssueId)).toBe(false);
  });

  it("builds a 7-day Codex project estimate from current labeled project activity", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const codexLabelId = randomUUID();
    const activeProjectId = randomUUID();
    const syncedProjectId = randomUUID();
    const completedProjectId = randomUUID();
    const otherProjectId = randomUUID();
    const fixedNow = new Date("2026-04-15T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      budgetMonthlyCents: 1_000,
      devValueHourlyRateCents: 20_000,
      devValueTokensPerHour: 100,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex Engineer",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values([
      {
        id: activeProjectId,
        companyId,
        name: "Codex Projects Dashboard",
        status: "in_progress",
        createdAt: new Date("2026-04-12T12:00:00.000Z"),
      },
      {
        id: syncedProjectId,
        companyId,
        name: "AI Master Dashboard",
        status: "backlog",
        createdAt: new Date("2026-04-14T12:00:00.000Z"),
      },
      {
        id: completedProjectId,
        companyId,
        name: "Completed Codex Project",
        status: "completed",
        createdAt: new Date("2026-04-10T12:00:00.000Z"),
      },
      {
        id: otherProjectId,
        companyId,
        name: "Non Codex Project",
        status: "in_progress",
        createdAt: new Date("2026-04-09T12:00:00.000Z"),
      },
    ]);

    await db.insert(projectWorkspaces).values({
      id: randomUUID(),
      companyId,
      projectId: syncedProjectId,
      name: "Codex workspace",
      sourceType: "local_path",
      cwd: "/Users/robertdawson/AI/Codex/Codex/Project AI Master Dashboard",
      metadata: {
        source: "codex_project_sync",
      },
      isPrimary: true,
    });

    await db.insert(labels).values({
      id: codexLabelId,
      companyId,
      name: "Codex",
      color: "#3b82f6",
    });

    await db.insert(projectLabels).values([
      {
        companyId,
        projectId: activeProjectId,
        labelId: codexLabelId,
      },
      {
        companyId,
        projectId: completedProjectId,
        labelId: codexLabelId,
      },
    ]);

    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        projectId: activeProjectId,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.4",
        inputTokens: 100,
        cachedInputTokens: 25,
        outputTokens: 50,
        costCents: 0,
        occurredAt: new Date("2026-04-14T12:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        projectId: syncedProjectId,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.4",
        inputTokens: 200,
        cachedInputTokens: 25,
        outputTokens: 0,
        costCents: 0,
        occurredAt: new Date("2026-04-14T12:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        projectId: completedProjectId,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.4",
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        occurredAt: new Date("2026-04-14T12:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        projectId: activeProjectId,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.4",
        inputTokens: 9_000,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        occurredAt: new Date("2026-04-07T12:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        projectId: otherProjectId,
        provider: "openai",
        biller: "chatgpt",
        billingType: "subscription_included",
        model: "gpt-5.4",
        inputTokens: 2_000,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        occurredAt: new Date("2026-04-14T12:00:00.000Z"),
      },
    ]);

    const summary = await svc.summary(companyId, fixedNow);

    expect(summary.costs.codexProjectsEstimate).toEqual(expect.objectContaining({
      labelName: "Codex",
      windowDays: 7,
      projectCount: 2,
      activeProjectDays: 4,
      projectWeekEquivalent: 0.57,
      totalTokens: 400,
      inputTokens: 300,
      cachedInputTokens: 50,
      outputTokens: 50,
      estimatedDevHours: 0.57,
      estimatedDevValueCents: 11_429,
      trackedTokenDevHours: 4,
      devValueHourlyRateCents: 20_000,
      devValueTokensPerHour: 100,
      devHoursPerProjectWeek: 1,
    }));
    expect(summary.costs.codexProjectsEstimate.windowStart.toISOString()).toBe("2026-04-08T12:00:00.000Z");
    expect(summary.costs.codexProjectsEstimate.windowEnd.toISOString()).toBe("2026-04-15T12:00:00.000Z");
    expect(summary.costs.codexProjectsEstimate.assumption).toContain("not billed spend");
    expect(summary.costs.codexProjectsEstimate.assumption).toContain("active project-weeks");
  });
});
