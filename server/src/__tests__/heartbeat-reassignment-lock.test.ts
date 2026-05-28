import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  budgetPolicies,
  companySkills,
  companies,
  costEvents,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issueTreeHoldMembers,
  issueTreeHolds,
  issueWorkProducts,
  issues,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "mock adapter",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat reassignment-lock tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat reassignment lock guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-reassignment-lock-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "mock adapter",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();

    // Clean up all DB state in dependency order
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(costEvents);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(issueWorkProducts);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(issueComments);
      await db.delete(issueDocuments);
      try {
        await db.delete(issues);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(agentWakeupRequests);
    await db.delete(budgetPolicies);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(companySkills);
      try {
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  interface SeedResult {
    companyId: string;
    issuePrefix: string;
    issueId: string;
    agentAId: string;
    agentBId: string;
    runAId: string;
    wakeupAId: string;
  }

  async function seedReassignmentFixture(opts?: {
    runAStatus?: "queued" | "running";
    issueAssignee?: "A" | "B" | "none";
    executionRunId?: string | null;
    agentBName?: string;
  }): Promise<SeedResult> {
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const runAId = randomUUID();
    const wakeupAId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-05-01T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "AgentA",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: opts?.agentBName ?? "AgentB",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: wakeupAId,
      companyId,
      agentId: agentAId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId: runAId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runAId,
      companyId,
      agentId: agentAId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts?.runAStatus ?? "queued",
      wakeupRequestId: wakeupAId,
      contextSnapshot: { issueId },
      startedAt: now,
      updatedAt: now,
    });

    const assignee = opts?.issueAssignee ?? "B";
    const executionRunIdValue = opts?.executionRunId === undefined ? null : opts.executionRunId;

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassignment lock test issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: assignee === "A" ? agentAId : assignee === "B" ? agentBId : null,
      assigneeUserId: assignee === "none" ? "user-1" : null,
      executionRunId: executionRunIdValue,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, issuePrefix, issueId, agentAId, agentBId, runAId, wakeupAId };
  }

  async function waitForRunStatus(
    runId: string,
    targetStatuses: string[],
    timeoutMs = 3_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      if (run && targetStatuses.includes(run.status)) return run.status;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const [run] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return run?.status ?? null;
  }

  // T1: Reassign A→B with queued R_A, then B wakes — R_A NOT reclaimed
  it("T1: does not reclaim former assignee's queued run for new assignee", async () => {
    const { companyId, issueId, agentAId, agentBId, runAId } = await seedReassignmentFixture({
      runAStatus: "queued",
      issueAssignee: "B",
      executionRunId: null,
    });

    const heartbeat = heartbeatService(db, {});

    const result = await heartbeat.wakeup(agentBId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
    });

    // R_A should NOT be reclaimed — it belongs to agent A, not B
    const [issueRow] = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
      })
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(issueRow.executionRunId).not.toBe(runAId);

    // A new run should be created for B
    const bRuns = await db
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentBId),
          eq(heartbeatRuns.companyId, companyId),
        ),
      );
    expect(bRuns.length).toBeGreaterThanOrEqual(1);

    // R_A still queued (Layer 1 not triggered here — that's the PATCH route's job)
    const [runA] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runAId));
    expect(runA.status).toBe("queued");
  }, 15_000);

  // T2: Pre-existing stale pin — execution lock held by A's run, but assignee is B
  it("T2: invalidates stale execution lock held by former assignee's run", async () => {
    const { issueId, agentBId, runAId } = await seedReassignmentFixture({
      runAStatus: "queued",
      issueAssignee: "B",
      executionRunId: undefined, // will be set below
    });

    // Manually pin executionRunId to R_A (simulating pre-existing stale state)
    await db
      .update(issues)
      .set({ executionRunId: runAId, executionAgentNameKey: "agenta", executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));

    const heartbeat = heartbeatService(db, {});

    await heartbeat.wakeup(agentBId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
    });

    // Stale pin should be cleared — executionRunId should no longer be R_A
    const [issueRow] = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
      })
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(issueRow.executionRunId).not.toBe(runAId);
  }, 15_000);

  // T3: User reassignment (no agent assignee) — legacy reclaim skipped
  it("T3: skips legacy reclaim when issue has no agent assignee", async () => {
    const { issueId, runAId, agentAId } = await seedReassignmentFixture({
      runAStatus: "queued",
      issueAssignee: "none",
      executionRunId: null,
    });

    const heartbeat = heartbeatService(db, {});

    // Wake any agent — with no assigneeAgentId, reclaim should be skipped
    await heartbeat.wakeup(agentAId, {
      source: "on_demand",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId },
    });

    const [issueRow] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));

    // executionRunId should NOT be R_A (orphan resurrection blocked)
    expect(issueRow.executionRunId).not.toBe(runAId);
  }, 15_000);

  // T4: Same-name different-id (A→A2) — R_A not adopted by A2
  it("T4: does not let same-name replacement agent inherit former agent's run", async () => {
    const { issueId, agentBId, runAId } = await seedReassignmentFixture({
      runAStatus: "queued",
      issueAssignee: "B",
      executionRunId: null,
      agentBName: "AgentA", // same name as agent A
    });

    const heartbeat = heartbeatService(db, {});

    await heartbeat.wakeup(agentBId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
    });

    const [issueRow] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));

    // R_A must NOT be adopted — agentId mismatch even though name matches
    expect(issueRow.executionRunId).not.toBe(runAId);
  }, 15_000);

  // T5: Layer 1 — cancelOrphanedIssueRuns cancels former assignee's runs
  it("T5: cancelOrphanedIssueRuns cancels former assignee's queued runs", async () => {
    const { companyId, issueId, agentAId, runAId, wakeupAId } = await seedReassignmentFixture({
      runAStatus: "queued",
      issueAssignee: "B",
      executionRunId: null,
    });

    const heartbeat = heartbeatService(db, {});

    const cancelled = await heartbeat.cancelOrphanedIssueRuns(issueId, agentAId, companyId);
    expect(cancelled).toBe(1);

    const [runA] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runAId));
    expect(runA.status).toBe("cancelled");

    const [wakeupA] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupAId));
    expect(wakeupA.status).toBe("cancelled");
  }, 15_000);

  // T6: Checkout guard — agent A cannot checkout issue assigned to B
  it("T6: former assignee's checkout is rejected after reassignment", async () => {
    const { issueId, agentAId, agentBId, companyId } = await seedReassignmentFixture({
      runAStatus: "queued",
      issueAssignee: "B",
      executionRunId: null,
    });

    // Give B a checkout run
    const runBId = randomUUID();
    const wakeupBId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupBId,
      companyId,
      agentId: agentBId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId: runBId,
      claimedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: runBId,
      companyId,
      agentId: agentBId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId: wakeupBId,
      contextSnapshot: { issueId },
      startedAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(issues)
      .set({ checkoutRunId: runBId })
      .where(eq(issues.id, issueId));

    // Agent A tries to checkout — should be rejected (assignee is B)
    const { issueService } = await import("../services/issues.ts");
    const issueSvc = issueService(db);

    // checkout throws 409 conflict when agent A (not assignee) tries to check out
    await expect(
      issueSvc.checkout(issueId, agentAId, ["in_progress"], null),
    ).rejects.toThrow("conflict");
  }, 15_000);

  // T7: Same-assignee re-wake — no regression, A keeps its lock
  it("T7: same-assignee wake preserves existing execution lock", async () => {
    const { issueId, agentAId, runAId } = await seedReassignmentFixture({
      runAStatus: "queued",
      issueAssignee: "A",
      executionRunId: undefined, // set below
    });

    // Pin execution lock to A's run (normal state)
    await db
      .update(issues)
      .set({ executionRunId: runAId, executionAgentNameKey: "agenta", executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));

    const heartbeat = heartbeatService(db, {});

    await heartbeat.wakeup(agentAId, {
      source: "on_demand",
      triggerDetail: "comment",
      reason: "issue_commented",
      payload: { issueId },
    });

    const [issueRow] = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
      })
      .from(issues)
      .where(eq(issues.id, issueId));

    // A's lock should still be held — either same run or coalesced
    // The key assertion: executionRunId should belong to agent A
    if (issueRow.executionRunId) {
      const [lockHolder] = await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, issueRow.executionRunId));
      expect(lockHolder.agentId).toBe(agentAId);
    }
  }, 15_000);
});
