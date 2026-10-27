import * as pluginProbe from "../services/native-runtime/plugin-runner-probe.js";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, plugins, projects } from "@paperclipai/db";
import { definePlugin } from "../../../packages/plugins/sdk/src/define-plugin.js";
import { startWorkerRpcHost } from "../../../packages/plugins/sdk/src/worker-rpc-host.js";
import { createRequest, parseMessage, serializeMessage, isJsonRpcSuccessResponse, isJsonRpcErrorResponse } from "../../../packages/plugins/sdk/src/protocol.js";
import { environmentTaskOperationSchema, type PluginEnvironmentTaskOperation } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { agentEnvironmentTestService } from "../services/agent-environment-test.js";
import { heartbeatService } from "../services/heartbeat.js";
import { remoteExecutionHasStopped } from "../services/remote-execution-termination.js";
import { resolvePluginTaskResume } from "../services/environment-task-runtime.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentRunOrchestrator } from "../services/environment-run-orchestrator.js";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, type RunnerProviderLaunchRequirements } from "@paperclipai/paperclip-runner";
import { createPluginRunnerTaskOwner } from "../services/native-runtime/plugin-runner-task.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ingress = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../realtime/runner-prp-outbound.js", () => ({ connectRunnerPrpIngress: ingress.connect }));
const support = await getEmbeddedPostgresTestSupport();
const databaseSuite = support.supported ? describe : describe.skip;

/** Real SDK serialization and dispatch with synthetic provider resources. */
function workerHarness(plugin: ReturnType<typeof definePlugin>, manifest: PaperclipPluginManifestV1) {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const host = startWorkerRpcHost({ plugin, stdin, stdout });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 0, buffer = "";
  stdout.on("data", chunk => {
    buffer += String(chunk);
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = parseMessage(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (!isJsonRpcSuccessResponse(message) && !isJsonRpcErrorResponse(message)) continue;
      const waiter = pending.get(Number(message.id));
      pending.delete(Number(message.id));
      if (isJsonRpcSuccessResponse(message)) waiter?.resolve(message.result);
      else waiter?.reject(new Error(message.error.message));
    }
  });
  const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    stdin.write(serializeMessage(createRequest(method as never, params as never, id)));
  });
  return { call, stop: () => host.stop(), initialize: () => call("initialize", {
    manifest, config: {}, instanceInfo: { instanceId: "fixture", hostVersion: "1.0.0" }, apiVersion: 1,
  }) };
}

databaseSuite("Core plugin Runner task lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("plugin-runner-task");
    stopDb = started.stop; db = createDb(started.connectionString);
  });
  afterAll(async () => { await stopDb?.(); });

  it("does not allocate agent-dependent setup leases before the agent is prepared", async () => {
    const companyId = randomUUID(), pluginId = randomUUID(), environmentId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Setup lease fixture", issuePrefix: "SETUP" });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "@test/agent-owned-tasks", version: "1.0.0", status: "ready",
      manifestJson: { agentLifecycle: true, capabilities: ["agents.lifecycle.manage", "environment.drivers.register"],
        environmentDrivers: [{ driverKey: "tasks", supportsTasks: true, requiresAgent: true }] } as never });
    await db.insert(environments).values({ id: environmentId, name: "Agent computer", driver: "plugin", status: "active",
      config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } });
    const call = vi.fn();
    const setup = agentEnvironmentTestService(db, { call } as never);
    const input = { companyId, environmentId, adapterType: "paperclip_runner" };
    expect((await setup.resolveAdapterTestExecutionContext(input)).fallbackChecks).toMatchObject([{ code: "environment_agent_required", level: "warn" }]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Draft", lifecycleState: "preparing", lifecycleHolds: ["setup"], status: "paused" });
    expect((await setup.resolveAdapterTestExecutionContext({ ...input, agentId })).fallbackChecks).toMatchObject([{ code: "environment_agent_preparing", level: "warn" }]);
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, companyId));
    await db.update(agents).set({ lifecycleState: "paused", pauseReason: "setup" }).where(eq(agents.id, agentId));
    expect((await setup.resolveAdapterTestExecutionContext({ ...input, agentId })).fallbackChecks).toMatchObject([{ code: "environment_agent_approval_required", level: "warn" }]);
    const foreign = randomUUID();
    await db.insert(companies).values({ id: foreign, name: "Other company", issuePrefix: "OTHER" });
    expect((await setup.resolveAdapterTestExecutionContext({ ...input, companyId: foreign, agentId })).fallbackChecks).toMatchObject([{ code: "environment_agent_preparing" }]);
    expect(call).not.toHaveBeenCalled();
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.environmentId, environmentId))).toEqual([]);
  });

  it("uses an acquired lease through SDK RPC, native dispatch, connection, stop proof and release", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    const environmentId = randomUUID(), pluginId = randomUUID(), projectId = randomUUID();
    const manifest: PaperclipPluginManifestV1 = {
      id: "test.runner-tasks", apiVersion: 1, version: "1.0.0", displayName: "Runner tasks",
      description: "Synthetic task provider", author: "Paperclip", categories: ["automation"],
      capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
      environmentDrivers: [{ driverKey: "tasks", displayName: "Tasks", supportsTasks: true, configSchema: { type: "object" } }],
    };
    await db.insert(companies).values({ id: companyId, name: "Fixture", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "running" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fixture", status: "active" });
    const [environment] = await db.insert(environments).values({ id: environmentId, name: "Fixture", driver: "plugin", status: "active",
      config: { pluginKey: manifest.id, driverKey: "tasks", driverConfig: {} } }).returning();
    await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id, packageName: "@test/runner-tasks",
      version: "1.0.0", apiVersion: 1, categories: ["automation"], manifestJson: manifest, status: "ready" });
    const calls: PluginEnvironmentTaskOperation[] = [];
    let executionStopped = false, stopRequested = false, acquisition = 0, releaseFailure = false;
    const released = vi.fn(), complete = vi.fn();
    const plugin = definePlugin({
      async setup() {},
      async onEnvironmentAcquireLease() { return { providerLeaseId: `attempt:fixture.${++acquisition}`, metadata: {} }; },
      async onEnvironmentReleaseLease() { if (releaseFailure) throw new Error("synthetic release failure"); released(); },
      async onEnvironmentTask(params) {
        calls.push(params.operation);
        switch (params.operation.kind) {
          case "describe": return { kind: "description", launchPreparationVersion: 1, projectAuthCheckVersion: 1, taskId: params.taskId,
            runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` } };
          case "prepare": return { kind: "prepared", taskId: params.taskId, launch: {
            configurationId: `config-${params.taskId}`, requirementsDigest: runnerLaunchRequirementsDigest(params.operation.requirements as RunnerProviderLaunchRequirements),
            provider: createRunnerProviderLaunch(params.operation.requirements as RunnerProviderLaunchRequirements, {
              options: { codexArgs: [] }, root: "/runner", cwd: "/workspace", codexHome: "/account",
              codexCommand: "/bin/codex", providerNodeCommand: "/bin/node", opencodeProxyPath: "", acpxSidecarPath: "",
            }),
          } };
          case "check_project_auth": return { kind: "project_auth", taskId: params.taskId,
            configurationId: params.operation.configurationId, provider: params.operation.provider, allowed: true };
          case "read_state": return { kind: "state", taskId: params.taskId, state: {
            schema: "paperclip.runner.durable.state.v1", ...params.operation.identity, lifecycle: "suspended",
          } };
          case "submit": stopRequested = false; executionStopped = false; return { kind: "accepted", taskId: params.taskId };
          case "status": return { kind: "status", taskId: params.taskId, phase: stopRequested ? "cancelled" : "running", executionStopped, sessionStateAvailable: executionStopped };
          case "connection": return { kind: "connection", taskId: params.taskId, endpoint: {
            kind: "authenticated_websocket", websocketUrl: "wss://runner.example.test/connect", generation: "fixture",
            secretHeaders: [{ name: "Authorization", value: "Bearer synthetic-fixture" }],
          } };
          case "stop": stopRequested = true; return { kind: "accepted", taskId: params.taskId };
          case "complete": complete(); return { kind: "accepted", taskId: params.taskId };
        }
      },
    });
    const harness = workerHarness(plugin, manifest);
    const { supportedMethods } = await harness.initialize();
    const workers = { isRunning: () => true, getWorker: () => ({ supportedMethods }),
      call: (_id: string, method: string, params: unknown) => harness.call(method, params) } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workers });
    const setup = agentEnvironmentTestService(db, workers);
    await setup.assertAdapterTestEnvironmentForCompany(companyId, environmentId, "paperclip_runner");
    const probe = await setup.resolveAdapterTestExecutionContext({ companyId, agentId, adapterType: "paperclip_runner", environmentId });
    expect(probe.fallbackChecks).toEqual([]);
    expect(probe.executionTarget).toMatchObject({ runnerTaskProbe: { runId: expect.any(String), sessionId: expect.any(String) } });
    if (probe.executionTarget?.kind !== "remote" || probe.executionTarget.transport !== "sandbox" || !probe.executionTarget.runnerTaskProbe) throw new Error("Probe task target unavailable");
    await expect(probe.executionTarget.runnerTask!({ kind: "describe" }))
      .resolves.toMatchObject({ kind: "description" });
    const [probeLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, probe.executionTarget.leaseId!));
    expect(probeLease.heartbeatRunId).toBeNull();
      const selected = { identity: "core-selected-revision", sessionIdentity: "core-selected-account", home: "/core-owned-home" };
      const verify = vi.spyOn(pluginProbe, "probePluginRunnerEnvironment").mockResolvedValue({ adapterType: "paperclip_runner", status: "pass", testedAt: new Date().toISOString(), checks: [] });
      try {
        await setup.testManagedEnvironment("paperclip_runner", { companyId, adapterType: "paperclip_runner", config: {}, executionTarget: probe.executionTarget },
          { provider: "openai" } as any, selected as any);
        expect(verify).toHaveBeenCalledWith(expect.anything(), { identity: selected.identity, accountIdentity: selected.sessionIdentity, home: "/core-owned-home/provider" });
      } finally { verify.mockRestore(); }
    await probe.executionTarget.runnerTask!({ kind: "check_project_auth", configurationId: "probe-config", provider: "openai", projectIds: [] });
    await probe.executionTarget.runnerTask!({ kind: "submit", preparedLaunchId: "probe-config", bootstrapTicket: "synthetic-probe-ticket", projectIds: [],
      runner: { protocolMin: 1, protocolMax: 3, harness: "codex", runnerId: "probe-runner", leaseId: probeLease.id,
        runId: probe.executionTarget.runnerTaskProbe.runId, sessionId: probe.executionTarget.runnerTaskProbe.sessionId, turnId: "probe-turn", itemId: "probe-item" },
      launch: { runnerVersion: "fixture", runnerDigest: `sha256:${"a".repeat(64)}`,
        maxOutboxBytes: 262144, p0ReserveBytes: 65536, maxRuntimeMs: 0,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    });
    const probeSubmit = calls.find((op): op is Extract<PluginEnvironmentTaskOperation, { kind: "submit" }> => op.kind === "submit")!;
    expect(probeSubmit.launch?.maxRuntimeMs).toBeGreaterThan(0);
    expect(probeSubmit.launch?.maxRuntimeMs).toBeLessThanOrEqual(120_000);
    executionStopped = true;
    await probe.release(); released.mockClear(); complete.mockClear(); calls.length = 0;
    const orchestrator = environmentRunOrchestrator(db, { environmentRuntime: runtime });
    const acquired = await orchestrator.acquireForRun({ companyId, selectedEnvironmentId: environmentId, localEnvironmentId: randomUUID(),
      agentId, issueId: null, heartbeatRunId: runId, persistedExecutionWorkspace: null,
      executionWorkspaceSettings: null, adapterType: "paperclip_runner" });
    const realization = await orchestrator.realizeForRun({ companyId, environment: acquired.environment, lease: acquired.lease,
      adapterType: "paperclip_runner", issueId: null, heartbeatRunId: runId,
      executionWorkspace: { baseCwd: "/local/project", cwd: "/local/project", source: "project_primary", projectId,
        workspaceId: null, repoUrl: null, repoRef: null, strategy: "project_primary", branchName: null, worktreePath: null,
        warnings: [], created: false, branchCreatedByRuntime: false },
      effectiveExecutionWorkspaceMode: null, persistedExecutionWorkspace: null });
    const target = realization.executionTarget;
    expect(target).toMatchObject({ kind: "remote", transport: "sandbox", remoteCwd: ".", leaseId: acquired.lease.id });
    if (target?.kind !== "remote" || target.transport !== "sandbox" || !target.runnerTask) throw new Error("Missing plugin target");
    expect(target.runner).toBeUndefined();
    await expect(target.runnerTask({ kind: "describe" }))
      .resolves.toMatchObject({ kind: "description", runner: { version: "fixture" } });
    const onDispatched = vi.fn(), checkpoint = vi.fn(async () => {}), close = vi.fn(async () => {});
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close });
    const owner = createPluginRunnerTaskOwner({ task: target.runnerTask, projectAuthCheckVersion: 1,
      credentialIdentity: "revision", accountIdentity: "account", credential: { type: "codex-auth-json", authJson: '{"OPENAI_API_KEY":"synthetic-account-key"}' }, projectIds: target.runnerTaskProjectIds ?? [], harness: "codex",
      onSessionRetained: checkpoint, onDispatched, pollMs: 1 });
    const identity = { runnerInstanceId: randomUUID(), environmentLeaseId: acquired.lease.id, runId,
      normalizedSessionId: randomUUID(), turnId: "turn", itemId: "item" };
    const requirements: RunnerProviderLaunchRequirements = { schema: "paperclip.runner.launch-requirements.v1", identity,
      provider: "codex", model: "fixture", instructions: "Core policy", runtimeContext: null, settings: {},
      approvalPolicy: "never", readOnly: false, preparedConversation: false, includeCollaborationModeInstructions: false };
    const prepared = await owner.driver.prepareLaunch!(requirements);
    // Re-preparation invalidates the old credential validation before the worker reply.
    await runtime.task({ companyId, leaseId: acquired.lease.id, operation: environmentTaskOperationSchema.parse({
      kind: "prepare", requirements, projectIds: [projectId],
    }) });
    await expect(runtime.task({ companyId, leaseId: acquired.lease.id, operation: {
      kind: "submit", projectIds: [projectId], preparedLaunchId: prepared.configurationId, bootstrapTicket: "synthetic-ticket",
      accountIdentity: "account", credential: { type: "codex-auth-json", authJson: '{"OPENAI_API_KEY":"never-transfer-stale-proof"}' },
      runner: { protocolMin: 1, protocolMax: 3, harness: "codex", runnerId: identity.runnerInstanceId,
        leaseId: identity.environmentLeaseId, runId: identity.runId, sessionId: identity.normalizedSessionId,
        turnId: identity.turnId, itemId: identity.itemId },
    } })).rejects.toThrow("validation unavailable");
    expect(calls.some(op => op.kind === "submit")).toBe(false);
    await owner.driver.prepareLaunch!(requirements);
    const registration = await owner.registration({} as never, runId);
    const handle = owner.launcher({ command: "ignored", args: [], cwd: "/ignored", environment: { OPENAI_API_KEY: "synthetic-launch-key" },
      nativeRunner: { identity, ticket: "synthetic-bootstrap-ticket",
        connection: registration.connection, stateDirectory: "/runner/state", runnerVersion: "fixture", runnerDigest: `sha256:${"a".repeat(64)}`,
        maxOutboxBytes: 262144, p0ReserveBytes: 65536, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } } });
    let settled = false;
    void handle.completion.then(() => { settled = true; });
    try {
      registration.activate(); await registration.ready();
      expect(onDispatched).toHaveBeenCalledOnce();
      expect(ingress.connect).toHaveBeenCalledWith(expect.objectContaining({ endpoint: expect.objectContaining({ websocketUrl: "wss://runner.example.test/connect" }) }));
      const submit = calls.find(operation => operation.kind === "submit");
      expect(submit).toMatchObject({ kind: "submit", projectIds: [projectId], runner: { leaseId: acquired.lease.id, runId },
        launch: { runnerVersion: "fixture" } });
      const [saved] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, acquired.lease.id));
      expect(saved.metadata?.runnerTaskDispatched).toBe(true);
      expect(JSON.stringify(saved.metadata)).not.toMatch(/synthetic-account-key|synthetic-launch-key|synthetic-bootstrap-ticket|synthetic-fixture/);
      await expect(runtime.task({ companyId: randomUUID(), leaseId: acquired.lease.id, operation: { kind: "stop" } })).rejects.toThrow("lease unavailable");
      const before = calls.filter(value => value.kind === "submit").length;
      await expect(runtime.task({ companyId, leaseId: acquired.lease.id, operation: { ...submit!, projectIds: [randomUUID()] } as never })).rejects.toThrow("project unavailable");
      expect(calls.filter(value => value.kind === "submit")).toHaveLength(before);
      handle.child.kill("SIGTERM");
      await vi.waitFor(() => expect(stopRequested).toBe(true));
      await delay(10); expect(settled).toBe(false);
      executionStopped = true; await handle.completion;
      await registration.release(); expect(complete).not.toHaveBeenCalled();
      await registration.checkpoint("settled");
      expect(checkpoint).toHaveBeenCalledOnce(); expect(complete).toHaveBeenCalledOnce();
      await runtime.releaseRunLeases(runId, "released");
      expect(released).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
      expect(await remoteExecutionHasStopped(db, companyId, runId)).toBe(true);

      // A controller that dies after dispatch leaves only the lease marker.
      const second = await runtime.acquireRunLease({ companyId, environment: environment as never, agentId,
        issueId: null, heartbeatRunId: runId, persistedExecutionWorkspace: null, adapterType: "paperclip_runner" });
      if (submit?.kind !== "submit") throw new Error("Missing submit fixture");
      await runtime.task({ companyId, leaseId: second.lease.id, operation: { kind: "check_project_auth", configurationId: "second-config", provider: "openai", projectIds: [projectId] } });
      await runtime.task({ companyId, leaseId: second.lease.id,
        operation: { ...submit, credential: undefined, accountIdentity: undefined, credentialIdentity: undefined,
          preparedLaunchId: "second-config", runner: { ...submit.runner, leaseId: second.lease.id } } });
      await runtime.task({ companyId, leaseId: second.lease.id, operation: { kind: "complete" } });
      const errors = vi.fn();
      await runtime.releaseRunLeases(runId, "released", errors);
      expect(errors).toHaveBeenCalledOnce();
      expect(released).toHaveBeenCalledOnce(); // No release while termination is unknown.
      const [pending] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, second.lease.id));
      expect(pending).toMatchObject({ status: "pending_cleanup", metadata: { runnerTaskDispatched: true } });
      await db.delete(environments).where(eq(environments.id, environmentId));
      executionStopped = true;
      releaseFailure = true;
      const recovery = heartbeatService(db, { environmentRuntime: runtime, pluginWorkerManager: workers });
      expect((await recovery.sweepPendingCleanupLeases()).destroyed).toBe(0);
      const [retryable] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, second.lease.id));
      expect(retryable.status).toBe("pending_cleanup");
      releaseFailure = false;
      await db.update(environmentLeases).set({ metadata: { ...retryable.metadata, pendingCleanupRetryAfterMs: 0 } }).where(eq(environmentLeases.id, second.lease.id));
      const sweep = await recovery.sweepPendingCleanupLeases();
      expect(released).toHaveBeenCalledTimes(2);
      expect(sweep.destroyed).toBe(1);
      const [cleaned] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, second.lease.id));
      expect(cleaned).toMatchObject({ status: "expired", cleanupStatus: "success", environmentId: null,
        metadata: { runnerTaskDispatched: false, remoteExecutionTermination: { state: "stopped" } } });
    } finally { executionStopped = true; handle.child.kill(); await handle.completion.catch(() => {}); harness.stop(); }
  });

  it.each([false, true])("replaces a same-run task only after the provider confirms termination (%s)", async stopped => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), pluginId = randomUUID(), environmentId = randomUUID(), oldLeaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Task recovery", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "running" });
    await db.insert(environments).values({ id: environmentId, name: `Recovery ${environmentId}`, driver: "plugin", status: "active", config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "fixture-recovery", version: "1.0.0", status: "ready", manifestJson: {
      capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true }],
    } as never });
    const priorIdentity = { runnerInstanceId: "runner", environmentLeaseId: oldLeaseId, runId, normalizedSessionId: "session" };
    const runner = { runnerId: "runner", leaseId: oldLeaseId, runId, sessionId: "session", turnId: "turn", itemId: "item", harness: "codex", protocolMin: 1, protocolMax: 3 };
    await db.insert(environmentLeases).values({ id: oldLeaseId, companyId, environmentId, heartbeatRunId: runId, status: "active", provider: `plugin:${pluginId}:tasks`, providerLeaseId: "old-task",
      metadata: { driver: "plugin", pluginId, pluginKey: pluginId, driverKey: "tasks", agentId, runnerTaskLease: true, runnerTaskDispatched: true, runnerTaskIdentity: runner } });
    const operations: string[] = [];
    const workers = { isRunning: () => true, getWorker: () => ({ supportedMethods: ["environmentTask", "environmentReleaseLease", "environmentAcquireLease"] }),
      call: async (_id: string, method: string, params: any) => {
        operations.push(method === "environmentTask" ? params.operation.kind : method);
        if (method === "environmentAcquireLease") {
          expect(await remoteExecutionHasStopped(db, companyId, runId)).toBe(true);
          return { providerLeaseId: "new-task", metadata: {} };
        }
        if (method === "environmentReleaseLease") return;
        if (params.operation.kind === "check_project_auth") return { kind: "project_auth", taskId: params.taskId, configurationId: params.operation.configurationId, provider: params.operation.provider, allowed: true };
        if (params.operation.kind === "status") return { kind: "status", taskId: "old-task", phase: "cancelled", executionStopped: stopped, sessionStateAvailable: stopped };
        return { kind: "accepted", taskId: params.taskId };
      } } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workers });
    const acquire = environmentRunOrchestrator(db, { environmentRuntime: runtime }).acquireForRun({
      companyId, selectedEnvironmentId: environmentId, localEnvironmentId: randomUUID(), adapterType: "paperclip_runner", agentId,
      issueId: null, heartbeatRunId: runId, persistedExecutionWorkspace: null, executionWorkspaceSettings: null, recoverPluginTask: true,
    });
    if (!stopped) {
      await expect(acquire).rejects.toThrow("termination_unconfirmed");
      expect(operations).not.toContain("environmentAcquireLease");
      expect(operations).not.toContain("complete");
      return;
    }
    const next = await acquire;
    expect(operations).toEqual(["stop", "status", "complete", "environmentReleaseLease", "environmentAcquireLease"]);
    expect(next.lease.id).not.toBe(oldLeaseId);
    await expect(resolvePluginTaskResume(db, { companyId, leaseId: next.lease.id, priorIdentity })).resolves.toBe("old-task");
    await expect(runtime.task({ companyId, leaseId: next.lease.id, operation: { kind: "submit", projectIds: [], bootstrapTicket: "fixture", runner } })).rejects.toThrow("identity mismatch");
    await runtime.task({ companyId, leaseId: next.lease.id, operation: { kind: "check_project_auth", configurationId: "recovery-config", provider: "openai", projectIds: [] } });
    await expect(runtime.task({ companyId, leaseId: next.lease.id, operation: { kind: "submit", preparedLaunchId: "recovery-config", projectIds: [], bootstrapTicket: "fixture", runner, resumeFrom: "old-task" } })).resolves.toMatchObject({ kind: "accepted" });
    const competingId = randomUUID();
    await db.insert(environmentLeases).values({ id: competingId, companyId, environmentId, heartbeatRunId: runId, status: "active", provider: `plugin:${pluginId}:tasks`, providerLeaseId: "competing-task" });
    await expect(resolvePluginTaskResume(db, { companyId, leaseId: next.lease.id, priorIdentity })).rejects.toThrow("not authorized");
    await db.delete(environmentLeases).where(eq(environmentLeases.id, competingId));
    await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, oldLeaseId));
    await expect(resolvePluginTaskResume(db, { companyId, leaseId: next.lease.id, priorIdentity })).rejects.toThrow("not authorized");
  });

});
