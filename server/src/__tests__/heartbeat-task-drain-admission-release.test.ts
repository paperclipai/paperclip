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
  // every update for real. For example { 0: issues, 1: agentWakeupRequests }
  // fails only the issue-lock write in the first transaction
  // (releaseRunClaimedJustBeforeSuppression) and only the wakeup write in
  // the second (failRunClaimedJustBeforeSuppression's own transaction).
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

  for (const [label, failingTable] of [
    ["the wakeup-request update", agentWakeupRequests],
    ["the issue-lock update", issues],
  ] as const) {
    it(`fails the run instead of leaving it claimed when ${label} fails`, async () => {
      const { companyId, issueId, runId, wakeupRequestId } = await seedQueuedRun();
      // Fault only the first (release) transaction, so the fallback's own
      // transaction runs for real and this test proves it can still reach
      // "failed" on its own — atomicity of the fallback itself is covered
      // separately below.
      const failingDb = withFailingTransactionalUpdate(db, { 0: failingTable });
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

      // The atomic release transaction rolled back (a non-atomic release
      // would show a partial mix of "queued" and "claimed" instead), so
      // executeRun's fallback takes over and fails the run outright. A
      // stuck "running" run here would keep the wakeup claimed and the
      // issue locked forever while active tracking already reports zero
      // active runs — the false-quiescence bug this test guards against.
      const run = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      expect(run?.status).toBe("failed");
      expect(run?.errorCode).toBe("claim_release_failed");

      const wakeup = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null);
      expect(wakeup?.status).toBe("failed");

      const issue = await db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(issue?.executionRunId).toBeNull();

      // The database converged to the same "not active" conclusion active
      // tracking already reached, so quiescence now reads true because it
      // is genuinely true, not because the database was never checked.
      const status = getTaskDrainStatus();
      expect(status.activeRuns).toBe(0);
      expect(status.quiescent).toBe(true);
    }, 20_000);
  }

  // Wraps db.transaction so the release transaction (call 0) fails on
  // releaseFailingTable exactly like withFailingTransactionalUpdate above —
  // this forces the fallback to run. The fallback's own transaction (call 1)
  // first writes a terminal outcome to the run, wakeup, and issue-lock rows
  // before it runs its real update. This stands in for a concurrent path (a
  // cancellation, the orphan reaper) that reaches a terminal status — and
  // finishes releasing the same three rows this fallback also guards — while
  // the fallback was still waiting to run its own update.
  function withRunTerminalizedBeforeFallbackUpdate(
    realDb: typeof db,
    releaseFailingTable: unknown,
    ids: { runId: string; wakeupRequestId: string; issueId: string },
  ) {
    let callIndex = 0;
    return new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>) => {
          const isReleaseCall = callIndex === 0;
          const isFallbackCall = callIndex === 1;
          callIndex += 1;
          return target.transaction(async (tx) => {
            if (isReleaseCall) {
              const txProxy = new Proxy(tx as object, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp === "update") {
                    return (table: unknown) => {
                      if (table === releaseFailingTable) {
                        throw new Error("simulated transactional write failure");
                      }
                      return (txTarget as any).update(table);
                    };
                  }
                  return Reflect.get(txTarget, txProp, txReceiver);
                },
              });
              return fn(txProxy);
            }
            if (isFallbackCall) {
              const now = new Date();
              const txDb = tx as typeof db;
              await txDb
                .update(heartbeatRuns)
                .set({
                  status: "cancelled",
                  finishedAt: now,
                  error: "Cancelled while a task drain was pending",
                  errorCode: "cancelled",
                  updatedAt: now,
                })
                .where(eq(heartbeatRuns.id, ids.runId));
              await txDb
                .update(agentWakeupRequests)
                .set({ status: "cancelled", finishedAt: now, updatedAt: now })
                .where(eq(agentWakeupRequests.id, ids.wakeupRequestId));
              await txDb
                .update(issues)
                .set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, updatedAt: now })
                .where(eq(issues.id, ids.issueId));
            }
            return fn(tx);
          });
        };
      },
    }) as typeof db;
  }

  it("leaves a run's outcome untouched when another path already terminalized it before the fallback runs", async () => {
    const { companyId, issueId, runId, wakeupRequestId } = await seedQueuedRun();

    const failingDb = withRunTerminalizedBeforeFallbackUpdate(db, issues, { runId, wakeupRequestId, issueId });
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

    // The other path's outcome survives untouched. Before the fix, the
    // fallback's unconditional update matched this already-terminal row and
    // overwrote it with "failed" / "claim_release_failed", losing the real
    // cause.
    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("cancelled");

    const wakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("cancelled");

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();

    // The run is not active by any measure: not in the live execution-promise
    // tracking (it already settled) and not in the stuck claim-release
    // marker (the fallback found no row to update, so it never throws).
    // Quiescence must be able to reach true.
    const status = getTaskDrainStatus();
    expect(status.activeRuns).toBe(0);
    expect(status.quiescent).toBe(true);
  }, 20_000);

  for (const [label, failingTable] of [
    ["the wakeup-request update", agentWakeupRequests],
    ["the issue-lock update", issues],
  ] as const) {
    it(`leaves the run claimed instead of a partial write when the fallback's own ${label} fails`, async () => {
      const { companyId, issueId, runId, wakeupRequestId } = await seedQueuedRun();
      // Fault the release transaction (call 0) on the issue lock so the
      // fallback engages, then fault the fallback's own transaction
      // (call 1) on a different table. Before the fix, the fallback wrote
      // the run row with a plain, unconditional update before it ever
      // touched the wakeup or issue rows — that write would have committed
      // here regardless of what came after it. With the fallback's writes
      // in one transaction, a failure anywhere inside it must roll back
      // everything, including the run-status write that ran first.
      const failingDb = withFailingTransactionalUpdate(db, { 0: issues, 1: failingTable });
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

      // Both transactions rolled back, so the database still shows the run
      // exactly as the admission claim left it — claimed, not a mix of
      // "failed" run row with a still-claimed wakeup or a still-locked issue.
      const run = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      expect(run?.status).toBe("running");
      expect(run?.errorCode).toBeNull();

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

      // The database still holds the claim, so task-drain must not report
      // quiescent for it. Before the fix, executeRun's rejection here was
      // caught by the dispatch site's generic handler, which removed this
      // run's execution promise from active tracking regardless — reporting
      // quiescent while the run, wakeup, and issue lock were all still
      // durably claimed.
      const status = getTaskDrainStatus();
      expect(status.activeRuns).toBeGreaterThanOrEqual(1);
      expect(status.quiescent).toBe(false);

      // The run's row is still "running", so the orphan reaper (which the
      // failing-transaction proxy no longer intercepts past call index 1)
      // finds it, finalizes the run, wakeup, and issue lock for real, and
      // this fix drops the in-memory marker along with them. Before the
      // fix, this marker survived the reap and quiescent stayed false
      // until the process restarted.
      const reapResult = await heartbeat.reapOrphanedRuns();
      expect(reapResult.runIds).toContain(runId);

      const reapedRun = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      expect(reapedRun?.status).toBe("failed");
      expect(reapedRun?.errorCode).toBe("process_lost");

      const reapedWakeup = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null);
      expect(reapedWakeup?.status).toBe("failed");

      // The issue is still "todo" and assigned to the same agent, so the
      // reaper's normal self-heal path queues a fresh recovery run for it
      // instead of leaving the lock empty — that recovery is unrelated to
      // this fix and stays queued (not running) because the drain is still
      // active, so it does not itself count toward activeRuns below.
      const reapedIssue = await db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(reapedIssue?.executionRunId).not.toBe(runId);

      const statusAfterReap = getTaskDrainStatus();
      expect(statusAfterReap.activeRuns).toBe(0);
      expect(statusAfterReap.quiescent).toBe(true);
    }, 20_000);
  }

  // Wraps a db handle (which may already be wrapped by
  // withFailingTransactionalUpdate) so a call to db.insert(table) throws
  // once armed.value is true. Lets a test fail one specific later cleanup
  // step without touching any insert that happens earlier.
  function withFailingInsertWhenArmed(realDb: typeof db, table: unknown, armed: { value: boolean }) {
    return new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop !== "insert") return Reflect.get(target, prop, receiver);
        return (insertTable: unknown) => {
          if (armed.value && insertTable === table) {
            throw new Error("simulated insert failure");
          }
          return (target as any).insert(insertTable);
        };
      },
    }) as typeof db;
  }

  // Wraps a db handle (which may already be wrapped by
  // withFailingTransactionalUpdate) so a db.transaction() callback's own
  // tx.update(table) call throws once armed.value is true. This mirrors
  // withFailingInsertWhenArmed above, but for a table a step updates inside
  // its own transaction (releaseIssueExecutionAndPromote updates the issues
  // table this way) instead of a plain top-level insert.
  function withFailingTransactionalUpdateWhenArmed(realDb: typeof db, table: unknown, armed: { value: boolean }) {
    return new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>) =>
          target.transaction((tx) => {
            const txProxy = new Proxy(tx as object, {
              get(txTarget, txProp, txReceiver) {
                if (txProp === "update") {
                  return (updateTable: unknown) => {
                    if (armed.value && updateTable === table) {
                      throw new Error("simulated issue-lock release failure");
                    }
                    return (txTarget as any).update(updateTable);
                  };
                }
                return Reflect.get(txTarget, txProp, txReceiver);
              },
            });
            return fn(txProxy);
          });
      },
    }) as typeof db;
  }

  it("clears the stuck claim-release marker even when later reap cleanup rejects", async () => {
    const { companyId, runId } = await seedQueuedRun();
    // Reuse the same setup as "leaves the run claimed instead of a partial
    // write" above: both the release transaction and the fallback's own
    // transaction fail, so the run stays "running" and its claim-release
    // marker keeps task drain non-quiescent until the orphan reaper picks
    // the run up.
    const transactionFailingDb = withFailingTransactionalUpdate(db, { 0: issues, 1: agentWakeupRequests });
    const armedRunEventInsertFailure = { value: false };
    const failingDb = withFailingInsertWhenArmed(transactionFailingDb, heartbeatRunEvents, armedRunEventInsertFailure);
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

    const claimedStatus = getTaskDrainStatus();
    expect(claimedStatus.activeRuns).toBeGreaterThanOrEqual(1);
    expect(claimedStatus.quiescent).toBe(false);

    // Arm the failure only now, so it hits the reap loop's own run-event
    // insert — a cleanup step that runs after the run's row already reaches
    // a terminal status — instead of any insert during the claim race above.
    armedRunEventInsertFailure.value = true;
    await expect(heartbeat.reapOrphanedRuns()).rejects.toThrow("simulated insert failure");

    // The run's row reached "failed" before the injected failure, and the
    // marker must have cleared right after that point, not only after every
    // later cleanup step succeeds — the bug this test guards against.
    const reapedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(reapedRun?.status).toBe("failed");

    const statusAfterFailedReap = getTaskDrainStatus();
    expect(statusAfterFailedReap.activeRuns).toBe(0);
    expect(statusAfterFailedReap.quiescent).toBe(true);
  }, 20_000);

  // This test's failure (the issue-lock release itself rejects) never
  // resolves the run's marker within this run of the process — see
  // stuckClaimReleaseRunIds's own comment in heartbeat.ts: that is the
  // documented, accepted outcome when the lock release itself keeps
  // failing, not a bug. Because the marker is process-memory state with no
  // per-test reset, this test runs last in the file so its permanently
  // stuck marker cannot affect another test's activeRuns count.
  it("keeps the stuck claim-release marker active when the reap loop's own issue-lock release rejects", async () => {
    const { companyId, issueId, runId } = await seedQueuedRun();
    // Same admission-race setup as "leaves the run claimed instead of a
    // partial write" above: both the release transaction and the fallback's
    // own transaction fail, so the run stays "running" and its
    // claim-release marker keeps task drain non-quiescent until the orphan
    // reaper picks the run up.
    const transactionFailingDb = withFailingTransactionalUpdate(db, { 0: issues, 1: agentWakeupRequests });
    const armedIssueReleaseFailure = { value: false };
    const failingDb = withFailingTransactionalUpdateWhenArmed(transactionFailingDb, issues, armedIssueReleaseFailure);
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

    const claimedStatus = getTaskDrainStatus();
    expect(claimedStatus.activeRuns).toBeGreaterThanOrEqual(1);
    expect(claimedStatus.quiescent).toBe(false);

    // Arm the failure only now, so it hits releaseIssueExecutionAndPromote's
    // own issue-lock update inside the reap loop, after the run's row
    // already reached "failed" — not the admission-time issue-lock write
    // exercised above.
    armedIssueReleaseFailure.value = true;
    await expect(heartbeat.reapOrphanedRuns()).rejects.toThrow("simulated issue-lock release failure");

    const reapedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(reapedRun?.status).toBe("failed");

    // The run's row reached a terminal status, but its issue-lock release
    // itself failed, so the issue is still locked to this run. The marker
    // must stay active and keep reporting this instance non-quiescent — the
    // failure this test guards against clears it as soon as the row reaches
    // a terminal status, before the lock is actually released.
    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(runId);

    const statusAfterFailedRelease = getTaskDrainStatus();
    expect(statusAfterFailedRelease.activeRuns).toBeGreaterThanOrEqual(1);
    expect(statusAfterFailedRelease.quiescent).toBe(false);
  }, 20_000);
});
