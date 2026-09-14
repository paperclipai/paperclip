import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, closeRegisteredClients, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, plugins, projects, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import type { PluginEnvironmentRunProcessControlParams } from "@paperclipai/plugin-sdk";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { environmentService } from "../environments.js";
import { resolveEnvironmentDriverConfigForRuntime, stripSandboxProviderEnvelope } from "../environment-config.js";
import { runtimeServiceRunConfigurationDigest } from "../runtime-services/run-attachment.js";
import { withRuntimeServiceLeaseLock } from "../runtime-services/retention.js";

describe("original environment capability for native runner recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const pluginId = randomUUID();
  beforeAll(async () => {
    const connectionString = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
    database = connectionString ? { connectionString, cleanup: () => closeRegisteredClients(connectionString) }
      : await startEmbeddedPostgresTestDatabase("paperclip-remote-runner-recovery-");
    db = createDb(database.connectionString);
    await db.insert(plugins).values({ id: pluginId, pluginKey: `fixture.recovery.${pluginId}`, packageName: "fixture-recovery", version: "1.0.0", status: "ready", apiVersion: 1,
      manifestJson: { id: `fixture.recovery.${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "Recovery fixture", description: "Recovery fixture", author: "Paperclip", categories: ["automation"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" }, environmentDrivers: [{ driverKey: "daytona", kind: "sandbox_provider", displayName: "Daytona fixture", configSchema: { type: "object" } }] } });
  }, 30_000);
  afterAll(async () => { if (db) await db.delete(plugins).where(eq(plugins.id, pluginId)); await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), providerLeaseId = randomUUID(), leaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: `R${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Developer", adapterType: "paperclip_runner" }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "Recovery project" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id, name: "Recovery workspace", mode: "isolated_workspace", strategyType: "git_worktree", cwd: "/workspace/app" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, runtimeMode: "native", status: "running", nativeSessionId: randomUUID(),
      processLocation: "remote", processPid: process.pid, processGroupId: null, processStartedAt: new Date() }).returning();
    const [environment] = await db.insert(environments).values({ name: companyId, driver: "sandbox", config: { provider: "daytona", image: "node:24" } }).returning();
    const owner = { version: 1 as const, pid: process.pid, processGroupId: process.pid, uid: 1000, bootId: randomUUID(), startTicks: "100" };
    const workspaceConnection = { scopeId: run!.id, fingerprint: "a".repeat(64) };
    const metadata = { driver: "sandbox", provider: "daytona", sandboxProviderPlugin: true, pluginId,
      runtimeServiceBoundary: { version: 1, provider: "daytona", workspaceRoot: "/workspace/app" },
      runtimeServiceProcessOwner: { version: 1, provider: "daytona", environmentLeaseId: leaseId, providerLeaseId, runId: run!.id, workspaceRoot: "/workspace/app", process: owner },
      runtimeServiceRunScope: { version: 1, companyId, environmentId: environment!.id, executionWorkspaceId: workspace!.id, pluginId, configurationDigest: "b".repeat(64), connection: workspaceConnection } };
    const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId: environment!.id, heartbeatRunId: run!.id,
      executionWorkspaceId: workspace!.id, provider: "daytona", providerLeaseId, status: "active", metadata }).returning();
    const methods = ["environmentRunProcessControl"];
    const call = vi.fn(async (id: string, method: string, raw: unknown) => {
      expect(id).toBe(pluginId); expect(method).toBe("environmentRunProcessControl");
      const params = raw as PluginEnvironmentRunProcessControlParams;
      expect(params).toMatchObject({ companyId, environmentId: environment!.id, providerLeaseId, owner, workspaceConnection });
      expect(params.config).not.toHaveProperty("runtimeServiceProcessOwner");
      return { state: params.operation.action === "inspect" ? "running" : params.operation.action === "signal" ? "signalled" : "stopped", workspaceConnection };
    });
    const worker = { isRunning: () => true, getWorker: () => ({ supportedMethods: methods }), call } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const input = { companyId, runId: run!.id, environmentLeaseId: leaseId, operation: { action: "inspect" as const } };
    return { companyId, run: run!, lease: lease!, owner, metadata, workspaceConnection, input, call, methods, runtime };
  }

  it("verifies the original provider binding without host PID probes, new leases or status changes", async () => {
    const f = await fixture(); const kill = vi.spyOn(process, "kill");
    try {
      expect(await f.runtime.controlRunProcess(f.input)).toMatchObject({ state: "running", process: { processLocation: "remote",
        pid: process.pid, processGroupId: null, environmentLeaseId: f.lease.id, providerLeaseId: f.lease.providerLeaseId,
        remoteProcessIdentity: f.owner, workspaceConnection: f.workspaceConnection } });
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
    expect(f.call).toHaveBeenCalledOnce();
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId))).toEqual([f.lease]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id))).toEqual([f.run]);
  });
  it.each(["company", "run", "lease"])("refuses a foreign %s binding before provider access", async kind => {
    const f = await fixture(); const input = { ...f.input, [kind === "company" ? "companyId" : kind === "run" ? "runId" : "environmentLeaseId"]: randomUUID() };
    expect(await f.runtime.controlRunProcess(input)).toEqual({ state: "unverified" }); expect(f.call).not.toHaveBeenCalled();
  });
  it.each(["released", "expired", "local", "legacy", "finished", "changed_pid", "changed_owner", "missing_scope"])("refuses %s ownership", async cause => {
    const f = await fixture();
    if (cause === "released") await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() }).where(eq(environmentLeases.id, f.lease.id));
    if (cause === "expired") await db.update(environmentLeases).set({ expiresAt: new Date(0) }).where(eq(environmentLeases.id, f.lease.id));
    if (cause === "local") await db.update(heartbeatRuns).set({ processLocation: "local" }).where(eq(heartbeatRuns.id, f.run.id));
    if (cause === "legacy") await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, f.run.id));
    if (cause === "finished") await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    if (cause === "changed_pid") await db.update(heartbeatRuns).set({ processPid: process.pid + 1 }).where(eq(heartbeatRuns.id, f.run.id));
    if (cause === "changed_owner") await db.update(environmentLeases).set({ metadata: { ...f.metadata, runtimeServiceProcessOwner: { ...f.metadata.runtimeServiceProcessOwner, runId: randomUUID() } } }).where(eq(environmentLeases.id, f.lease.id));
    if (cause === "missing_scope") await db.update(environmentLeases).set({ metadata: { ...f.metadata, runtimeServiceRunScope: null } }).where(eq(environmentLeases.id, f.lease.id));
    expect(await f.runtime.controlRunProcess(f.input)).toEqual({ state: "unverified" }); expect(f.call).not.toHaveBeenCalled();
  });
  it("requires the separately negotiated method instead of falling back to generic execute", async () => {
    const f = await fixture(); f.methods.splice(0, 1, "environmentExecute");
    expect(await f.runtime.controlRunProcess(f.input)).toEqual({ state: "unverified" }); expect(f.call).not.toHaveBeenCalled();
  });
  it("binds signals to the caller's exact expected receipt and keeps termination authority unchanged", async () => {
    const f = await fixture(); const input = { ...f.input, operation: { action: "signal" as const, signal: "SIGTERM" as const }, expectedOwner: f.owner };
    expect(await f.runtime.controlRunProcess({ ...input, expectedOwner: { ...f.owner, startTicks: "200" } })).toEqual({ state: "unverified" });
    expect(await f.runtime.controlRunProcess({ ...input, expectedOwner: undefined } as never)).toEqual({ state: "unverified" });
    expect(f.call).not.toHaveBeenCalled();
    expect(await f.runtime.controlRunProcess(input)).toMatchObject({ state: "signalled" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id))).toEqual([f.run]);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id))).toEqual([f.lease]);
  });
  it("rejects changed bindings during the asynchronous provider observation", async () => {
    const f = await fixture(); f.call.mockImplementationOnce(async () => {
      await db.update(heartbeatRuns).set({ processPid: process.pid + 1 }).where(eq(heartbeatRuns.id, f.run.id));
      return { state: "running", workspaceConnection: f.workspaceConnection };
    });
    expect(await f.runtime.controlRunProcess(f.input)).toEqual({ state: "unverified" });
  });
  it("does not accept another connection or an inappropriate success state", async () => {
    const f = await fixture();
    f.call.mockResolvedValueOnce({ state: "running", workspaceConnection: { ...f.workspaceConnection, fingerprint: "c".repeat(64) } });
    expect(await f.runtime.controlRunProcess(f.input)).toEqual({ state: "unverified" });
    f.call.mockResolvedValueOnce({ state: "stopped", workspaceConnection: f.workspaceConnection });
    expect(await f.runtime.controlRunProcess(f.input)).toEqual({ state: "unverified" });
    f.call.mockRejectedValueOnce(new Error("private provider output"));
    expect(await f.runtime.controlRunProcess(f.input)).toEqual({ state: "unverified" });
  });

  async function controllerFixture(operation: "signal" | "read_state" | "ingress" | "execute" = "signal") {
    const f = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Recover existing runner", status: "in_progress", assigneeAgentId: f.run.agentId }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue!.id }).where(eq(heartbeatRuns.id, f.run.id));
    const expectedController = { leaseOwner: "original-controller", controllerGeneration: 2 };
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: issue!.id, runId: f.run.id,
      phase: "observed", ...expectedController, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const observed = await f.runtime.controlRunProcess(f.input); expect(observed.process).toBeDefined();
    f.methods.push("environmentRunnerRecovery", "environmentRunnerRecoveryExecute"); f.call.mockClear();
    const result = operation === "signal" ? { state: "signalled", workspaceConnection: f.workspaceConnection }
      : operation === "execute" ? { state: "executed", workspaceConnection: f.workspaceConnection, result: { exitCode: 0, timedOut: false, stdout: "checkpoint", stderr: "" } }
      : { state: "ready", workspaceConnection: f.workspaceConnection, ...(operation === "read_state" ? { runnerState: { runId: f.run.id } }
        : { endpoint: { kind: "authenticated_websocket", websocketUrl: `wss://preview.test/api/runner/v1/connect/${f.run.id}`, secretHeaders: [], generation: "one" } }) };
    f.call.mockImplementation(async (_id, _method, params) => {
      expect(params).not.toHaveProperty("expectedController"); return result;
    });
    const binding = { companyId: f.companyId, runId: f.run.id, expectedProcess: observed.process!, expectedController };
    const invoke = () => operation === "signal" ? f.runtime.controlRunProcess({ ...f.input, expectedController, expectedOwner: f.owner,
      operation: { action: "signal", signal: "SIGTERM" } }) : operation === "execute"
        ? f.runtime.executeRecoveringRunner({ ...binding, execution: { command: "tar", cwd: "/workspace/app" } })
        : f.runtime.recoverRunner({ ...binding, operation });
    return { ...f, expectedController, invoke, result };
  }
  describe.each(["signal", "read_state", "ingress", "execute"] as const)("controller-bound %s", operation => {
    it("accepts the current controller without sending its authority to the provider", async () => {
      const f = await controllerFixture(operation);
      expect(await f.invoke()).toMatchObject({ state: f.result.state }); expect(f.call).toHaveBeenCalledOnce();
    });
    it.each(["missing", "owner", "generation", "expired"])("refuses %s controller authority before provider access", async cause => {
      const f = await controllerFixture(operation);
      if (cause === "missing") await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id));
      else await db.update(nativeRunFinalizations).set(cause === "owner" ? { leaseOwner: "replacement" }
        : cause === "generation" ? { controllerGeneration: 3 } : { leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.run.id));
      expect(await f.invoke()).toEqual({ state: "unverified" }); expect(f.call).not.toHaveBeenCalled();
    });
    it("withholds the result if the controller lease expires during provider work", async () => {
      const f = await controllerFixture(operation);
      f.call.mockImplementationOnce(async () => {
        await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.run.id));
        return f.result;
      });
      expect(await f.invoke()).toEqual({ state: "unverified" }); expect(f.call).toHaveBeenCalledOnce();
    });
  });
  async function waitForAllocationWaiter(lease: { id: string; companyId: string; provider: string | null; providerLeaseId: string | null }) {
    const key = `runtime-service-allocation:${lease.companyId}:${lease.provider}:${lease.providerLeaseId}`;
    await vi.waitFor(async () => {
      const rows = await db.execute(sql`select exists(select 1 from pg_locks where locktype = 'advisory' and not granted
        and objid::bigint = (hashtext(${key})::bigint & 4294967295::bigint)) as waiting`);
      expect(rows[0]?.waiting).toBe(true);
    }, { timeout: 5000, interval: 10 });
  }
  it("rejects a stale signal queued behind the controller takeover lock", async () => {
    const f = await controllerFixture(); let pending: ReturnType<typeof f.invoke> | undefined;
    try {
      await withRuntimeServiceLeaseLock(db, f.lease, async tx => {
        pending = f.invoke(); await waitForAllocationWaiter(f.lease);
        expect(f.call).not.toHaveBeenCalled();
        await tx.update(nativeRunFinalizations).set({ leaseOwner: "replacement", controllerGeneration: 3 }).where(eq(nativeRunFinalizations.runId, f.run.id));
      });
      expect(await pending).toEqual({ state: "unverified" }); expect(f.call).not.toHaveBeenCalled();
    } finally { await pending; }
  });
  it("finishes a verified signal before a waiting controller can take ownership", async () => {
    const f = await controllerFixture(); const events: string[] = [];
    let entered!: () => void, release!: () => void;
    const providerEntered = new Promise<void>(resolve => { entered = resolve; });
    const providerRelease = new Promise<void>(resolve => { release = resolve; });
    f.call.mockImplementationOnce(async () => { events.push("signal"); entered(); await providerRelease; return f.result; });
    const pending = f.invoke(); let takeover: Promise<void> | undefined;
    try {
      await providerEntered;
      takeover = withRuntimeServiceLeaseLock(db, f.lease, async tx => {
        events.push("takeover");
        await tx.update(nativeRunFinalizations).set({ leaseOwner: "replacement", controllerGeneration: 3 }).where(eq(nativeRunFinalizations.runId, f.run.id));
      });
      await waitForAllocationWaiter(f.lease); expect(events).toEqual(["signal"]);
      release(); expect(await pending).toMatchObject({ state: "signalled" }); await takeover;
      expect(events).toEqual(["signal", "takeover"]);
      expect(await f.invoke()).toEqual({ state: "unverified" }); expect(f.call).toHaveBeenCalledOnce();
    } finally { release(); await Promise.allSettled([pending, takeover]); }
  });

  async function recoveryFixture() {
    const f = await fixture();
    const observed = await f.runtime.controlRunProcess(f.input); expect(observed.process).toBeDefined();
    f.methods.push("environmentRunnerRecovery"); f.call.mockClear();
    const input = { companyId: f.companyId, runId: f.run.id, expectedProcess: observed.process!, operation: "read_state" as const };
    const result = { state: "ready", workspaceConnection: f.workspaceConnection, runnerState: { runId: f.run.id, lifecycle: "ready" } };
    f.call.mockImplementation(async (id, method, params) => {
      expect(id).toBe(f.metadata.pluginId); expect(method).toBe("environmentRunnerRecovery");
      expect(params).toMatchObject({ companyId: f.companyId, environmentId: f.lease.environmentId, providerLeaseId: f.lease.providerLeaseId,
        workspaceConnection: f.workspaceConnection, owner: f.owner, runId: f.run.id, workspaceRoot: "/workspace/app",
        sessionHash: createHash("sha256").update(f.run.nativeSessionId!).digest("hex"), operation: "read_state" });
      return result;
    });
    return { ...f, input, result };
  }
  it("derives recovery reads from the recorded session and retains the original lease", async () => {
    const f = await recoveryFixture(); expect(await f.runtime.recoverRunner(f.input)).toEqual(f.result);
    expect(f.call).toHaveBeenCalledOnce();
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId))).toEqual([f.lease]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id))).toEqual([f.run]);
  });
  it.each(["company", "run", "connection", "workspace", "configuration", "owner", "session_missing", "capability"])("refuses recovery with a changed %s before provider access", async cause => {
    const f = await recoveryFixture();
    if (cause === "company") f.input.companyId = randomUUID();
    if (cause === "run") f.input.runId = randomUUID();
    if (cause === "connection") f.input.expectedProcess.workspaceConnection = { ...f.workspaceConnection, fingerprint: "c".repeat(64) };
    if (cause === "workspace") f.input.expectedProcess.workspaceRoot = "/different";
    if (cause === "configuration") f.input.expectedProcess.configurationDigest = "d".repeat(64);
    if (cause === "owner") f.input.expectedProcess.remoteProcessIdentity = { ...f.owner, startTicks: "200" };
    if (cause === "session_missing") await db.update(heartbeatRuns).set({ nativeSessionId: null }).where(eq(heartbeatRuns.id, f.run.id));
    if (cause === "capability") f.methods.splice(f.methods.indexOf("environmentRunnerRecovery"), 1, "environmentRunnerIngressEndpoint");
    expect(await f.runtime.recoverRunner(f.input)).toEqual({ state: "unverified" }); expect(f.call).not.toHaveBeenCalled();
  });
  it.each(["connection", "session", "wrong_operation"])("rejects %s drift during recovery without returning provider state", async cause => {
    const f = await recoveryFixture(); f.call.mockImplementationOnce(async () => {
      if (cause === "session") await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, f.run.id));
      if (cause === "connection") return { ...f.result, workspaceConnection: { ...f.workspaceConnection, fingerprint: "c".repeat(64) } };
      if (cause === "wrong_operation") return { state: "ready", workspaceConnection: f.workspaceConnection, endpoint: {} };
      return f.result;
    });
    expect(await f.runtime.recoverRunner(f.input)).toEqual({ state: "unverified" });
  });

  async function recoveryExecutionFixture() {
    const f = await fixture();
    const observed = await f.runtime.controlRunProcess(f.input); expect(observed.process).toBeDefined();
    f.methods.push("environmentRunnerRecoveryExecute"); f.call.mockClear();
    const input = { companyId: f.companyId, runId: f.run.id, expectedProcess: observed.process!,
      execution: { command: "tar", args: ["-czf", "-", "checkpoint"], cwd: "/workspace/app", timeoutMs: 120_000 } };
    const result = { state: "executed", workspaceConnection: f.workspaceConnection,
      result: { exitCode: 0, timedOut: false, stdout: "saved archive", stderr: "" } };
    f.call.mockImplementation(async (id, method, params) => {
      expect(id).toBe(f.metadata.pluginId); expect(method).toBe("environmentRunnerRecoveryExecute");
      expect(params).toMatchObject({ companyId: f.companyId, environmentId: f.lease.environmentId, providerLeaseId: f.lease.providerLeaseId,
        workspaceConnection: f.workspaceConnection, owner: f.owner, workspaceRoot: "/workspace/app", execution: input.execution });
      return result;
    });
    return { ...f, input, result };
  }
  it("runs host checkpoint commands on the original lease without acquisition, resume or ordinary execute", async () => {
    const f = await recoveryExecutionFixture(); expect(await f.runtime.executeRecoveringRunner(f.input)).toEqual(f.result);
    expect(f.call).toHaveBeenCalledOnce();
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId))).toEqual([f.lease]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id))).toEqual([f.run]);
  });
  it.each(["capability", "owner", "session", "released", "timeout"])("rejects recovery commands with %s uncertainty before provider access", async cause => {
    const f = await recoveryExecutionFixture();
    if (cause === "capability") f.methods.splice(1, 1, "environmentExecute");
    if (cause === "owner") f.input.expectedProcess.remoteProcessIdentity.startTicks = "200";
    if (cause === "session") await db.update(heartbeatRuns).set({ nativeSessionId: null }).where(eq(heartbeatRuns.id, f.run.id));
    if (cause === "released") await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, f.lease.id));
    if (cause === "timeout") f.input.execution.timeoutMs = Infinity;
    expect(await f.runtime.executeRecoveringRunner(f.input)).toEqual({ state: "unverified" }); expect(f.call).not.toHaveBeenCalled();
  });
  it.each(["connection", "owner", "session", "timed_out", "incomplete", "provider_error"])("withholds command output after %s changes", async cause => {
    const f = await recoveryExecutionFixture(); f.call.mockImplementationOnce(async () => {
      if (cause === "provider_error") throw new Error("private provider details");
      if (cause === "owner") await db.update(heartbeatRuns).set({ processPid: process.pid + 1 }).where(eq(heartbeatRuns.id, f.run.id));
      if (cause === "session") await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, f.run.id));
      return { ...f.result,
        workspaceConnection: cause === "connection" ? { ...f.workspaceConnection, fingerprint: "e".repeat(64) } : f.workspaceConnection,
        result: { ...f.result.result, timedOut: cause === "timed_out", exitCode: cause === "incomplete" ? null : 0 } };
    });
    expect(await f.runtime.executeRecoveringRunner(f.input)).toEqual({ state: "unverified" });
    expect(f.call).toHaveBeenCalledOnce();
  });

  async function leaseAdoptionFixture() {
    const f = await fixture(); const environment = (await environmentService(db).getById(f.lease.environmentId!))!;
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, f.companyId, environment, { heartbeatRunId: f.run.id, issueId: null });
    if (parsed.driver !== "sandbox") throw new Error("Fixture must be a sandbox");
    const policy = { trustPreset: { kind: "standard" }, networkScope: "enabled" };
    const configurationDigest = runtimeServiceRunConfigurationDigest({ providerConfig: stripSandboxProviderEnvelope(parsed.config), adapterType: "paperclip_runner",
      executionWorkspaceMode: "isolated_workspace", executionWorkspaceSettings: null, executionPolicy: policy, pluginVersion: "1.0.0" });
    await db.update(environmentLeases).set({ metadata: { ...f.metadata, runtimeServiceRunScope: { ...f.metadata.runtimeServiceRunScope, configurationDigest } } }).where(eq(environmentLeases.id, f.lease.id));
    const observed = await f.runtime.controlRunProcess(f.input); expect(observed.process).toBeDefined();
    f.methods.push("environmentRunnerRecovery", "environmentRunnerRecoveryExecute"); f.call.mockClear();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const input = { companyId: f.companyId, environment, heartbeatRunId: f.run.id, agentId: f.run.agentId, issueId: null, adapterType: "paperclip_runner",
      persistedExecutionWorkspace: { id: f.lease.executionWorkspaceId!, mode: "isolated_workspace" as const }, executionWorkspaceSettings: null,
      runtimeServiceExecutionPolicy: policy, recoveryProcess: observed.process! };
    return { ...f, input, lease: lease! };
  }
  it("reattaches the original active lease through the production acquisition entry point without acquire or resume RPCs", async () => {
    const f = await leaseAdoptionFixture(); const result = await f.runtime.acquireRunLease(f.input);
    expect(result.lease).toMatchObject({ id: f.lease.id, providerLeaseId: f.lease.providerLeaseId, status: "active", expiresAt: f.lease.expiresAt });
    expect(f.call).toHaveBeenCalledOnce(); expect(f.call.mock.calls[0]![1]).toBe("environmentRunProcessControl");
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId))).toEqual([f.lease]);
  });
  it.each(["policy", "agent", "workspace", "capability", "execute_capability", "environment", "local", "expired", "process_exited"])("never falls back to allocation or resume when %s blocks lease adoption", async cause => {
    const f = await leaseAdoptionFixture();
    if (cause === "policy") f.input.runtimeServiceExecutionPolicy.networkScope = "disabled";
    if (cause === "agent") f.input.agentId = randomUUID();
    if (cause === "workspace") f.input.persistedExecutionWorkspace.id = randomUUID();
    if (cause === "capability") f.methods.splice(f.methods.indexOf("environmentRunnerRecovery"), 1);
    if (cause === "execute_capability") f.methods.splice(f.methods.indexOf("environmentRunnerRecoveryExecute"), 1);
    if (cause === "environment") f.input.environment = { ...f.input.environment, id: randomUUID() };
    if (cause === "local") f.input.environment = { ...f.input.environment, driver: "local", config: {} };
    if (cause === "expired") await db.update(environmentLeases).set({ expiresAt: new Date(0) }).where(eq(environmentLeases.id, f.lease.id));
    if (cause === "process_exited") f.call.mockResolvedValueOnce({ state: "exited", workspaceConnection: f.workspaceConnection });
    await expect(f.runtime.acquireRunLease(f.input)).rejects.toThrow(/recovery_/);
    expect(f.call.mock.calls.map(call => call[1])).toEqual(cause === "process_exited" ? ["environmentRunProcessControl"] : []);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId))).toHaveLength(1);
  });
});
