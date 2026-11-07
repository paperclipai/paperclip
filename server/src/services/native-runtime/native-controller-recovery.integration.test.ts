import { execFile, spawn } from "node:child_process";
import { nativeProviderRecoveryEvidence, nativeSessionFailureSourceCode, verifyRemoteRunnerReattachment } from "./native-session-executor.js";
import { readRemoteRunnerRecoveryError } from "./remote-runner-recovery-diagnostics.js";
import { nativeToolContractFingerprintForTarget, rebindNativeSessionCheckpoint } from "./native-session-resume.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentTaskSessions, agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, nativeRunnerCheckpoints } from "@paperclipai/db";
import { DurablePrpControlPlane, parseNativeExecutionInput, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { startRecoveryPostgres, recoveryPostgresSupport } from "../../__tests__/helpers/recovery-postgres.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { assertNativeRetainedSandboxBinding, createNativeControllerRecovery, deferNativeControllerRecovery, importNativeControllerRecovery, NativeControllerRecoveryWaitingError, NATIVE_RETAINED_OWNER_WAIT, resolveNativeControllerRecovery } from "./native-controller-recovery.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";
import { claimNativeRestartRecoveries } from "./native-restart-recovery.js";
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
    await expect(readSandbox()).resolves.toBeUndefined();
    await expect(inspect({ readControlState: () => ({ identity, commands: [{ status: "pending" }],
      committedEvents: [{ eventType: "run.terminal", envelope: identity }] }) })).rejects.toThrow(denied);
    const recovered = await inspect();
    expect(recovered.identity).toEqual(identity);
    expect(recovered.checkpoint).toBe(checkpoint);
    expect(recovered.reuseProcess).toBe(true);
    const claims = await claimNativeSessionResumptions({ db, runnerInstanceId: "successor", runIds: [runId], now: deadline });
    expect(claims).toHaveLength(1);
    expect(await claimNativeSessionResumptions({ db, runnerInstanceId: "duplicate", runIds: [runId], now: deadline })).toEqual([]);
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
