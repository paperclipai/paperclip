import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  applyPendingMigrations,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  heartbeatRunEvents,
  environmentLeases,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { returnStoppedWaitingTaskToTodo } from "../services/heartbeat/stopped-waiting-task.ts";
import { executionProjectionsForRuns } from "../services/execution-projection.ts";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.ts";
import { agentRoutes } from "../routes/agents.ts";
import { issueRoutes } from "../routes/issues.ts";
import { errorHandler } from "../middleware/index.ts";
import { issueService } from "../services/issues.ts";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapters/index.ts";
import { HttpError } from "../errors.ts";
import { settleCancelledLegacyPreparation } from "../services/legacy-execution-recovery.ts";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.ts";

const gates = vi.hoisted(() => new Map<string, (() => void) | null>());
const preparation = vi.hoisted(() => ({
  beforeSession: undefined as (() => Promise<void>) | undefined,
  onExecution: undefined as ((context: AdapterExecutionContext) => Promise<void>) | undefined,
}));
vi.mock("../services/heartbeat/session-preparation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat/session-preparation.js")>();
  return { ...actual, prepareHeartbeatSession: async (...args: Parameters<typeof actual.prepareHeartbeatSession>) => {
    await preparation.beforeSession?.();
    return actual.prepareHeartbeatSession(...args);
  } };
});
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (context: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    const issueId = (context.context as Record<string, unknown> | undefined)?.issueId;
    // One-shot gate: hold only the first run of a gated task so the slot stays busy.
    if (typeof issueId === "string" && gates.get(issueId) === null) {
      await new Promise<void>((resolve) => gates.set(issueId, resolve));
    }
    await preparation.onExecution?.(context);
    return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "ok", provider: "test", model: "test" };
  }),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_STOP_QUEUED_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Stop on a task whose run is still waiting in line", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const executedIssueIds = () =>
    mockAdapterExecute.mock.calls.map(([context]) => (context.context as Record<string, unknown>)?.issueId);

  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stop-queued-task-");
    db = createDb(external ?? tempDb!.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    preparation.beforeSession = undefined;
    preparation.onExecution = undefined;
    for (const release of gates.values()) release?.();
    gates.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockClear();
    await truncateTablesWithDeadlockRetry(db, `
      TRUNCATE TABLE "issue_comments", "issues", "heartbeat_run_events", "cost_events", "activity_log",
        "heartbeat_runs", "agent_wakeup_requests", "agent_runtime_state", "agents", "companies"
      RESTART IDENTITY CASCADE
    `, { attempts: 10, delayMs: () => 100 });
    await db.delete(authUsers).where(eq(authUsers.id, "responsible-user"));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user", requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    return { companyId, agentId };
  }

  async function assignAndWake(companyId: string, agentId: string, title: string, status: "todo" | "in_progress" = "todo") {
    const [issue] = await db.insert(issues).values({ companyId, title, status, assigneeAgentId: agentId }).returning();
    const run = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: issue.id } });
    expect(run).toBeTruthy();
    return { issue, run: run! };
  }

  it("confirms Stop during preparation and continues once from a later message", async () => {
    const { companyId, agentId } = await seed();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "responsible-user", companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false };
      next();
    });
    app.use("/api", agentRoutes(db, {}));
    const unusedStorage = async () => { throw new Error("Stop and comment routes must not access object storage"); };
    app.use("/api", issueRoutes(db, { provider: "local_disk", putFile: unusedStorage,
      getObject: unusedStorage, headObject: unusedStorage, deleteObject: unusedStorage }));
    app.use(errorHandler);
    let entered = false;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    preparation.beforeSession = async () => { entered = true; await released; };
    try {
      const { issue, run } = await assignAndWake(companyId, agentId, "Accidental submission");
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 });
      const stop = await request(app).post(`/api/heartbeat-runs/${run.id}/cancel`).send({});
      expect(stop.status).toBe(200);
      expect(stop.body.status).toBe("cancelled");
      // Terminal status alone must not confirm a Stop while preparation owns it.
      expect(stop.body.resultJson.executionCancellation).toMatchObject({ state: "requested" });
      release();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const settled = await request(app).get(`/api/heartbeat-runs/${run.id}`);
      expect(settled.status).toBe(200);
      expect(settled.body.resultJson.executionCancellation).toMatchObject({ state: "acknowledged", proof: "preparation_settled", acknowledgedAt: expect.any(String) });
      expect(executedIssueIds()).not.toContain(issue.id);
      expect((await executionProjectionsForRuns(db, companyId, [run.id])).get(run.id)).toMatchObject({
        phase: "completed", label: "Stopped", cause: null,
        nextAction: "Send a new message to continue from saved work.",
      });
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id)))
        .filter(action => action.status === "active" || action.status === "escalated")).toHaveLength(0);
      const [task] = await db.select().from(issues).where(eq(issues.id, issue.id));
      expect(await taskInterruptionPresentation(db, task)).toMatchObject({ state: "resolved", canRetry: false });
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
      expect(events.find(event => event.message === "run cancelled")?.level).toBe("info");
      await heartbeat.reconcileStrandedAssignedIssues();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(executedIssueIds()).not.toContain(issue.id);

      preparation.beforeSession = undefined;
      // Simulate the agent's final reply and task completion. A raw adapter exit
      // without a task disposition correctly triggers a separate follow-up.
      preparation.onExecution = async context => {
        await context.onEvent?.({ eventType: "item.completed", stream: "stdout", level: "info", payload: {
          prpEvent: { sourceEventId: `fixture:${context.runId}:final`, payload: { kind: "agentMessage", channel: "final", text: "ok" } },
        } });
        await issueService(db).update(issue.id, { status: "done" });
      };
      const message = await request(app).post(`/api/issues/${issue.id}/comments`).send({ body: "Continue with the corrected request." });
      expect(message.status).toBe(201);
      // Comment dispatch is asynchronous; wait for its wake to register before
      // draining the process-wide executor set or tearing down its task rows.
      await vi.waitFor(() => expect(executedIssueIds()).toContain(issue.id), { timeout: 10_000 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(executedIssueIds().filter(id => id === issue.id)).toHaveLength(1);
      expect((await heartbeat.getRun(run.id))?.status).toBe("cancelled");
    } finally { release(); }
  }, 60_000);

  it.each([false, true])("confirms Stop only after lease release, with prior automatic disposition: %s", async (disposeFirst) => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, assigneeAgentId: agentId, title: "Retained preparation", status: "in_progress" }).returning();
    const requestedAt = new Date().toISOString();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id,
      status: "cancelled", runtimeMode: "legacy", startedAt: new Date(), finishedAt: new Date(), errorCode: "cancelled",
      contextSnapshot: { issueId: issue.id }, resultJson: {
        cancellation: { source: "operator", expected: true, initiator: { type: "user", id: "responsible-user" }, reason: "Stop", recordedAt: requestedAt },
        executionCancellation: { state: "requested", requestedAt },
      } }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId: issue.id, heartbeatRunId: run.id,
      provider: "local", status: "active" }).returning();
    expect(await settleCancelledLegacyPreparation(db, { run, providerDispatchStarted: false })).toBeNull();
    expect((await heartbeat.getRun(run.id))?.resultJson?.executionCancellation).toEqual({ state: "requested", requestedAt });
    expect((await executionProjectionsForRuns(db, companyId, [run.id])).get(run.id)?.phase).toBe("failed");
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });

    if (disposeFirst) {
      await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id,
        kind: "active_run_watchdog", status: "active", ownerType: "system", returnOwnerAgentId: agentId,
        cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${run.id}`,
        nextAction: "Preserve this stopped execution until its outcome is known.", evidence: { runId: run.id } });
      await settleUnrecoverableExecutions(db);
      const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id));
      expect(hold).toMatchObject({ status: "resolved", outcome: "blocked",
        evidence: { automaticRecovery: { replay: "blocked" }, legacyCancellationBlock: { runId: run.id } } });
      expect((await executionProjectionsForRuns(db, companyId, [run.id])).get(run.id)?.phase).toBe("recovery_needed");
    }

    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" }).where(eq(environmentLeases.id, lease.id));
    const settled = await settleCancelledLegacyPreparation(db, { run, providerDispatchStarted: false });
    expect(settled?.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", proof: "preparation_settled", requestedAt });
    expect((await executionProjectionsForRuns(db, companyId, [run.id])).get(run.id)).toMatchObject({ phase: "completed", label: "Stopped" });
    const [settledIssue] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(settledIssue.status).toBe("in_progress");
    expect(await taskInterruptionPresentation(db, settledIssue)).toMatchObject({ state: "resolved", canRetry: false });
    expect(executedIssueIds()).not.toContain(issue.id);
  });

  it.each(["2026-01-01T00:00:00.000Z", null])("retains the Stop hold after dispatch handoff without an invocation event: %s", async (handedOffAt) => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, assigneeAgentId: agentId,
      title: "Dispatch handoff before adapter entry", status: "in_progress" }).returning();
    const requestedAt = new Date().toISOString();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id,
      status: "cancelled", runtimeMode: "legacy", startedAt: new Date(), finishedAt: new Date(), errorCode: "cancelled",
      contextSnapshot: { issueId: issue.id }, runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      resultJson: {
        cancellation: { source: "operator", expected: true, initiator: { type: "user", id: "responsible-user" },
          reason: "Stop", recordedAt: requestedAt },
        executionCancellation: { state: "requested", requestedAt },
      } }).returning();
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id,
      kind: "active_run_watchdog", status: "active", ownerType: "system", returnOwnerAgentId: agentId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${run.id}`,
      nextAction: "Preserve this stopped execution until its outcome is known.", evidence: { runId: run.id } }).returning();
    // The old owner has a stale snapshot. The replacement has passed the gate,
    // but has not recorded adapter.invoke or a process identity yet.
    await db.update(heartbeatRuns).set({ usageJson: { budgetDispatch: { handedOffAt } }, executionStage: "dispatching" })
      .where(eq(heartbeatRuns.id, run.id));
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id))).toEqual([]);
    expect(await settleCancelledLegacyPreparation(db, { run, providerDispatchStarted: false })).toBeNull();
    const stopped = await heartbeat.getRun(run.id);
    expect(stopped?.resultJson).toEqual(run.resultJson);
    const [retained] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
    expect(retained).toMatchObject({ status: "active", outcome: null, evidence: hold.evidence });
    expect((await executionProjectionsForRuns(db, companyId, [run.id])).get(run.id)?.phase).not.toBe("completed");
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed" });
    expect(executedIssueIds()).not.toContain(issue.id);
  });

  it("preserves a system cancellation's recovery delivery when preparation settles", async () => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, assigneeAgentId: agentId,
      title: "Stale continuation", status: "in_progress" }).returning();
    const requestedAt = new Date().toISOString();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id,
      status: "cancelled", runtimeMode: "legacy", startedAt: new Date(), finishedAt: new Date(),
      contextSnapshot: { issueId: issue.id }, resultJson: {
        cancellation: { source: "control_plane", expected: true, initiator: { type: "system" },
          reason: "continuation_task_ownership_changed", recordedAt: requestedAt },
        executionCancellation: { state: "requested", requestedAt },
      } }).returning();
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id,
      kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "system", returnOwnerAgentId: agentId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${run.id}`,
      nextAction: "Continue saved input through recovery.", evidence: { runId: run.id,
        automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", continuationDelivery: "pending" } } }).returning();
    const result = await settleCancelledLegacyPreparation(db, { run, providerDispatchStarted: false });
    expect(result?.resultJson?.executionCancellation).toEqual({ state: "requested", requestedAt });
    const [settled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
    expect(settled.evidence.automaticRecovery).toEqual({ policy: "preserve_without_replay_v1",
      replay: "allowed", continuationDelivery: "pending" });
  });

  it.each(["todo", "in_progress"] as const)("takes a %s task out of line in one Stop and still promotes the agent's next task", async (waitingStatus) => {
    const { companyId, agentId } = await seed();
    const busy = randomUUID();
    const [busyIssue] = await db.insert(issues).values({ id: busy, companyId, title: "Busy", status: "todo", assigneeAgentId: agentId }).returning();
    gates.set(busyIssue.id, null);
    const busyRun = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: busyIssue.id } });
    await vi.waitFor(() => expect(executedIssueIds()).toContain(busyIssue.id), { timeout: 10_000 });

    const waiting = await assignAndWake(companyId, agentId, "Waiting task", waitingStatus);
    const next = await assignAndWake(companyId, agentId, "Next task");
    expect((await heartbeat.getRun(waiting.run.id))?.status).toBe("queued");
    expect((await heartbeat.getRun(next.run.id))?.status).toBe("queued");

    const stopped = await heartbeat.cancelRun(waiting.run.id, "Cancelled by a board operator", {
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "responsible-user" },
    });
    expect(stopped?.status).toBe("cancelled");
    // The board Stop route follows the cancel with this status return.
    await returnStoppedWaitingTaskToTodo(db, stopped!, { userId: "responsible-user" });

    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, waiting.run.wakeupRequestId!));
    expect(wake.status).toBe("cancelled");
    const [waitingIssue] = await db.select().from(issues).where(eq(issues.id, waiting.issue.id));
    expect(waitingIssue.executionRunId).toBeNull();
    expect(waitingIssue.status).toBe("todo");
    const statusActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, waiting.issue.id));
    expect(statusActivity.filter((row) => row.action === "issue.updated")).toHaveLength(waitingStatus === "in_progress" ? 1 : 0);

    // Free the slot: the agent's next task promotes, the stopped one never runs again.
    gates.get(busyIssue.id)?.();
    await vi.waitFor(() => expect(executedIssueIds()).toContain(next.issue.id), { timeout: 45_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.reconcileStrandedAssignedIssues();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(executedIssueIds()).not.toContain(waiting.issue.id);
    const laterRuns = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${waiting.issue.id}`);
    expect(laterRuns).toEqual([{ id: waiting.run.id, status: "cancelled" }]);
    const [afterIssue] = await db.select().from(issues).where(eq(issues.id, waiting.issue.id));
    expect(afterIssue.status).toBe("todo");
    expect(afterIssue.executionRunId).toBeNull();
    expect(busyRun).toBeTruthy();
  }, 120_000);

  /** Hold the task row in another transaction until `release` is called. */
  async function holdTaskRow(issueId: string) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      locked();
      await released;
    });
    await lockTaken;
    return { release, holder };
  }

  async function queueBehindBusyTask() {
    const { companyId, agentId } = await seed();
    const [busyIssue] = await db.insert(issues).values({ companyId, title: "Busy", status: "todo", assigneeAgentId: agentId }).returning();
    gates.set(busyIssue.id, null);
    await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: busyIssue.id } });
    await vi.waitFor(() => expect(executedIssueIds()).toContain(busyIssue.id), { timeout: 10_000 });
    const waiting = await assignAndWake(companyId, agentId, "Waiting task");
    const queued = await heartbeat.getRun(waiting.run.id);
    expect(queued?.status).toBe("queued");
    expect(queued?.runtimeMode).toBe("legacy");
    return waiting;
  }

  // The board route attributes Stop to the user, which first supersedes the
  // task's handoffs under the same task-row lock.
  const stopCallers = [
    { caller: "control plane", reason: "Cancelled by control plane", options: undefined },
    { caller: "board", reason: "Cancelled by a board operator",
      options: { resultJson: { cancelledByActorType: "user", cancelledByUserId: "responsible-user" } } },
  ] as const;

  it.each(stopCallers)("stops a waiting legacy run for the $caller when another writer briefly holds its task row past the lock timeout", async ({ reason, options }) => {
    const waiting = await queueBehindBusyTask();
    const lock = await holdTaskRow(waiting.issue.id);
    // Longer than one 1s lock_timeout, shorter than the bounded attempts.
    const releaseTimer = setTimeout(lock.release, 1_500);
    try {
      const stopped = await heartbeat.cancelRun(waiting.run.id, reason, options);
      expect(stopped?.status).toBe("cancelled");
    } finally {
      clearTimeout(releaseTimer);
      lock.release();
      await lock.holder;
    }
    expect((await heartbeat.getRun(waiting.run.id))?.status).toBe("cancelled");
  }, 60_000);

  it.each(stopCallers)("answers the $caller a retryable conflict when the task row stays locked through every attempt", async ({ reason, options }) => {
    const waiting = await queueBehindBusyTask();
    const lock = await holdTaskRow(waiting.issue.id);
    try {
      const startedAt = Date.now();
      const error = await heartbeat.cancelRun(waiting.run.id, reason, options).then(
        () => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(409);
      expect((error as HttpError).details).toMatchObject({ code: "run_stop_busy", runId: waiting.run.id });
      // Bounded: three 1s waits plus short backoff, never an open-ended queue.
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      lock.release();
      await lock.holder;
    }
    // Nothing was committed, so the same Stop succeeds once the writer is done.
    expect((await heartbeat.getRun(waiting.run.id))?.status).toBe("queued");
    const stopped = await heartbeat.cancelRun(waiting.run.id, reason, options);
    expect(stopped?.status).toBe("cancelled");
  }, 60_000);
});
