import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import * as databaseModule from "@paperclipai/db";
import * as idleWorkModule from "../services/idle-local-work.js";
import { idleWorkSnapshot, isIdleTaskDrainActive, registerTaskDrainExpiryWork, startTaskDrain, stopTaskDrain } from "../services/task-admission.js";
import { agents, companies, applyPendingMigrations, createDb, companySecrets, projects, pluginCompanySettings, pluginConfig, plugins, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { registerPluginLifecycleDelivery } from "../services/plugin-lifecycle-delivery.js";
import { pluginLifecycleInbox } from "../services/plugin-lifecycle-inbox.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { recordProjectLifecycleEvent, recordResourceCreationEvent } from "../services/resource-lifecycle-events.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import type { PluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const externalUrl = process.env.PAPERCLIP_PLUGIN_LIFECYCLE_TEST_DATABASE_URL;
const expectedDatabase = process.env.PAPERCLIP_PLUGIN_LIFECYCLE_EXPECTED_DATABASE;
if (externalUrl || expectedDatabase) {
  if (!externalUrl || !expectedDatabase || !/^sleep2_[a-z0-9_]+_test$/.test(expectedDatabase)) throw new Error("Explicit lifecycle test database required");
  const target = new URL(externalUrl);
  if (!["postgres:", "postgresql:"].includes(target.protocol) || target.hostname !== "127.0.0.1" || target.port !== "55448" || target.pathname !== `/${expectedDatabase}` || target.search) throw new Error("Unexpected lifecycle test database");
}
const support = externalUrl ? { supported: true as const } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping lifecycle delivery database tests: ${support.reason}`);

describePostgres("durable plugin lifecycle delivery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let pluginId: string;
  let listenerOwners: Array<{ listen: Db["$client"]["listen"]; close: ReturnType<typeof vi.fn> }>;
  const deliveries = new Set<ReturnType<typeof registerPluginLifecycleDelivery>>();
  beforeAll(async () => {
    if (externalUrl) await applyPendingMigrations(externalUrl);
    else database = await startEmbeddedPostgresTestDatabase("paperclip-plugin-delivery-");
    db = createDb(externalUrl ?? database.connectionString, { maxConnections: 4 });
  }, 90_000);
  afterAll(async () => { try { await db?.$client.end({ timeout: 1 }); } finally { await database?.cleanup(); } });
  afterEach(async () => {
    try { await Promise.all([...deliveries].map(worker => worker.dispose())); }
    finally { deliveries.clear(); stopTaskDrain(); vi.restoreAllMocks(); }
  });
  beforeEach(async () => {
    listenerOwners = [];
    vi.spyOn(db.$client, "listen").mockResolvedValue({ unlisten: vi.fn(), state: {} } as never);
    vi.spyOn(databaseModule, "createOwnedDatabaseListener").mockImplementation(() => {
      const owner = { listen: db.$client.listen, close: vi.fn().mockResolvedValue(undefined) };
      listenerOwners.push(owner);
      return owner;
    });
    await db.delete(plugins);
    companyId = randomUUID(); pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Delivery fixture", issuePrefix: `L${companyId.slice(0, 6)}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "delivery-fixture", version: "1.0.0", status: "ready",
      manifestJson: { resourceLifecycle: ["project"], capabilities: ["events.subscribe"] } as never });
    await db.insert(pluginConfig).values({ pluginId, companyId, configJson: {} });
  });
  async function event(resourceId: string = randomUUID(), action: "create" | "update" | "delete" = "create") {
    await db.transaction(async tx => {
      if (action === "create") await recordResourceCreationEvent(tx as unknown as Db, companyId, "project", resourceId);
      else await recordProjectLifecycleEvent(tx as unknown as Db, companyId, resourceId, action);
    });
    return resourceId;
  }
  function delivery() {
    let task!: Parameters<ReturnType<typeof createDeliveryWorkCoordinator>["register"]>[1];
    const wake = vi.fn();
    const coordinator = { register: vi.fn((_queue, input) => { task = input; return { wake, ready: Promise.resolve(), stop: vi.fn().mockResolvedValue(undefined) }; }) };
    const call = vi.fn(async (_pluginId, _method, input) => ({ eventId: input.id, status: "acknowledged" }));
    const running = vi.fn(() => true);
    const lifecycle = new EventEmitter();
    const configApplied = new Set<() => void>();
    const onConfigApplied = (listener: () => void) => { configApplied.add(listener); return () => { configApplied.delete(listener); }; };
    const worker = registerPluginLifecycleDelivery(coordinator as never, db, { call, isRunning: running, onConfigApplied } as unknown as PluginWorkerManager, lifecycle as unknown as PluginLifecycleManager);
    deliveries.add(worker);
    return { call, running, wake, lifecycle, worker, applied: () => { for (const listener of configApplied) listener(); }, run: () => task.run(new AbortController().signal), pending: () => task.hasPending(), nextRunAt: () => task.nextRunAt?.(), settled: () => task.onSettled?.() };
  }
  async function withManagedPlugin(enabledCompanies: string[], run: () => Promise<void>) {
    const root = await mkdtemp(path.join(tmpdir(), "delivery-managed-"));
    await mkdir(path.join(root, "sandbox-providers/daytona"), { recursive: true });
    vi.stubEnv("PAPERCLIP_BUNDLED_PLUGIN_ROOT", root);
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "1", features: {},
      plugins: { autoInstall: ["daytona"], workerEnv: { daytona: ["PROVIDER_ORIGIN"] }, enabledCompanies: { daytona: enabledCompanies } } }));
    try { await run(); }
    finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  }
  it("delivers to a managed plugin with no config row and a stale saved path only in the companies the document enables", async () => {
    const unlistedCompanyId = randomUUID(), disabledCompanyId = randomUUID(), absentCompanyId = randomUUID();
    await withManagedPlugin([companyId, disabledCompanyId, absentCompanyId], async () => {
      const managedId = randomUUID(), ungrantedId = randomUUID();
      const manifestJson = { resourceLifecycle: ["project"], capabilities: ["events.subscribe"] } as never;
      await db.insert(companies).values([
        { id: unlistedCompanyId, name: "Unlisted company", issuePrefix: `O${unlistedCompanyId.slice(0, 6)}` },
        { id: disabledCompanyId, name: "Disabled company", issuePrefix: `D${disabledCompanyId.slice(0, 6)}` },
      ]);
      await db.insert(plugins).values([
        { id: managedId, pluginKey: "paperclip.daytona-sandbox-provider", packageName: "managed", version: "1.0.0", status: "ready", packagePath: "/old/image/plugins/daytona", manifestJson },
        { id: ungrantedId, pluginKey: ungrantedId, packageName: "ungranted", version: "1.0.0", status: "ready", manifestJson },
      ]);
      await db.insert(pluginCompanySettings).values({ pluginId: managedId, companyId: disabledCompanyId, enabled: false });
      const resourceId = await event();
      await db.transaction(async tx => {
        await recordResourceCreationEvent(tx as unknown as Db, unlistedCompanyId, "project", randomUUID());
        await recordResourceCreationEvent(tx as unknown as Db, disabledCompanyId, "project", randomUUID());
      });
      const d = delivery();
      await d.run();
      const delivered = (id: string) => d.call.mock.calls.filter(([plugin]) => plugin === id).map(([, , input]) => input.resourceId);
      expect(delivered(managedId)).toEqual([resourceId]);
      expect(delivered(ungrantedId)).toEqual([]);
      expect(delivered(pluginId)).toEqual([resourceId]);
      await d.worker.dispose();
    });
  });
  it("listens for a managed plugin with no config row until its last enabled company disables it", async () => {
    await withManagedPlugin([companyId], async () => {
      await db.delete(plugins);
      const managedId = randomUUID();
      await db.insert(plugins).values({ id: managedId, pluginKey: "paperclip.daytona-sandbox-provider", packageName: "managed", version: "1.0.0", status: "ready",
        manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never });
      const subscription = { unlisten: vi.fn(), state: {} };
      vi.mocked(db.$client.listen).mockResolvedValueOnce(subscription as never);
      const d = delivery();
      await d.worker.ready;
      expect(db.$client.listen).toHaveBeenCalledWith("paperclip_plugin_lifecycle", expect.any(Function), expect.any(Function));
      await db.insert(pluginCompanySettings).values({ pluginId: managedId, companyId, enabled: false });
      d.applied();
      await vi.waitFor(() => expect(listenerOwners[0]!.close).toHaveBeenCalledTimes(1));
      await d.worker.dispose();
    });
  });
  it("does not listen for a managed plugin that the document enables for no company", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "delivery-managed-"));
    await mkdir(path.join(root, "sandbox-providers/daytona"), { recursive: true });
    vi.stubEnv("PAPERCLIP_BUNDLED_PLUGIN_ROOT", root);
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "1", features: {},
      plugins: { autoInstall: ["daytona"], workerEnv: { daytona: ["PROVIDER_ORIGIN"] } } }));
    try {
      await db.delete(plugins);
      await db.insert(plugins).values({ id: randomUUID(), pluginKey: "paperclip.daytona-sandbox-provider", packageName: "managed", version: "1.0.0", status: "ready",
        manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never });
      const d = delivery();
      await d.worker.ready;
      expect(db.$client.listen).not.toHaveBeenCalled();
      await d.worker.dispose();
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
  it("delivers project events to a storage provider only for projects attached to it", async () => {
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["project"], capabilities: ["events.subscribe", "workspaces.manage"], workspaceProvider: { modes: ["isolated_workspace"], strategies: ["git_worktree"] } } as never }).where(eq(plugins.id, pluginId));
    const [core] = await db.insert(projects).values({ companyId, name: "Core project" }).returning();
    const [attached] = await db.insert(projects).values({ companyId, name: "Attached project", executionWorkspacePolicy: { enabled: true, storageProviderPluginId: pluginId } }).returning();
    await event(core.id);
    await event(attached.id);
    const d = delivery();
    try {
      await d.run();
      expect(d.call).toHaveBeenCalledTimes(1);
      expect(d.call.mock.calls[0][2]).toMatchObject({ resourceId: attached.id });
      expect(await pluginLifecycleInbox(db, pluginId).list(companyId)).toEqual([]);
      await db.update(projects).set({ executionWorkspacePolicy: { enabled: true, storageProviderPluginId: pluginId } }).where(eq(projects.id, core.id));
      await event(core.id, "update");
      await d.run();
      expect(d.call).toHaveBeenCalledTimes(2);
      expect(d.call.mock.calls[1][2]).toMatchObject({ resourceId: core.id, action: "update" });
    } finally {
      await d.worker.dispose();
    }
  });

  it("delivers a deleted project's event to a storage provider", async () => {
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["project"], capabilities: ["events.subscribe", "workspaces.manage"], workspaceProvider: { modes: ["isolated_workspace"], strategies: ["git_worktree"] } } as never }).where(eq(plugins.id, pluginId));
    const removed = await event(randomUUID(), "delete");
    const d = delivery();
    try {
      await d.run();
      expect(d.call.mock.calls[0][2]).toMatchObject({ resourceId: removed, action: "delete" });
    } finally {
      await d.worker.dispose();
    }
  });

  it("supplies project native credentials only to opted-in callbacks and saves returned patches before acknowledgment", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["project"], capabilities: ["events.subscribe", "projects.instance-secrets"] } as never }).where(eq(plugins.id, pluginId));
    const [project] = await db.insert(projects).values({ companyId, name: "Native credentials owner" }).returning();
    await event(project.id);
    const d = delivery();
    d.call.mockImplementationOnce(async (_p, _m, input) => {
      expect(input.instanceSecrets).toEqual({});
      return { eventId: input.id, status: "acknowledged", instanceSecrets: { mount_grants: "fixture-private-grants" } };
    });
    try {
      await d.run();
      expect(await pluginLifecycleInbox(db, pluginId).list(companyId)).toEqual([]);
      expect(await db.select().from(companySecrets).where(eq(companySecrets.ownerProjectId, project.id))).toHaveLength(1);
      await event(project.id, "update");
      d.call.mockImplementationOnce(async (_p, _m, input) => {
        expect(input.instanceSecrets).toEqual({ mount_grants: "fixture-private-grants" });
        return { eventId: input.id, status: "retry", instanceSecrets: { mount_grants: "must-not-save" } };
      });
      await d.run();
      const [stored] = await db.select().from(companySecrets).where(eq(companySecrets.ownerProjectId, project.id));
      expect(stored.latestVersion).toBe(1);
      expect(JSON.stringify(await pluginLifecycleInbox(db, pluginId).list(companyId))).not.toContain("fixture-private-grants");
    } finally { await d.worker.dispose(); vi.unstubAllEnvs(); }
  });
  it("rejects credential patches from plugins without project instance secret scope", async () => {
    await event(); const d = delivery();
    d.call.mockImplementationOnce(async (_p, _m, input) => {
      expect(input.instanceSecrets).toBeUndefined();
      return { eventId: input.id, status: "acknowledged", instanceSecrets: { mount_grants: "private" } };
    });
    try { await d.run(); expect(await pluginLifecycleInbox(db, pluginId).list(companyId)).toHaveLength(1); }
    finally { await d.worker.dispose(); }
  });
  it.each([false, true])("does not wait for queued plugin callbacks during startup (runtime subscriber: %s)", async runtime => {
    if (runtime) await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["project", "agent_runtime"], capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId));
    await event();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const call = vi.fn(async (_plugin, _method, input) => { await blocked; return { eventId: input.id, status: "acknowledged" }; });
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => {} });
    const worker = registerPluginLifecycleDelivery(coordinator, db, { call, isRunning: () => true, onConfigApplied: () => () => {} } as never, new EventEmitter() as never);
    let ready = false;
    void worker.ready.then(() => { ready = true; });
    try {
      await vi.waitFor(() => expect(call).toHaveBeenCalled(), { timeout: 5000 });
      await vi.waitFor(() => expect(ready).toBe(true));
      expect(await pluginLifecycleInbox(db, pluginId).list(companyId)).toHaveLength(1);
    } finally { release(); await worker.dispose(); await coordinator.stop(); }
  });
  describe("agent runtime events", () => {
    const runtimeManifest = (capabilities: string[]) => ({ resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe", ...capabilities] }) as never;
    async function agent(name: string, requiredPluginIds: string[] | null) {
      const [row] = await db.insert(agents).values({ companyId, name, adapterType: "process" }).returning({ id: agents.id });
      await db.update(agents).set({ lifecycleRequiredPluginIds: requiredPluginIds }).where(eq(agents.id, row.id));
      return row.id;
    }
    const delivered = (d: ReturnType<typeof delivery>) => new Set(d.call.mock.calls.map(c => c[2].resourceId));
    async function drain(d: ReturnType<typeof delivery>) {
      do { await d.run(); } while (await d.pending());
    }

    it("delivers only the agents a lifecycle plugin owns and acknowledges the rest", async () => {
      await db.update(plugins).set({ manifestJson: runtimeManifest(["agents.lifecycle.manage"]) }).where(eq(plugins.id, pluginId));
      const owned = await agent("Owned", [pluginId]);
      await agent("Other plugin", [randomUUID()]);
      await agent("No plugins", []);
      await agent("Not selected", null);
      const d = delivery();
      try {
        await drain(d);
        expect(delivered(d)).toEqual(new Set([owned]));
        expect(await pluginLifecycleInbox(db, pluginId).list(companyId, 100, undefined, ["agent_runtime"])).toEqual([]);
      } finally {
        await d.worker.dispose();
      }
    });

    it("delivers a new event after an agent selects the plugin and reaches ready", async () => {
      await db.update(plugins).set({ manifestJson: runtimeManifest(["agents.lifecycle.manage"]) }).where(eq(plugins.id, pluginId));
      const id = await agent("Later owned", null);
      const d = delivery();
      try {
        await drain(d);
        expect(d.call).not.toHaveBeenCalled();
        await db.update(agents).set({ lifecycleState: "preparing", lifecycleRequiredPluginIds: [pluginId] }).where(eq(agents.id, id));
        await db.update(agents).set({ lifecycleState: "ready" }).where(eq(agents.id, id));
        await drain(d);
        expect(delivered(d)).toEqual(new Set([id]));
      } finally {
        await d.worker.dispose();
      }
    });

    it("delivers a deleted agent's event to a lifecycle plugin", async () => {
      await db.update(plugins).set({ manifestJson: runtimeManifest(["agents.lifecycle.manage"]) }).where(eq(plugins.id, pluginId));
      const id = await agent("Removed", [pluginId]);
      await db.delete(agents).where(eq(agents.id, id));
      const d = delivery();
      try {
        await drain(d);
        expect(d.call.mock.calls.at(-1)?.[2]).toMatchObject({ resourceId: id, action: "delete" });
      } finally {
        await d.worker.dispose();
      }
    });

    it("keeps delivering to a subscriber that does not manage agent lifecycles", async () => {
      await db.update(plugins).set({ manifestJson: runtimeManifest([]) }).where(eq(plugins.id, pluginId));
      const id = await agent("Observed", null);
      const d = delivery();
      try {
        await drain(d);
        expect(delivered(d)).toEqual(new Set([id]));
      } finally {
        await d.worker.dispose();
      }
    });
  });

  it("drains creation before transitions, recovers acknowledgments across dispatcher replacement, and ignores agent events", async () => {
    const id = await event(); await event(id, "update"); await event(id, "delete");
    await db.transaction(tx => recordResourceCreationEvent(tx as unknown as Db, companyId, "agent", randomUUID()));
    const first = delivery(); await first.run(); await first.worker.dispose();
    expect(first.call.mock.calls.map(c => c[2].action)).toEqual(["create"]);
    const restarted = delivery(); await restarted.run(); await restarted.run(); await restarted.run();
    expect(restarted.call.mock.calls.map(c => c[2].action)).toEqual(["update", "delete"]);
    expect(await restarted.pending()).toBe(false);
    expect((await pluginLifecycleInbox(db, pluginId).list(companyId)).map(e => e.resourceType)).toEqual(["agent"]);
    await restarted.worker.dispose();
  });
  it("replays failures and invalid acknowledgments without blocking independent resources", async () => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const failed = await event(); await event(failed, "delete"); await event();
    const d = delivery();
    d.call.mockImplementationOnce(async () => { throw new Error("worker exited after provider effect"); });
    await d.run();
    expect(d.call).toHaveBeenCalledTimes(2); expect(await d.pending()).toBe(true);
    d.call.mockImplementationOnce(async () => ({ eventId: "wrong", status: "acknowledged" }));
    now += 30_000; await d.run(); expect(await d.pending()).toBe(true);
    now += 30_000; await d.run(); await d.run();
    expect(d.call.mock.calls.map(c => c[2].action)).toEqual(["create", "create", "create", "create", "delete"]);
    expect(await pluginLifecycleInbox(db, pluginId).list(companyId)).toEqual([]);
    await d.worker.dispose();
  });
  it("healthy acknowledgments and new events do not bypass a failed event's retry deadline", async () => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const failed = await event(), healthy = await event();
    await event(healthy, "update"); await event(healthy, "delete");
    const d = delivery();
    d.call.mockImplementation(async (_p, _m, e) => ({ eventId: e.id, status: e.resourceId === failed ? "retry" : "acknowledged" }));
    await d.run();
    const deadline = now + 30_000;
    expect(d.nextRunAt()).toBe(deadline);
    now += 1000;
    await d.run(); await d.run(); await event(); d.settled(); await d.run();
    expect(d.call.mock.calls.filter(c => c[2].resourceId === healthy).map(c => c[2].action)).toEqual(["create", "update", "delete"]);
    expect(d.call.mock.calls.filter(c => c[2].resourceId === failed)).toHaveLength(1);
    expect(d.nextRunAt()).toBe(deadline);
    now = deadline;
    expect(d.nextRunAt()).toBeNull(); // Paused dispatch waits for the normal retry, not a zero-delay loop.
    await d.run();
    expect(d.call.mock.calls.filter(c => c[2].resourceId === failed)).toHaveLength(2);
    expect(d.nextRunAt()).toBe(now + 30_000);
    await d.worker.dispose();
  });
  it("defers without a retry deadline, retries unfinished work, and wakes on plugin startup", async () => {
    await event(); const d = delivery();
    d.call.mockImplementationOnce(async (_p, _m, e) => ({ eventId: e.id, status: "deferred" }));
    await d.run(); expect(await d.pending()).toBe(false); expect(d.wake).not.toHaveBeenCalled();
    d.lifecycle.emit("plugin.worker_started"); expect(d.wake).toHaveBeenCalledTimes(1);
    d.call.mockImplementationOnce(async (_p, _m, e) => ({ eventId: e.id, status: "retry" }));
    await d.run(); expect(await d.pending()).toBe(true);
    d.running.mockReturnValue(false); await d.run(); expect(await d.pending()).toBe(true);
    expect(d.call).toHaveBeenCalledTimes(2); await d.worker.dispose();
    d.lifecycle.emit("plugin.worker_started"); expect(d.wake).toHaveBeenCalledTimes(1);
  });
  it("requires ready, configured, company-enabled plugins and rechecks disabling within a batch", async () => {
    await event(); await event(); const d = delivery(); const registry = pluginRegistryService(db);
    await registry.upsertCompanySettings(pluginId, companyId, { enabled: false, settingsJson: {} });
    await d.run(); expect(d.call).not.toHaveBeenCalled();
    await registry.upsertCompanySettings(pluginId, companyId, { enabled: true, settingsJson: {} });
    d.call.mockImplementationOnce(async (_p, _m, e) => {
      await registry.upsertCompanySettings(pluginId, companyId, { enabled: false, settingsJson: {} });
      return { eventId: e.id, status: "acknowledged" };
    });
    await d.run(); expect(d.call).toHaveBeenCalledTimes(1);
    await registry.upsertCompanySettings(pluginId, companyId, { enabled: true, settingsJson: {} });
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
    await d.run(); expect(d.call).toHaveBeenCalledTimes(1);
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId));
    await db.delete(pluginConfig).where(eq(pluginConfig.pluginId, pluginId));
    await d.run(); expect(d.call).toHaveBeenCalledTimes(1); await d.worker.dispose();
  });
  it("notifies only after the outer transaction settles and wakes deferred work for config changes", async () => {
    const wake = vi.fn(); const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.pluginLifecycle, wake);
    try {
      await db.transaction(async tx => {
        await eventInTransaction(tx as unknown as Db);
        expect(wake).not.toHaveBeenCalled();
      });
      expect(wake).toHaveBeenCalledTimes(1);
      const registry = pluginRegistryService(db);
      await registry.upsertConfig(pluginId, companyId, { companyId, configJson: { enabled: true } });
      await registry.patchConfig(pluginId, companyId, { companyId, configJson: { enabled: false } });
      await registry.upsertCompanySettings(pluginId, companyId, { enabled: true, settingsJson: {} });
      expect(wake).toHaveBeenCalledTimes(4);
    } finally { unsubscribe(); }
    async function eventInTransaction(tx: Db) {
      await tx.transaction(inner => recordResourceCreationEvent(inner as unknown as Db, companyId, "project", randomUUID()));
    }
  });
  it("retains startup and settled work while idle drain prevents dispatch", async () => {
    const d = delivery();
    // The coordinator can call hasPending without run when admission is paused.
    expect(await d.pending()).toBe(true);
    await d.run(); expect(await d.pending()).toBe(false);
    await event(); d.settled();
    expect(await d.pending()).toBe(true);
    expect(d.call).not.toHaveBeenCalled();
    await d.run();
    expect(d.call).toHaveBeenCalledTimes(1);
    expect(await d.pending()).toBe(true); // An acknowledgment must drain its successor.
    await d.run(); expect(await d.pending()).toBe(false);
    d.lifecycle.emit("plugin.enabled"); expect(await d.pending()).toBe(true);
    await d.run(); expect(await d.pending()).toBe(false);
    d.worker.wake(); expect(await d.pending()).toBe(true);
    await d.worker.dispose();
  });
  it("wakes deferred events after live configuration finishes applying", async () => {
    await event(); const d = delivery();
    let configured = false;
    d.call.mockImplementation(async (_p, _m, e) => ({ eventId: e.id, status: configured ? "acknowledged" : "deferred" }));
    await d.run(); expect(await d.pending()).toBe(false);
    // Commit notification races ahead of the asynchronous worker callback.
    d.settled(); await d.run(); expect(await d.pending()).toBe(false);
    configured = true; d.applied();
    expect(await d.pending()).toBe(true); expect(d.wake).toHaveBeenCalledTimes(1);
    await d.run(); expect(await pluginLifecycleInbox(db, pluginId).list(companyId)).toEqual([]);
    await d.worker.dispose(); d.wake.mockClear(); d.applied(); expect(d.wake).not.toHaveBeenCalled();
  });
  it("retains a failed scan across a retry skipped during idle drain", async () => {
    await event(); const d = delivery();
    await d.worker.ready;
    const select = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("database unavailable"); });
    await expect(d.run()).rejects.toThrow("database unavailable");
    // The coordinator's drain path checks hasPending without calling run.
    expect(await d.pending()).toBe(true); expect(d.call).not.toHaveBeenCalled();
    select.mockRestore(); await d.run(); await d.run();
    expect(await d.pending()).toBe(false);
    expect(await pluginLifecycleInbox(db, pluginId).list(companyId)).toEqual([]);
    await d.worker.dispose();
  });
  it("saves config and settings without borrowing another pool connection", async () => {
    const single = createDb(externalUrl ?? database.connectionString, { maxConnections: 1 });
    try {
      const registry = pluginRegistryService(single);
      await registry.upsertConfig(pluginId, companyId, { companyId, configJson: { first: true } });
      await registry.patchConfig(pluginId, companyId, { companyId, configJson: { second: true } });
      await registry.upsertCompanySettings(pluginId, companyId, { enabled: true, settingsJson: {} });
      expect((await registry.getConfig(pluginId, companyId))?.configJson).toEqual({ first: true, second: true });
    } finally { await single.$client.end({ timeout: 1 }); }
  }, 5000);
  it("retries listener setup through durable delivery after an enable-time failure", async () => {
    const d = delivery();
    await d.worker.ready;
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId));
    const listen = vi.mocked(db.$client.listen);
    listen.mockRejectedValueOnce(new Error("temporary listener outage"));
    d.lifecycle.emit("plugin.enabled");
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    expect(await d.pending()).toBe(true);
    await d.run();
    expect(listen).toHaveBeenCalledTimes(2);
    expect(await d.pending()).toBe(false);
    await d.worker.dispose();
  });
  it("unregisters the listener on the last disable or unload and can subscribe again", async () => {
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId));
    const otherPluginId = randomUUID();
    await db.insert(plugins).values({ id: otherPluginId, pluginKey: otherPluginId, packageName: "other-runtime", version: "1.0.0", status: "ready", manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never });
    await db.insert(pluginConfig).values({ pluginId: otherPluginId, companyId, configJson: {} });
    const first = { unlisten: vi.fn(), state: {} };
    const second = { unlisten: vi.fn(), state: {} };
    const third = { unlisten: vi.fn(), state: {} };
    const listen = vi.mocked(db.$client.listen).mockResolvedValueOnce(first as never).mockResolvedValueOnce(second as never).mockResolvedValueOnce(third as never);
    const d = delivery();
    await d.worker.ready;
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
    d.lifecycle.emit("plugin.status_changed");
    await d.run();
    expect(listenerOwners[0]!.close).not.toHaveBeenCalled();
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, otherPluginId));
    d.lifecycle.emit("plugin.disabled");
    await vi.waitFor(() => expect(listenerOwners[0]!.close).toHaveBeenCalledTimes(1));
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId));
    d.lifecycle.emit("plugin.enabled");
    await d.run();
    expect(listen).toHaveBeenCalledTimes(2);
    const registry = pluginRegistryService(db);
    await registry.upsertCompanySettings(pluginId, companyId, { enabled: false, settingsJson: {} });
    d.applied();
    await vi.waitFor(() => expect(listenerOwners[1]!.close).toHaveBeenCalledTimes(1));
    await registry.upsertCompanySettings(pluginId, companyId, { enabled: true, settingsJson: {} });
    d.applied(); await d.run();
    expect(listen).toHaveBeenCalledTimes(3);
    await db.delete(plugins).where(eq(plugins.id, pluginId));
    d.lifecycle.emit("plugin.unloaded");
    await vi.waitFor(() => expect(listenerOwners[2]!.close).toHaveBeenCalledTimes(1));
    expect(listenerOwners[0]!.close).toHaveBeenCalledTimes(1);
    expect(listenerOwners[1]!.close).toHaveBeenCalledTimes(1);
    await d.worker.dispose();
    expect(d.lifecycle.listenerCount("plugin.status_changed")).toBe(0);
    expect(d.lifecycle.listenerCount("plugin.disabled")).toBe(0);
    expect(d.lifecycle.listenerCount("plugin.unloaded")).toBe(0);
  });
  it("retires disabled-feature retry history without discarding the original backoff on re-enable", async () => {
    const register = idleWorkModule.registerIdleLocalWorkProbe;
    let inspect: (() => string) | undefined;
    vi.spyOn(idleWorkModule, "registerIdleLocalWorkProbe").mockImplementation(probe => {
      inspect = () => probe({}); return register(probe);
    });
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    await event();
    const d = delivery(); await d.worker.ready;
    d.call.mockImplementationOnce(async () => { throw new Error("provider retry fixture"); });
    await d.run();
    const originalDeadline = now + 30_000;
    expect(await d.pending()).toBe(true);
    expect(d.nextRunAt()).toBe(originalDeadline);
    expect(d.call).toHaveBeenCalledTimes(1);
    const registry = pluginRegistryService(db);
    now += 1_000;
    await registry.upsertCompanySettings(pluginId, companyId, { enabled: false, settingsJson: {} });
    d.applied(); await d.run();
    expect(await d.pending()).toBe(false);
    expect(d.nextRunAt()).toBeNull();
    startTaskDrain({ purpose: "idle", ttlMs: 30_000 });
    expect(await d.worker.prepareForIdleSleep({ canRetire: () => true })).toBe("none");
    expect(inspect?.()).toBe("none");
    stopTaskDrain();
    now += 1_000;
    await registry.upsertCompanySettings(pluginId, companyId, { enabled: true, settingsJson: {} });
    d.applied(); await d.run();
    expect(await d.pending()).toBe(true);
    expect(d.nextRunAt()).toBe(originalDeadline);
    expect(d.call).toHaveBeenCalledTimes(1);
    expect(inspect?.()).toBe("present");
    startTaskDrain({ purpose: "idle", ttlMs: 30_000 });
    expect(await d.worker.prepareForIdleSleep({ canRetire: () => true })).toBe("present");
    stopTaskDrain();
    now = originalDeadline - 1; await d.run();
    expect(d.call).toHaveBeenCalledTimes(1);
    expect(d.nextRunAt()).toBe(originalDeadline);
    now = originalDeadline; await d.run(); await d.run();
    expect(d.call).toHaveBeenCalledTimes(2);
    expect(await pluginLifecycleInbox(db, pluginId).list(companyId)).toEqual([]);
    expect(await d.pending()).toBe(false);
    expect(d.nextRunAt()).toBeNull();
  });
  it("requires a current owned idle drain even when the caller supplies a true predicate", async () => {
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId));
    const d = delivery(); await d.worker.ready; await d.run(); await d.run();
    expect(await d.worker.prepareForIdleSleep({ canRetire: () => true })).toBe("unknown");
    expect(listenerOwners[0]!.close).not.toHaveBeenCalled();
  });
  it("retains an uncertain listener close and refuses retirement after authority changes", async () => {
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId));
    const d = delivery(); await d.worker.ready; await d.run(); await d.run();
    startTaskDrain({ purpose: "idle", ttlMs: 30_000 });
    const close = listenerOwners[0]!.close;
    close.mockRejectedValueOnce(new Error("listener close uncertain"));
    expect(await d.worker.prepareForIdleSleep({ canRetire: () => true })).toBe("unknown");
    expect(close).toHaveBeenCalledTimes(1);
    expect(await d.worker.prepareForIdleSleep({ canRetire: () => false })).toBe("unknown");
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRejectedValueOnce(new Error("listener close still uncertain"));
    expect(await d.worker.prepareForIdleSleep({ canRetire: () => true })).toBe("unknown");
    expect(close).toHaveBeenCalledTimes(2);
    expect(await d.worker.prepareForIdleSleep({ canRetire: () => true })).toBe("none");
    expect(close).toHaveBeenCalledTimes(3);
  });
  it("recovers a post-close journal inspection failure without creating another listener", async () => {
    const register = idleWorkModule.registerIdleLocalWorkProbe;
    let inspect: (() => string) | undefined;
    vi.spyOn(idleWorkModule, "registerIdleLocalWorkProbe").mockImplementation(probe => {
      inspect = () => probe({});
      return register(probe);
    });
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId));
    const d = delivery(); await d.worker.ready; await d.run(); await d.run();
    startTaskDrain({ purpose: "idle", ttlMs: 30_000 });
    listenerOwners[0]!.close.mockImplementationOnce(async () => {
      vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("post-close journal unavailable"); });
    });
    expect(await d.worker.prepareForIdleSleep({ canRetire: () => true })).toBe("unknown");
    expect(inspect?.()).toBe("unknown");
    expect(listenerOwners[0]!.close).toHaveBeenCalledTimes(1);
    vi.mocked(db.select).mockRestore();
    expect(await d.worker.prepareForIdleSleep({ canRetire: () => true })).toBe("none");
    expect(inspect?.()).toBe("none");
    expect(listenerOwners).toHaveLength(1);
    expect(listenerOwners[0]!.close).toHaveBeenCalledTimes(1);
  });
  it("recovers an absent-feature inspection failure without manufacturing a listener", async () => {
    const register = idleWorkModule.registerIdleLocalWorkProbe;
    let inspect: (() => string) | undefined;
    vi.spyOn(idleWorkModule, "registerIdleLocalWorkProbe").mockImplementation(probe => {
      inspect = () => probe({});
      return register(probe);
    });
    const d = delivery(); await d.worker.ready; await d.run();
    startTaskDrain({ purpose: "idle", ttlMs: 30_000 });
    const select = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("journal unavailable"); });
    expect(await d.worker.prepareForIdleSleep({ canRetire: () => true })).toBe("unknown");
    expect(inspect?.()).toBe("unknown");
    select.mockRestore();
    expect(await d.worker.prepareForIdleSleep({ canRetire: () => true })).toBe("none");
    expect(inspect?.()).toBe("none");
    expect(listenerOwners).toHaveLength(0);
  });
  it("retries failed normal disposal without losing its owned listener", async () => {
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId));
    const d = delivery(); await d.worker.ready;
    listenerOwners[0]!.close.mockRejectedValueOnce(new Error("owned disposal failed"));
    await expect(d.worker.dispose()).rejects.toThrow("owned disposal failed");
    expect(listenerOwners[0]!.close).toHaveBeenCalledTimes(1);
    await d.worker.dispose();
    expect(listenerOwners[0]!.close).toHaveBeenCalledTimes(2);
  });
  it("invalidates a retirement when configuration arrives during its owned close", async () => {
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId));
    const d = delivery(); await d.worker.ready; await d.run(); await d.run();
    startTaskDrain({ purpose: "idle", ttlMs: 30_000 });
    let release!: () => void, entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    listenerOwners[0]!.close.mockImplementationOnce(async () => { entered(); await gate; });
    const preparation = d.worker.prepareForIdleSleep({ canRetire: () => true });
    try { await began; d.applied(); }
    finally { release(); }
    expect(await preparation).toBe("unknown");
    expect(await d.pending()).toBe(true);
    expect(listenerOwners).toHaveLength(1);
  });
  it("refuses an owned retirement while a real lifecycle callback remains active", async () => {
    await event(); const d = delivery(); await d.worker.ready;
    let release!: () => void, entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    d.call.mockImplementationOnce(async (_p, _m, value) => { entered(); await gate; return { eventId: value.id, status: "acknowledged" }; });
    const run = d.run();
    try {
      await began;
      startTaskDrain({ purpose: "idle", ttlMs: 30_000 });
      expect(await d.worker.prepareForIdleSleep({ canRetire: () => true })).toBe("present");
      expect(listenerOwners.every(owner => owner.close.mock.calls.length === 0)).toBe(true);
    } finally { release(); await run; }
  });
  it("keeps journal arrivals during an owned close as actual pending work", async () => {
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId));
    const d = delivery(); await d.worker.ready; await d.run(); await d.run();
    startTaskDrain({ purpose: "idle", ttlMs: 30_000 });
    let release!: () => void, entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    listenerOwners[0]!.close.mockImplementationOnce(async () => { entered(); await gate; });
    const preparation = d.worker.prepareForIdleSleep({ canRetire: () => true });
    try { await began; await db.insert(agents).values({ companyId, name: "Arrived during retirement", adapterType: "process" }); }
    finally { release(); }
    expect(await preparation).toBe("present");
    expect(await pluginLifecycleInbox(db, pluginId).list(companyId, 1, undefined, ["agent_runtime"])).not.toHaveLength(0);
  });
  it("finishes exact already-started cleanup but rejects an invalidated retirement permit", async () => {
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId));
    const d = delivery(); await d.worker.ready; await d.run(); await d.run();
    startTaskDrain({ purpose: "idle", ttlMs: 30_000 });
    let release!: () => void, entered!: () => void, permitted = true;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    listenerOwners[0]!.close.mockImplementationOnce(async () => { entered(); await gate; });
    const preparation = d.worker.prepareForIdleSleep({ canRetire: () => permitted });
    try { await began; permitted = false; }
    finally { release(); }
    expect(await preparation).toBe("unknown");
    expect(listenerOwners[0]!.close).toHaveBeenCalledTimes(1);
  });
  it("joins an in-progress listener creation on idempotent normal disposal", async () => {
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId));
    let release!: () => void, entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(db.$client.listen).mockImplementationOnce(async () => { entered(); await gate; return { state: {}, unlisten: vi.fn() } as never; });
    const d = delivery();
    await began;
    const disposal = d.worker.dispose();
    release();
    await disposal;
    await d.worker.dispose();
    expect(listenerOwners[0]!.close).toHaveBeenCalledTimes(1);
    expect(d.lifecycle.listenerCount("plugin.enabled")).toBe(0);
  });
  it("reopens a physically retired listener at normal TTL expiry and delivers newly found journal debt without a manual wake", async () => {
    vi.mocked(databaseModule.createOwnedDatabaseListener).mockRestore();
    const createListener = databaseModule.createOwnedDatabaseListener;
    let created = 0, arrivalId: string | undefined;
    const foreignCompany = randomUUID();
    await db.insert(companies).values({ id: foreignCompany, name: "Foreign expiry runtime", issuePrefix: `X${foreignCompany.slice(0, 6)}` });
    vi.spyOn(databaseModule, "createOwnedDatabaseListener").mockImplementation(owner => {
      const listener = createListener(owner), ordinal = ++created;
      return { listen: listener.listen, close: async () => {
        await listener.close();
        if (ordinal === 1 && !arrivalId) {
          await db.transaction(async tx => {
            const [arrival] = await tx.insert(agents).values({ companyId, name: "Arrived after physical close", adapterType: "process" }).returning();
            arrivalId = arrival!.id;
            await tx.insert(agents).values({ companyId: foreignCompany, name: "Foreign after physical close", adapterType: "process" });
          });
        }
      } };
    });
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId));
    const calls = vi.fn(async (_plugin, _method, value) => ({ eventId: value.id, status: "acknowledged" }));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !isIdleTaskDrainActive(), canReconcile: () => true, onError: error => errors.push(error) });
    const expiry = registerTaskDrainExpiryWork(coordinator, () => {});
    const worker = registerPluginLifecycleDelivery(coordinator, db, { call: calls, isRunning: () => true, onConfigApplied: () => () => {} } as never, new EventEmitter() as never);
    try {
      await expiry.ready; await worker.ready;
      await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
      const identity = () => db.execute(sql`SELECT pid, backend_start::text AS started, client_port FROM pg_stat_activity WHERE datname = current_database() AND query = 'listen "paperclip_plugin_lifecycle"'`);
      const [before] = await identity(); expect(before).toBeDefined();
      startTaskDrain({ purpose: "idle", ttlMs: 1_000 });
      await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
      expect(await worker.prepareForIdleSleep({ canRetire: () => true })).toBe("present");
      expect(await db.execute(sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid = ${before!.pid}::integer AND backend_start = ${before!.started}::timestamptz AND client_port = ${before!.client_port}::integer`)).toHaveLength(0);
      expect(created).toBe(1);
      await vi.waitFor(() => expect(calls.mock.calls.some(([, , value]) => value.resourceId === arrivalId && value.companyId === companyId)).toBe(true), { timeout: 5_000 });
      expect(created).toBe(2);
      expect(calls.mock.calls.some(([, , value]) => value.companyId === foreignCompany)).toBe(false);
      const [resumed] = await identity(); expect(resumed).toBeDefined(); expect(resumed!.pid).not.toBe(before!.pid);
      await vi.waitFor(async () => expect(await db.execute(sql`SELECT 1 FROM plugin_lifecycle_acknowledgments ack JOIN resource_lifecycle_events event ON event.id = ack.event_id WHERE ack.plugin_id = ${pluginId}::uuid AND event.resource_id = ${arrivalId}::uuid AND event.company_id = ${companyId}::uuid`)).not.toHaveLength(0), { timeout: 5_000 });
      expect(errors).toEqual([]);
    } finally {
      try { await worker.dispose(); } finally { try { await expiry.stop(); } finally { await coordinator.stop(); } }
    }
  });
  it("physically closes only its owned LISTEN and recreates it for useful same-company work", async () => {
    vi.mocked(databaseModule.createOwnedDatabaseListener).mockRestore();
    vi.mocked(db.$client.listen).mockRestore();
    await db.update(plugins).set({ manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId));
    const foreign = await db.$client.listen("fixture_other_lifecycle", () => {});
    const d = delivery();
    try {
      await d.worker.ready; await d.run(); await d.run();
      const identity = async (channel: string) => db.execute(sql`SELECT pid, backend_start::text AS started, client_port FROM pg_stat_activity WHERE datname = current_database() AND query = ${'listen "' + channel + '"'}`);
      const [owned] = await identity("paperclip_plugin_lifecycle");
      const [other] = await identity("fixture_other_lifecycle");
      expect(owned).toBeDefined(); expect(other).toBeDefined(); expect(owned!.pid).not.toBe(other!.pid);
      startTaskDrain({ purpose: "idle", ttlMs: 30_000 });
      expect(await d.worker.prepareForIdleSleep({ canRetire: () => true })).toBe("none");
      expect(await db.execute(sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid = ${owned!.pid}::integer AND backend_start = ${owned!.started}::timestamptz AND client_port = ${owned!.client_port}::integer`)).toHaveLength(0);
      expect((await identity("fixture_other_lifecycle"))[0]?.pid).toBe(other!.pid);
      expect(await d.worker.prepareForIdleSleep({ canRetire: () => true })).toBe("none");
      stopTaskDrain();
      await d.run(); await d.run();
      const [resumed] = await identity("paperclip_plugin_lifecycle");
      expect(resumed).toBeDefined(); expect(resumed!.pid).not.toBe(owned!.pid);
      const [agent] = await db.insert(agents).values({ companyId, name: "Useful resumed runtime", adapterType: "process" }).returning();
      const foreignCompany = randomUUID();
      await db.insert(companies).values({ id: foreignCompany, name: "Foreign runtime", issuePrefix: `F${foreignCompany.slice(0, 6)}` });
      await db.insert(agents).values({ companyId: foreignCompany, name: "Excluded runtime", adapterType: "process" });
      await d.run(); await d.run();
      expect(d.call.mock.calls.some(([, , value]) => value.resourceId === agent!.id && value.companyId === companyId)).toBe(true);
      expect(d.call.mock.calls.some(([, , value]) => value.companyId === foreignCompany)).toBe(false);
      const acknowledged = await db.execute(sql`SELECT 1 FROM plugin_lifecycle_acknowledgments ack JOIN resource_lifecycle_events event ON event.id = ack.event_id WHERE ack.plugin_id = ${pluginId}::uuid AND event.company_id = ${companyId}::uuid AND event.resource_id = ${agent!.id}::uuid`);
      expect(acknowledged.length).toBeGreaterThan(0);
    } finally { await d.worker.dispose(); await foreign.unlisten(); }
  });
  it("records failed delivery scope and stage without provider secrets", async () => {
    await event(); const d = delivery();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      d.call.mockImplementationOnce(async () => { throw Object.assign(new Error("provider-secret-fixture"), { code: -32001 }); });
      await d.run();
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ pluginId, companyId, eventId: expect.any(String), stage: "callback", rpcCode: -32001 }), expect.any(String));
      expect(JSON.stringify(warn.mock.calls)).not.toContain("provider-secret-fixture");
      expect(await d.pending()).toBe(true);
    } finally { warn.mockRestore(); await d.worker.dispose(); }
  });
  it("rollbacks never expose queue rows even when settlement wakes the dispatcher", async () => {
    const d = delivery();
    await expect(db.transaction(async tx => {
      await recordResourceCreationEvent(tx as unknown as Db, companyId, "project", randomUUID());
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await d.run(); expect(d.call).not.toHaveBeenCalled(); expect(await d.pending()).toBe(false);
    expect(await db.select().from(resourceLifecycleEvents).where(eq(resourceLifecycleEvents.companyId, companyId))).toEqual([]);
    await d.worker.dispose();
  });
});
