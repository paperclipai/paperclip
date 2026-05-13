import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  providerRateLimitBlocks,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockFetchAllQuotaWindows = vi.hoisted(() => vi.fn());

vi.mock("../services/quota-windows.ts", () => ({
  fetchAllQuotaWindows: mockFetchAllQuotaWindows,
}));

import { providerRateLimitService } from "../services/provider-rate-limits.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres provider rate-limit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("provider rate-limit block release", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-rate-limit-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("keeps a due block active when quota verification still reports the window blocked", async () => {
    const companyId = await seedCompany();
    const svc = providerRateLimitService(db);
    await svc.upsertBlock({
      companyId,
      adapterType: "claude_local",
      limitKind: "seven_day",
      modelFamily: null,
      message: "You've hit your limit",
      resetsAt: new Date("2026-05-13T07:00:00.000Z"),
    });

    mockFetchAllQuotaWindows.mockResolvedValue([
      {
        provider: "anthropic",
        ok: true,
        windows: [
          {
            windowId: "seven_day",
            label: "7 day",
            usedPercent: 100,
            resetsAt: "2026-05-13T07:00:00.000Z",
          },
        ],
      },
    ]);

    const result = await svc.releaseDueBlocks(new Date("2026-05-13T07:00:01.000Z"));

    expect(result.checked).toBe(1);
    expect(result.released).toBe(0);
    const [block] = await db
      .select()
      .from(providerRateLimitBlocks)
      .where(and(eq(providerRateLimitBlocks.companyId, companyId), isNull(providerRateLimitBlocks.resolvedAt)));
    expect(block).toBeTruthy();
  });

  it("retires provider-limit recovery blockers and restores source issue liveness on release even when agents were already unpaused", async () => {
    const companyId = await seedCompany();
    const developerId = randomUUID();
    const reviewerId = randomUUID();
    const sourceIssueId = randomUUID();
    const recoveryIssueId = randomUUID();
    const strandedRunId = randomUUID();
    const block = await providerRateLimitService(db).upsertBlock({
      companyId,
      adapterType: "claude_local",
      limitKind: "seven_day",
      modelFamily: null,
      message: "You've hit your limit",
      resetsAt: new Date("2026-05-13T07:00:00.000Z"),
    });

    await db.insert(agents).values([
      {
        id: developerId,
        companyId,
        name: "Developer",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: { model: "claude-sonnet-4-6" },
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
        permissions: {},
      },
      {
        id: reviewerId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: { model: "claude-sonnet-4-6" },
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: strandedRunId,
      companyId,
      agentId: developerId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      errorCode: "claude_hard_limit",
      error: "You've hit your limit",
      contextSnapshot: { issueId: sourceIssueId, wakeReason: "issue_assigned" },
      finishedAt: new Date("2026-05-11T04:00:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Source work",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: developerId,
      },
      {
        id: recoveryIssueId,
        companyId,
        title: "Recover stalled issue",
        status: "blocked",
        priority: "high",
        assigneeAgentId: reviewerId,
        parentId: sourceIssueId,
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
        originRunId: strandedRunId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: recoveryIssueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });

    const result = await providerRateLimitService(db).releaseAndResumeForBlock(block);

    expect(result.matchingAgents).toBe(2);
    expect(result.retiredRecoveryIssueIds).toEqual([recoveryIssueId]);
    expect(result.unblockedIssueIds).toContain(sourceIssueId);
    const [recoveryIssue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, recoveryIssueId));
    expect(recoveryIssue?.status).toBe("cancelled");
    const remainingRelations = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.issueId, recoveryIssueId), eq(issueRelations.relatedIssueId, sourceIssueId)));
    expect(remainingRelations).toHaveLength(0);
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, "issue_dependencies_blocked"));
    expect(wakeups).toHaveLength(0);
  });

  it("repairs stale provider-limit recovery blockers left behind by previously resolved blocks", async () => {
    const companyId = await seedCompany();
    const developerId = randomUUID();
    const reviewerId = randomUUID();
    const sourceIssueId = randomUUID();
    const recoveryIssueId = randomUUID();
    const strandedRunId = randomUUID();
    const svc = providerRateLimitService(db);
    const block = await svc.upsertBlock({
      companyId,
      adapterType: "claude_local",
      limitKind: "seven_day",
      modelFamily: null,
      message: "You've hit your limit",
      resetsAt: new Date("2026-05-13T07:00:00.000Z"),
    });
    await svc.resolveBlock(block.id, "system");

    await db.insert(agents).values([
      {
        id: developerId,
        companyId,
        name: "Developer",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: { model: "claude-sonnet-4-6" },
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
        permissions: {},
      },
      {
        id: reviewerId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: { model: "claude-sonnet-4-6" },
        runtimeConfig: { heartbeat: { wakeOnDemand: true } },
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: strandedRunId,
      companyId,
      agentId: developerId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      errorCode: "claude_hard_limit",
      error: "You've hit your limit",
      contextSnapshot: { issueId: sourceIssueId, wakeReason: "issue_assigned" },
      finishedAt: new Date("2026-05-11T04:00:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Source work",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: developerId,
      },
      {
        id: recoveryIssueId,
        companyId,
        title: "Recover stalled issue",
        status: "blocked",
        priority: "high",
        assigneeAgentId: reviewerId,
        parentId: sourceIssueId,
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
        originRunId: strandedRunId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: recoveryIssueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });

    const result = await svc.cleanupReleasedProviderRecoveryBlockers(new Date("2026-05-13T09:05:00.000Z"));

    expect(result.checked).toBe(1);
    expect(result.retiredRecoveryIssueIds).toEqual([recoveryIssueId]);
    expect(result.unblockedIssueIds).toEqual([sourceIssueId]);
    const [recoveryIssue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, recoveryIssueId));
    expect(recoveryIssue?.status).toBe("cancelled");
    const remainingRelations = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.issueId, recoveryIssueId), eq(issueRelations.relatedIssueId, sourceIssueId)));
    expect(remainingRelations).toHaveLength(0);
  });
});
