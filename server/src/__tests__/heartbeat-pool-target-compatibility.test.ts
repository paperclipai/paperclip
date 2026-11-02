import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, aiConnectionRouterCursors, aiConnectionTaskPins, authUsers, companies, companyMemberships, createDb, environments, issues, plugins } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { AiConnectionRouterRequest, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { aiConnectionService } from "../services/ai-connections.js";
import { aiConnectionRouterService } from "../services/ai-connection-router.js";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentService } from "../services/environments.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import * as agentRunnerSelection from "../services/agent-runner-selection.js";
import * as workspacePreparation from "../services/heartbeat/workspace-preparation.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { waitForPendingRunFailureReports } from "../services/run-failure-report.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "pool-target-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "pool-target");
  database = await startEmbeddedPostgresTestDatabase("pool-target-db-");
  db = createDb(database.connectionString);
}, 90_000);
afterAll(async () => {
  await waitForPendingRunFailureReports();
  await db?.$client.end();
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

async function fixture(pluginDefault = true) {
  const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Pool target", issuePrefix: `P${companyId.slice(0, 6)}` });
  await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
  const [environment] = await db.insert(environments).values({ name: `Plugin Runner ${companyId}`, driver: "plugin", status: "active", config: { pluginKey: "fixture.environment", driverKey: "runner" } }).returning();
  const pluginKey = `fixture.pool-${companyId}`;
  const manifest: PaperclipPluginManifestV1 = { id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Pool", description: "Fixture", author: "Tests", categories: ["connector"], capabilities: ["ai.connections.route"], aiConnectionRouter: { name: "Pool", description: "Fixture" }, entrypoints: { worker: "worker.js" } };
  await db.insert(plugins).values({ pluginKey, packageName: pluginKey, version: "0.1.0", manifestJson: manifest, status: "ready" });
  await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true, enableNativeRunner: true, enableWorktreeRunExecution: true, enableManagedSandboxOnly: false });
  const account = await aiConnectionService(db).save(companyId, userId, { provider: "openai", method: "api_key", ownership: "personal", name: "Chat", apiKey: "fixture", allAgents: true, agentIds: [], routing: { kind: "gateway", protocol: "chat", auth: "bearer", baseUrl: "https://gateway.example/v1", models: [] } }, "fixture");
  const pool = await aiConnectionRouterService(db).save(pluginKey, { companyId, config: { name: "Target pool", enabled: true, mode: "round_robin", thresholdPercent: 90, members: [{ id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...account }, profile: { provider: "opencode", model: "qwen" } }] } }, userId);
  const local = await environmentService(db).ensureLocalEnvironment(companyId);
  await db.insert(agents).values({ id: agentId, companyId, name: "Target agent", adapterType: "paperclip_runner", defaultEnvironmentId: pluginDefault ? environment.id : local.id, adapterConfig: { provider: "opencode", model: "paperclip/qwen", cwd: home }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id }, heartbeat: { enabled: false, wakeOnDemand: true } } });
  const call = vi.fn(async (_id: string, _method: string, request: AiConnectionRouterRequest) => request.candidates[0]
    ? { kind: "selected", memberId: request.candidates[0].member.id }
    : { kind: "unavailable", skipped: {} });
  const worker = { isRunning: () => true, call } as unknown as PluginWorkerManager;
  const provider = vi.fn(() => { throw new Error("Unexpected provider start"); });
  const heartbeat = heartbeatService(db, { pluginWorkerManager: worker, runtimeEnv: {}, nativeSessionBackendFactory: provider });
  const wake = async (issueId?: string) => {
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", reason: "manual", triggerDetail: "manual", contextSnapshot: { responsibleUserId: userId, wakeReason: "manual", ...(issueId ? { issueId } : {}) } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    return (await heartbeat.getRun(run!.id))!;
  };
  const pins = () => db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id));
  const version = async () => (await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)))[0]?.version;
  return { companyId, agentId, userId, environment, pool, call, provider, heartbeat, wake, pins, version };
}

const runnerDriver = () => vi.spyOn(agentRunnerSelection, "pluginEnvironmentRunnerTaskDriver").mockResolvedValue({ driverKey: "runner", supportsTasks: true } as NonNullable<Awaited<ReturnType<typeof agentRunnerSelection.pluginEnvironmentRunnerTaskDriver>>>);

describe("heartbeat pool target compatibility", () => {
  it("rejects an unsupported plugin environment before committing a pool pin or starting a provider", async () => {
    const f = await fixture();
    const driver = runnerDriver();
    try {
      const saved = await f.wake();
      expect(saved.status).toBe("failed");
      expect(saved.errorCode).toBe("configuration_incomplete");
      expect(saved.contextSnapshot?.aiRouterSelection).toBeUndefined();
      expect(f.call).toHaveBeenCalledOnce();
      expect(f.call.mock.calls[0]?.[2].candidates).toEqual([]);
      expect(driver).toHaveBeenCalledWith(db, expect.objectContaining({ id: f.environment.id, driver: "plugin" }));
      expect(f.provider).not.toHaveBeenCalled();
      expect(await f.pins()).toHaveLength(0);
      expect(await f.version()).toBe(0);
    } finally {
      await f.heartbeat.drainActiveRunExecutions();
      driver.mockRestore();
    }
  }, 30_000);

  it("rejects a newly realized incompatible target after admitting and pinning a local selection", async () => {
    const f = await fixture(false);
    const prepare = workspacePreparation.prepareHeartbeatWorkspace;
    const realized = vi.spyOn(workspacePreparation, "prepareHeartbeatWorkspace").mockImplementation(async (...args) => ({
      ...await prepare(...args),
      executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: home, runnerTask: async () => { throw new Error("Unexpected plugin dispatch"); } },
    }));
    try {
      const saved = await f.wake();
      expect(realized).toHaveBeenCalledOnce();
      expect(saved.status).toBe("failed");
      expect(saved.errorCode).toBe("configuration_incomplete");
      expect(saved.error).toBe("Plugin Runner does not support this managed credential provider or routing");
      expect(saved.resultJson?.configurationIncomplete).toMatchObject({ reason: "ai_connection_incompatible" });
      expect(f.call.mock.calls[0]?.[2].candidates).toHaveLength(1);
      expect(await f.pins()).toHaveLength(1);
      expect(await f.version()).toBe(1);
      expect(f.provider).not.toHaveBeenCalled();
    } finally {
      await f.heartbeat.drainActiveRunExecutions();
      realized.mockRestore();
    }
  }, 30_000);

  it("uses the low-trust task sandbox rather than filtering by the agent's plugin default", async () => {
    const f = await fixture();
    const [sandbox] = await db.insert(environments).values({ name: "Task sandbox", driver: "sandbox", status: "active", config: { provider: "fake" } }).returning();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Sandbox task", status: "todo", assigneeAgentId: f.agentId,
      executionWorkspaceSettings: { mode: "isolated_workspace", environmentId: sandbox.id },
      executionPolicy: { trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review", trustBoundary: { mode: "low_trust_review", companyId: f.companyId, rootIssueId: issueId } } },
    });
    const driver = runnerDriver();
    const stopped = vi.spyOn(workspacePreparation, "prepareHeartbeatWorkspace").mockRejectedValue(new Error("Stopped at sandbox realization boundary"));
    try {
      const saved = await f.wake(issueId);
      expect(f.call).toHaveBeenCalledOnce();
      expect(f.call.mock.calls[0]?.[2].candidates).toHaveLength(1);
      expect(await f.pins()).toHaveLength(1);
      expect(await f.version()).toBe(1);
      expect(stopped).toHaveBeenCalledOnce();
      expect(stopped.mock.calls[0]?.[1].environment.selectedEnvironmentForConfig?.id).toBe(sandbox.id);
      expect(saved.error).toBe("Stopped at sandbox realization boundary");
      expect(f.provider).not.toHaveBeenCalled();
      expect(driver).not.toHaveBeenCalled();
    } finally {
      await f.heartbeat.drainActiveRunExecutions();
      stopped.mockRestore();
      driver.mockRestore();
    }
  }, 30_000);

  it.each(["kubernetes", "managed_sandbox"] as const)("preserves the actionable global %s environment failure before pool routing", async policy => {
    const f = await fixture(false);
    const settings = instanceSettingsService(db);
    if (policy === "kubernetes") await settings.updateGeneral({ executionMode: "kubernetes" });
    else await settings.updateExperimental({ enableManagedSandboxOnly: true });
    try {
      const saved = await f.wake();
      expect(saved.status).toBe("failed");
      expect(saved.error).toContain(policy === "kubernetes" ? "no managed Kubernetes environment" : "managed sandbox");
      expect(saved.error).not.toContain("No pool account");
      expect(saved.resultJson?.configurationIncomplete).not.toMatchObject({ reason: "ai_connection_unavailable" });
      expect(f.call).not.toHaveBeenCalled();
      expect(await f.pins()).toHaveLength(0);
      expect(await f.version()).toBe(0);
      expect(f.provider).not.toHaveBeenCalled();
    } finally {
      await settings.updateGeneral({ executionMode: "any" });
      await settings.updateExperimental({ enableManagedSandboxOnly: false });
      await f.heartbeat.drainActiveRunExecutions();
    }
  }, 30_000);
});
