import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { companies, createDb, companySecrets, projects, pluginConfig, plugins, resourceLifecycleEvents, type Db } from "@paperclipai/db";
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

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping lifecycle delivery database tests: ${support.reason}`);

describePostgres("durable plugin lifecycle delivery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let pluginId: string;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-plugin-delivery-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(async () => {
    vi.spyOn(db.$client, "listen").mockResolvedValue({ unlisten: vi.fn(), state: {} } as never);
    await db.delete(plugins);
    companyId = randomUUID(); pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Delivery fixture", issuePrefix: `L${companyId.slice(0, 6)}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "delivery-fixture", version: "1.0.0", status: "ready",
      manifestJson: { resourceLifecycle: ["project"], capabilities: ["events.subscribe"] } as never });
    await db.insert(pluginConfig).values({ pluginId, companyId, configJson: {} });
  });
  async function event(resourceId = randomUUID(), action: "create" | "update" | "delete" = "create") {
    await db.transaction(async tx => {
      if (action === "create") await recordResourceCreationEvent(tx as unknown as Db, companyId, "project", resourceId);
      else await recordProjectLifecycleEvent(tx as unknown as Db, companyId, resourceId, action);
    });
    return resourceId;
  }
  function delivery() {
    let task!: Parameters<ReturnType<typeof createDeliveryWorkCoordinator>["register"]>[1];
    const wake = vi.fn();
    const coordinator = { register: vi.fn((_queue, input) => { task = input; return { wake, ready: Promise.resolve() }; }) };
    const call = vi.fn(async (_pluginId, _method, input) => ({ eventId: input.id, status: "acknowledged" }));
    const running = vi.fn(() => true);
    const lifecycle = new EventEmitter();
    const configApplied = new Set<() => void>();
    const onConfigApplied = (listener: () => void) => { configApplied.add(listener); return () => { configApplied.delete(listener); }; };
    const worker = registerPluginLifecycleDelivery(coordinator as never, db, { call, isRunning: running, onConfigApplied } as unknown as PluginWorkerManager, lifecycle as unknown as PluginLifecycleManager);
    return { call, running, wake, lifecycle, worker, applied: () => { for (const listener of configApplied) listener(); }, run: () => task.run(new AbortController().signal), pending: () => task.hasPending(), nextRunAt: () => task.nextRunAt?.(), settled: () => task.onSettled?.() };
  }
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
    } finally { d.worker.dispose(); vi.unstubAllEnvs(); }
  });
  it("rejects credential patches from plugins without project instance secret scope", async () => {
    await event(); const d = delivery();
    d.call.mockImplementationOnce(async (_p, _m, input) => {
      expect(input.instanceSecrets).toBeUndefined();
      return { eventId: input.id, status: "acknowledged", instanceSecrets: { mount_grants: "private" } };
    });
    try { await d.run(); expect(await pluginLifecycleInbox(db, pluginId).list(companyId)).toHaveLength(1); }
    finally { d.worker.dispose(); }
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
    } finally { release(); worker.dispose(); await coordinator.stop(); }
  });
  it("drains creation before transitions, recovers acknowledgments across dispatcher replacement, and ignores agent events", async () => {
    const id = await event(); await event(id, "update"); await event(id, "delete");
    await db.transaction(tx => recordResourceCreationEvent(tx as unknown as Db, companyId, "agent", randomUUID()));
    const first = delivery(); await first.run(); first.worker.dispose();
    expect(first.call.mock.calls.map(c => c[2].action)).toEqual(["create"]);
    const restarted = delivery(); await restarted.run(); await restarted.run(); await restarted.run();
    expect(restarted.call.mock.calls.map(c => c[2].action)).toEqual(["update", "delete"]);
    expect(await restarted.pending()).toBe(false);
    expect((await pluginLifecycleInbox(db, pluginId).list(companyId)).map(e => e.resourceType)).toEqual(["agent"]);
    restarted.worker.dispose();
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
    d.worker.dispose();
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
    d.worker.dispose();
  });
  it("defers without a retry deadline, retries unfinished work, and wakes on plugin startup", async () => {
    await event(); const d = delivery();
    d.call.mockImplementationOnce(async (_p, _m, e) => ({ eventId: e.id, status: "deferred" }));
    await d.run(); expect(await d.pending()).toBe(false); expect(d.wake).not.toHaveBeenCalled();
    d.lifecycle.emit("plugin.worker_started"); expect(d.wake).toHaveBeenCalledTimes(1);
    d.call.mockImplementationOnce(async (_p, _m, e) => ({ eventId: e.id, status: "retry" }));
    await d.run(); expect(await d.pending()).toBe(true);
    d.running.mockReturnValue(false); await d.run(); expect(await d.pending()).toBe(true);
    expect(d.call).toHaveBeenCalledTimes(2); d.worker.dispose();
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
    await d.run(); expect(d.call).toHaveBeenCalledTimes(1); d.worker.dispose();
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
      await registry.upsertConfig(pluginId, companyId, { configJson: { enabled: true } });
      await registry.patchConfig(pluginId, companyId, { configJson: { enabled: false } });
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
    d.worker.dispose();
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
    d.worker.dispose(); d.wake.mockClear(); d.applied(); expect(d.wake).not.toHaveBeenCalled();
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
    d.worker.dispose();
  });
  it("saves config and settings without borrowing another pool connection", async () => {
    const single = createDb(database.connectionString, { maxConnections: 1 });
    const registry = pluginRegistryService(single);
    await registry.upsertConfig(pluginId, companyId, { configJson: { first: true } });
    await registry.patchConfig(pluginId, companyId, { configJson: { second: true } });
    await registry.upsertCompanySettings(pluginId, companyId, { enabled: true, settingsJson: {} });
    expect((await registry.getConfig(pluginId, companyId))?.configJson).toEqual({ first: true, second: true });
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
    d.worker.dispose();
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
    expect(first.unlisten).not.toHaveBeenCalled();
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, otherPluginId));
    d.lifecycle.emit("plugin.disabled");
    await vi.waitFor(() => expect(first.unlisten).toHaveBeenCalledTimes(1));
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId));
    d.lifecycle.emit("plugin.enabled");
    await d.run();
    expect(listen).toHaveBeenCalledTimes(2);
    const registry = pluginRegistryService(db);
    await registry.upsertCompanySettings(pluginId, companyId, { enabled: false, settingsJson: {} });
    d.applied();
    await vi.waitFor(() => expect(second.unlisten).toHaveBeenCalledTimes(1));
    await registry.upsertCompanySettings(pluginId, companyId, { enabled: true, settingsJson: {} });
    d.applied(); await d.run();
    expect(listen).toHaveBeenCalledTimes(3);
    await db.delete(plugins).where(eq(plugins.id, pluginId));
    d.lifecycle.emit("plugin.unloaded");
    await vi.waitFor(() => expect(third.unlisten).toHaveBeenCalledTimes(1));
    expect(first.unlisten).toHaveBeenCalledTimes(1);
    expect(second.unlisten).toHaveBeenCalledTimes(1);
    d.worker.dispose();
    expect(d.lifecycle.listenerCount("plugin.status_changed")).toBe(0);
    expect(d.lifecycle.listenerCount("plugin.disabled")).toBe(0);
    expect(d.lifecycle.listenerCount("plugin.unloaded")).toBe(0);
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
    } finally { warn.mockRestore(); d.worker.dispose(); }
  });
  it("rollbacks never expose queue rows even when settlement wakes the dispatcher", async () => {
    const d = delivery();
    await expect(db.transaction(async tx => {
      await recordResourceCreationEvent(tx as unknown as Db, companyId, "project", randomUUID());
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await d.run(); expect(d.call).not.toHaveBeenCalled(); expect(await d.pending()).toBe(false);
    expect(await db.select().from(resourceLifecycleEvents).where(eq(resourceLifecycleEvents.companyId, companyId))).toEqual([]);
    d.worker.dispose();
  });
});
