import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../task-admission.js";
import { createHeartbeatLifecycle } from "../heartbeat/run-lifecycle.js";
import { createHeartbeatRunState } from "../heartbeat/run-state.js";
import { createHeartbeatRunPreparation } from "../heartbeat/run-preparation.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, createDb, applyPendingMigrations, environmentLeases, environments, externalAgentHolds, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { markExecutionReconciliation, settleUnrecoverableExecutions, validateExecutionReconciliation } from "../execution-recovery-resolution.js";
import { prepareSandboxStopAndRetain, settleStopOnlyCleanup } from "../sandbox-stop-and-retain.js";
import { preserveCancelledNativeWorkspaces, preserveNativeFailedWorkspace, preserveOrphanedNativeWorkspace, registerCancelledWorkspacePreservationWork } from "./native-failed-workspace-recovery.js";
import { claimNativeRestartRecoveries, currentNativeControllerIdentity, type NativeRestartRecoveryClaim } from "./native-restart-recovery.js";
import { NativeWorkspaceFinalizationBusyError } from "./native-workspace-finalization-ownership.js";
import { preserveWorkspaceRestoreRecoveryMetadataSql } from "../legacy-workspace-restore-recovery.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("failed native workspace retention", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    if (externalUrl) {
      await applyPendingMigrations(externalUrl);
      db = createDb(externalUrl);
    }
    else {
      temporary = await startEmbeddedPostgresTestDatabase("native-failed-workspace-");
      db = createDb(temporary.connectionString);
    }
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Native workspace", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Preserve unfinished files", status: "in_progress", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", nativePhase: "terminal_failure", errorCode: "adapter_failed",
      error: "runner_remote_process_identity_unavailable", resultJson: { originalDiagnostic: true }, contextSnapshot: { issueId },
    }).returning();
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure" });
    const [environment] = await db.insert(environments).values({ name: `Native recovery ${runId}`, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
      environmentId: environment.id, provider: "daytona", providerLeaseId: randomUUID(), status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" },
    }).returning();
    const [bound] = await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
      schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
      baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: runId,
      leaseId: lease.id, providerLeaseId: lease.providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy",
    } } }).where(eq(heartbeatRuns.id, runId)).returning();
    return { companyId, agentId, issueId, runId, run: bound, lease, environment };
  }
  const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  const readLease = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
  const actions = async (issueId: string) => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));

  async function seedRestartFailure() {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "running", nativePhase: "observed", error: null, errorCode: null,
      runnerProfileJson: { ...f.run.runnerProfileJson, sessionCheckpoint: {
        terminal: { runTerminalState: "failed", turnTerminalState: "failed" },
        providerSessionId: "failed-provider-session",
      } },
    }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "observed", attempt: 1 }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    return f;
  }

  it.each(["bound", "foreign", "owned"])("pins blocked restart files only for an unowned, bound source: %s", async kind => {
    const f = await seedRestartFailure();
    const controller = await currentNativeControllerIdentity();
    if (kind === "owned") await db.update(nativeRunFinalizations).set({ leaseOwner: "active-controller",
      leaseExpiresAt: new Date(Date.now() + 60_000), controllerBootId: controller.bootId,
      controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt,
    }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (kind === "foreign") await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, remoteCwd: "/other" } })
      .where(eq(environmentLeases.id, f.lease.id));

    expect(await claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [f.runId] })).toEqual([
      { kind: kind === "owned" ? "awaiting_evidence" : "blocked", runId: f.runId,
        reason: kind === "owned" ? "controller_still_alive" : "provider_checkpoint_permanently_failed" },
    ]);
    const current = await readRun(f.runId);
    expect(current.status).toBe(kind === "owned" ? "running" : "failed");
    expect(current.resultJson).toMatchObject({ originalDiagnostic: true });
    if (kind === "bound") {
      expect(current.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { leaseIds: [f.lease.id] } });
      expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure",
        metadata: { sandboxStopAndRetain: { runId: f.runId, leaseId: f.lease.id } } });
      expect((await actions(f.issueId)).some(action => action.evidence.workspaceRestoreRecovery)).toBe(true);
    } else {
      expect(current.resultJson?.workspaceRestoreRecovery).toBeUndefined();
      expect(await readLease(f.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
    }
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].attempt).toBe(1);
  });

  it("rolls back restart terminalization when workspace retention cannot commit", async () => {
    const f = await seedRestartFailure();
    const name = sql.identifier(`reject_retention_${f.runId.replaceAll("-", "")}`);
    await db.execute(sql`create function ${name}() returns trigger language plpgsql as $$
      begin
        if new.result_json ? 'workspaceRestoreRecovery' then
          raise exception 'retention write failed';
        end if;
        return new;
      end;
    $$`);
    await db.execute(sql`create trigger ${name} before update on heartbeat_runs for each row execute function ${name}()`);
    try {
      await expect(claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [f.runId] })).rejects.toThrow();
      expect(await readRun(f.runId)).toMatchObject({ status: "running", nativePhase: "observed", resultJson: { originalDiagnostic: true } });
      expect(await readLease(f.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
      expect(await actions(f.issueId)).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBe(f.runId);
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
        .toMatchObject({ phase: "observed", attempt: 1 });
    } finally {
      await db.execute(sql`drop trigger ${name} on heartbeat_runs`);
      await db.execute(sql`drop function ${name}()`);
    }
  });

  describe("cancelled workspace preservation worker", () => {
    const fixtureCompanies = new Set<string>();
    afterEach(async () => {
      vi.useRealTimers(); vi.restoreAllMocks();
      if (fixtureCompanies.size) await db.update(heartbeatRuns).set({ status: "failed" })
        .where(inArray(heartbeatRuns.companyId, [...fixtureCompanies]));
      fixtureCompanies.clear();
    });
    async function prepared() {
      const fixture = await seed(); fixtureCompanies.add(fixture.companyId); return fixture;
    }
    const acknowledgement = (f: Awaited<ReturnType<typeof seed>>) => ({
      cancelledByActorType: "user", cancelledByUserId: "operator", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId, issueId: f.issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      },
    });
    const clock = () => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const coordinator = (canRun = () => true, canReconcile = () => true) =>
      createDeliveryWorkCoordinator({ owner: db, canRun, canReconcile, onError: () => {} });
    const lifecycle = (owner = db) => createHeartbeatLifecycle(owner, {
      ...createHeartbeatRunState(owner), ...createHeartbeatRunPreparation(owner),
      issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
      recovery: { escalateStrandedAssignedIssue: vi.fn() },
      companySkills: { completeTestRunForIssue: vi.fn() },
      budgets: { getInvocationBlock: vi.fn(async () => null) },
      treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
      enqueueWakeup: vi.fn(), getCurrentUserRedactionOptions: vi.fn(async () => ({})),
      getAgentInvokability: vi.fn(async () => ({ invokable: true as const })),
      emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
    });
    async function cancel(f: Awaited<ReturnType<typeof seed>>, owner = db) {
      await lifecycle(owner).setRunStatus(f.runId, "cancelled", { resultJson: acknowledgement(f), finishedAt: new Date() });
    }
    async function pinned(f: Awaited<ReturnType<typeof seed>>) {
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(100);
        expect((await readRun(f.runId)).resultJson).toMatchObject({
          workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.lease.id] },
        });
      }, { timeout: 5000 });
      expect((await readLease(f.lease.id)).leasePolicy).toBe("retain_on_failure");
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
      expect((await readRun(f.runId)).status).toBe("cancelled");
      expect(await actions(f.issueId)).toHaveLength(1);
    }
    it("stays quiet for active runs, completed preservation, and admitted workspace-less sessions", async () => {
      const active = await prepared(), settled = await prepared(), external = await prepared();
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, active.runId));
      await cancel(settled); await preserveNativeFailedWorkspace(db, await readRun(settled.runId), { allowPreterminal: true });
      await bindExternalInput(external, "muse"); await cancel(external);
      clock(); const worker = coordinator();
      try {
        await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
        const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(worker.nextWakeAt()).toBeNull();
        expect((await readLease(active.lease.id)).status).toBe("active");
        expect((await readLease(external.lease.id)).status).toBe("active");
      } finally { await worker.stop(); }
    });
    it.each(["missing issue", "foreign company"] as const)("does not schedule an unbound cancellation receipt: %s", async mismatch => {
      const f = await prepared(); const result = acknowledgement(f);
      if (mismatch === "missing issue") await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      await db.update(heartbeatRuns).set({ status: "cancelled",
        ...(mismatch === "missing issue" ? { nativeIssueId: null } : {}),
        resultJson: { ...result, nativeCancellation: { ...result.nativeCancellation,
          ...(mismatch === "missing issue" ? { issueId: null } : { companyId: randomUUID() }),
        } },
      }).where(eq(heartbeatRuns.id, f.runId));
      clock(); const worker = coordinator();
      try {
        await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
        const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(worker.nextWakeAt()).toBeNull();
        expect((await readLease(f.lease.id)).status).toBe("active");
      } finally { await worker.stop(); }
    });
    it("reactivates from the real run-status producer and becomes quiet after recording the hold", async () => {
      const f = await prepared(); clock(); const worker = coordinator();
      try {
        await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
        expect(worker.nextWakeAt()).toBeNull();
        await cancel(f); await pinned(f);
        await vi.advanceTimersByTimeAsync(1000); await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(worker.nextWakeAt()).toBeNull();
      } finally { await worker.stop(); }
    });
    it.each(["restart", "drain", "standby"] as const)("retains preservation across %s", async mode => {
      const f = await prepared(); if (mode === "restart") await cancel(f);
      let admitted = mode === "restart";
      clock(); const worker = coordinator(() => admitted, () => admitted || mode !== "standby");
      try {
        await registerCancelledWorkspacePreservationWork(db, worker, () => admitted, async () => true).ready;
        if (mode !== "restart") {
          await cancel(f); await vi.advanceTimersByTimeAsync(1000);
          const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(60_000);
          expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
          expect((await readLease(f.lease.id)).status).toBe("active");
          admitted = true; await vi.advanceTimersByTimeAsync(30_000);
        }
        await pinned(f);
      } finally { await worker.stop(); }
    });
    it("waits for the outer cancellation commit and discards a rolled-back transition", async () => {
      const f = await prepared(); clock(); const worker = coordinator();
      try {
        await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
        await expect(db.transaction(async tx => {
          await cancel(f, tx as unknown as typeof db); await vi.advanceTimersByTimeAsync(1000);
          expect((await readLease(f.lease.id)).status).toBe("active");
          throw new Error("rollback cancellation");
        })).rejects.toThrow("rollback cancellation");
        await vi.advanceTimersByTimeAsync(1000);
        expect((await readRun(f.runId)).status).toBe("failed");
        await db.transaction(async tx => {
          await cancel(f, tx as unknown as typeof db); await vi.advanceTimersByTimeAsync(1000);
          expect((await readLease(f.lease.id)).status).toBe("active");
        });
        await pinned(f);
      } finally { await worker.stop(); }
    });
    it("preserves owed work while another controller owns finalization", async () => {
      const f = await prepared(); await cancel(f);
      await db.update(nativeRunFinalizations).set({ leaseOwner: "other-controller" }).where(eq(nativeRunFinalizations.runId, f.runId));
      clock(); const worker = coordinator();
      try {
        await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
        expect((await readLease(f.lease.id)).status).toBe("active");
        const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(20_000);
        expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
        await db.update(nativeRunFinalizations).set({ leaseOwner: null }).where(eq(nativeRunFinalizations.runId, f.runId));
        await vi.advanceTimersByTimeAsync(10_000); await pinned(f);
      } finally { await worker.stop(); }
    });
    it("waits for exact stop-only proof before retaining an already-released source", async () => {
      const f = await prepared(); await cancel(f);
      const stopping = await prepareSandboxStopAndRetain(db, f.lease);
      if (!stopping) throw new Error("Expected stop-only source");
      clock(); const worker = coordinator();
      try {
        await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
        expect((await readRun(f.runId)).resultJson).not.toHaveProperty("workspaceRestoreRecovery");
        const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(20_000);
        expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
        await settleStopOnlyCleanup(db, stopping, { attemptId: String(stopping.metadata?.pendingCleanupAttemptId),
          receipt: { providerLeaseId: f.lease.providerLeaseId, state: "stopped" } });
        await vi.advanceTimersByTimeAsync(10_000); await pinned(f);
        expect((await readLease(f.lease.id)).status).toBe("released");
      } finally { await worker.stop(); }
    });
    it("retries failed owner transactions without blocking another cancelled source", async () => {
      const first = await prepared(), second = await prepared(); await cancel(first); await cancel(second);
      clock(); const worker = coordinator();
      const transactions = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("preservation database unavailable"));
      try {
        await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
        transactions.mockRestore();
        const policies = [(await readLease(first.lease.id)).leasePolicy, (await readLease(second.lease.id)).leasePolicy];
        expect(policies.filter(policy => policy === "retain_on_failure")).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(30_000); await pinned(first); await pinned(second);
      } finally { transactions.mockRestore(); await worker.stop(); }
    });
    it.each(["acknowledgement", "phase", "status"] as const)("rejects changed %s at the locked preservation boundary", async changed => {
      const f = await prepared(); await cancel(f); clock(); const worker = coordinator();
      const transaction = db.transaction.bind(db); let changedOnce = false;
      const transactions = vi.spyOn(db, "transaction").mockImplementation((async (callback, options) => {
        if (!changedOnce) {
          changedOnce = true;
          if (changed === "phase") await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, f.runId));
          else if (changed === "status") await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
          else {
            const result = acknowledgement(f);
            result.nativeCancellation.dispatchState = "pending";
            await db.update(heartbeatRuns).set({ resultJson: result }).where(eq(heartbeatRuns.id, f.runId));
          }
        }
        return transaction(callback, options);
      }) as typeof db.transaction);
      try {
        await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
        transactions.mockRestore(); expect(changedOnce).toBe(true);
        expect((await readLease(f.lease.id)).status).toBe("active");
        expect((await readRun(f.runId)).resultJson).not.toHaveProperty("workspaceRestoreRecovery");
        if (changed === "phase") {
          expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase).toBe("observed");
          await db.update(nativeRunFinalizations).set({ phase: "terminal_failure" }).where(eq(nativeRunFinalizations.runId, f.runId));
          await vi.advanceTimersByTimeAsync(30_000);
        } else await cancel(f);
        await pinned(f);
      } finally { transactions.mockRestore(); await worker.stop(); }
    });
    it("reconstructs more than one page and pins all sources in bounded batches", async () => {
      const fixtures = [];
      for (let index = 0; index < 103; index++) {
        const f = await prepared(); await cancel(f); fixtures.push(f);
      }
      clock(); const worker = coordinator();
      const retained = () => db.select({ id: environmentLeases.id }).from(environmentLeases)
        .where(and(inArray(environmentLeases.companyId, [...fixtureCompanies]), eq(environmentLeases.leasePolicy, "retain_on_failure")));
      try {
        await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
        expect((await retained()).length).toBeLessThanOrEqual(5);
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(1000);
          expect(await retained()).toHaveLength(103);
        }, { timeout: 20_000 });
        for (const f of [fixtures[0], fixtures[102]]) await pinned(f);
        await vi.advanceTimersByTimeAsync(1000); await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(worker.nextWakeAt()).toBeNull();
      } finally { await worker.stop(); }
    }, 60_000);
    it("joins an admitted preservation transaction during shutdown", async () => {
      const f = await prepared(); await cancel(f); clock(); const worker = coordinator();
      const transaction = db.transaction.bind(db);
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const transactions = vi.spyOn(db, "transaction").mockImplementationOnce((async (callback, options) => {
        entered(); await held; return transaction(callback, options);
      }) as typeof db.transaction);
      let stopping: Promise<void> | undefined;
      try {
        const registration = registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true);
        await reached; let complete = false;
        stopping = worker.stop().then(() => { complete = true; });
        await new Promise<void>(resolve => setImmediate(resolve)); expect(complete).toBe(false);
        release(); await stopping; await registration.ready; await pinned(f);
        const restarted = coordinator();
        try {
          await registerCancelledWorkspacePreservationWork(db, restarted, () => true, async () => true).ready;
          expect(restarted.nextWakeAt()).toBeNull();
        } finally { await restarted.stop(); }
      } finally { release(); transactions.mockRestore(); await stopping; await worker.stop(); }
    });
  });

  async function supersededRetry() {
    const f = await seed();
    await db.update(heartbeatRuns).set({ nativePhase: "retryable_failure", startedAt: new Date(1), finishedAt: new Date(2) })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "retryable_failure", attempt: 1,
      recoveryState: "resuming_session", nextAttemptAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded", nativePhase: "committed",
      startedAt: new Date(3), finishedAt: new Date(4), contextSnapshot: { issueId: f.issueId,
        previousRunId: f.runId, taskRetryRequestId: randomUUID() } }).returning();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    return { ...f, successor };
  }

  it.each(["restart", "resume"])("retires a superseded failed retry and preserves its files during %s recovery", async path => {
    const f = await supersededRetry();
    const beforeTask = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0];
    const recover = () => path === "restart" ? claimNativeRestartRecoveries({ db, runIds: [f.runId], restartKind: "hard" })
      : claimNativeSessionResumptions({ db, runIds: [f.runId], runnerInstanceId: "recovery" });
    await recover();
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", attempt: 1, leaseOwner: null, nextAttemptAt: null,
        failureCode: "native_retry_superseded", failureDetail: { successorRunId: f.successor.id } });
    expect(await readRun(f.runId)).toMatchObject({ status: "failed", nativePhase: "terminal_failure",
      resultJson: { originalDiagnostic: true, workspaceRestoreRecovery: { leaseIds: [f.lease.id] } } });
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(beforeTask);
    const retainedActions = await actions(f.issueId);
    expect(retainedActions).toHaveLength(1);
    await recover();
    expect(await actions(f.issueId)).toEqual(retainedActions);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(2);
  });

  it.each(["live_owner", "process", "current_execution", "unfinished_successor", "unlinked_successor", "foreign_successor", "mismatched_source"])(
    "keeps an unverified superseded retry held: %s", async scenario => {
      const f = await supersededRetry();
      if (scenario === "live_owner") await db.update(nativeRunFinalizations).set({ leaseOwner: "live-controller",
        leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (scenario === "process") await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.runId));
      if (scenario === "current_execution") await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      if (scenario === "unfinished_successor") await db.update(heartbeatRuns).set({ status: "running", nativePhase: "observed", finishedAt: null })
        .where(eq(heartbeatRuns.id, f.successor.id));
      if (scenario === "unlinked_successor") await db.update(heartbeatRuns).set({ contextSnapshot: { previousRunId: randomUUID(), taskRetryRequestId: randomUUID() } })
        .where(eq(heartbeatRuns.id, f.successor.id));
      if (scenario === "foreign_successor") {
        const foreign = await seed();
        await db.update(heartbeatRuns).set({ contextSnapshot: {} }).where(eq(heartbeatRuns.id, f.successor.id));
        await db.insert(heartbeatRuns).values({ companyId: foreign.companyId, agentId: foreign.agentId,
          issueId: foreign.issueId, nativeIssueId: foreign.issueId, runtimeMode: "native", status: "succeeded", nativePhase: "committed",
          startedAt: new Date(3), finishedAt: new Date(4), contextSnapshot: { previousRunId: f.runId, taskRetryRequestId: randomUUID() } });
      }
      if (scenario === "mismatched_source") await db.update(environmentLeases).set({ providerLeaseId: randomUUID() })
        .where(eq(environmentLeases.id, f.lease.id));
      const beforeRun = await readRun(f.runId), beforeLease = await readLease(f.lease.id);
      await claimNativeSessionResumptions({ db, runIds: [f.runId], runnerInstanceId: "recovery" });
      expect(await readRun(f.runId)).toEqual(beforeRun);
      expect(await readLease(f.lease.id)).toEqual(beforeLease);
      expect(await actions(f.issueId)).toEqual([]);
    });

  it("rolls back retry retirement together with file preservation", async () => {
    const f = await supersededRetry();
    const beforeRun = await readRun(f.runId), beforeLease = await readLease(f.lease.id);
    const beforeCoordinator = (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0];
    await expect(db.transaction(async tx => {
      await claimNativeSessionResumptions({ db: tx as unknown as typeof db, runIds: [f.runId], runnerInstanceId: "recovery" });
      expect((await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0].phase).toBe("terminal_failure");
      throw new Error("rollback retry retirement");
    })).rejects.toThrow("rollback retry retirement");
    expect(await readRun(f.runId)).toEqual(beforeRun);
    expect(await readLease(f.lease.id)).toEqual(beforeLease);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(beforeCoordinator);
    expect(await actions(f.issueId)).toEqual([]);
  });

  it("keeps another orphan recoverable while a task lock delays preservation", async () => {
    const busy = await seed(), free = await seed();
    let unlock!: () => void, ready!: () => void;
    const released = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<void>(resolve => { ready = resolve; });
    const holding = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, busy.issueId)).for("update");
      ready(); await released;
    });
    await acquired;
    try {
      expect(await preserveOrphanedNativeWorkspace(db, busy.lease)).toBe(false);
      expect(await preserveOrphanedNativeWorkspace(db, free.lease)).toBe(true);
      expect((await readLease(busy.lease.id)).status).toBe("active");
      expect(await readLease(free.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
      expect(await actions(busy.issueId)).toHaveLength(0);
    } finally { unlock(); await holding; }
    expect(await preserveOrphanedNativeWorkspace(db, busy.lease)).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, busy.companyId))).toHaveLength(1);
  });

  it("rolls back orphan registration with its enclosing transaction", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => {
      expect(await preserveOrphanedNativeWorkspace(tx as unknown as typeof db, f.lease)).toBe(true);
      throw new Error("rollback preservation");
    })).rejects.toThrow("rollback preservation");
    expect(await readRun(f.runId)).toEqual(f.run);
    expect(await readLease(f.lease.id)).toEqual(f.lease);
    expect(await actions(f.issueId)).toHaveLength(0);
    expect(await preserveOrphanedNativeWorkspace(db, f.lease)).toBe(true);
    expect(await actions(f.issueId)).toHaveLength(1);
  });

  it.each(["settled", "historical", "live_owner", "retry", "nonterminal", "wrong_wake", "wrong_hold_run", "no_hold"])("retires only an exact superseded native resume obligation: %s", async scenario => {
    const f = await seed(), actionId = randomUUID();
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "active", ownerType: "agent", ownerAgentId: f.agentId,
      returnOwnerAgentId: f.agentId, cause: "native_session_interrupted", fingerprint: randomUUID(),
      evidence: { runId: f.runId }, nextAction: "Resume the exact persisted session.",
      wakePolicy: { kind: "resume_native_run", runId: f.runId }, attemptCount: 1, maxAttempts: 3 });
    await preserveNativeFailedWorkspace(db, f.run);
    const hold = (await actions(f.issueId)).find(action => action.id !== actionId)!;
    expect(hold.evidence.automaticRecovery).toMatchObject({ replay: "blocked", actionOutcome: "unknown" });
    if (scenario === "live_owner") await db.update(nativeRunFinalizations).set({ leaseOwner: "live-controller" }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (scenario === "retry") await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (scenario === "nonterminal") await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (scenario === "wrong_wake") await db.update(issueRecoveryActions).set({ wakePolicy: { kind: "resume_native_run", runId: randomUUID() } }).where(eq(issueRecoveryActions.id, actionId));
    if (scenario === "wrong_hold_run") await db.update(issueRecoveryActions).set({ evidence: { ...hold.evidence, runId: randomUUID() } }).where(eq(issueRecoveryActions.id, hold.id));
    if (scenario === "no_hold") await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
    const beforeRun = await readRun(f.runId), beforeLease = await readLease(f.lease.id);
    const beforeBlocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    const [beforeTask] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await settleUnrecoverableExecutions(db);
    if (scenario === "historical") await settleUnrecoverableExecutions(db);
    const retired = (await actions(f.issueId)).find(action => action.id === actionId)!;
    const shouldRetire = scenario === "settled" || scenario === "historical";
    expect(retired.status).toBe(shouldRetire ? "cancelled" : "active");
    if (shouldRetire) {
      expect(retired).toMatchObject({ outcome: "cancelled", wakePolicy: null,
        evidence: { runId: f.runId, supersedingRecoveryActionId: hold.id } });
      expect((await actions(f.issueId)).find(action => action.id === hold.id)).toEqual(hold);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
        eq(activityLog.action, "issue.execution_recovery_settled")))).toHaveLength(1);
    }
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toEqual(beforeBlocker);
    expect(await readRun(f.runId)).toEqual(beforeRun);
    expect(await readLease(f.lease.id)).toEqual(beforeLease);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(beforeTask);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  });

  it.each(["acknowledged", "warm", "pending", "foreign", "owned"])("pins historical cancelled work only after an exact Stop acknowledgement: %s", async kind => {
    const f = await seed();
    if (kind === "warm") await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment" }).where(eq(environmentLeases.id, f.lease.id));
    await db.update(heartbeatRuns).set({ status: "cancelled", nativePhase: "observed", finishedAt: new Date(),
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId: f.runId,
        companyId: kind === "foreign" ? randomUUID() : f.companyId, issueId: f.issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: kind === "pending" ? "pending" : "acknowledged",
        dispatched: true, intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } },
    }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "owned") await db.update(nativeRunFinalizations).set({ leaseOwner: "current-controller" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await preserveCancelledNativeWorkspaces(db);
    const current = await readRun(f.runId);
    expect(current).toMatchObject({ status: "cancelled", resultJson: { nativeCancellation: { scope: "run" } } });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
    const pinned = kind === "acknowledged" || kind === "warm";
    expect(await readLease(f.lease.id)).toMatchObject(pinned
      ? { status: "pending_cleanup", leasePolicy: "retain_on_failure", metadata: { sandboxStopAndRetain: { runId: f.runId } } }
      : { status: "active", leasePolicy: "ephemeral" });
    expect(await actions(f.issueId)).toHaveLength(pinned ? 1 : 0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  });
  it("keeps another cancelled workspace recoverable when one task row is locked", async () => {
    const busy = await seed(), free = await seed();
    for (const f of [busy, free]) await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId, issueId: f.issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } },
    }).where(eq(heartbeatRuns.id, f.runId));
    let release!: () => void, ready!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { ready = resolve; });
    const holding = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, busy.issueId)).for("update");
      ready(); await released;
    });
    await acquired;
    try {
      for (let pass = 0; pass < 3; pass++) await preserveCancelledNativeWorkspaces(db);
      expect(await readLease(busy.lease.id)).toMatchObject({ status: "active" });
      expect(await readLease(free.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    } finally { release(); await holding; }
  }, 15_000);
  it.each(["pending_cleanup", "released"])("keeps an exact %s cancellation eligible until its file hold is recorded", async status => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId, issueId: f.issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } },
    }).where(eq(heartbeatRuns.id, f.runId));
    const stopping = await prepareSandboxStopAndRetain(db, f.lease);
    if (!stopping) throw new Error("Expected the exact stop-only source");
    if (status === "pending_cleanup") {
      await preserveCancelledNativeWorkspaces(db);
      expect((await readRun(f.runId)).resultJson).not.toHaveProperty("workspaceRestoreRecovery");
      expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "ephemeral" });
    }
    await settleStopOnlyCleanup(db, stopping, { attemptId: String(stopping.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId: f.lease.providerLeaseId, state: "stopped" } });
    for (let pass = 0; pass < 3; pass++) await preserveCancelledNativeWorkspaces(db);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "released", leasePolicy: "retain_on_failure",
      metadata: { remoteExecutionTermination: { state: "stopped" } } });
    expect(await readRun(f.runId)).toMatchObject({ status: "cancelled", resultJson: {
      workspaceRestoreRecovery: { leaseIds: [f.lease.id] },
    } });
    expect(await actions(f.issueId)).toHaveLength(1);
  });

  it("pins only the exact unexported source and exposes a file-only recovery card", async () => {
    const f = await seed();
    const [other] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId,
      issueId: f.issueId, environmentId: f.environment.id, provider: "daytona", providerLeaseId: randomUUID(),
      status: "active", metadata: f.lease.metadata,
    }).returning();
    await db.transaction(tx => preserveNativeFailedWorkspace(tx as unknown as typeof db, f.run));
    expect(await readRun(f.runId)).toMatchObject({ status: "failed", errorCode: "adapter_failed", resultJson: {
      originalDiagnostic: true, workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: { leaseIds: [f.lease.id] },
    } });
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure", metadata: {
      sandboxStopAndRetain: { runId: f.runId, leaseId: f.lease.id, providerLeaseId: f.lease.providerLeaseId },
    } });
    expect(await readLease(other.id)).toMatchObject({ status: "active" });
    expect(await actions(f.issueId)).toMatchObject([{ status: "resolved", outcome: "blocked", evidence: { runId: f.runId } }]);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.runId,
      cause: "native_continuation_requires_reconciliation", workspaceRepairRequired: true,
      canRecordWorkspaceRepair: true, canRetry: false, canContinue: false,
    });
    await preserveNativeFailedWorkspace(db, await readRun(f.runId));
    expect(await actions(f.issueId)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "issue.workspace_recovery_required")))).toHaveLength(1);
  });

  async function bindExternalInput(f: Awaited<ReturnType<typeof seed>>, provider: "grok_bot" | "openai_dot" | "muse", change?: (input: { schema: string; binding: { runId: string; companyId: string; agentId: string; issueId: string }; provider: { kind: string; bridgeRevision?: string }; workspace: { access: string; cwd: string | null } }) => void) {
    const run = await readRun(f.runId);
    const input = { schema: provider === "muse" ? "paperclip.native-execution-input.v8" : "paperclip.native-execution-input.v6",
      binding: { runId: f.runId, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId },
      provider: { kind: provider, ...(provider === "muse" ? { bridgeRevision: "muse-v1" } : {}) }, workspace: { access: "none", cwd: null, repoUrl: null, repoRef: null, branchName: null } };
    change?.(input);
    const [updated] = await db.update(heartbeatRuns).set({ driverKind: provider === "muse" ? "muse_external" : provider === "grok_bot" ? "grok_bot_mcp" : "openai_dot_mcp",
      runnerProfileJson: { ...run.runnerProfileJson, nativeExecutionInput: input } }).where(eq(heartbeatRuns.id, f.runId)).returning();
    return updated;
  }

  it.each(["grok_bot", "openai_dot", "muse"] as const)("does not invent file recovery for %s admitted without workspace access", async provider => {
    const f = await seed(), run = await bindExternalInput(f, provider);
    const [hold] = provider === "muse" ? await db.insert(externalAgentHolds).values({ companyId: f.companyId, agentId: f.agentId,
      provider: "muse", assignmentId: randomUUID(), bindingId: randomUUID(), bindingGeneration: 1, runId: f.runId,
      workerUnknown: true, nativeEffectsUnknown: true }).returning() : [];
    await preserveNativeFailedWorkspace(db, run);
    expect((await readRun(f.runId)).resultJson).not.toHaveProperty("workspaceRestoreFailure");
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
    expect(await actions(f.issueId)).toHaveLength(0);
    if (hold) expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id, hold.id)))[0]).toEqual(hold);
  });

  it.each(["run", "company", "agent", "schema", "write_access"])("preserves file safeguards when no-workspace evidence has an invalid %s", async mismatch => {
    const f = await seed();
    const run = await bindExternalInput(f, "grok_bot", input => {
      if (mismatch === "run") input.binding.runId = randomUUID();
      if (mismatch === "company") input.binding.companyId = randomUUID();
      if (mismatch === "agent") input.binding.agentId = randomUUID();
      if (mismatch === "schema") input.schema = "unknown";
      if (mismatch === "write_access") input.workspace.access = "read_write";
    });
    await preserveNativeFailedWorkspace(db, run);
    expect((await readRun(f.runId)).resultJson).toHaveProperty("workspaceRestoreFailure", "restore_failed");
    expect(await readLease(f.lease.id)).toMatchObject({ leasePolicy: "retain_on_failure" });
  });

  it.each(["run", "company", "agent", "issue", "schema", "provider", "bridge", "missing_bridge", "driver", "write_access", "cwd"] as const)("retains file safeguards for a mismatched Muse %s contract", async mismatch => {
    const f = await seed();
    await bindExternalInput(f, "muse", input => {
      if (mismatch === "run") input.binding.runId = randomUUID();
      if (mismatch === "company") input.binding.companyId = randomUUID();
      if (mismatch === "agent") input.binding.agentId = randomUUID();
      if (mismatch === "issue") input.binding.issueId = randomUUID();
      if (mismatch === "schema") input.schema = "paperclip.native-execution-input.v6";
      if (mismatch === "provider") input.provider.kind = "grok_bot";
      if (mismatch === "bridge") input.provider.bridgeRevision = "unknown";
      if (mismatch === "missing_bridge") delete input.provider.bridgeRevision;
      if (mismatch === "write_access") input.workspace.access = "read_write";
      if (mismatch === "cwd") input.workspace.cwd = "/untrusted-task-workspace";
    });
    if (mismatch === "driver") await db.update(heartbeatRuns).set({ driverKind: "openai_dot_mcp" }).where(eq(heartbeatRuns.id, f.runId));
    await preserveNativeFailedWorkspace(db, await readRun(f.runId));
    expect((await readRun(f.runId)).resultJson).toHaveProperty("workspaceRestoreFailure", "restore_failed");
    expect(await readLease(f.lease.id)).toMatchObject({ leasePolicy: "retain_on_failure" });
    expect(await actions(f.issueId)).toHaveLength(1);
  });

  it.each(["grok_bot", "openai_dot"] as const)("keeps historical %s inspection holds with an available recovery path", async provider => {
    const f = await seed();
    // Reproduce a hold persisted by an older cancellation path, then attach its admitted contract.
    await preserveNativeFailedWorkspace(db, f.run);
    const lease = await readLease(f.lease.id);
    await settleStopOnlyCleanup(db, lease, { attemptId: String(lease.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId: lease.providerLeaseId, state: "stopped" } });
    await bindExternalInput(f, provider);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ runId: f.runId, canRetry: false, canContinue: false,
      workspaceRepairRequired: provider !== "grok_bot", canRecordWorkspaceRepair: provider !== "grok_bot" });
    if (provider === "grok_bot") {
      expect(blocker?.nextAction).not.toContain("files");
      expect(blocker?.nextAction).toContain("Runtime");
    }
    expect(await actions(f.issueId)).toHaveLength(1);
  });

  it("records verified file repair without retrying the native run or changing its task", async () => {
    const f = await seed();
    await db.update(issues).set({ status: "done", assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    await preserveNativeFailedWorkspace(db, f.run);
    const lease = await readLease(f.lease.id);
    await settleStopOnlyCleanup(db, lease, { attemptId: String(lease.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId: lease.providerLeaseId, state: "stopped" },
    });
    const [action] = await actions(f.issueId);
    const decision = { runId: f.runId, providerStopped: true as const, actionOutcome: "mixed" as const,
      outcomeEvidence: "Files verified; no external action is replayed.", workspaceRepairEvidence: "Exact retained allocation exported and every source hash checked." };
    await validateExecutionReconciliation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: null, sourceRunId: f.runId, decision, workspaceRepairOnly: true });
    await markExecutionReconciliation(db, action!, decision, "board-operator", undefined, { workspaceRepairOnly: true });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect(await db.select().from(issues).where(eq(issues.id, f.issueId))).toMatchObject([{ status: "done", assigneeAgentId: null }]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await actions(f.issueId)).toMatchObject([{ evidence: { continuationDelivery: "not_requested" } }]);
  });

  async function claimRestart(f: Awaited<ReturnType<typeof seed>>) {
    const claim: NativeRestartRecoveryClaim = { kind: "reattach_remote_runner", runId: f.runId,
      leaseOwner: randomUUID(), controllerGeneration: 2, providerAttempt: 3,
      restartKind: "hard", recoveryRequestId: null,
      remote: { providerLeaseId: f.lease.providerLeaseId!, remoteCwd: "/work" } };
    await db.update(heartbeatRuns).set({ status: "running", nativePhase: "observed" }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner: claim.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000), controllerGeneration: claim.controllerGeneration, attempt: claim.providerAttempt,
    }).where(eq(nativeRunFinalizations.runId, f.runId));
    return claim;
  }

  it.each([false, true])("captures a preparation failure before the terminal writer, with recovery claim: %s", async claimed => {
    const f = await seed();
    const restartRecovery = claimed ? await claimRestart(f) : undefined;
    if (!claimed) {
      await db.update(heartbeatRuns).set({ status: "running", nativePhase: "observed" }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, f.runId));
    }
    await preserveNativeFailedWorkspace(db, await readRun(f.runId), { allowPreterminal: true, restartRecovery });
    expect(await readRun(f.runId)).toMatchObject({ status: "running", resultJson: { workspaceRestoreRecovery: { leaseIds: [f.lease.id] } } });
    if (claimed) expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))
      .toMatchObject([{ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null }]);
    await db.update(heartbeatRuns).set({ status: "failed", resultJson: preserveWorkspaceRestoreRecoveryMetadataSql({ stopReason: "adapter_failed" }) })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await readRun(f.runId)).toMatchObject({ status: "failed", resultJson: {
      stopReason: "adapter_failed", workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: { leaseIds: [f.lease.id] },
    } });
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ workspaceRepairRequired: true });
  });

  it("records terminal file retention after the executor retires its recovery claim", async () => {
    const f = await seed();
    const restartRecovery = await claimRestart(f);
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(heartbeatRuns).set({ status: "failed", nativePhase: "terminal_failure" }).where(eq(heartbeatRuns.id, f.runId));
    await preserveNativeFailedWorkspace(db, await readRun(f.runId), { allowPreterminal: true, restartRecovery });
    expect(await readRun(f.runId)).toMatchObject({ status: "failed", nativePhase: "terminal_failure" });
    expect(await readLease(f.lease.id)).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ workspaceRepairRequired: true });
  });

  it.each(["token", "generation", "attempt", "run", "remote", "expired", "released"])("refuses a stale %s recovery claim", async kind => {
    const f = await seed();
    const restartRecovery = await claimRestart(f);
    if (kind === "token") restartRecovery.leaseOwner = randomUUID();
    if (kind === "generation") restartRecovery.controllerGeneration += 1;
    if (kind === "attempt") restartRecovery.providerAttempt += 1;
    if (kind === "run") restartRecovery.runId = randomUUID();
    if (kind === "remote" && restartRecovery.kind === "reattach_remote_runner" && restartRecovery.remote.kind !== "plugin_task") restartRecovery.remote.remoteCwd = "/other";
    if (kind === "expired") await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (kind === "released") await db.update(nativeRunFinalizations).set({ leaseOwner: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    await expect(preserveNativeFailedWorkspace(db, await readRun(f.runId), { allowPreterminal: true, restartRecovery }))
      .rejects.toBeInstanceOf(NativeWorkspaceFinalizationBusyError);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active" });
    expect(await actions(f.issueId)).toHaveLength(0);
    expect(await readRun(f.runId)).toMatchObject({ status: "running", nativePhase: "observed" });
  });

  it("refuses cleanup when another execution still owns the coordinator", async () => {
    const f = await seed();
    await db.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner: randomUUID() })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    await expect(preserveNativeFailedWorkspace(db, f.run, { allowPreterminal: true }))
      .rejects.toBeInstanceOf(NativeWorkspaceFinalizationBusyError);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active" });
    expect(await actions(f.issueId)).toHaveLength(0);
  });

  it.each(["finalized", "retryable_failure", "result_accepted", "wrong_provider", "wrong_company"])("leaves %s outside failed-source retention", async kind => {
    const f = await seed();
    if (kind === "retryable_failure" || kind === "result_accepted") {
      await db.update(nativeRunFinalizations).set({ phase: kind }).where(eq(nativeRunFinalizations.runId, f.runId));
    } else {
      const reference = f.run.runnerProfileJson!.nativeWorkspaceSync as Record<string, unknown>;
      if (kind === "wrong_company") {
        const foreign = await seed();
        await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
          ...reference, leaseId: foreign.lease.id, providerLeaseId: foreign.lease.providerLeaseId,
        } } }).where(eq(heartbeatRuns.id, f.runId));
      } else await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
        ...reference, ...(kind === "finalized" ? { state: "finalized", finalHostSha256: "c".repeat(64) } : { providerLeaseId: randomUUID() }),
      } } }).where(eq(heartbeatRuns.id, f.runId));
    }
    await preserveNativeFailedWorkspace(db, await readRun(f.runId));
    expect(await actions(f.issueId)).toHaveLength(0);
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active" });
  });

  it("rolls back terminal status, source retention and the recovery card together", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
    await expect(db.transaction(async tx => {
      const [run] = await tx.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.runId)).returning();
      await preserveNativeFailedWorkspace(tx as unknown as typeof db, run!);
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    expect(await readRun(f.runId)).toMatchObject({ status: "running", resultJson: { originalDiagnostic: true } });
    expect(await readLease(f.lease.id)).toMatchObject({ status: "active", leasePolicy: "ephemeral" });
    expect(await actions(f.issueId)).toHaveLength(0);
  });
});
