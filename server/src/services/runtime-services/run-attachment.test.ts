import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, plugins, projects, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createRuntimeServiceSchema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { environmentRuntimeService } from "../environment-runtime.js";
import { environmentService } from "../environments.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { createRuntimeServiceManager } from "./manager.js";
import type { RuntimeServiceProvider } from "./provider.js";
import { prepareNativeHeartbeatRun } from "../native-runtime/prepare-native-run.js";
import { buildNativeExecutionInput } from "../native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import { withNativeRemoteWarmRetention } from "../native-runtime/native-remote-warm-retention.js";
import { claimNativeRemoteIdleClose, nativeRunnerAllocationLeaseDigest, recordNativeRemoteIdleCheckpoint } from "../native-runtime/remote-runner-recovery.js";
import { buildNativeHarnessBackupManifest } from "../native-runtime/native-session-executor.js";
import { createNativeHarnessBackupStamp } from "../native-runtime/native-harness-backup-stamp.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.daytona-attachment-test", apiVersion: 1, version: "1.0.0", displayName: "Daytona fixture", description: "Provider RPC contract fixture", author: "Paperclip",
  categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
  environmentDrivers: [{ driverKey: "daytona", kind: "sandbox_provider", displayName: "Daytona", supportsReusableLeases: true,
    configSchema: { type: "object", properties: { image: { type: "string" }, reuseLease: { type: "boolean" } } } }],
};

describe("agent run attachment to retained service workspaces", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const pluginId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-service-attachment-");
    db = createDb(database.connectionString);
    await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id, packageName: "@paperclipai/plugin-daytona", version: manifest.version,
      apiVersion: 1, categories: ["automation"], manifestJson: manifest, status: "ready", installOrder: 1 });
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(reuseLease = false) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Service attachment", issuePrefix: `S${companyId.slice(0, 6)}` });
    const [developer, reviewer] = await db.insert(agents).values([{ companyId, name: "Developer" }, { companyId, name: "Reviewer" }]).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "Retained app" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id, name: "App", mode: "isolated_workspace", strategyType: "git_worktree", cwd: "/workspace" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Develop app", executionWorkspaceId: workspace!.id, assigneeAgentId: developer!.id }).returning();
    const [environmentRow] = await db.insert(environments).values({ name: `Daytona ${companyId}`, driver: "sandbox", config: { provider: "daytona", image: "node:24", reuseLease } }).returning();
    const envs = environmentService(db);
    const environment = (await envs.getById(environmentRow!.id))!;
    const providerLeaseId: string = randomUUID();
    const token: string = randomUUID();
    const connectionFingerprint = "b".repeat(64);
    const taskWorkspaceOwnership = { version: 1, executionWorkspaceId: workspace!.id, createdByRunId: "", sandboxName: "original-task-sandbox" };
    const resume = vi.fn(async (params: Record<string, any>) => ({ providerLeaseId, metadata: {
      provider: "daytona", remoteCwd: "/workspace", shellCommand: "bash", workspaceConnection: params.workspaceConnection, taskWorkspaceOwnership: { ...taskWorkspaceOwnership },
      workspaceSentinel: { path: "/workspace/.paperclip-runtime/reusable-sandbox-lease.json", token, result: "matched" },
    } }));
    const call = vi.fn(async (_id: string, method: string, params: Record<string, any>) => {
      if (method === "environmentGetServiceConnection") return { fingerprint: connectionFingerprint };
      if (method === "environmentAcquireLease") { taskWorkspaceOwnership.createdByRunId = params.runId; return { providerLeaseId, metadata: {
        provider: "daytona", remoteCwd: "/workspace", shellCommand: "bash", workspaceConnection: params.workspaceConnection, taskWorkspaceOwnership: { ...taskWorkspaceOwnership },
        workspaceSentinel: { path: "/workspace/.paperclip-runtime/reusable-sandbox-lease.json", token, result: "written" },
      } }; }
      if (method === "environmentResumeLease") return resume(params);
      if (method === "environmentService") return { state: "retained", workspaceConnection: params.workspaceConnection };
      throw new Error(`Unexpected provider operation ${method}`);
    });
    const methods = ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentGetServiceConnection", "environmentService"];
    const worker = { isRunning: () => true, getWorker: () => ({ supportedMethods: methods }), call } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const newRun = async (agentId = reviewer!.id) => {
      await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issue!.id));
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: issue!.id, executionWorkspaceId: workspace!.id } }).returning();
      return run!;
    };
    const run = await newRun(developer!.id);
    const input = (currentRun = run) => ({ companyId, environment, issueId: issue!.id, agentId: currentRun.agentId, heartbeatRunId: currentRun.id,
      persistedExecutionWorkspace: { id: workspace!.id, mode: workspace!.mode as "isolated_workspace" }, adapterType: "paperclip_runner",
      runtimeServiceExecutionPolicy: { trustPreset: { kind: "standard" }, networkScope: "enabled" } });
    const first = (await runtime.acquireRunLease(input())).lease;
    const provider: RuntimeServiceProvider = { key: "daytona", capabilities: { dynamicPorts: true, preview: true, logs: true, preservesDataOnStop: true },
      async start(ctx) { return ctx.process; }, async inspect() { return { state: "running", endpoints: [] }; }, async stop() {}, async logs() { return ""; } };
    const manager = createRuntimeServiceManager(db, { providers: [provider] });
    const service = await manager.create(companyId, { type: "board", id: "operator" }, createRuntimeServiceSchema.parse({
      name: "App worker", purpose: "worker", issueId: issue!.id, command: "node app.cjs", start: false, requestId: randomUUID(),
    }), { provider: "daytona", reuseKey: providerLeaseId, environmentLeaseId: first.id, executionWorkspaceId: workspace!.id, cwd: "/workspace" });
    const finish = async (currentRun = run) => {
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, currentRun.id));
      await runtime.releaseRunLeases(currentRun.id, "released");
    };
    await finish();
    call.mockClear();
    return { companyId, environment, envs, workspace: workspace!, issue: issue!, run, first, providerLeaseId, runtime, resume, call, newRun, input, finish, service, methods };
  }

  it.each([false, true])("reattaches after reassignment with ordinary reuse=%s and keeps one lease on replay", async (reuse) => {
    const f = await fixture(reuse);
    const next = await f.newRun();
    const [attached, replay] = await Promise.all([f.runtime.acquireRunLease(f.input(next)), f.runtime.acquireRunLease(f.input(next))]);
    expect(attached.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(attached.lease.id).toBe(replay.lease.id);
    expect(attached.lease.metadata).toMatchObject({ agentId: next.agentId, sandboxLeaseAcquisition: { outcome: "resumed" },
      runtimeServiceRunScope: f.first.metadata!.runtimeServiceRunScope,
      taskWorkspaceOwnership: { version: 1, executionWorkspaceId: f.workspace.id, createdByRunId: f.run.id, sandboxName: "original-task-sandbox" },
      runtimeServiceAttachment: { allocationId: f.service.allocationId, executionWorkspaceId: f.workspace.id } });
    expect(f.call.mock.calls.map(([, method]) => method)).toEqual(["environmentResumeLease", "environmentResumeLease"]);
    const rows = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, f.companyId), eq(environmentLeases.heartbeatRunId, next.id)));
    expect(rows).toHaveLength(1);
    expect(await f.envs.getLeaseById(f.first.id)).toMatchObject({ status: "retained" });
  });

  it.each(["acquire", "release_compute"] as const)("recovers a lost idle-close completion through ordinary %s", async operation => {
    const f = await fixture();
    const stateBase = await mkdtemp(join(tmpdir(), "paperclip-idle-admission-"));
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    try {
      const [run] = await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.run.id)).returning();
      const [issue] = await db.update(issues).set({ status: "in_progress", executionRunId: f.run.id }).where(eq(issues.id, f.issue.id)).returning();
      const native = await prepareNativeHeartbeatRun({ db, run: run!, issue: issue!, environmentLeaseId: f.first.id });
      const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, f.issue.id));
      const execution = buildNativeExecutionInput({ companyId: f.companyId, runId: f.run.id, agentId: f.run.agentId,
        issue: { ...issue!, workMode: "standard" }, taskPrompt: "Continue this dev server", workspace: { id: f.workspace.id, cwd: f.workspace.cwd!, repoUrl: null, repoRef: null, branchName: null },
        normalizedSessionId: native.normalizedSessionId, provider: "codex", runtimeContext: nativeRuntimeContextFixture(),
        completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: contract!.schemaVersion,
          contract: contract!.contractJson as unknown as Parameters<typeof buildNativeExecutionInput>[0]["completionContract"]["contract"] } });
      execution.session.lifecyclePolicy = { mode: "warm", idleTimeoutMs: 300_000 };
      const identity = { runnerInstanceId: randomUUID(), environmentLeaseId: f.first.id, runId: f.run.id,
        normalizedSessionId: native.normalizedSessionId, turnId: native.turnId, itemId: native.itemId };
      const controller = { bootId: "retired-admission-controller", pid: 2_000_000_001, processStartedAt: new Date(0) };
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.first.id));
      const owner = { version: 1, pid: 40, processGroupId: 40, uid: 1000, bootId: randomUUID(), startTicks: "100" };
      await db.update(environmentLeases).set({ status: "active", releasedAt: null, metadata: { ...lease!.metadata,
        runtimeServiceBoundary: { version: 1, provider: "daytona", workspaceRoot: "/workspace" },
        runtimeServiceProcessOwner: { version: 1, provider: "daytona", environmentLeaseId: f.first.id, providerLeaseId: f.providerLeaseId,
          runId: f.run.id, workspaceRoot: "/workspace", process: owner },
      } }).where(eq(environmentLeases.id, f.first.id));
      const [prepared] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
      await db.update(heartbeatRuns).set({ processLocation: "remote", processPid: 40, processGroupId: null, processStartedAt: new Date(),
        runnerInstanceId: identity.runnerInstanceId, runnerProfileJson: { ...prepared!.runnerProfileJson, nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.run.id));
      await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issue.id, runId: f.run.id, phase: "observed",
        leaseOwner: "idle-admission-controller", leaseExpiresAt: new Date(Date.now() + 60_000), controllerGeneration: 1,
        controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt });
      const proof = await withNativeRemoteWarmRetention(db, { execution, environmentLeaseId: f.first.id, runnerInstanceId: identity.runnerInstanceId,
        runnerIdentity: identity, sessionConfigDigest: "sha256:" + "c".repeat(64), controller, leaseOwner: "idle-admission-controller", attempt: 0,
        controllerGeneration: 1 }, async (tx, retention) => {
        await tx.update(nativeRunFinalizations).set({ phase: "committed", leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.run.id));
        return retention;
      });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issue.id));
      await f.envs.releaseLease(f.first.id, "retained", { cleanupStatus: "success" });
      const binding = { companyId: f.companyId, runId: f.run.id, expectedProcess: proof.process,
        expectedRetention: { nonce: proof.nonce, bootId: controller.bootId, pid: controller.pid, processStartedAt: controller.processStartedAt.toISOString() } };
      const nonce = await claimNativeRemoteIdleClose(db, binding);
      if (!nonce) throw new Error("Idle admission fixture was not retained");
      const sessionScopeId = f.run.id, backupRoot = join(stateBase, createHash("sha256").update(sessionScopeId).digest("hex"), "failover-backups/current");
      await mkdir(join(backupRoot, "runner"), { recursive: true }); await mkdir(join(backupRoot, "codex-home"));
      await writeFile(join(backupRoot, "runner/runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "suspended" }));
      await writeFile(join(backupRoot, "codex-home/thread.jsonl"), "fixture retained provider");
      const manifest = buildNativeHarnessBackupManifest({ backupRoot, execution, runnerInstanceId: identity.runnerInstanceId,
        sourceProviderLeaseId: f.providerLeaseId, providerSessionIdentity: { providerSessionId: "same-provider-session", providerBackendSessionId: null, providerSessionIdentity: null } });
      const manifestPath = join(backupRoot, "manifest.json"); await writeFile(manifestPath, JSON.stringify(manifest));
      const stamp = createNativeHarnessBackupStamp({ manifestPath, sessionScopeId, authorizedProviderLeaseId: f.providerLeaseId,
        normalizedSessionId: native.normalizedSessionId, runnerInstanceId: identity.runnerInstanceId, completedAt: manifest.completedAt });
      expect(await recordNativeRemoteIdleCheckpoint(db, binding, nonce, stamp)).toBe(true);
      f.methods.push("environmentRunProcessControl");
      const provider = f.call.getMockImplementation()!;
      f.call.mockImplementation(async (...args) => {
        if (args[1] !== "environmentRunProcessControl") return provider(...args);
        expect(args[2]).toMatchObject({ providerLeaseId: f.providerLeaseId, owner, operation: { action: "inspect" }, workspaceConnection: proof.process.workspaceConnection });
        return { state: "exited", workspaceConnection: proof.process.workspaceConnection };
      });
      if (operation === "acquire") {
        const attached = await f.runtime.acquireRunLease(f.input(await f.newRun()));
        expect(attached.lease.providerLeaseId).toBe(f.providerLeaseId);
        expect(attached.lease.metadata).not.toHaveProperty("nativeWarmRunnerClose");
      } else {
        await f.runtime.operateRuntimeService({ companyId: f.companyId, environmentLeaseId: f.first.id, serviceId: f.service.id,
          generation: randomUUID(), action: "release_compute" });
      }
      expect((await f.envs.getLeaseById(f.first.id))?.metadata?.nativeWarmRunnerClose).toMatchObject({ state: "closed",
        recovery: { reason: "verified_checkpoint_after_controller_exit" } });
      expect(f.call.mock.calls.map(([, method]) => method)).toEqual(["environmentRunProcessControl", operation === "acquire" ? "environmentResumeLease" : "environmentService"]);
    } finally {
      if (previousStateDirectory === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR; else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      await rm(stateBase, { recursive: true, force: true });
    }
  });

  it("uses the most recent completed file receipt on a third run", async () => {
    const f = await fixture();
    const secondRun = await f.newRun();
    const second = (await f.runtime.acquireRunLease(f.input(secondRun))).lease;
    const receipt = { version: 1, sha256: "c".repeat(64), exclude: [".git"], executionWorkspaceId: f.workspace.id, providerLeaseId: f.providerLeaseId, remoteCwd: "/workspace" };
    await f.envs.updateLeaseMetadata(second.id, { ...second.metadata, runtimeServiceWorkspaceSync: receipt });
    await f.finish(secondRun);
    // Retention maintenance can touch the original allocation lease after a
    // run finishes. Its timestamp must not restore an older file-sync record.
    await f.envs.updateLeaseMetadata(f.first.id, { ...f.first.metadata, retentionCheckedAt: new Date().toISOString() });
    const third = (await f.runtime.acquireRunLease(f.input(await f.newRun()))).lease;
    expect(third.metadata?.runtimeServiceWorkspaceSync).toEqual(receipt);
    expect(third.metadata?.runtimeServiceAttachment).toMatchObject({ allocationId: f.service.allocationId });
  });

  it("allows the inherited workspace mode to become an explicit issue setting", async () => {
    const f = await fixture();
    const attached = await f.runtime.acquireRunLease({ ...f.input(await f.newRun()), executionWorkspaceSettings: { mode: "isolated_workspace" } });
    expect(attached.lease.providerLeaseId).toBe(f.providerLeaseId);
  });

  it("reattaches the creating run after recovery even when its original lease was ephemeral", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.run.id));
    const attached = await f.runtime.acquireRunLease(f.input());
    const replay = await f.runtime.acquireRunLease(f.input());
    expect(attached.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(replay.lease.id).toBe(attached.lease.id);
    expect(attached.lease.id).not.toBe(f.first.id);
    expect(f.call.mock.calls.map(([, method]) => method)).toEqual(["environmentResumeLease", "environmentResumeLease"]);
  });

  it("checks the originating run's connection on later service operations", async () => {
    const f = await fixture();
    const result = await f.runtime.operateRuntimeService({ companyId: f.companyId, environmentLeaseId: f.first.id, serviceId: f.service.id, generation: randomUUID(), action: "retain" });
    const scope = f.first.metadata!.runtimeServiceRunScope as { connection: unknown };
    expect(result.workspaceConnection).toEqual(scope.connection);
    expect(f.call.mock.calls[0]?.[2].workspaceConnection).toEqual(scope.connection);
    expect(f.call.mock.calls[0]?.[2].config).not.toHaveProperty("taskWorkspaceOwnership");
  });

  it.each(["owner", "historical_alias"])("refuses run and service admission when deletion is fenced on the %s lease", async (marker) => {
    const f = await fixture();
    const metadata = { ...f.first.metadata, runtimeServiceDataDeletionId: randomUUID() };
    if (marker === "owner") await f.envs.updateLeaseMetadata(f.first.id, metadata);
    else await db.insert(environmentLeases).values({ ...f.first, id: randomUUID(), heartbeatRunId: null, status: "expired", metadata });
    await expect(f.runtime.acquireRunLease(f.input(await f.newRun()))).rejects.toThrow(/delet/i);
    await expect(f.runtime.operateRuntimeService({ companyId: f.companyId, environmentLeaseId: f.first.id, serviceId: f.service.id, generation: randomUUID(), action: "start" })).rejects.toThrow(/delet/i);
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each(["adapter", "network", "configuration", "missing_scope", "fixed_expiry"])("refuses %s without allocating or destroying a sandbox", async (change) => {
    const f = await fixture();
    const input = f.input(await f.newRun());
    if (change === "adapter") input.adapterType = "codex_local";
    if (change === "network") input.runtimeServiceExecutionPolicy.networkScope = "deny";
    if (change === "configuration") input.environment = { ...input.environment, config: { ...input.environment.config, image: "different:image" } };
    if (change === "missing_scope") await f.envs.updateLeaseMetadata(f.first.id, { ...f.first.metadata, runtimeServiceRunScope: null });
    if (change === "fixed_expiry") await db.update(environmentLeases).set({ expiresAt: new Date(Date.now() + 30_000) }).where(eq(environmentLeases.id, f.first.id));
    await expect(f.runtime.acquireRunLease(input)).rejects.toThrow(/retained|incompatible/);
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each(["missing", "different_sandbox", "different_sentinel", "no_connection_receipt"])("preserves the allocation on a %s resume result", async (failure) => {
    const f = await fixture();
    const original = f.resume.getMockImplementation()!;
    f.resume.mockImplementation(async (params) => {
      const result = await original(params);
      if (failure === "missing") return { providerLeaseId: null, metadata: { expired: true } } as any;
      if (failure === "different_sandbox") result.providerLeaseId = "unexpected-sandbox";
      if (failure === "different_sentinel") result.metadata.workspaceSentinel.token = "foreign-token";
      if (failure === "no_connection_receipt") delete result.metadata.workspaceConnection;
      return result;
    });
    await expect(f.runtime.acquireRunLease(f.input(await f.newRun()))).rejects.toThrow();
    expect(f.call.mock.calls.map(([, method]) => method)).toEqual(["environmentResumeLease"]);
    expect(await f.envs.getLeaseById(f.first.id)).toMatchObject({ status: "retained", providerLeaseId: f.providerLeaseId });
  });

  it("rejects stale task authorization before resuming", async () => {
    const f = await fixture();
    const next = await f.newRun();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: randomUUID(), executionWorkspaceId: f.workspace.id } }).where(eq(heartbeatRuns.id, next.id));
    await expect(f.runtime.acquireRunLease(f.input(next))).rejects.toThrow(/authorized/);
    expect(f.call).not.toHaveBeenCalled();
  });

  it("serializes different runs and refuses a second writer while the first is active", async () => {
    const f = await fixture();
    const active = await f.newRun();
    await f.runtime.acquireRunLease(f.input(active));
    f.call.mockClear();
    await expect(f.runtime.acquireRunLease(f.input(await f.newRun()))).rejects.toThrow(/Another agent run/);
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each(["owner", "historical_alias"])("refuses acquisition while a runner shutdown is unfinished on the %s lease", async marker => {
    const f = await fixture();
    const metadata = { ...f.first.metadata, nativeWarmRunnerClose: { version: 1, nonce: randomUUID(), retentionNonce: randomUUID(),
      state: "closing", requestedAt: new Date(0).toISOString() } };
    if (marker === "owner") await f.envs.updateLeaseMetadata(f.first.id, metadata);
    else await db.insert(environmentLeases).values({ ...f.first, id: randomUUID(), heartbeatRunId: null, status: "expired", metadata });
    await expect(f.runtime.acquireRunLease(f.input(await f.newRun()))).rejects.toThrow("idle_close_pending");
    await expect(f.runtime.operateRuntimeService({ companyId: f.companyId, environmentLeaseId: f.first.id,
      serviceId: f.service.id, generation: randomUUID(), action: "release_compute" })).rejects.toThrow("idle_close_pending");
    expect(f.call).not.toHaveBeenCalled();
    expect(await f.envs.getLeaseById(f.first.id)).toMatchObject({ providerLeaseId: f.providerLeaseId, status: "retained" });
  });

  it.each([
    ["owner", "attaching"], ["historical_alias", "attaching"],
    ["owner", "failed"], ["historical_alias", "failed"],
    ["owner", "malformed"], ["historical_alias", "malformed"],
  ])("holds acquisition and compute release during %s lease %s reconnection", async (location, state) => {
    const f = await fixture();
    const nonce = randomUUID(), authorityNonce = randomUUID();
    const metadata = { ...f.first.metadata, nativeWarmRunnerRetention: { nonce,
      controller: { bootId: "original", pid: 1, processStartedAt: new Date(0).toISOString() },
      controllerTakeover: { version: 1, originNonce: nonce, generation: 1, previousAuthoritySha256: "a".repeat(64), claimedAt: new Date(0).toISOString(),
        authority: { nonce: authorityNonce, bootId: "replacement", pid: 2, processStartedAt: new Date(0).toISOString() },
        reconnection: { version: 1, nonce: randomUUID(), authorityNonce, state, startedAt: new Date(0).toISOString(),
          ...(state === "failed" ? { settledAt: new Date(0).toISOString() } : {}),
          evidence: { sessionScopeSha256: "1".repeat(64), checkpointSha256: "2".repeat(64), hostAuthoritySha256: "3".repeat(64) } },
      } } };
    if (location === "owner") await f.envs.updateLeaseMetadata(f.first.id, metadata);
    else await db.insert(environmentLeases).values({ ...f.first, id: randomUUID(), heartbeatRunId: null, status: "expired", metadata });
    const next = await f.newRun();
    await expect(f.runtime.acquireRunLease(f.input(next))).rejects.toThrow("idle_recovery_pending");
    await expect(f.runtime.operateRuntimeService({ companyId: f.companyId, environmentLeaseId: f.first.id,
      serviceId: f.service.id, generation: randomUUID(), action: "release_compute" })).rejects.toThrow("idle_recovery_pending");
    expect(f.call).not.toHaveBeenCalled();
    const published = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, f.companyId), eq(environmentLeases.heartbeatRunId, next.id)));
    expect(published).toHaveLength(0);
    expect(await f.envs.getLeaseById(f.first.id)).toMatchObject({ providerLeaseId: f.providerLeaseId, status: "retained" });
  });

  it.each(["owner", "historical_alias"])("holds acquisition and compute release before orphan recovery can claim the %s lease", async location => {
    const f = await fixture();
    const metadata = { ...f.first.metadata, nativeWarmRunnerRetention: { nonce: randomUUID(),
      allocationRunLeasesDigest: await nativeRunnerAllocationLeaseDigest(db, f.first),
      controller: { bootId: "retired", pid: 2_000_000_001, processStartedAt: new Date(0).toISOString() } } };
    if (location === "owner") await f.envs.updateLeaseMetadata(f.first.id, metadata);
    else await db.insert(environmentLeases).values({ ...f.first, id: randomUUID(), heartbeatRunId: null, status: "expired", metadata });
    const next = await f.newRun();
    await expect(f.runtime.acquireRunLease(f.input(next))).rejects.toThrow("idle_recovery_pending");
    await expect(f.runtime.operateRuntimeService({ companyId: f.companyId, environmentLeaseId: f.first.id,
      serviceId: f.service.id, generation: randomUUID(), action: "release_compute" })).rejects.toThrow("idle_recovery_pending");
    expect(f.call).not.toHaveBeenCalled();
    expect(await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, f.companyId), eq(environmentLeases.heartbeatRunId, next.id)))).toHaveLength(0);
    expect(await f.envs.getLeaseById(f.first.id)).toMatchObject({ providerLeaseId: f.providerLeaseId, status: "retained" });
  });

  it("admits the next run after the prior runner shutdown has a committed completion", async () => {
    const f = await fixture();
    await f.envs.updateLeaseMetadata(f.first.id, { ...f.first.metadata, nativeWarmRunnerClose: {
      version: 1, nonce: randomUUID(), retentionNonce: randomUUID(), state: "closed", finishedAt: new Date().toISOString(),
    } });
    const resume = f.resume.getMockImplementation()!;
    f.resume.mockImplementation(async params => {
      const result = await resume(params);
      return { ...result, metadata: { ...result.metadata, nativeWarmRunnerClose: params.leaseMetadata.nativeWarmRunnerClose,
        nativeWarmRunnerRetention: { nonce: "provider-echo" } } };
    });
    const next = await f.newRun();
    const lease = await f.runtime.acquireRunLease(f.input(next));
    expect(lease.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(lease.lease.metadata).not.toHaveProperty("nativeWarmRunnerClose");
    expect(lease.lease.metadata).not.toHaveProperty("nativeWarmRunnerRetention");
    expect(f.call.mock.calls.map(([, method]) => method)).toEqual(["environmentResumeLease"]);
  });

  it("holds compute release until the resumed run publishes its consumer lease", async () => {
    const f = await fixture();
    const next = await f.newRun();
    let entered!: () => void, finish!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { finish = resolve; });
    const original = f.resume.getMockImplementation()!;
    f.resume.mockImplementation(async (params) => { entered(); await released; return original(params); });
    const attaching = f.runtime.acquireRunLease(f.input(next));
    await entering;
    let releaseSettled = false;
    const releasing = f.runtime.operateRuntimeService({ companyId: f.companyId, environmentLeaseId: f.first.id, serviceId: f.service.id, generation: randomUUID(), action: "release_compute" })
      .finally(() => { releaseSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(releaseSettled).toBe(false);
    finish();
    const attached = await attaching;
    expect(attached.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(await releasing).toMatchObject({ state: "retained" });
    expect(f.call.mock.calls.map(([, method]) => method)).toEqual(["environmentResumeLease"]);
  });

  it("rechecks task cancellation after provider resume before publishing a lease", async () => {
    const f = await fixture();
    const next = await f.newRun();
    const original = f.resume.getMockImplementation()!;
    f.resume.mockImplementation(async (params) => {
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, next.id));
      return original(params);
    });
    await expect(f.runtime.acquireRunLease(f.input(next))).rejects.toThrow(/authorized/);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, next.id))).toHaveLength(0);
    expect(f.call.mock.calls.map(([, method]) => method)).toEqual(["environmentResumeLease"]);
    expect(await f.envs.getLeaseById(f.first.id)).toMatchObject({ status: "retained" });
  });

  it("does not switch a retained remote task to local execution", async () => {
    const f = await fixture();
    const local = await f.envs.ensureLocalEnvironment(f.companyId);
    await expect(f.runtime.acquireRunLease({ ...f.input(await f.newRun()), environment: local })).rejects.toThrow(/original environment/);
    expect(f.call).not.toHaveBeenCalled();
  });
});
