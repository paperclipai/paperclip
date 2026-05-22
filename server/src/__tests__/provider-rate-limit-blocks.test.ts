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
  providerRateLimitBlockMembers,
  providerRateLimitBlocks,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  seedAgent,
  seedBlock,
  seedBlockMember,
  seedCompany,
  seedHeartbeatRun,
  seedIssue,
} from "./helpers/provider-rate-limit-fixtures.js";

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

  it("keeps a due block active when quota verification still reports the window blocked", async () => {
    const companyId = await seedCompany(db);
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
    const companyId = await seedCompany(db);
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

    const developerId = await seedAgent(db, companyId, { name: "Developer" });
    const reviewerId = await seedAgent(db, companyId, { name: "Reviewer" });

    await seedHeartbeatRun(db, companyId, developerId, {
      id: strandedRunId,
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

    expect(result.affectedAgents).toBe(0);
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, "issue_dependencies_blocked"));
    expect(wakeups).toHaveLength(0);
  });

  it("repairs stale provider-limit recovery blockers left behind by previously resolved blocks", async () => {
    const companyId = await seedCompany(db);
    const sourceIssueId = randomUUID();
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

    const developerId = await seedAgent(db, companyId, { name: "Developer" });
    const strandedRunId = await seedHeartbeatRun(db, companyId, developerId, {
      errorCode: "provider_rate_limit",
      error: "You've hit your limit",
      contextSnapshot: { issueId: sourceIssueId, wakeReason: "issue_assigned" },
      finishedAt: new Date("2026-05-11T04:00:00.000Z"),
    });
    await seedIssue(db, companyId, {
      id: sourceIssueId,
      title: "Source work",
      status: "blocked",
      assigneeAgentId: developerId,
      executionRunId: strandedRunId,
    });

    const result = await svc.recoverLegacyResolvedBlocks(new Date("2026-05-13T09:05:00.000Z"));

    expect(result.checked).toBe(1);
    expect(result.recoveredIssues).toBe(1);
  });

  it("does not unblock agent-assigned issues when released provider members have no issue id", async () => {
    const svc = providerRateLimitService(db);
    const now = new Date("2026-05-06T07:32:00.000Z");
    const companyId = await seedCompany(db);
    const agentId = await seedAgent(db, companyId, {
      status: "paused",
      pauseReason: "provider_rate_limit",
      pausedAt: new Date(now.getTime() - 60_000),
    });
    const issueId = await seedIssue(db, companyId, {
      title: "Budget-blocked issue",
      status: "blocked",
      assigneeAgentId: agentId,
      updatedAt: now,
    });

    const block = await seedBlock(db, companyId, {
      resetsAt: new Date(now.getTime() - 1_000),
      createdAt: new Date(now.getTime() - 60_000),
      updatedAt: now,
    });
    await seedBlockMember(db, {
      blockId: block.id,
      companyId,
      agentId,
      issueId: null,
      originalAgentStatus: "running",
    });

    await svc.releaseAndResumeForBlock(block);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("blocked");
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent?.status).toBe("idle");
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(0);
  });

  it("does not fan out reset wakeups for memberless legacy blocks", async () => {
    const svc = providerRateLimitService(db);
    const now = new Date("2026-05-06T07:32:00.000Z");
    const companyId = await seedCompany(db);
    const firstAgentId = await seedAgent(db, companyId, {
      status: "paused",
      pauseReason: "provider_rate_limit",
      pausedAt: new Date(now.getTime() - 60_000),
    });
    const secondAgentId = await seedAgent(db, companyId, {
      status: "paused",
      pauseReason: "provider_rate_limit",
      pausedAt: new Date(now.getTime() - 60_000),
    });
    const idleAgentId = await seedAgent(db, companyId, {
      status: "idle",
    });

    const block = await seedBlock(db, companyId, {
      resetsAt: new Date(now.getTime() - 1_000),
      createdAt: new Date(now.getTime() - 60_000),
      updatedAt: now,
    });

    const result = await svc.releaseAndResumeForBlock(block);

    expect(result).toMatchObject({ affectedAgents: 2, resumed: 2, wakeupsQueued: 0 });
    const agentRows = await db
      .select({ id: agents.id, status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(agentRows.find((agent) => agent.id === firstAgentId)).toMatchObject({ status: "idle", pauseReason: null });
    expect(agentRows.find((agent) => agent.id === secondAgentId)).toMatchObject({ status: "idle", pauseReason: null });
    expect(agentRows.find((agent) => agent.id === idleAgentId)).toMatchObject({ status: "idle", pauseReason: null });
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(0);
  });

  it("records issue scope only for the source agent when pausing an adapter block", async () => {
    const svc = providerRateLimitService(db);
    const companyId = await seedCompany(db);
    const sourceAgentId = await seedAgent(db, companyId, { name: "Source" });
    const otherAgentId = await seedAgent(db, companyId, { name: "Other" });
    const issueId = await seedIssue(db, companyId, { assigneeAgentId: sourceAgentId });
    const runId = await seedHeartbeatRun(db, companyId, sourceAgentId, {
      status: "failed",
      errorCode: "provider_rate_limit",
      contextSnapshot: { issueId },
    });
    const block = await seedBlock(db, companyId);

    await svc.pauseAgentsForBlock(companyId, "claude_local", null, {
      blockId: block.id,
      sourceAgentId,
      issueId,
      runId,
    });

    const members = await db
      .select()
      .from(providerRateLimitBlockMembers)
      .where(eq(providerRateLimitBlockMembers.blockId, block.id));
    expect(members).toHaveLength(2);
    expect(members.find((member) => member.agentId === sourceAgentId)).toMatchObject({ issueId, runId });
    expect(members.find((member) => member.agentId === otherAgentId)).toMatchObject({ issueId: null, runId: null });
  });

  it("releases only a changed-scope provider pause and keeps the original provider block active", async () => {
    const svc = providerRateLimitService(db);
    const now = new Date("2026-05-06T08:00:00.000Z");
    const companyId = await seedCompany(db);
    const blockId = randomUUID();

    const releasedAgentId = await seedAgent(db, companyId, {
      name: "Codex",
      status: "paused",
      pauseReason: "provider_rate_limit",
      pausedAt: new Date(now.getTime() - 60_000),
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.3-codex" },
    });
    const stillBlockedAgentId = await seedAgent(db, companyId, {
      name: "Claude",
      status: "paused",
      pauseReason: "provider_rate_limit",
      pausedAt: new Date(now.getTime() - 60_000),
      adapterConfig: { model: "claude-opus-4-7" },
    });
    const issueId = await seedIssue(db, companyId, {
      title: "Continue after switching provider",
      status: "blocked",
      assigneeAgentId: releasedAgentId,
      updatedAt: now,
    });

    await db.insert(providerRateLimitBlocks).values({
      id: blockId,
      companyId,
      adapterType: "claude_local",
      limitKind: "seven_day_opus",
      modelFamily: "claude-opus",
      message: "Opus quota exhausted",
    });
    await seedBlockMember(db, { blockId, companyId, agentId: releasedAgentId, issueId, originalAgentStatus: "running" });
    await seedBlockMember(db, { blockId, companyId, agentId: stillBlockedAgentId, originalAgentStatus: "running" });

    const result = await svc.reconcileAgentProviderLimitPause(releasedAgentId);

    expect(result).toMatchObject({ released: true, issueIds: [issueId], wakeupsQueued: 1 });
    const [block] = await db.select().from(providerRateLimitBlocks).where(eq(providerRateLimitBlocks.id, blockId));
    expect(block?.resolvedAt).toBeNull();
    const [releasedAgent] = await db.select().from(agents).where(eq(agents.id, releasedAgentId));
    expect(releasedAgent?.status).toBe("idle");
    expect(releasedAgent?.pauseReason).toBeNull();
    const [stillBlockedAgent] = await db.select().from(agents).where(eq(agents.id, stillBlockedAgentId));
    expect(stillBlockedAgent?.status).toBe("paused");
    expect(stillBlockedAgent?.pauseReason).toBe("provider_rate_limit");
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("in_progress");
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, releasedAgentId), eq(agentWakeupRequests.reason, "provider_rate_limit_scope_changed")));
    expect(wakeups).toHaveLength(1);
  });

  it("uses the issue model profile when reconciling model-family provider pauses", async () => {
    const svc = providerRateLimitService(db);
    const companyId = await seedCompany(db);
    const blockId = randomUUID();

    const agentId = await seedAgent(db, companyId, {
      status: "paused",
      pauseReason: "provider_rate_limit",
      pausedAt: new Date(),
      adapterConfig: { model: "claude-opus-4-7" },
      runtimeConfig: {
        modelProfiles: {
          cheap: { adapterConfig: { model: "claude-sonnet-4-6" } },
        },
      },
    });
    const issueId = await seedIssue(db, companyId, {
      title: "Cheap lane",
      status: "blocked",
      assigneeAgentId: agentId,
      assigneeAdapterOverrides: { modelProfile: "cheap" },
    });

    await db.insert(providerRateLimitBlocks).values({
      id: blockId,
      companyId,
      adapterType: "claude_local",
      limitKind: "seven_day_opus",
      modelFamily: "claude-opus",
      message: "Opus quota exhausted",
    });
    await seedBlockMember(db, { blockId, companyId, agentId, issueId, originalAgentStatus: "running" });

    const result = await svc.reconcileAgentProviderLimitPause(agentId);

    expect(result.released).toBe(true);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent?.status).toBe("idle");
    const effectiveModel = await svc.resolveEffectiveRunModel({ companyId, agent: agent!, issueId });
    expect(effectiveModel).toBe("claude-sonnet-4-6");
    await expect(svc.getActiveBlockForAgent(companyId, "claude_local", effectiveModel)).resolves.toBeNull();
  });

  it("keeps Sonnet paused under a generic Claude provider block and never crosses providers", async () => {
    const svc = providerRateLimitService(db);
    const companyId = await seedCompany(db);
    const blockId = randomUUID();

    const agentId = await seedAgent(db, companyId, {
      status: "paused",
      pauseReason: "provider_rate_limit",
      pausedAt: new Date(),
    });
    const issueId = await seedIssue(db, companyId, {
      title: "Generic Claude lane",
      status: "blocked",
      assigneeAgentId: agentId,
    });

    await db.insert(providerRateLimitBlocks).values({
      id: blockId,
      companyId,
      adapterType: "claude_local",
      limitKind: "five_hour",
      modelFamily: null,
      message: "Claude quota exhausted",
    });
    await seedBlockMember(db, { blockId, companyId, agentId, issueId, originalAgentStatus: "running" });

    await expect(svc.reconcileAgentProviderLimitPause(agentId))
      .resolves.toMatchObject({ released: false, issueIds: [] });
    await expect(svc.getActiveBlockForAgent(companyId, "codex_local", "gpt-5.3-codex"))
      .resolves.toBeNull();
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent?.status).toBe("paused");
    expect(agent?.pauseReason).toBe("provider_rate_limit");
  });
});
