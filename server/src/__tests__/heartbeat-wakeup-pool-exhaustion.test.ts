import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.js";

// Regression coverage for paperclipai/paperclip#14196: a wakeup holds one
// pooled connection inside its transaction. Any helper that then reads
// through the global pool needs a second connection. When every connection is
// held by such a transaction, none can finish and the whole API freezes
// (production: 25 assigned child tasks, all 10 connections idle in
// transaction, /api/health timing out). The pool here is deliberately small
// so the same exhaustion shows up with a handful of wakeups.
const POOL_SIZE = 3;
const WAKEUP_DEADLINE_MS = 30_000;
const HEALTH_DEADLINE_MS = 5_000;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat wakeup pool-exhaustion tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat wakeup under a bounded connection pool", () => {
  let db!: ReturnType<typeof createDb>;
  // A separate single-connection client, outside the bounded pool, so the
  // test can still inspect and recover the database after a deadlock.
  let adminDb!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let inFlight: Promise<unknown>[] = [];
  let deadlineExceeded = false;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-wakeup-pool-");
    db = createDb(tempDb.connectionString, { maxConnections: POOL_SIZE });
    adminDb = createDb(tempDb.connectionString, { maxConnections: 1 });
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    if (deadlineExceeded) {
      // A failed deadline may leave transactions waiting on each other. End
      // the bounded pool immediately instead of waiting forever for wakeups
      // that cannot settle. A fresh pool keeps later scenarios independent.
      await db.$client.end({ timeout: 0 });
      db = createDb(tempDb!.connectionString, { maxConnections: POOL_SIZE });
      heartbeat = heartbeatService(db);
      inFlight = [];
      deadlineExceeded = false;
      return;
    }
    // Only a failed run leaves transactions stuck. Terminate them so their
    // wakeups reject and the next test starts with a usable pool.
    await adminDb.execute(sql`
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and state like 'idle in transaction%'
    `);
    await Promise.allSettled(inFlight);
    inFlight = [];
    await heartbeat.drainActiveRunExecutions();
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await adminDb?.$client.end({ timeout: 0 });
    await tempDb?.cleanup();
  }, 60_000);

  async function idleInTransactionCount() {
    const rows = await adminDb.execute(sql`
      select count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and state like 'idle in transaction%'
    `);
    return Number((rows as unknown as Array<{ count: number }>)[0]?.count ?? 0);
  }

  async function withinDeadline<T>(label: string, promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        deadlineExceeded = true;
        void idleInTransactionCount()
          .catch(() => "unknown")
          .then((count) =>
            reject(
              new Error(
                `${label} did not finish within ${ms}ms; ${count} connection(s) idle in transaction (pool size ${POOL_SIZE})`,
              ),
            ),
          );
      }, ms);
    });
    try {
      return await Promise.race([promise, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function expectPoolStillServesQueries() {
    // Stands in for /api/health, which reads through the same pool.
    const rows = await withinDeadline(
      "independent query after the wakeups",
      db.execute(sql`select 1 as ok`),
      HEALTH_DEADLINE_MS,
    );
    expect((rows as unknown as Array<{ ok: number }>)[0]?.ok).toBe(1);
  }

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "company-default-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pool Worker",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    // Occupy the agent's single run slot so queued runs stay queued and the
    // test measures only wakeup admission, not adapter execution.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { taskKey: "busy-slot", wakeReason: "test_busy_slot" },
      startedAt: new Date(),
    });
    return { companyId, agentId, issuePrefix };
  }

  async function seedIssues(input: {
    companyId: string;
    agentId: string;
    issuePrefix: string;
    count: number;
    parentId?: string | null;
    firstNumber?: number;
    // Routine-origin issues make the wake path read the routine env; manual
    // issues return before that read, so they leave its binding unpinned.
    routineOrigin?: boolean;
  }) {
    const ids = Array.from({ length: input.count }, () => randomUUID());
    const firstNumber = input.firstNumber ?? 1;
    await db.insert(issues).values(
      ids.map((id, index) => ({
        id,
        companyId: input.companyId,
        title: `Pool exhaustion task ${index + 1}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: input.agentId,
        parentId: input.parentId ?? null,
        issueNumber: firstNumber + index,
        identifier: `${input.issuePrefix}-${firstNumber + index}`,
        ...(input.routineOrigin ? { originKind: "routine_execution", originId: randomUUID() } : {}),
      })),
    );
    return ids;
  }

  function assignmentWake(agentId: string, issueId: string) {
    return heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: null,
    });
  }

  it("completes concurrent assignment wakeups on one issue and keeps the pool usable", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const [issueId] = await seedIssues({ companyId, agentId, issuePrefix, count: 1, routineOrigin: true });

    const wakeups = Array.from({ length: POOL_SIZE * 3 }, () => assignmentWake(agentId, issueId));
    inFlight = wakeups;

    const results = await withinDeadline("concurrent same-issue wakeups", Promise.all(wakeups), WAKEUP_DEADLINE_MS);

    const queuedRunIds = [...new Set(results.flatMap((run) => (run ? [run.id] : [])))];
    expect(queuedRunIds.length).toBeGreaterThan(0);
    const queued = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, queuedRunIds));
    // Resolved through the company default, read on the wakeup's own transaction.
    expect(queued.every((run) => run.agentId === agentId && run.responsibleUserId === "company-default-user")).toBe(true);

    await expectPoolStillServesQueries();
  }, 60_000);

  it("completes one assignment wakeup per child task, as when 25 child tasks are accepted at once", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const parentId = randomUUID();
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent task",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "parent-owner",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    const childIds = await seedIssues({
      companyId,
      agentId,
      issuePrefix,
      count: 25,
      parentId,
      firstNumber: 2,
      routineOrigin: true,
    });

    const wakeups = childIds.map((issueId) => assignmentWake(agentId, issueId));
    inFlight = wakeups;

    const results = await withinDeadline("concurrent child-task wakeups", Promise.all(wakeups), WAKEUP_DEADLINE_MS);

    expect(results.every((run) => run?.status === "queued")).toBe(true);
    const runs = await db
      .select({ responsibleUserId: heartbeatRuns.responsibleUserId, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"));
    const childIdSet = new Set<string>(childIds);
    const childRuns = runs.filter((run) => childIdSet.has(String(run.contextSnapshot?.issueId)));
    expect(childRuns).toHaveLength(childIds.length);
    // Resolved through the parent issue, read on the wakeup's own transaction.
    expect(childRuns.every((run) => run.responsibleUserId === "parent-owner")).toBe(true);

    await expectPoolStillServesQueries();
  }, 60_000);

  it("completes concurrent agent-scoped wakeups without an issue and keeps the pool usable", async () => {
    const { agentId } = await seedCompanyAndAgent();

    const wakeups = Array.from({ length: POOL_SIZE * 3 }, (_, index) =>
      heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "pool_exhaustion_regression",
        contextSnapshot: { taskKey: `pool-task-${index}`, wakeReason: "pool_exhaustion_regression" },
        requestedByActorType: "system",
        requestedByActorId: null,
      }),
    );
    inFlight = wakeups;

    const results = await withinDeadline("concurrent agent-scoped wakeups", Promise.all(wakeups), WAKEUP_DEADLINE_MS);

    expect(results.every((run) => run?.status === "queued")).toBe(true);
    // Resolved through the company default, read on the wakeup's own transaction.
    expect(results.every((run) => run?.responsibleUserId === "company-default-user")).toBe(true);

    await expectPoolStillServesQueries();
  }, 60_000);

  it("completes concurrent continuation wakeups on distinct issues with isolated workspaces and a prior session", async () => {
    // With isolated workspaces on, each issue wakeup probes the task session of
    // the issue's prior run while it holds its issue-transaction connection.
    // Continuation wakes (not issue_assigned) keep that session, so the probe
    // reads the session row and must do it on the wakeup's own transaction.
    const settings = instanceSettingsService(db);
    const previous = await settings.getExperimental();
    const sessionCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pool-session-"));
    try {
      await settings.updateExperimental({ enableIsolatedWorkspaces: true });
      const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
      const issueIds = await seedIssues({ companyId, agentId, issuePrefix, count: POOL_SIZE * 2, routineOrigin: true });
      await db.insert(agentTaskSessions).values(
        issueIds.map((issueId) => ({
          companyId,
          agentId,
          adapterType: "process",
          taskKey: issueId,
          sessionParamsJson: { sessionId: `session-${issueId}`, cwd: sessionCwd },
        })),
      );

      const wakeups = issueIds.map((issueId) =>
        heartbeat.wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId },
          contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
          requestedByActorType: "system",
          requestedByActorId: null,
        }),
      );
      inFlight = wakeups;

      const results = await withinDeadline(
        "concurrent isolated-workspace continuation wakeups",
        Promise.all(wakeups),
        WAKEUP_DEADLINE_MS,
      );

      expect(results.every((run) => run?.status === "queued")).toBe(true);
      await expectPoolStillServesQueries();
    } finally {
      await fs.rm(sessionCwd, { recursive: true, force: true });
      // Reset through the admin connection: after a deadlock the bounded pool
      // may be unusable.
      await instanceSettingsService(adminDb)
        .updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces })
        .catch(() => undefined);
    }
  }, 60_000);

  it("completes concurrent run releases that promote a deferred wake, resolving the owner through the release transaction", async () => {
    // Drives the production wake-queue callbacks in heartbeat.ts. Each release
    // runs in a transaction that holds one pooled connection and promotes a
    // deferred wake, which reads the routine env (the issues are routine-origin
    // so that read happens), the responsible user and the prior session. A callback that reads through the global pool needs a
    // second connection per release and deadlocks the bounded pool.
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const finishingAgentIds = Array.from({ length: POOL_SIZE * 2 }, () => randomUUID());
    await db.insert(agents).values(
      finishingAgentIds.map((id, index) => ({
        id,
        companyId,
        name: `Finishing Agent ${index + 1}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    const issueIds = await seedIssues({
      companyId,
      agentId,
      issuePrefix,
      count: finishingAgentIds.length,
      routineOrigin: true,
    });
    const runIds = finishingAgentIds.map(() => randomUUID());
    await db.insert(heartbeatRuns).values(
      runIds.map((id, index) => ({
        id,
        companyId,
        agentId: finishingAgentIds[index]!,
        invocationSource: "assignment" as const,
        triggerDetail: "system",
        status: "running",
        runtimeMode: "legacy" as const,
        startedAt: new Date(),
        contextSnapshot: { issueId: issueIds[index] },
      })),
    );
    // Each issue is locked by its finishing run and has a wake deferred behind
    // it, without a responsible user so the company default is resolved.
    for (const [index, issueId] of issueIds.entries()) {
      await db.update(issues).set({ executionRunId: runIds[index]! }).where(eq(issues.id, issueId));
    }
    const deferredWakeIds = issueIds.map(() => randomUUID());
    await db.insert(agentWakeupRequests).values(
      issueIds.map((issueId, index) => ({
        id: deferredWakeIds[index]!,
        companyId,
        agentId,
        source: "automation",
        reason: "issue_commented",
        status: "deferred_issue_execution",
        requestedByActorType: "system" as const,
        requestedByActorId: "test",
        requestedAt: new Date(),
        payload: { issueId },
      })),
    );

    // A workspace wait releases the lock and goes on to promote the deferred wake.
    const cancels = runIds.map((runId) =>
      heartbeat.cancelRun(runId, undefined, {
        errorCode: "workspace_busy",
        resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false } },
      }),
    );
    inFlight = cancels;

    await withinDeadline("concurrent run releases", Promise.all(cancels), WAKEUP_DEADLINE_MS);

    const promoted = await db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.id, deferredWakeIds));
    expect(promoted.every((wake) => wake.status !== "deferred_issue_execution" && wake.runId !== null)).toBe(true);
    const promotedRuns = await db
      .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, promoted.flatMap((wake) => (wake.runId ? [wake.runId] : []))));
    expect(promotedRuns).toHaveLength(deferredWakeIds.length);
    expect(promotedRuns.every((run) => run.responsibleUserId === "company-default-user")).toBe(true);

    await expectPoolStillServesQueries();
  }, 60_000);
});
