import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  agents,
  agentWakeupRequests,
  companies,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-heartbeat-recovery-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");
  const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  await applyPendingMigrations(connectionString);
  return { connectionString, instance, dataDir };
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function createMockCancelableChild(options: { exitOnSigterm: boolean }): ChildProcess {
  const emitter = new EventEmitter() as EventEmitter & ChildProcess;
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.killed = false;
  emitter.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === "SIGTERM") {
      if (options.exitOnSigterm) {
        emitter.killed = true;
        emitter.exitCode = 0;
        emitter.emit("exit", 0, "SIGTERM");
        emitter.emit("close", 0, "SIGTERM");
      }
      return true;
    }
    if (signal === "SIGKILL") {
      emitter.killed = true;
      emitter.signalCode = "SIGKILL";
      emitter.emit("exit", null, "SIGKILL");
      emitter.emit("close", null, "SIGKILL");
      return true;
    }
    return true;
  }) as ChildProcess["kill"];
  return emitter;
}

describe("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  const childProcesses = new Set<ChildProcess>();

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
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
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "running" | "idle";
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

  it("does not start queued runs during agent-wide cancel loop", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const run1Id = randomUUID();
    const run2Id = randomUUID();
    const wake1Id = randomUUID();
    const wake2Id = randomUUID();
    const now = new Date("2026-03-20T00:00:00.000Z");
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
      name: "Runner",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values([
      {
        id: wake1Id,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: {},
        status: "claimed",
        runId: run1Id,
        claimedAt: now,
      },
      {
        id: wake2Id,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: {},
        status: "queued",
        runId: run2Id,
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: run1Id,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        wakeupRequestId: wake1Id,
        contextSnapshot: {},
        startedAt: now,
        updatedAt: now,
      },
      {
        id: run2Id,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wake2Id,
        contextSnapshot: {},
        startedAt: null,
        updatedAt: now,
      },
    ]);

    const heartbeat = heartbeatService(db);
    const cancelledCount = await heartbeat.cancelActiveForAgent(agentId);
    expect(cancelledCount).toBe(2);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const run1 = runs.find((row) => row.id === run1Id);
    const run2 = runs.find((row) => row.id === run2Id);
    expect(run1?.status).toBe("cancelled");
    expect(run2?.status).toBe("cancelled");
    expect(run2?.startedAt).toBeNull();
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

  it("sends SIGKILL after SIGTERM timeout when cancelling active runs", async () => {
    vi.useFakeTimers();
    try {
      const { agentId, runId } = await seedRunFixture({ includeIssue: false });
      const heartbeat = heartbeatService(db);
      const child = createMockCancelableChild({ exitOnSigterm: false });
      runningProcesses.set(runId, { child, graceSec: 1 });

      const cancellation = heartbeat.cancelActiveForAgent(agentId);
      await vi.advanceTimersByTimeAsync(1_000);
      const cancelledCount = await cancellation;

      expect(cancelledCount).toBe(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send SIGKILL when process exits on SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const { agentId, runId } = await seedRunFixture({ includeIssue: false });
      const heartbeat = heartbeatService(db);
      const child = createMockCancelableChild({ exitOnSigterm: true });
      runningProcesses.set(runId, { child, graceSec: 1 });

      const cancellation = heartbeat.cancelActiveForAgent(agentId);
      await vi.advanceTimersByTimeAsync(1_000);
      const cancelledCount = await cancellation;

      expect(cancelledCount).toBe(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up runningProcesses tracking after active cancel", async () => {
    vi.useFakeTimers();
    try {
      const { agentId, runId } = await seedRunFixture({ includeIssue: false });
      const heartbeat = heartbeatService(db);
      const child = createMockCancelableChild({ exitOnSigterm: false });
      runningProcesses.set(runId, { child, graceSec: 1 });

      const cancellation = heartbeat.cancelActiveForAgent(agentId);
      await vi.advanceTimersByTimeAsync(1_000);
      await cancellation;

      expect(runningProcesses.has(runId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
