import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  boardBriefAlertEvents,
  boardBriefSnapshots,
  companies,
  companyKpis,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  invites,
  issueDocuments,
  issueWorkProducts,
  issues,
  joinRequests,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { boardBriefService } from "../services/board-brief.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping board brief service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("boardBriefService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-brief-");
    db = createDb(tempDb.connectionString);
  }, 45_000);

  afterEach(async () => {
    await db.delete(boardBriefSnapshots);
    await db.delete(boardBriefAlertEvents);
    await db.delete(activityLog);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(approvals);
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(companyKpis);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  }, 45_000);

  it("builds a deterministic board brief with freshness, incidents, outputs, and manual KPIs", async () => {
    const now = new Date("2026-04-15T12:00:00.000Z");
    const companyId = randomUUID();
    const schedulerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const staleIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const documentId = randomUUID();
    const failedRunId = randomUUID();
    const inviteId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Board Co",
      issuePrefix: `BBC${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      budgetMonthlyCents: 10_000,
      criticalBoardAlertsEmailEnabled: true,
    });

    await db.insert(companyKpis).values({
      companyId,
      label: "Pipeline",
      value: "$320k",
      trend: "up",
      note: "Board-entered context",
      position: 0,
    });

    await db.insert(agents).values([
      {
        id: schedulerAgentId,
        companyId,
        name: "Ops COO",
        role: "coo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600 } },
        permissions: {},
        lastHeartbeatAt: new Date("2026-04-15T07:00:00.000Z"),
      },
      {
        id: workerAgentId,
        companyId,
        name: "Delivery Engineer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        lastHeartbeatAt: new Date("2026-04-15T11:40:00.000Z"),
      },
    ]);

    await db.insert(issues).values([
      {
        id: staleIssueId,
        companyId,
        title: "Launch partner rollout",
        status: "todo",
        priority: "high",
        assigneeAgentId: workerAgentId,
        createdAt: new Date("2026-04-14T07:00:00.000Z"),
        updatedAt: new Date("2026-04-14T07:00:00.000Z"),
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Unblock revenue dashboard",
        status: "blocked",
        priority: "critical",
        assigneeAgentId: workerAgentId,
        createdAt: new Date("2026-04-15T03:00:00.000Z"),
        updatedAt: new Date("2026-04-15T03:00:00.000Z"),
      },
    ]);

    await db.insert(approvals).values({
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: {
        title: "Approve launch budget",
        issueId: blockedIssueId,
      },
      createdAt: new Date("2026-04-14T22:30:00.000Z"),
      updatedAt: new Date("2026-04-14T22:30:00.000Z"),
    });

    await db.insert(invites).values({
      id: inviteId,
      companyId,
      tokenHash: "token-hash",
      expiresAt: new Date("2026-04-16T12:00:00.000Z"),
    });

    await db.insert(joinRequests).values({
      id: randomUUID(),
      inviteId,
      companyId,
      requestType: "human",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      requestEmailSnapshot: "director@example.com",
      createdAt: new Date("2026-04-14T08:00:00.000Z"),
      updatedAt: new Date("2026-04-14T08:00:00.000Z"),
    });

    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId: workerAgentId,
        status: "failed",
        startedAt: new Date("2026-04-15T11:00:00.000Z"),
        finishedAt: new Date("2026-04-15T11:10:00.000Z"),
        error: "Tool execution crashed",
        contextSnapshot: { issueId: blockedIssueId },
        createdAt: new Date("2026-04-15T11:00:00.000Z"),
        updatedAt: new Date("2026-04-15T11:10:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        agentId: schedulerAgentId,
        status: "completed",
        startedAt: new Date("2026-04-15T10:30:00.000Z"),
        finishedAt: new Date("2026-04-15T10:40:00.000Z"),
        contextSnapshot: {},
        createdAt: new Date("2026-04-15T10:30:00.000Z"),
        updatedAt: new Date("2026-04-15T10:40:00.000Z"),
      },
    ]);

    await db.insert(costEvents).values({
      companyId,
      agentId: workerAgentId,
      issueId: blockedIssueId,
      billingCode: null,
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 400,
      occurredAt: new Date("2026-04-15T09:30:00.000Z"),
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Launch narrative",
      latestBody: "# Launch narrative",
      latestRevisionNumber: 1,
      createdByAgentId: workerAgentId,
      updatedByAgentId: workerAgentId,
      createdAt: new Date("2026-04-15T09:00:00.000Z"),
      updatedAt: new Date("2026-04-15T09:00:00.000Z"),
    });

    await db.insert(issueDocuments).values({
      companyId,
      issueId: blockedIssueId,
      documentId,
      key: "launch-narrative",
      createdAt: new Date("2026-04-15T09:00:00.000Z"),
      updatedAt: new Date("2026-04-15T09:00:00.000Z"),
    });

    await db.insert(documentRevisions).values({
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Launch narrative",
      body: "# Launch narrative",
      changeSummary: "First board draft",
      createdByAgentId: workerAgentId,
      createdAt: new Date("2026-04-15T09:00:00.000Z"),
    });

    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: blockedIssueId,
      type: "pull_request",
      provider: "github",
      title: "PR #42",
      url: "https://example.com/pr/42",
      status: "ready_for_review",
      reviewState: "needs_board_review",
      isPrimary: true,
      healthStatus: "healthy",
      summary: "Ready for board review",
      createdAt: new Date("2026-04-15T10:00:00.000Z"),
      updatedAt: new Date("2026-04-15T10:30:00.000Z"),
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: workerAgentId,
      agentId: workerAgentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: blockedIssueId,
      createdAt: new Date("2026-04-15T03:15:00.000Z"),
      details: { summary: "Still blocked on launch data source." },
    });

    const brief = await boardBriefService(db).build(companyId, now);

    expect(brief.health.tone).toBe("blocked");
    expect(brief.confidence).toBe("low");
    expect(brief.freshness.execution.status).toBe("stale");
    expect(brief.freshness.cost.status).toBe("stale");
    expect(brief.manualKpis).toHaveLength(1);
    expect(brief.snapshot.outputs.value).toBe("2");
    expect(brief.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "work_product",
          issueId: blockedIssueId,
          title: "PR #42",
        }),
        expect.objectContaining({
          kind: "document_revision",
          issueId: blockedIssueId,
          title: "Launch narrative",
        }),
      ]),
    );
    expect(brief.actionQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "output",
          severity: "high",
          title: "PR #42",
        }),
        expect.objectContaining({
          kind: "approval",
          severity: "medium",
        }),
      ]),
    );
    expect(brief.incidents.map((incident) => incident.type)).toEqual(
      expect.arrayContaining(["stale_issue", "stale_agent", "cost_telemetry_stale"]),
    );
  });

  it("keeps the full canonical action queue even when more than seven actions are pending", async () => {
    const now = new Date("2026-04-15T12:00:00.000Z");
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Queue Co",
      issuePrefix: `QUE${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      budgetMonthlyCents: 20_000,
      criticalBoardAlertsEmailEnabled: true,
    });

    await db.insert(approvals).values(
      Array.from({ length: 8 }, (_, index) => ({
        companyId,
        type: "request_board_approval" as const,
        status: "pending" as const,
        payload: {
          title: `Approval ${index + 1}`,
        },
        createdAt: new Date(now.getTime() - index * 60_000),
        updatedAt: new Date(now.getTime() - index * 60_000),
      })),
    );

    const brief = await boardBriefService(db).build(companyId, now);

    expect(brief.actionQueue).toHaveLength(8);
    expect(brief.actionQueue.map((item) => item.kind)).toEqual([
      "approval",
      "approval",
      "approval",
      "approval",
      "approval",
      "approval",
      "approval",
      "approval",
    ]);
  });
});
