import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, applyPendingMigrations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environments, environmentLeases, executionWorkspaces, heartbeatRuns, plugins, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requireServerAdapter } from "../adapters/index.js";
import { agentHarnessVerificationService } from "../services/agent-harness-verification.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { environmentService } from "../services/environments.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_PROVIDER_API_LIFECYCLE_TEST_DATABASE_URL");
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("Cursor Cloud API controller activation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;
  let companyId: string;
  const workers: ReturnType<typeof configureAgentLifecycle>[] = [];
  const config = { provider: "cursor_cloud", model: "caller-model", repoUrl: "https://github.com/example/qualification",
    lifecycleMode: "per_turn", env: { CURSOR_API_KEY: "synthetic-cursor-key" } };
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://callback.example.test/mcp/native-runs/") && init?.method === "POST") return new Response(null, { status: 401 });
    if (url === "https://api.cursor.com/v1/models" && init?.method === "GET") return new Response(JSON.stringify({ items: [{ id: config.model, displayName: "Caller model" }] }), { headers: { "Content-Type": "application/json" } });
    throw new Error(`Unexpected provider request: ${init?.method} ${url}`);
  });

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paperclip-provider-api-lifecycle-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
    vi.stubEnv("PAPERCLIP_SETTING_DEFAULTS", undefined);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://callback.example.test");
    if (externalDatabaseUrl) await applyPendingMigrations(externalDatabaseUrl);
    database = externalDatabaseUrl ? { connectionString: externalDatabaseUrl, cleanup: async () => {} }
      : await startEmbeddedPostgresTestDatabase("paperclip-provider-api-lifecycle-");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  beforeEach(async () => {
    for (const worker of workers) await worker.stop();
    await instanceSettingsService(db).update({ defaultEnvironmentId: null });
    await db.execute(sql`truncate table companies, plugins, environments restart identity cascade`);
    await instanceSettingsService(db).updateGeneral({ executionMode: "any" });
    await instanceSettingsService(db).updateExperimental({ enableManagedSandboxOnly: true, enableNativeRunner: true });
    [companyId] = await db.insert(companies).values({ name: "API controller activation", issuePrefix: "API" }).returning({ id: companies.id }).then(rows => rows.map(row => row.id));
    fetch.mockClear();
    vi.stubGlobal("fetch", fetch);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(async () => {
    for (const worker of workers) await worker.stop();
    await db?.$client.end();
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  const current = (id: string) => db.select().from(agents).where(eq(agents.id, id)).then(rows => rows[0]!);
  async function saved(adapterType = "paperclip_runner", adapterConfig = config) {
    return (await db.insert(agents).values({ companyId, name: "Saved controller", adapterType, adapterConfig,
      status: "paused", lifecycleState: "verifying" }).returning())[0]!;
  }
  async function noComputerWork() {
    expect(await db.select().from(environmentLeases)).toHaveLength(0);
    expect(await db.select().from(executionWorkspaces)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  }

  it.each([false, true])("finishes the same held draft and reaches Ready with an experimental account WARN, inherited plugin Computer=%s", async defaultComputer => {
    if (defaultComputer) {
      const pluginId = randomUUID();
      await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "unneeded-computer", version: "1.0.0", status: "ready",
        manifestJson: { capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", requiresAgent: true, supportsTasks: true, warmTaskVersion: 1 }] } as never });
      const [computer] = await db.insert(environments).values({ name: "Inherited Computer", driver: "plugin", status: "active",
        config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } }).returning();
      await instanceSettingsService(db).update({ defaultEnvironmentId: computer.id });
    }
    expect(await environmentService(db).findManagedSandboxEnvironment(companyId)).toBeNull();
    const lifecycle = createAgentLifecycle(db);
    const draft = await lifecycle.requestHire(companyId, { name: "Cursor setup", adapterType: "paperclip_runner",
      adapterConfig: { provider: "cursor_cloud" } }, { setupOnly: true, runnerResolved: true });
    expect(draft).toMatchObject({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["setup"], defaultEnvironmentId: null });
    await lifecycle.updateConfiguration(draft.id, { adapterConfig: config, runtimeConfig: { heartbeat: { enabled: false } } });
    expect(await current(draft.id)).toMatchObject({ lifecycleState: "paused", lifecycleHolds: ["setup"] });
    const finished = await lifecycle.requestHire(companyId, { id: draft.id, name: draft.name, adapterType: "paperclip_runner",
      adapterConfig: config, runtimeConfig: { heartbeat: { enabled: false } }, defaultEnvironmentId: null }, { setupAgentId: draft.id, runnerResolved: true });
    expect(finished.id).toBe(draft.id);
    expect(finished.adapterConfig.lifecycleMode).toBe("per_turn");
    const probe = vi.spyOn(requireServerAdapter("paperclip_runner"), "testEnvironment");
    const driver = createLifecycleDriver(db, {} as never);
    const worker = configureAgentLifecycle(db, driver);
    workers.push(worker);
    await worker.process(draft.id);
    expect(await current(draft.id)).toMatchObject({ status: "idle", lifecycleState: "ready", lifecycleHolds: [], defaultEnvironmentId: null });
    expect(probe).toHaveBeenCalledOnce();
    expect(await probe.mock.results[0]!.value).toMatchObject({ status: "warn", checks: [
      { code: "cursor_cloud_account_ready", level: "info" },
      { code: "cursor_cloud_model_listed", level: "info" },
      { code: "cursor_cloud_model_identity_unverified", level: "warn" },
    ] });
    expect(fetch.mock.calls.map(([url, input]) => [String(url), input?.method])).toEqual([
      ["https://callback.example.test/mcp/native-runs/00000000-0000-4000-8000-000000000000", "POST"],
      ["https://api.cursor.com/v1/models", "GET"],
    ]);
    await noComputerWork();
  });

  it("keeps native Computer-backed setup preparation and warm-task defaults", async () => {
    const pluginId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "required-computer", version: "1.0.0", status: "ready",
      manifestJson: { capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", requiresAgent: true, supportsTasks: true, warmTaskVersion: 1 }] } as never });
    const [computer] = await db.insert(environments).values({ name: "Required Computer", driver: "plugin", status: "active",
      config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } }).returning();
    await instanceSettingsService(db).update({ defaultEnvironmentId: computer.id });
    const draft = await createAgentLifecycle(db).requestHire(companyId, { name: "Codex setup", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-luna", lifecycleMode: "per_turn" } }, { setupOnly: true, runnerResolved: true });
    expect(draft).toMatchObject({ status: "paused", lifecycleState: "preparing", lifecycleHolds: ["setup"], adapterConfig: { lifecycleMode: "warm" } });
    expect(fetch).not.toHaveBeenCalled();
    await noComputerWork();
  });

  it("verifies a saved native controller without resolving an unavailable managed Computer", async () => {
    const agent = await saved();
    await expect(agentHarnessVerificationService(db, {} as never).verify(agent)).resolves.toBe("complete");
    expect(fetch).toHaveBeenCalledTimes(2);
    await noComputerWork();
  });

  it("rejects Kubernetes-only activation before any provider probe", async () => {
    const agent = await saved();
    await instanceSettingsService(db).updateGeneral({ executionMode: "kubernetes" });
    await expect(agentHarnessVerificationService(db, {} as never).verify(agent)).rejects.toMatchObject({
      status: 422, details: { code: "provider_api_kubernetes_execution_unsupported" },
    });
    await expect(createAgentLifecycle(db).requestHire(companyId, { name: "Forbidden hire", adapterType: "paperclip_runner", adapterConfig: config }, { runnerResolved: true }))
      .rejects.toMatchObject({ status: 422, details: { code: "provider_api_kubernetes_execution_unsupported" } });
    expect(fetch).not.toHaveBeenCalled();
    await noComputerWork();
  });

  it("does not grant API placement to an incomplete active profile", async () => {
    const agent = await saved("paperclip_runner", { ...config, model: "" });
    await expect(agentHarnessVerificationService(db, {} as never).verify(agent)).rejects.toMatchObject({ code: "paperclip_runner_cursor_cloud_model_required" });
    expect(fetch).not.toHaveBeenCalled();
    await noComputerWork();
  });

  it.each(["opencode_local", "cursor_cloud"])("preserves the managed Computer requirement for %s", async adapterType => {
    const agent = await saved(adapterType);
    await expect(agentHarnessVerificationService(db, {} as never).verify(agent)).rejects.toMatchObject({ details: { code: "managed_sandbox_unavailable" } });
    expect(fetch).not.toHaveBeenCalled();
    await noComputerWork();
  });
});
