import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  routineRuns,
  routines,
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

vi.mock("../services/company-skills.ts", () => ({
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(async () => []),
  }),
}));

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
import { issueService } from "../services/issues.ts";
import { routineService } from "../services/routines.ts";
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

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForAgentRunsToSettle(
  db: ReturnType<typeof createDb>,
  agentId: string,
  expectedRunCount: number,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    if (runs.length >= expectedRunCount && runs.every((run) => run.status !== "queued" && run.status !== "running")) {
      return runs;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
}

async function waitForIssueExecutionLock(
  db: ReturnType<typeof createDb>,
  issueId: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    if (issue?.executionRunId && issue.status === "in_progress") return issue;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
}

async function waitForIssueStatus(
  db: ReturnType<typeof createDb>,
  issueId: string,
  status: typeof issues.$inferSelect.status,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    if (issue?.status === status) return issue;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
}

async function spawnOrphanedProcessGroup() {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid));",
        "setTimeout(() => process.exit(0), 25);",
      ].join(" "),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  let stdout = "";
  leader.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    leader.once("error", reject);
    leader.once("exit", () => resolve());
  });

  const descendantPid = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
    throw new Error(`Failed to capture orphaned descendant pid from detached process group: ${stdout}`);
  }

  return {
    processPid: leader.pid ?? null,
    processGroupId: leader.pid ?? null,
    descendantPid,
  };
}

describeEmbeddedPostgres("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();
  const cleanupPids = new Set<number>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (runs.every((run) => run.status !== "queued" && run.status !== "running")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(routineRuns);
    await db.delete(routines);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
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
    await db.delete(companies);
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processGroupId?: number | null;
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
      processGroupId: input?.processGroupId ?? null,
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

  async function seedStrandedIssueFixture(input: {
    status: "todo" | "in_progress";
    runStatus: "failed" | "timed_out" | "cancelled" | "succeeded";
    retryReason?: "assignment_recovery" | "issue_continuation_needed" | null;
    assignToUser?: boolean;
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
      status: "idle",
      adapterType: "codex_local",
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
      reason: input.retryReason === "assignment_recovery" ? "issue_assignment_recovery" : "issue_assigned",
      payload: { issueId },
      status: input.runStatus === "cancelled" ? "cancelled" : "failed",
      runId,
      claimedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      error: input.runStatus === "succeeded" ? null : "run failed before issue advanced",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.runStatus,
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: input.retryReason === "assignment_recovery"
          ? "issue_assignment_recovery"
          : input.retryReason ?? "issue_assigned",
        ...(input.retryReason ? { retryReason: input.retryReason } : {}),
      },
      startedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      updatedAt: new Date("2026-03-19T00:05:00.000Z"),
      errorCode: input.runStatus === "succeeded" ? null : "process_lost",
      error: input.runStatus === "succeeded" ? null : "run failed before issue advanced",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recover stranded assigned work",
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assignToUser ? null : agentId,
      assigneeUserId: input.assignToUser ? "user-1" : null,
      checkoutRunId: input.status === "in_progress" ? runId : null,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: input.status === "in_progress" ? now : null,
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  async function seedRoutineExecutionIssueFixture(input?: {
    issueStatus?: "todo" | "in_progress" | "blocked" | "cancelled";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineId = randomUUID();
    const routineRunId = randomUUID();
    const issueId = randomUUID();
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
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Daily cleanup",
      description: "Clean stale artifacts",
      assigneeAgentId: agentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Daily cleanup",
      description: "Clean stale artifacts",
      status: input?.issueStatus ?? "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      originKind: "routine_execution",
      originId: routineId,
      originRunId: routineRunId,
    });

    await db.insert(routineRuns).values({
      id: routineRunId,
      companyId,
      routineId,
      source: "schedule",
      status: "issue_created",
      triggeredAt: new Date("2026-03-19T00:00:00.000Z"),
      linkedIssueId: issueId,
    });

    return { agentId, issueId, routineRunId };
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

  it.skipIf(process.platform === "win32")("reaps orphaned descendant process groups when the parent pid is already gone", async () => {
    const orphan = await spawnOrphanedProcessGroup();
    cleanupPids.add(orphan.descendantPid);
    expect(isPidAlive(orphan.descendantPid)).toBe(true);

    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: orphan.processPid,
      processGroupId: orphan.processGroupId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    expect(await waitForPidExit(orphan.descendantPid, 2_000)).toBe(true);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.error).toContain("descendant process group");

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.status).toBe("queued");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
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

    expect(mockTrackAgentFirstHeartbeat).toHaveBeenCalledWith(
      mockTelemetryClient,
      expect.objectContaining({
        agentRole: "engineer",
      }),
    );
  });

  it("closes open routine execution issues when their heartbeat run succeeds", async () => {
    const { agentId, issueId, routineRunId } = await seedRoutineExecutionIssueFixture({
      issueStatus: "todo",
    });
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "routine_execution",
      payload: { issueId },
      contextSnapshot: { issueId, source: "routine.dispatch" },
    });
    expect(run?.id).toBeTruthy();
    const settledRun = run ? await waitForRunToSettle(heartbeat, run.id) : null;
    expect(settledRun?.status).toBe("succeeded");

    const issue = await waitForIssueStatus(db, issueId, "done");
    expect(issue?.status).toBe("done");
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.completedAt).toBeInstanceOf(Date);

    const routineRun = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.id, routineRunId))
      .then((rows) => rows[0] ?? null);
    expect(routineRun?.status).toBe("completed");
    expect(routineRun?.completedAt).toBeInstanceOf(Date);
  });

  it("does not auto-close cancelled routine execution issues after a succeeding heartbeat", async () => {
    const { agentId, issueId, routineRunId } = await seedRoutineExecutionIssueFixture({
      issueStatus: "cancelled",
    });
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "routine_execution",
      payload: { issueId },
      contextSnapshot: { issueId, source: "routine.dispatch" },
    });
    expect(run?.id).toBeTruthy();
    const settledRun = run ? await waitForRunToSettle(heartbeat, run.id) : null;
    expect(settledRun?.status).toBe("succeeded");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("cancelled");
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.completedAt).toBeNull();

    const routineRun = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.id, routineRunId))
      .then((rows) => rows[0] ?? null);
    expect(routineRun?.status).toBe("issue_created");
    expect(routineRun?.completedAt).toBeNull();
  });

  it("preserves routine execution cancellation while the heartbeat run is active", async () => {
    let releaseAdapter!: () => void;
    const adapterReleased = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await adapterReleased;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        provider: "test",
        model: "test-model",
      };
    });

    const { agentId, issueId, routineRunId } = await seedRoutineExecutionIssueFixture({
      issueStatus: "todo",
    });
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "routine_execution",
      payload: { issueId },
      contextSnapshot: { issueId, source: "routine.dispatch" },
    });
    expect(run?.id).toBeTruthy();

    const activeIssue = await waitForIssueExecutionLock(db, issueId);
    expect(activeIssue?.status).toBe("in_progress");
    expect(activeIssue?.executionRunId).toBe(run?.id);

    await issueService(db).update(issueId, { status: "cancelled" });
    await routineService(db).syncRunStatusForIssue(issueId);

    releaseAdapter();
    const settledRun = run ? await waitForRunToSettle(heartbeat, run.id) : null;
    expect(settledRun?.status).toBe("succeeded");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("cancelled");
    expect(issue?.completedAt).toBeNull();
    expect(issue?.cancelledAt).toBeInstanceOf(Date);
    expect(issue?.executionRunId).toBeNull();

    const routineRun = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.id, routineRunId))
      .then((rows) => rows[0] ?? null);
    expect(routineRun?.status).toBe("failed");
    expect(routineRun?.failureReason).toBe("Execution issue moved to cancelled");
    expect(routineRun?.completedAt).toBeInstanceOf(Date);
  });

  it("does not promote deferred comment wakes after a routine execution is cancelled", async () => {
    let releaseAdapter!: () => void;
    const adapterReleased = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await adapterReleased;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        provider: "test",
        model: "test-model",
      };
    });

    const { agentId, issueId, routineRunId } = await seedRoutineExecutionIssueFixture({
      issueStatus: "todo",
    });
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "routine_execution",
      payload: { issueId },
      contextSnapshot: { issueId, source: "routine.dispatch" },
    });
    expect(run?.id).toBeTruthy();

    const activeIssue = await waitForIssueExecutionLock(db, issueId);
    expect(activeIssue?.status).toBe("in_progress");
    expect(activeIssue?.executionRunId).toBe(run?.id);

    const comment = await db
      .insert(issueComments)
      .values({
        companyId: activeIssue!.companyId,
        issueId,
        authorAgentId: agentId,
        body: "Follow-up while routine execution is running",
      })
      .returning()
      .then((rows) => rows[0]);

    const deferredRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: comment.id },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: comment.id,
        wakeReason: "issue_commented",
      },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });
    expect(deferredRun).toBeNull();

    await issueService(db).update(issueId, { status: "cancelled" });
    await routineService(db).syncRunStatusForIssue(issueId);

    releaseAdapter();
    const settledRun = run ? await waitForRunToSettle(heartbeat, run.id) : null;
    expect(settledRun?.status).toBe("succeeded");
    const runs = await waitForAgentRunsToSettle(db, agentId, 1);
    expect(runs).toHaveLength(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("cancelled");
    expect(issue?.completedAt).toBeNull();
    expect(issue?.cancelledAt).toBeInstanceOf(Date);
    expect(issue?.executionRunId).toBeNull();

    const deferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.find((row) => row.reason === "issue_execution_deferred"));
    expect(deferred?.status).toBe("skipped");

    const routineRun = await db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.id, routineRunId))
      .then((rows) => rows[0] ?? null);
    expect(routineRun?.status).toBe("failed");
    expect(routineRun?.failureReason).toBe("Execution issue moved to cancelled");
    expect(routineRun?.completedAt).toBeInstanceOf(Date);
  });

  it("re-enqueues assigned todo work when the last issue run died and no wake remains", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("blocks assigned todo work after the one automatic dispatch recovery was already used", async () => {
    const { issueId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried dispatch");
  });

  it("re-enqueues continuation for stranded in-progress work with no active run", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("issue_continuation_needed");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("blocks stranded in-progress work after the continuation retry was already used", async () => {
    const { issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried continuation");
  });

  it("does not reconcile user-assigned work through the agent stranded-work recovery path", async () => {
    const { issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      assignToUser: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runs).toHaveLength(1);
  });
});
