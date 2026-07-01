/**
 * BLO-12990: high-priority `todo` starved behind low-priority `in_progress`.
 *
 * Verifies that startNextQueuedRunForAgent selects a high-priority `todo`
 * run ahead of a low-priority `in_progress` run when a slot opens. The old
 * sort made status the primary key (in_progress always won regardless of
 * priority gap); the new sort uses priority * 2 + statusBonus so priority
 * can cross the status boundary.
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
});
