import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, aiConnectionRouterCursors, aiConnectionTaskPins, aiProviderDefaults, companies, companyMemberships, connectionGrants, createDb, environments, plugins } from "@paperclipai/db";
import type { AiConnectionPoolMember, AiConnectionRouterRequest, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { aiConnectionRouterService } from "../services/ai-connection-router.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import * as agentRunnerSelection from "../services/plugin-runner-ai-connection.js";
import * as aiRuntime from "../services/ai-connection-runtime.js";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { agentHarnessVerificationService } from "../services/agent-harness-verification.js";
import * as serverAdapters from "../adapters/index.js";
import * as environmentTests from "../services/agent-environment-test.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { secretService } from "../services/secrets.js";
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

  it.each([false, true])("filters unsupported plugin pool members before lifecycle allocation (mixed=%s)", async mixed => {
    const pluginKey = `fixture.lifecycle-${agent.companyId}`;
    const manifest: PaperclipPluginManifestV1 = { id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Pool", description: "Fixture", author: "Tests", categories: ["connector"], capabilities: ["ai.connections.route"], aiConnectionRouter: { name: "Pool", description: "Fixture" }, entrypoints: { worker: "worker.js" } };
    await db.insert(plugins).values({ pluginKey, packageName: pluginKey, version: "0.1.0", manifestJson: manifest, status: "ready" });
    await instanceSettingsService(db).updateExperimental({ enableAiConnectionRouters: true });
    const [environment] = await db.insert(environments).values({ name: `Lifecycle target ${agent.id}`, driver: "plugin", status: "active", config: { pluginKey: "fixture.environment", driverKey: "runner" } }).returning();
    const accounts = aiConnectionService(db);
    const gateway = await accounts.save(agent.companyId, userId, { provider: "openai", method: "api_key", ownership: "personal", name: "Gateway", apiKey: "fixture", allAgents: true, agentIds: [], routing: { kind: "gateway", protocol: "chat", auth: "bearer", baseUrl: "https://gateway.example/v1", models: [] } }, "fixture");
    const direct = await accounts.save(agent.companyId, userId, { provider: "openai", method: "api_key", ownership: "personal", name: "Direct", apiKey: "fixture", allAgents: true, agentIds: [] }, "fixture");
    const gatewayMember: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...gateway }, profile: { provider: "opencode", model: "qwen" } };
    const directMember: AiConnectionPoolMember = { id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...direct }, profile: { provider: "codex", model: "gpt-5.6-sol" } };
    const pool = await aiConnectionRouterService(db).save(pluginKey, { companyId: agent.companyId, config: { name: "Lifecycle pool", enabled: true, mode: "round_robin", thresholdPercent: 90, members: mixed ? [gatewayMember, directMember] : [gatewayMember] } }, userId);
    [agent] = await db.update(agents).set({ adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
      adapterConfig: { provider: "opencode", model: "paperclip/qwen" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id } },
      lifecycleOperation: { id: randomUUID(), hostComplete: true, completedPluginIds: [], attempts: 0, responsibleUserId: userId },
    }).where(eq(agents.id, agent.id)).returning();
    vi.mocked(environmentTests.agentEnvironmentTestService).mockImplementation((database, manager) => ({
      ...realEnvironmentTests(database, manager), resolveAdapterTestExecutionContext: allocate, testManagedEnvironment: probe,
    }));
    vi.spyOn(agentRunnerSelection, "pluginEnvironmentRunnerTaskDriver").mockResolvedValue({ driverKey: "runner", supportsTasks: true } as NonNullable<Awaited<ReturnType<typeof agentRunnerSelection.pluginEnvironmentRunnerTaskDriver>>>);
    const managed = vi.spyOn(aiRuntime, "withManagedAiProbe").mockRejectedValue(new Error("Reached supported credential preparation"));
    const call = vi.fn(async (_id: string, _method: string, request: AiConnectionRouterRequest) => request.candidates[0]
      ? { kind: "selected", memberId: request.candidates[0].member.id } : { kind: "unavailable", skipped: {} });
    const manager = { isRunning: () => true, call } as unknown as PluginWorkerManager;
    const service = agentHarnessVerificationService(db, manager);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(service.verify(agent)).rejects.toThrow(mixed ? "Reached supported credential preparation" : "No pool account");
      expect(call.mock.calls[attempt]?.[2].candidates.map(candidate => candidate.member.id)).toEqual(mixed ? [directMember.id] : []);
      const pins = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, pool.id));
      expect(pins).toHaveLength(mixed ? 1 : 0);
      if (mixed) expect(pins[0]?.selection).toMatchObject({ memberId: directMember.id, binding: directMember.binding, runtimeConfig: { provider: "codex" } });
      expect((await db.select().from(aiConnectionRouterCursors).where(eq(aiConnectionRouterCursors.poolId, pool.id)))[0]?.version).toBe(mixed ? 1 : 0);
    }
    expect(allocate).toHaveBeenCalledTimes(mixed ? 2 : 0);
    expect(managed).toHaveBeenCalledTimes(mixed ? 2 : 0);
    expect(probe).not.toHaveBeenCalled();
    if (mixed) expect(release).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
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

  it("reuses a passed verification of the same configuration and tests again after a change", async () => {
    await expect(verify()).resolves.toBe("complete");
    expect(allocate).toHaveBeenCalledOnce();
    const [verified] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(verified!.harnessVerifiedDigest).toMatch(/^v2:hmac-sha256:[a-f0-9]{64}$/);
    // A restart, or a return to verifying, never boots another test target.
    await expect(verify()).resolves.toBe("complete");
    expect(allocate).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();
    // Account checks still run: a revoked account fails before any reuse.
    const [grant] = await db.select({ status: connectionGrants.status }).from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, account.grantId));
    await expect(verify()).rejects.toThrow("Reconnect or validate the selected AI account");
    await db.update(connectionGrants).set({ status: grant!.status }).where(eq(connectionGrants.id, account.grantId));
    // A changed configuration is a new configuration, including values a
    // session fingerprint ignores (cwd) and literal credentials.
    const model = "openrouter/anthropic/claude-sonnet-4.5";
    let calls = 1;
    for (const adapterConfig of [{ model: "openrouter/openai/gpt-5.1" }, { model, cwd: "/tmp/paperclip-missing-directory" },
      { model, env: { FIXTURE_TOKEN: "first-literal" } }, { model, env: { FIXTURE_TOKEN: "second-literal" } }]) {
      await db.update(agents).set({ adapterConfig }).where(eq(agents.id, agent.id));
      await expect(verify()).resolves.toBe("complete");
      expect(allocate).toHaveBeenCalledTimes(++calls);
    }
    // The digest is keyed: it is not a plain hash a reader could recompute.
    const [stored] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(stored!.harnessVerifiedDigest).not.toContain("second-literal");
  });

  it("tests again after the selected AI account's credential rotates", async () => {
    await expect(verify()).resolves.toBe("complete");
    const [grant] = await db.select({ refs: connectionGrants.credentialSecretRefs }).from(connectionGrants)
      .where(eq(connectionGrants.id, account.grantId));
    const secretIds = (grant?.refs ?? []).map(ref => ref.secretId);
    expect(secretIds.length).toBeGreaterThan(0);
    await secretService(db).rotate(secretIds[0]!, { value: "fixture-rotated-key" }, { userId });
    await expect(verify()).resolves.toBe("complete");
    expect(allocate).toHaveBeenCalledTimes(2);
  });

  it("keeps a pass whose probe refreshed its own credential, never one rotated by a person meanwhile", async () => {
    const [grant] = await db.select({ refs: connectionGrants.credentialSecretRefs }).from(connectionGrants)
      .where(eq(connectionGrants.id, account.grantId));
    const secretId = grant!.refs[0]!.secretId;
    // The subscription refresh write-back keeps the AI session epoch.
    probe.mockImplementationOnce(async () => {
      await secretService(db).rotate(secretId, { value: "fixture-refreshed-key", preserveAiSessionEpoch: true }, { userId });
      return passed;
    });
    await expect(verify()).resolves.toBe("complete");
    await expect(verify()).resolves.toBe("complete");
    expect(allocate).toHaveBeenCalledOnce();
    // A person's rotation during the probe bumps the epoch: nothing is recorded.
    await db.update(agents).set({ harnessVerifiedDigest: null }).where(eq(agents.id, agent.id));
    probe.mockImplementationOnce(async () => {
      await secretService(db).rotate(secretId, { value: "fixture-person-rotated-key" }, { userId });
      return passed;
    });
    await expect(verify()).resolves.toBe("complete");
    expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0]!.harnessVerifiedDigest).toBeNull();
  });

  it("records nothing when the probe tested a different account than the digest describes (A, then B, then A)", async () => {
    const other = await aiConnectionService(db).save(agent.companyId, userId, {
      provider: "openrouter", method: "api_key", ownership: "personal", name: "Second account",
      apiKey: "fixture-second-key", allAgents: true, agentIds: [],
    }, "fixture-second-key");
    // Switch to B after verify() selected A, before the probe selects its account.
    allocate.mockImplementationOnce(async () => {
      await aiConnectionService(db).setDefault(agent.companyId, userId, other.grantId);
      return { executionTarget: null, environmentName: "Fixture execution target", fallbackChecks: [], release };
    });
    // The probe tests B; switch back to A before verify() could look again.
    probe.mockImplementationOnce(async () => {
      await aiConnectionService(db).setDefault(agent.companyId, userId, account.grantId);
      return passed;
    });
    await expect(verify()).resolves.toBe("complete");
    expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0]!.harnessVerifiedDigest).toBeNull();
  });

  it("never reuses a local probe that may use the host's own credentials", async () => {
    const localProbe = vi.fn().mockResolvedValue(passed);
    vi.spyOn(serverAdapters, "requireServerAdapter").mockReturnValue({ testEnvironment: localProbe } as never);
    await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, agent.id));
    await expect(verify()).resolves.toBe("complete");
    await expect(verify()).resolves.toBe("complete");
    expect(localProbe).toHaveBeenCalledTimes(2);
    expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0]!.harnessVerifiedDigest).toBeNull();
  });

  it("does not record a failed verification", async () => {
    probe.mockResolvedValueOnce({ ...passed, status: "fail", checks: [{ code: "opencode_hello_probe_timed_out", level: "error", message: "timed out" }] });
    await expect(verify()).rejects.toMatchObject({ code: "harness_probe_timed_out" });
    const [failed] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(failed!.harnessVerifiedDigest).toBeNull();
    await expect(verify()).resolves.toBe("complete");
    expect(allocate).toHaveBeenCalledTimes(2);
  });
});
