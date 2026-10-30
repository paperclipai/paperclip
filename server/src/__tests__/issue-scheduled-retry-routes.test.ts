import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createScheduledRetryCancellationRecovery } from "../services/heartbeat/scheduled-retry-cancellation.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyScheduledRetryCancellation } from "../services/scheduled-retry-cancellation-notifications.js";
import { requestedRunCancellation } from "../services/run-cancellation.js";
import { idleWorkSnapshot, startTaskDrain, stopTaskDrain } from "../services/task-admission.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  applyPendingMigrations,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { runningProcesses } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RETRY_CANCELLATION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres scheduled retry route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue scheduled retry routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      await applyPendingMigrations(externalTestDatabaseUrl);
      db = createDb(externalTestDatabaseUrl);
    }
    else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-scheduled-retry-routes-");
      db = createDb(tempDb.connectionString);
    }
  }, 20_000);

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string, source: "session" | "local_implicit" = "session"): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source,
    };
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    };
  }

  async function seedIssueWithRetry(input: {
    agentStatus?: "active" | "paused";
    retryStatus?: "scheduled_retry" | "queued" | "running";
    issueStatus?: "in_progress" | "todo" | "done" | "cancelled";
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const retryRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-05-06T18:00:00.000Z");
    const scheduledRetryAt = new Date("2026-05-06T19:00:00.000Z");

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
      status: input.agentStatus ?? "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "transient upstream error",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "bounded_transient_heartbeat_retry",
      payload: {
        issueId,
        retryOfRunId: sourceRunId,
        scheduledRetryAt: scheduledRetryAt.toISOString(),
      },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: input.retryStatus ?? "scheduled_retry",
      wakeupRequestId,
      retryOfRunId: sourceRunId,
      scheduledRetryAt,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        issueId,
        wakeReason: "bounded_transient_heartbeat_retry",
        retryOfRunId: sourceRunId,
        scheduledRetryAt: scheduledRetryAt.toISOString(),
        scheduledRetryAttempt: 2,
        retryReason: "transient_failure",
      },
      updatedAt: now,
      createdAt: now,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: retryRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retryable issue",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: retryRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, sourceRunId, retryRunId, scheduledRetryAt };
  }

  describe("scheduled retry cancellation worker", () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    async function runRow(id: string) {
      return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]);
    }
    function intent(reason = "Interrupted operator stop") {
      return { cancellation: requestedRunCancellation({}, reason), startupCancellation: { requestedAt: new Date().toISOString() } };
    }
    async function writeIntent(f: { companyId: string; retryRunId: string }, owner = db) {
      await owner.transaction(async tx => {
        await notifyScheduledRetryCancellation(tx, { companyId: f.companyId, runId: f.retryRunId });
        await tx.update(heartbeatRuns).set({ resultJson: intent() }).where(eq(heartbeatRuns.id, f.retryRunId));
      });
    }
    async function waitCancelled(id: string) {
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(100);
        expect((await runRow(id))?.status).toBe("cancelled");
      }, { timeout: 5000 });
    }
    function clock() { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true }); }

    it("stays quiet with retries lacking cancellation and retained completed history", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      const historical = await seedIssueWithRetry({ agentStatus: "paused" });
      await db.update(heartbeatRuns).set({ status: "cancelled", resultJson: intent() }).where(eq(heartbeatRuns.id, historical.retryRunId));
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBeNull();
        const reads = vi.spyOn(db, "select");
        await vi.advanceTimersByTimeAsync(180_000);
        expect(reads).not.toHaveBeenCalled();
        reads.mockRestore();
        expect((await runRow(f.retryRunId)).status).toBe("scheduled_retry");
      } finally { await coordinator.stop(); }
    });

    it("recovers a real cancellation's failed final write from its committed signal and retry", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      const unrelated = await seedIssueWithRetry({ agentStatus: "paused" });
      const service = heartbeatService(db, { runtimeEnv: {} });
      const errors: unknown[] = [];
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await service.registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        expect(coordinator.nextWakeAt()).toBeNull();
        await db.execute(sql`ALTER TABLE heartbeat_runs ADD CONSTRAINT reject_worker_cancellation CHECK (status <> 'cancelled') NOT VALID`);
        try {
          await expect(service.cancelRun(f.retryRunId, "Human cancelled retry", { expectedStatus: "scheduled_retry" })).rejects.toThrow();
          await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(errors.length).toBeGreaterThan(0); });
          expect((await runRow(f.retryRunId)).resultJson?.cancellation).toMatchObject({ reason: "Human cancelled retry" });
        } finally { await db.execute(sql`ALTER TABLE heartbeat_runs DROP CONSTRAINT reject_worker_cancellation`); }
        await vi.advanceTimersByTimeAsync(31_000);
        await waitCancelled(f.retryRunId);
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect((await runRow(f.retryRunId)).error).toBe("Human cancelled retry");
        expect((await runRow(unrelated.retryRunId)).status).toBe("scheduled_retry");
        expect(await db.select().from(issues).where(eq(issues.id, f.issueId)))
          .toEqual([expect.objectContaining({ executionRunId: null })]);
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, f.retryRunId)))
          .toEqual([expect.objectContaining({ status: "cancelled" })]);
        const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId));
        await vi.advanceTimersByTimeAsync(120_000);
        expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId))).toEqual(events);
        expect(coordinator.nextWakeAt()).toBeNull();
      } finally { await coordinator.stop(); }
    });

    it("recovers when the caller loses the committed cancellation-fence response", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      const service = heartbeatService(db, { runtimeEnv: {} });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      await service.registerScheduledRetryCancellationWork(coordinator, () => true).ready;
      let injected = false;
      const transaction = db.transaction.bind(db);
      const transactions = vi.spyOn(db, "transaction").mockImplementation((async (callback, options) => {
        const result = await transaction(callback, options);
        if (!injected && result && typeof result === "object" && "id" in result && result.id === f.retryRunId) {
          injected = true;
          throw new Error("Lost cancellation-fence response");
        }
        return result;
      }) as typeof db.transaction);
      try {
        await expect(service.cancelRun(f.retryRunId, "Stop before settlement", { expectedStatus: "scheduled_retry" }))
          .rejects.toThrow("Lost cancellation-fence response");
        expect(injected).toBe(true);
        transactions.mockRestore();
        await waitCancelled(f.retryRunId);
        expect((await runRow(f.retryRunId)).error).toBe("Stop before settlement");
      } finally { transactions.mockRestore(); await coordinator.stop(); }
    });

    it("reactivates when dispatch parks a queued retry with an existing cancellation", async () => {
      const f = await seedIssueWithRetry({ retryStatus: "queued" });
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", resultJson: {
        conversationContinuation: "continue_conversation_v1", workspaceRestoreFailure: "restore_failed",
      } }).where(eq(heartbeatRuns.id, f.sourceRunId));
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", resultJson: {
        ...intent(), conversationContinuation: "continue_conversation_v1",
      } }).where(eq(heartbeatRuns.id, f.retryRunId));
      await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
        heartbeatRunId: f.sourceRunId, status: "pending_cleanup", cleanupStatus: "failed",
      });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        expect(coordinator.nextWakeAt()).toBeNull();
        expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId: f.companyId,
          runId: f.retryRunId, expectedStatus: "queued", now: new Date(),
        })).toMatchObject({ outcome: "deferred" });
        await waitCancelled(f.retryRunId);
        expect((await runRow(f.retryRunId)).error).toBe("Interrupted operator stop");
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBeNull();
      } finally { await coordinator.stop(); }
    });

    it("preserves existing cancellation metadata through recovery", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      const budgetEnforcement = { companyId: f.companyId, scopeType: "agent", scopeId: f.agentId };
      const saved = intent();
      await db.update(heartbeatRuns).set({ resultJson: { ...saved,
        startupCancellation: { ...saved.startupCancellation, budgetEnforcement },
        cancelledByUserId: "original-operator", recoveryEvidence: "retain-me",
      } }).where(eq(heartbeatRuns.id, f.retryRunId));
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        await waitCancelled(f.retryRunId);
        expect((await runRow(f.retryRunId)).resultJson).toMatchObject({
          cancellation: saved.cancellation, startupCancellation: { budgetEnforcement },
          cancelledByUserId: "original-operator", recoveryEvidence: "retain-me",
        });
      } finally { await coordinator.stop(); }
    });

    it("waits for the outer transaction and ignores a rolled-back intent", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        await expect(db.transaction(async tx => {
          await writeIntent(f, tx as unknown as typeof db);
          await vi.advanceTimersByTimeAsync(1000);
          expect((await runRow(f.retryRunId)).resultJson).toBeNull();
          throw new Error("outer rollback");
        })).rejects.toThrow("outer rollback");
        await vi.advanceTimersByTimeAsync(1000);
        expect((await runRow(f.retryRunId)).status).toBe("scheduled_retry");
        await db.transaction(async tx => {
          await writeIntent(f, tx as unknown as typeof db);
          await vi.advanceTimersByTimeAsync(1000);
          expect((await runRow(f.retryRunId)).resultJson).toBeNull();
        });
        await waitCancelled(f.retryRunId);
      } finally { await coordinator.stop(); }
    });

    it.each(["restart", "drain", "standby"] as const)("retains a pending cancellation through %s", async mode => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      if (mode === "restart") await writeIntent(f);
      let canRun = mode === "restart";
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
        canReconcile: () => mode !== "standby", onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => canRun).ready;
        if (mode !== "restart") {
          await writeIntent(f);
          await vi.advanceTimersByTimeAsync(30_000);
          if (mode !== "standby") await expect.poll(() => idleWorkSnapshot().active).toBe(0);
          const reads = vi.spyOn(db, "select");
          await vi.advanceTimersByTimeAsync(60_000);
          expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
          expect((await runRow(f.retryRunId)).status).toBe("scheduled_retry");
          canRun = true;
          await vi.advanceTimersByTimeAsync(30_000);
        }
        await waitCancelled(f.retryRunId);
      } finally { await coordinator.stop(); }
    });

    it.each(["manual", "expiry"] as const)("resumes a real task drain after %s release without passive SQL", async mode => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        startTaskDrain(mode === "expiry" ? { ttlMs: 60_000 } : {});
        await writeIntent(f);
        await vi.advanceTimersByTimeAsync(1000);
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        const reads = vi.spyOn(db, "select");
        await vi.advanceTimersByTimeAsync(30_000);
        expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
        expect((await runRow(f.retryRunId)).status).toBe("scheduled_retry");
        if (mode === "manual") stopTaskDrain();
        await vi.advanceTimersByTimeAsync(31_000);
        await waitCancelled(f.retryRunId);
      } finally { stopTaskDrain(); await coordinator.stop(); }
    });

    it("observes a real worktree activation without polling disabled settings", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      await writeIntent(f);
      const runtimeEnv = { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "sleep39-activation" };
      const settings = instanceSettingsService(db, { runtimeEnv });
      await settings.updateExperimental({ enableWorktreeRunExecution: false });
      const service = heartbeatService(db, { runtimeEnv });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await service.registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        expect(coordinator.nextWakeAt()).toBeNull();
        const reads = vi.spyOn(db, "select");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
        await service.resolveSchedulingSuppression();
        await settings.updateExperimental({ enableWorktreeRunExecution: true });
        await waitCancelled(f.retryRunId);
      } finally { await coordinator.stop(); await settings.updateExperimental({ enableWorktreeRunExecution: false }); }
    });

    it("retains a second committed intent while the first cancellation is running", async () => {
      const first = await seedIssueWithRetry({ agentStatus: "paused" });
      const second = await seedIssueWithRetry({ agentStatus: "paused" });
      await writeIntent(first);
      const service = heartbeatService(db, { runtimeEnv: {} });
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const cancel = vi.fn(async (...args: Parameters<typeof service.cancelRun>) => {
        if (args[0] === first.retryRunId) { enter(); await held; }
        return service.cancelRun(...args);
      });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      const worker = createScheduledRetryCancellationRecovery(db, cancel).register(coordinator, () => true, async () => true);
      try {
        await entered;
        await writeIntent(second);
        release(); await worker.ready;
        await waitCancelled(first.retryRunId); await waitCancelled(second.retryRunId);
        expect(cancel.mock.calls.filter(args => args[0] === first.retryRunId)).toHaveLength(1);
        expect(cancel.mock.calls.filter(args => args[0] === second.retryRunId)).toHaveLength(1);
      } finally { release(); await coordinator.stop(); }
    });

    it("does not repeat settlement when a foreground cancellation wins", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      await writeIntent(f);
      const service = heartbeatService(db, { runtimeEnv: {} });
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      const worker = createScheduledRetryCancellationRecovery(db, async (...args) => {
        enter(); await held; return service.cancelRun(...args);
      }).register(coordinator, () => true, async () => true);
      try {
        await entered;
        await service.cancelRun(f.retryRunId, "Foreground stop", { expectedStatus: "scheduled_retry" });
        const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId));
        release(); await worker.ready;
        await vi.advanceTimersByTimeAsync(1000);
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId))).toEqual(events);
        expect((await runRow(f.retryRunId)).error).toBe("Foreground stop");
      } finally { release(); await coordinator.stop(); }
    });

    it("joins an in-flight authority read at shutdown without starting cancellation", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      await writeIntent(f);
      const service = heartbeatService(db, { runtimeEnv: {} });
      let enter!: () => void, release!: () => void, checks = 0;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const cancel = vi.fn(service.cancelRun);
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      const worker = createScheduledRetryCancellationRecovery(db, cancel).register(coordinator, () => true, async () => {
        if (++checks === 2) { enter(); await held; }
        return true;
      });
      let stopping: Promise<void> | undefined;
      try {
        await entered;
        let stopped = false;
        stopping = coordinator.stop().then(() => { stopped = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(stopped).toBe(false);
        release(); await worker.ready; await stopping;
        expect(cancel).not.toHaveBeenCalled();
        expect((await runRow(f.retryRunId)).status).toBe("scheduled_retry");
      } finally { release(); await (stopping ?? coordinator.stop()); }
      const restarted = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(restarted, () => true).ready;
        expect((await runRow(f.retryRunId)).status).toBe("cancelled");
      } finally { await restarted.stop(); }
    });

    it("manual recovery starts cancellation without loading the full backlog", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      const work = await db.insert(heartbeatRuns).values(Array.from({ length: 120 }, () => ({
        companyId: f.companyId, agentId: f.agentId, status: "scheduled_retry", resultJson: intent(),
      }))).returning({ id: heartbeatRuns.id });
      const service = heartbeatService(db, { runtimeEnv: {} });
      const reads = vi.spyOn(db, "select");
      let readsBeforeFirstCancellation: number | undefined;
      try {
        await createScheduledRetryCancellationRecovery(db, async (...args) => {
          readsBeforeFirstCancellation ??= reads.mock.calls.filter(([fields]) => fields &&
            "result" in fields && "errorCode" in fields).length;
          return service.cancelRun(...args);
        }).sweep();
        expect(readsBeforeFirstCancellation).toBe(2);
        const states = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
          .where(inArray(heartbeatRuns.id, work.map(row => row.id)));
        expect(states.filter(row => row.status === "cancelled")).toHaveLength(20);
        expect(states.filter(row => row.status === "scheduled_retry")).toHaveLength(100);
      } finally { reads.mockRestore(); }
    });

    it("pages past malformed intents and drains fair batches without revisiting completed history", async () => {
      const a = await seedIssueWithRetry({ agentStatus: "paused" });
      const b = await seedIssueWithRetry({ agentStatus: "paused" });
      await db.insert(heartbeatRuns).values(Array.from({ length: 103 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, companyId: a.companyId, agentId: a.agentId,
        status: "scheduled_retry", resultJson: { startupCancellation: {}, cancellation: { expected: true } },
      })));
      const work = await db.insert(heartbeatRuns).values([...[a, b].flatMap((f, index) =>
        Array.from({ length: index === 0 ? 25 : 3 }, () => ({ companyId: f.companyId, agentId: f.agentId,
          status: "scheduled_retry", resultJson: intent() }))),
      ]).returning({ id: heartbeatRuns.id });
      const states = () => db.select({ companyId: heartbeatRuns.companyId, status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, work.map(row => row.id)));
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        expect((await states()).filter(row => row.status === "cancelled")).toHaveLength(0);
        const earlierId = "00000000-0000-4000-8000-000000000000";
        await writeIntent({ companyId: a.companyId, retryRunId: earlierId });
        work.push({ id: earlierId });
        await vi.advanceTimersByTimeAsync(1000);
        await expect.poll(async () => (await states()).filter(row => row.status === "cancelled").length).toBe(20);
        const initial = (await states()).filter(row => row.status === "cancelled");
        expect(new Set(initial.map(row => row.companyId)).size).toBe(2);
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(1000);
          expect((await states()).filter(row => row.status === "cancelled")).toHaveLength(29);
        }, { timeout: 10_000 });
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        await vi.advanceTimersByTimeAsync(1000);
        await expect.poll(() => coordinator.nextWakeAt()).toBeNull();
        const reads = vi.spyOn(db, "select");
        await vi.advanceTimersByTimeAsync(180_000);
        expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
      } finally { await coordinator.stop(); }
    });
  });

  it("finishes a parked retry cancellation after its owner loses the final database write", async () => {
    const f = await seedIssueWithRetry({ agentStatus: "paused" });
    const unrelated = await seedIssueWithRetry({ agentStatus: "paused" });
    await db.execute(sql`ALTER TABLE heartbeat_runs ADD CONSTRAINT reject_retry_cancellation CHECK (status <> 'cancelled') NOT VALID`);
    try {
      await expect(heartbeatService(db).cancelRun(f.retryRunId, "Superseded by a human comment", {
        expectedStatus: "scheduled_retry",
      })).rejects.toThrow();
      // A failed sweep leaves the same durable intent available for a later one.
      await heartbeatService(db).reapOrphanedRuns();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId)))
        .toEqual([expect.objectContaining({ status: "scheduled_retry" })]);
    } finally {
      await db.execute(sql`ALTER TABLE heartbeat_runs DROP CONSTRAINT reject_retry_cancellation`);
    }
    const [interrupted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
    expect(interrupted).toMatchObject({ status: "scheduled_retry", resultJson: {
      startupCancellation: expect.any(Object), cancellation: { reason: "Superseded by a human comment" },
    } });

    // A fresh service has no process-local cancellation owner or settlement promise.
    await heartbeatService(db).reapOrphanedRuns();
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
    expect(cancelled).toMatchObject({ status: "cancelled", error: "Superseded by a human comment" });
    expect(cancelled!.resultJson!.cancellation).toEqual(interrupted!.resultJson!.cancellation);
    expect(await db.select().from(issues).where(eq(issues.id, f.issueId)))
      .toEqual([expect.objectContaining({ executionRunId: null, assigneeAgentId: f.agentId })]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, f.retryRunId)))
      .toEqual([expect.objectContaining({ status: "cancelled" })]);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId));
    await heartbeatService(db).reapOrphanedRuns();
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId))).toEqual(events);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.retryRunId)))
      .toEqual([expect.objectContaining({ status: "scheduled_retry", resultJson: null })]);
  });

  it.each(["post", "patch"] as const)("keeps a retry's live process and saved work owner when a %s comment arrives", async method => {
    const f = await seedIssueWithRetry({ retryStatus: "running" });
    await db.insert(companyMemberships).values({
      companyId: f.companyId, principalType: "user", principalId: "board-user",
      membershipRole: "admin", status: "active",
    });
    const child = spawn(process.execPath, ["-e", `
      process.on('message', message => {
        if (message === 'continue-work') process.send('work-continues');
      });
      process.send('ready');
    `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const exited = once(child, "exit");
    const heartbeat = heartbeatService(db);
    try {
      await once(child, "message", { signal: AbortSignal.timeout(5_000) });
      runningProcesses.set(f.retryRunId, { child, graceSec: 1, processGroupId: null });
      await db.update(heartbeatRuns).set({
        startedAt: new Date(), runtimeModeResolvedAt: new Date(), processPid: child.pid,
      }).where(eq(heartbeatRuns.id, f.retryRunId));
      const app = createApp(boardActor(f.companyId));

      const res = method === "post"
        ? await request(app).post(`/api/issues/${f.issueId}/comments`).send({ body: "Verified source recovery; continue the original work." })
        : await request(app).patch(`/api/issues/${f.issueId}`).send({ comment: "Verified source recovery; continue the original work." });

      expect(res.status, JSON.stringify(res.body)).toBe(method === "post" ? 201 : 200);
      await heartbeat.drainActiveRunExecutions();
      const progress = once(child, "message", { signal: AbortSignal.timeout(5_000) });
      child.send("continue-work");
      expect((await progress)[0]).toBe("work-continues");
      const [savedIssue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const [savedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
      expect(savedIssue).toMatchObject({ status: "in_progress", executionRunId: f.retryRunId });
      expect(savedRun).toMatchObject({ status: "running", processPid: child.pid });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)))
        .toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "running"),
      ))).toHaveLength(1);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      runningProcesses.delete(f.retryRunId);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });

  it("surfaces the current scheduled retry in the issue read model", async () => {
    const { companyId, issueId, agentId, sourceRunId, retryRunId, scheduledRetryAt } = await seedIssueWithRetry();

    const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.scheduledRetry).toMatchObject({
      runId: retryRunId,
      status: "scheduled_retry",
      agentId,
      agentName: "CodexCoder",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
    });
    expect(res.body.scheduledRetry.scheduledRetryAt).toBe(scheduledRetryAt.toISOString());
  });

  it.each(["queued", "running"] as const)(
    "surfaces a %s retry with its real live status",
    async (retryStatus) => {
      const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ retryStatus });

      const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${issueId}`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.scheduledRetry).toMatchObject({
        runId: retryRunId,
        status: retryStatus,
        scheduledRetryReason: "transient_failure",
      });
    },
  );

  it("includes a blocker's live retry in relation summaries", async () => {
    const { companyId, issueId: blockerId, retryRunId } = await seedIssueWithRetry({ retryStatus: "running" });
    const blockedId = randomUUID();
    await db.insert(issues).values({
      id: blockedId,
      companyId,
      title: "Waiting for recovery",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${blockedId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockedBy).toHaveLength(1);
    expect(res.body.blockedBy[0]).toMatchObject({
      id: blockerId,
      scheduledRetry: {
        runId: retryRunId,
        status: "running",
        scheduledRetryReason: "transient_failure",
      },
    });
  });

  it("promotes the existing scheduled retry and treats duplicate clicks as idempotent", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();
    const app = createApp(boardActor(companyId));

    const first = await request(app).post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      outcome: "promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });

    const second = await request(app).post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});

    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({
      outcome: "already_promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });

    const retryRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.retryOfRunId, first.body.scheduledRetry.retryOfRunId), eq(heartbeatRuns.companyId, companyId)));
    expect(retryRuns).toHaveLength(1);
    expect(retryRuns[0]).toMatchObject({ id: retryRunId, status: "queued" });
  });

  it("reports cleanup waits with the saved schedule and promotes the same retry after release", async () => {
    const f = await seedIssueWithRetry();
    await db.update(heartbeatRuns)
      .set({ resultJson: { conversationContinuation: "continue_conversation_v1" } })
      .where(inArray(heartbeatRuns.id, [f.sourceRunId, f.retryRunId]));
    const [lease] = await db.insert(environmentLeases).values({
      companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.sourceRunId,
      status: "pending_cleanup", cleanupStatus: "failed",
    }).returning();
    const app = createApp(boardActor(f.companyId));
    for (let click = 0; click < 2; click++) {
      const before = Date.now();
      const res = await request(app).post(`/api/issues/${f.issueId}/scheduled-retry/retry-now`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ outcome: "waiting", scheduledRetry: {
        runId: f.retryRunId, status: "scheduled_retry", scheduledRetryAttempt: 2,
      } });
      expect(res.body.message).toContain("Waiting for execution cleanup");
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
      expect(res.body.scheduledRetry.scheduledRetryAt).toBe(saved!.scheduledRetryAt!.toISOString());
      expect(saved!.scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    }
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.sourceRunId))).toHaveLength(1);
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() })
      .where(eq(environmentLeases.id, lease!.id));
    const resumed = await request(app).post(`/api/issues/${f.issueId}/scheduled-retry/retry-now`).send({});
    expect(resumed.body).toMatchObject({ outcome: "promoted", scheduledRetry: {
      runId: f.retryRunId, status: "queued", scheduledRetryAttempt: 2,
    } });
  });

  it("returns a clear no-op response when there is no scheduled retry", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "NONE",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No retry",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: "NONE-1",
    });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "no_scheduled_retry",
      scheduledRetry: null,
    });
  });

  it("reports already-promoted retries without creating another run", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ retryStatus: "queued" });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "already_promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });
  });

  it("uses normal promotion gates and records gate-suppressed retries", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ agentStatus: "paused" });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      scheduledRetry: {
        runId: retryRunId,
        status: "cancelled",
        errorCode: "agent_not_invokable",
      },
    });

    const [run] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    expect(run).toEqual({ status: "cancelled", errorCode: "agent_not_invokable" });

    const [activity] = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity).toEqual({
      action: "issue.scheduled_retry_retry_now",
      entityId: issueId,
      runId: retryRunId,
    });
  });

  it("requires board access for retry-now", async () => {
    const { companyId, agentId, issueId } = await seedIssueWithRetry();

    const res = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status).toBe(403);
  });

  it("enforces company scoping for retry-now with a uniform 404", async () => {
    const { issueId } = await seedIssueWithRetry();

    const res = await request(createApp(boardActor(randomUUID())))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status).toBe(404);
  });

});
