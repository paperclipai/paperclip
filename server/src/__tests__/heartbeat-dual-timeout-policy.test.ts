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
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async (ctx) => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: process.platform !== "win32",
          stdio: "ignore",
        });
        await ctx.onSpawn?.({
          pid: child.pid ?? 0,
          processGroupId: child.pid ?? null,
          startedAt: new Date().toISOString(),
        });
        if (ctx.config.emitInitialLog !== false) {
          await ctx.onLog?.("stdout", "[test] initial activity\n");
        }
        const additionalActivityDelaysMs = Array.isArray(ctx.config.additionalActivityDelaysMs)
          ? ctx.config.additionalActivityDelaysMs
              .map((value) => Number(value))
              .filter((value) => Number.isFinite(value) && value >= 0)
          : [];
        const scheduledActivityTimers = additionalActivityDelaysMs.map((delayMs, index) =>
          setTimeout(() => {
            void ctx.onLog?.("stdout", `[test] follow-up activity ${index + 1}\n`);
          }, delayMs),
        );
        return await new Promise((resolve, reject) => {
          child.once("error", (error) => {
            for (const timer of scheduledActivityTimers) {
              clearTimeout(timer);
            }
            reject(error);
          });
          child.once("exit", (exitCode, signal) => {
            for (const timer of scheduledActivityTimers) {
              clearTimeout(timer);
            }
            resolve({
              exitCode,
              signal,
              timedOut: false,
              errorMessage: null,
              provider: "test",
              model: "test-model",
            });
          });
        });
      }),
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat dual timeout tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat dual timeout policy", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-timeout-policy-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    const activeRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    for (const run of activeRuns) {
      const heartbeat = heartbeatService(db);
      await heartbeat.cancelRun(run.id).catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedAgentAndIssue(adapterConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
      name: "TimeoutTester",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig,
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Dual timeout verification",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function waitForRun(
    heartbeat: ReturnType<typeof heartbeatService>,
    runId: string,
    predicate: (run: typeof heartbeatRuns.$inferSelect | null) => boolean,
    timeoutMs = 8_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (predicate(run)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return heartbeat.getRun(runId);
  }

  it("updates persisted run activity and clears detached warnings", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ActivityTester",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      startedAt: new Date("2026-04-18T00:00:00.000Z"),
      error: "Detached child process",
      errorCode: "process_detached",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.reportRunActivity(runId);

    const run = await heartbeat.getRun(runId);
    expect(run?.lastActivityAt).toBeTruthy();
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("times out a run on stall after server-observed activity", async () => {
    const { agentId, issueId } = await seedAgentAndIssue({
      stallTimeoutSec: 1,
      absoluteTimeoutSec: 30,
      emitInitialLog: true,
    });
    const heartbeat = heartbeatService(db);
    const queuedRun = await heartbeat.invoke(agentId, "on_demand", { issueId, taskId: issueId });
    expect(queuedRun).toBeTruthy();

    await heartbeat.resumeQueuedRuns();
    const runningRun = await waitForRun(
      heartbeat,
      queuedRun!.id,
      (run) => run?.status === "running" && run.lastActivityAt != null && run.processPid != null,
    );
    expect(runningRun?.status).toBe("running");
    expect(runningRun?.lastActivityAt).toBeTruthy();

    await heartbeat.tickTimers(new Date(Date.now() + 2_000));
    const finishedRun = await waitForRun(heartbeat, queuedRun!.id, (run) => run?.status === "timed_out");
    const timeoutTermination = (finishedRun?.resultJson as Record<string, any>)?.timeoutTermination;

    expect(finishedRun?.status).toBe("timed_out");
    expect(finishedRun?.errorCode).toBe("stall");
    expect(timeoutTermination?.reason).toBe("stall");
    expect(timeoutTermination?.telemetryFallback).toBe(false);
    expect(timeoutTermination?.stallThresholdSec).toBe(1);
    expect(timeoutTermination?.absoluteTimeoutSec).toBe(30);
    expect(timeoutTermination?.firedThresholdKey).toBe("stallTimeoutSec");
    expect(timeoutTermination?.lastActivityAt).toBeTruthy();

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("terminal reason: `stall`"))).toBe(true);
  }, 20_000);

  it("keeps a run alive past the stall threshold when qualifying activity continues", async () => {
    const { agentId } = await seedAgentAndIssue({
      stallTimeoutSec: 1,
      absoluteTimeoutSec: 30,
      emitInitialLog: true,
      additionalActivityDelaysMs: [1_200],
    });
    const heartbeat = heartbeatService(db);
    const queuedRun = await heartbeat.invoke(agentId, "on_demand", {});

    await heartbeat.resumeQueuedRuns();
    const initialRun = await waitForRun(
      heartbeat,
      queuedRun!.id,
      (run) => run?.status === "running" && run.lastActivityAt != null && run.processPid != null,
    );
    expect(initialRun?.status).toBe("running");
    expect(initialRun?.lastActivityAt).toBeTruthy();

    const initialLastActivityAt = new Date(initialRun!.lastActivityAt!).getTime();
    const refreshedRun = await waitForRun(
      heartbeat,
      queuedRun!.id,
      (run) =>
        run?.status === "running"
        && run.lastActivityAt != null
        && new Date(run.lastActivityAt).getTime() > initialLastActivityAt,
      8_000,
    );
    expect(refreshedRun?.status).toBe("running");
    expect(refreshedRun?.lastActivityAt).toBeTruthy();

    const refreshedLastActivityAt = new Date(refreshedRun!.lastActivityAt!).getTime();
    expect(refreshedLastActivityAt - initialLastActivityAt).toBeGreaterThanOrEqual(1_000);

    await heartbeat.tickTimers(new Date(refreshedLastActivityAt + 100));
    const survivingRun = await heartbeat.getRun(queuedRun!.id);

    expect(survivingRun?.status).toBe("running");
    expect(survivingRun?.errorCode).toBeNull();
  }, 20_000);

  it("falls back to absolute ceiling when no qualifying activity was observed", async () => {
    const { agentId } = await seedAgentAndIssue({
      stallTimeoutSec: 1,
      absoluteTimeoutSec: 1,
      emitInitialLog: false,
    });
    const heartbeat = heartbeatService(db);
    const queuedRun = await heartbeat.invoke(agentId, "on_demand", {});

    await heartbeat.resumeQueuedRuns();
    const runningRun = await waitForRun(
      heartbeat,
      queuedRun!.id,
      (run) => run?.status === "running" && run.processPid != null,
    );
    expect(runningRun?.lastActivityAt).toBeNull();

    await heartbeat.tickTimers(new Date(Date.now() + 2_000));
    const finishedRun = await waitForRun(heartbeat, queuedRun!.id, (run) => run?.status === "timed_out");
    const timeoutTermination = (finishedRun?.resultJson as Record<string, any>)?.timeoutTermination;

    expect(finishedRun?.errorCode).toBe("absolute_ceiling");
    expect(timeoutTermination?.reason).toBe("absolute_ceiling");
    expect(timeoutTermination?.telemetryFallback).toBe(true);
    expect(timeoutTermination?.lastActivityAt).toBeNull();
    expect(timeoutTermination?.firedThresholdKey).toBe("absoluteTimeoutSec");
  }, 20_000);

  it("records absolute ceiling as the terminal reason when both thresholds are exceeded", async () => {
    const { agentId } = await seedAgentAndIssue({
      stallTimeoutSec: 1,
      absoluteTimeoutSec: 1,
      emitInitialLog: true,
    });
    const heartbeat = heartbeatService(db);
    const queuedRun = await heartbeat.invoke(agentId, "on_demand", {});

    await heartbeat.resumeQueuedRuns();
    await waitForRun(
      heartbeat,
      queuedRun!.id,
      (run) => run?.status === "running" && run.lastActivityAt != null && run.processPid != null,
    );

    await heartbeat.tickTimers(new Date(Date.now() + 2_000));
    const finishedRun = await waitForRun(heartbeat, queuedRun!.id, (run) => run?.status === "timed_out");
    const timeoutTermination = (finishedRun?.resultJson as Record<string, any>)?.timeoutTermination;

    expect(finishedRun?.errorCode).toBe("absolute_ceiling");
    expect(timeoutTermination?.reason).toBe("absolute_ceiling");
    expect(timeoutTermination?.stallExceeded).toBe(true);
  }, 20_000);

  it("uses legacy timeoutSec as the absolute ceiling compatibility path", async () => {
    const { agentId } = await seedAgentAndIssue({
      timeoutSec: 1,
      emitInitialLog: true,
    });
    const heartbeat = heartbeatService(db);
    const queuedRun = await heartbeat.invoke(agentId, "on_demand", {});

    await heartbeat.resumeQueuedRuns();
    await waitForRun(
      heartbeat,
      queuedRun!.id,
      (run) => run?.status === "running" && run.lastActivityAt != null && run.processPid != null,
    );

    await heartbeat.tickTimers(new Date(Date.now() + 2_000));
    const finishedRun = await waitForRun(heartbeat, queuedRun!.id, (run) => run?.status === "timed_out");
    const timeoutTermination = (finishedRun?.resultJson as Record<string, any>)?.timeoutTermination;

    expect(finishedRun?.errorCode).toBe("absolute_ceiling");
    expect(timeoutTermination?.reason).toBe("absolute_ceiling");
    expect(timeoutTermination?.policySource).toBe("legacy_timeoutSec");
    expect(timeoutTermination?.firedThresholdKey).toBe("timeoutSec");
    expect(timeoutTermination?.stallThresholdSec).toBeNull();
  }, 20_000);
});
