/**
 * Tests for FUL-11100: defer direct-wake runs when the target issue's
 * execution workspace is held by another active run.
 *
 * Scenario:
 *   1. Issue A has a queued heartbeat run (direct wake: issue_assigned,
 *      board comment, review continuation, etc.).
 *   2. Issue B holds an active executionRunId on the SAME executionWorkspace.
 *   3. claimQueuedRun() must keep the queued run in "queued" state and NOT
 *      start the adapter, to avoid the adapter_failed "worktree already held"
 *      loop.
 *   4. When Issue B's run clears its executionRunId, the next call to
 *      startNextQueuedRunForAgent (via releaseIssueExecutionAndPromote) picks
 *      up the deferred run normally.
 *
 * Covers:
 *   - Direct wake deferral when workspace is held (running holder)
 *   - Deferral when holder run is queued (not yet running)
 *   - Deferral when holder run is scheduled_retry
 *   - Cross-project isolation: different executionWorkspaceId → no block
 *   - Null-workspace bypass: issue with no executionWorkspaceId → no block
 *   - Adapter is not invoked for deferred wakes (no adapter_failed run)
 *   - Activity log records the defer with holder identifiers only
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "ok",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));
vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
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
    `Skipping direct-wake worktree-defer tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("claimQueuedRun — direct-wake workspace-held deferral", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-direct-wake-worktree-defer-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(executionWorkspaces);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seeds the minimal fixture:
   *   - company + agent
   *   - project + executionWorkspace
   *   - deferred issue (todo, queued wake) — the issue we want to start
   *   - holding issue with an active executionRunId on the same (or different) workspace
   */
  async function seedDirectWakeFixture(opts: {
    holderRunStatus?: "running" | "queued" | "scheduled_retry";
    deferredHasSameWorkspace?: boolean;
    deferredExecutionWorkspaceId?: string | null;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const altWorkspaceId = randomUUID();
    const deferredIssueId = randomUUID();
    const holderIssueId = randomUUID();
    const deferredWakeId = randomUUID();
    const deferredRunId = randomUUID();
    const holderWakeId = randomUUID();
    const holderRunId = randomUUID();
    const now = new Date("2026-06-13T10:00:00.000Z");
    const issuePrefix = `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Help2day-test",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Platform Lead",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true } },
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Runtime",
    });

    await db.insert(executionWorkspaces).values([
      {
        id: workspaceId,
        companyId,
        projectId,
        mode: "shared",
        strategyType: "git_worktree",
        name: "main-worktree",
      },
      {
        id: altWorkspaceId,
        companyId,
        projectId,
        mode: "shared",
        strategyType: "git_worktree",
        name: "alt-worktree",
      },
    ]);

    // Determine the deferred issue's workspace link
    const deferredWorkspaceId =
      opts.deferredExecutionWorkspaceId !== undefined
        ? opts.deferredExecutionWorkspaceId
        : opts.deferredHasSameWorkspace === false
          ? altWorkspaceId
          : workspaceId;

    // Deferred issue — todo, assigned, no active executionRunId
    await db.insert(issues).values({
      id: deferredIssueId,
      companyId,
      title: "Deferred issue (direct wake target)",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      projectId,
      executionWorkspaceId: deferredWorkspaceId,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    // Queued wakeup + run for the deferred issue (the direct wake)
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: deferredIssueId },
      status: "queued",
      runId: deferredRunId,
      claimedAt: null,
    });
    await db.insert(heartbeatRuns).values({
      id: deferredRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: deferredWakeId,
      contextSnapshot: {
        issueId: deferredIssueId,
        taskId: deferredIssueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
    });

    // Holder issue — active run holding the workspace
    await db.insert(agentWakeupRequests).values({
      id: holderWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: holderIssueId },
      status: "claimed",
      runId: holderRunId,
      claimedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts.holderRunStatus ?? "running",
      wakeupRequestId: holderWakeId,
      contextSnapshot: {
        issueId: holderIssueId,
        taskId: holderIssueId,
        wakeReason: "issue_assigned",
      },
      startedAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: holderIssueId,
      companyId,
      title: "Holder issue (active run on workspace)",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      projectId,
      executionWorkspaceId: workspaceId, // always on the primary workspace
      executionRunId: holderRunId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
      startedAt: now,
    });

    return {
      companyId,
      agentId,
      projectId,
      workspaceId,
      altWorkspaceId,
      deferredIssueId,
      holderIssueId,
      deferredRunId,
      holderRunId,
    };
  }

  it("keeps queued run in queued state when workspace is held by a running holder", async () => {
    const { companyId, deferredIssueId, holderIssueId, deferredRunId, holderRunId } =
      await seedDirectWakeFixture({ holderRunStatus: "running" });

    await heartbeat.resumeQueuedRuns();

    // Adapter must NOT have been called
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    // Deferred run must stay queued (not running or failed)
    const deferredRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, deferredRunId))
      .then((rows) => rows[0] ?? null);
    expect(deferredRun?.status).toBe("queued");

    // Activity log must capture the defer with holder identifiers
    const deferActivity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.direct_wake.workspace_held_defer"),
          eq(activityLog.entityId, deferredRunId),
        ),
      );
    expect(deferActivity).toHaveLength(1);
    expect(deferActivity[0]?.details).toMatchObject({
      issueId: deferredIssueId,
      heldByIssueId: holderIssueId,
      heldByRunId: holderRunId,
    });
  });

  it("keeps queued run deferred when holder run is in queued status", async () => {
    const { deferredRunId } = await seedDirectWakeFixture({ holderRunStatus: "queued" });

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const deferredRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, deferredRunId))
      .then((rows) => rows[0] ?? null);
    expect(deferredRun?.status).toBe("queued");
  });

  it("keeps queued run deferred when holder run is in scheduled_retry status", async () => {
    const { deferredRunId } = await seedDirectWakeFixture({ holderRunStatus: "scheduled_retry" });

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const deferredRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, deferredRunId))
      .then((rows) => rows[0] ?? null);
    expect(deferredRun?.status).toBe("queued");
  });

  it("does not defer when deferred issue uses a different execution workspace (cross-project isolation)", async () => {
    const { companyId, deferredRunId } = await seedDirectWakeFixture({
      holderRunStatus: "running",
      deferredHasSameWorkspace: false,
    });

    await heartbeat.resumeQueuedRuns();

    // claimQueuedRun transitions the run from "queued" → "running" synchronously
    // before spawning executeRun. Verify the guard did not block it.
    const deferredRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, deferredRunId))
      .then((rows) => rows[0] ?? null);
    expect(deferredRun?.status).not.toBe("queued");

    // No workspace-held-defer activity should have been logged
    const deferActivity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.direct_wake.workspace_held_defer"),
        ),
      );
    expect(deferActivity).toHaveLength(0);
  });

  it("does not defer when deferred issue has no executionWorkspaceId (null-workspace bypass)", async () => {
    const { companyId, deferredRunId } = await seedDirectWakeFixture({
      holderRunStatus: "running",
      deferredExecutionWorkspaceId: null,
    });

    await heartbeat.resumeQueuedRuns();

    // Null workspace means no hold can apply — run should have been claimed
    const deferredRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, deferredRunId))
      .then((rows) => rows[0] ?? null);
    expect(deferredRun?.status).not.toBe("queued");

    const deferActivity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.direct_wake.workspace_held_defer"),
        ),
      );
    expect(deferActivity).toHaveLength(0);
  });

  it("proceeds when holder run completes and releases the workspace", async () => {
    const { holderIssueId, holderRunId, deferredRunId } = await seedDirectWakeFixture({
      holderRunStatus: "running",
    });

    // First pass: workspace is held, run stays queued
    await heartbeat.resumeQueuedRuns();
    const runAfterFirst = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, deferredRunId))
      .then((rows) => rows[0] ?? null);
    expect(runAfterFirst?.status).toBe("queued");

    // Simulate holder run completing: clear executionRunId on holder issue
    await db
      .update(issues)
      .set({ executionRunId: null, updatedAt: new Date() })
      .where(eq(issues.id, holderIssueId));
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, holderRunId));

    // Second pass: workspace released, run should be claimed (transitions to running)
    await heartbeat.resumeQueuedRuns();
    const runAfterSecond = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, deferredRunId))
      .then((rows) => rows[0] ?? null);
    expect(runAfterSecond?.status).not.toBe("queued");
  });

  it("activity log details contain only issue/run identifiers (sanitized)", async () => {
    const { companyId, deferredIssueId, holderIssueId, deferredRunId, holderRunId, workspaceId } =
      await seedDirectWakeFixture({ holderRunStatus: "running" });

    await heartbeat.resumeQueuedRuns();

    const deferActivity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.direct_wake.workspace_held_defer"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    expect(deferActivity).not.toBeNull();
    const details = deferActivity?.details as Record<string, unknown>;
    // Must include workspace + holder identifiers
    expect(details.executionWorkspaceId).toBe(workspaceId);
    expect(details.heldByIssueId).toBe(holderIssueId);
    expect(details.heldByRunId).toBe(holderRunId);
    expect(details.issueId).toBe(deferredIssueId);
    // Must NOT contain any user-visible text, paths, or secret-bearing fields
    const detailKeys = Object.keys(details);
    for (const key of detailKeys) {
      expect(typeof details[key]).toMatch(/^(string|null|undefined)$/);
    }
  });
});
