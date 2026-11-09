import { randomUUID } from "node:crypto";
import { createServer, connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, createDb, pluginCompanySettings, pluginConfig, plugins, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pluginAgentRuntimeState } from "../services/plugin-agent-runtime-state.js";
import { pluginLifecycleInbox } from "../services/plugin-lifecycle-inbox.js";
import { registerPluginLifecycleDelivery } from "../services/plugin-lifecycle-delivery.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { agentFileStore } from "../services/agent-file-store.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("agent runtime synchronization hooks", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let pluginId: string;
  let agentId: string;
  let home: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-agent-runtime-");
    db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-runtime-home-"));
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); await fs.rm(home, { recursive: true, force: true }); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_HOME", home);
    companyId = randomUUID(); pluginId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Runtime fixture", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "runtime-fixture", version: "1.0.0", status: "ready",
      manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe", "agents.lifecycle.manage"] } as never });
    await db.insert(pluginConfig).values({ pluginId, companyId, configJson: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runtime agent", lifecycleRequiredPluginIds: [pluginId] });
  });
  const events = () => db.select().from(resourceLifecycleEvents).where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"))).orderBy(resourceLifecycleEvents.id);

  it("captures all configuration writers while ignoring no-op and heartbeat bookkeeping updates", async () => {
    expect(await events()).toHaveLength(1);
    await db.update(agents).set({ name: "Runtime agent", updatedAt: new Date(), lastHeartbeatAt: new Date(), spendMonthUtc: "2099-01" }).where(eq(agents.id, agentId));
    expect(await events()).toHaveLength(1);
    await db.update(agents).set({ adapterConfig: { model: "fixture" }, permissions: { canCreateAgents: true } }).where(eq(agents.id, agentId));
    await db.update(agents).set({ runtimeConfig: { fixture: true } }).where(eq(agents.id, agentId));
    const rows = await events();
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.resourceId === agentId)).toBe(true);
    expect(Object.keys(rows[0]).sort()).toEqual(["action", "companyId", "createdAt", "id", "resourceId", "resourceType"]);
  });

  it("captures instruction saves, deletion and writeback through the shared file store", async () => {
    const actor = { type: "board" as const, userId: "local-board", source: "local_implicit" as const };
    await agentFileStore(db).write({ companyId, agentId, path: "AGENTS.md", bytes: Buffer.from("instructions"), baseHash: null }, actor);
    const saved = await agentFileStore(db).write({ companyId, agentId, path: "notes.txt", bytes: Buffer.from("notes"), baseHash: null }, actor);
    const beforeDelete = (await events()).length;
    await agentFileStore(db).write({ companyId, agentId, path: "notes.txt", bytes: null, baseHash: saved.contentHash }, actor);
    expect(await events()).toHaveLength(beforeDelete + 1);
    expect(await events()).toContainEqual(expect.objectContaining({ resourceId: agentId, action: "update" }));
  });

  it("records a managed reset even when only its supporting files changed", async () => {
    const before = (await events()).length;
    await db.insert(activityLog).values({ companyId, actorType: "plugin", actorId: pluginId, action: "plugin.managed_agent.reset", entityType: "agent", entityId: agentId });
    expect(await events()).toHaveLength(before + 1);
  });

  it("rolls configuration and its event back together and rejects a change when journaling fails", async () => {
    const before = await events();
    await expect(db.transaction(async tx => {
      await tx.update(agents).set({ name: "Rolled back" }).where(eq(agents.id, agentId));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await events()).toEqual(before);
    await db.execute((await import("drizzle-orm")).sql`ALTER TABLE resource_lifecycle_events ADD CONSTRAINT runtime_fixture_failure CHECK (resource_type <> 'agent_runtime') NOT VALID`);
    try { await expect(db.update(agents).set({ name: "Failed" }).where(eq(agents.id, agentId))).rejects.toThrow(); }
    finally { await db.execute((await import("drizzle-orm")).sql`ALTER TABLE resource_lifecycle_events DROP CONSTRAINT runtime_fixture_failure`); }
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0].name).toBe("Runtime agent");
    expect(await events()).toEqual(before);
  });

  it.each(["file-write", "file-delete", "instructions"])("repairs runtime delivery when %s is retried after journal failure", async writer => {
    const actor = { type: "board" as const, userId: "local-board", source: "local_implicit" as const };
    const instructions = agentInstructionRevisionService(db);
    const initial = await instructions.commit({ companyId, agentId, entryFile: "AGENTS.md", content: "original", baseRevisionId: null, source: "api" }, actor);
    const store = agentFileStore(db);
    const saved = writer === "file-delete" ? await store.write({ companyId, agentId, path: "notes.txt", bytes: Buffer.from("notes"), baseHash: null }, actor) : null;
    const save = () => writer === "instructions"
      ? instructions.commit({ companyId, agentId, entryFile: "AGENTS.md", content: "changed", baseRevisionId: initial.revision.id, source: "api" }, actor)
      : store.write({ companyId, agentId, path: saved ? "notes.txt" : "AGENTS.md", bytes: saved ? null : Buffer.from("changed"), baseHash: saved ? saved.contentHash : initial.revision.contentHash }, actor);
    const inbox = pluginLifecycleInbox(db, pluginId);
    for (const event of await events()) await inbox.acknowledge(companyId, String(event.id));
    const before = await events();
    await db.execute(sql`ALTER TABLE resource_lifecycle_events ADD CONSTRAINT file_runtime_failure CHECK (resource_type <> 'agent_runtime') NOT VALID`);
    try { await expect(save()).rejects.toThrow(); }
    finally { await db.execute(sql`ALTER TABLE resource_lifecycle_events DROP CONSTRAINT file_runtime_failure`); }
    expect(await events()).toEqual(before);
    expect(await store.read(companyId, agentId, saved ? "notes.txt" : "AGENTS.md", actor)).toEqual(saved ? null : Buffer.from("changed"));
    expect(await save()).toMatchObject({ changed: false });
    expect(await events()).toHaveLength(before.length + 1);
    expect(await inbox.list(companyId, 100, undefined, ["agent_runtime"])).toEqual([expect.objectContaining({ resourceId: agentId, action: "update" })]);
    const repaired = await events();
    const audits = await db.select().from(activityLog).where(eq(activityLog.entityId, agentId)).orderBy(activityLog.id);
    for (let replay = 0; replay < 5; replay++) expect(await save()).toMatchObject({ changed: false });
    expect(await events()).toEqual(repaired);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, agentId)).orderBy(activityLog.id)).toEqual(audits);
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agentId))!.revision).toBe(String((await events()).at(-1)!.id));
  });

  it("repairs a failed save even when that content hash was recorded before an intervening change", async () => {
    const actor = { type: "board" as const, userId: "local-board", source: "local_implicit" as const };
    const store = agentFileStore(db);
    const target = { companyId, agentId, path: "AGENTS.md" };
    const first = await store.write({ ...target, bytes: Buffer.from("first"), baseHash: null }, actor);
    const second = await store.write({ ...target, bytes: Buffer.from("second"), baseHash: first.contentHash }, actor);
    await store.write({ ...target, bytes: Buffer.from("first"), baseHash: second.contentHash }, actor);
    const before = (await events()).length;
    const save = () => store.write({ ...target, bytes: Buffer.from("second"), baseHash: first.contentHash }, actor);
    await db.execute(sql`ALTER TABLE resource_lifecycle_events ADD CONSTRAINT repeated_hash_failure CHECK (resource_type <> 'agent_runtime') NOT VALID`);
    try { await expect(save()).rejects.toThrow(); }
    finally { await db.execute(sql`ALTER TABLE resource_lifecycle_events DROP CONSTRAINT repeated_hash_failure`); }
    expect(await save()).toMatchObject({ changed: false });
    expect(await events()).toHaveLength(before + 1);
    await save();
    expect(await events()).toHaveLength(before + 1);
  });

  it("keeps old subscriptions isolated and replays runtime events in order until acknowledged", async () => {
    await db.update(agents).set({ name: "New name" }).where(eq(agents.id, agentId));
    const inbox = pluginLifecycleInbox(db, pluginId);
    expect(await inbox.list(companyId)).toEqual([]);
    const [first] = await inbox.list(companyId, 100, undefined, ["agent_runtime"]);
    expect(await inbox.list(companyId, 100, undefined, ["agent_runtime"])).toEqual([first]);
    const rows = await events();
    await expect(inbox.acknowledge(companyId, String(rows[1].id))).rejects.toMatchObject({ status: 409 });
    await inbox.acknowledge(companyId, first.id);
    expect(await inbox.list(companyId, 100, undefined, ["agent_runtime"])).toEqual([expect.objectContaining({ id: String(rows[1].id) })]);
  });

  it.each([{}, { instructionsBundleMode: "managed", instructionsRootPath: "/missing/previous-home" }])("recovers effective managed instruction paths from disk for %j", async adapterConfig => {
    const [agent] = await db.update(agents).set({ adapterConfig }).where(eq(agents.id, agentId)).returning();
    const root = resolveManagedInstructionsRoot(agent);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "GUIDE.md"), "restored instructions");
    const state = await pluginAgentRuntimeState(db, pluginId, companyId, agentId);
    expect(state).toMatchObject({ instructionsRootPath: root, instructionsEntryFile: "GUIDE.md" });
    expect(await fs.readFile(path.join(state!.instructionsRootPath!, state!.instructionsEntryFile), "utf8")).toBe("restored instructions");
  });

  it("supplies default instructions when the agent has no instruction directory", async () => {
    await db.update(agents).set({ adapterConfig: { promptTemplate: "Fallback task instructions" } }).where(eq(agents.id, agentId));
    expect(await pluginAgentRuntimeState(db, pluginId, companyId, agentId)).toMatchObject({
      instructionsRootPath: null, instructionsEntryFile: "AGENTS.md", instructionsEntryContent: "Fallback task instructions",
    });
  });

  it("resolves instructions without reading or hashing bundle contents", async () => {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const root = resolveManagedInstructionsRoot(agent);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "instructions");
    await fs.writeFile(path.join(root, "support.bin"), Buffer.alloc(1024 * 1024));
    const read = vi.spyOn(fs, "readFile");
    expect(await pluginAgentRuntimeState(db, pluginId, companyId, agentId)).toMatchObject({ instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" });
    expect(read.mock.calls.filter(([file]) => String(file).startsWith(`${root}${path.sep}`))).toEqual([]);
  });

  it("uses the company reporting graph for runtime health data", async () => {
    const [manager] = await db.insert(agents).values({ companyId, name: "Manager" }).returning();
    await db.update(agents).set({ reportsTo: manager.id }).where(eq(agents.id, agentId));
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agentId))!.agent.orgChainHealth?.status).toBe("healthy");
    await db.update(agents).set({ reportsTo: agentId }).where(eq(agents.id, manager.id));
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agentId))!.agent.orgChainHealth?.status).toBe("invalid_org_chain");
  });

  it("scopes runtime inputs to the enabled owning plugin and returns the current revision", async () => {
    const state = await pluginAgentRuntimeState(db, pluginId, companyId, agentId);
    expect(state).toMatchObject({ revision: String((await events()).at(-1)!.id), agent: { id: agentId }, instructionsEntryFile: "AGENTS.md", instanceSecrets: {} });
    expect(await pluginAgentRuntimeState(db, pluginId, randomUUID(), agentId)).toBeNull();
    await expect(pluginAgentRuntimeState(db, randomUUID(), companyId, agentId)).rejects.toMatchObject({ status: 403 });
    await db.insert(pluginCompanySettings).values({ companyId, pluginId, enabled: false });
    await expect(pluginAgentRuntimeState(db, pluginId, companyId, agentId)).rejects.toMatchObject({ status: 403 });
  });

  it("does not broadcast legacy lifecycle events to runtime listeners", async () => {
    const notifications: string[] = [];
    const listener = await db.$client.listen("paperclip_plugin_lifecycle", payload => { notifications.push(payload); });
    try {
      await db.transaction(async tx => {
        await tx.insert(resourceLifecycleEvents).values({ companyId, resourceType: "project", resourceId: randomUUID(), action: "update" });
        await tx.execute(sql`SELECT pg_notify('paperclip_plugin_lifecycle', 'barrier')`);
      });
      await vi.waitFor(() => expect(notifications).toContain("barrier"));
      expect(notifications).toEqual(["barrier"]);
      await db.update(agents).set({ name: "Notify runtime" }).where(eq(agents.id, agentId));
      await vi.waitFor(() => expect(notifications).toEqual(["barrier", ""]));
    } finally { await listener.unlisten(); }
  });

  it("wakes delivery after a commit on an independent database client, without polling", async () => {
    const other = createDb(database.connectionString);
    const initialCount = (await events()).length;
    const notifications: string[] = [];
    const listen = db.$client.listen.bind(db.$client);
    vi.spyOn(db.$client, "listen").mockImplementation((channel, onnotify, onlisten) => listen(channel, payload => {
      notifications.push(payload);
      onnotify(payload);
    }, onlisten));
    const call = vi.fn(async (_plugin, _method, event) => ({ eventId: event.id, status: "acknowledged" }));
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    const delivery = registerPluginLifecycleDelivery(coordinator, db, { call, isRunning: () => true, onConfigApplied: () => () => {} } as never, new EventEmitter() as never);
    try {
      await delivery.ready;
      await vi.waitFor(() => expect(call).toHaveBeenCalled(), { timeout: 5000 });
      const delivered = () => call.mock.calls.filter(call => call[2].companyId === companyId);
      await vi.waitFor(async () => expect((await events()).length).toBeGreaterThan(initialCount), { timeout: 5000 });
      await vi.waitFor(async () => expect(await pluginLifecycleInbox(db, pluginId).list(companyId)).toHaveLength(0), { timeout: 5000 });
      const waitForIdle = () => vi.waitFor(() => {
        expect(idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      await waitForIdle();
      await other.execute(sql`SELECT pg_notify('paperclip_plugin_lifecycle', 'startup-drained')`);
      await vi.waitFor(() => expect(notifications).toContain("startup-drained"), { timeout: 5000 });
      await waitForIdle();
      let committedEventId: string | undefined;
      await other.transaction(async tx => {
        await tx.update(agents).set({ name: "Independent writer" }).where(eq(agents.id, agentId));
        const [event] = await tx.select({ id: resourceLifecycleEvents.id }).from(resourceLifecycleEvents)
          .where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"), eq(resourceLifecycleEvents.resourceId, agentId)))
          .orderBy(sql`${resourceLifecycleEvents.id} DESC`).limit(1);
        committedEventId = String(event.id);
        expect(delivered().map(call => call[2].id)).not.toContain(committedEventId);
      });
      await vi.waitFor(() => expect(delivered().map(call => call[2].id)).toContain(committedEventId), { timeout: 5000 });
      expect(delivered().find(call => call[2].id === committedEventId)![2]).toMatchObject({ companyId, resourceId: agentId, resourceType: "agent_runtime" });
    } finally { delivery.dispose(); await coordinator.stop(); await other.$client.end(); }
  });
  it("recovers work committed during real listener connection loss without another write", async () => {
    const target = new URL(database.connectionString);
    const upstreamHost = target.hostname; const upstreamPort = Number(target.port);
    let blocked = false;
    const sockets = new Set<Socket>();
    const proxy = createServer(client => {
      if (blocked) { client.destroy(); return; }
      const upstream = connect(upstreamPort, upstreamHost);
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on("error", () => { client.destroy(); upstream.destroy(); });
        socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
      }
      client.pipe(upstream); upstream.pipe(client);
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    target.hostname = "127.0.0.1"; target.port = String((proxy.address() as { port: number }).port);
    const listenerDb = createDb(target.toString(), { connectTimeoutSeconds: 1 });
    const call = vi.fn(async (_plugin, _method, event) => ({ eventId: event.id, status: "acknowledged" }));
    const coordinator = createDeliveryWorkCoordinator({ owner: listenerDb, canRun: () => true, onError: () => {} });
    const delivery = registerPluginLifecycleDelivery(coordinator, listenerDb, { call, isRunning: () => true, onConfigApplied: () => () => {} } as never, new EventEmitter() as never);
    try {
      await delivery.ready;
      const inbox = pluginLifecycleInbox(db, pluginId);
      await vi.waitFor(async () => expect(await inbox.list(companyId, 100, undefined, ["agent_runtime"])).toEqual([]), { timeout: 5000 });
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 5000 });
      blocked = true;
      for (const socket of sockets) socket.destroy();
      await db.update(agents).set({ name: "Changed while disconnected" }).where(eq(agents.id, agentId));
      const queued = (await events()).at(-1)!;
      expect(call.mock.calls.some(call => call[2].id === String(queued.id))).toBe(false);
      blocked = false;
      await vi.waitFor(() => expect(call.mock.calls.some(call => call[2].id === String(queued.id))).toBe(true), { timeout: 10000 });
    } finally {
      blocked = false; delivery.dispose(); await coordinator.stop(); await listenerDb.$client.end({ timeout: 1 });
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  }, 20000);

});
