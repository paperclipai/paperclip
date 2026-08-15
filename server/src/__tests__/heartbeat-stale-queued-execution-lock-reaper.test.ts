import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { STALE_QUEUED_EXECUTION_LOCK_ERROR_CODE } from "../services/stale-queued-execution-lock.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Capacity-blocked queued run claimed.",
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale queued execution-lock reaper tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describeEmbeddedPostgres("stale queued execution-lock reaper", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const now = new Date("2026-07-29T12:00:00.000Z");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-queued-lock-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    mockAdapterExecute.mockClear();
    await db.execute(sql.raw('TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE'));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLockedQueuedRun(input?: {
    createdAt?: Date;
    scheduledRetryAt?: Date | null;
    runPatch?: Partial<typeof heartbeatRuns.$inferInsert>;
    wakeupPatch?: Partial<typeof agentWakeupRequests.$inferInsert>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    const createdAt = input?.createdAt ?? new Date("2026-07-28T05:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QueueReaperAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "scheduled_retry",
      payload: { issueId },
      status: "queued",
      runId,
      requestedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
      ...(input?.wakeupPatch ?? {}),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      scheduledRetryAt: input?.scheduledRetryAt === undefined
        ? new Date("2026-07-28T06:00:00.000Z")
        : input.scheduledRetryAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "provider_quota",
      contextSnapshot: {
        issueId,
        wakeReason: "scheduled_retry",
        retryReason: "provider_quota",
      },
      createdAt,
      updatedAt: createdAt,
      ...(input?.runPatch ?? {}),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Legacy queued execution lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "queuereaperagent",
      executionLockedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });

    return { companyId, agentId, issueId, runId, wakeupRequestId };
  }

  it("reaps the GOLAA-8387 shape once under concurrent and repeated invocation", async () => {
    const seeded = await seedLockedQueuedRun();

    const [left, right] = await Promise.all([
      heartbeat.reapStaleQueuedExecutionLocks({ now }),
      heartbeat.reapStaleQueuedExecutionLocks({ now }),
    ]);
    const repeated = await heartbeat.reapStaleQueuedExecutionLocks({ now });

    expect(left.reaped + right.reaped).toBe(1);
    expect(repeated).toEqual({ reaped: 0, runIds: [], issueIds: [] });

    const [run, wakeup, issue, events, activities] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)).then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeupRequestId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0]),
      db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, seeded.runId)),
      db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.stale_queued_execution_lock_reaped")),
    ]);

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: STALE_QUEUED_EXECUTION_LOCK_ERROR_CODE,
      finishedAt: now,
    });
    expect(run?.resultJson).toMatchObject({
      stopReason: STALE_QUEUED_EXECUTION_LOCK_ERROR_CODE,
      timeoutSource: "stale_queued_execution_lock_reaper",
      timeoutFired: true,
    });
    expect(wakeup).toMatchObject({ status: "cancelled", finishedAt: now });
    expect(issue).toMatchObject({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "lifecycle", level: "warn" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      entityType: "issue",
      entityId: seeded.issueId,
      runId: seeded.runId,
    });
  });

  it("does not reap a future-dated scheduled retry", async () => {
    const seeded = await seedLockedQueuedRun({
      scheduledRetryAt: new Date("2026-07-29T13:00:00.000Z"),
    });

    const result = await heartbeat.reapStaleQueuedExecutionLocks({ now });

    expect(result).toEqual({ reaped: 0, runIds: [], issueIds: [] });
    const [run, wakeup, issue] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)).then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeupRequestId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0]),
    ]);
    expect(run?.status).toBe("queued");
    expect(wakeup?.status).toBe("queued");
    expect(issue?.executionRunId).toBe(seeded.runId);
  });

  it("does not reap a scheduled retry within the one-hour overdue grace", async () => {
    const seeded = await seedLockedQueuedRun({
      scheduledRetryAt: new Date("2026-07-29T11:15:00.000Z"),
    });

    const result = await heartbeat.reapStaleQueuedExecutionLocks({ now });

    expect(result).toEqual({ reaped: 0, runIds: [], issueIds: [] });
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("queued");
  });

  it("does not reap recently queued ordinary work", async () => {
    const seeded = await seedLockedQueuedRun({
      createdAt: new Date("2026-07-29T11:58:00.000Z"),
      scheduledRetryAt: null,
      runPatch: {
        invocationSource: "assignment",
        scheduledRetryAttempt: 0,
        scheduledRetryReason: null,
      },
    });

    const result = await heartbeat.reapStaleQueuedExecutionLocks({ now });

    expect(result.reaped).toBe(0);
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("queued");
  });

  it("reaps a legacy locked row that predates an enabled worktree cutoff", async () => {
    const cutoff = new Date("2026-07-29T11:00:00.000Z");
    const runtimeEnv = {
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_INSTANCE_ID: "stale-queued-lock-test",
    };
    await instanceSettingsService(db, {
      runtimeEnv,
      now: () => cutoff,
    }).updateExperimental({ enableWorktreeRunExecution: true });
    const worktreeHeartbeat = heartbeatService(db, { runtimeEnv });
    const seeded = await seedLockedQueuedRun();

    const result = await worktreeHeartbeat.reapStaleQueuedExecutionLocks({ now });

    expect(result).toEqual({
      reaped: 1,
      runIds: [seeded.runId],
      issueIds: [seeded.issueId],
    });
  });

  it("preserves an overdue retry while its agent is at capacity, then allows it to claim", async () => {
    const seeded = await seedLockedQueuedRun();
    const capacityRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: capacityRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "timer",
      triggerDetail: "interval",
      status: "running",
      startedAt: new Date("2026-07-29T10:00:00.000Z"),
      createdAt: new Date("2026-07-29T10:00:00.000Z"),
      updatedAt: new Date("2026-07-29T10:00:00.000Z"),
    });

    const whileAtCapacity = await heartbeat.reapStaleQueuedExecutionLocks({ now });

    expect(whileAtCapacity).toEqual({ reaped: 0, runIds: [], issueIds: [] });
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: now, updatedAt: now })
      .where(eq(heartbeatRuns.id, capacityRunId));

    await heartbeat.resumeQueuedRuns();
    const afterResume = await heartbeat.reapStaleQueuedExecutionLocks({ now });
    await heartbeat.drainActiveRunExecutions();

    expect(afterResume).toEqual({ reaped: 0, runIds: [], issueIds: [] });
    const [run, wakeup] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)).then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeupRequestId)).then((rows) => rows[0]),
    ]);
    expect(mockAdapterExecute).toHaveBeenCalled();
    expect(run?.startedAt).not.toBeNull();
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).not.toBe(STALE_QUEUED_EXECUTION_LOCK_ERROR_CODE);
    expect(wakeup?.status).toBe("completed");
  });

  it("preserves an overdue retry for a bounded grace after a higher-priority sibling finishes", async () => {
    const seeded = await seedLockedQueuedRun();
    const higherPriorityIssueId = randomUUID();
    const higherPriorityRunId = randomUUID();
    const higherPriorityFinishedAt = new Date("2026-07-29T11:59:30.000Z");
    await db
      .update(issues)
      .set({ priority: "low" })
      .where(eq(issues.id, seeded.issueId));
    await db.insert(issues).values({
      id: higherPriorityIssueId,
      companyId: seeded.companyId,
      title: "Higher-priority queued work",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: seeded.agentId,
      createdAt: new Date("2026-07-29T11:58:00.000Z"),
      updatedAt: higherPriorityFinishedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: higherPriorityRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      startedAt: new Date("2026-07-29T11:59:00.000Z"),
      finishedAt: higherPriorityFinishedAt,
      contextSnapshot: { issueId: higherPriorityIssueId },
      createdAt: new Date("2026-07-29T11:58:00.000Z"),
      updatedAt: higherPriorityFinishedAt,
    });

    const duringCapacityTransition = await heartbeat.reapStaleQueuedExecutionLocks({ now });

    expect(duringCapacityTransition).toEqual({ reaped: 0, runIds: [], issueIds: [] });
    const preservedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId))
      .then((rows) => rows[0]);
    expect(preservedRun?.status).toBe("queued");

    const afterCapacityGrace = await heartbeat.reapStaleQueuedExecutionLocks({
      now: new Date("2026-07-29T13:00:00.000Z"),
    });

    expect(afterCapacityGrace).toEqual({
      reaped: 1,
      runIds: [seeded.runId],
      issueIds: [seeded.issueId],
    });
  }, 20_000);

  it("still reaps within a bounded grace when the agent keeps finishing later runs", async () => {
    // GOLAA-8435 F4 regression: a rolling MAX anchor let any agent that
    // finishes work more than once per hour push staleAt forward forever, so
    // the backstop never fired on a busy agent. The anchor is the FIRST
    // capacity release at/after eligibility, so continued activity cannot
    // extend the grace. Fails against the rolling-MAX build (staleAt anchored
    // to 12:45 -> 13:45, so no reap at 13:00).
    const seeded = await seedLockedQueuedRun();
    // First release at/after eligibility, then the agent stays busy every 15m.
    const releaseTimes = [
      "2026-07-29T11:59:30.000Z",
      "2026-07-29T12:15:00.000Z",
      "2026-07-29T12:30:00.000Z",
      "2026-07-29T12:45:00.000Z",
    ];
    for (const finishedAtIso of releaseTimes) {
      const siblingIssueId = randomUUID();
      const siblingRunId = randomUUID();
      const finishedAt = new Date(finishedAtIso);
      const startedAt = new Date(finishedAt.getTime() - 30_000);
      await db.insert(issues).values({
        id: siblingIssueId,
        companyId: seeded.companyId,
        title: "Sibling capacity work",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: seeded.agentId,
        createdAt: startedAt,
        updatedAt: finishedAt,
      });
      await db.insert(heartbeatRuns).values({
        id: siblingRunId,
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "succeeded",
        startedAt,
        finishedAt,
        contextSnapshot: { issueId: siblingIssueId },
        createdAt: startedAt,
        updatedAt: finishedAt,
      });
    }

    // Before first-release + 1h grace: preserved (proves grace is measured
    // from the capacity release, not eligibility, which is >30h earlier).
    const beforeGrace = await heartbeat.reapStaleQueuedExecutionLocks({
      now: new Date("2026-07-29T12:30:00.000Z"),
    });
    expect(beforeGrace).toEqual({ reaped: 0, runIds: [], issueIds: [] });

    // After first-release + 1h (11:59:30 -> 12:59:30), the lock is reaped even
    // though a later sibling finished at 12:45; the anchor did not move.
    const afterGrace = await heartbeat.reapStaleQueuedExecutionLocks({
      now: new Date("2026-07-29T13:00:00.000Z"),
    });
    expect(afterGrace).toEqual({
      reaped: 1,
      runIds: [seeded.runId],
      issueIds: [seeded.issueId],
    });
    const reapedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId))
      .then((rows) => rows[0]);
    expect(reapedRun?.status).toBe("cancelled");
  }, 20_000);

  it("is a no-op when a claim wins after stale-candidate discovery", async () => {
    const seeded = await seedLockedQueuedRun();
    const lockReady = deferred();
    const allowClaim = deferred();

    const claimTransaction = db.transaction(async (tx) => {
      await tx.execute(sql`select id from heartbeat_runs where id = ${seeded.runId} for update`);
      lockReady.resolve();
      await allowClaim.promise;
      await tx
        .update(heartbeatRuns)
        .set({ status: "running", startedAt: now, updatedAt: now })
        .where(eq(heartbeatRuns.id, seeded.runId));
      await tx
        .update(agentWakeupRequests)
        .set({ status: "claimed", claimedAt: now, updatedAt: now })
        .where(eq(agentWakeupRequests.id, seeded.wakeupRequestId));
    });

    await lockReady.promise;
    const reapPromise = heartbeat.reapStaleQueuedExecutionLocks({ now });
    await new Promise((resolve) => setTimeout(resolve, 75));
    allowClaim.resolve();
    await claimTransaction;
    const result = await reapPromise;

    expect(result.reaped).toBe(0);
    const [run, wakeup, issue, activities] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)).then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeupRequestId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0]),
      db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.stale_queued_execution_lock_reaped")),
    ]);
    expect(run).toMatchObject({ status: "running", startedAt: now });
    expect(wakeup).toMatchObject({ status: "claimed", claimedAt: now });
    expect(issue?.executionRunId).toBe(seeded.runId);
    expect(activities).toHaveLength(0);
  });

  it("preserves a changed issue lock when the pointer changes after candidate discovery", async () => {
    const seeded = await seedLockedQueuedRun();
    const replacementRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: replacementRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId: seeded.issueId },
      createdAt: now,
      updatedAt: now,
    });

    const lockReady = deferred();
    const allowLockChange = deferred();
    const lockChangeTransaction = db.transaction(async (tx) => {
      await tx.execute(sql`select id from issues where id = ${seeded.issueId} for update`);
      lockReady.resolve();
      await allowLockChange.promise;
      await tx
        .update(issues)
        .set({ executionRunId: replacementRunId, executionLockedAt: now, updatedAt: now })
        .where(eq(issues.id, seeded.issueId));
    });

    await lockReady.promise;
    const reapPromise = heartbeat.reapStaleQueuedExecutionLocks({ now });
    await new Promise((resolve) => setTimeout(resolve, 75));
    allowLockChange.resolve();
    await lockChangeTransaction;
    const result = await reapPromise;

    expect(result.reaped).toBe(0);
    const [staleRun, wakeup, issue, events] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)).then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeupRequestId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0]),
      db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, seeded.runId)),
    ]);
    expect(staleRun?.status).toBe("queued");
    expect(wakeup?.status).toBe("queued");
    expect(issue?.executionRunId).toBe(replacementRunId);
    expect(events).toHaveLength(0);
  });
});
