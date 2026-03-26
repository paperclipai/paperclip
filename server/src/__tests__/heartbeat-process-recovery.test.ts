import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
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

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
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
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
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
      status: "paused",
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
});
