import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environments,
  heartbeatRuns,
  plugins,
  type Db,
} from "@paperclipai/db";
import type { Environment, PaperclipPluginManifestV1, PluginEnvironmentDriverDeclaration } from "@paperclipai/shared";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { resolveSandboxProviderSecretRefPaths } from "../services/environment-config.ts";
import { pluginRegistryService } from "../services/plugin-registry.ts";
import { pluginLoader } from "../services/plugin-loader.ts";
import { secretService } from "../services/secrets.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";

const support = await getEmbeddedPostgresTestSupport();
const PROVIDER_SCHEMA_STATEMENT = "with selected_provider as materialized";
const SCHEMA_REUSE_BOUND_MS = 5_000;

describe.skipIf(!support.supported)("sandbox provider schema reads on the live remote-run path", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let seedDb: Db;
  const clients: Db[] = [];
  const meters: Array<ReturnType<typeof meterDatabaseStatements>> = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("sandbox-schema-census-");
    seedDb = createDb(database.connectionString);
  }, 120_000);
  afterEach(async () => {
    vi.useRealTimers();
    meters.splice(0).reverse().forEach(meter => meter.uninstall());
    await Promise.all(clients.splice(0).map(client => client.$client.end({ timeout: 1 })));
  });
  afterAll(async () => {
    await seedDb?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  function meteredClient() {
    const client = createDb(database.connectionString);
    clients.push(client);
    const meter = meterDatabaseStatements(client, database.connectionString);
    meters.push(meter);
    return { client, meter };
  }

  function declaration(driverKey: string, secretPaths: string[]): PluginEnvironmentDriverDeclaration {
    return {
      driverKey, kind: "sandbox_provider", displayName: "Census provider",
      sandboxCapabilities: { runnerWebSocketIngress: true },
      configSchema: { type: "object", properties: Object.fromEntries([
        ["template", { type: "string" }],
        ...secretPaths.map(path => [path, { type: "string", format: "secret-ref" }]),
      ]) },
    } as PluginEnvironmentDriverDeclaration;
  }

  function manifest(pluginKey: string, declarations: PluginEnvironmentDriverDeclaration[], version = "1.0.0"): PaperclipPluginManifestV1 {
    return {
      id: pluginKey, apiVersion: 1, version, displayName: "Census provider", description: "Fixture",
      author: "Test", categories: ["automation"], capabilities: ["environment.drivers.register"],
      entrypoints: { worker: "worker.js" }, environmentDrivers: declarations,
    };
  }

  async function seedPlugin(driverKey: string, secretPaths = ["apiKey"]) {
    const pluginKey = `test.census.${randomUUID()}`;
    const installed = await pluginRegistryService(seedDb).install(
      { packageName: "@test/census" }, manifest(pluginKey, [declaration(driverKey, secretPaths)]));
    await seedDb.update(plugins).set({ status: "ready" }).where(eq(plugins.id, installed!.id));
    return { pluginId: installed!.id, pluginKey };
  }

  async function seedCompanyEnvironment(driverKey: string, secretValue: string) {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID(), runId = randomUUID();
    await seedDb.insert(companies).values({ id: companyId, name: "Census", status: "active", issuePrefix: `C${companyId.slice(0, 6).toUpperCase()}` });
    await seedDb.insert(agents).values({
      id: agentId, companyId, name: "Runner", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const secret = await secretService(seedDb).create(companyId, {
      name: `census-api-key-${randomUUID()}`, provider: "local_encrypted", value: secretValue,
    });
    const config = { provider: driverKey, template: "base", apiKey: secret.id, reuseLease: false };
    const now = new Date();
    await seedDb.insert(environments).values({
      id: environmentId, name: `census-${environmentId.slice(0, 8)}`, driver: "sandbox", status: "active", config,
      createdAt: now, updatedAt: now,
    });
    await secretService(seedDb).createBinding({
      companyId, secretId: secret.id, targetType: "environment", targetId: environmentId, configPath: "apiKey",
    });
    await seedDb.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "running" });
    const environment: Environment = {
      id: environmentId, name: `census-${environmentId.slice(0, 8)}`, description: null, driver: "sandbox",
      status: "active", config, envVars: {}, metadata: null, createdAt: now, updatedAt: now,
    };
    return { companyId, environment, runId, secretId: secret.id };
  }

  function workerManager(pluginId: string, driverKey: string) {
    const configs: Array<{ method: string; config: Record<string, unknown> }> = [];
    const manager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn(() => ({ status: "running", supportedMethods: [
        "environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease",
        "environmentExecute", "environmentSyncIn", "environmentSyncOut", "environmentRealizeWorkspace",
        "environmentRunnerIngressEndpoint",
      ] })),
      call: vi.fn(async (_id: string, method: string, params: { config: Record<string, unknown>; path?: string }) => {
        configs.push({ method, config: params.config });
        switch (method) {
          case "environmentAcquireLease":
          case "environmentResumeLease":
            return { providerLeaseId: "census-sandbox", metadata: { provider: driverKey, template: "base", remoteCwd: "/workspace" } };
          case "environmentExecute":
            return { exitCode: 0, signal: null, timedOut: false, stdout: "ok\n", stderr: "" };
          case "environmentSyncIn":
          case "environmentSyncOut":
            return { results: [] };
          case "environmentRealizeWorkspace":
            return { cwd: "/workspace", metadata: {} };
          case "environmentRunnerIngressEndpoint":
            return { kind: "authenticated_websocket", websocketUrl: `wss://runner.example.test${params.path}`,
              secretHeaders: [{ name: "x-runner-token", value: "token" }], generation: "g1" };
          case "environmentReleaseLease":
            return undefined;
          default:
            throw new Error(`Unexpected plugin method: ${method}`);
        }
      }),
    } as unknown as PluginWorkerManager;
    return { manager, configs };
  }

  async function runCensus(client: Db, meter: ReturnType<typeof meterDatabaseStatements>, driverKey: string,
    seeded: Awaited<ReturnType<typeof seedCompanyEnvironment>>, pluginId: string) {
    const { manager, configs } = workerManager(pluginId, driverKey);
    const runtime = environmentRuntimeService(client, { pluginWorkerManager: manager });
    const rows: Array<{ operation: string; providerSchemaReads: number; statements: number }> = [];
    async function measure<T>(operation: string, run: () => Promise<T>) {
      meter.startLog();
      const value = await run();
      const log = meter.stopLog();
      rows.push({ operation, providerSchemaReads: log.filter(entry => entry.sql.includes(PROVIDER_SCHEMA_STATEMENT)).length,
        statements: log.length });
      return value;
    }
    const { environment } = seeded;
    const acquired = await measure("lease acquire", () => runtime.acquireRunLease({
      companyId: seeded.companyId, environment, issueId: null, heartbeatRunId: seeded.runId, persistedExecutionWorkspace: null,
    }));
    const lease = acquired.lease;
    await measure("runner attach (ingress endpoint)", () => runtime.getRunnerIngressEndpoint({ environment, lease, port: 8080, path: "/runner" }));
    await measure("capability snapshot", () => runtime.resolveCapabilities({ environment, lease }));
    await measure("exec", () => runtime.execute({ environment, lease, command: "true", args: [], cwd: "/workspace", env: {} }));
    for (let index = 0; index < 9; index++) {
      await measure("exec (repeat)", () => runtime.execute({ environment, lease, command: "true", args: [], cwd: "/workspace", env: {} }));
    }
    await measure("file write (sync in)", () => runtime.syncIn({ environment, lease, operations: [] }));
    await measure("file read (sync out)", () => runtime.syncOut({ environment, lease, operations: [] }));
    await measure("workspace realize", () => runtime.realizeWorkspace({ environment, lease, workspace: { remotePath: "/workspace" } }));
    await measure("lease resume (reattach)", () => runtime.resumeRunLease({ environment, lease }));
    await measure("lease release", () => runtime.releaseRunLeases(seeded.runId));
    const merged = new Map<string, { operation: string; count: number; providerSchemaReads: number; statements: number }>();
    for (const row of rows) {
      const entry = merged.get(row.operation) ?? { operation: row.operation, count: 0, providerSchemaReads: 0, statements: 0 };
      entry.count += 1;
      entry.providerSchemaReads += row.providerSchemaReads;
      entry.statements += row.statements;
      merged.set(row.operation, entry);
    }
    return { table: [...merged.values()], configs };
  }

  it("reads the provider schema at most once per bound across a whole remote run, not once per operation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const driverKey = `census-${randomUUID().slice(0, 8)}`;
    const { pluginId } = await seedPlugin(driverKey);
    const seeded = await seedCompanyEnvironment(driverKey, "company-a-key");
    const { client, meter } = meteredClient();
    const { table, configs } = await runCensus(client, meter, driverKey, seeded, pluginId);
    console.info(`provider schema census\n${table.map(row =>
      `${row.operation} x${row.count}: provider schema reads=${row.providerSchemaReads}, statements=${row.statements}`).join("\n")}`);
    const total = table.reduce((sum, row) => sum + row.providerSchemaReads, 0);
    const acquire = table.find(row => row.operation === "lease acquire")!;
    expect(acquire.providerSchemaReads).toBeLessThanOrEqual(1);
    expect(total).toBeLessThanOrEqual(1);
    expect(configs.filter(entry => entry.method !== "environmentAcquireLease").every(entry => entry.config.apiKey === "company-a-key")).toBe(true);
  });

  it("applies a plugin upgrade that changes the schema at once in this process, and a change made elsewhere within the bound", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const driverKey = `census-${randomUUID().slice(0, 8)}`;
    const { pluginId, pluginKey } = await seedPlugin(driverKey, ["apiKey"]);
    const { client, meter } = meteredClient();
    expect(await resolveSandboxProviderSecretRefPaths(client, driverKey)).toEqual(new Set(["apiKey"]));
    await pluginRegistryService(seedDb).update(pluginId, {
      version: "2.0.0", manifest: manifest(pluginKey, [declaration(driverKey, ["apiKey", "token"])], "2.0.0"),
    });
    expect(await resolveSandboxProviderSecretRefPaths(client, driverKey)).toEqual(new Set(["apiKey", "token"]));

    await seedDb.update(plugins).set({ manifestJson: manifest(pluginKey, [declaration(driverKey, ["token"])], "3.0.0") })
      .where(eq(plugins.id, pluginId));
    meter.startLog();
    const withinBound = await resolveSandboxProviderSecretRefPaths(client, driverKey);
    expect(meter.stopLog()).toHaveLength(0);
    expect([new Set(["apiKey", "token"]), new Set(["token"])]).toContainEqual(withinBound);
    vi.setSystemTime(Date.now() + SCHEMA_REUSE_BOUND_MS + 1);
    expect(await resolveSandboxProviderSecretRefPaths(client, driverKey)).toEqual(new Set(["token"]));

    await pluginRegistryService(seedDb).uninstall(pluginId, true);
    expect(await resolveSandboxProviderSecretRefPaths(client, driverKey)).toEqual(new Set());
  });

  it("never remembers a missing provider, so a provider that becomes ready is used on the next operation", async () => {
    const driverKey = `census-${randomUUID().slice(0, 8)}`;
    const { client, meter } = meteredClient();
    expect(await resolveSandboxProviderSecretRefPaths(client, driverKey)).toEqual(new Set());
    await seedDb.insert(plugins).values({
      pluginKey: `test.census.${randomUUID()}`, packageName: "@test/census", version: "1.0.0", installOrder: 0,
      status: "ready", manifestJson: manifest(`test.census.late`, [declaration(driverKey, ["apiKey"])]),
    });
    meter.startLog();
    expect(await resolveSandboxProviderSecretRefPaths(client, driverKey)).toEqual(new Set(["apiKey"]));
    expect(meter.stopLog().filter(entry => entry.sql.includes(PROVIDER_SCHEMA_STATEMENT))).toHaveLength(1);
  });

  it("keeps each company's secret resolution and binding check per operation while the provider schema is shared", async () => {
    const driverKey = `census-${randomUUID().slice(0, 8)}`;
    const { pluginId } = await seedPlugin(driverKey);
    const first = await seedCompanyEnvironment(driverKey, "company-a-key");
    const second = await seedCompanyEnvironment(driverKey, "company-b-key");
    const { client, meter } = meteredClient();
    const a = await runCensus(client, meter, driverKey, first, pluginId);
    const b = await runCensus(client, meter, driverKey, second, pluginId);
    expect(a.configs.filter(entry => entry.method !== "environmentAcquireLease").map(entry => entry.config.apiKey))
      .toEqual(expect.arrayContaining(["company-a-key"]));
    expect(a.configs.some(entry => entry.config.apiKey === "company-b-key")).toBe(false);
    expect(b.configs.filter(entry => entry.method !== "environmentAcquireLease").every(entry => entry.config.apiKey === "company-b-key")).toBe(true);

    const crossCompany = { ...second.environment, config: { ...second.environment.config, apiKey: first.secretId } };
    const { manager } = workerManager(pluginId, driverKey);
    const runtime = environmentRuntimeService(client, { pluginWorkerManager: manager });
    await expect(runtime.execute({
      environment: crossCompany,
      lease: { companyId: second.companyId, environmentId: second.environment.id, issueId: null, providerLeaseId: "census-sandbox",
        metadata: { provider: driverKey, pluginId, sandboxProviderPlugin: true, template: "base", apiKey: first.secretId } } as never,
      command: "true", args: [], cwd: "/workspace", env: {},
    })).rejects.toThrow("Secret must belong to same company");
  });

  it("applies a plugin reinstall only after its install transaction commits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const driverKey = `census-${randomUUID().slice(0, 8)}`;
    const pluginKey = `test.census.reinstall${randomUUID().slice(0, 8)}`;
    await seedDb.insert(plugins).values({
      pluginKey, packageName: pluginKey, version: "1.0.0", installOrder: 0, status: "uninstalled",
      manifestJson: manifest(pluginKey, [declaration(driverKey, ["apiKey"])]),
    });
    const upgraded = manifest(pluginKey, [declaration(driverKey, ["apiKey", "token"])], "2.0.0");
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "census-plugin-"));
    try {
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: pluginKey, version: upgraded.version, type: "module", paperclipPlugin: { manifest: "./manifest.js" },
      }));
      await writeFile(path.join(packageRoot, "manifest.js"), `export default ${JSON.stringify(upgraded)};\n`);
      await mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await writeFile(path.join(packageRoot, "dist", "worker.js"), "export {};\n");
      const { client: observer } = meteredClient();
      expect(await resolveSandboxProviderSecretRefPaths(observer, driverKey)).toEqual(new Set(["apiKey"]));
      const installer = createDb(database.connectionString);
      clients.push(installer);
      const readBeforeCommit = new Proxy(installer, {
        get(target, property, receiver) {
          if (property !== "transaction") return Reflect.get(target, property, receiver);
          return (work: (tx: unknown) => Promise<unknown>) => target.transaction(async tx => {
            const result = await work(tx);
            expect(await resolveSandboxProviderSecretRefPaths(observer, driverKey)).toEqual(new Set(["apiKey"]));
            return result;
          });
        },
      });
      await pluginLoader(readBeforeCommit, { enableLocalFilesystem: false, enableNpmDiscovery: false })
        .installPlugin({ localPath: packageRoot });
      expect(await resolveSandboxProviderSecretRefPaths(observer, driverKey)).toEqual(new Set(["apiKey", "token"]));
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("starts cold on a new process, as before", async () => {
    const driverKey = `census-${randomUUID().slice(0, 8)}`;
    await seedPlugin(driverKey);
    const first = meteredClient();
    await resolveSandboxProviderSecretRefPaths(first.client, driverKey);
    const restarted = meteredClient();
    restarted.meter.startLog();
    expect(await resolveSandboxProviderSecretRefPaths(restarted.client, driverKey)).toEqual(new Set(["apiKey"]));
    expect(restarted.meter.stopLog().filter(entry => entry.sql.includes(PROVIDER_SCHEMA_STATEMENT))).toHaveLength(1);
  });
});
