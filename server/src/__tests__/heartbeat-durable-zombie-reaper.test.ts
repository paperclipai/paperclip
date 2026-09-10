/**
 * Tests for the durable zombie session reaper:
 *   1. reapSilentZombieRuns — kills in-memory handles that have been silent
 *      beyond the kill threshold and releases the issue execution lock.
 *   2. reapOrphanedRuns with detached-process kill — a run already marked
 *      "process_detached" is terminated once the staleness window passes.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
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

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping zombie reaper tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describeEmbeddedPostgres("durable zombie reaper", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-zombie-reaper-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    runningProcesses.clear();
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "TestCo",
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedAgent(companyId: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedIssue(companyId: string, runId: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Zombie test issue",
      status: "in_progress",
      priority: "medium",
      executionRunId: runId,
      executionAgentNameKey: "test-agent",
      executionLockedAt: new Date(),
    });
    return id;
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    overrides: Partial<typeof heartbeatRuns.$inferInsert> = {},
  ) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      startedAt: new Date(Date.now() - 6 * 60 * 60 * 1000), // 6 h ago
      lastOutputAt: new Date(Date.now() - 5 * 60 * 60 * 1000), // silent 5 h
      ...overrides,
    });
    return id;
  }

  // ---------------------------------------------------------------------------
  // reapSilentZombieRuns — core zombie path
  // ---------------------------------------------------------------------------
  describe("reapSilentZombieRuns", () => {
    it("terminalizes a running run in runningProcesses that has been silent beyond the kill threshold", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = await seedRun(companyId, agentId, {
        lastOutputAt: new Date(Date.now() - 5 * 60 * 60 * 1000), // 5 h silent
      });
      const issueId = await seedIssue(companyId, runId);

      // Simulate an in-memory handle (no real process needed for this path)
      runningProcesses.set(runId, { child: {} as never, graceSec: 30, processGroupId: null });

      const heartbeat = heartbeatService(db);
      // Pass killThresholdMs: 0 to make the threshold trivially old
      const result = await heartbeat.reapSilentZombieRuns({ killThresholdMs: 0 });

      expect(result.reaped).toBe(1);
      expect(result.runIds).toContain(runId);

      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(run?.status).toBe("interrupted");
      expect(run?.errorCode).toBe("silent_zombie_killed");

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.executionRunId).toBeNull();
      expect(issue?.executionAgentNameKey).toBeNull();

      expect(runningProcesses.has(runId)).toBe(false);
    });

    it("does not reap a running run that has produced recent output", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      // Last output 2 minutes ago → not stale at a 4-h threshold
      const runId = await seedRun(companyId, agentId, {
        lastOutputAt: new Date(Date.now() - 2 * 60 * 1000),
      });

      runningProcesses.set(runId, { child: {} as never, graceSec: 30, processGroupId: null });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reapSilentZombieRuns({ killThresholdMs: 4 * 60 * 60 * 1000 });

      expect(result.reaped).toBe(0);

      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(run?.status).toBe("running");
    });

    it("cleans up a stale runningProcesses entry whose run is already terminal", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = await seedRun(companyId, agentId, { status: "failed" });

      runningProcesses.set(runId, { child: {} as never, graceSec: 30, processGroupId: null });

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reapSilentZombieRuns({ killThresholdMs: 0 });

      expect(result.reaped).toBe(0);
      expect(runningProcesses.has(runId)).toBe(false);
    });

    it("skips runs whose runningProcesses entry is missing (handled by reapOrphanedRuns)", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = await seedRun(companyId, agentId, {
        lastOutputAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
      });

      // No entry in runningProcesses — reapOrphanedRuns owns this case
      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reapSilentZombieRuns({ killThresholdMs: 0 });

      expect(result.reaped).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // reapOrphanedRuns — detached-process kill path
  // ---------------------------------------------------------------------------
  describe("reapOrphanedRuns detached-process kill", () => {
    it("kills a process that was previously marked process_detached once the staleness window passes", async () => {
      // Spawn a real long-lived process so we can verify the PID is killed
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      const pid = child.pid!;
      expect(isPidAlive(pid)).toBe(true);

      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = randomUUID();

      // Plant a run that is already marked "process_detached" and is old enough
      // to pass the staleness check. updatedAt is set far in the past so the
      // staleness threshold of 5 ms triggers immediately.
      const staleUpdatedAt = new Date(Date.now() - 60_000); // 60 s ago
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
        startedAt: new Date(Date.now() - 70_000),
        processPid: pid,
        errorCode: "process_detached",
        error: "Lost in-memory process handle, but child pid is still alive",
        // processLossRetryCount: 1 disables the one-off process-loss retry so
        // the test does not need a responsible-user row in auth_users.
        processLossRetryCount: 1,
        updatedAt: staleUpdatedAt,
        createdAt: staleUpdatedAt,
      });
      const issueId = await seedIssue(companyId, runId);

      const heartbeat = heartbeatService(db);
      // staleThresholdMs: 5 ms — the run's updatedAt is 60 s old, easily stale
      const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 });

      expect(result.reaped).toBeGreaterThanOrEqual(1);
      expect(result.runIds).toContain(runId);

      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(run?.status).not.toBe("running");

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      // After terminalizing, sweepStaleIssueLocks would clear the lock on the
      // next tick. Verify the run was terminalized (which is the durable step).
      expect(run?.status).toMatch(/^(failed|interrupted|cancelled)$/);

      // Give the OS a moment then verify the process was killed
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(isPidAlive(pid)).toBe(false);

      // Cleanup in case the kill failed (shouldn't happen)
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, 10_000);

    it("does not kill a detached process that has not yet passed the staleness window", async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      const pid = child.pid!;

      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = randomUUID();

      // updatedAt is very recent — not stale
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "running",
        startedAt: new Date(),
        processPid: pid,
        processLossRetryCount: 1,
        errorCode: "process_detached",
        error: "Lost in-memory process handle, but child pid is still alive",
        updatedAt: new Date(), // just now
        createdAt: new Date(),
      });

      const heartbeat = heartbeatService(db);
      await heartbeat.reapOrphanedRuns({ staleThresholdMs: 60_000 }); // 60 s threshold

      expect(isPidAlive(pid)).toBe(true);

      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(run?.status).toBe("running");

      // Cleanup
      child.kill("SIGKILL");
    }, 10_000);
  });
});
