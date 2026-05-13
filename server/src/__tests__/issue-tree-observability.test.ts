import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildIssueTreeObservability } from "../services/issue-tree-observability.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue tree observability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue tree observability service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-tree-observability-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates descendant issue status, runs, cost, runtime, and redacted error timeline", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    const hiddenIssueId = randomUUID();
    const siblingIssueId = randomUUID();
    const rootRunId = randomUUID();
    const failedRunId = randomUUID();
    const liveRunId = randomUUID();
    const siblingRunId = randomUUID();
    const fakeBearerToken = ["sk", "test", "placeholder", "1234567890"].join("-");
    const fakePassword = ["super", "sensitive", "placeholder"].join("-");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Observability Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root roadmap",
        status: "in_progress",
        priority: "critical",
        issueNumber: 1,
        identifier: "TST-1",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child delivery",
        status: "blocked",
        priority: "high",
        issueNumber: 2,
        identifier: "TST-2",
        assigneeAgentId: agentId,
        createdAt: new Date("2026-05-01T00:01:00.000Z"),
      },
      {
        id: grandchildIssueId,
        companyId,
        parentId: childIssueId,
        title: "Grandchild verifier",
        status: "todo",
        priority: "medium",
        issueNumber: 3,
        identifier: "TST-3",
        createdAt: new Date("2026-05-01T00:02:00.000Z"),
      },
      {
        id: hiddenIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Hidden child",
        status: "done",
        priority: "low",
        issueNumber: 4,
        identifier: "TST-4",
        hiddenAt: new Date("2026-05-01T00:03:00.000Z"),
      },
      {
        id: siblingIssueId,
        companyId,
        title: "Sibling outside tree",
        status: "done",
        priority: "medium",
        issueNumber: 5,
        identifier: "TST-5",
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: rootRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-05-01T00:10:00.000Z"),
        finishedAt: new Date("2026-05-01T00:11:00.000Z"),
        contextSnapshot: { issueId: rootIssueId },
        createdAt: new Date("2026-05-01T00:10:00.000Z"),
      },
      {
        id: failedRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        startedAt: new Date("2026-05-01T00:20:00.000Z"),
        finishedAt: new Date("2026-05-01T00:22:00.000Z"),
        error: `Authorization failed for bearer ${fakeBearerToken}`,
        errorCode: "auth_failed",
        contextSnapshot: { issueId: childIssueId },
        createdAt: new Date("2026-05-01T00:20:00.000Z"),
      },
      {
        id: liveRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
        startedAt: new Date("2026-05-01T00:25:00.000Z"),
        contextSnapshot: {},
        createdAt: new Date("2026-05-01T00:25:00.000Z"),
      },
      {
        id: siblingRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-05-01T00:30:00.000Z"),
        finishedAt: new Date("2026-05-01T00:31:00.000Z"),
        contextSnapshot: { issueId: siblingIssueId },
      },
    ]);

    await db.insert(activityLog).values([
      {
        companyId,
        runId: liveRunId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "issue.checked_out",
        entityType: "issue",
        entityId: grandchildIssueId,
        createdAt: new Date("2026-05-01T00:25:10.000Z"),
      },
      {
        companyId,
        runId: siblingRunId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "issue.checked_out",
        entityType: "issue",
        entityId: siblingIssueId,
        createdAt: new Date("2026-05-01T00:30:10.000Z"),
      },
    ]);

    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: rootIssueId,
        heartbeatRunId: rootRunId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 50,
        costCents: 123,
        occurredAt: new Date("2026-05-01T00:11:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        heartbeatRunId: failedRunId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "claude-sonnet-4",
        inputTokens: 200,
        cachedInputTokens: 20,
        outputTokens: 75,
        costCents: 277,
        occurredAt: new Date("2026-05-01T00:22:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: siblingIssueId,
        heartbeatRunId: siblingRunId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 999,
        cachedInputTokens: 0,
        outputTokens: 999,
        costCents: 999,
        occurredAt: new Date("2026-05-01T00:31:00.000Z"),
      },
    ]);

    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId: failedRunId,
      agentId,
      seq: 1,
      eventType: "adapter_error",
      level: "error",
      stream: "stderr",
      message: `Request failed with password=${fakePassword} and token ${fakeBearerToken}`,
      createdAt: new Date("2026-05-01T00:21:30.000Z"),
    });

    const result = await buildIssueTreeObservability(db, companyId, rootIssueId, {
      limit: 12,
      now: new Date("2026-05-01T00:30:00.000Z"),
    });

    expect(result.issueId).toBe(rootIssueId);
    expect(result.summary).toMatchObject({
      issueCount: 3,
      activeIssueCount: 3,
      blockedIssueCount: 1,
      runCount: 3,
      activeRunCount: 1,
      failedRunCount: 1,
      errorEventCount: 1,
      costCents: 400,
      inputTokens: 300,
      cachedInputTokens: 30,
      outputTokens: 125,
    });
    expect(result.summary.runtimeMs).toBe(60_000 + 120_000 + 5 * 60_000);

    const childNode = result.nodes.find((node) => node.id === childIssueId);
    expect(childNode).toMatchObject({
      identifier: "TST-2",
      depth: 1,
      runCount: 1,
      failedRunCount: 1,
      costCents: 277,
      errorEventCount: 1,
    });
    expect(result.nodes.some((node) => node.id === hiddenIssueId)).toBe(false);

    expect(result.timeline.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["run", "cost", "error", "activity"]),
    );
    expect(result.timeline.some((entry) => entry.runId === siblingRunId)).toBe(false);
    const timelineText = JSON.stringify(result.timeline);
    expect(timelineText).toContain("[REDACTED]");
    expect(timelineText).not.toContain(fakePassword);
    expect(timelineText).not.toContain(fakeBearerToken);
  });
});
