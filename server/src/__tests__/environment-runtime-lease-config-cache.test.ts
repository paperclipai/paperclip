import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  environments,
  heartbeatRuns,
  plugins,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import { secretService } from "../services/secrets.ts";
import {
  LEASE_RUNTIME_CONFIG_CACHE_MAX_ENTRIES,
  LEASE_RUNTIME_CONFIG_CACHE_TTL_MS,
  leaseRuntimeConfigCacheFor,
  noteCompanySecretChanged,
} from "../services/lease-runtime-config-cache.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

describe("leaseRuntimeConfigCacheFor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shares one in-flight resolution between concurrent first reads", async () => {
    const cache = leaseRuntimeConfigCacheFor({});
    let release!: (value: Record<string, unknown>) => void;
    const resolve = vi.fn(() => new Promise<Record<string, unknown>>((done) => { release = done; }));
    const reads = Array.from({ length: 5 }, () =>
      cache.getOrResolve({ leaseId: "lease-1", companyId: "company-1", fingerprintInput: { a: 1 }, resolve }));
    release({ kubeconfig: "value" });
    const results = await Promise.all(reads);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.kubeconfig === "value")).toBe(true);
    // Each caller gets its own copy, so one caller cannot change another's config.
    results[0]!.kubeconfig = "mutated";
    expect((await cache.getOrResolve({ leaseId: "lease-1", companyId: "company-1", fingerprintInput: { a: 1 }, resolve })).kubeconfig).toBe("value");
  });

  it("never caches a failed resolution", async () => {
    const cache = leaseRuntimeConfigCacheFor({});
    const resolve = vi.fn()
      .mockRejectedValueOnce(new Error("secret unavailable"))
      .mockResolvedValueOnce({ kubeconfig: "value" });
    await expect(cache.getOrResolve({ leaseId: "l", companyId: "c", fingerprintInput: {}, resolve })).rejects.toThrow("secret unavailable");
    expect(cache.size).toBe(0);
    await expect(cache.getOrResolve({ leaseId: "l", companyId: "c", fingerprintInput: {}, resolve })).resolves.toEqual({ kubeconfig: "value" });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("re-resolves on a changed fingerprint, a secret change of the company, and after the TTL", async () => {
    const cache = leaseRuntimeConfigCacheFor({});
    const companyId = randomUUID();
    const resolve = vi.fn(async () => ({ kubeconfig: "value" }));
    const read = (fingerprintInput: unknown) => cache.getOrResolve({ leaseId: "l", companyId, fingerprintInput, resolve });
    await read({ v: 1 });
    await read({ v: 1 });
    expect(resolve).toHaveBeenCalledTimes(1);
    await read({ v: 2 });
    expect(resolve).toHaveBeenCalledTimes(2);
    noteCompanySecretChanged(randomUUID());
    await read({ v: 2 });
    expect(resolve).toHaveBeenCalledTimes(2);
    noteCompanySecretChanged(companyId);
    await read({ v: 2 });
    expect(resolve).toHaveBeenCalledTimes(3);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + LEASE_RUNTIME_CONFIG_CACHE_TTL_MS - 1_000);
    await read({ v: 2 });
    expect(resolve).toHaveBeenCalledTimes(3);
    vi.spyOn(Date, "now").mockReturnValue(now + LEASE_RUNTIME_CONFIG_CACHE_TTL_MS + 1_000);
    await read({ v: 2 });
    expect(resolve).toHaveBeenCalledTimes(4);
  });

  it("keeps at most the configured number of entries, evicting the least recently used", async () => {
    const cache = leaseRuntimeConfigCacheFor({});
    const resolve = vi.fn(async () => ({}));
    for (let index = 0; index < LEASE_RUNTIME_CONFIG_CACHE_MAX_ENTRIES; index += 1) {
      await cache.getOrResolve({ leaseId: `lease-${index}`, companyId: "c", fingerprintInput: {}, resolve });
    }
    // Touch lease-0 so lease-1 is now the least recently used entry.
    await cache.getOrResolve({ leaseId: "lease-0", companyId: "c", fingerprintInput: {}, resolve });
    await cache.getOrResolve({ leaseId: "lease-new", companyId: "c", fingerprintInput: {}, resolve });
    expect(cache.size).toBe(LEASE_RUNTIME_CONFIG_CACHE_MAX_ENTRIES);
    const calls = resolve.mock.calls.length;
    await cache.getOrResolve({ leaseId: "lease-0", companyId: "c", fingerprintInput: {}, resolve });
    expect(resolve.mock.calls.length).toBe(calls);
    await cache.getOrResolve({ leaseId: "lease-1", companyId: "c", fingerprintInput: {}, resolve });
    expect(resolve.mock.calls.length).toBe(calls + 1);
  });

  it("scopes entries to one database handle", async () => {
    const resolve = vi.fn(async () => ({}));
    await leaseRuntimeConfigCacheFor({}).getOrResolve({ leaseId: "l", companyId: "c", fingerprintInput: {}, resolve });
    await leaseRuntimeConfigCacheFor({}).getOrResolve({ leaseId: "l", companyId: "c", fingerprintInput: {}, resolve });
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("plugin sandbox execute reuses the lease's resolved config", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-runtime-lease-config-cache");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await stopDb?.();
  });

  // Counts the database calls made through this handle, the way the runtime
  // and the secret service reach the database.
  function countingDb() {
    const counts = { select: 0, insert: 0, update: 0, delete: 0, execute: 0, transaction: 0 };
    const proxy = new Proxy(db, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        if (typeof prop === "string" && prop in counts) {
          return (...args: unknown[]) => {
            counts[prop as keyof typeof counts] += 1;
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
    return { db: proxy, counts, total: () => Object.values(counts).reduce((sum, count) => sum + count, 0) };
  }

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 8).toUpperCase()}`, status: "active", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {}, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `acme.kube-${pluginId.slice(0, 8)}`,
      packageName: "@acme/kube-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: `acme.kube-${pluginId.slice(0, 8)}`,
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Kube Sandbox Provider",
        description: "Test provider with a secret-backed kubeconfig",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{
          driverKey: "kube-test",
          kind: "sandbox_provider",
          displayName: "Kube Test",
          configSchema: {
            type: "object",
            properties: {
              namespace: { type: "string" },
              kubeconfig: { type: "string", format: "secret-ref" },
              timeoutMs: { type: "number" },
              reuseLease: { type: "boolean" },
            },
          },
        }],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    return { companyId, agentId, pluginId };
  }

  async function seedEnvironmentWithSecret(companyId: string, kubeconfigValue: string) {
    const environmentId = randomUUID();
    const secret = await secretService(db).create(companyId, {
      name: `kubeconfig-${randomUUID()}`,
      provider: "local_encrypted",
      value: kubeconfigValue,
    });
    const config = { provider: "kube-test", namespace: "sandboxes", kubeconfig: secret.id, timeoutMs: 1234, reuseLease: false };
    const createdAt = new Date();
    await db.insert(environments).values({
      id: environmentId, name: `kube-${environmentId.slice(0, 8)}`, driver: "sandbox", status: "active",
      config, createdAt, updatedAt: createdAt,
    });
    await secretService(db).createBinding({
      companyId, secretId: secret.id, targetType: "environment", targetId: environmentId, configPath: "kubeconfig",
    });
    const environment = {
      id: environmentId, companyId, name: `kube-${environmentId.slice(0, 8)}`, description: null, driver: "sandbox",
      status: "active", config, metadata: null, createdAt, updatedAt: createdAt,
    } as const;
    return { environment, secret };
  }

  function workerFor(pluginId: string) {
    const executedKubeconfigs: unknown[] = [];
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `pod-${randomUUID()}`,
            metadata: { ...params.config, provider: "kube-test", remoteCwd: "/workspace" },
          };
        }
        if (method === "environmentExecute") {
          executedKubeconfigs.push(params.config.kubeconfig);
          return { exitCode: 0, signal: null, timedOut: false, stdout: "ok\n", stderr: "" };
        }
        if (method === "environmentReleaseLease") return undefined;
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    return { workerManager, executedKubeconfigs };
  }

  async function acquire(runtime: ReturnType<typeof environmentRuntimeService>, input: {
    companyId: string;
    agentId: string;
    environment: Awaited<ReturnType<typeof seedEnvironmentWithSecret>>["environment"];
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: input.companyId, agentId: input.agentId, invocationSource: "manual", status: "running",
      createdAt: new Date(), updatedAt: new Date(),
    });
    const acquired = await runtime.acquireRunLease({
      companyId: input.companyId,
      environment: input.environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    // The provider records the secret reference in the lease, not the value.
    expect(acquired.lease.metadata?.kubeconfig).toBe(input.environment.config.kubeconfig);
    return { lease: acquired.lease, runId };
  }

  function exec(
    runtime: ReturnType<typeof environmentRuntimeService>,
    environment: Parameters<ReturnType<typeof environmentRuntimeService>["execute"]>[0]["environment"],
    lease: Parameters<ReturnType<typeof environmentRuntimeService>["execute"]>[0]["lease"],
  ) {
    return runtime.execute({ environment, lease, command: "true", args: [], cwd: "/workspace", env: {} });
  }

  async function accessEvents(secretId: string) {
    const rows = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, secretId));
    return rows;
  }

  it("resolves the kubeconfig secret once for N execs on one lease, with one audit row and no further queries", async () => {
    const { companyId, agentId, pluginId } = await seed();
    const { environment, secret } = await seedEnvironmentWithSecret(companyId, "kubeconfig-v1");
    const counting = countingDb();
    const { workerManager, executedKubeconfigs } = workerFor(pluginId);
    const runtime = environmentRuntimeService(counting.db as typeof db, { pluginWorkerManager: workerManager });
    const { lease } = await acquire(runtime, { companyId, agentId, environment });
    const eventsAfterAcquire = (await accessEvents(secret.id)).length;

    const beforeFirstExec = counting.total();
    await exec(runtime, environment, lease);
    const firstExecQueries = counting.total() - beforeFirstExec;
    expect(firstExecQueries).toBeGreaterThan(0);
    const firstExecWrites = counting.counts.insert + counting.counts.update;

    for (let index = 0; index < 49; index += 1) await exec(runtime, environment, lease);

    expect(counting.total() - beforeFirstExec).toBe(firstExecQueries);
    expect(counting.counts.insert + counting.counts.update).toBe(firstExecWrites);
    expect(executedKubeconfigs).toHaveLength(50);
    expect(new Set(executedKubeconfigs)).toEqual(new Set(["kubeconfig-v1"]));
    const events = await accessEvents(secret.id);
    expect(events.length - eventsAfterAcquire).toBe(1);
    // The one audit row keeps who, what and when of the actual access.
    const latest = events.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
    expect(latest).toMatchObject({
      companyId,
      secretId: secret.id,
      actorType: "system",
      consumerType: "environment",
      consumerId: environment.id,
      configPath: "kubeconfig",
      outcome: "success",
    });
  });

  it("does not stampede when the first execs of a lease run concurrently", async () => {
    const { companyId, agentId, pluginId } = await seed();
    const { environment, secret } = await seedEnvironmentWithSecret(companyId, "kubeconfig-v1");
    const { workerManager, executedKubeconfigs } = workerFor(pluginId);
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const { lease } = await acquire(runtime, { companyId, agentId, environment });
    const eventsAfterAcquire = (await accessEvents(secret.id)).length;

    await Promise.all(Array.from({ length: 10 }, () => exec(runtime, environment, lease)));

    expect(executedKubeconfigs).toEqual(Array(10).fill("kubeconfig-v1"));
    expect((await accessEvents(secret.id)).length - eventsAfterAcquire).toBe(1);
  });

  it("resolves again after an environment update, and never shares an entry across leases or environments", async () => {
    const { companyId, agentId, pluginId } = await seed();
    const first = await seedEnvironmentWithSecret(companyId, "kubeconfig-a");
    const second = await seedEnvironmentWithSecret(companyId, "kubeconfig-b");
    const { workerManager, executedKubeconfigs } = workerFor(pluginId);
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const leaseA1 = (await acquire(runtime, { companyId, agentId, environment: first.environment })).lease;
    const leaseA2 = (await acquire(runtime, { companyId, agentId, environment: first.environment })).lease;
    const leaseB = (await acquire(runtime, { companyId, agentId, environment: second.environment })).lease;
    const baseA = (await accessEvents(first.secret.id)).length;
    const baseB = (await accessEvents(second.secret.id)).length;

    await exec(runtime, first.environment, leaseA1);
    await exec(runtime, first.environment, leaseA2);
    await exec(runtime, second.environment, leaseB);
    await exec(runtime, first.environment, leaseA1);
    await exec(runtime, second.environment, leaseB);
    expect(executedKubeconfigs).toEqual(["kubeconfig-a", "kubeconfig-a", "kubeconfig-b", "kubeconfig-a", "kubeconfig-b"]);
    // One resolution per lease: two leases of A, one of B.
    expect((await accessEvents(first.secret.id)).length - baseA).toBe(2);
    expect((await accessEvents(second.secret.id)).length - baseB).toBe(1);

    // The same lease presented with another environment does not reuse A's
    // entry: it resolves again, and B is not bound to A's secret.
    await expect(exec(runtime, second.environment, leaseA1)).rejects.toThrow(/not bound to environment/);
    expect((await accessEvents(first.secret.id)).length - baseA).toBe(3);

    // An environment update (new updatedAt and config) resolves again.
    const updatedConfig = { ...first.environment.config, namespace: "sandboxes-2" };
    await environmentService(db).update(first.environment.id, { config: updatedConfig });
    const updatedEnvironment = (await environmentService(db).getById(first.environment.id))!;
    await exec(runtime, updatedEnvironment as any, leaseA1);
    await exec(runtime, updatedEnvironment as any, leaseA1);
    expect((await accessEvents(first.secret.id)).length - baseA).toBe(4);
  });

  it("drops the entry on lease release", async () => {
    const { companyId, agentId, pluginId } = await seed();
    const { environment, secret } = await seedEnvironmentWithSecret(companyId, "kubeconfig-v1");
    const { workerManager } = workerFor(pluginId);
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const { lease, runId } = await acquire(runtime, { companyId, agentId, environment });
    await exec(runtime, environment, lease);
    const cache = leaseRuntimeConfigCacheFor(db);
    const beforeRelease = (await accessEvents(secret.id)).length;

    // A release from another runtime on the same database drops the entry too.
    const releasingRuntime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const released = await releasingRuntime.releaseRunLeases(runId);
    expect(released).toHaveLength(1);
    // The release resolved the config fresh (one audit row) instead of reusing the entry.
    expect((await accessEvents(secret.id)).length - beforeRelease).toBe(1);
    await exec(runtime, environment, lease);
    expect((await accessEvents(secret.id)).length - beforeRelease).toBe(2);
    cache.invalidateLease(lease.id);
  });

  it("picks up a rotated kubeconfig at once in this process, and within the TTL when rotated elsewhere", async () => {
    const { companyId, agentId, pluginId } = await seed();
    const { environment, secret } = await seedEnvironmentWithSecret(companyId, "kubeconfig-v1");
    const { workerManager, executedKubeconfigs } = workerFor(pluginId);
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const { lease } = await acquire(runtime, { companyId, agentId, environment });

    await exec(runtime, environment, lease);
    await secretService(db).rotate(secret.id, { value: "kubeconfig-v2" });
    await exec(runtime, environment, lease);
    expect(executedKubeconfigs).toEqual(["kubeconfig-v1", "kubeconfig-v2"]);

    // A rotation this process does not see: write version 3 directly, the way
    // another server task or an external vault rotation would change it.
    const donor = await secretService(db).create(companyId, {
      name: `donor-${randomUUID()}`, provider: "local_encrypted", value: "kubeconfig-v3",
    });
    const [donorVersion] = await db.select().from(companySecretVersions)
      .where(and(eq(companySecretVersions.secretId, donor.id), eq(companySecretVersions.version, 1)));
    await db.insert(companySecretVersions).values({
      secretId: secret.id,
      version: 3,
      material: donorVersion!.material,
      valueSha256: donorVersion!.valueSha256,
      fingerprintSha256: donorVersion!.fingerprintSha256,
      status: "current",
    } as any);
    await db.update(companySecrets).set({ latestVersion: 3 }).where(eq(companySecrets.id, secret.id));

    await exec(runtime, environment, lease);
    expect(executedKubeconfigs.at(-1)).toBe("kubeconfig-v2");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + LEASE_RUNTIME_CONFIG_CACHE_TTL_MS + 1_000);
    await exec(runtime, environment, lease);
    expect(executedKubeconfigs.at(-1)).toBe("kubeconfig-v3");
  });

  it("keeps resolving on every exec while the secret cannot be resolved", async () => {
    const { companyId, agentId, pluginId } = await seed();
    const { environment, secret } = await seedEnvironmentWithSecret(companyId, "kubeconfig-v1");
    const { workerManager, executedKubeconfigs } = workerFor(pluginId);
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const { lease } = await acquire(runtime, { companyId, agentId, environment });
    await exec(runtime, environment, lease);
    await secretService(db).update(secret.id, { status: "disabled" });
    const failuresBefore = (await accessEvents(secret.id)).filter((event) => event.outcome === "failure").length;
    // A disabled secret fails resolution on every exec, as before the cache,
    // and every failed attempt is audited.
    await expect(exec(runtime, environment, lease)).rejects.toThrow();
    await expect(exec(runtime, environment, lease)).rejects.toThrow();
    const failures = (await accessEvents(secret.id)).filter((event) => event.outcome === "failure").length - failuresBefore;
    expect(failures).toBe(2);
    expect(executedKubeconfigs).toEqual(["kubeconfig-v1"]);
  });
});
