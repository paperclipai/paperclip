import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRetryCircuits,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  roadmapEpicPauses,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { ServerAdapterModule } from "../adapters/index.js";
import { registerServerAdapter, runningProcesses, unregisterServerAdapter } from "../adapters/index.ts";
const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());

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

import { heartbeatService } from "../services/heartbeat.ts";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

describeEmbeddedPostgres("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();
  const registeredAdapterTypes = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    runningProcesses.clear();
    for (const adapterType of registeredAdapterTypes) {
      unregisterServerAdapter(adapterType);
    }
    registeredAdapterTypes.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    await db.delete(issues);
    await db.delete(roadmapEpicPauses);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentRuntimeState);
    await db.delete(heartbeatRetryCircuits);
    await db.delete(companySkills);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  function registerTestAdapter(adapter: ServerAdapterModule) {
    unregisterServerAdapter(adapter.type);
    registerServerAdapter(adapter);
    registeredAdapterTypes.add(adapter.type);
    return adapter;
  }

  async function waitFor(
    condition: () => boolean | Promise<boolean>,
    timeoutMs = 5_000,
    intervalMs = 25,
  ) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error("Timed out waiting for condition");
  }

  async function seedAgentFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runtimeConfig?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "idle",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: input?.runtimeConfig ?? {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runStatus?: "running" | "queued" | "failed" | "succeeded" | "cancelled" | "timed_out";
    processPid?: number | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    runErrorCode?: string | null;
    runError?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: input?.includeIssue === false ? {} : { issueId },
      processPid: input?.processPid ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      startedAt: now,
      lastActivityAt: new Date("2026-03-19T00:00:00.000Z"),
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover local adapter after lost process",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        executionLockedAt: now,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.retryState).toBe("scheduled");
    expect(failedRun?.retryClass).toBe("transient");
    expect(failedRun?.retryLastDecision).toBe("auto_retry_scheduled");
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.retryGroupId).toBe(runId);
    expect(retryRun?.retryAttempt).toBe(1);
    expect(retryRun?.retryState).toBe("scheduled");
    expect(retryRun?.retryClass).toBe("transient");
    expect(retryRun?.processLossRetryCount).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("marks a quiet run as suspect before it is declared lost", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      processPid: null,
    });
    const now = Date.now();
    await db
      .update(heartbeatRuns)
      .set({
        lastActivityAt: new Date(now - 100_000),
        updatedAt: new Date(now - 100_000),
      })
      .where(eq(heartbeatRuns.id, runId));

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({
      suspectThresholdMs: 90_000,
      staleThresholdMs: 150_000,
    });

    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_suspect");
    expect(run?.error).toContain("quiet for");
  });

  it("declares a suspect run lost based on the last real activity timestamp", async () => {
    const now = Date.now();
    const { runId } = await seedRunFixture({
      includeIssue: false,
      processPid: null,
    });
    const firstActivityAt = new Date(now - 100_000);
    await db
      .update(heartbeatRuns)
      .set({
        lastActivityAt: firstActivityAt,
        updatedAt: firstActivityAt,
      })
      .where(eq(heartbeatRuns.id, runId));

    const heartbeat = heartbeatService(db);
    await heartbeat.reapOrphanedRuns({
      suspectThresholdMs: 90_000,
      staleThresholdMs: 150_000,
    });

    let run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_suspect");
    expect(run?.lastActivityAt?.toISOString()).toBe(firstActivityAt.toISOString());

    await db
      .update(heartbeatRuns)
      .set({
        lastActivityAt: new Date(now - 160_000),
        updatedAt: new Date(now),
      })
      .where(eq(heartbeatRuns.id, runId));

    const result = await heartbeat.reapOrphanedRuns({
      suspectThresholdMs: 90_000,
      staleThresholdMs: 150_000,
    });

    expect(result.reaped).toBe(1);
    run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
  });

  it("does not queue a second retry after the first process-loss retry was already used", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("queues one retry for non-local adapters after a stale running run is declared lost", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      adapterType: "external_test",
      processPid: null,
    });
    await db
      .update(heartbeatRuns)
      .set({
        lastActivityAt: new Date(Date.now() - 200_000),
        updatedAt: new Date(Date.now() - 200_000),
      })
      .where(eq(heartbeatRuns.id, runId));

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({
      suspectThresholdMs: 90_000,
      staleThresholdMs: 150_000,
    });

    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.retryState).toBe("scheduled");
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryAttempt).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
  });

  it("blocks automatic recovery when the adapter retry circuit opens", async () => {
    const { companyId, runId, issueId, agentId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const now = Date.now();
    await db.insert(heartbeatRetryCircuits).values({
      companyId,
      adapterType: "codex_local",
      state: "closed",
      windowStartedAt: new Date(now - 60_000),
      windowTotal: 2,
      windowFailures: 2,
      consecutiveFailures: 2,
      cooldownSeconds: 600,
      updatedAt: new Date(now - 60_000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns();

    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.retryState).toBe("blocked");
    expect(runs[0]?.retryBlockedReason).toBe("adapter_retry_circuit_open");

    const circuit = await db
      .select()
      .from(heartbeatRetryCircuits)
      .where(eq(heartbeatRetryCircuits.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    expect(circuit?.state).toBe("open");
    expect(circuit?.openUntil).not.toBeNull();

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("keeps fresh queued work paused while the adapter retry circuit is open", async () => {
    const execute = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
    }));
    registerTestAdapter({
      type: "external_circuit_test",
      execute,
      testEnvironment: async () => ({
        adapterType: "external_circuit_test",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
      models: [],
      supportsLocalAgentJwt: false,
    });

    const { companyId, agentId } = await seedAgentFixture({
      adapterType: "external_circuit_test",
      agentStatus: "idle",
    });
    await db.insert(heartbeatRetryCircuits).values({
      companyId,
      adapterType: "external_circuit_test",
      state: "open",
      openedAt: new Date(),
      openUntil: new Date(Date.now() + 60_000),
      windowStartedAt: new Date(),
      windowTotal: 3,
      windowFailures: 3,
      consecutiveFailures: 3,
      cooldownSeconds: 600,
      updatedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued?.status).toBe("queued");

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(execute).not.toHaveBeenCalled();
    const storedRun = queued ? await heartbeat.getRun(queued.id) : null;
    expect(storedRun?.status).toBe("queued");
  });

  it("clears issue execution locks that still point at terminal runs", async () => {
    const { runId, issueId } = await seedRunFixture({
      runStatus: "succeeded",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);
    expect(result.runIds).toEqual([]);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("succeeded");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.executionLockedAt).toBeNull();
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("retries thrown transient adapter failures instead of collapsing them into non-retriable adapter_failed", async () => {
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => {
        const error = new Error("socket hang up ECONNRESET");
        Object.assign(error, { code: "ECONNRESET" });
        throw error;
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
      });
    registerTestAdapter({
      type: "external_transient_throw_test",
      execute,
      testEnvironment: async () => ({
        adapterType: "external_transient_throw_test",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
      models: [],
      supportsLocalAgentJwt: false,
    });

    const { agentId } = await seedAgentFixture({
      adapterType: "external_transient_throw_test",
      agentStatus: "idle",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.invoke(agentId, "on_demand", {}, "manual");

    await waitFor(async () => {
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return runs.length >= 2;
    }, 2_000);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));

    expect(runs).toHaveLength(2);
    const initialRun = runs.find((run) => run.retryAttempt === 0);
    const retryRun = runs.find((run) => run.retryAttempt === 1);
    expect(initialRun?.retryState).toBe("scheduled");
    expect(initialRun?.retryLastDecision).toBe("auto_retry_scheduled");
    expect(retryRun?.retryOfRunId).toBe(initialRun?.id ?? null);
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });
    const heartbeat = heartbeatService(db);

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("continues timer scans when a paused company blocks wakeups", async () => {
    const now = new Date("2026-03-20T00:00:00.000Z");
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paused Company",
      status: "paused",
      pauseReason: "manual",
      pausedAt: now,
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 30,
        },
      },
      permissions: {},
      lastHeartbeatAt: new Date(now.getTime() - 31_000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(now);

    expect(result).toEqual({
      checked: 1,
      enqueued: 0,
      skipped: 1,
    });

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.status).toBe("skipped");
    expect(wakeups[0]?.reason).toBe("company.paused");
    expect(wakeups[0]?.source).toBe("timer");

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("does not stack a new timer run while a prior timer run is still live", async () => {
    const now = new Date("2026-03-20T00:00:00.000Z");
    const companyId = randomUUID();
    const agentId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Timer Company",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Agent",
      role: "coo",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
        },
      },
      permissions: {},
      lastHeartbeatAt: new Date(now.getTime() - 16 * 60_000),
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: new Date(now.getTime() - 30_000),
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: {},
      startedAt: new Date(now.getTime() - 30_000),
      lastActivityAt: new Date(now.getTime() - 5_000),
      updatedAt: new Date(now.getTime() - 5_000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(now);

    expect(result).toEqual({
      checked: 1,
      enqueued: 0,
      skipped: 1,
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.id).toBe(wakeupRequestId);
  });

  it("tracks the first heartbeat with the agent role instead of adapter type", async () => {
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.cancelRun(runId);

    expect(mockTrackAgentFirstHeartbeat).toHaveBeenCalledWith(mockTelemetryClient, {
      agentRole: "engineer",
    });
  });

  it("skips wakeups for issues that map to a paused roadmap epic", async () => {
    const now = new Date("2026-03-20T00:00:00.000Z");
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const roadmapId = "RM-2026-Q2-09";

    await db.insert(companies).values({
      id: companyId,
      name: "Paused Epic Company",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Roadmap Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      lastHeartbeatAt: new Date(now.getTime() - 31_000),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `[${roadmapId}] Tighten execution focus`,
      description: "Pause this epic to prevent new runs from starting.",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(roadmapEpicPauses).values({
      companyId,
      roadmapId,
      pausedByUserId: "board-user-1",
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId },
    });

    expect(run).toBeNull();

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.status).toBe("skipped");
    expect(wakeups[0]?.reason).toBe("roadmap.epic_paused");

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });
});
