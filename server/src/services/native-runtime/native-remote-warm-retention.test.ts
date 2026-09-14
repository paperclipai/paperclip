import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { environmentService } from "../environments.js";
import { seedRemoteDispatchFixture } from "./remote-dispatch.test-fixture.js";
import { withNativeRemoteWarmRetention, type NativeRemoteWarmRetention } from "./native-remote-warm-retention.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { withRuntimeServiceLeaseLock } from "../runtime-services/retention.js";
import { adoptRemoteRunnerLease, assertNoNativeRunnerClosing, claimNativeRemoteIdleClose, nativeRemoteIdleStatus, nativeRemoteRetentionAuthority, nativeRemoteIdleReconnectionAdmitted, reconcileNativeRemoteIdleClosures, recordNativeRemoteIdleCheckpoint, settleNativeRemoteIdleReconnection } from "./remote-runner-recovery.js";
import { createNativeRemoteIdleLifecycle } from "./native-remote-idle-lifecycle.js";
import { createNativeRemoteIdleControls, createNativeRemoteIdleProcessControls } from "./native-remote-idle-controls.js";
import { createRemoteRunnerProcessLauncher } from "./remote-runner-process.js";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { currentNativeControllerIdentity, type NativeControllerIdentity } from "./native-restart-recovery.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { buildNativeHarnessBackupManifest } from "./native-session-executor.js";
import { createNativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import { createRemoteRunnerRecoveryControls } from "./remote-runner-recovery-controls.js";

describe("durable native warm-runner retention evidence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-warm-retention-")); process.env.PAPERCLIP_HOME = root;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = path.join(root, "runner-state");
    database = await startEmbeddedPostgresTestDatabase("paperclip-remote-warm-retention-db-"); db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    await database?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousStateDirectory === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR; else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Warm retention", issuePrefix: "W" + companyId.slice(0, 6) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Developer" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Same running app", status: "in_progress", assigneeAgentId: agentId, executionRunId: runId });
    const f = await seedRemoteDispatchFixture(db, { companyId, agentId, issueId, runId, hostCwd: path.join(root, runId, "workspace") });
    const execution = structuredClone(f.execution);
    execution.session.lifecyclePolicy = { mode: "warm", idleTimeoutMs: 300_000 };
    const runnerInstanceId = randomUUID();
    await db.update(heartbeatRuns).set({ runnerInstanceId, runnerProfileJson: { ...f.run.runnerProfileJson, nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const input = { execution, environmentLeaseId: f.lease.id, runnerInstanceId, sessionConfigDigest: "sha256:" + "c".repeat(64),
      runnerIdentity: { runId, runnerInstanceId, normalizedSessionId: f.native.normalizedSessionId, environmentLeaseId: randomUUID(),
        turnId: f.native.turnId, itemId: f.native.itemId, secret: "must-not-persist" },
      leaseOwner: f.claim.leaseOwner, attempt: 0, controllerGeneration: 1,
      controller: { bootId: "previous-boot", pid: 2_000_000_001, processStartedAt: new Date(0) } };
    const retention = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]!.metadata?.nativeWarmRunnerRetention as NativeRemoteWarmRetention | undefined;
    return { ...f, input, retention };
  }

  async function idleFixture(controller?: NativeControllerIdentity) {
    const f = await fixture();
    // Historical run leases do not prevent current idle control. Only a
    // membership change after the retention record was committed revokes it.
    const historicalRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: historicalRunId, companyId: f.companyId, agentId: f.agentId, status: "succeeded" });
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id, provider: "daytona", providerLeaseId: f.lease.providerLeaseId,
      heartbeatRunId: historicalRunId, status: "retained", createdAt: new Date(f.lease.createdAt.getTime() - 1) });
    f.input.controller = controller ?? await currentNativeControllerIdentity();
    await db.update(nativeRunFinalizations).set({ controllerBootId: f.input.controller.bootId, controllerPid: f.input.controller.pid,
      controllerProcessStartedAt: f.input.controller.processStartedAt }).where(eq(nativeRunFinalizations.runId, f.runId));
    await withNativeRemoteWarmRetention(db, f.input, async tx => {
      await tx.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    });
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ status: "done", executionRunId: null }).where(eq(issues.id, f.issueId));
    await environmentService(db).releaseLease(f.lease.id, "retained", { cleanupStatus: "success" });
    const proof = (await f.retention())!;
    const expectedRetention = { nonce: proof.nonce, bootId: proof.controller.bootId, pid: proof.controller.pid, processStartedAt: proof.controller.processStartedAt };
    const input = { companyId: f.companyId, runId: f.runId, environmentLeaseId: f.lease.id, expectedRetention, expectedOwner: proof.process.remoteProcessIdentity,
      operation: { action: "inspect" as const } };
    const methods = ["environmentRunProcessControl", "environmentRunnerRecovery", "environmentRunnerRecoveryExecute"];
    const call = vi.fn(async (id: string, method: string, params: Record<string, unknown>) => {
      expect(id).toBe(f.pluginId);
      expect(params).toMatchObject({ companyId: f.companyId, environmentId: f.environment.id, providerLeaseId: f.lease.providerLeaseId,
        owner: proof.process.remoteProcessIdentity, workspaceConnection: proof.process.workspaceConnection });
      expect(params).not.toHaveProperty("expectedRetention");
      expect(params).not.toHaveProperty("expectedController");
      if (method === "environmentRunProcessControl") return { state: (params.operation as { action: string }).action === "inspect" ? "running" : "signalled", workspaceConnection: proof.process.workspaceConnection };
      expect(method).toBe("environmentRunnerRecovery");
      expect(params).toMatchObject({ operation: "read_state", runId: f.runId, workspaceRoot: proof.process.workspaceRoot });
      return { state: "ready", workspaceConnection: proof.process.workspaceConnection, runnerState: { runId: f.runId, lifecycle: "ready" } };
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, getWorker: () => ({ supportedMethods: methods }), call } as unknown as PluginWorkerManager });
    const read = () => runtime.recoverRunner({ companyId: f.companyId, runId: f.runId, expectedProcess: proof.process, expectedRetention, operation: "read_state" });
    const signal = () => runtime.controlRunProcess({ ...input, operation: { action: "signal", signal: "SIGTERM" } });
    return { ...f, idleInput: input, proof, call, methods, runtime, read, signal };
  }

  async function checkpointFixture(controller: NativeControllerIdentity = { bootId: "retired-controller", pid: 2_000_000_001, processStartedAt: new Date(0) }, takeOver = false) {
    const f = await idleFixture(controller);
    const proof = takeOver ? await f.runtime.claimIdleRunnerController({ companyId: f.companyId, runId: f.runId,
      expectedProcess: f.proof.process, expectedRetention: f.idleInput.expectedRetention }) : f.proof;
    if (!proof) throw new Error("Fixture takeover failed");
    const binding = { companyId: f.companyId, runId: f.runId, expectedProcess: proof.process, expectedRetention: nativeRemoteRetentionAuthority(proof)! };
    const nonce = await claimNativeRemoteIdleClose(db, binding);
    if (!nonce) throw new Error("Fixture close admission failed");
    const sessionScopeId = f.runId, backupRoot = path.join(process.env.PAPERCLIP_RUNNER_STATE_DIR!, createHash("sha256").update(sessionScopeId).digest("hex"), "failover-backups/current");
    await mkdir(path.join(backupRoot, "runner"), { recursive: true });
    await mkdir(path.join(backupRoot, "codex-home"));
    const runnerPath = path.join(backupRoot, "runner/runner-state.json");
    await writeFile(runnerPath, JSON.stringify({ schema: "paperclip.runner.durable.state.v1", ...f.proof.runnerIdentity, lifecycle: "suspended" }));
    await writeFile(path.join(backupRoot, "codex-home/thread.jsonl"), "fixture provider state");
    const makeStamp = async () => {
      const manifest = buildNativeHarnessBackupManifest({ backupRoot, execution: f.input.execution, runnerInstanceId: f.proof.runnerInstanceId,
        sourceProviderLeaseId: f.lease.providerLeaseId!, providerSessionIdentity: { providerSessionId: "original-provider-session", providerBackendSessionId: "session-1", providerSessionIdentity: null } });
      const manifestPath = path.join(backupRoot, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest));
      return createNativeHarnessBackupStamp({ manifestPath, sessionScopeId, authorizedProviderLeaseId: f.lease.providerLeaseId!,
        normalizedSessionId: f.proof.normalizedSessionId, runnerInstanceId: f.proof.runnerInstanceId, completedAt: manifest.completedAt });
    };
    const stamp = await makeStamp();
    expect(await recordNativeRemoteIdleCheckpoint(db, binding, nonce, stamp)).toBe(true);
    const inspect = vi.fn(async () => ({ state: "exited" as const, workspaceConnection: f.proof.process.workspaceConnection }));
    const reconcile = () => withRuntimeServiceLeaseLock(db, f.lease, tx => reconcileNativeRemoteIdleClosures(tx, f.lease, inspect));
    return { ...f, binding, nonce, stamp, backupRoot, runnerPath, makeStamp, inspect, reconcile };
  }

  const idleBinding = (f: Awaited<ReturnType<typeof idleFixture>>) => ({ companyId: f.companyId, runId: f.runId,
    expectedProcess: f.proof.process, expectedRetention: f.idleInput.expectedRetention });
  const stoppedController = { bootId: "retired-controller", pid: 2_000_000_001, processStartedAt: new Date(0) };
  const reconnectionEvidence = { sessionScopeSha256: "1".repeat(64), checkpointSha256: "2".repeat(64), hostAuthoritySha256: "3".repeat(64) };

  it("stores only the non-secret supervisor settings needed by restart recovery", async () => {
    const f = await fixture();
    await withNativeRemoteWarmRetention(db, { ...f.input, supervisorEnvironment: { networkAccess: true,
      githubAuthenticationMode: "managed", credentialRunId: f.runId, token: "must-not-persist" } as never }, async tx => {
      await tx.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    });
    expect((await f.retention())!.supervisorEnvironment).toEqual({ networkAccess: true, githubAuthenticationMode: "managed", credentialRunId: f.runId });
    expect(JSON.stringify(await f.retention())).not.toContain("must-not-persist");
  });

  it.each(["network", "mode", "run"])("rejects invalid supervisor %s before recording retention", async cause => {
    const f = await fixture();
    const supervisorEnvironment = { networkAccess: cause === "network" ? "enabled" : true,
      githubAuthenticationMode: cause === "mode" ? "private-token" : "managed", credentialRunId: cause === "run" ? randomUUID() : f.runId };
    await expect(withNativeRemoteWarmRetention(db, { ...f.input, supervisorEnvironment } as never, async () => undefined)).rejects.toThrow("native_execution_ownership_unverified");
    expect(await f.retention()).toBeUndefined();
  });

  async function reconnectingFixture() {
    const f = await idleFixture(stoppedController);
    const claimed = await f.runtime.claimIdleRunnerController({ ...idleBinding(f), reconnectionEvidence });
    if (!claimed?.controllerTakeover?.reconnection) throw new Error("Fixture reconnection admission failed");
    const binding = { ...idleBinding(f), expectedRetention: nativeRemoteRetentionAuthority(claimed)! };
    const nonce = claimed.controllerTakeover.reconnection.nonce;
    const request = { ...binding, expectedIdleReconnectionNonce: nonce };
    const hold = () => withRuntimeServiceLeaseLock(db, f.lease, tx => assertNoNativeRunnerClosing(tx, f.lease));
    return { ...f, claimed, binding, nonce, request, hold };
  }

  it("holds an orphaned allocation when provider inspection cannot admit recovery", async () => {
    const f = await idleFixture(stoppedController);
    f.call.mockResolvedValue({ state: "unverified" } as never);
    expect(await f.runtime.claimIdleRunnerController({ ...idleBinding(f), reconnectionEvidence })).toBeNull();
    expect((await f.retention())!.controllerTakeover).toBeUndefined();
    await expect(withRuntimeServiceLeaseLock(db, f.lease, tx => assertNoNativeRunnerClosing(tx, f.lease))).rejects.toThrow("idle_recovery_pending");
  });

  it("admits a retained session supervised by this controller", async () => {
    const f = await idleFixture();
    await expect(withRuntimeServiceLeaseLock(db, f.lease, tx => assertNoNativeRunnerClosing(tx, f.lease))).resolves.toBeUndefined();
  });

  it("ignores a historical retention epoch superseded by another run lease", async () => {
    const f = await idleFixture(stoppedController);
    const successorId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: successorId, companyId: f.companyId, agentId: f.agentId, status: "succeeded" });
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id, provider: "daytona",
      providerLeaseId: f.lease.providerLeaseId, heartbeatRunId: successorId, status: "retained" });
    await expect(withRuntimeServiceLeaseLock(db, f.lease, tx => assertNoNativeRunnerClosing(tx, f.lease))).resolves.toBeUndefined();
  });

  it.each(["authority", "membership"])("holds an orphan with malformed %s evidence", async cause => {
    const f = await idleFixture(stoppedController), retention = structuredClone(f.proof);
    if (cause === "authority") retention.controller.pid = -1;
    else retention.allocationRunLeasesDigest = "unknown";
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, nativeWarmRunnerRetention: retention } }).where(eq(environmentLeases.id, f.lease.id));
    await expect(withRuntimeServiceLeaseLock(db, f.lease, tx => assertNoNativeRunnerClosing(tx, f.lease))).rejects.toThrow("idle_recovery_pending");
  });

  it("admits reconnection atomically, holding the allocation until supervision is installed", async () => {
    const f = await reconnectingFixture();
    const before = (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0];
    expect(f.claimed.controllerTakeover!.reconnection).toMatchObject({ state: "attaching", evidence: reconnectionEvidence,
      authorityNonce: f.binding.expectedRetention.nonce });
    expect(await nativeRemoteIdleStatus(db, f.binding)).toBe("recovering");
    expect(await nativeRemoteIdleReconnectionAdmitted(db, f.binding, f.nonce)).toBe(true);
    await expect(f.hold()).rejects.toThrow("idle_recovery_pending");
    expect(await claimNativeRemoteIdleClose(db, f.binding)).toBeNull();
    const lifecycle = await createNativeRemoteIdleLifecycle({ db, runtime: f.runtime, retention: f.claimed });
    f.call.mockClear();
    expect(await lifecycle.controls.inspect(f.proof.process.remoteProcessIdentity)).toBe("pending");
    expect(await f.runtime.recoverRunner({ ...f.binding, operation: "read_state" })).toEqual({ state: "unverified" });
    expect(f.call).not.toHaveBeenCalled();
    expect(await settleNativeRemoteIdleReconnection(db, f.binding, randomUUID(), "attached")).toBe(false);
    await expect(f.hold()).rejects.toThrow("idle_recovery_pending");
    expect(await settleNativeRemoteIdleReconnection(db, f.binding, f.nonce, "attached")).toBe(true);
    expect(await settleNativeRemoteIdleReconnection(db, f.binding, f.nonce, "attached")).toBe(true);
    expect(await settleNativeRemoteIdleReconnection(db, f.binding, f.nonce, "failed")).toBe(false);
    expect(await nativeRemoteIdleStatus(db, f.binding)).toBe("ready");
    await expect(f.hold()).resolves.toBeUndefined();
    expect(await lifecycle.controls.inspect(f.proof.process.remoteProcessIdentity)).toBe("running");
    expect((await f.retention())!.idleExpiresAt).toBe(f.proof.idleExpiresAt);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(before);
    const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    expect(audit.filter(entry => entry.action === "environment.runner_idle_reconnection_settled")).toHaveLength(1);
  });

  it("uses a separately fenced idle transport and revokes ingress when close begins", async () => {
    const f = await reconnectingFixture();
    f.call.mockImplementation(async (_id, method, params) => {
      expect(params).not.toHaveProperty("expectedRetention"); expect(params).not.toHaveProperty("expectedIdleReconnectionNonce");
      expect(params).not.toHaveProperty("reconnectionEvidence");
      if (method === "environmentRunProcessControl") return { state: "running", workspaceConnection: f.proof.process.workspaceConnection } as never;
      expect(method).toBe("environmentRunnerRecovery");
      return { state: "ready", workspaceConnection: f.proof.process.workspaceConnection,
        ...(params.operation === "ingress" ? { endpoint: { kind: "authenticated_websocket",
          websocketUrl: `wss://runner.daytona.test/api/runner/v1/connect/${f.runId}`, generation: "one",
          secretHeaders: [{ name: "X-Daytona-Preview-Token", value: "private-test-token" }] } }
          : { runnerState: { runId: f.runId, lifecycle: "ready" } }) } as never;
    });
    f.call.mockClear();
    const controls = createRemoteRunnerRecoveryControls({ companyId: f.companyId, runId: f.runId, process: f.proof.process, runtime: f.runtime,
      idle: { authority: f.binding.expectedRetention, reconnectionNonce: f.nonce, generation: f.claimed.controllerTakeover!.generation } });
    await expect(controls.nativeRunnerRecovery.isAlive()).rejects.toThrow("recovery_unverified");
    expect(() => controls.nativeRunnerRecovery.bindController({ leaseOwner: "old-active-controller", controllerGeneration: 1 })).toThrow("recovery_unverified");
    expect(f.call).not.toHaveBeenCalled();
    controls.nativeRunnerRecovery.bindController({ leaseOwner: `native-idle:${f.binding.expectedRetention.nonce}`, controllerGeneration: 1 });
    expect(await controls.nativeRunnerRecovery.isAlive()).toBe(true);
    expect(await controls.nativeRunnerRecovery.readState()).toMatchObject({ runId: f.runId });
    const endpoint = await controls.getRunnerIngressEndpoint({ leaseId: f.lease.id, port: 43127, path: `/api/runner/v1/connect/${f.runId}` });
    expect(endpoint.secretHeaders[0]!.value).toBe("private-test-token"); expect(JSON.stringify(endpoint)).not.toContain("private-test-token");
    const count = f.call.mock.calls.length;
    await expect(controls.execute({ command: "sh", args: ["-c", "exit 99"] })).rejects.toThrow("recovery_unverified");
    expect(await f.runtime.executeRecoveringRunner({ ...f.request, execution: { command: "sh" } })).toEqual({ state: "unverified" });
    expect(await f.runtime.controlRunProcess({ ...f.request, environmentLeaseId: f.lease.id, expectedOwner: f.proof.process.remoteProcessIdentity,
      operation: { action: "stop_group", signal: "SIGTERM" } } as never)).toEqual({ state: "unverified" });
    expect(f.call).toHaveBeenCalledTimes(count);
    expect(await settleNativeRemoteIdleReconnection(db, f.binding, f.nonce, "attached")).toBe(true);
    await endpoint.refresh();
    expect(await claimNativeRemoteIdleClose(db, f.binding)).toEqual(expect.any(String));
    const closedCount = f.call.mock.calls.length;
    await expect(endpoint.refresh()).rejects.toThrow("recovery_unverified");
    expect(await nativeRemoteIdleReconnectionAdmitted(db, f.binding, f.nonce)).toBe(false);
    expect(f.call).toHaveBeenCalledTimes(closedCount);
  });

  it("keeps a failed reconnect held after expiry and refuses an in-process retry or late success", async () => {
    const f = await reconnectingFixture();
    expect(await settleNativeRemoteIdleReconnection(db, f.binding, f.nonce, "failed")).toBe(true);
    expect(await settleNativeRemoteIdleReconnection(db, f.binding, f.nonce, "failed")).toBe(true);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const expiredAt = Date.now() - 300_000;
    await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, nativeWarmRunnerRetention: {
      ...(await f.retention())!, recordedAt: new Date(expiredAt - 300_000).toISOString(), idleExpiresAt: new Date(expiredAt).toISOString(),
    } } }).where(eq(environmentLeases.id, f.lease.id));
    await expect(f.hold()).rejects.toThrow("idle_recovery_pending");
    expect(await nativeRemoteIdleReconnectionAdmitted(db, f.binding, f.nonce)).toBe(false);
    expect(await settleNativeRemoteIdleReconnection(db, f.binding, f.nonce, "attached")).toBe(false);
    f.call.mockClear();
    expect(await f.runtime.claimIdleRunnerController({ ...f.binding, reconnectionEvidence })).toBeNull();
    expect(await f.runtime.claimIdleRunnerController(f.binding)).toBeNull();
    expect(await claimNativeRemoteIdleClose(db, f.binding)).toBeNull();
    expect(await f.runtime.recoverRunner({ ...f.request, operation: "ingress" })).toEqual({ state: "unverified" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each(["attaching", "failed"] as const)("recovers an interrupted %s epoch only after its real controller exits", async state => {
    const former = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>((resolveExit, reject) => { former.once("error", reject); former.once("exit", () => resolveExit()); });
    try {
      const birth = await readProcessStartedAt(former.pid!);
      if (!birth) throw new Error("Fixture controller birth unavailable");
      const f = await reconnectingFixture(), historical = structuredClone(f.claimed);
      // Seed the record left by a former server. The process is real; the
      // saved epoch is fixture data, not a claim that its PRP session attached.
      const takeover = historical.controllerTakeover!;
      takeover.authority = { nonce: randomUUID(), bootId: randomUUID(), pid: former.pid!, processStartedAt: birth };
      takeover.reconnection = { ...takeover.reconnection!, authorityNonce: takeover.authority.nonce, state,
        ...(state === "failed" ? { settledAt: new Date().toISOString() } : {}) };
      const oldBinding = { ...f.binding, expectedRetention: takeover.authority };
      const oldNonce = takeover.reconnection.nonce;
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, nativeWarmRunnerRetention: historical } }).where(eq(environmentLeases.id, f.lease.id));
      const evidence = { ...reconnectionEvidence, hostAuthoritySha256: "4".repeat(64) };
      f.call.mockClear();
      expect(await f.runtime.claimIdleRunnerController({ ...oldBinding, reconnectionEvidence: evidence })).toBeNull();
      expect(f.call).not.toHaveBeenCalled();
      former.kill("SIGTERM"); await exited;
      // A process-control-only claim must not erase the durable recovery hold.
      expect(await f.runtime.claimIdleRunnerController(oldBinding)).toBeNull();
      await expect(f.hold()).rejects.toThrow("idle_recovery_pending");
      const claimed = await f.runtime.claimIdleRunnerController({ ...oldBinding, reconnectionEvidence: evidence });
      expect(claimed!.controllerTakeover!.generation).toBe(2);
      expect(claimed!.controllerTakeover!.reconnection).toMatchObject({ state: "attaching", evidence });
      expect(claimed!.controllerTakeover!.reconnection!.nonce).not.toBe(oldNonce);
      expect(claimed!.idleExpiresAt).toBe(f.proof.idleExpiresAt);
      expect(f.call).toHaveBeenCalledOnce();
      await expect(f.hold()).rejects.toThrow("idle_recovery_pending");
      expect(await settleNativeRemoteIdleReconnection(db, oldBinding, oldNonce, "attached")).toBe(false);
      expect(await f.runtime.recoverRunner({ ...oldBinding, expectedIdleReconnectionNonce: oldNonce, operation: "ingress" })).toEqual({ state: "unverified" });
      expect(f.call).toHaveBeenCalledOnce();
      const binding = { ...f.binding, expectedRetention: nativeRemoteRetentionAuthority(claimed)! };
      expect(await settleNativeRemoteIdleReconnection(db, binding, claimed!.controllerTakeover!.reconnection!.nonce, "attached")).toBe(true);
      await expect(f.hold()).resolves.toBeUndefined();
    } finally { former.kill("SIGKILL"); await exited; }
  });

  it("publishes a single reconnection nonce for competing claims", async () => {
    const f = await idleFixture(stoppedController);
    const input = { ...idleBinding(f), reconnectionEvidence };
    const results = await Promise.all([f.runtime.claimIdleRunnerController(input), f.runtime.claimIdleRunnerController(input)]);
    expect(results.filter(Boolean)).toHaveLength(1); expect(f.call).toHaveBeenCalledOnce();
    const saved = (await f.retention())!.controllerTakeover!;
    expect(saved).toEqual(results.find(Boolean)!.controllerTakeover);
    expect(saved.reconnection?.state).toBe("attaching");
    await expect(withRuntimeServiceLeaseLock(db, f.lease, tx => assertNoNativeRunnerClosing(tx, f.lease))).rejects.toThrow("idle_recovery_pending");
  });

  it("holds allocation aliases while allowing a different company to proceed", async () => {
    const f = await reconnectingFixture();
    const alias = await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id,
      provider: "daytona", providerLeaseId: f.lease.providerLeaseId, heartbeatRunId: null, status: "retained" }).returning();
    await expect(withRuntimeServiceLeaseLock(db, alias[0]!, tx => assertNoNativeRunnerClosing(tx, alias[0]!))).rejects.toThrow("idle_recovery_pending");
    const other = await idleFixture(stoppedController);
    await expect(withRuntimeServiceLeaseLock(db, { ...other.lease, providerLeaseId: f.lease.providerLeaseId },
      tx => assertNoNativeRunnerClosing(tx, { ...other.lease, providerLeaseId: f.lease.providerLeaseId }))).resolves.toBeUndefined();
    expect(await nativeRemoteIdleReconnectionAdmitted(db, f.binding, f.nonce)).toBe(true);
  });

  it("does not settle or reuse ingress once a successor changes allocation membership", async () => {
    const f = await reconnectingFixture(), nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId, status: "running" });
    // Simulate an out-of-band membership change. Normal acquisition is held.
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id, provider: "daytona",
      providerLeaseId: f.lease.providerLeaseId, heartbeatRunId: nextRunId, status: "active" });
    expect(await nativeRemoteIdleStatus(db, f.binding)).toBe("superseded");
    expect(await nativeRemoteIdleReconnectionAdmitted(db, f.binding, f.nonce)).toBe(false);
    expect(await settleNativeRemoteIdleReconnection(db, f.binding, f.nonce, "attached")).toBe(false);
    f.call.mockClear();
    expect(await f.runtime.recoverRunner({ ...f.request, operation: "ingress" })).toEqual({ state: "unverified" });
    expect(f.call).not.toHaveBeenCalled();
    await expect(f.hold()).rejects.toThrow("idle_recovery_pending");
  });

  it.each(["missing_authority", "active_controller", "nonce", "company", "run", "process", "close_nonce"] as const)(
    "rejects %s reconnection capability before provider access", async cause => {
      const f = await reconnectingFixture(), request: Record<string, unknown> = structuredClone(f.request);
      if (cause === "missing_authority") delete request.expectedRetention;
      if (cause === "active_controller") request.expectedController = { leaseOwner: f.claim.leaseOwner, controllerGeneration: 1 };
      if (cause === "nonce") request.expectedIdleReconnectionNonce = randomUUID();
      if (cause === "company") request.companyId = randomUUID();
      if (cause === "run") request.runId = randomUUID();
      if (cause === "process") request.expectedProcess = { ...f.proof.process, pid: f.proof.process.pid + 1 };
      if (cause === "close_nonce") request.expectedIdleCloseNonce = randomUUID();
      f.call.mockClear();
      expect(await f.runtime.recoverRunner({ ...request, operation: "ingress" } as never)).toEqual({ state: "unverified" });
      expect(f.call).not.toHaveBeenCalled();
    });

  it.each(["scope", "checkpoint", "authority", "extra", "null"] as const)("rejects invalid %s reconnection evidence without taking ownership", async cause => {
    const f = await idleFixture(stoppedController), evidence = { ...reconnectionEvidence } as Record<string, unknown>;
    if (cause === "scope") evidence.sessionScopeSha256 = "foreign";
    if (cause === "checkpoint") delete evidence.checkpointSha256;
    if (cause === "authority") evidence.hostAuthoritySha256 = "a".repeat(65);
    if (cause === "extra") evidence.path = "/private-file";
    expect(await f.runtime.claimIdleRunnerController({ ...idleBinding(f), reconnectionEvidence: cause === "null" ? null : evidence } as never)).toBeNull();
    expect(f.call).not.toHaveBeenCalled(); expect(await f.retention()).toEqual(f.proof);
  });

  it.each(["state", "nonce", "authority", "evidence", "timestamp", "takeover"] as const)("holds malformed %s reconnection metadata", async cause => {
    const f = await reconnectingFixture(), retention = structuredClone(f.claimed), marker = retention.controllerTakeover!.reconnection!;
    if (cause === "state") marker.state = "unknown" as never;
    if (cause === "nonce") marker.nonce = "";
    if (cause === "authority") marker.authorityNonce = randomUUID();
    if (cause === "evidence") marker.evidence.checkpointSha256 = "invalid";
    if (cause === "timestamp") marker.settledAt = new Date().toISOString();
    if (cause === "takeover") { marker.state = "attached"; marker.settledAt = new Date().toISOString(); retention.controllerTakeover!.originNonce = randomUUID(); }
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, nativeWarmRunnerRetention: retention } }).where(eq(environmentLeases.id, f.lease.id));
    await expect(f.hold()).rejects.toThrow("idle_recovery_pending");
    expect(await nativeRemoteIdleStatus(db, f.binding)).toBe("unverified");
    expect(await settleNativeRemoteIdleReconnection(db, f.binding, f.nonce, "attached")).toBe(false);
    f.call.mockClear();
    expect(await f.runtime.recoverRunner({ ...f.request, operation: "ingress" })).toEqual({ state: "unverified" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("transfers idle control only after the real original controller exits, preserving finalization", async () => {
    const former = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>((resolveExit, reject) => { former.once("error", reject); former.once("exit", () => resolveExit()); });
    try {
      const birth = await readProcessStartedAt(former.pid!);
      if (!birth) throw new Error("Fixture controller birth unavailable");
      const f = await idleFixture({ bootId: randomUUID(), pid: former.pid!, processStartedAt: new Date(birth) });
      const binding = idleBinding(f);
      const before = (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0];
      expect(await f.runtime.claimIdleRunnerController(binding)).toBeNull(); expect(f.call).not.toHaveBeenCalled();
      former.kill("SIGTERM"); await exited;
      const claimed = await f.runtime.claimIdleRunnerController(binding);
      expect(claimed).toMatchObject({ ...f.proof, controllerTakeover: { version: 1, generation: 1, originNonce: f.proof.nonce } });
      expect(claimed!.controllerTakeover!.authority.nonce).not.toBe(f.proof.nonce);
      expect(f.call).toHaveBeenCalledOnce();
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(before);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.status).toBe("succeeded");
      // A stale owner loses both observation and signals, even when it still
      // has all the old process/connection/retention fields in memory.
      expect(await f.runtime.controlRunProcess(f.idleInput)).toEqual({ state: "unverified" });
      expect(await f.signal()).toEqual({ state: "unverified" });
      expect(await f.read()).toEqual({ state: "unverified" });
      expect(await claimNativeRemoteIdleClose(db, binding)).toBeNull();
      expect(f.call).toHaveBeenCalledOnce();
      const authority = nativeRemoteRetentionAuthority(claimed)!;
      const controls = await createNativeRemoteIdleControls({ companyId: f.companyId, runId: f.runId,
        retentionNonce: authority.nonce, process: f.proof.process, runtime: f.runtime });
      expect(await controls.isAlive()).toBe(true);
      expect(await controls.readState()).toMatchObject({ runId: f.runId, lifecycle: "ready" });
      expect(await controls.signal("SIGTERM")).toBe(true);
      const current = { ...binding, expectedRetention: authority };
      const count = f.call.mock.calls.length;
      expect(await f.runtime.claimIdleRunnerController(current)).toBeNull();
      expect(await f.runtime.recoverRunner({ ...current, operation: "ingress" })).toEqual({ state: "unverified" });
      expect(await f.runtime.executeRecoveringRunner({ ...current, execution: { command: "sh", args: ["-c", "exit 99"] } })).toEqual({ state: "unverified" });
      expect(f.call).toHaveBeenCalledTimes(count);
      const lifecycle = await createNativeRemoteIdleLifecycle({ db, runtime: f.runtime, retention: claimed! });
      expect(await lifecycle.status()).toBe("ready");
      expect(await claimNativeRemoteIdleClose(db, current)).toEqual(expect.any(String));
      expect(await lifecycle.status()).toBe("closing");
      const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
      expect(audit.filter(entry => entry.action === "environment.runner_idle_controller_recovered")).toHaveLength(1);
    } finally { former.kill("SIGKILL"); await exited; }
  });

  it("serializes competing idle claims without duplicate provider work or nonce publication", async () => {
    const f = await idleFixture(stoppedController);
    const claimed = await Promise.all([f.runtime.claimIdleRunnerController(idleBinding(f)), f.runtime.claimIdleRunnerController(idleBinding(f))]);
    expect(claimed.filter(Boolean)).toHaveLength(1); expect(f.call).toHaveBeenCalledOnce();
    expect((await f.retention())!.controllerTakeover?.authority).toEqual(claimed.find(Boolean)!.controllerTakeover!.authority);
  });

  it.each(["exited", "mismatch", "unverified", "wrong_connection", "provider_failure"] as const)(
    "leaves idle ownership unchanged after %s inspection", async result => {
      const f = await idleFixture(stoppedController);
      f.call.mockImplementationOnce(async () => {
        if (result === "provider_failure") throw new Error("Provider unavailable");
        return { state: result === "wrong_connection" ? "running" : result,
          workspaceConnection: result === "wrong_connection" ? { ...f.proof.process.workspaceConnection, fingerprint: "d".repeat(64) } : f.proof.process.workspaceConnection } as never;
      });
      expect(await f.runtime.claimIdleRunnerController(idleBinding(f))).toBeNull();
      expect(await f.retention()).toEqual(f.proof);
    });

  it.each(["company", "run", "nonce", "process", "finalizing", "closing", "successor", "invalid_takeover"] as const)(
    "rejects %s idle takeover before provider access", async cause => {
      const f = await idleFixture(stoppedController), binding = structuredClone(idleBinding(f));
      if (cause === "company") binding.companyId = randomUUID();
      if (cause === "run") binding.runId = randomUUID();
      if (cause === "nonce") binding.expectedRetention.nonce = randomUUID();
      if (cause === "process") binding.expectedProcess.pid += 1;
      if (cause === "finalizing") await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (cause === "closing") expect(await claimNativeRemoteIdleClose(db, binding)).toEqual(expect.any(String));
      if (cause === "successor") {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running" });
        await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id, provider: "daytona",
          providerLeaseId: f.lease.providerLeaseId, heartbeatRunId: runId, status: "active" });
      }
      if (cause === "invalid_takeover") {
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
        await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, nativeWarmRunnerRetention: { ...f.proof, controllerTakeover: { version: 9 } } } }).where(eq(environmentLeases.id, f.lease.id));
      }
      expect(await f.runtime.claimIdleRunnerController(binding)).toBeNull(); expect(f.call).not.toHaveBeenCalled();
    });

  it("rechecks retention after a provider observation instead of publishing stale authority", async () => {
    const f = await idleFixture(stoppedController);
    f.call.mockImplementationOnce(async () => {
      await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.runId));
      return { state: "running", workspaceConnection: f.proof.process.workspaceConnection } as never;
    });
    expect(await f.runtime.claimIdleRunnerController(idleBinding(f))).toBeNull();
    expect(await f.retention()).toEqual(f.proof);
  });

  it("does not recover a lost close while the replacement idle controller is still alive", async () => {
    const f = await checkpointFixture(stoppedController, true);
    expect(await f.reconcile()).toBe(0);
    expect(f.inspect).not.toHaveBeenCalled();
    expect(await nativeRemoteIdleStatus(db, f.binding)).toBe("closing");
    await expect(withRuntimeServiceLeaseLock(db, f.lease, tx => assertNoNativeRunnerClosing(tx, f.lease))).rejects.toThrow("idle_close_pending");
  });

  it("recovers a checkpointed close only after its real controller process exits", async () => {
    const controller = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>((resolveExit, reject) => { controller.once("error", reject); controller.once("exit", () => resolveExit()); });
    try {
      const startedAt = await readProcessStartedAt(controller.pid!);
      if (!startedAt) throw new Error("Fixture controller birth unavailable");
      const f = await checkpointFixture({ bootId: randomUUID(), pid: controller.pid!, processStartedAt: new Date(startedAt) });
      const before = (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0];
      expect(await f.reconcile()).toBe(0); expect(f.inspect).not.toHaveBeenCalled();
      controller.kill("SIGTERM"); await exited;
      expect(await f.reconcile()).toBe(1);
      expect(f.inspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.lease.id }), {
        owner: f.proof.process.remoteProcessIdentity, operation: { action: "inspect" }, workspaceConnection: f.proof.process.workspaceConnection,
      });
      expect(await nativeRemoteIdleStatus(db, f.binding)).toBe("closed");
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(before);
      await expect(withRuntimeServiceLeaseLock(db, f.lease, tx => assertNoNativeRunnerClosing(tx, f.lease))).resolves.toBeUndefined();
      expect(await f.reconcile()).toBe(0); expect(f.inspect).toHaveBeenCalledOnce();
      const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
      expect(audit.filter(entry => entry.action === "environment.runner_idle_close_recovered")).toHaveLength(1);
    } finally { controller.kill("SIGKILL"); await exited; }
  });

  it.each(["missing_checkpoint", "missing_backup", "corrupt_backup", "foreign_runner", "active_runner_state", "different_stamp", "controller_changed", "successor_lease"] as const)(
    "keeps %s close evidence fenced before calling the provider", async failure => {
      const f = await checkpointFixture();
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      const closure = lease!.metadata!.nativeWarmRunnerClose as Record<string, unknown>;
      if (failure === "missing_checkpoint") await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, nativeWarmRunnerClose: { ...closure, checkpoint: null } } }).where(eq(environmentLeases.id, f.lease.id));
      if (failure === "missing_backup") await rm(f.backupRoot, { recursive: true });
      if (failure === "corrupt_backup") await writeFile(f.runnerPath, "corrupt");
      if (failure === "foreign_runner" || failure === "active_runner_state") {
        await writeFile(f.runnerPath, JSON.stringify({ schema: "paperclip.runner.durable.state.v1", ...f.proof.runnerIdentity,
          ...(failure === "foreign_runner" ? { runId: randomUUID() } : {}), lifecycle: failure === "active_runner_state" ? "ready" : "suspended" }));
        const stamp = await f.makeStamp();
        // A valid digest of another epoch (or of active state) is insufficient.
        await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, nativeHarnessBackup: stamp,
          nativeWarmRunnerClose: { ...closure, checkpoint: { version: 1, stamp } } } }).where(eq(environmentLeases.id, f.lease.id));
      }
      if (failure === "different_stamp") await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, nativeHarnessBackup: { ...f.stamp, manifestSha256: "sha256:" + "0".repeat(64) } } }).where(eq(environmentLeases.id, f.lease.id));
      if (failure === "controller_changed") await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (failure === "successor_lease") {
        const nextRunId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId, status: "succeeded" });
        await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id,
          provider: "daytona", providerLeaseId: f.lease.providerLeaseId, heartbeatRunId: nextRunId, status: "retained" });
      }
      expect(await f.reconcile()).toBe(0); expect(f.inspect).not.toHaveBeenCalled();
      await expect(withRuntimeServiceLeaseLock(db, f.lease, tx => assertNoNativeRunnerClosing(tx, f.lease))).rejects.toThrow("idle_close_pending");
    });

  it.each(["running", "wrong_connection", "corrupt_checkpoint", "new_close", "controller_changed"] as const)(
    "rechecks %s after the recovery process inspection", async failure => {
      const f = await checkpointFixture();
      f.inspect.mockImplementation(async () => {
        if (failure === "corrupt_checkpoint") await writeFile(f.runnerPath, "changed after inspection began");
        if (failure === "controller_changed") await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.runId));
        if (failure === "new_close") {
          const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
          await db.update(environmentLeases).set({ metadata: { ...lease!.metadata,
            nativeWarmRunnerClose: { ...(lease!.metadata!.nativeWarmRunnerClose as Record<string, unknown>), nonce: randomUUID() } } }).where(eq(environmentLeases.id, f.lease.id));
        }
        return { state: failure === "running" ? "running" : "exited", workspaceConnection: failure === "wrong_connection"
          ? { ...f.proof.process.workspaceConnection, fingerprint: "0".repeat(64) } : f.proof.process.workspaceConnection } as never;
      });
      expect(await f.reconcile()).toBe(0); expect(f.inspect).toHaveBeenCalledOnce();
      await expect(withRuntimeServiceLeaseLock(db, f.lease, tx => assertNoNativeRunnerClosing(tx, f.lease))).rejects.toThrow("idle_close_pending");
    });

  it("binds checkpoint publication to the admitted close and exact suspended runner", async () => {
    const f = await checkpointFixture();
    expect(await recordNativeRemoteIdleCheckpoint(db, f.binding, randomUUID(), f.stamp)).toBe(false);
    expect(await recordNativeRemoteIdleCheckpoint(db, f.binding, f.nonce, { ...f.stamp, sourceProviderLeaseId: randomUUID() })).toBe(false);
    await writeFile(f.runnerPath, JSON.stringify({ schema: "paperclip.runner.durable.state.v1", ...f.proof.runnerIdentity, runId: randomUUID(), lifecycle: "suspended" }));
    expect(await recordNativeRemoteIdleCheckpoint(db, f.binding, f.nonce, await f.makeStamp())).toBe(false);
  });

  it("observes and signals the committed retained runner through dedicated provider methods without reopening a run lease", async () => {
    const f = await idleFixture();
    const controls = await createNativeRemoteIdleControls({ companyId: f.companyId, runId: f.runId,
      retentionNonce: f.proof.nonce, process: f.proof.process, runtime: f.runtime });
    const beforeLeases = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId));
    const beforeRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(await controls.isAlive()).toBe(true);
    expect(await controls.readState()).toMatchObject({ runId: f.runId });
    expect(await controls.signal("SIGTERM")).toBe(true);
    expect(f.call.mock.calls.map(call => call[1])).toEqual(["environmentRunProcessControl", "environmentRunnerRecovery", "environmentRunProcessControl"]);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId))).toEqual(beforeLeases);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toEqual(beforeRuns);
  });

  it("connects the live launcher to retained idle controls without generic execution after launch", async () => {
    const f = await idleFixture(), owner = f.proof.process.remoteProcessIdentity;
    const controls = await createNativeRemoteIdleProcessControls({ companyId: f.companyId, runId: f.runId,
      retentionNonce: f.proof.nonce, process: f.proof.process, runtime: f.runtime });
    const provider = f.call.getMockImplementation()!;
    let exited = false;
    f.call.mockImplementation(async (...args) => {
      const result = await provider(...args);
      if (args[1] === "environmentRunProcessControl") {
        if ((args[2].operation as { action: string }).action === "signal") exited = true;
        else if (exited) return { ...result, state: "exited" };
      }
      return result;
    });
    const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async call => {
      if (call.args?.[2] !== "paperclip-runner-launch") throw new Error("Idle monitor cannot execute ordinary commands");
      return { stdout: `paperclip-process-v1|${call.args[4]}|${owner.pid}|${owner.uid}|${owner.processGroupId}|${owner.bootId}|${owner.startTicks}\n`,
        stderr: "", exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: null };
    });
    const before = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId));
    let handle!: ReturnType<ReturnType<typeof createRemoteRunnerProcessLauncher>>;
    handle = createRemoteRunnerProcessLauncher({ target: { kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd: "/workspace" },
      runner: { execute }, processControls: controls, remoteBinary: "/runtime/runner", processIdentityPath: "/runtime/identity",
      stateDirectory: "/runtime/state", diagnosticsDirectory: "/runtime/diagnostics", runnerInstanceId: f.input.runnerInstanceId,
      onSpawn: async () => { expect(handle.child.kill("SIGTERM")).toBe(true); },
    })({ command: "runner", args: ["--runner-id", f.input.runnerInstanceId], cwd: "/workspace", environment: {} });
    await expect(handle.completion).resolves.toMatchObject({ stderr: "runner_remote_process_exited lifecycle=ready" });
    expect(execute).toHaveBeenCalledOnce();
    expect(f.call.mock.calls.map(call => call[1])).toEqual(["environmentRunProcessControl", "environmentRunProcessControl", "environmentRunnerRecovery"]);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId))).toEqual(before);
  });

  it("does not let this controller borrow the previous controller's retained authority", async () => {
    const f = await idleFixture();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(nativeRunFinalizations).set({ controllerBootId: "previous-controller" }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, nativeWarmRunnerRetention: {
      ...f.proof, controller: { ...f.proof.controller, bootId: "previous-controller" },
    } } }).where(eq(environmentLeases.id, f.lease.id));
    const controls = await createNativeRemoteIdleControls({ companyId: f.companyId, runId: f.runId,
      retentionNonce: f.proof.nonce, process: f.proof.process, runtime: f.runtime });
    await expect(controls.isAlive()).rejects.toThrow("idle_authority_unverified");
    await expect(controls.signal("SIGTERM")).rejects.toThrow("idle_authority_unverified");
    await expect(controls.readState()).rejects.toThrow("idle_authority_unverified");
    expect(f.call).not.toHaveBeenCalled();
  });

  it("waits for finalization before shutdown, fences acquisition and closes only after exact exit", async () => {
    const f = await idleFixture(), owner = f.proof.process.remoteProcessIdentity;
    const lifecycle = await createNativeRemoteIdleLifecycle({ db, runtime: f.runtime, retention: f.proof });
    await db.update(nativeRunFinalizations).set({ phase: "workspace_finalizing", leaseOwner: "native-finalizer:fixture" }).where(eq(nativeRunFinalizations.runId, f.runId));
    const close = vi.fn(async () => undefined);
    expect(await lifecycle.controls.inspect(owner)).toBe("pending");
    expect(await lifecycle.close(close)).toBe(false);
    await expect(lifecycle.execute({ command: "node", args: ["checkpoint"] })).rejects.toThrow("idle_authority_unverified");
    expect(close).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled();
    await db.update(nativeRunFinalizations).set({ phase: "committed", leaseOwner: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    let exited = false, closeNonce = "";
    const commandRequest = { companyId: f.companyId, runId: f.runId, expectedProcess: f.proof.process,
      expectedRetention: f.idleInput.expectedRetention, execution: { command: "node", args: ["checkpoint"] } };
    expect(await f.runtime.executeRecoveringRunner({ ...commandRequest, expectedIdleCloseNonce: randomUUID() })).toEqual({ state: "unverified" });
    const provider = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...args) => {
      if (args[1] === "environmentRunnerRecoveryExecute") {
        expect(args[2]).toMatchObject({ owner, workspaceConnection: f.proof.process.workspaceConnection,
          execution: { command: "node", args: ["checkpoint"], timeoutMs: 120_000 } });
        expect(args[2]).not.toHaveProperty("expectedIdleCloseNonce");
        return { state: "executed", workspaceConnection: f.proof.process.workspaceConnection,
          result: { exitCode: 0, timedOut: false, stdout: "saved", stderr: "" } };
      }
      const result = await provider(...args);
      return args[1] === "environmentRunProcessControl" && exited ? { ...result, state: "exited" } : result;
    });
    expect(await lifecycle.close(async () => {
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      closeNonce = (lease!.metadata?.nativeWarmRunnerClose as { nonce: string }).nonce;
      const calls = f.call.mock.calls.length;
      expect(await f.runtime.executeRecoveringRunner({ ...commandRequest, expectedIdleCloseNonce: randomUUID() })).toEqual({ state: "unverified" });
      expect(await f.runtime.executeRecoveringRunner({ ...commandRequest, expectedRetention: undefined, expectedIdleCloseNonce: closeNonce })).toEqual({ state: "unverified" });
      expect(f.call).toHaveBeenCalledTimes(calls);
      await expect(withRuntimeServiceLeaseLock(db, f.lease, tx => assertNoNativeRunnerClosing(tx, f.lease))).rejects.toThrow("idle_close_pending");
      expect(await lifecycle.controls.inspect(owner)).toBe("running");
      expect(await lifecycle.execute({ command: "node", args: ["checkpoint"], timeoutMs: 300_000 })).toMatchObject({ stdout: "saved", exitCode: 0 });
      exited = true;
    })).toBe(true);
    expect(await lifecycle.status()).toBe("closed");
    expect(await f.runtime.executeRecoveringRunner({ ...commandRequest, expectedIdleCloseNonce: closeNonce })).toEqual({ state: "unverified" });
    await expect(withRuntimeServiceLeaseLock(db, f.lease, tx => assertNoNativeRunnerClosing(tx, f.lease))).resolves.toBeUndefined();
    await expect(lifecycle.execute({ command: "node", args: ["checkpoint"] })).rejects.toThrow("idle_authority_unverified");
  });

  it.each(["callback_failure", "root_alive", "controller_changed"])("keeps an admitted %s shutdown fenced rather than expiring its claim", async failure => {
    const f = await idleFixture();
    const lifecycle = await createNativeRemoteIdleLifecycle({ db, runtime: f.runtime, retention: f.proof });
    await expect(lifecycle.close(async () => {
      if (failure === "callback_failure") throw new Error("checkpoint unavailable");
      if (failure === "controller_changed") await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.runId));
    })).rejects.toThrow();
    await expect(withRuntimeServiceLeaseLock(db, f.lease, tx => assertNoNativeRunnerClosing(tx, f.lease))).rejects.toThrow("idle_close_pending");
    const again = vi.fn(async () => undefined);
    await expect(lifecycle.close(again)).rejects.toThrow();
    expect(again).not.toHaveBeenCalled();
    await expect(lifecycle.execute({ command: "node" })).rejects.toThrow("idle_authority_unverified");
  });

  it("defers monitoring and refuses shutdown once a successor lease supersedes retained ownership", async () => {
    const f = await idleFixture(), nextRunId = randomUUID();
    const lifecycle = await createNativeRemoteIdleLifecycle({ db, runtime: f.runtime, retention: f.proof });
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId, status: "running" });
    await withRuntimeServiceLeaseLock(db, f.lease, async tx => {
      await assertNoNativeRunnerClosing(tx, f.lease);
      await tx.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id, provider: "daytona",
        providerLeaseId: f.lease.providerLeaseId, heartbeatRunId: nextRunId, status: "active" });
    });
    expect(await lifecycle.controls.inspect(f.proof.process.remoteProcessIdentity)).toBe("pending");
    const close = vi.fn(async () => undefined);
    expect(await lifecycle.close(close)).toBe(false);
    expect(close).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled();
    await expect(lifecycle.controls.signal(f.proof.process.remoteProcessIdentity, "SIGKILL")).rejects.toThrow("idle_authority_unverified");
    expect(f.call).not.toHaveBeenCalled();
  });

  it("rechecks shutdown after waiting for acquisition's allocation lock", async () => {
    const f = await idleFixture(), nextRunId = randomUUID();
    const binding = { companyId: f.companyId, runId: f.runId, expectedProcess: f.proof.process, expectedRetention: f.idleInput.expectedRetention };
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId, status: "running" });
    let pending: Promise<string | null> | undefined;
    try {
      await withRuntimeServiceLeaseLock(db, f.lease, async tx => {
        pending = claimNativeRemoteIdleClose(db, binding);
        const key = `runtime-service-allocation:${f.companyId}:daytona:${f.lease.providerLeaseId}`;
        await vi.waitFor(async () => {
          const rows = await db.execute(sql`select exists(select 1 from pg_locks where locktype = 'advisory' and not granted
            and objid::bigint = (hashtext(${key})::bigint & 4294967295::bigint)) as waiting`);
          expect(rows[0]?.waiting).toBe(true);
        }, { timeout: 5000, interval: 10 });
        await tx.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id, provider: "daytona",
          providerLeaseId: f.lease.providerLeaseId, heartbeatRunId: nextRunId, status: "active" });
      });
      expect(await pending).toBeNull();
      expect(await nativeRemoteIdleStatus(db, binding)).toBe("superseded");
    } finally { await pending; }
  });

  it("does not grant ingress, generic execution, group termination or an active controller capability while idle", async () => {
    const f = await idleFixture();
    const recovery = { companyId: f.companyId, runId: f.runId, expectedProcess: f.proof.process, expectedRetention: f.idleInput.expectedRetention };
    expect(await f.runtime.recoverRunner({ ...recovery, operation: "ingress" })).toEqual({ state: "unverified" });
    expect(await f.runtime.executeRecoveringRunner({ ...recovery, execution: { command: "sh", args: ["-c", "echo not-authorized"] } })).toEqual({ state: "unverified" });
    expect(await f.runtime.controlRunProcess({ ...f.idleInput, operation: { action: "stop_group" } })).toEqual({ state: "unverified" });
    expect(await f.runtime.controlRunProcess({ ...f.idleInput, expectedController: { leaseOwner: f.input.leaseOwner, controllerGeneration: 1 } })).toEqual({ state: "unverified" });
    expect(await f.runtime.controlRunProcess({ ...f.idleInput, expectedRetention: undefined })).toEqual({ state: "unverified" });
    const inspect = vi.fn(async () => ({ state: "running" as const, workspaceConnection: f.proof.process.workspaceConnection }));
    expect(await adoptRemoteRunnerLease(db, { companyId: f.companyId, runId: f.runId, agentId: f.agentId, issueId: f.issueId,
      environmentId: f.environment.id, executionWorkspaceId: f.workspace.id, taskWorkspaceId: null,
      configurationDigest: f.proof.process.configurationDigest, pluginId: f.pluginId, expectedProcess: f.proof.process,
      expectedRetention: f.idleInput.expectedRetention } as Parameters<typeof adoptRemoteRunnerLease>[1], inspect)).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each(["nonce", "boot", "pid", "birth", "generation", "attempt", "finalization", "unfinished", "profile", "session", "runner", "kernel", "connection", "lease", "digest_missing", "deleting", "unsupported"] as const)(
    "rejects idle %s drift before invoking the provider", async cause => {
      const f = await idleFixture();
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      if (cause === "nonce") f.idleInput.expectedRetention.nonce = randomUUID();
      if (cause === "boot") f.idleInput.expectedRetention.bootId = "another-boot";
      if (cause === "pid") f.idleInput.expectedRetention.pid++;
      if (cause === "birth") f.idleInput.expectedRetention.processStartedAt = new Date(1).toISOString();
      if (cause === "generation") await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (cause === "attempt") await db.update(nativeRunFinalizations).set({ attempt: 1 }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (cause === "finalization") await db.update(nativeRunFinalizations).set({ phase: "workspace_finalizing" }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (cause === "unfinished") await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
      if (cause === "profile") await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: { ...f.input.execution, task: { ...f.input.execution.task, title: "changed" } } } }).where(eq(heartbeatRuns.id, f.runId));
      if (cause === "session") await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
      if (cause === "runner") await db.update(heartbeatRuns).set({ runnerInstanceId: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
      if (cause === "kernel") await db.update(heartbeatRuns).set({ processPid: 41 }).where(eq(heartbeatRuns.id, f.runId));
      if (cause === "connection") await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, runtimeServiceRunScope: null } }).where(eq(environmentLeases.id, f.lease.id));
      if (cause === "lease") await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, f.lease.id));
      if (cause === "digest_missing") await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, nativeWarmRunnerRetention: { ...f.proof, executionDigest: undefined } } }).where(eq(environmentLeases.id, f.lease.id));
      if (cause === "deleting") await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, runtimeServiceDataDeletionId: randomUUID() } }).where(eq(environmentLeases.id, f.lease.id));
      if (cause === "unsupported") f.methods.splice(0);
      // The deletion fence surfaces the existing explicit conflict.
      const result = await f.signal().catch(() => ({ state: "unverified" }));
      expect(result).toEqual({ state: "unverified" });
      expect(f.call).not.toHaveBeenCalled();
    },
  );

  it("withholds provider observations when the retained identity changes during the call", async () => {
    const f = await idleFixture();
    f.call.mockImplementationOnce(async () => {
      await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.runId));
      return { state: "running", workspaceConnection: f.proof.process.workspaceConnection };
    });
    expect(await f.runtime.controlRunProcess(f.idleInput)).toEqual({ state: "unverified" });
    expect(f.call).toHaveBeenCalledOnce();
  });

  it.each(["active", "retained", "released", "backdated"])("a successor %s run lease permanently supersedes the idle authority", async kind => {
    const f = await idleFixture(), nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId, status: "succeeded" });
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id, provider: "daytona", providerLeaseId: f.lease.providerLeaseId,
      heartbeatRunId: nextRunId, status: kind === "backdated" ? "active" : kind, createdAt: new Date(f.lease.createdAt.getTime() + (kind === "backdated" ? -1 : 1)) });
    expect(await f.signal()).toEqual({ state: "unverified" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("rechecks idle authority after waiting for the physical allocation lock", async () => {
    const f = await idleFixture();
    let pending: ReturnType<typeof f.signal> | undefined;
    try {
      await withRuntimeServiceLeaseLock(db, f.lease, async tx => {
        pending = f.signal();
        const key = `runtime-service-allocation:${f.companyId}:daytona:${f.lease.providerLeaseId}`;
        await vi.waitFor(async () => {
          const rows = await db.execute(sql`select exists(select 1 from pg_locks where locktype = 'advisory' and not granted
            and objid::bigint = (hashtext(${key})::bigint & 4294967295::bigint)) as waiting`);
          expect(rows[0]?.waiting).toBe(true);
        }, { timeout: 5000, interval: 10 });
        expect(f.call).not.toHaveBeenCalled();
        await tx.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.runId));
      });
      expect(await pending).toEqual({ state: "unverified" });
      expect(f.call).not.toHaveBeenCalled();
    } finally { await pending; }
  });

  it("completes an authorized idle signal before a waiting ownership change", async () => {
    const f = await idleFixture(), events: string[] = [];
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    f.call.mockImplementationOnce(async () => {
      events.push("signal"); entered(); await finish;
      return { state: "signalled", workspaceConnection: f.proof.process.workspaceConnection };
    });
    const pending = f.signal();
    let takeover: Promise<void> | undefined;
    try {
      await started;
      takeover = withRuntimeServiceLeaseLock(db, f.lease, async tx => {
        events.push("takeover");
        await tx.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.runId));
      });
      const key = `runtime-service-allocation:${f.companyId}:daytona:${f.lease.providerLeaseId}`;
      await vi.waitFor(async () => {
        const rows = await db.execute(sql`select exists(select 1 from pg_locks where locktype = 'advisory' and not granted
          and objid::bigint = (hashtext(${key})::bigint & 4294967295::bigint)) as waiting`);
        expect(rows[0]?.waiting).toBe(true);
      }, { timeout: 5000, interval: 10 });
      expect(events).toEqual(["signal"]);
      release();
      expect(await pending).toMatchObject({ state: "signalled" });
      await takeover;
      expect(events).toEqual(["signal", "takeover"]);
      expect(await f.signal()).toEqual({ state: "unverified" });
      expect(f.call).toHaveBeenCalledOnce();
    } finally { release(); await Promise.allSettled([pending, takeover]); }
  });

  it("records process, connection, session and controller before releasing the run lease, and survives later lease retention", async () => {
    const f = await fixture();
    const released = await withNativeRemoteWarmRetention(db, f.input, async tx => {
      const [lease] = await tx.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      expect(lease!.metadata?.nativeWarmRunnerRetention).toMatchObject({ runId: f.runId, normalizedSessionId: f.native.normalizedSessionId });
      await tx.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
      return "released";
    });
    expect(released).toBe("released");
    const proof = (await f.retention())!;
    expect(proof).toMatchObject({ version: 1, runId: f.runId, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      runnerInstanceId: f.input.runnerInstanceId, sessionConfigDigest: f.input.sessionConfigDigest,
      runnerIdentity: { environmentLeaseId: f.input.runnerIdentity.environmentLeaseId, turnId: f.native.turnId, itemId: f.native.itemId },
      process: f.claim.kind === "reattach_existing_runner" ? f.claim.process : null,
      controller: { leaseOwner: f.claim.leaseOwner, attempt: 0, generation: 1, bootId: f.input.controller.bootId } });
    expect(proof.nonce).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(proof)).not.toContain("must-not-persist");
    expect(proof.runnerIdentity.environmentLeaseId).not.toBe(proof.process.environmentLeaseId);
    expect(Date.parse(proof.idleExpiresAt) - Date.parse(proof.recordedAt)).toBe(300_000);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    await environmentService(db).releaseLease(f.lease.id, "retained", { cleanupStatus: "success" });
    expect(await f.retention()).toEqual(proof);
  });

  it("rolls back the retention record if coordinator release fails", async () => {
    const f = await fixture();
    await expect(withNativeRemoteWarmRetention(db, f.input, async () => { throw new Error("release lost"); })).rejects.toThrow("release lost");
    expect(await f.retention()).toBeUndefined();
    const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(owner!.leaseOwner).toBe(f.claim.leaseOwner);
  });

  it.each(["company", "session", "runner", "wire_run", "wire_turn", "profile", "per_turn", "controller", "generation", "birth", "expired", "attempt", "lease", "process", "connection", "task", "deleting"] as const)(
    "does not publish retention or release ownership for %s drift", async cause => {
      const f = await fixture();
      if (cause === "company") f.input.execution.binding.companyId = randomUUID();
      if (cause === "session") f.input.execution.session.normalizedSessionId = randomUUID();
      if (cause === "runner") f.input.runnerInstanceId = randomUUID();
      if (cause === "profile") await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, f.runId));
      if (cause === "per_turn") f.input.execution.session.lifecyclePolicy = { mode: "per_turn", idleTimeoutMs: null };
      if (cause === "wire_run") f.input.runnerIdentity.runId = randomUUID();
      if (cause === "wire_turn") f.input.runnerIdentity.turnId = "";
      if (cause === "controller") f.input.leaseOwner = "other-controller";
      if (cause === "generation") f.input.controllerGeneration = 2;
      if (cause === "birth") f.input.controller.processStartedAt = new Date(1);
      if (cause === "expired") await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
      if (cause === "attempt") f.input.attempt = 1;
      if (cause === "lease") await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, f.lease.id));
      if (cause === "process") await db.update(heartbeatRuns).set({ processPid: 41 }).where(eq(heartbeatRuns.id, f.runId));
      if (cause === "connection") await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, runtimeServiceRunScope: null } }).where(eq(environmentLeases.id, f.lease.id));
      if (cause === "task") await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
      if (cause === "deleting") await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, runtimeServiceDataDeletionId: randomUUID() } }).where(eq(environmentLeases.id, f.lease.id));
      const release = vi.fn(async () => true);
      await expect(withNativeRemoteWarmRetention(db, f.input, release)).rejects.toThrow();
      expect(release).not.toHaveBeenCalled();
      expect(await f.retention()).toBeUndefined();
    },
  );
});
