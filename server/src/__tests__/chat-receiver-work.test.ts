import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { applyPendingMigrations, agents, chatEndpoints, chatEndpointLeases, companies, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyDeliveryWork, DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { chatReceiverSchedule } from "../services/chat-channels/runtime/receiver-schedule.js";
import { registerChatReceiverWork } from "../services/chat-channels/runtime/receiver-work.js";
import { notifyChatEndpointConfiguration, notifyChatConnectionConfiguration, notifyChatCompanyConfiguration } from "../services/chat-channels/configuration-work-notifications.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RECEIVER_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat receiver discovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, companyId: string, agentId: string, applicationId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let enabled = true, primary = true;
  const errors: unknown[] = [];
  const reconcile = vi.fn(async (_id: string): Promise<"owned" | "foreign"> => "owned"), stop = vi.fn(async (_id: string) => {});
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("chat-receivers-");
    if (external) await applyPendingMigrations(external);
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 60_000);
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); applicationId = randomUUID(); enabled = true; primary = true; errors.length = 0;
    reconcile.mockReset().mockResolvedValue("owned"); stop.mockReset().mockResolvedValue(undefined);
    await db.insert(companies).values({ id: companyId, name: "Receivers", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Receiver", adapterType: "codex_local" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Receiver", type: "chat" });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select 1`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function endpoint(patch: Partial<typeof chatEndpoints.$inferInsert> = {}, writer = db) {
    const id = patch.id ?? randomUUID(), connectionId = randomUUID();
    return writer.transaction(async tx => {
      await notifyChatEndpointConfiguration(tx, { id, provider: patch.provider ?? "discord" });
      await tx.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: id, uid: id,
        transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
      return (await tx.insert(chatEndpoints).values({ id, companyId, connectionId, assignedAgentId: agentId,
        publicId: id, provider: "discord", status: "active", ...patch }).returning())[0];
    });
  }
  async function start(service = chatReceiverSchedule(db, { reconcile, stop })) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled && primary, canReconcile: () => primary, onError: error => errors.push(error) });
    const worker = registerChatReceiverWork(coordinator, service, () => enabled && primary);
    await worker.ready;
    return { worker, service };
  }
  async function settled(expected: number | null = null) {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBe(expected);
    }, { timeout: 5000 });
  }
  async function quiet(ms = 120_000) {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction"), execute = vi.spyOn(db, "execute");
    try {
      await vi.advanceTimersByTimeAsync(ms);
      expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); writes.mockRestore(); execute.mockRestore(); }
  }
  it("does no recurring SQL after empty reconstruction", async () => { await start(); await settled(); await quiet(); });
  it("leaves disabled, archived, and webhook-only endpoints quiet", async () => {
    await endpoint({ status: "paused" }); await endpoint({ status: "archived" }); await endpoint({ provider: "slack" });
    const disabled = await endpoint(); await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, disabled.connectionId));
    const failed = await endpoint({ status: "attention" }); await db.update(toolConnections).set({ healthStatus: "failed" }).where(eq(toolConnections.id, failed.connectionId));
    await start(); await settled(); await quiet(); expect(reconcile).not.toHaveBeenCalled();
  });
  it.each(["discord", "imessage-photon"] as const)("wakes the first %s receiver and retains its identity until removal", async provider => {
    await start(); await settled(); await quiet();
    const row = await endpoint({ provider }); await settled();
    expect(reconcile).toHaveBeenCalledWith(row.id); await quiet();
    await db.transaction(async tx => { await notifyChatConnectionConfiguration(tx, row.connectionId); await tx.delete(chatEndpoints).where(eq(chatEndpoints.id, row.id)); });
    await settled(); expect(stop).toHaveBeenCalledWith(row.id); await quiet();
  });
  it("waits for outer commit and discards rolled-back configuration", async () => {
    await start(); await settled();
    await expect(db.transaction(async tx => { await endpoint({}, tx as unknown as typeof db); await vi.advanceTimersByTimeAsync(60_000); expect(reconcile).not.toHaveBeenCalled(); throw new Error("rollback"); })).rejects.toThrow("rollback");
    await settled(); await quiet();
    let id = "";
    await db.transaction(async tx => { id = (await endpoint({}, tx as unknown as typeof db)).id; await vi.advanceTimersByTimeAsync(60_000); expect(reconcile).not.toHaveBeenCalled(); });
    await settled(); expect(reconcile).toHaveBeenCalledWith(id);
  });
  it("preserves the first receiver written during drain without passive SQL", async () => {
    await start(); await settled(); enabled = false; const row = await endpoint();
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
    });
    const drained = idleWorkSnapshot();
    await quiet(60_000); expect(idleWorkSnapshot()).toEqual(drained); expect(reconcile).not.toHaveBeenCalled();
    enabled = true; await settled(); expect(reconcile).toHaveBeenCalledWith(row.id);
  });
  it("reconstructs after standby becomes primary without restarting the worker", async () => {
    await endpoint(); primary = false; await start(); await quiet(60_000);
    primary = true; await settled(); expect(reconcile).toHaveBeenCalledOnce(); await quiet();
  });
  it("waits for a foreign lease, observes its extension, and takes over after release", async () => {
    const row = await endpoint(); let owned = false;
    reconcile.mockImplementation(async () => owned ? "owned" : "foreign");
    const expiry = Date.now() + 60_000;
    await db.insert(chatEndpointLeases).values({ companyId, endpointId: row.id, leaseKey: "discord_gateway_runtime", token: randomUUID(), expiresAt: new Date(expiry) });
    await start(); await settled(expiry); await quiet(10_000); expect(reconcile).toHaveBeenCalledOnce();
    const renewed = expiry + 60_000;
    await db.update(chatEndpointLeases).set({ expiresAt: new Date(renewed) }).where(eq(chatEndpointLeases.endpointId, row.id));
    await vi.advanceTimersByTimeAsync(expiry - Date.now()); await settled(renewed); expect(reconcile).toHaveBeenCalledTimes(2);
    await db.delete(chatEndpointLeases).where(eq(chatEndpointLeases.endpointId, row.id)); owned = true;
    await vi.advanceTimersByTimeAsync(renewed - Date.now()); await settled(); expect(reconcile).toHaveBeenCalledTimes(3); await quiet();
  });
  it("wakes after a local receiver stops and then returns to quiet", async () => {
    const row = await endpoint(); const { worker } = await start(); await settled(); await quiet();
    worker.changed(row.id); await settled(); expect(reconcile).toHaveBeenCalledTimes(2); await quiet();
  });
  it("retains a producer arriving during its scoped refresh", async () => {
    const service = chatReceiverSchedule(db, { reconcile, stop }), original = service.load;
    await start(service); await settled(); let inserted = false;
    service.load = async (...args) => { const rows = await original(...args); if (!inserted) { inserted = true; await endpoint(); } return rows; };
    await endpoint(); await settled(); expect(reconcile).toHaveBeenCalledTimes(2); await quiet();
  });
  it("cancels all cached owned receivers after a company deletion hint", async () => {
    await endpoint(); await endpoint(); await start(); await settled();
    await db.transaction(async tx => { await notifyChatCompanyConfiguration(tx, companyId); await tx.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId)); });
    await settled(); expect(stop).toHaveBeenCalledTimes(2); await quiet();
  });
  it("retains transient load failures and does not repeatedly scan during their backoff", async () => {
    const service = chatReceiverSchedule(db, { reconcile, stop }), original = service.load;
    await start(service); await settled(); let broken = true;
    service.load = async (...args) => { if (broken) throw new Error("load unavailable"); return original(...args); };
    await endpoint(); await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(errors.length).toBeGreaterThan(0); });
    await quiet(10_000); broken = false; await settled(); expect(reconcile).toHaveBeenCalledOnce(); errors.length = 0;
  });
  it("does not schedule blocked takeover attempts before a failed scope refresh can retry", async () => {
    const row = await endpoint();
    reconcile.mockResolvedValue("foreign");
    const expiry = Date.now() + 10_000;
    await db.insert(chatEndpointLeases).values({ companyId, endpointId: row.id, leaseKey: "discord_gateway_runtime", token: randomUUID(), expiresAt: new Date(expiry) });
    const service = chatReceiverSchedule(db, { reconcile, stop }), original = service.load;
    await start(service); await settled(expiry);
    service.load = async () => { throw new Error("scoped inventory unavailable"); };
    await db.transaction(tx => notifyChatConnectionConfiguration(tx, row.connectionId));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(coordinator!.nextWakeAt()).toBeGreaterThan(Date.now() + 20_000);
    await quiet(10_000);
    service.load = original; reconcile.mockResolvedValue("owned");
    await settled(); errors.length = 0; await quiet();
  });
  it("coalesces a full refresh with its already pending scoped hints", async () => {
    const service = chatReceiverSchedule(db, { reconcile, stop });
    await start(service); await settled();
    const load = vi.spyOn(service, "load");
    await db.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatReceivers, "*");
      await endpoint({}, tx as unknown as typeof db);
      await endpoint({}, tx as unknown as typeof db);
    });
    await settled(); expect(reconcile).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledOnce(); expect(load.mock.calls[0][0]).toBeUndefined();
    load.mockRestore(); await quiet();
  });
  it("keeps full-refresh backoff when a narrower producer arrives", async () => {
    const service = chatReceiverSchedule(db, { reconcile, stop }), original = service.load;
    await start(service); await settled();
    const load = vi.spyOn(service, "load").mockRejectedValue(new Error("inventory unavailable"));
    await db.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.chatReceivers, "*"));
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(errors).toHaveLength(1); });
    const retryAt = coordinator!.nextWakeAt();
    const row = await endpoint();
    await quiet(10_000);
    expect(load).toHaveBeenCalledOnce(); expect(coordinator!.nextWakeAt()).toBe(retryAt);
    load.mockImplementation(original);
    await settled(); expect(reconcile).toHaveBeenCalledWith(row.id);
    expect(load).toHaveBeenCalledTimes(2); expect(load.mock.calls[1][0]).toBeUndefined();
    errors.length = 0; load.mockRestore(); await quiet();
  });
  it("recovers malformed scopes without losing a subsequent valid producer", async () => {
    await start(); await settled();
    await db.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.chatReceivers, "unknown:old"));
    await endpoint();
    await settled(); expect(reconcile).toHaveBeenCalledOnce(); expect(errors.length).toBeGreaterThan(0); errors.length = 0; await quiet();
  });
  it.each([0, 1100])("drains paged inventory despite a failed receiver after %i ms", async delay => {
    for (let i = 0; i < 105; i++) await endpoint();
    const service = chatReceiverSchedule(db, { reconcile, stop });
    const reads = vi.spyOn(db, "select"); const inventory = await service.load({ kind: "company", id: companyId });
    expect(inventory).toHaveLength(105); expect(reads).toHaveBeenCalledTimes(2); reads.mockRestore();
    const failedId = inventory[0].id;
    reconcile.mockImplementation(async id => {
      if (id === failedId) { vi.setSystemTime(Date.now() + delay); throw new Error("bad credential"); }
      return "owned";
    });
    await start(service);
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    expect(coordinator!.nextWakeAt()!).toBeLessThanOrEqual(Date.now() + 1000);
    await vi.waitFor(() => expect(new Set(reconcile.mock.calls.map(([id]) => id)).size).toBe(105), { timeout: 5000 });
    expect(reconcile.mock.calls.filter(([id]) => id === failedId)).toHaveLength(1);
    reconcile.mockResolvedValue("owned"); await settled(); errors.length = 0; await quiet();
  });
  it("includes a second company in the first batch despite a larger earlier backlog", async () => {
    for (let i = 1; i <= 30; i++) await endpoint({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` });
    const firstCompany = companyId, firstAgent = agentId, firstApplication = applicationId;
    const secondCompany = randomUUID(), secondAgent = randomUUID(), secondApplication = randomUUID();
    await db.insert(companies).values({ id: secondCompany, name: "Other receiver company", issuePrefix: `R${secondCompany.slice(0, 7)}` });
    await db.insert(agents).values({ id: secondAgent, companyId: secondCompany, name: "Receiver", adapterType: "codex_local" });
    await db.insert(toolApplications).values({ id: secondApplication, companyId: secondCompany, name: "Receiver", type: "chat" });
    try {
      companyId = secondCompany; agentId = secondAgent; applicationId = secondApplication;
      const other = await endpoint({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
      companyId = firstCompany; agentId = firstAgent; applicationId = firstApplication;
      await start();
      expect(reconcile.mock.calls.slice(0, 25).map(([id]) => id)).toContain(other.id);
      await settled(); expect(reconcile).toHaveBeenCalledTimes(31); await quiet();
    } finally {
      companyId = firstCompany; agentId = firstAgent; applicationId = firstApplication;
      await coordinator?.stop(); coordinator = undefined;
      await db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, secondCompany));
      await db.delete(agents).where(eq(agents.companyId, secondCompany));
      await db.delete(companies).where(eq(companies.id, secondCompany));
    }
  });
  it("joins admitted runtime initialization during shutdown", async () => {
    await start(); await settled(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    reconcile.mockImplementation(async () => { await gate; return "owned"; });
    await endpoint(); await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(reconcile).toHaveBeenCalledOnce(); });
    let stopped = false; const stopping = coordinator!.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1000); expect(stopped).toBe(false);
    release(); await stopping; coordinator = undefined; errors.length = 0;
    await quiet(); expect(reconcile).toHaveBeenCalledOnce();
  });
});
