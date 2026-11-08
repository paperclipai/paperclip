import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, aiProviderDefaults, companies, companyMemberships, connectionGrants, createDb, environments, plugins } from "@paperclipai/db";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import * as modelCatalog from "../services/openrouter-models.js";
import * as adapters from "../adapters/index.js";
import { harnessPoolService } from "../services/harness-pools.js";
import { agentHarnessVerificationService } from "../services/agent-harness-verification.js";
import * as environmentTests from "../services/agent-environment-test.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { readAiConnectionConfigurationFailure } from "../services/ai-connection-configuration-failure.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const realEnvironmentTests = environmentTests.agentEnvironmentTestService;

describePostgres("saved harness account preflight", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let agent: typeof agents.$inferSelect;
  let userId: string;
  let account: { connectionId: string; grantId: string };
  let fixtureNumber = 0;
  const binding = { provider: "openrouter", method: "api_key", mode: "responsible_user" } as const;
  const passed: AdapterEnvironmentTestResult = {
    adapterType: "opencode_local", status: "pass", testedAt: new Date().toISOString(),
    checks: [{ code: "opencode_hello_probe_passed", level: "info", message: "Fixture probe passed" }],
  };
  const release = vi.fn<(status?: "released" | "failed") => Promise<void>>();
  const allocate = vi.fn<ReturnType<typeof realEnvironmentTests>["resolveAdapterTestExecutionContext"]>();
  const probe = vi.fn<ReturnType<typeof realEnvironmentTests>["testManagedEnvironment"]>();
  const verify = () => agentHarnessVerificationService(db, {} as PluginWorkerManager).verify(agent);

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-harness-preflight-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "harness-preflight-fixture");
    database = await startEmbeddedPostgresTestDatabase("paperclip-harness-preflight-db-");
    db = createDb(database.connectionString);
  }, 90_000);

  beforeEach(async () => {
    release.mockReset().mockResolvedValue(undefined);
    allocate.mockReset().mockResolvedValue({
      executionTarget: null, environmentName: "Fixture execution target", fallbackChecks: [], release,
    });
    probe.mockReset().mockResolvedValue(passed);
    vi.spyOn(environmentTests, "agentEnvironmentTestService").mockImplementation((database, manager) => ({
      ...realEnvironmentTests(database, manager),
      resolveAdapterTestEnvironmentId: vi.fn().mockResolvedValue(null),
      resolveAdapterTestExecutionContext: allocate,
      testManagedEnvironment: probe,
    }));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider request"));
    const companyId = randomUUID();
    userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Harness preflight", issuePrefix: `HP${++fixtureNumber}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    [agent] = await db.insert(agents).values({
      companyId, name: "Fixture agent", adapterType: "opencode_local", lifecycleState: "verifying",
      adapterConfig: { model: "openrouter/anthropic/claude-sonnet-4.5" }, runtimeConfig: { aiConnection: binding },
    }).returning();
    account = await aiConnectionService(db).save(companyId, userId, {
      provider: "openrouter", method: "api_key", ownership: "personal", name: "Fixture account",
      apiKey: "fixture-preflight-key", allAgents: true, agentIds: [],
    }, "fixture-preflight-key");
    await aiConnectionService(db).setDefault(companyId, userId, account.grantId);
  });

  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("rejects a missing default before allocating a target", async () => {
    await db.delete(aiProviderDefaults).where(eq(aiProviderDefaults.companyId, agent.companyId));
    const failure = await verify().catch(error => error);
    expect(readAiConnectionConfigurationFailure(failure)).toBe("ai_connection_default_missing");
    expect(allocate).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("rejects a revoked account before allocating a target", async () => {
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, account.grantId));
    await expect(verify()).rejects.toThrow("Reconnect or validate the selected AI account");
    expect(allocate).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects incompatible model routing before allocating a target", async () => {
    await db.update(agents).set({ adapterConfig: { model: "openai/gpt-5" } }).where(eq(agents.id, agent.id));
    await expect(verify()).rejects.toThrow("Select an AI connection compatible with this harness and model");
    expect(allocate).not.toHaveBeenCalled();
  });

  it("runs a valid managed probe and releases its target", async () => {
    await expect(verify()).resolves.toBe("complete");
    expect(allocate).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0][1].config.env).toMatchObject({ OPENROUTER_API_KEY: "fixture-preflight-key" });
    expect(release).toHaveBeenCalledExactlyOnceWith("released");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])("verifies the saved native pool member instead of ambient credentials (revoked=%s)", async revoked => {
    vi.spyOn(modelCatalog, "listOpenRouterModels").mockResolvedValue([{ id: "openrouter/anthropic/claude-sonnet-4.5", label: "Fixture model" }]);
    const pool = await harnessPoolService(db).save(agent.companyId, { config: {
      schemaVersion: 2, kind: "harness_pool", name: "Lifecycle Pool", enabled: true, mode: "failover", members: [{
        id: randomUUID(), harness: { type: "opencode" }, connection: { mode: "delegated", provider: "openrouter", method: "api_key", ...account },
        model: "openrouter/anthropic/claude-sonnet-4.5",
      }],
    } }, userId);
    [agent] = await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex" },
      runtimeConfig: { harnessPool: { poolId: pool.id } }, lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0 },
    }).where(eq(agents.id, agent.id)).returning();
    const nativeAdapter = adapters.requireServerAdapter("paperclip_runner");
    const ambient = vi.fn().mockResolvedValue({ ...passed, adapterType: "paperclip_runner", status: "fail", checks: [] });
    vi.spyOn(adapters, "requireServerAdapter").mockReturnValue({ ...nativeAdapter, testEnvironment: ambient });
    if (revoked) {
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, account.grantId));
      await expect(verify()).rejects.toThrow("No pool account is permitted");
      expect(allocate).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
    } else {
      await expect(verify()).resolves.toBe("complete");
      expect(probe).toHaveBeenCalledOnce();
      expect(probe.mock.calls[0][1].config).toMatchObject({ provider: "opencode", model: "openrouter/anthropic/claude-sonnet-4.5" });
      expect(probe.mock.calls[0][1].config.env).toMatchObject({ OPENROUTER_API_KEY: "fixture-preflight-key" });
      expect(release).toHaveBeenCalledExactlyOnceWith("released");
    }
    expect(ambient).not.toHaveBeenCalled();
  });

  it("checks account access again after allocation and releases on revocation", async () => {
    allocate.mockImplementationOnce(async () => {
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, account.grantId));
      return { executionTarget: null, environmentName: "Fixture execution target", fallbackChecks: [], release };
    });
    await expect(verify()).rejects.toThrow("Reconnect or validate the selected AI account");
    expect(allocate).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith("failed");
  });

  it("releases the target when the managed probe fails", async () => {
    probe.mockRejectedValueOnce(new Error("Fixture probe failure"));
    await expect(verify()).rejects.toThrow("Fixture probe failure");
    expect(release).toHaveBeenCalledExactlyOnceWith("failed");
  });

  async function useRunnerTaskEnvironment(runtimeConfig: Record<string, unknown>, homeMode?: string) {
    const pluginId = randomUUID(), pluginKey = `test.runner-tasks.${pluginId}`;
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@test/runner-tasks", version: "1.0.0", apiVersion: 1,
      categories: ["automation"], status: "ready", manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0",
        displayName: "Runner tasks", description: "Runner task fixture", author: "Paperclip", categories: ["automation"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "worker.js" },
        environmentDrivers: [{ driverKey: "tasks", displayName: "Tasks", supportsTasks: true, configSchema: { type: "object" } }] } } as any);
    const [environment] = await db.insert(environments).values({ name: `Runner tasks ${pluginId}`, driver: "plugin", status: "active",
      config: { pluginKey, driverKey: "tasks", driverConfig: {} } }).returning();
    vi.mocked(environmentTests.agentEnvironmentTestService).mockImplementation((database, manager) => ({
      ...realEnvironmentTests(database, manager),
      resolveAdapterTestEnvironmentId: vi.fn().mockResolvedValue(environment.id),
      assertAdapterTestEnvironmentForCompany: vi.fn().mockResolvedValue(undefined),
      resolveAdapterTestExecutionContext: allocate,
      testManagedEnvironment: probe,
    }));
    [agent] = await db.update(agents).set({ adapterType: "paperclip_runner", runtimeConfig,
      adapterConfig: { provider: "opencode", model: "openrouter/anthropic/claude-sonnet-4.5", ...(homeMode ? { homeMode } : {}) } })
      .where(eq(agents.id, agent.id)).returning();
  }

  it("refuses a plugin Runner-task agent without a managed AI connection before allocating a target", async () => {
    await useRunnerTaskEnvironment({});
    await expect(verify()).rejects.toMatchObject({ code: "ai_connection_required", message: expect.stringContaining("Choose an AI connection") });
    expect(allocate).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses a preconfigured Runner home with a saved connection before allocating a target", async () => {
    await useRunnerTaskEnvironment({ aiConnection: binding }, "preconfigured");
    await expect(verify()).rejects.toMatchObject({ code: "ai_connection_required", message: expect.stringContaining("isolated Runner home") });
    expect(allocate).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("verifies a plugin Runner-task agent with a managed AI connection", async () => {
    await useRunnerTaskEnvironment({ aiConnection: binding });
    await expect(verify()).resolves.toBe("complete");
    expect(allocate).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();
  });
});
