/**
 * BLO-12990: high-priority `todo` starved behind low-priority `in_progress`.
 *
 * Covers two independent fixes:
 *
 * Fix #3 (priority sort): verifies that startNextQueuedRunForAgent selects a
 * high-priority `todo` run ahead of a low-priority `in_progress` run when a
 * slot opens. The old sort made status the primary key (in_progress always won
 * regardless of priority gap); the new sort uses priority * 2 + statusBonus so
 * priority can cross the status boundary.
 *
 * Fix #1 (stale-run exclusion): verifies that a stale/silent running run does
 * not hold a dispatch slot hostage. A run is stale when its most-recent signal
 * (lastUsefulActionAt > lastOutputAt > startedAt) is older than
 * EXTERNAL_LIFECYCLE_STALE_MS (15 min). Before the fix, stale runs counted as
 * "running" and blocked all dispatch for external-lifecycle agents via the hard
 * early-return gate — even when the k8s Job was already gone.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null as string | null,
    timedOut: false,
    errorMessage: null as string | null,
    resultJson: { exitCode: 0 },
    provider: "test",
    model: "test-model",
  })),
);

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

vi.mock("../services/k8s-job-liveness.ts", () => ({
  listLiveAgentJobRunIds: vi.fn(async () => null),
  listAgentJobRunStatuses: vi.fn(async () => null),
  readAgentJobRunStatusByName: vi.fn(async () => null),
  deleteAgentJobsForRun: vi.fn(async () => 1),
  hasActiveJobForAgent: vi.fn(async () => false),
}));

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping dispatch-priority-sort tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) {
      await heartbeat.drainInFlightExecutions(timeoutMs);
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat dispatch priority sort (BLO-12990)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const allowPenstockGate = {
    checkAdapter: async () => ({ allow: true as const }),
    _resetForTesting: () => {},
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dispatch-priority-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { penstockGate: allowPenstockGate });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    await cleanupHeartbeatTestState(db, heartbeat);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  it("dispatches high-priority todo ahead of low-priority in_progress (BLO-12990 regression)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const inProgressIssueId = randomUUID();
    const todoIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    // Issue A: in_progress, low priority — should LOSE under the new sort
    await db.insert(issues).values([
      {
        id: inProgressIssueId,
        companyId,
        title: "Low priority in-progress work",
        status: "in_progress",
        priority: "low",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        startedAt: new Date(),
      },
      // Issue B: todo, high priority — should WIN under the new sort
      {
        id: todoIssueId,
        companyId,
        title: "High priority new work",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    // Insert two queued runs. The in_progress run is OLDER (createdAt) so it
    // would win the old sort's createdAt-ASC tie-break within its status rank.
    // With the new priority-first sort the todo/high run should still win.
    const olderTime = new Date("2026-01-01T00:00:00Z");
    const newerTime = new Date("2026-01-01T00:01:00Z");

    const inProgressWakeId = randomUUID();
    const inProgressRunId = randomUUID();
    const todoWakeId = randomUUID();
    const todoRunId = randomUUID();

    await db.insert(agentWakeupRequests).values([
      {
        id: inProgressWakeId,
        companyId,
        agentId,
        source: "heartbeat",
        triggerDetail: "timer",
        reason: "heartbeat_timer",
        payload: { issueId: inProgressIssueId },
        status: "queued",
        runId: inProgressRunId,
        requestedAt: olderTime,
        updatedAt: olderTime,
      },
      {
        id: todoWakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: todoIssueId },
        status: "queued",
        runId: todoRunId,
        requestedAt: newerTime,
        updatedAt: newerTime,
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: inProgressRunId,
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "queued",
        wakeupRequestId: inProgressWakeId,
        contextSnapshot: { issueId: inProgressIssueId, wakeReason: "heartbeat_timer" },
        createdAt: olderTime,
        updatedAt: olderTime,
      },
      {
        id: todoRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: todoWakeId,
        contextSnapshot: { issueId: todoIssueId, wakeReason: "issue_assigned" },
        createdAt: newerTime,
        updatedAt: newerTime,
      },
    ]);

    // Track which runIds are dispatched and in what order.
    // The "issue_assigned" wakeReason triggers a missing-comment-retry cascade
    // after todoRun completes, so there will be more than 1 execute call total.
    // The regression guard is ORDER: high-priority todo must be first.
    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    // Dispatch: only 1 slot available (maxConcurrentRuns: 1, 0 running).
    await heartbeat.resumeQueuedRuns();

    // Wait for the todo run to settle and drain all cascaded follow-up dispatches.
    await waitForRunToSettle(heartbeat, todoRunId);

    // REGRESSION GUARD: the high-priority todo run must be the FIRST dispatch.
    // The old sort always picked in_progress ahead regardless of priority gap.
    expect(dispatchedRunIds[0]).toBe(todoRunId);

    // The low-priority in_progress run must have been dispatched AFTER the todo run.
    const inProgressDispatchIdx = dispatchedRunIds.indexOf(inProgressRunId);
    expect(inProgressDispatchIdx).toBeGreaterThan(0);

    const todoRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, todoRunId))
      .then((rows) => rows[0] ?? null);

    // todo/high should have been dispatched (left the queued state).
    expect(todoRun?.status).not.toBe("queued");
  });

  it("dispatches queued run despite a stale silent running run (BLO-12990 Fix #1)", async () => {
    // A running run that has been silent for > EXTERNAL_LIFECYCLE_STALE_MS (15 min)
    // must NOT consume a concurrency slot. With maxConcurrentRuns: 2 and 2 stale
    // "running" runs in the DB, the old code saw runningCount = 2 = maxConcurrentRuns
    // and returned availableSlots = 0 (no dispatch). Fix #1 excludes stale runs from
    // the count so nonStaleRunningRuns = 0, runningCount = 0, availableSlots = 2, and
    // the queued run dispatches.
    //
    // codex_local is intentionally used here: for non-external-lifecycle adapters
    // reapOrphanedRuns is NOT called inside startNextQueuedRunForAgent, so the stale
    // runs remain "running" in the DB untouched during the dispatch cycle, isolating
    // the stale-exclusion logic cleanly without reaper interference.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const staleIssueId1 = randomUUID();
    const staleIssueId2 = randomUUID();
    const todoIssueId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "StaleTestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "StaleTestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: staleIssueId1,
        companyId,
        title: "Stale in-flight issue 1",
        status: "in_progress",
        priority: "low",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        startedAt: new Date(),
      },
      {
        id: staleIssueId2,
        companyId,
        title: "Stale in-flight issue 2",
        status: "in_progress",
        priority: "low",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        startedAt: new Date(),
      },
      {
        id: todoIssueId,
        companyId,
        title: "New high-priority work",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        issueNumber: 3,
        identifier: `${issuePrefix}-3`,
      },
    ]);

    // Two stale running runs: lastOutputAt = 20 minutes ago (> EXTERNAL_LIFECYCLE_STALE_MS = 15 min).
    // These fill maxConcurrentRuns: 2 under the old code, leaving availableSlots = 0.
    const staleOutputAt = new Date(Date.now() - 20 * 60 * 1000);
    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "running",
        contextSnapshot: { issueId: staleIssueId1, wakeReason: "heartbeat_timer" },
        startedAt: staleOutputAt,
        lastOutputAt: staleOutputAt,
        createdAt: staleOutputAt,
        updatedAt: staleOutputAt,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "running",
        contextSnapshot: { issueId: staleIssueId2, wakeReason: "heartbeat_timer" },
        startedAt: staleOutputAt,
        lastOutputAt: staleOutputAt,
        createdAt: staleOutputAt,
        updatedAt: staleOutputAt,
      },
    ]);

    // The queued high-priority run.
    const todoWakeId = randomUUID();
    const todoRunId = randomUUID();
    const queuedTime = new Date();
    await db.insert(agentWakeupRequests).values({
      id: todoWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: todoIssueId },
      status: "queued",
      runId: todoRunId,
      requestedAt: queuedTime,
      updatedAt: queuedTime,
    });
    await db.insert(heartbeatRuns).values({
      id: todoRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: todoWakeId,
      contextSnapshot: { issueId: todoIssueId, wakeReason: "issue_assigned" },
      createdAt: queuedTime,
      updatedAt: queuedTime,
    });

    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, todoRunId);

    // REGRESSION GUARD (Fix #1): the stale running runs must NOT block dispatch.
    // The todo/high-priority run must have been dispatched despite filling both slots.
    expect(dispatchedRunIds[0]).toBe(todoRunId);

    // The todo run should have left the queued state.
    const todoRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, todoRunId))
      .then((rows) => rows[0] ?? null);
    expect(todoRun?.status).not.toBe("queued");
  });
});
