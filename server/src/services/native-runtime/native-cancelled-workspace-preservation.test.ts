import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, completionContracts, createDb, environmentLeases, environments,
  executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { hasAcknowledgedNativeStopIntent } from "../acknowledged-native-stop.js";
import { requestWorkspaceRecovery } from "../workspace-recovery.js";
import { inspectWorkspaceRecoverySource } from "../workspace-recovery-source.js";
import { preserveCancelledNativeWorkspaces, preserveNativeFailedWorkspace,
  registerCancelledWorkspacePreservationWork } from "./native-failed-workspace-recovery.js";

(recoveryPostgresSupport.supported ? describe : describe.skip)("lifecycle-cancelled workspace preservation", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  const fixtures = new Set<string>();
  async function seed() {
    if (!database) {
      database = await startRecoveryPostgres("lifecycle-cancelled-workspace-");
      db = createDb(database.connectionString);
    }
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    fixtures.add(runId);
    const workspaceId = randomUUID(), leaseId = randomUUID(), environmentId = randomUUID();
    const providerLeaseId = `allocation-${randomUUID()}`, snapshotId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stopped native files", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stopped worker", adapterType: "paperclip_runner",
      status: "terminated", lifecycleState: "terminating" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Keep cancelled files", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `Preservation ${runId}`, driver: "sandbox" });
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
      remoteCwd: "/work", epoch: 2, state: "prepared", snapshotId };
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", companyId, issueId, runId,
      scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
      intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), acknowledgedAt: new Date().toISOString(),
      effects: ["release_run_resources"] };
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", runtimeModeResolvedAt: new Date(), nativePhase: "observed", status: "cancelled",
      errorCode: "cancelled", error: "Agent lifecycle stop requested", finishedAt: new Date(),
      costAccountingPending: true, usageJson: { inputTokens: 7 },
      contextSnapshot: { issueId, taskId: issueId },
      runnerProfileJson: { remoteWorkspace: reference, nativeResourceDisposition: "destroy" },
      resultJson: { nativeCancellation, startupCancellation: { beforeNativeSelection: false } },
    }).returning();
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
      failureCode: "native_continuation_requires_reconciliation", recoveryState: "blocked" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      name: "Retained remote files", mode: "isolated", strategyType: "scratch", metadata: { remoteWorkspace: {
        schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId, source: { kind: "empty" },
        location: { environmentId, leaseId, providerLeaseId, remoteCwd: "/work" }, writerRunId: runId, dirty: true,
      } } });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId,
      issueId, executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId, status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" } });
    return { companyId, agentId, issueId, runId, workspaceId, leaseId, reference, nativeCancellation, run };
  }
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks();
    if (fixtures.size) await db.update(heartbeatRuns).set({ status: "failed" }).where(inArray(heartbeatRuns.id, [...fixtures]));
    fixtures.clear();
  });

  async function unchanged(f: Awaited<ReturnType<typeof seed>>) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.resultJson).not.toHaveProperty("workspaceRestoreRecovery");
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0])
      .toMatchObject({ status: "active", cleanupStatus: null, releasedAt: null });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }

  it("reconstructs prepared remote files after an audited lifecycle Stop without a board actor", async () => {
    const f = await seed();
    const [historical] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "resolved", ownerType: "board", cause: "native_continuation_requires_reconciliation",
      fingerprint: randomUUID(), evidence: { runId: f.runId, originalFailureCode: "native_continuation_requires_reconciliation",
        nativeFailureBlock: true, automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", runId: f.runId } },
      nextAction: "The prior execution remains stopped.", resolvedAt: new Date() }).returning();
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      const [retained] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(retained.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.leaseId] },
        nativeCancellation: f.nativeCancellation });
      expect(retained).toMatchObject({ status: "cancelled", nativePhase: "observed" });
      expect(retained).toMatchObject({ costAccountingPending: true, costAccountedAt: null,
        usageJson: f.run.usageJson, finishedAt: f.run.finishedAt });
      expect(retained.runnerProfileJson).toEqual(f.run.runnerProfileJson);
      expect(hasAcknowledgedNativeStopIntent(retained)).toBe(false);
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      expect(lease).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure",
        metadata: { sandboxStopAndRetain: { runId: f.runId, leaseId: f.leaseId } } });
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
      expect(actions).toHaveLength(2);
      expect(actions.find(action => action.id === historical.id)).toEqual(historical);
      const preservation = actions.find(action => action.id !== historical.id)!;
      expect(preservation.evidence).toMatchObject({ runId: f.runId, workspaceRestoreRecovery: { leaseIds: [f.leaseId] } });
      await preserveCancelledNativeWorkspaces(db);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toEqual(actions);
      const source = { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: preservation.id };
      expect((await inspectWorkspaceRecoverySource(db, source)).sources).toHaveLength(1);
      expect(worker.nextWakeAt()).toBeNull();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const reads = vi.spyOn(db, "select");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore(); vi.useRealTimers();
      expect(await requestWorkspaceRecovery({ ...source, db, idempotencyKey: randomUUID(), actorId: "operator" }))
        .toMatchObject({ actionId: source.actionId, status: "queued" });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
      expect((await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, f.companyId),
        eq(nativeRunFinalizations.runId, f.runId))))[0]).toMatchObject({ phase: "terminal_failure", resultId: null,
        leaseOwner: null, failureCode: "native_continuation_requires_reconciliation" });
    } finally { await worker.stop(); }
  }, 120_000);

  it.each(["pending", "undispatched", "foreign-company", "foreign-issue", "foreign-run", "turn-scope",
    "empty-intent-audit", "missing-ack-audit", "empty-ack-audit", "live-owner", "live-controller", "accepted-result",
    "foreign-allocation", "foreign-workspace", "foreign-cwd", "saved-reference", "unknown-reference", "running"] as const)
  ("does not admit preservation for %s", async invalid => {
    const f = await seed();
    const intent: Record<string, unknown> = { ...f.nativeCancellation };
    if (invalid === "pending") intent.dispatchState = "pending";
    if (invalid === "undispatched") intent.dispatched = false;
    if (invalid === "foreign-company") intent.companyId = randomUUID();
    if (invalid === "foreign-issue") intent.issueId = randomUUID();
    if (invalid === "foreign-run") intent.runId = randomUUID();
    if (invalid === "turn-scope") intent.scope = "turn";
    if (invalid === "empty-intent-audit") intent.intentAuditId = "";
    if (invalid === "missing-ack-audit") delete intent.acknowledgementAuditId;
    if (invalid === "empty-ack-audit") intent.acknowledgementAuditId = "";
    const reference = { ...f.reference };
    if (invalid === "foreign-allocation") reference.providerLeaseId = randomUUID();
    if (invalid === "foreign-workspace") reference.workspaceId = randomUUID();
    if (invalid === "foreign-cwd") reference.remoteCwd = "/another-workspace";
    if (invalid === "saved-reference") reference.state = "saved";
    if (invalid === "unknown-reference") reference.schema = "unknown";
    await db.update(heartbeatRuns).set({ resultJson: { nativeCancellation: intent },
      runnerProfileJson: { remoteWorkspace: reference },
      ...(invalid === "running" ? { status: "running" } : {}),
      ...(invalid === "live-controller" ? { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) } : {}),
    }).where(eq(heartbeatRuns.id, f.runId));
    if (invalid === "live-owner") await db.update(nativeRunFinalizations).set({ leaseOwner: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (invalid === "accepted-result") {
      const [contract] = await db.insert(completionContracts).values({ companyId: f.companyId, issueId: f.issueId,
        revision: 1, schemaVersion: "v1", policyVersion: "v1", risk: "low", completionAuthority: "agent",
        incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: "a".repeat(64),
        createdByActorType: "system", createdByActorId: "test" }).returning();
      await db.update(heartbeatRuns).set({ completionContractId: contract.id }).where(eq(heartbeatRuns.id, f.runId));
      const [result] = await db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId,
        completionContractId: contract.id, serverFingerprint: "b".repeat(64), schemaStatus: "accepted",
        resultJson: {}, canonicalSha256: "c".repeat(64) }).returning();
      await db.update(nativeRunFinalizations).set({ resultId: result.id }).where(eq(nativeRunFinalizations.runId, f.runId));
    }
    const errors: unknown[] = [];
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { errors.push(error); } });
    try {
      await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      expect(errors).toEqual([]);
      await unchanged(f);
    } finally { await worker.stop(); }
  });

  it("rolls preservation back with its outer transaction", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => {
      await preserveNativeFailedWorkspace(tx as unknown as typeof db, f.run,
        { allowPreterminal: true, requireCancelledStop: true });
      throw new Error("outer transaction rollback");
    })).rejects.toThrow("outer transaction rollback");
    await unchanged(f);
  });

  it.each(["existing", "renewed-under-lock"] as const)("waits for the actual %s controller lease deadline", async kind => {
    const f = await seed();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const expiresAt = new Date(Date.now() + 600_000);
    let release = () => {};
    let blocker: Promise<void> | undefined;
    if (kind === "existing") {
      await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: expiresAt }).where(eq(heartbeatRuns.id, f.runId));
    } else {
      let ready!: (pid: number) => void;
      const acquired = new Promise<number>(resolve => { ready = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      blocker = db.transaction(async tx => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update");
        const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        ready(row.pid); await released;
      });
      const pid = await acquired;
      const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        const registration = registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true);
        await vi.waitFor(async () => {
          const [row] = await db.execute<{ waiting: number }>(sql`select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and ${pid} = any(pg_blocking_pids(pid))`);
          expect(row.waiting).toBe(1);
        });
        await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: expiresAt }).where(eq(heartbeatRuns.id, f.runId));
        release(); await blocker; await registration.ready;
        expect(worker.nextWakeAt()).toBe(expiresAt.getTime());
        const reads = vi.spyOn(db, "select"), transactions = vi.spyOn(db, "transaction");
        await vi.advanceTimersByTimeAsync(300_000);
        expect(reads).not.toHaveBeenCalled(); expect(transactions).not.toHaveBeenCalled();
        reads.mockRestore(); transactions.mockRestore();
        await vi.advanceTimersByTimeAsync(300_001);
        await vi.waitFor(async () => expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].resultJson)
          .toHaveProperty("workspaceRestoreRecovery"));
        expect(worker.nextWakeAt()).toBeNull();
      } finally { release(); await blocker; await worker.stop(); }
      return;
    }
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      expect(worker.nextWakeAt()).toBe(expiresAt.getTime());
      const reads = vi.spyOn(db, "select"), transactions = vi.spyOn(db, "transaction");
      await vi.advanceTimersByTimeAsync(300_000);
      expect(reads).not.toHaveBeenCalled(); expect(transactions).not.toHaveBeenCalled();
      reads.mockRestore(); transactions.mockRestore();
      await vi.advanceTimersByTimeAsync(300_001);
      await vi.waitFor(async () => expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].resultJson)
        .toHaveProperty("workspaceRestoreRecovery"));
      expect(worker.nextWakeAt()).toBeNull();
    } finally { await worker.stop(); }
  });
});
