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
      await db.$client.end({ timeout: 0 });
      db = createDb(tempDb!.connectionString, { maxConnections: POOL_SIZE });
      heartbeat = heartbeatService(db);
      inFlight = [];
      deadlineExceeded = false;
      return;
    }
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
    expect(results.every((run) => run?.responsibleUserId === "company-default-user")).toBe(true);

    await expectPoolStillServesQueries();
  }, 60_000);

  it("completes concurrent continuation wakeups on distinct issues with isolated workspaces and a prior session", async () => {
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
      await instanceSettingsService(adminDb)
        .updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces })
        .catch(() => undefined);
    }
  }, 60_000);

  it("completes concurrent run releases that promote a deferred wake, resolving the owner through the release transaction", async () => {
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
