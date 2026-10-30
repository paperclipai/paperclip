import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, builtInManagedResources, companies, createDb, environmentLeases, environments, heartbeatRuns, plugins, sandboxCreationOperations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

describe("durable sandbox creation through the runtime entry point", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string, environmentId: string, pluginId: string, runId: string, spool: string;
  let creates: number, destroys: number, loseReply: boolean, failDestroy: boolean;
  let beforeReply: (() => Promise<void>) | undefined;
  const resources = new Map<string, string>();
  let workers: PluginWorkerManager;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("sandbox-creation-operations-");
    db = createDb(database.connectionString);
  }, 90_000);
  beforeEach(async () => {
    await db.execute(sql`truncate sandbox_creation_operations, companies, environments, plugins cascade`);
    companyId = randomUUID(); environmentId = randomUUID(); pluginId = randomUUID(); runId = randomUUID();
    const agentId = randomUUID(); creates = 0; destroys = 0; loseReply = false; failDestroy = false; beforeReply = undefined; resources.clear();
    spool = await mkdtemp(join(tmpdir(), "empty-sandbox-web-"));
    await db.insert(companies).values({ id: companyId, name: "Creation fixture", issuePrefix: "CRT" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "manual" });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox", config: { provider: "creation-fixture", image: "fixture", reuseLease: false } });
    await db.insert(plugins).values({ id: pluginId, pluginKey: "paperclip.creation-fixture", packageName: "creation-fixture", version: "1.0.0", apiVersion: 1,
      status: "ready", categories: ["automation"], manifestJson: { id: "paperclip.creation-fixture", version: "1.0.0", apiVersion: 1,
      displayName: "Creation fixture", description: "Controlled remote provider", author: "Paperclip", categories: ["automation"],
      capabilities: ["environment.drivers.register"], entrypoints: { worker: "fixture.js" }, environmentDrivers: [{
        driverKey: "creation-fixture", kind: "sandbox_provider", displayName: "Fixture", creationOperationVersion: 1, configSchema: { type: "object" },
      }] } });
    workers = {
      isRunning: () => true,
      getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentInspectLease", "environmentDestroyLease"] }),
      call: vi.fn(async (_pluginId: string, method: string, input: any) => {
        if (method === "environmentAcquireLease") {
          expect(await db.select().from(sandboxCreationOperations)).toContainEqual(expect.objectContaining({ id: input.creationOperationId, state: "pending" }));
          creates++;
          const resource = `provider-${input.creationOperationId}`;
          resources.set(input.creationOperationId, resource);
          await beforeReply?.();
          if (loseReply) throw new Error("Lost provider reply");
          return { providerLeaseId: resource, metadata: { remoteCwd: "/workspace" } };
        }
        if (method === "environmentInspectLease") {
          const id = input.leaseMetadata.creationOperationId;
          const resource = resources.get(id);
          if (!resource) return { providerLeaseId: id, state: "unknown" };
          return { providerLeaseId: resource, state: "active", creationCleanup: { providerLeaseId: resource,
            observedProviderLeaseId: resource, companyId, environmentId, runId: input.leaseMetadata.creationRunId, attemptId: id,
            accountFingerprint: "a".repeat(64), labels: { "paperclip-create-attempt": id } } };
        }
        if (method === "environmentDestroyLease") {
          destroys++;
          if (failDestroy) throw new Error("Fixture teardown failed");
          resources.delete(input.leaseMetadata.creationOperationId);
          return { providerLeaseId: input.providerLeaseId, state: "destroyed" };
        }
        throw new Error(`Unexpected fixture method ${method}`);
      }),
    } as unknown as PluginWorkerManager;
  });
  afterEach(async () => {
    await db.execute(sql`drop trigger if exists reject_fixture_lease on environment_leases`);
    await db.execute(sql`drop trigger if exists reject_fixture_creation on sandbox_creation_operations`);
    await rm(spool, { recursive: true, force: true });
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  function runtime() { return environmentRuntimeService(db, { pluginWorkerManager: workers, orphanCleanupSpoolDir: spool }); }
  async function acquire() {
    return runtime().acquireRunLease({ companyId, environment: (await environmentService(db).getById(environmentId))!,
      heartbeatRunId: runId, issueId: null, persistedExecutionWorkspace: null, assertCompanyBinding: true });
  }
  async function due() { await db.update(sandboxCreationOperations).set({ nextAttemptAt: new Date(0) }); }
  async function rejectWrites(table: "environment_leases" | "sandbox_creation_operations", trigger: string) {
    await db.execute(sql`create or replace function reject_fixture_write() returns trigger language plpgsql as $$ begin raise exception 'Fixture database write unavailable'; end $$`);
    await db.execute(sql.raw(`create trigger ${trigger} before insert on ${table} for each row execute function reject_fixture_write()`));
  }
  it("fails before the external action when the durable admission write fails", async () => {
    await rejectWrites("sandbox_creation_operations", "reject_fixture_creation");
    await expect(acquire()).rejects.toThrow();
    expect(creates).toBe(0); expect(resources.size).toBe(0); expect(await readdir(spool)).toEqual([]);
  });
  it("attaches once and reuses the committed transfer after a lost response", async () => {
    const first = await acquire();
    const retry = await acquire();
    expect(retry.lease.id).toBe(first.lease.id); expect(creates).toBe(1); expect(destroys).toBe(0);
    await due(); await runtime().flushDeferredOrphanCleanups();
    expect(await db.select().from(environmentLeases)).toHaveLength(1);
    expect(await nextEnvironmentCleanupAt(db)).toBeNull();
  });
  it("recovers a failed lease write with a fresh receiver and empty web disk", async () => {
    await rejectWrites("environment_leases", "reject_fixture_lease");
    await expect(acquire()).rejects.toThrow();
    expect(creates).toBe(1); expect(await readdir(spool)).toEqual([]);
    expect(await db.select().from(sandboxCreationOperations)).toEqual([expect.objectContaining({ state: "pending" })]);
    await db.execute(sql`drop trigger reject_fixture_lease on environment_leases`);
    await due();
    await Promise.all([runtime().flushDeferredOrphanCleanups(), runtime().flushDeferredOrphanCleanups()]);
    const leases = await db.select().from(environmentLeases);
    expect(leases).toEqual([expect.objectContaining({ status: "pending_cleanup", providerLeaseId: [...resources.values()][0] })]);
    expect(creates).toBe(1);
    failDestroy = true;
    await expect(runtime().retryPendingSandboxTeardown({ environment: null, lease: (await environmentService(db).getLeaseById(leases[0]!.id))! })).rejects.toThrow("Fixture teardown failed");
    expect(resources.size).toBe(1);
    failDestroy = false;
    await runtime().retryPendingSandboxTeardown({ environment: null, lease: (await environmentService(db).getLeaseById(leases[0]!.id))! });
    expect(resources.size).toBe(0); expect(destroys).toBe(2);
  });
  it("reconstructs ownership in a replacement receiver process with a different empty web disk", async () => {
    const provider = createServer(async (request, response) => {
      try {
        let body = ""; for await (const chunk of request) body += chunk.toString();
        const { method, input } = JSON.parse(body);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(await (workers.call as any)(pluginId, method, input)));
      } catch { response.statusCode = 500; response.end("{}"); }
    });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address() as { port: number };
    const replacementDisk = await mkdtemp(join(tmpdir(), "replacement-sandbox-web-"));
    const fixture = fileURLToPath(new URL("./fixtures/sandbox-creation-receiver.ts", import.meta.url));
    async function receiver(action: string, disk: string) {
      const result = await promisify(execFile)(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), fixture], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)), timeout: 60_000,
        env: { ...process.env, CREATION_FIXTURE_ACTION: action, CREATION_FIXTURE_EMPTY_DISK: disk,
          CREATION_FIXTURE_DATABASE_URL: database.connectionString, CREATION_FIXTURE_PROVIDER_URL: `http://127.0.0.1:${address.port}`,
          CREATION_FIXTURE_COMPANY_ID: companyId, CREATION_FIXTURE_ENVIRONMENT_ID: environmentId, CREATION_FIXTURE_RUN_ID: runId },
      });
      return result.stdout;
    }
    try {
      await rejectWrites("environment_leases", "reject_fixture_lease");
      expect(await receiver("acquire", spool)).toContain('"ok":false');
      expect(creates).toBe(1); expect(resources.size).toBe(1); expect(await readdir(spool)).toEqual([]);
      await db.execute(sql`drop trigger reject_fixture_lease on environment_leases`);
      await due();
      expect(await receiver("recover", replacementDisk)).toContain('"ok":true');
      expect(await receiver("recover", replacementDisk)).toContain('"ok":true');
      expect(await db.select().from(environmentLeases)).toEqual([
        expect.objectContaining({ status: "pending_cleanup", providerLeaseId: [...resources.values()][0] }),
      ]);
      expect(creates).toBe(1); expect(await readdir(replacementDisk)).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      await rm(replacementDisk, { recursive: true, force: true });
    }
  }, 180_000);
  it("never repeats creation after a lost provider reply", async () => {
    loseReply = true;
    await expect(acquire()).rejects.toThrow("Lost provider reply");
    await expect(acquire()).rejects.toThrow("requires reconciliation");
    expect(creates).toBe(1);
    await due(); await runtime().flushDeferredOrphanCleanups();
    expect(await db.select().from(environmentLeases)).toEqual([expect.objectContaining({ status: "pending_cleanup" })]);
  });
  it("retains cleanup ownership when the environment is deleted during creation", async () => {
    beforeReply = async () => { await environmentService(db).remove(environmentId); };
    await expect(acquire()).rejects.toThrow();
    expect(await db.select().from(sandboxCreationOperations)).toEqual([expect.objectContaining({ environmentId: null, originalEnvironmentId: environmentId, state: "pending" })]);
    await due(); await runtime().flushDeferredOrphanCleanups();
    expect(await db.select().from(environmentLeases)).toEqual([expect.objectContaining({ environmentId: null, status: "pending_cleanup" })]);
  });
  it("rejects attachment after a company rebind and retains cleanup", async () => {
    beforeReply = async () => {
      const foreign = randomUUID(); await db.insert(companies).values({ id: foreign, name: "Foreign", issuePrefix: "FOR" });
      await db.insert(builtInManagedResources).values({ companyId: foreign, bundleKey: "managed-environment", resourceKind: "environment",
        resourceKey: "sandbox", resourceId: environmentId, stockVersion: "1", stockHash: "fixture" });
    };
    await expect(acquire()).rejects.toMatchObject({ status: 403 });
    await due(); await runtime().flushDeferredOrphanCleanups();
    expect(await db.select().from(environmentLeases)).toEqual([expect.objectContaining({ companyId, status: "pending_cleanup" })]);
  });
  it("backs off a failed lookup and recovers unrelated creations in the same pass", async () => {
    loseReply = true; await expect(acquire()).rejects.toThrow("Lost provider reply");
    const [first] = await db.select().from(sandboxCreationOperations);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    runId = randomUUID(); await db.insert(heartbeatRuns).values({ ...run!, id: runId });
    await expect(acquire()).rejects.toThrow("Lost provider reply");
    const originalCall = workers.call;
    (workers as any).call = vi.fn(async (plugin: string, method: string, params: any, timeout: any) => {
      if (method === "environmentInspectLease" && params.leaseMetadata.creationOperationId === first!.id) throw new Error("Transient fixture lookup");
      return originalCall(plugin, method as any, params, timeout);
    });
    await due(); await runtime().flushDeferredOrphanCleanups();
    const rows = await db.select().from(sandboxCreationOperations);
    expect(rows.find(value => value.id === first!.id)).toMatchObject({ state: "pending" });
    expect(rows.find(value => value.id === first!.id)!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(rows.filter(value => value.state === "cleanup_pending")).toHaveLength(1);
  });
  it("does not attach a sandbox to a run stopped during creation", async () => {
    beforeReply = async () => { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId)); };
    await expect(acquire()).rejects.toThrow("run authority changed");
    expect(await db.select().from(environmentLeases)).toHaveLength(0);
    await due(); await runtime().flushDeferredOrphanCleanups();
    expect(await db.select().from(environmentLeases)).toEqual([expect.objectContaining({ status: "pending_cleanup" })]);
  });
  it("makes unsupported uncertain outcomes explicit without another creation", async () => {
    loseReply = true; await expect(acquire()).rejects.toThrow();
    await db.update(plugins).set({ manifestJson: sql`${plugins.manifestJson} #- '{environmentDrivers,0,creationOperationVersion}'` }).where(eq(plugins.id, pluginId));
    await due(); await runtime().flushDeferredOrphanCleanups();
    expect(await db.select().from(sandboxCreationOperations)).toEqual([expect.objectContaining({ state: "needs_reconciliation" })]);
    expect(await nextEnvironmentCleanupAt(db)).toBeNull();
    await expect(acquire()).rejects.toThrow("requires reconciliation"); expect(creates).toBe(1);
  });
});
