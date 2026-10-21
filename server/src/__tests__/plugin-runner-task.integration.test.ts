import * as pluginProbe from "../services/native-runtime/plugin-runner-probe.js";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, plugins } from "@paperclipai/db";
import { definePlugin } from "../../../packages/plugins/sdk/src/define-plugin.js";
import { startWorkerRpcHost } from "../../../packages/plugins/sdk/src/worker-rpc-host.js";
import { createRequest, parseMessage, serializeMessage, isJsonRpcSuccessResponse, isJsonRpcErrorResponse } from "../../../packages/plugins/sdk/src/protocol.js";
import { type PluginEnvironmentTaskOperation } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { agentEnvironmentTestService } from "../services/agent-environment-test.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

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

  it("uses a bounded setup lease through SDK RPC and releases it after stop proof", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    const environmentId = randomUUID(), pluginId = randomUUID();
    const manifest: PaperclipPluginManifestV1 = {
      id: "test.runner-tasks", apiVersion: 1, version: "1.0.0", displayName: "Runner tasks",
      description: "Synthetic task provider", author: "Paperclip", categories: ["automation"],
      capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
      environmentDrivers: [{ driverKey: "tasks", displayName: "Tasks", supportsTasks: true, configSchema: { type: "object" } }],
    };
    await db.insert(companies).values({ id: companyId, name: "Fixture", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
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
          case "check_project_auth": return { kind: "project_auth", taskId: params.taskId,
            configurationId: params.operation.configurationId, provider: params.operation.provider, allowed: true };
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
    try {
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
      await probe.release();
      expect(released).toHaveBeenCalledOnce();
    } finally { harness.stop(); }
  });
});
