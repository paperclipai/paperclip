import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
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
  let raceDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
    raceDb = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
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

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runStatus?: "running" | "queued" | "failed";
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
      name: "Paperclip",
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
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
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

  it("cancels a stale queued issue_assigned run after the issue is reassigned", async () => {
    const { companyId, issueId, runId, wakeupRequestId } = await seedRunFixture({
      agentStatus: "idle",
      runStatus: "queued",
    });
    const otherAgentId = randomUUID();
    const heartbeat = heartbeatService(db);

    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db
      .update(issues)
      .set({
        status: "todo",
        assigneeAgentId: otherAgentId,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      })
      .where(eq(issues.id, issueId));

    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      })
      .where(eq(heartbeatRuns.id, runId));

    await heartbeat.resumeQueuedRuns();

    const queuedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);

    expect(queuedRun?.status).toBe("cancelled");
    expect(queuedRun?.error).toContain("reassigned");
    expect(issue?.assigneeAgentId).toBe(otherAgentId);
    expect(issue?.executionRunId).toBeNull();
    expect(wakeup?.status).toBe("cancelled");
  });

  it("does not restamp stale execution ownership when reassignment races the queued claim", async () => {
    const { companyId, issueId, runId } = await seedRunFixture({
      agentStatus: "idle",
      runStatus: "queued",
    });
    const otherAgentId = randomUUID();
    const heartbeat = heartbeatService(db);
    const lockKey = Number.parseInt(runId.replaceAll("-", "").slice(0, 8), 16);
    const triggerName = `test_claim_sleep_${runId.replaceAll("-", "_")}`;
    const functionName = `${triggerName}_fn`;

    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      })
      .where(eq(heartbeatRuns.id, runId));

    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION ${functionName}()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.id = '${runId}'::uuid AND OLD.status = 'queued' AND NEW.status = 'running' THEN
          PERFORM pg_advisory_lock(${lockKey});
          PERFORM pg_sleep(0.4);
          PERFORM pg_advisory_unlock(${lockKey});
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE ON heartbeat_runs
      FOR EACH ROW
      EXECUTE FUNCTION ${functionName}();
    `));

    async function waitForClaimWindow() {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const rows = await raceDb.execute(sql<{ acquired: boolean }>`SELECT pg_try_advisory_lock(${lockKey}) AS acquired`);
        const acquired = rows[0]?.acquired === true;
        if (!acquired) return;
        await raceDb.execute(sql`SELECT pg_advisory_unlock(${lockKey})`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Timed out waiting for the queued-claim race window");
    }

    try {
      const resumePromise = heartbeat.resumeQueuedRuns();
      await waitForClaimWindow();

      const reassignPromise = raceDb
        .update(issues)
        .set({
          status: "todo",
          assigneeAgentId: otherAgentId,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
        })
        .where(eq(issues.id, issueId));

      await Promise.all([resumePromise, reassignPromise]);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON heartbeat_runs`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
    }

    const queuedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(queuedRun?.status).toBe("running");
    expect(issue?.assigneeAgentId).toBe(otherAgentId);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBeNull();
  });

  it("cancels a stale queued issue_assigned run after the issue is reassigned", async () => {
    const { companyId, issueId, runId, wakeupRequestId } = await seedRunFixture({
      agentStatus: "idle",
      runStatus: "queued",
    });
    const otherAgentId = randomUUID();
    const heartbeat = heartbeatService(db);

    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db
      .update(issues)
      .set({
        status: "todo",
        assigneeAgentId: otherAgentId,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      })
      .where(eq(issues.id, issueId));

    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      })
      .where(eq(heartbeatRuns.id, runId));

    await heartbeat.resumeQueuedRuns();

    const queuedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);

    expect(queuedRun?.status).toBe("cancelled");
    expect(queuedRun?.error).toContain("reassigned");
    expect(issue?.assigneeAgentId).toBe(otherAgentId);
    expect(issue?.executionRunId).toBeNull();
    expect(wakeup?.status).toBe("cancelled");
  });

  it("does not restamp a stale queued issue_assigned run when waking the new assignee", async () => {
    const { companyId, issueId, runId: staleRunId } = await seedRunFixture({
      agentStatus: "idle",
      runStatus: "queued",
    });
    const otherAgentId = randomUUID();
    const blockerWakeupRequestId = randomUUID();
    const blockerRunId = randomUUID();
    const heartbeat = heartbeatService(db);

    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: blockerWakeupRequestId,
      companyId,
      agentId: otherAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {},
      status: "claimed",
      runId: blockerRunId,
      claimedAt: new Date("2026-03-19T00:03:00.000Z"),
    });

    await db.insert(heartbeatRuns).values({
      id: blockerRunId,
      companyId,
      agentId: otherAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId: blockerWakeupRequestId,
      contextSnapshot: { taskKey: "other-task" },
      startedAt: new Date("2026-03-19T00:03:00.000Z"),
      updatedAt: new Date("2026-03-19T00:03:00.000Z"),
    });

    await db
      .update(issues)
      .set({
        status: "todo",
        assigneeAgentId: otherAgentId,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      })
      .where(eq(issues.id, issueId));

    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      })
      .where(eq(heartbeatRuns.id, staleRunId));

    const promotedRun = await heartbeat.wakeup(otherAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    expect(promotedRun).toEqual(expect.objectContaining({
      agentId: otherAgentId,
      status: "queued",
    }));
    expect(promotedRun?.id).not.toBe(staleRunId);

    const issueAfterWake = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    const deferredWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, otherAgentId))
      .then((rows) => rows.find((row) => row.status === "deferred_issue_execution") ?? null);

    expect(issueAfterWake?.assigneeAgentId).toBe(otherAgentId);
    expect(issueAfterWake?.executionRunId).toBe(promotedRun?.id ?? null);
    expect(deferredWake).toBeNull();

    await heartbeat.resumeQueuedRuns();

    const staleRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, staleRunId))
      .then((rows) => rows[0] ?? null);
    const issueAfterResume = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(staleRun?.status).toBe("cancelled");
    expect(staleRun?.error).toContain("reassigned");
    expect(issueAfterResume?.executionRunId).toBe(promotedRun?.id ?? null);
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
});
