import { currentControllerProcess } from "../services/controller-process-identity.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { agents, authUsers, companyMemberships, environmentLeases, environments, executionWorkspaceSnapshots, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { beforeAll, expect, it, vi } from "vitest";
import * as storageBackend from "../storage/index.js";
import { getStorageService } from "../storage/index.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { getSandboxProvider } from "../services/sandbox-provider-runtime.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerEnvironmentCleanupWork } from "../services/environment-cleanup-work.js";
import { classifyEnvironmentCapabilities, environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "../services/remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "../services/remote-workspace-snapshot-archive.js";
import { registerWorkspaceRecoveryWork } from "../services/workspace-recovery-work.js";
import { hasVerifiedWorkspaceRepair } from "../services/workspace-recovery-receipt.js";
import { pinFailedObservedWorkspace, settleStoppedObservedWorkspace, ObservedWorkspacePreservationBusyError } from "../services/native-runtime/native-observed-workspace-preservation.js";
import { claimNativeRestartRecoveries } from "../services/native-runtime/native-restart-recovery.js";
import { hasRemoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { hasConfirmedSandboxStopAndRetain } from "../services/sandbox-stop-and-retain.js";
import { createOwnershipReportState, runOwnershipReconciliationPass, settleOwnableKind } from "../services/recovery/ownership-invariant-report.js";
import { OWNABLE_KINDS } from "../services/recovery/ownership-registry.js";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";

const execute = promisify(execFile);
function barrier() { let resolve!: () => void; const promise = new Promise<void>(ready => { resolve = ready; }); return { promise, resolve }; }

describeEmbeddedPostgres("stopped observed native workspace preservation", () => {
  const fixture = nativeRestartFixture();
  let runtimeRoot: string, companyId: string, agentId: string;
  beforeAll(() => { ({ runtimeRoot, companyId, agentId } = fixture.current); });

  async function seedSource(label: string) {
    const f = await fixture.seedRun(label), db = f.db;
    const workspaceId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `sandbox://fake/${randomUUID()}`;
    await mkdir(path.join(runtimeRoot, workspaceId));
    const remoteCwd = await realpath(path.join(runtimeRoot, workspaceId));
    await writeFile(path.join(remoteCwd, "saved.txt"), "unfinished work with an unknown provider effect\n");
    await db.insert(environments).values({ id: environmentId, name: `Historical allocation ${environmentId}`, driver: "sandbox",
      config: { provider: "fake", image: "fixture:test" } });
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Source operator", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.update(agents).set({ defaultEnvironmentId: environmentId, adapterConfig: { provider: "codex", model: "gpt-6.1-sol" } }).where(eq(agents.id, agentId));
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
      remoteCwd, epoch: 1, state: "prepared", snapshotId: null };
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: f.issueId,
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "cloud_sandbox", name: "Unsaved original files",
      cwd: `/workspaces/${workspaceId}`, metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1",
        epoch: 1, snapshotId: null, source: { kind: "empty" }, writerRunId: f.runId, dirty: true,
        location: { environmentId, leaseId, providerLeaseId, remoteCwd } } } });
    await db.update(issues).set({ status: "blocked", executionRunId: null, checkoutRunId: null, executionWorkspaceId: workspaceId })
      .where(eq(issues.id, f.issueId));
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      executionWorkspaceId: workspaceId, environmentId, provider: "fake", providerLeaseId, status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", provider: "fake", image: "fixture:test", remoteCwd, agentId }, updatedAt: new Date(Date.now() - 6 * 60_000) });
    const checkpoint = { identity: { companyId, issueId: f.issueId, runId: f.runId, agentId, sessionId: f.native.normalizedSessionId },
      providerSessionId: "historical-session", activeTurnId: "unfinished-turn", pendingRuntimeRequests: [{ requestId: "unknown-tool" }] };
    const execution = buildNativeExecutionInput({ companyId, agentId, runId: f.runId,
      issue: { id: f.issueId, identifier: "NRR-HISTORICAL-OBSERVED", title: "Preserve original work", description: null, workMode: "standard" },
      taskPrompt: "Continue the original task.", provider: "codex", model: "gpt-6.1-sol",
      workspace: { id: workspaceId, cwd: remoteCwd, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: f.native.normalizedSessionId, runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Preserve original work", criteria: [{ id: "objective", requirement: "Retain files" }] } } });
    const profile = { ...f.preparedProfile, remoteWorkspace: reference, sessionCheckpoint: checkpoint,
      nativeExecutionInput: execution, nativeResourceDisposition: "stop_and_retain" };
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(Date.now() - 6 * 60_000),
      nativePhase: "observed", errorCode: "setup_failed", error: "Sandbox failed to become ready within the timeout period",
      responsibleUserId: userId, runnerProfileJson: profile, contextSnapshot: { issueId: f.issueId, executionWorkspaceId: workspaceId } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "observed", attempt: 1, controllerGeneration: 3, recoveryState: "awaiting_runner_reattach",
        controllerBootId: randomUUID(), controllerPid: 2_147_483_640, controllerProcessStartedAt: new Date(0),
      leaseOwner: "old-observed-controller", leaseExpiresAt: new Date(Date.now() - 5 * 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      ownerType: "board", returnOwnerAgentId: agentId, cause: "native_session_interrupted", fingerprint: `interrupted:${f.runId}`,
      evidence: { runId: f.runId }, nextAction: "Reconcile the unknown provider outcome.", maxAttempts: 3, wakePolicy: null,
      supersedeOnIdentityChange: true });
    return { ...f, workspaceId, environmentId, leaseId, providerLeaseId, remoteCwd, checkpoint, profile };
  }

  it("stops the exact stale allocation, preserves a cold-readable archive and never creates another native session", async () => {
    const f = await seedSource("HISTORICAL-OBSERVED"), db = f.db;
    const settings = instanceSettingsService(db), previous = await settings.getExperimental();
    const priorDatabase = process.env.DATABASE_URL, priorKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    const localStorage = getStorageService();
    let storage: { mockRestore(): void } | undefined;
    let heartbeat: ReturnType<typeof heartbeatService> | undefined;
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let workspaceWorker: ReturnType<typeof registerWorkspaceRecoveryWork> | undefined;
    let providerStop: { mockRestore(): void } | undefined;
    let providerDestroy: { mockRestore(): void } | undefined;
    let cleanupWorker: ReturnType<typeof registerEnvironmentCleanupWork> | undefined;
    const stopAllowed = barrier();
    try {
      storage = vi.spyOn(storageBackend, "getStorageService").mockReturnValue({ ...localStorage, provider: "s3" });
      process.env.DATABASE_URL = fixture.current.temporary.connectionString; process.env.PAPERCLIP_SECRETS_MASTER_KEY = "72".repeat(32);
      await settings.updateExperimental({ enableNativeRunner: true });
      const { workspaceId, environmentId, leaseId, providerLeaseId, remoteCwd, checkpoint, profile } = f;
      const acquire = vi.fn(async () => { throw new Error("A new allocation is forbidden"); });
      const backend = vi.fn(() => { throw new Error("A native session is forbidden"); });
      const copy = async (input: { operations: Array<{ files: Array<{ sourcePath: string; targetPath: string }> }> }) => {
        for (const operation of input.operations) for (const file of operation.files) {
          await mkdir(path.dirname(file.targetPath), { recursive: true }); await cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
        }
        return { operations: [], filesTransferred: input.operations.reduce((sum, operation) => sum + operation.files.length, 0), bytesTransferred: 0 };
      };
      const provider = getSandboxProvider("fake")!;
      const originalStop = provider.stopLease!.bind(provider);
      const stopped = vi.spyOn(provider, "stopLease").mockImplementation(async input => {
        await stopAllowed.promise; return originalStop(input);
      });
      providerStop = stopped;
      const destroyed = vi.spyOn(provider, "destroyLease"); providerDestroy = destroyed;
      const fileRuntime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox", acquireRunLease: acquire,
        resumeRunLease: async ({ lease }) => ({ providerLeaseId: lease.providerLeaseId!, metadata: { remoteCwd: lease.metadata?.remoteCwd } }),
        releaseRunLease: async () => { throw new Error("Destructive release is forbidden"); },
        retryPendingSandboxTeardown: async () => { throw new Error("Use the actual lifecycle owner"); }, realizeWorkspace: async () => { throw new Error("New realization is forbidden"); },
        execute: async input => {
          const result = await execute(input.command === "node" ? process.execPath : input.command, input.args ?? [],
            { cwd: input.cwd, env: { ...process.env, ...input.env }, maxBuffer: 4 * 1024 * 1024 });
          return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, timedOut: false, signal: null };
        },
        syncIn: copy, syncOut: copy, supportsSync: () => true,
        resolveCapabilities: async () => classifyEnvironmentCapabilities({ verifiedMethods: ["environmentSyncIn", "environmentSyncOut", "environmentExecute"] }),
      }] });
      const runtime = { ...fileRuntime, retryPendingSandboxTeardown: environmentRuntimeService(db).retryPendingSandboxTeardown };
      heartbeat = heartbeatService(db, { environmentRuntime: runtime, nativeSessionBackendFactory: backend });
      const errors = vi.fn();
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
      workspaceWorker = registerWorkspaceRecoveryWork(db, coordinator, runtime, heartbeat.resumeRemoteStopComments);
      const environmentWorker = heartbeat.registerNativeEnvironmentSettlementWork(coordinator, () => true);
      const orphanWorker = heartbeat.registerResidualRecoveryWork(coordinator, () => true);
      await Promise.all([workspaceWorker.ready, environmentWorker.ready, orphanWorker.ready]);
      await expect.poll(async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0].status,
        { timeout: 10_000 }).toBe("pending_cleanup");
      const [beforeRestart] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
        eq(issueRecoveryActions.fingerprint, `native-workspace:${f.runId}`)));
      await coordinator.stop(); await workspaceWorker.stop();
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
      workspaceWorker = registerWorkspaceRecoveryWork(db, coordinator, runtime, heartbeat.resumeRemoteStopComments);
      const restartedEnvironment = heartbeat.registerNativeEnvironmentSettlementWork(coordinator, () => true);
      const restartedOrphan = heartbeat.registerResidualRecoveryWork(coordinator, () => true);
      await Promise.all([workspaceWorker.ready, restartedEnvironment.ready, restartedOrphan.ready]);
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, beforeRestart.id)))[0].evidence.observedWorkspacePreservation)
        .toEqual(beforeRestart.evidence.observedWorkspacePreservation);
      cleanupWorker = registerEnvironmentCleanupWork(db, coordinator, { canRun: () => true,
        sweepPending: backoffMs => heartbeat!.sweepPendingCleanupLeases({ backoffMs }), minimumSpacingMs: 1 });
      await expect.poll(() => stopped.mock.calls.length, { timeout: 10_000 }).toBe(1);
      const [pending] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      const [ownerBeforeStop] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(ownerBeforeStop).toMatchObject({ phase: "observed", leaseOwner: "old-observed-controller", controllerGeneration: 3, attempt: 1 });
      expect(pending).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure",
        metadata: { sandboxStopAndRetain: { runId: f.runId, leaseId, providerLeaseId } } });
      expect(hasRemoteTerminationReceipt(pending)).toBe(false);
      expect(await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, workspaceId))).toHaveLength(0);
      expect(backend).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
      stopAllowed.resolve();
      await cleanupWorker.ready;
      const [waiting] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
        eq(issueRecoveryActions.fingerprint, `native-workspace:${f.runId}`)));
      const wait = waiting.evidence.systemRecovery as { state?: string; nextAttemptAt?: number; failure?: { code?: string } } | undefined;
      if (wait?.nextAttemptAt && wait.nextAttemptAt > Date.now()) {
        expect(wait).toMatchObject({ state: "awaiting_evidence", failure: { code: "agent_stop_unconfirmed" } });
        expect(wait.nextAttemptAt - Date.now()).toBeLessThanOrEqual(36_000);
      }
      await expect.poll(async () => hasVerifiedWorkspaceRepair(db,
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]), { timeout: 40_000 }).toBe(true);
      const [savedWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
      const [savedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [savedOwner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(savedOwner).toMatchObject({ phase: "terminal_failure", leaseOwner: null, attempt: 1, controllerGeneration: 3 });
      expect(savedRun).toMatchObject({ status: "failed", errorCode: "setup_failed", runnerProfileJson: { sessionCheckpoint: checkpoint, nativeExecutionInput: profile.nativeExecutionInput } });
      const snapshotId = (savedWorkspace.metadata?.remoteWorkspace as { snapshotId: string }).snapshotId;
      const snapshot = await getWorkspaceSnapshot(db, { companyId, workspaceId, snapshotId });
      expect(snapshot).not.toBeNull();
      const cold = path.join(runtimeRoot, randomUUID()), archivePath = path.join(runtimeRoot, `${randomUUID()}.pcws`);
      await loadWorkspaceSnapshotArchive({ storage: storageBackend.getStorageService(), reference: snapshot!, targetPath: archivePath });
      await restoreRemoteWorkspaceArchive({ archivePath, targetDir: cold, expectedManifestDigest: snapshot!.manifestDigest });
      expect(await readFile(path.join(cold, "saved.txt"), "utf8")).toBe("unfinished work with an unknown provider effect\n");
      expect(await readFile(path.join(remoteCwd, "saved.txt"), "utf8")).toBe("unfinished work with an unknown provider effect\n");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toHaveLength(0);
      const [preservation] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
        eq(issueRecoveryActions.fingerprint, `native-workspace:${f.runId}`)));
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
      expect((await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
        eq(issueRecoveryActions.fingerprint, `interrupted:${f.runId}`))))[0]).toMatchObject({ status: "active", cause: "native_session_interrupted" });
      expect(preservation.evidence).toMatchObject({ automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", actionOutcome: "unknown" } });
      expect(backend).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
      expect(destroyed).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      stopAllowed.resolve(); cleanupWorker?.stop();
      try { await coordinator?.stop(); await workspaceWorker?.stop(); await heartbeat?.drainActiveRunExecutions(); }
      finally {
        providerStop?.mockRestore(); providerDestroy?.mockRestore();
        storage?.mockRestore();
        if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
        if (priorKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; else process.env.PAPERCLIP_SECRETS_MASTER_KEY = priorKey;
        await settings.updateExperimental(previous);
      }
    }
  }, 60_000);

  type Source = Awaited<ReturnType<typeof seedSource>>;
  async function readSource(f: Source) {
    const [run] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [lease] = await f.db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    const [owner] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    return { run, lease, owner };
  }
  async function changeLease(f: Source, patch: Partial<typeof environmentLeases.$inferInsert>, metadata?: Record<string, unknown>) {
    const { lease } = await readSource(f);
    await f.db.update(environmentLeases).set({ ...patch, ...(metadata ? { metadata: { ...lease.metadata, ...metadata } } : {}) })
      .where(eq(environmentLeases.id, f.leaseId));
  }
  async function acceptedResult(f: Source) {
    const { run } = await readSource(f);
    await f.db.insert(nativeRunResults).values({ companyId, issueId: f.issueId, runId: f.runId,
      completionContractId: run.completionContractId!, schemaStatus: "accepted", serverFingerprint: randomUUID(),
      canonicalSha256: "a".repeat(64), resultJson: { outcome: "accepted" } });
  }
  async function otherAllocationOwner(f: Source) {
    const other = await fixture.seedRun(`OTHER-${randomUUID()}`, f.db);
    await f.db.insert(environmentLeases).values({ companyId, issueId: other.issueId, heartbeatRunId: other.runId,
      environmentId: f.environmentId, provider: "fake", providerLeaseId: f.providerLeaseId,
      status: "active", leasePolicy: "ephemeral", metadata: { driver: "sandbox", provider: "fake", image: "fixture:test" } });
    return other;
  }
  async function sourceHeld(f: Source) {
    const { run, owner } = await readSource(f);
    expect(owner).toMatchObject({ phase: "observed", leaseOwner: "old-observed-controller", controllerGeneration: 3, attempt: 1 });
    expect(run).toMatchObject({ status: "failed", runnerProfileJson: { sessionCheckpoint: f.checkpoint } });
    expect(await readFile(path.join(f.remoteCwd, "saved.txt"), "utf8")).toBe("unfinished work with an unknown provider effect\n");
    expect(await f.db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, f.workspaceId))).toHaveLength(0);
  }

  it.each(["reusable", "inflight_cleanup", "unknown_cleanup", "null_stop_intent", "null_export_intent", "unknown_recovery", "manual_failure", "live_controller",
    "copyback_owner", "accepted_unbound", "other_allocation_owner", "wrong_epoch", "invalid_reference", "stopped_mismatch", "operator_stop"] as const)(
    "keeps unsafe observed source held without Stop or Delete (%s)", async mode => {
      const f = await seedSource(`HELD-${mode}`);
      if (mode === "reusable") await changeLease(f, { leasePolicy: "reuse_by_environment" });
      if (mode === "inflight_cleanup") await changeLease(f, {}, { pendingCleanupInFlight: true });
      if (mode === "unknown_cleanup") await changeLease(f, {}, { pendingCleanupInFlight: "unknown" });
      if (mode === "null_stop_intent") await changeLease(f, {}, { sandboxStopAndRetain: null });
      if (mode === "null_export_intent") await changeLease(f, {}, { nativeWorkspaceExportResume: null });
      if (mode === "unknown_recovery") await f.db.update(nativeRunFinalizations).set({ recoveryState: "awaiting_evidence" }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (mode === "manual_failure") await f.db.update(nativeRunFinalizations).set({ failureCode: "native_restart_recovery_blocked" }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (mode === "live_controller") await f.db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (mode === "copyback_owner") await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.profile,
        nativeWorkspaceFinalizationOwner: { token: randomUUID() } } }).where(eq(heartbeatRuns.id, f.runId));
      if (mode === "invalid_reference") await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.profile, remoteWorkspace: { schema: "unverified" } } }).where(eq(heartbeatRuns.id, f.runId));
      if (mode === "accepted_unbound") await acceptedResult(f);
      if (mode === "other_allocation_owner") await otherAllocationOwner(f);
      if (mode === "wrong_epoch") await f.db.update(executionWorkspaces).set({ metadata: sql`jsonb_set(${executionWorkspaces.metadata}, '{remoteWorkspace,epoch}', '2')` }).where(eq(executionWorkspaces.id, f.workspaceId));
      if (mode === "stopped_mismatch") await changeLease(f, { status: "released", cleanupStatus: "success", releasedAt: new Date() }, {
        remoteExecutionTermination: { schema: "paperclip.remote-execution-termination.v1", provider: "fake", providerLeaseId: `sandbox://fake/${randomUUID()}`, state: "stopped", confirmedAt: new Date().toISOString() },
      });
      if (mode === "operator_stop") await f.db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
      const provider = getSandboxProvider("fake")!, stopped = vi.spyOn(provider, "stopLease"), destroyed = vi.spyOn(provider, "destroyLease");
      const backend = vi.fn(() => { throw new Error("Unexpected native execution"); });
      const heartbeat = heartbeatService(f.db, { nativeSessionBackendFactory: backend });
      try {
        await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0, companyId, leaseId: f.leaseId });
        await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
        const current = await readSource(f);
        expect(current.run.resultJson?.workspaceRestoreRecovery).toBeUndefined();
        if (mode === "null_stop_intent") expect(current.lease.metadata?.sandboxStopAndRetain).toBeNull();
        if (mode === "null_export_intent") expect(current.lease.metadata?.nativeWorkspaceExportResume).toBeNull();
        await sourceHeld(f);
        expect(stopped.mock.calls.filter(([input]) => input.providerLeaseId === f.providerLeaseId)).toHaveLength(0);
        expect(destroyed.mock.calls.filter(([input]) => input.providerLeaseId === f.providerLeaseId)).toHaveLength(0); expect(backend).not.toHaveBeenCalled();
      } finally { await heartbeat.drainActiveRunExecutions(); stopped.mockRestore(); destroyed.mockRestore(); }
    });

  it("holds malformed workspace authority without throwing or recording a new pin", async () => {
    const f = await seedSource("MALFORMED-WORKSPACE");
    await f.db.update(executionWorkspaces).set({ metadata: sql`jsonb_set(${executionWorkspaces.metadata}, '{remoteWorkspace,epoch}', '0')` })
      .where(eq(executionWorkspaces.id, f.workspaceId));
    await expect(pinFailedObservedWorkspace(f.db, companyId, f.runId)).resolves.toBe(false);
    expect((await readSource(f)).run.resultJson?.workspaceRestoreRecovery).toBeUndefined();
    await sourceHeld(f);
  });

  it("keeps a poisoned workspace held and continues the actual orphan page to its next valid source", async () => {
    const bad = await seedSource("POISONED-PAGE-FIRST"), good = await seedSource("VALID-PAGE-NEXT"), db = bad.db;
    await db.update(environmentLeases).set({ updatedAt: new Date(Date.now() - 7 * 60_000) }).where(eq(environmentLeases.id, bad.leaseId));
    await db.update(executionWorkspaces).set({ metadata: sql`jsonb_set(${executionWorkspaces.metadata}, '{remoteWorkspace,epoch}', '0')` })
      .where(eq(executionWorkspaces.id, bad.workspaceId));
    const provider = getSandboxProvider("fake")!, stopped = vi.spyOn(provider, "stopLease"), destroyed = vi.spyOn(provider, "destroyLease");
    const backend = vi.fn(() => { throw new Error("Unexpected native execution"); });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: backend });
    try {
      await expect(heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0, companyId })).resolves.toMatchObject({ recovered: 1 });
      expect((await readSource(bad)).run.resultJson?.workspaceRestoreRecovery).toBeUndefined();
      expect((await readSource(bad)).lease.status).toBe("active");
      expect((await readSource(good)).run.resultJson?.workspaceRestoreRecovery).toMatchObject({ leaseIds: [good.leaseId] });
      expect((await readSource(good)).lease).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
      await sourceHeld(bad);
      expect(stopped.mock.calls.filter(([input]) => input.providerLeaseId === bad.providerLeaseId)).toHaveLength(0);
      expect(destroyed.mock.calls.filter(([input]) => input.providerLeaseId === bad.providerLeaseId)).toHaveLength(0);
      expect(backend).not.toHaveBeenCalled();
    } finally { await heartbeat.drainActiveRunExecutions(); stopped.mockRestore(); destroyed.mockRestore(); }
  });

  it.each(["before_pin", "after_pin"] as const)("serializes the real ephemeral checkpoint claim %s", async order => {
    const f = await seedSource(`CLAIM-${order}`);
    if (order === "before_pin") {
      // This branch exercises a same-host checkpoint claim, not a legacy or
      // foreign namespace. Keep every other historical preservation fixture unchanged.
      const controller = await currentControllerProcess();
      expect(controller.hostHash).not.toBe("unknown");
      await f.db.update(nativeRunFinalizations).set({ controllerHostHash: controller.hostHash })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      await f.db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    } else expect(await pinFailedObservedWorkspace(f.db, companyId, f.runId)).toBe(true);
    const dispositions = await claimNativeRestartRecoveries({ db: f.db, restartKind: "hard", runIds: [f.runId], controller: fixture.current.successor });
    if (order === "before_pin") {
      expect(dispositions).toMatchObject([{ kind: "reattach_remote_runner", runId: f.runId }]);
      expect(await pinFailedObservedWorkspace(f.db, companyId, f.runId)).toBe(false);
      const { run, lease, owner } = await readSource(f);
      expect(run.status).toBe("running"); expect(owner.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(owner.controllerGeneration).toBe(4); expect(lease.status).toBe("active");
      expect(lease.metadata?.sandboxStopAndRetain).toBeUndefined();
    } else {
      expect(dispositions).toMatchObject([{ kind: "blocked", runId: f.runId, reason: "issue_execution_lock_changed" }]);
      expect((await readSource(f)).owner).toMatchObject({ phase: "observed", leaseOwner: "old-observed-controller", controllerGeneration: 3 });
    }
  });

  it("settles the fence from the shared reconciler once the provider stop is proven, never before", async () => {
    const f = await seedSource("SHARED-RECONCILER");
    const kind = OWNABLE_KINDS.find(entry => entry.id === "observed_workspace_preservation_fence")!;
    const pass = (record = true) => runOwnershipReconciliationPass(f.db, { state: createOwnershipReportState(), kinds: [kind], record });
    const settleThis = () => settleOwnableKind(f.db, kind.id, { runIds: [f.runId] });
    const fenceOf = async () => (await f.db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
      eq(issueRecoveryActions.fingerprint, `native-workspace:${f.runId}`))))[0].evidence.observedWorkspacePreservation as { state: string };
    expect(await pinFailedObservedWorkspace(f.db, companyId, f.runId)).toBe(true);
    const held = await pass(false);
    expect(held.kinds[0]!.reasons.fence_expired_without_provider_proof).toBeGreaterThanOrEqual(1);
    expect(await settleThis()).toEqual([]);
    expect(await fenceOf()).toMatchObject({ state: "stop_pending" });

    const heartbeat = heartbeatService(f.db);
    try {
      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
      const { lease } = await readSource(f);
      expect(hasRemoteTerminationReceipt(lease) && hasConfirmedSandboxStopAndRetain(lease)).toBe(true);
      const readOnly = await pass(false);
      expect(readOnly.kinds[0]!.reasons.provider_stopped).toBeGreaterThanOrEqual(1);
      expect(await fenceOf()).toMatchObject({ state: "stop_pending" });

      expect(await settleThis()).toMatchObject([{ kind: kind.id, runId: f.runId, reason: "provider_stopped" }]);
      expect(await fenceOf()).toMatchObject({ state: "stopped" });
      expect((await readSource(f)).owner).toMatchObject({ phase: "terminal_failure", leaseOwner: null });
      expect(await readFile(path.join(f.remoteCwd, "saved.txt"), "utf8")).toBe("unfinished work with an unknown provider effect\n");
    } finally { await heartbeat.drainActiveRunExecutions(); }
  });

  it("rechecks a new physical allocation owner after pin before the actual Stop dispatch", async () => {
    const f = await seedSource("ARRIVING-OWNER");
    expect(await pinFailedObservedWorkspace(f.db, companyId, f.runId)).toBe(true);
    const other = await otherAllocationOwner(f);
    const provider = getSandboxProvider("fake")!, stopped = vi.spyOn(provider, "stopLease"), destroyed = vi.spyOn(provider, "destroyLease");
    const heartbeat = heartbeatService(f.db);
    try {
      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
      expect(stopped.mock.calls.filter(([input]) => input.providerLeaseId === f.providerLeaseId)).toHaveLength(0);
        expect(destroyed.mock.calls.filter(([input]) => input.providerLeaseId === f.providerLeaseId)).toHaveLength(0);
      expect(await settleStoppedObservedWorkspace(f.db, companyId, f.runId)).toBe(false);
      expect((await readSource(f)).lease).toMatchObject({ status: "pending_cleanup", metadata: { pendingCleanupInFlight: false } });
      expect((await f.db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, other.runId)))[0].status).toBe("active");
      await sourceHeld(f);
    } finally { await heartbeat.drainActiveRunExecutions(); stopped.mockRestore(); destroyed.mockRestore(); }
  });

  it.each(["generation", "checkpoint", "workspace_authority", "accepted_result", "other_owner", "lost_stop_ack"] as const)(
    "does not settle observed ownership from stale or missing Stop evidence (%s)", async mode => {
      const f = await seedSource(`STOP-FENCE-${mode}`);
      expect(await pinFailedObservedWorkspace(f.db, companyId, f.runId)).toBe(true);
      const original = (await f.db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
        eq(issueRecoveryActions.fingerprint, `native-workspace:${f.runId}`))))[0];
      expect(await pinFailedObservedWorkspace(f.db, companyId, f.runId)).toBe(true);
      expect((await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, original.id)))[0]).toEqual(original);
      const provider = getSandboxProvider("fake")!;
      const stop = mode === "lost_stop_ack" ? vi.spyOn(provider, "stopLease").mockRejectedValue(new Error("Controlled lost acknowledgement")) : null;
      const heartbeat = heartbeatService(f.db);
      try {
        await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
        expect(hasRemoteTerminationReceipt((await readSource(f)).lease)).toBe(mode !== "lost_stop_ack");
        if (mode === "generation") await f.db.update(nativeRunFinalizations).set({ controllerGeneration: 4 }).where(eq(nativeRunFinalizations.runId, f.runId));
        if (mode === "checkpoint") await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.profile, sessionCheckpoint: { ...f.checkpoint, activeTurnId: "changed" } } }).where(eq(heartbeatRuns.id, f.runId));
        if (mode === "workspace_authority") await f.db.update(executionWorkspaces).set({ metadata: sql`jsonb_set(${executionWorkspaces.metadata}, '{remoteWorkspace,epoch}', '0')` }).where(eq(executionWorkspaces.id, f.workspaceId));
        if (mode === "accepted_result") await acceptedResult(f);
        if (mode === "other_owner") await otherAllocationOwner(f);
        expect(await settleStoppedObservedWorkspace(f.db, companyId, f.runId)).toBe(false);
        expect(await pinFailedObservedWorkspace(f.db, companyId, f.runId)).toBe(mode === "lost_stop_ack");
        const current = (await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, original.id)))[0];
        expect(current.evidence.observedWorkspacePreservation).toEqual(original.evidence.observedWorkspacePreservation);
        expect((await readSource(f)).owner.phase).toBe("observed");
        expect(await readFile(path.join(f.remoteCwd, "saved.txt"), "utf8")).toBe("unfinished work with an unknown provider effect\n");
      } finally { await heartbeat.drainActiveRunExecutions(); stop?.mockRestore(); }
    });

  it("backs off a real cleanup producer conflict only after rolling the preservation transaction back", async () => {
    const f = await seedSource("CLEANUP-ROW-BUSY"), entered = barrier(), release = barrier();
    const peer = f.db.transaction(async tx => {
      await environmentService(tx as unknown as typeof f.db).releaseLease(f.leaseId, "released", { cleanupStatus: "success" });
      entered.resolve(); await release.promise;
    });
    try {
      await entered.promise;
      await expect(pinFailedObservedWorkspace(f.db, companyId, f.runId)).rejects.toBeInstanceOf(ObservedWorkspacePreservationBusyError);
      expect((await readSource(f)).run.resultJson?.workspaceRestoreRecovery).toBeUndefined();
    } finally { release.resolve(); await peer; }
    expect(await pinFailedObservedWorkspace(f.db, companyId, f.runId)).toBe(false);
    await sourceHeld(f);
  });

});
