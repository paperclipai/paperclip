import { execFile, spawn } from "node:child_process";
import { nativeProviderRecoveryEvidence, nativeSessionFailureSourceCode, restoreRemoteSuspendedRunnerCheckpoint,
  verifyRemoteRunnerReattachment } from "./native-session-executor.js";
import { readRemoteRunnerRecoveryError } from "./remote-runner-recovery-diagnostics.js";
import { nativeToolContractFingerprintForTarget, rebindNativeSessionCheckpoint } from "./native-session-resume.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentTaskSessions, agents, companies, createDb, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, nativeRunnerCheckpoints } from "@paperclipai/db";
import { DurablePrpControlPlane, parseNativeExecutionInput, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { startRecoveryPostgres, recoveryPostgresSupport } from "../../__tests__/helpers/recovery-postgres.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { assertNativeRetainedSandboxBinding, createNativeControllerRecovery, deferNativeControllerRecovery, deferNativeRunForBusyAgentDirectory, NATIVE_AGENT_DIRECTORY_BUSY_WAIT, importNativeControllerRecovery, NativeControllerRecoveryWaitingError, NATIVE_RETAINED_OWNER_WAIT, resolveNativeControllerRecovery } from "./native-controller-recovery.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";
import { claimNativeRestartRecoveries } from "./native-restart-recovery.js";
import { AgentDirectoryPreparationDeferral, deferRunForBusyAgentDirectory, prepareWithAgentDirectoryDeferral } from "../heartbeat/agent-directory-busy.js";
import { AgentDirectoryOperationBusyError } from "../agent-directory-working-copies.js";
import { readNativeControllerRecoveryInventory } from "./native-controller-recovery-inventory.js";
import { inspectRemoteWarmSessionRecovery } from "./remote-warm-session-recovery.js";

describe.skipIf(!recoveryPostgresSupport.supported)("native controller durable discovery and import", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let home: ReturnType<typeof createIsolatedTestHome>;
  let root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const companyId = randomUUID(), agentId = randomUUID();
  const compatibility = { configDigest: `sha256:${"a".repeat(64)}`, processConfigDigest: null };
  beforeAll(async () => {
    home = createIsolatedTestHome();
    process.env.PAPERCLIP_HOME = home.home;
    root = await mkdtemp(join(tmpdir(), "native-controller-discovery-"));
    database = await startRecoveryPostgres("native-controller-discovery-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Controller discovery", issuePrefix: "NCD" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
  }, 60_000);
  afterAll(async () => {
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    home?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
  });

  async function seed() {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue retained execution", assigneeAgentId: agentId, status: "in_progress" });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId }).returning();
    const native = await prepareNativeHeartbeatRun({ db, run, issue: { id: issueId, title: "Continue retained execution", description: null, reviewPolicy: null }, environmentLeaseId: randomUUID() });
    const owner = { companyId, issueId, runId, authorityRunId: runId, bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed", controllerBootId: owner.bootId,
      controllerGeneration: 1, leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const core = new DurablePrpControlPlane({ stateDirectory: join(root, runId),
      identity: { runId, normalizedSessionId: native.normalizedSessionId, runnerInstanceId: native.runnerInstanceId,
        environmentLeaseId: native.environmentLeaseId, turnId: native.turnId, itemId: native.itemId },
      expectedRunnerVersion: "discovery-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    core.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
    await core.flushCheckpoint();
    await core.stop();
    const snapshot: PersistedNativeSession = { backendKind: "mock", sessionId: native.normalizedSessionId,
      identity: { companyId, agentId, issueId, runId, sessionId: native.normalizedSessionId } };
    const [prepared] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId,
      completionContractId: prepared.completionContractId!, serverFingerprint: "fixture", schemaStatus: "accepted",
      resultJson: {}, canonicalSha256: "fixture" }).returning();
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result.id, leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
    const profile = { ...prepared.runnerProfileJson, sessionCheckpoint: snapshot };
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), runnerProfileJson: profile }).where(eq(heartbeatRuns.id, runId));
    const scope = { companyId, agentId, issueId, runId, normalizedSessionId: native.normalizedSessionId };
    return { scope, native, profile, snapshot, owner,
      supervisor: { schema: "paperclip.native-session-supervisor.v1", ...compatibility, snapshot } };
  }

  it("imports a retained source once, rejects stale input, and resolves it without any local projection", async () => {
    const fixture = await seed();
    const input = { ...fixture.scope, expectedConfigDigest: compatibility.configDigest, supervisor: fixture.supervisor };
    expect(await importNativeControllerRecovery(db, { ...input, supervisor: { ...input.supervisor, snapshot: { ...fixture.snapshot, providerSessionId: "stale" } } }))
      .toEqual({ kind: "missing_evidence", reason: "stale_supervisor_snapshot" });
    expect(await importNativeControllerRecovery(db, input)).toEqual({ kind: "imported" });
    expect(await importNativeControllerRecovery(db, input)).toEqual({ kind: "unchanged" });
    await rm(join(root, fixture.scope.runId), { recursive: true });
    const currentRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: currentRunId, companyId, agentId, nativeIssueId: fixture.scope.issueId,
      nativeSessionId: fixture.scope.normalizedSessionId, status: "running", runtimeMode: "native" });
    const recovered = await resolveNativeControllerRecovery(db, { ...fixture.scope, currentRunId });
    expect(recovered.kind).toBe("recoverable");
    if (recovered.kind !== "recoverable") throw new Error(JSON.stringify(recovered));
    expect(recovered.snapshot).toEqual(fixture.snapshot);
    expect(recovered.checkpoint.recoveryEvidence.runnerInstanceId).toBe(fixture.native.runnerInstanceId);
    const deadline = new Date(Date.now() + 60_000);
    await db.update(nativeRunFinalizations).set({ leaseOwner: "other-controller", leaseExpiresAt: deadline }).where(eq(nativeRunFinalizations.runId, fixture.scope.runId));
    expect(await importNativeControllerRecovery(db, input)).toEqual({ kind: "waiting_for_owner", deadline });
    expect(await resolveNativeControllerRecovery(db, { ...fixture.scope, currentRunId })).toEqual({ kind: "waiting_for_owner", deadline });
  });

  it("does not assign current-run resume authority to a warm source that fails before attachment", async () => {
    const fixture = await seed(), runId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID();
    const remoteCwd = join(root, runId, "remote"), providerLeaseId = randomUUID();
    const previous = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
      binding: { companyId, agentId, issueId: fixture.scope.issueId, runId: fixture.scope.runId,
        executionWorkspaceId: randomUUID() },
      task: { identifier: "NCD-1", title: "Continue retained work", description: null,
        prompt: "Continue the saved work.", workMode: "standard" },
      workspace: { cwd: remoteCwd, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: fixture.scope.normalizedSessionId, driverKind: "codex_app_server",
        protocolVersion: 1, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } },
      completionContract: { id: randomUUID(), sha256: "fixture", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Continue the saved work", criteria: [{ id: "objective", requirement: "Save the result" }] } },
      credentialBindings: [], interactionResponses: [],
    });
    const current = { ...previous, binding: { ...previous.binding, runId } };
    const checkpoint: PersistedNativeSession = { ...fixture.snapshot, backendKind: "runner", driverKind: "codex_app_server",
      providerSessionId: "historical-provider-thread", sessionId: "historical-provider-thread", cursor: "prior-cursor",
      activeTurnId: null, terminal: null, terminalTurns: [], pendingRuntimeRequests: [] };
    const sourceProfile = { ...fixture.profile, nativeExecutionInput: previous, sessionCheckpoint: checkpoint,
      nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", "codex") };
    await db.update(heartbeatRuns).set({ runnerProfileJson: sourceProfile }).where(eq(heartbeatRuns.id, fixture.scope.runId));
    const rebound = rebindNativeSessionCheckpoint({ previousRun: { id: fixture.scope.runId, companyId, agentId,
      nativeSessionId: fixture.scope.normalizedSessionId, runnerProfileJson: sourceProfile }, currentExecution: current, executionTargetKind: "remote" });
    expect(rebound).toMatchObject({ providerSessionId: "historical-provider-thread", cursor: null, identity: { runId } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: fixture.scope.issueId,
      nativeSessionId: fixture.scope.normalizedSessionId, runnerInstanceId: randomUUID(), status: "running", runtimeMode: "native",
      runnerProfileJson: { nativeExecutionInput: current, sessionCheckpoint: rebound, nativePreparationFencingVersion: 1 } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: fixture.scope.issueId, runId, phase: "observed" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, fixture.scope.issueId));
    await db.insert(environments).values({ id: environmentId, name: runId, driver: "sandbox" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, issueId: fixture.scope.issueId,
      heartbeatRunId: fixture.scope.runId, provider: "daytona", providerLeaseId, status: "released", metadata: { remoteCwd } });
    const identity = { runId: fixture.scope.runId, normalizedSessionId: fixture.scope.normalizedSessionId,
      runnerInstanceId: fixture.native.runnerInstanceId, environmentLeaseId: fixture.native.environmentLeaseId,
      turnId: fixture.native.turnId, itemId: fixture.native.itemId };
    const runnerRoot = join(remoteCwd, ".paperclip-runtime", "paperclip-runner", "sessions",
      createHash("sha256").update(fixture.scope.normalizedSessionId).digest("hex"), "runner");
    await mkdir(runnerRoot, { recursive: true });
    await writeFile(join(runnerRoot, "runner-state.json"), JSON.stringify({ ...identity, lifecycle: "ready", outbox: [], pendingTerminalDelivery: null }));
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
    await writeFile(join(runnerRoot, "runner-process.identity"), `fixture-nonce\n${child.pid}\n${new Date().toISOString()}\n${identity.runnerInstanceId}\nlinux:abcd-1234:100\n`);
    const execute = (request: { command: string; args?: string[] }) => new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>(resolve => {
      execFile(request.command, request.args ?? [], { cwd: remoteCwd }, (error, stdout, stderr) => resolve({ stdout, stderr,
        exitCode: error ? typeof error.code === "number" ? error.code : 1 : 0, timedOut: false }));
    });
    const target = { kind: "remote", transport: "sandbox", environmentId, leaseId: randomUUID(), providerKey: "daytona",
      remoteCwd, sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId }, runner: { execute } } as const;
    await assertNativeRetainedSandboxBinding(db, { ...fixture.scope, target: target as never });
    const sourceClaim = { runId: fixture.scope.runId, remote: { providerLeaseId, remoteCwd } };
    const failure = await verifyRemoteRunnerReattachment({ claim: sourceClaim, target: target as never, identity,
      runId: fixture.scope.runId, normalizedSessionId: fixture.scope.normalizedSessionId }).catch(error => error);
    expect(readRemoteRunnerRecoveryError(failure)).toEqual({ stage: "process_verification", reason: "process_not_running",
      runnerLifecycle: "ready", runnerSettled: true });
    expect(nativeSessionFailureSourceCode(failure)).toBe("native_session_interrupted");
    await expect(verifyRemoteRunnerReattachment({ claim: { ...sourceClaim, runId }, target: target as never,
      identity, runId, normalizedSessionId: fixture.scope.normalizedSessionId }))
      .rejects.toThrow(new Error("native_remote_recovery_lease_mismatch: stage=runner_verification field=identity_run_id"));
    const recovery = await nativeProviderRecoveryEvidence({ db, runId, executionTargetKind: target.kind, sourceFailureCode: nativeSessionFailureSourceCode(failure) });
    expect(recovery).toMatchObject({ providerSessionEstablished: true, providerEventsExist: false, checkpointExists: true });
    expect(recovery.recoveryMode).toBe("ambiguous_state");
    const currentOwner = { companyId, issueId: fixture.scope.issueId, runId, authorityRunId: runId,
      bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await db.update(nativeRunFinalizations).set({ controllerBootId: currentOwner.bootId, controllerGeneration: 1,
      leaseOwner: currentOwner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, runId));
    const [currentRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const core = new DurablePrpControlPlane({ stateDirectory: join(root, runId, "current-controller"),
      identity: { ...identity, runId, runnerInstanceId: currentRun.runnerInstanceId! },
      expectedRunnerVersion: "discovery-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    core.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, currentOwner));
    try {
      await core.flushCheckpoint();
      expect(await nativeProviderRecoveryEvidence({ db, runId, executionTargetKind: target.kind, sourceFailureCode: nativeSessionFailureSourceCode(failure) }))
        .toMatchObject({ recoveryMode: "exact_checkpoint_resume", providerSessionEstablished: true, providerEventsExist: false });
      for (const field of ["nativeSessionId", "runnerInstanceId"] as const) {
        await db.update(heartbeatRuns).set({ [field]: randomUUID() }).where(eq(heartbeatRuns.id, runId));
        expect((await nativeProviderRecoveryEvidence({ db, runId, executionTargetKind: target.kind, sourceFailureCode: nativeSessionFailureSourceCode(failure) })).recoveryMode)
          .toBe("ambiguous_state");
        await db.update(heartbeatRuns).set({ [field]: currentRun[field] }).where(eq(heartbeatRuns.id, runId));
      }
    } finally { await core.stop(); }
    await db.update(nativeRunnerCheckpoints).set({ material: { invalid: true } }).where(eq(nativeRunnerCheckpoints.runId, runId));
    expect((await nativeProviderRecoveryEvidence({ db, runId, executionTargetKind: target.kind, sourceFailureCode: nativeSessionFailureSourceCode(failure) })).recoveryMode)
      .toBe("ambiguous_state");
    await db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, runId));
    expect(await nativeProviderRecoveryEvidence({ db, runId, metadataOnly: true,
      sourceFailureCode: nativeSessionFailureSourceCode(failure) })).toMatchObject({ recoveryMode: "exact_checkpoint_resume" });
    expect(JSON.parse(await readFile(join(root, runId, "current-controller", "control-plane-state.json"), "utf8")))
      .toMatchObject({ identity: { runId, normalizedSessionId: fixture.scope.normalizedSessionId, runnerInstanceId: currentRun.runnerInstanceId } });
    expect(await nativeProviderRecoveryEvidence({ db, runId, sourceFailureCode: nativeSessionFailureSourceCode(failure),
      executionTargetKind: "local" })).toMatchObject({ recoveryMode: "exact_checkpoint_resume", providerSessionEstablished: true });
  });

  it("retries a remote follow-up whose own server stopped serving before its runner, carrying only the predecessor session", async () => {
    // Daytona wave s9203: a graceful drain closed the runtime API listener while
    // a follow-up was still preparing. Its only checkpoint was the settled
    // predecessor's provider session, rebound at admission.
    const fixture = await seed(), runId = randomUUID();
    const checkpoint: PersistedNativeSession = { ...fixture.snapshot, backendKind: "runner", driverKind: "codex_app_server",
      providerSessionId: "predecessor-thread", sessionId: "predecessor-thread", cursor: "predecessor-cursor",
      activeTurnId: null, terminal: null, terminalTurns: [], pendingRuntimeRequests: [] };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...fixture.profile, sessionCheckpoint: checkpoint } })
      .where(eq(heartbeatRuns.id, fixture.scope.runId));
    const rebound = { ...checkpoint, cursor: null, identity: { ...checkpoint.identity, runId } };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: fixture.scope.issueId,
      nativeSessionId: fixture.scope.normalizedSessionId, runnerInstanceId: randomUUID(), status: "running", runtimeMode: "native",
      createdAt: new Date(Date.now() + 1_000),
      runnerProfileJson: { sessionCheckpoint: rebound, nativePreparationFencingVersion: 1 } });
    const evidence = (sourceFailureCode: Parameters<typeof nativeProviderRecoveryEvidence>[0]["sourceFailureCode"],
      executionTargetKind: "remote" | "local" = "remote") =>
      nativeProviderRecoveryEvidence({ db, runId, executionTargetKind, sourceFailureCode });
    expect(await evidence("local_runtime_api_listener_unavailable")).toMatchObject({ recoveryMode: "bootstrap_retry",
      providerSessionEstablished: false, providerEventsExist: false, checkpointExists: true });
    // Only this server's own shutdown proves the runner was never reached.
    expect((await evidence("provider_process_exited")).recoveryMode).toBe("ambiguous_state");
    // A provider session no settled predecessor saved could be this run's own.
    await db.update(heartbeatRuns).set({ runnerProfileJson: { sessionCheckpoint: { ...rebound, providerSessionId: "unknown-thread" },
      nativePreparationFencingVersion: 1 } }).where(eq(heartbeatRuns.id, runId));
    expect((await evidence("local_runtime_api_listener_unavailable")).recoveryMode).toBe("ambiguous_state");
    // A turn of this run is provider work, whatever stopped it.
    await db.update(heartbeatRuns).set({ runnerProfileJson: { sessionCheckpoint: { ...rebound, cursor: "own-turn" },
      nativePreparationFencingVersion: 1 } }).where(eq(heartbeatRuns.id, runId));
    expect((await evidence("local_runtime_api_listener_unavailable")).recoveryMode).toBe("ambiguous_state");
    await db.update(heartbeatRuns).set({ runnerProfileJson: { sessionCheckpoint: rebound, nativePreparationFencingVersion: 1 } })
      .where(eq(heartbeatRuns.id, runId));
    // Any Runner controller checkpoint of this run, even one whose identity
    // no longer matches the run, proves a Runner was reached.
    const core = new DurablePrpControlPlane({ stateDirectory: join(root, runId, "reached-runner"),
      identity: { runId, normalizedSessionId: fixture.scope.normalizedSessionId, runnerInstanceId: randomUUID(),
        environmentLeaseId: fixture.native.environmentLeaseId, turnId: fixture.native.turnId, itemId: fixture.native.itemId },
      expectedRunnerVersion: "discovery-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    const runnerOwner = { companyId, issueId: fixture.scope.issueId, runId, authorityRunId: runId,
      bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: fixture.scope.issueId, runId, phase: "observed",
      controllerBootId: runnerOwner.bootId, controllerGeneration: 1, leaseOwner: runnerOwner.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    core.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, runnerOwner));
    try {
      await core.flushCheckpoint();
      expect((await evidence("local_runtime_api_listener_unavailable")).recoveryMode).toBe("ambiguous_state");
    } finally { await core.stop(); }
    await db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, runId));
    expect((await evidence("local_runtime_api_listener_unavailable")).recoveryMode).toBe("bootstrap_retry");
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1, stream: "system", level: "info",
      eventType: "session.resumed" });
    expect((await evidence("local_runtime_api_listener_unavailable")).recoveryMode).toBe("ambiguous_state");
  });

  it("uses the database clock when an import finds an expired owner", async () => {
    const fixture = await seed();
    const now = Date.now();
    await db.update(nativeRunFinalizations).set({ leaseOwner: "expired-owner", leaseExpiresAt: new Date(now - 60_000) })
      .where(eq(nativeRunFinalizations.runId, fixture.scope.runId));
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now - 3_600_000);
    try {
      expect(await importNativeControllerRecovery(db, { ...fixture.scope, expectedConfigDigest: compatibility.configDigest,
        supervisor: fixture.supervisor })).toEqual({ kind: "missing_evidence", reason: "normal_ownership_recovery_required" });
    } finally { vi.useRealTimers(); }
  });

  it("holds mismatched snapshots and runner bindings instead of falling back to fresh execution", async () => {
    const fixture = await seed(), currentRunId = randomUUID();
    const metadata = createNativeControllerRecovery(fixture.snapshot, compatibility, { runId: fixture.scope.runId,
      runnerInstanceId: fixture.native.runnerInstanceId, normalizedSessionId: fixture.scope.normalizedSessionId });
    await db.insert(heartbeatRuns).values({ id: currentRunId, companyId, agentId, nativeIssueId: fixture.scope.issueId,
      nativeSessionId: fixture.scope.normalizedSessionId, status: "running", runtimeMode: "native" });
    for (const envelope of [{ ...metadata, snapshotSha256: "wrong" }, { ...metadata, checkpoint: { ...metadata.checkpoint!, runnerInstanceId: randomUUID() } }]) {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...fixture.profile, nativeControllerRecovery: envelope } }).where(eq(heartbeatRuns.id, fixture.scope.runId));
      expect(await resolveNativeControllerRecovery(db, { ...fixture.scope, currentRunId }))
        .toMatchObject({ kind: "missing_evidence", reason: "snapshot_digest_or_checkpoint_binding" });
    }
  });

  async function seedBusyDirectoryRun(input: { checkpoint?: boolean; resultJson?: Record<string, unknown> } = {}) {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Busy agent directory", assigneeAgentId: agentId, status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native",
      resultJson: input.resultJson ?? null,
      runnerProfileJson: { nativeExecutionInput: { binding: { companyId, agentId, issueId, runId } },
        ...(input.checkpoint ? { sessionCheckpoint: { backendKind: "mock", sessionId: randomUUID(), providerSessionId: "provider-session",
          identity: { companyId, agentId, issueId, runId } } } : {}) } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "retryable_failure", attempt: 3,
      failureDetail: { recoveryMode: "exact_checkpoint_resume", providerSessionEstablished: true, providerEventsExist: true } });
    const read = async () => (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0]!;
    const readRun = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
    return { issueId, runId, read, readRun };
  }

  it("defers a resumed run whose agent directory is busy across repeated claims and stops at the bound", async () => {
    const { runId, read, readRun } = await seedBusyDirectoryRun({ checkpoint: true });
    let now = new Date();
    for (let cycle = 1; cycle <= 3; cycle++) {
      const [claim] = await claimNativeSessionResumptions({ db, runnerInstanceId: "successor", runIds: [runId], now });
      expect(claim).toBeDefined();
      expect((await read()).failureDetail?.agentDirectoryBusyDeferrals).toBeUndefined();
      const retryAt = new Date(now.getTime() + 10_000);
      expect(await deferNativeRunForBusyAgentDirectory(db, { companyId, runId, leaseOwner: claim!.leaseOwner, retryAt, maxDeferrals: 3 })).toBe("deferred");
      expect(await read()).toMatchObject({ phase: "retryable_failure", attempt: 3, leaseOwner: null, nextAttemptAt: retryAt,
        failureCode: NATIVE_AGENT_DIRECTORY_BUSY_WAIT, failureDetail: { recoveryMode: "same_session_resume" } });
      expect(await readRun()).toMatchObject({ status: "running", errorCode: null, contextSnapshot: { agentDirectoryBusyDeferrals: cycle } });
      expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "successor", runIds: [runId], now })).toEqual([]);
      now = retryAt;
    }
    const [claim] = await claimNativeSessionResumptions({ db, runnerInstanceId: "successor", runIds: [runId], now });
    expect(await deferNativeRunForBusyAgentDirectory(db, { companyId, runId, leaseOwner: claim!.leaseOwner,
      retryAt: new Date(now.getTime() + 10_000), maxDeferrals: 3 })).toBe("refused");
    expect(await read()).toMatchObject({ phase: "observed", leaseOwner: claim!.leaseOwner });
  });

  it("leaves a busy-directory run to normal settlement after Stop, a lost lease or a moved task", async () => {
    const retryAt = new Date(Date.now() + 10_000);
    const stopped = await seedBusyDirectoryRun({ checkpoint: true });
    const [stoppedClaim] = await claimNativeSessionResumptions({ db, runnerInstanceId: "successor", runIds: [stopped.runId] });
    await db.update(heartbeatRuns).set({ resultJson: { cancellation: { source: "operator", expected: true, initiator: { type: "user", userId: "board" },
      reason: "Stopped", recordedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, stopped.runId));
    expect(await deferNativeRunForBusyAgentDirectory(db, { companyId, runId: stopped.runId, leaseOwner: stoppedClaim!.leaseOwner, retryAt, maxDeferrals: 30 })).toBe("refused");
    expect((await stopped.read()).nextAttemptAt).toBeNull();
    const foreign = await seedBusyDirectoryRun({ checkpoint: true });
    await claimNativeSessionResumptions({ db, runnerInstanceId: "successor", runIds: [foreign.runId] });
    expect(await deferNativeRunForBusyAgentDirectory(db, { companyId, runId: foreign.runId, leaseOwner: "another-controller", retryAt, maxDeferrals: 30 })).toBe("refused");
    const moved = await seedBusyDirectoryRun({ checkpoint: true });
    const [movedClaim] = await claimNativeSessionResumptions({ db, runnerInstanceId: "successor", runIds: [moved.runId] });
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, moved.issueId));
    expect(await deferNativeRunForBusyAgentDirectory(db, { companyId, runId: moved.runId, leaseOwner: movedClaim!.leaseOwner, retryAt, maxDeferrals: 30 })).toBe("refused");
    const fresh = randomUUID();
    await db.insert(heartbeatRuns).values({ id: fresh, companyId, agentId, status: "running", runtimeMode: "native" });
    expect(await deferNativeRunForBusyAgentDirectory(db, { companyId, runId: fresh, retryAt, maxDeferrals: 30 })).toBe("pre_admission");
  });

  it("defers only a busy agent directory met during preparation, never a busy collection after a turn", async () => {
    const { runId, read } = await seedBusyDirectoryRun({ checkpoint: true });
    const [claim] = await claimNativeSessionResumptions({ db, runnerInstanceId: "successor", runIds: [runId] });
    const schedule = vi.fn(), record = vi.fn(async () => undefined);
    const run = { id: runId, companyId };
    expect(await deferRunForBusyAgentDirectory(db, { run, error: new AgentDirectoryOperationBusyError(), leaseOwner: claim!.leaseOwner, schedule, record })).toBe("not_applicable");
    expect(await deferRunForBusyAgentDirectory(db, { run, error: new Error("unrelated"), leaseOwner: claim!.leaseOwner, schedule, record })).toBe("not_applicable");
    expect(schedule).not.toHaveBeenCalled();
    expect((await read()).phase).toBe("observed");
    const deferral = await prepareWithAgentDirectoryDeferral(async () => { throw new AgentDirectoryOperationBusyError(); }).catch(error => error);
    expect(deferral).toBeInstanceOf(AgentDirectoryPreparationDeferral);
    expect(deferral.message).toBe("Another run of this agent is still using its files");
    const started = Date.now();
    expect(await deferRunForBusyAgentDirectory(db, { run, error: deferral, leaseOwner: claim!.leaseOwner, schedule, record, random: () => 0.5 })).toBe("deferred");
    const [, retryAt] = schedule.mock.calls[0]! as [string, Date];
    expect(record).toHaveBeenCalledWith(retryAt);
    expect(retryAt.getTime() - started).toBeGreaterThanOrEqual(10_000);
    expect(retryAt.getTime() - started).toBeLessThan(11_000);
  });

  it("keeps an unstarted follow-up on the same run until the retained owner's deadline", async () => {
    const fixture = await seed(), runId = randomUUID();
    const scope = { ...fixture.scope, runId };
    const deadline = new Date(Date.now() + 60_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: scope.issueId,
      nativeSessionId: scope.normalizedSessionId, status: "running", runtimeMode: "native",
      // The admission boundary has already stored its input; the deferral
      // and resumption owners never execute this transport-independent fixture.
      runnerProfileJson: { nativeExecutionInput: { binding: scope } } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, scope.issueId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: scope.issueId, runId, phase: "observed" });
    await deferNativeControllerRecovery(db, { ...scope, retryAt: deadline });
    const read = () => db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect((await read())[0]).toMatchObject({ phase: "retryable_failure", attempt: 0, leaseOwner: null,
      nextAttemptAt: deadline, failureCode: NATIVE_RETAINED_OWNER_WAIT });
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "successor", runIds: [runId] })).toEqual([]);
    // Even after expiry, restart adoption cannot reinterpret this pre-provider
    // wait as a crashed provider. The ordinary resumption owner consumes it.
    expect(await claimNativeRestartRecoveries({ db, runIds: [runId], restartKind: "hard", now: deadline })).toEqual([]);
    const claims = await claimNativeSessionResumptions({ db, runnerInstanceId: "successor", runIds: [runId], now: deadline });
    expect(claims).toHaveLength(1);
    const nextDeadline = new Date(deadline.getTime() + 60_000);
    await deferNativeControllerRecovery(db, { ...scope, leaseOwner: claims[0].leaseOwner, retryAt: nextDeadline });
    expect((await read())[0]).toMatchObject({ attempt: 0, leaseOwner: null, nextAttemptAt: nextDeadline });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "successor", runIds: [runId], now: nextDeadline })).toEqual([]);
  });

  it.each(["committed", "workspace_finalizing"])("defers a remote warm continuation while its %s predecessor has a finalization lease", async phase => {
    const fixture = await seed(), runId = randomUUID(), environmentId = randomUUID();
    const previous = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
      binding: { companyId, agentId, issueId: fixture.scope.issueId, runId: fixture.scope.runId,
        executionWorkspaceId: randomUUID() },
      task: { identifier: "NCD-1", title: "Continue retained execution", description: null,
        prompt: "Continue the saved work.", workMode: "standard" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: fixture.scope.normalizedSessionId, driverKind: "codex_app_server",
        protocolVersion: 1, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } },
      completionContract: { id: randomUUID(), sha256: "fixture", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Continue the saved work.", criteria: [{ id: "objective", requirement: "Save the result." }] } },
      credentialBindings: [], interactionResponses: [],
    });
    const current = { ...previous, binding: { ...previous.binding, runId } };
    const checkpoint: PersistedNativeSession = { ...fixture.snapshot, driverKind: "codex_app_server",
      providerSessionId: "retained-provider-session", activeTurnId: null, pendingRuntimeRequests: [] };
    const metadata = createNativeControllerRecovery(checkpoint, compatibility, { runId: fixture.scope.runId,
      runnerInstanceId: fixture.native.runnerInstanceId, normalizedSessionId: fixture.scope.normalizedSessionId });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...fixture.profile, nativeExecutionInput: previous,
      sessionCheckpoint: checkpoint, nativeControllerRecovery: metadata } }).where(eq(heartbeatRuns.id, fixture.scope.runId));
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: fixture.scope.issueId,
      nativeSessionId: fixture.scope.normalizedSessionId, status: "running", runtimeMode: "native",
      runnerProfileJson: { nativeExecutionInput: current, sessionCheckpoint: { ...checkpoint,
        identity: { ...checkpoint.identity, runId } } } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: fixture.scope.issueId, runId, phase: "observed" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, fixture.scope.issueId));
    await db.insert(environments).values({ id: environmentId, name: `Retained ${environmentId}`, driver: "sandbox" });
    await db.insert(environmentLeases).values({ companyId, environmentId, issueId: fixture.scope.issueId,
      heartbeatRunId: fixture.scope.runId, provider: "daytona", providerLeaseId: "retained-sandbox", status: "released",
      metadata: { remoteCwd: "/workspace" } });
    const deadline = new Date(Date.now() + 60_000);
    await db.update(nativeRunFinalizations).set({ phase, leaseOwner: "finalizer", leaseExpiresAt: deadline,
      controllerPid: process.pid, controllerProcessStartedAt: new Date() }).where(eq(nativeRunFinalizations.runId, fixture.scope.runId));
    const identity = { runId: fixture.scope.runId, normalizedSessionId: fixture.scope.normalizedSessionId,
      runnerInstanceId: fixture.native.runnerInstanceId, environmentLeaseId: fixture.native.environmentLeaseId,
      turnId: fixture.native.turnId, itemId: fixture.native.itemId };
    const target = { kind: "remote", transport: "sandbox", environmentId, leaseId: randomUUID(), providerKey: "daytona",
      remoteCwd: "/workspace", sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "retained-sandbox" } } as const;
    const readSandbox = (override: Record<string, unknown> = {}) => assertNativeRetainedSandboxBinding(db,
      { ...fixture.scope, target: { ...target, ...override } as never });
    const inspect = (overrides: Partial<Parameters<typeof inspectRemoteWarmSessionRecovery>[0]> = {}) => inspectRemoteWarmSessionRecovery({ db, execution: current,
      target: target as never,
      identity, readControlState: () => ({ identity, commands: [{ type: "turn.start", status: "completed" }],
        committedEvents: [{ eventType: "run.terminal", envelope: identity }] }),
      matchesExecution: saved => saved.binding.runId === fixture.scope.runId,
      loadCheckpoint: () => checkpoint, canReuseProcess: () => true, ...overrides,
    });
    const denied = "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate";
    await expect(inspect({ execution: { ...current, binding: { ...current.binding, companyId: randomUUID() } } }))
      .rejects.toThrow(denied);
    await expect(inspect({ matchesExecution: () => false })).rejects.toThrow(denied);
    await expect(readSandbox({ remoteCwd: "/unrelated" })).rejects.toThrow("retained_sandbox_binding");
    for (const leaseExpiresAt of [null, new Date(Date.now() - 1_000)]) {
      await db.update(nativeRunFinalizations).set({ leaseExpiresAt }).where(eq(nativeRunFinalizations.runId, fixture.scope.runId));
      await expect(inspect()).rejects.toThrow(denied);
      await expect(readSandbox()).rejects.toThrow("retained_sandbox_binding");
    }
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: deadline }).where(eq(nativeRunFinalizations.runId, fixture.scope.runId));
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, fixture.scope.runId));
    await expect(inspect()).rejects.toThrow(denied);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, fixture.scope.runId));
    await expect(readSandbox()).rejects.toMatchObject({ retryAt: deadline });
    const waiting = await inspect().catch(error => error);
    expect(waiting).toBeInstanceOf(NativeControllerRecoveryWaitingError);
    expect(waiting.retryAt).toEqual(deadline);
    await deferNativeControllerRecovery(db, { ...current.binding, retryAt: waiting.retryAt });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0])
      .toMatchObject({ phase: "retryable_failure", attempt: 0, nextAttemptAt: deadline, resultId: null });
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "successor", runIds: [runId] })).toEqual([]);
    await db.update(nativeRunFinalizations).set({ phase: "committed", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, fixture.scope.runId));
    await expect(readSandbox()).resolves.toEqual({ remoteCwd: "/workspace" });
    await expect(inspect({ readControlState: () => ({ identity, commands: [{ status: "pending" }],
      committedEvents: [{ eventType: "run.terminal", envelope: identity }] }) })).rejects.toThrow(denied);
    // A created or replacement sandbox holds no Runner to adopt. Live adoption
    // steps aside so ordinary admission can retire the finished owner, instead
    // of denying with prior_owner_terminal_state_indeterminate (Nov 10 staging).
    for (const outcome of ["created", "replacement"] as const) {
      await expect(inspect({ target: { ...target, sandboxLeaseAcquisition: { outcome, providerLeaseId: "new-sandbox" } } as never }))
        .resolves.toBeNull();
    }
    const recovered = (await inspect())!;
    expect(recovered.identity).toEqual(identity);
    expect(recovered.checkpoint).toBe(checkpoint);
    expect(recovered.reuseProcess).toBe(true);
    const claims = await claimNativeSessionResumptions({ db, runnerInstanceId: "successor", runIds: [runId], now: deadline });
    expect(claims).toHaveLength(1);
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "duplicate", runIds: [runId], now: deadline })).toEqual([]);
  });

  // The Nov 10 staging shape: a preparation-only run's epoch was abandoned, so
  // the warm follow-up restored the last save into a new allocation of the same
  // sandbox. The committed source's Runner state stays in its own directory.
  it("binds a retained Runner read to the source's directory after the workspace moved within the same sandbox", async () => {
    const fixture = await seed(), environmentId = randomUUID(), workspaceId = randomUUID();
    const sourceLeaseId = randomUUID(), currentLeaseId = randomUUID(), providerLeaseId = randomUUID();
    const allocations = "/home/daytona/paperclip-workspace/.paperclip-workspaces";
    const sourceCwd = `${allocations}/${workspaceId}-1-${randomUUID()}`;
    const movedCwd = `${allocations}/${workspaceId}-6-${currentLeaseId}`;
    await db.insert(environments).values({ id: environmentId, name: `Moved ${environmentId}`, driver: "sandbox" });
    // Saved by the source run (status expired after its reusable handoff).
    await db.insert(environmentLeases).values({ id: sourceLeaseId, companyId, environmentId, issueId: fixture.scope.issueId,
      heartbeatRunId: fixture.scope.runId, provider: "daytona", providerLeaseId, status: "expired",
      leasePolicy: "reuse_by_environment", metadata: { remoteCwd: sourceCwd } });
    const target = { kind: "remote", transport: "sandbox", environmentId, leaseId: currentLeaseId, providerKey: "daytona",
      remoteCwd: movedCwd, sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId } } as const;
    const readSandbox = (override: Record<string, unknown> = {}) => assertNativeRetainedSandboxBinding(db,
      { ...fixture.scope, target: { ...target, ...override } as never });

    await expect(readSandbox()).resolves.toEqual({ remoteCwd: sourceCwd });
    await expect(readSandbox({ remoteCwd: sourceCwd })).resolves.toEqual({ remoteCwd: sourceCwd });
    // A root published under the exact workspace ID is the same workspace too.
    await expect(readSandbox({ remoteCwd: `${allocations}/${workspaceId}` })).resolves.toEqual({ remoteCwd: sourceCwd });
    const exactRoot = `${allocations}/${workspaceId}`;
    await db.update(environmentLeases).set({ metadata: { remoteCwd: exactRoot } }).where(eq(environmentLeases.id, sourceLeaseId));
    await expect(readSandbox()).resolves.toEqual({ remoteCwd: exactRoot });
    await db.update(environmentLeases).set({ metadata: { remoteCwd: sourceCwd } }).where(eq(environmentLeases.id, sourceLeaseId));
    // Strict checks stay strict: another workspace's allocation, another
    // parent, a non-canonical path or name, or another sandbox never bind.
    for (const remoteCwd of [`${allocations}/${randomUUID()}-6-${currentLeaseId}`, `/elsewhere/${workspaceId}-6-${currentLeaseId}`,
      `${allocations}/../.paperclip-workspaces/${workspaceId}-6-${currentLeaseId}`, `${allocations}/${workspaceId}-0-${currentLeaseId}`,
      `${allocations}/${workspaceId}-6-${currentLeaseId}-extra`, "/unrelated"]) {
      await expect(readSandbox({ remoteCwd })).rejects.toThrow("retained_sandbox_binding");
    }
    await expect(readSandbox({ sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: randomUUID() } }))
      .rejects.toThrow("retained_sandbox_binding");
  });

  // The same move, driven through the changed read with sandbox confinement:
  // the Runner command may touch only paths inside the sandbox's workspace base.
  it.each(["suspended", "ready"] as const)("reads a moved source's %s Runner state from its own directory through a confined sandbox", async lifecycle => {
    const fixture = await seed(), environmentId = randomUUID(), workspaceId = randomUUID(), runId = randomUUID();
    const providerLeaseId = randomUUID(), base = join(root, `sandbox-${runId}`, "paperclip-workspace");
    const sourceCwd = join(base, ".paperclip-workspaces", `${workspaceId}-1-${randomUUID()}`);
    const movedCwd = join(base, ".paperclip-workspaces", `${workspaceId}-6-${randomUUID()}`);
    await mkdir(movedCwd, { recursive: true });
    await db.insert(environments).values({ id: environmentId, name: `Confined ${environmentId}`, driver: "sandbox" });
    await db.insert(environmentLeases).values({ companyId, environmentId, issueId: fixture.scope.issueId,
      heartbeatRunId: fixture.scope.runId, provider: "daytona", providerLeaseId, status: "expired",
      leasePolicy: "reuse_by_environment", metadata: { remoteCwd: sourceCwd } });
    const identity = { runId: fixture.scope.runId, normalizedSessionId: fixture.scope.normalizedSessionId,
      runnerInstanceId: fixture.native.runnerInstanceId, environmentLeaseId: fixture.native.environmentLeaseId,
      turnId: fixture.native.turnId, itemId: fixture.native.itemId };
    const runnerDirectory = (cwd: string) => join(cwd, ".paperclip-runtime", "paperclip-runner", "sessions",
      createHash("sha256").update(fixture.scope.normalizedSessionId).digest("hex"), "runner");
    await mkdir(runnerDirectory(sourceCwd), { recursive: true });
    await writeFile(join(runnerDirectory(sourceCwd), "runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.v1",
      ...identity, lifecycle, outbox: [], pendingTerminalDelivery: null, pendingProviderCleanup: null, warmTransition: null }));
    const commands: string[] = [];
    const execute = (request: { command: string; args?: string[] }) => {
      const script = (request.args ?? []).join(" ");
      commands.push(script);
      // Provider confinement: nothing outside the sandbox's workspace base.
      const paths = script.match(/'(\/[^']*)'/g)?.map(path => path.slice(1, -1)) ?? [];
      if (paths.some(path => !path.startsWith(`${base}/`))) {
        return Promise.resolve({ stdout: "", stderr: "outside sandbox", exitCode: 126, timedOut: false });
      }
      return new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>(resolve => {
        execFile(request.command, request.args ?? [], { cwd: movedCwd }, (error, stdout, stderr) => resolve({ stdout, stderr,
          exitCode: error ? typeof error.code === "number" ? error.code : 1 : 0, timedOut: false }));
      });
    };
    const execution = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
      binding: { companyId, agentId, issueId: fixture.scope.issueId, runId, executionWorkspaceId: workspaceId },
      task: { identifier: "NCD-1", title: "Continue retained work", description: null,
        prompt: "Continue the saved work.", workMode: "standard" },
      workspace: { cwd: movedCwd, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: fixture.scope.normalizedSessionId, driverKind: "codex_app_server",
        protocolVersion: 1, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } },
      completionContract: { id: randomUUID(), sha256: "fixture", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Continue the saved work", criteria: [{ id: "objective", requirement: "Save the result" }] } },
      credentialBindings: [], interactionResponses: [],
    });
    // The controller already restored the committed source's durable checkpoint.
    const controller = join(root, `controller-${runId}`);
    await mkdir(join(controller, "control-plane"), { recursive: true });
    await writeFile(join(controller, "control-plane", "control-plane-state.json"),
      JSON.stringify({ schema: "paperclip.runner.durable.control-plane-state.v2", identity }));
    const target = { kind: "remote", transport: "sandbox", environmentId, leaseId: randomUUID(), providerKey: "daytona",
      remoteCwd: movedCwd, sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId }, runner: { execute } } as const;
    const restore = () => restoreRemoteSuspendedRunnerCheckpoint({ db, execution, runnerExecutionTarget: target as never }, controller);

    if (lifecycle === "suspended") {
      await restore();
      expect(commands.some(script => script.includes(runnerDirectory(sourceCwd)))).toBe(true);
      expect(commands.some(script => script.includes(movedCwd))).toBe(false);
      expect(JSON.parse(await readFile(join(controller, "plugin-runner-state.json"), "utf8")))
        .toMatchObject({ lifecycle: "suspended", ...identity });
    } else {
      // A Runner left in the abandoned allocation is never adopted live.
      await expect(restore()).rejects.toThrow("native_controller_recovery_missing_evidence:runner_not_settled");
      await expect(readFile(join(controller, "plugin-runner-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  // Nov 10 staging shape: a restart stopped the controller right after it sent
  // runner.suspend to an idle warm Runner. The Runner saved `suspended` with a
  // terminal fence for that result, which nobody acknowledged. The next warm
  // run resumed the same sandbox and directory and failed with runner_not_settled.
  it.each([
    { name: "undelivered suspend receipt", accepted: true },
    { name: "undelivered turn terminal", accepted: false, pending: { commandType: "turn.stop", lifecycle: "suspended" } },
    { name: "suspend receipt with provider cleanup", accepted: false, runner: { pendingProviderCleanup: { commandType: "runner.suspend" } } },
    { name: "suspend receipt with unsent events", accepted: false, runner: { outbox: [{ sourceSeq: 9 }] } },
    { name: "suspend receipt behind a later command", accepted: false, runner: { lastControllerCommandSeq: 8 } },
    { name: "journal names the command differently", accepted: false, journal: "turn.stop" },
    { name: "journal without the suspend command", accepted: false, journalCommands: [] },
    { name: "journal with a later command", accepted: false, laterCommand: true },
  ] as const)("reads a resumed sandbox's suspended Runner with an $name", async variant => {
    const fixture = await seed(), environmentId = randomUUID(), workspaceId = randomUUID(), runId = randomUUID();
    const providerLeaseId = randomUUID(), base = join(root, `sandbox-${runId}`, "paperclip-workspace");
    const cwd = join(base, ".paperclip-workspaces", `${workspaceId}-1-${randomUUID()}`);
    await mkdir(cwd, { recursive: true });
    await db.insert(environments).values({ id: environmentId, name: `Suspended ${environmentId}`, driver: "sandbox" });
    await db.insert(environmentLeases).values({ companyId, environmentId, issueId: fixture.scope.issueId,
      heartbeatRunId: fixture.scope.runId, provider: "daytona", providerLeaseId, status: "expired",
      leasePolicy: "reuse_by_environment", metadata: { remoteCwd: cwd } });
    const identity = { runId: fixture.scope.runId, normalizedSessionId: fixture.scope.normalizedSessionId,
      runnerInstanceId: fixture.native.runnerInstanceId, environmentLeaseId: fixture.native.environmentLeaseId,
      turnId: fixture.native.turnId, itemId: fixture.native.itemId };
    const runnerDirectory = join(cwd, ".paperclip-runtime", "paperclip-runner", "sessions",
      createHash("sha256").update(fixture.scope.normalizedSessionId).digest("hex"), "runner");
    const suspend = { commandId: randomUUID(), controllerSeq: 7 };
    await mkdir(runnerDirectory, { recursive: true });
    await writeFile(join(runnerDirectory, "runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.v1",
      ...identity, lifecycle: "suspended", outbox: [], lastControllerCommandSeq: 7,
      pendingTerminalDelivery: { ...suspend, commandType: "runner.suspend", lifecycle: "suspended", ...("pending" in variant ? variant.pending : {}) },
      pendingProviderCleanup: null, warmTransition: null, ...("runner" in variant ? variant.runner : {}) }));
    const execute = (request: { command: string; args?: string[] }) => {
      const script = (request.args ?? []).join(" ");
      const paths = script.match(/'(\/[^']*)'/g)?.map(path => path.slice(1, -1)) ?? [];
      if (paths.some(path => !path.startsWith(`${base}/`))) {
        return Promise.resolve({ stdout: "", stderr: "outside sandbox", exitCode: 126, timedOut: false });
      }
      return new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>(resolve => {
        execFile(request.command, request.args ?? [], { cwd }, (error, stdout, stderr) => resolve({ stdout, stderr,
          exitCode: error ? typeof error.code === "number" ? error.code : 1 : 0, timedOut: false }));
      });
    };
    const execution = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
      binding: { companyId, agentId, issueId: fixture.scope.issueId, runId, executionWorkspaceId: workspaceId },
      task: { identifier: "NCD-1", title: "Continue retained work", description: null,
        prompt: "Continue the saved work.", workMode: "standard" },
      workspace: { cwd, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: fixture.scope.normalizedSessionId, driverKind: "codex_app_server",
        protocolVersion: 1, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 900_000 } },
      completionContract: { id: randomUUID(), sha256: "fixture", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Continue the saved work", criteria: [{ id: "objective", requirement: "Save the result" }] } },
      credentialBindings: [], interactionResponses: [],
    });
    // The restored journal still holds the controller's unanswered suspend.
    const controller = join(root, `controller-${runId}`);
    await mkdir(join(controller, "control-plane"), { recursive: true });
    await writeFile(join(controller, "control-plane", "control-plane-state.json"), JSON.stringify({
      schema: "paperclip.runner.durable.control-plane-state.v2", identity,
      commands: "journalCommands" in variant ? variant.journalCommands : [
        { ...suspend, type: "journal" in variant ? variant.journal : "runner.suspend", status: "pending" },
        ...("laterCommand" in variant ? [{ commandId: randomUUID(), controllerSeq: 8, type: "turn.stop", status: "pending" }] : []),
      ] }));
    const target = { kind: "remote", transport: "sandbox", environmentId, leaseId: randomUUID(), providerKey: "daytona",
      remoteCwd: cwd, sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId }, runner: { execute } } as const;
    const restore = () => restoreRemoteSuspendedRunnerCheckpoint({ db, execution, runnerExecutionTarget: target as never }, controller);

    if (variant.accepted) {
      await restore();
      expect(JSON.parse(await readFile(join(controller, "plugin-runner-state.json"), "utf8")))
        .toEqual({ schema: "paperclip.runner.durable.state.v1", lifecycle: "suspended", ...identity });
    } else {
      await expect(restore()).rejects.toThrow("native_controller_recovery_missing_evidence:runner_not_settled");
      await expect(readFile(join(controller, "plugin-runner-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(["live-owner", "expired-owner", "provider-attempt", "stopped", "operator-stop"])("does not publish an admission wait after authority changes: %s", async scenario => {
    const fixture = await seed(), runId = randomUUID();
    const scope = { ...fixture.scope, runId };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: scope.issueId,
      status: scenario === "stopped" ? "cancelled" : "running", runtimeMode: "native",
      resultJson: scenario === "operator-stop" ? { cancellation: { source: "operator", expected: true,
        initiator: { type: "user" }, reason: "Stop", recordedAt: new Date().toISOString() } } : null,
      runnerProfileJson: { nativeExecutionInput: { binding: scope } } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, scope.issueId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: scope.issueId, runId, phase: "observed",
      attempt: scenario === "provider-attempt" ? 1 : 0,
      leaseOwner: scenario.endsWith("-owner") ? "other-controller" : null,
      leaseExpiresAt: scenario === "expired-owner" ? new Date(Date.now() - 1_000) : null });
    await expect(deferNativeControllerRecovery(db, { ...scope,
      leaseOwner: scenario === "expired-owner" ? "other-controller" : undefined,
      retryAt: new Date(Date.now() + 60_000) }))
      .rejects.toThrow("wait_authority_changed");
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0].phase).toBe("observed");
  });

  it("reports bounded retained-pointer coverage without loading historical payloads", async () => {
    const fixture = await seed();
    await importNativeControllerRecovery(db, { ...fixture.scope, expectedConfigDigest: compatibility.configDigest, supervisor: fixture.supervisor });
    await db.insert(agentTaskSessions).values([0, 1].map(index => ({ companyId, agentId, taskKey: `${fixture.scope.issueId}-${index}`,
      adapterType: "paperclip_runner", lastRunId: fixture.scope.runId })));
    const first = await readNativeControllerRecoveryInventory(db, { limit: 1 });
    expect(first).toMatchObject({ inspected: 1, coverage: "partial", truncated: true, selectedRetainedEvidence: 1, fullPayloadsValidated: false });
    const next = await readNativeControllerRecoveryInventory(db, { limit: 1, afterId: first.nextAfterId! });
    expect(next).toMatchObject({ inspected: 1, coverage: "partial", truncated: false, selectedRetainedEvidence: 1 });
  });
});
