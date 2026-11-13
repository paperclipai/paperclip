import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES, PluginWorkspaceOperationError, workspaceOperationErrorData } from "@paperclipai/plugin-sdk";
import * as nativeRuntimeMode from "../services/native-runtime/runtime-mode.js";
import * as aiRuntime from "../services/ai-connection-runtime.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentTaskSessions, authUsers, companies, companyMemberships, createDb, executionWorkspaces, environments, heartbeatRuns, issues, plugins, projects } from "@paperclipai/db";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { requestTaskRetry } from "../services/task-retry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import * as environmentOrchestrator from "../services/environment-run-orchestrator.js";
import { createPluginWorkspaceFixture } from "./helpers/plugin-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping session preparation tests: ${support.reason}`);

describePostgres("heartbeat session preparation through adapter dispatch", () => {
  const adapterType = "session_preparation_test";
  const captured = new Map<string, AdapterExecutionContext>();
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-session-preparation-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType,
      supportsLocalAgentJwt: false,
      execute: async (input) => {
        captured.set(input.runId, input);
        // Settle the fixture's work so no automatic unfinished-task retry
        // competes with the next explicit session-continuation wake.
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, sessionId: "saved-session", sessionParams: { sessionId: "saved-session", adapterState: "preserved" }, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed(runtimeConfig: Record<string, unknown> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Session fixture", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: userId, name: "Session owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Session reader", adapterType, status: "idle", adapterConfig: { model: "model-a" }, runtimeConfig });
    await db.insert(issues).values({ id: issueId, companyId, title: "Session fixture", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    return { companyId, agentId, issueId, userId };
  }

  async function execute(f: Awaited<ReturnType<typeof seed>>, context: Record<string, unknown> = {}) {
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    const run = await heartbeat.wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "manual",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, ...context },
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const finished = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).then(rows => rows[0]);
    expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
    expect(captured.has(run!.id)).toBe(true);
    return { input: captured.get(run!.id)!, finished };
  }

  it("reuses unchanged task sessions and strips host freshness metadata before dispatch", async () => {
    const f = await seed();
    const first = await execute(f);
    expect(first.input.runtime.sessionId).toBeNull();
    const stored = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId)).then(rows => rows[0]);
    expect(stored?.sessionParamsJson).toHaveProperty("__paperclipConfigFingerprint");
    const resumed = await execute(f, { paperclipSessionHandoffMarkdown: "stale handoff", paperclipSessionRotationReason: "stale reason", paperclipPreviousSessionId: "stale session" });
    expect(resumed.input.runtime).toMatchObject({ sessionId: "saved-session", sessionDisplayId: "saved-session", taskKey: f.issueId });
    expect(resumed.input.runtime.sessionParams).toMatchObject({ sessionId: "saved-session", adapterState: "preserved" });
    expect(resumed.input.runtime.sessionParams).not.toHaveProperty("__paperclipConfigFingerprint");
    expect(resumed.input.context.paperclipSessionHandoffMarkdown).toBeUndefined();
    expect(resumed.input.context.paperclipSessionRotationReason).toBeUndefined();
    expect(resumed.input.context.paperclipPreviousSessionId).toBeUndefined();
    expect(resumed.finished.sessionIdBefore).toBe("saved-session");
  });

  it("keeps a default-attached project policy stable after binding a repository-free workspace", async () => {
    const f = await seed();
    const storage = await createPluginWorkspaceFixture(db, f.companyId);
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, storage.pluginId));
    await db.update(plugins).set({ manifestJson: { ...plugin.manifestJson, workspaceProvider: {
      ...plugin.manifestJson.workspaceProvider!, defaultForProjects: { mode: "isolated_workspace", strategy: "git_worktree" },
    } } }).where(eq(plugins.id, storage.pluginId));
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Directory project", executionWorkspacePolicy: { enabled: true, storageProviderPluginId: storage.pluginId } }).returning();
    await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
    try {
      const first = await execute(f);
      const [bound] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(bound.executionWorkspaceId).toEqual(expect.any(String));
      const next = await execute(f);
      expect(next.input.runtime.sessionId).toBe("saved-session");
      expect(next.input.config.workspaceStrategy).toEqual(first.input.config.workspaceStrategy);
      expect(next.finished.resultJson).toMatchObject({ configFreshness: {
        session: { reset: false, taskSessionReused: true, changedCategories: [] },
        workspace: { action: "reuse", workspaceReused: true, changedCategories: [], activeWorkspaceId: bound.executionWorkspaceId },
      } });
    } finally { await db.delete(plugins).where(eq(plugins.id, storage.pluginId)); }
  });

  it.each([
    { settings: null, retry: false },
    { settings: { mode: "isolated_workspace" }, retry: false },
    { settings: { workspaceStrategy: { type: "git_worktree", branchTemplate: "work" } }, retry: false },
    { settings: null, retry: true },
    { settings: null, retry: true, refuse: true },
  ])("keeps a default-attached repository policy stable through binding ($settings, Retry: $retry, refusal: $refuse)", async ({ settings, retry, refuse }) => {
    const f = await seed();
    const storage = await createPluginWorkspaceFixture(db, f.companyId);
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, storage.pluginId));
    const [environment] = await db.insert(environments).values({ name: `Storage tasks ${storage.pluginId}`, driver: "plugin", status: "active",
      config: { pluginKey: plugin.pluginKey, driverKey: "tasks", driverConfig: {} } }).returning();
    await db.update(plugins).set({ manifestJson: { ...plugin.manifestJson,
      capabilities: [...plugin.manifestJson.capabilities, "environment.drivers.register"],
      environmentDrivers: [{ driverKey: "tasks", displayName: "Tasks", supportsTasks: true, configSchema: { type: "object" },
        ...(refuse ? { freshWorkspaceVersion: 1 as const } : {}) }],
      workspaceProvider: { ...plugin.manifestJson.workspaceProvider!, defaultForProjects: { mode: "isolated_workspace", strategy: "git_worktree" },
        ...(retry ? { workspaceVerificationVersion: 1 as const } : {}),
        ...(refuse ? { freshWorkspaceVersion: 1 as const } : {}) },
    } }).where(eq(plugins.id, storage.pluginId));
    await db.update(agents).set({ defaultEnvironmentId: environment.id }).where(eq(agents.id, f.agentId));
    await db.update(projects).set({ executionWorkspacePolicy: { enabled: true, storageProviderPluginId: storage.pluginId } }).where(eq(projects.id, storage.input.projectId));
    await db.update(issues).set({ projectId: storage.input.projectId, projectWorkspaceId: storage.input.projectWorkspaceId,
      executionWorkspaceSettings: settings,
    }).where(eq(issues.id, f.issueId));
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true, enableIsolatedWorkspacesByDefault: true });
    const cwd = await mkdtemp(join(tmpdir(), "session-provider-fixture-"));
    const realizedBase = new Map<string, string | null | undefined>();
    const createOrchestrator = environmentOrchestrator.environmentRunOrchestrator;
    const realization = vi.spyOn(environmentOrchestrator, "environmentRunOrchestrator").mockImplementation((...args) => ({
      ...createOrchestrator(...args),
      // These tests dispatch a synthetic adapter; substitute only the provider
      // transport while preserving the configured storage/task-driver identity.
      acquireForRun: async input => createOrchestrator(...args).acquireForRun({ ...input, selectedEnvironmentId: input.localEnvironmentId }),
      realizeForRun: async input => {
        realizedBase.set(input.heartbeatRunId, input.executionWorkspace.baseRefSha);
        input.executionWorkspace.cwd = cwd;
        return { lease: input.lease, persistedExecutionWorkspace: input.persistedExecutionWorkspace,
          workspaceRealization: {}, executionTarget: null, remoteExecution: null };
      },
    }));
    const mode = refuse ? vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION,
    }) : undefined;
    const credentialAcquisition = vi.spyOn(aiRuntime, "prepareManagedAiRuntime");
    if (refuse) {
      const account = await aiConnectionService(db).save(f.companyId, f.userId, {
        provider: "openai", method: "api_key", ownership: "personal", name: "Retry fixture",
        apiKey: "fixture-key", agentIds: [], allAgents: true,
      }, "fixture-key");
      await db.update(agents).set({ adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex", model: "model-a" },
        runtimeConfig: { aiConnection: { provider: "openai", method: "api_key", mode: "delegated",
          connectionId: account.connectionId, grantId: account.grantId } },
      }).where(eq(agents.id, f.agentId));
      registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    }
    const originalHeartbeat = heartbeat;
    const storageWorkers = {
      ...storage.workers,
      call: async (...args: Parameters<typeof storage.workers.call>) => {
        const result = await storage.workers.call(...args) as Record<string, unknown>;
        const request = storage.calls.at(-1)!;
        if (request.operation.verifyExisting) {
          if (refuse) throw new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "Checkout unavailable",
            data: workspaceOperationErrorData(new PluginWorkspaceOperationError("binding_mismatch")),
          });
          return { ...result, created: false };
        }
        if (refuse && result.kind === "prepared" && request.operation.fresh) return { ...result, branchName: "work" };
        return result;
      },
    };
    heartbeat = heartbeatService(db, { pluginWorkerManager: storageWorkers as PluginWorkerManager });
    try {
      const first = await execute(f);
      const [bound] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(bound.executionWorkspaceId).toEqual(expect.any(String));
      expect(bound.executionWorkspacePreference).toBe("reuse_existing");
      expect(bound.executionWorkspaceSettings).toEqual({ ...settings, mode: "isolated_workspace" });
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, bound.executionWorkspaceId!));
      expect([...captured.values()].filter(input => input.context.issueId === f.issueId)).toHaveLength(1);
      expect(workspace).toMatchObject({ providerType: "plugin", strategyType: "git_worktree" });
      if (retry) {
        await db.update(heartbeatRuns).set({ status: "failed", errorCode: "setup_failed" })
          .where(eq(heartbeatRuns.id, first.finished.id));
        await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
        const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId,
          actorId: f.userId, actorSource: "local_implicit", observedRunId: first.finished.id, idempotencyKey: randomUUID() });
        expect(receipt.accepted).toBe(true);
        credentialAcquisition.mockClear();
        await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
        await heartbeat.drainActiveRunExecutions();
        const [resumed] = [...captured.values()].filter(input => input.context.issueId === f.issueId && input.runId !== first.finished.id);
        if (refuse) {
          expect(resumed?.runtime.sessionId).toBeNull();
          const finished = await heartbeat.getRun(resumed.runId);
          expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
          expect(credentialAcquisition).toHaveBeenCalledTimes(1);
          const [afterRetry] = await db.select().from(issues).where(eq(issues.id, f.issueId));
          expect(afterRetry.executionWorkspaceId).not.toBe(workspace.id);
          const [fresh] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, afterRetry.executionWorkspaceId!));
          expect(fresh).toMatchObject({ mode: "isolated_workspace", metadata: {
            workspaceProviderFresh: { previousWorkspaceId: workspace.id, sourceRunId: first.finished.id },
          } });
          expect(storage.calls.filter(call => call.runId === resumed.runId && call.operation.kind === "prepare"))
            .toMatchObject([{ executionWorkspaceId: workspace.id, operation: { verifyExisting: true } },
              { executionWorkspaceId: fresh.id, operation: { fresh: { previousWorkspaceId: workspace.id } } }]);
          return;
        }
        expect(resumed?.context.paperclipWorkspace).toMatchObject({ branchName: workspace.branchName });
        expect(realizedBase.get(first.finished.id)).toBe("a".repeat(40));
        expect(realizedBase.get(resumed.runId)).toBe(realizedBase.get(first.finished.id));
        const preparations = storage.calls.filter(call => call.runId === resumed.runId && call.operation.kind === "prepare");
        expect(preparations).toHaveLength(2);
        expect(preparations[0]).toMatchObject({ executionWorkspaceId: workspace.id, operation: { verifyExisting: true } });
        expect(preparations[1]).toMatchObject({ executionWorkspaceId: workspace.id });
        expect(preparations[1].operation.verifyExisting).toBeUndefined();
        const [afterRetry] = await db.select().from(issues).where(eq(issues.id, f.issueId));
        expect(afterRetry.executionWorkspaceId).toBe(workspace.id);
        return;
      }
      for (let turn = 0; turn < 2; turn++) {
        const next = await execute(f);
        expect(next.input.runtime.sessionId).toBe("saved-session");
        expect(next.input.config.workspaceStrategy).toEqual(first.input.config.workspaceStrategy);
        expect(next.finished.resultJson).toMatchObject({ configFreshness: {
          session: { reset: false, taskSessionReused: true, changedCategories: [] },
          workspace: { action: "reuse", workspaceReused: true, changedCategories: [], activeWorkspaceId: bound.executionWorkspaceId },
        } });
      }
      await db.update(projects).set({ executionWorkspacePolicy: { enabled: true, allowIssueOverride: false, storageProviderPluginId: storage.pluginId } }).where(eq(projects.id, storage.input.projectId));
      const changed = await execute(f);
      expect(changed.input.runtime.sessionId).toBeNull();
      expect(changed.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: true, changedCategories: ["workspaceConfig"] } } });
      const [retained] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, bound.executionWorkspaceId!));
      expect(retained.metadata?.workspaceProviderOwner).toBe(storage.pluginId);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      heartbeat = originalHeartbeat;
      realization.mockRestore();
      credentialAcquisition.mockRestore();
      mode?.mockRestore();
      if (refuse) unregisterServerAdapter("paperclip_runner");
      await rm(cwd, { recursive: true, force: true });
      await db.delete(plugins).where(eq(plugins.id, storage.pluginId));
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false, enableIsolatedWorkspacesByDefault: false });
    }
  });

  it("starts fresh when effective model configuration changes and persists the reason", async () => {
    const f = await seed();
    await execute(f);
    await db.update(agents).set({ adapterConfig: { model: "model-b" } }).where(eq(agents.id, f.agentId));
    const next = await execute(f);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.input.runtime.sessionParams).toBeNull();
    expect(next.finished.sessionIdBefore).toBeNull();
    expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: true, taskSessionAvailable: true, taskSessionReused: false } } });
  });

  it("refreshes tools with a fresh session when the selected adapter cannot refresh on resume", async () => {
    const f = await seed();
    await execute(f);
    const next = await execute(f, { refreshTools: true });
    expect(next.input.context.forceFreshSession).toBe(true);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { resetReasons: ["forceFreshSession was requested"] } } });
  });

  it("rotates a session at the configured run threshold and supplies a handoff", async () => {
    const f = await seed({ sessionCompaction: { enabled: true, maxSessionRuns: 1 } });
    await execute(f);
    await execute(f);
    const next = await execute(f);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.input.runtime.sessionParams).toBeNull();
    expect(next.input.context.paperclipPreviousSessionId).toBe("saved-session");
    expect(next.input.context.paperclipSessionRotationReason).toBe("session exceeded 1 runs");
    expect(next.input.context.paperclipSessionHandoffMarkdown).toEqual(expect.any(String));
    expect(next.finished.sessionIdBefore).toBeNull();
  });
});
