import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
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
import { heartbeatService, getTaskDrainStatus, startTaskDrain, stopTaskDrain } from "../services/heartbeat.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task-drain admission release tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat task-drain admission release", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-task-drain-admission-release-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  function isHeartbeatRunDependentFkError(error: unknown) {
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    return (
      message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk") ||
      message.includes("activity_log_run_id_heartbeat_runs_id_fk")
    );
  }

  async function deleteHeartbeatRunsWithDependents() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.delete(heartbeatRuns);
        return;
      } catch (error) {
        if (!isHeartbeatRunDependentFkError(error) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  afterEach(async () => {
    stopTaskDrain();
    await deleteHeartbeatRunsWithDependents();
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedQueuedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Drain Race Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Work claimed just before a drain trips",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    return { companyId, agentId, issueId, runId, wakeupRequestId };
  }

  it("releases the run, wakeup, and issue lock when a task drain trips right after the run is claimed", async () => {
    const { companyId, issueId, runId, wakeupRequestId } = await seedQueuedRun();
    const heartbeat = heartbeatService(db);

    // The claim path publishes a "heartbeat.run.status" live event with
    // status "running" the moment it flips the run row, before the run is
    // dispatched to executeRun's second suppression check. Starting the
    // drain from that same event reproduces the gap the fix closes: the
    // drain trips after the first admission check passed but before the
    // second one runs.
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      const payload = event.payload as { runId?: string; status?: string };
      if (event.type === "heartbeat.run.status" && payload.runId === runId && payload.status === "running") {
        startTaskDrain({});
      }
    });

    try {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
    } finally {
      unsubscribe();
    }

    const run = await db
      .select({
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        responsibleUserId: heartbeatRuns.responsibleUserId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run).toMatchObject({ status: "queued", startedAt: null, responsibleUserId: null });

    const wakeup = await db
      .select({ status: agentWakeupRequests.status, claimedAt: agentWakeupRequests.claimedAt })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({ status: "queued", claimedAt: null });

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const status = getTaskDrainStatus();
    expect(status.draining).toBe(true);
    expect(status.activeRuns).toBe(0);
    expect(status.pendingWakes).toBe(0);
    expect(status.quiescent).toBe(true);

    // The released run is not orphaned: once the drain lifts, the normal
    // admission path picks it back up and it runs to completion.
    stopTaskDrain();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const finished = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(finished?.status).toBe("succeeded");
  }, 20_000);

  // Wraps db.transaction so the callback's tx object throws the moment code
  // calls tx.update(table) for a table named in tablesByCall — this makes a
  // real Postgres transaction roll back exactly like a genuine write failure
  // partway through, without touching any other table's update path.
  // tablesByCall maps a 0-based db.transaction() call index (in call order)
  // to the table that call should fail on; a call index with no entry runs
  // every update for real. For example { 0: issues } fails only the
  // issue-lock write inside releaseRunClaimedJustBeforeSuppression's
  // transaction.
  function withFailingTransactionalUpdate(realDb: typeof db, tablesByCall: Record<number, unknown>) {
    let callIndex = 0;
    return new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>) => {
          const failingTable = tablesByCall[callIndex];
          callIndex += 1;
          return target.transaction((tx) => {
            const txProxy = new Proxy(tx as object, {
              get(txTarget, txProp, txReceiver) {
                if (txProp === "update") {
                  return (table: unknown) => {
                    if (failingTable !== undefined && table === failingTable) {
                      throw new Error("simulated transactional write failure");
                    }
                    return (txTarget as any).update(table);
                  };
                }
                return Reflect.get(txTarget, txProp, txReceiver);
              },
            });
            return fn(txProxy);
          });
        };
      },
    }) as typeof db;
  }

  it("leaves the run row running for the orphan reaper when the atomic release fails", async () => {
    const { companyId, issueId, runId, wakeupRequestId } = await seedQueuedRun();
    // Fault the release transaction on the issue-lock write, so executeRun's
    // suppression branch catches the failure, logs it, and returns instead
    // of throwing. There is no in-process fallback or retry for this path.
    const failingDb = withFailingTransactionalUpdate(db, { 0: issues });
    const heartbeat = heartbeatService(failingDb);

    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      const payload = event.payload as { runId?: string; status?: string };
      if (event.type === "heartbeat.run.status" && payload.runId === runId && payload.status === "running") {
        startTaskDrain({});
      }
    });

    try {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
    } finally {
      unsubscribe();
    }

    // The release transaction rolled back, so the run, wakeup, and issue
    // lock stay exactly as the admission claim left them.
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("running");

    const wakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(runId);

    // executeRun did not throw, so the dispatch site removed this run's
    // execution promise from active tracking like it does for any other
    // completed run. Task-drain now reads quiescent even though the
    // database still holds the run claimed: this reading counts in-process
    // work only.
    const status = getTaskDrainStatus();
    expect(status.activeRuns).toBe(0);
    expect(status.quiescent).toBe(true);

    // The run's row is still "running", so the orphan reaper finds it,
    // finalizes it, and releases the issue lock on its own cycle.
    const reapResult = await heartbeat.reapOrphanedRuns();
    expect(reapResult.runIds).toContain(runId);

    const reapedRun = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(reapedRun?.status).toBe("failed");
    expect(reapedRun?.errorCode).toBe("process_lost");

    // The issue is still "todo" and assigned to the same agent, so the
    // reaper's normal self-heal path queues a fresh recovery run for it
    // instead of leaving the lock pointed at the failed run.
    const reapedIssue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(reapedIssue?.executionRunId).not.toBe(runId);
  }, 20_000);
});
