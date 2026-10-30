import { HttpError } from "../errors.js";
import { toolAccessService } from "../services/tool-access.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { applyPendingMigrations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, agents, chatConversations, chatEndpoints, chatVoiceSessions, companies, createDb, issues, subscribeDatabaseWork, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { voiceSessionRecovery } from "../services/voice/voice-session-recovery.js";
import { registerVoiceRecoveryWork } from "../services/voice/voice-recovery-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { notifyVoiceRecovery, withVoiceSessionChange } from "../services/voice/voice-recovery-notifications.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_VOICE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("voice session recovery lifecycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, companyId: string, endpointId: string, agentId: string, issueId: string, conversationId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let enabled = true;
  const errors: unknown[] = [];
  const fixtureCompanies: string[] = [];
  const authorize = vi.fn(async (_session: typeof chatVoiceSessions.$inferSelect) => {}), inspect = vi.fn(async (_session: typeof chatVoiceSessions.$inferSelect): Promise<{ endedAt?: unknown }> => ({ endedAt: true }));
  const close = vi.fn(async (session: typeof chatVoiceSessions.$inferSelect) => {
    await withVoiceSessionChange(db, session.id, tx => tx.update(chatVoiceSessions).set({ state: "ended", endedAt: new Date(), updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id)));
  });
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("voice-recovery-");
    if (external) await applyPendingMigrations(external);
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  async function fixture() {
    const companyId = randomUUID(), endpointId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), conversationId = randomUUID();
    fixtureCompanies.push(companyId);
    const applicationId = randomUUID(), connectionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Voice recovery", issuePrefix: `V${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Voice", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Voice", assigneeAgentId: agentId, status: "in_progress" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Voice", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Voice", uid: connectionId, transport: "voice", connectionPurpose: "channel", config: { provider: "speko" }, enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId, publicId: endpointId, provider: "speko", status: "active", setup: { step: "complete", runtimeGeneration: 1 } });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: conversationId, externalThreadId: conversationId, externalLabel: "Voice", isDirectMessage: true });
    return { companyId, endpointId, assignedAgentId: agentId, issueId, conversationId };
  }
  beforeEach(async () => {
    enabled = true; errors.length = 0; authorize.mockClear(); inspect.mockReset().mockResolvedValue({ endedAt: true }); close.mockClear();
    ({ companyId, endpointId, assignedAgentId: agentId, issueId, conversationId } = await fixture());
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; vi.useRealTimers(); vi.restoreAllMocks();
    for (const companyId of fixtureCompanies.splice(0)) {
    await db.delete(chatVoiceSessions).where(eq(chatVoiceSessions.companyId, companyId));
    await db.delete(chatConversations).where(eq(chatConversations.companyId, companyId));
    await db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId));
    await db.delete(issues).where(eq(issues.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
    }
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function session(patch: Partial<typeof chatVoiceSessions.$inferInsert> = {}, writer = db) {
    const id = patch.id ?? randomUUID();
    return withVoiceSessionChange(writer, id, tx => tx.insert(chatVoiceSessions).values({ id, companyId, endpointId, conversationId, issueId, assignedAgentId: agentId,
      callerId: randomUUID(), callerAuthority: "member", mode: "browser", state: "active", generation: 1, credentialFingerprint: "test", providerSessionId: randomUUID(),
      toolTokenHash: "a".repeat(64), idempotencyKey: id, requestFingerprint: id, createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 600_000), ...patch }).returning()).then(rows => rows[0]);
  }
  async function start(service = voiceSessionRecovery(db, { authorize, inspect, close })) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, canReconcile: () => true, onError: error => errors.push(error) });
    await registerVoiceRecoveryWork(coordinator, service, () => enabled).ready;
    return service;
  }
  async function settled() {
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull(); }, { timeout: 5000 });
  }
  async function quiet(ms = 120_000) {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    try { await vi.advanceTimersByTimeAsync(ms); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); }
    finally { reads.mockRestore(); writes.mockRestore(); }
  }
  async function futureInventory(count: number) {
    const row = await session({ updatedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
    await db.insert(chatVoiceSessions).values(Array.from({ length: count - 1 }, () => {
      const id = randomUUID();
      return { ...row, id, callerId: randomUUID(), providerSessionId: id, idempotencyKey: id, requestFingerprint: id };
    }));
    return row.updatedAt.getTime() + 30_000;
  }
  function voiceReads() {
    const counts: number[] = [], select = db.select.bind(db);
    const measurement = vi.spyOn(db, "select").mockImplementation((...args) => {
      const selection = select(...args), from = selection.from.bind(selection);
      vi.spyOn(selection, "from").mockImplementation(table => {
        const query = from(table);
        if (table === chatVoiceSessions) {
          const execute = query.execute.bind(query);
          vi.spyOn(query, "execute").mockImplementation(async () => {
            const rows = await execute(); counts.push(rows.length); return rows;
          });
        }
        return query;
      });
      return selection;
    });
    return { counts, stop: () => measurement.mockRestore() };
  }
  async function futureSettled(at: number) {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBe(at);
    }, { timeout: 5000 });
  }
  it("bounds startup pages and retains every saved deadline", async () => {
    const due = await futureInventory(205), reads = voiceReads(), counts = reads.counts;
    await start();
    expect(counts).toHaveLength(1); expect(counts[0]).toBe(100);
    await futureSettled(due);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(205);
    expect(Math.max(...counts)).toBe(100);
    await vi.advanceTimersByTimeAsync(due - Date.now()); await settled();
    expect(new Set(inspect.mock.calls.map(([row]) => row.id)).size).toBe(205);
    reads.stop(); await quiet();
  });
  it("reconstructs every page when the same service restarts after a partial scan", async () => {
    const due = await futureInventory(205), service = voiceSessionRecovery(db, { authorize, inspect, close });
    await start(service); expect(inspect).not.toHaveBeenCalled(); await coordinator!.stop();
    await start(service); await futureSettled(due);
    await vi.advanceTimersByTimeAsync(due - Date.now()); await settled();
    expect(new Set(inspect.mock.calls.map(([row]) => row.id)).size).toBe(205);
    await quiet();
  });
  it("retains a new session behind the cursor during paged reconstruction", async () => {
    const due = await futureInventory(205), service = voiceSessionRecovery(db, { authorize, inspect, close });
    const refresh = service.refresh; let inserted = false, newcomer = "";
    service.refresh = async (...args) => {
      const result = await refresh(...args);
      if (!args[0] && !result.complete && !inserted) {
        inserted = true; newcomer = (await session({ id: "00000000-0000-4000-8000-000000000001" })).id;
      }
      return result;
    };
    await start(service); await futureSettled(due);
    expect(inspect.mock.calls.map(([row]) => row.id)).toEqual([newcomer]);
    expect((await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, newcomer)))[0].state).toBe("ended");
    await quiet(5000);
  });
  it("reapplies a feature change that arrives between inventory pages", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: false });
    await futureInventory(205);
    const settings = instanceSettingsService(db), service = voiceSessionRecovery(db, { authorize, inspect, close });
    const refresh = service.refresh; let changed = false;
    service.refresh = async (...args) => {
      const result = await refresh(...args);
      if (!args[0] && !result.complete && !changed) {
        changed = true; await settings.updateExperimental({ enableChatConnectors: false });
      }
      return result;
    };
    try {
      await start(service);
      for (let pass = 0; pass < 20; pass++) {
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(coordinator!.nextWakeAt() !== null || idleWorkSnapshot().active === 0).toBe(true), { interval: 0 });
      }
      expect(new Set(close.mock.calls.map(([row]) => row.id)).size).toBe(205);
      await settled();
      await quiet();
    } finally {
      await coordinator?.stop(); coordinator = undefined;
      await settings.updateExperimental({ enableChatConnectors: true });
    }
  });
  it("pages actual connection disablement and settles every cached live call", async () => {
    const due = await futureInventory(205); await start(); await futureSettled(due);
    const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId));
    const reads = voiceReads();
    authorize.mockRejectedValue(new HttpError(403, "Connection disabled"));
    try {
      await toolAccessService(db).updateConnection(endpoint.connectionId, { enabled: false });
      await settled();
      expect(new Set(close.mock.calls.map(([row]) => row.id)).size).toBe(205);
      expect(inspect).not.toHaveBeenCalled(); expect(Math.max(...reads.counts)).toBe(100);
      reads.stop(); await quiet();
    } finally { authorize.mockResolvedValue(undefined); reads.stop(); }
  });
  it("does not reread live calls after repeated real connection metadata and health writes", async () => {
    const due = await futureInventory(205);
    await start(); await futureSettled(due);
    const reads = voiceReads(), counts = reads.counts;
    const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId));
    const tools = toolAccessService(db);
    for (let index = 0; index < 5; index++) {
      await tools.updateConnection(endpoint.connectionId, { name: `Metadata ${index}` });
      await futureSettled(due);
    }
    let observations = 0;
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.voiceSessionRecovery, event => { if (event === "settled") observations++; });
    try {
      await expect(tools.checkHealth(endpoint.connectionId)).rejects.toMatchObject({ status: 422 });
      await futureSettled(due);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(0);
      expect(observations).toBe(0);
      expect(inspect).not.toHaveBeenCalled(); reads.stop(); await quiet(5000);
    } finally { unsubscribe(); }
  });
  it("preserves receiver and command wakes for SDK health observations", async () => {
    const id = randomUUID();
    await db.insert(toolConnections).values({ id, companyId, applicationId: (await db.select().from(toolApplications).where(eq(toolApplications.companyId, companyId)))[0].id,
      name: "SDK observation", uid: id, transport: "chat_sdk", connectionPurpose: "channel", config: { provider: "discord" }, enabled: true, status: "active" });
    const seen = new Set<string>();
    const topics = [DELIVERY_QUEUES.chatReceivers, DELIVERY_QUEUES.chatCommandRegistration, DELIVERY_QUEUES.voiceSessionRecovery];
    const stops = topics.map(topic => subscribeDatabaseWork(db, topic, event => { if (event === "settled") seen.add(topic); }));
    try {
      await expect(toolAccessService(db).checkHealth(id)).rejects.toMatchObject({ status: 422 });
      expect(seen).toEqual(new Set([DELIVERY_QUEUES.chatReceivers, DELIVERY_QUEUES.chatCommandRegistration]));
    } finally { for (const stop of stops) stop(); }
  });
  it("leaves configured terminal history quiet", async () => {
    await session({ state: "ended", endedAt: new Date() }); await start(); await settled(); await quiet(); expect(inspect).not.toHaveBeenCalled();
  });
  it("waits for outer commit and ignores a rolled-back nested producer", async () => {
    await start(); await settled();
    await expect(db.transaction(async tx => { await session({}, tx as unknown as typeof db); await vi.advanceTimersByTimeAsync(60_000); expect(inspect).not.toHaveBeenCalled(); throw new Error("rollback"); })).rejects.toThrow("rollback");
    await settled(); await quiet();
    await db.transaction(async tx => { await session({}, tx as unknown as typeof db); await vi.advanceTimersByTimeAsync(60_000); expect(inspect).not.toHaveBeenCalled(); });
    await settled(); expect(inspect).toHaveBeenCalledOnce(); await quiet();
  });
  it("preserves the first session during drain without passive database reads", async () => {
    await start(); await settled(); enabled = false;
    await db.transaction(async tx => {
      await session({}, tx as unknown as typeof db);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(idleWorkSnapshot().active).toBeGreaterThan(0);
      expect(inspect).not.toHaveBeenCalled();
    });
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); });
    const drained = idleWorkSnapshot();
    await quiet(60_000); expect(idleWorkSnapshot()).toEqual(drained); expect(inspect).not.toHaveBeenCalled();
    enabled = true; await settled(); expect(inspect).toHaveBeenCalledOnce(); await quiet();
  });
  it("retries unavailable authority without ending a valid provider call", async () => {
    const row = await session(); authorize.mockRejectedValueOnce(new Error("authority database unavailable"));
    await start(); expect(errors).toHaveLength(1); expect(close).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
    // Persisting cleanup_pending emits a committed hint; let that refresh settle first.
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); });
    expect(coordinator!.nextWakeAt()).toBeGreaterThan(Date.now() + 20_000);
    await quiet(10_000); await settled();
    expect(inspect).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
    expect((await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, row.id)))[0].state).toBe("ended");
    errors.length = 0; await quiet();
  });
  it("reconstructs a saved session deadline after restart", async () => {
    const due = Date.now() + 60_000;
    await session({ updatedAt: new Date(due - 30_000) }); await start();
    expect(coordinator!.nextWakeAt()).toBe(due); await coordinator!.stop();
    await start(); expect(coordinator!.nextWakeAt()).toBe(due); await quiet(10_000);
    await vi.advanceTimersByTimeAsync(due - Date.now()); await settled(); expect(inspect).toHaveBeenCalledOnce(); await quiet();
  });
  it("preserves a session committed during a full refresh", async () => {
    const service = voiceSessionRecovery(db, { authorize, inspect, close }), original = service.refresh;
    await start(service); await settled(); let inserted = false;
    service.refresh = async (...args) => { const rows = await original(...args); if (!inserted) { inserted = true; await session(); } return rows; };
    await db.transaction(tx => notifyVoiceRecovery(tx)); await settled(); expect(inspect).toHaveBeenCalledOnce(); await quiet();
  });
  it("pages saved sessions and drains healthy work while one provider fails", async () => {
    const failed = await session();
    for (let index = 0; index < 104; index++) await session();
    let broken = true;
    inspect.mockImplementation(async row => {
      if (row.id === failed.id && broken) throw new Error("one provider unavailable");
      return { endedAt: true };
    });
    await start();
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      const rows = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.companyId, companyId));
      expect(rows.filter(row => row.state === "ended")).toHaveLength(104);
    }, { timeout: 5000 });
    expect(inspect.mock.calls.filter(([row]) => row.id === failed.id)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    broken = false; await settled(); errors.length = 0; await quiet();
  });
  it("includes another company in the first batch despite a large older backlog", async () => {
    for (let index = 0; index < 30; index++) await session({ updatedAt: new Date(Date.now() - 120_000) });
    const other = await fixture();
    const row = await session(other);
    await start();
    expect(inspect.mock.calls.slice(0, 25).some(([candidate]) => candidate.id === row.id)).toBe(true);
    await settled(); expect(inspect).toHaveBeenCalledTimes(31); await quiet();
  });
  it("keeps exact hints and cached due calls moving while wildcard reconstruction backs off", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: false });
    const cached = await session({ updatedAt: new Date(Date.now() - 20_000) });
    const dueAt = cached.updatedAt.getTime() + 30_000;
    const service = await start(), refresh = service.refresh;
    service.refresh = async (scope, signal) => {
      if (!scope) throw new Error("wildcard unavailable");
      return refresh(scope, signal);
    };
    await db.transaction(tx => notifyVoiceRecovery(tx));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(errors).toHaveLength(1), { interval: 0 });
    const exact = await session({ state: "ending" });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(expect.objectContaining({ id: exact.id })), { interval: 0 });
    await vi.advanceTimersByTimeAsync(Math.max(0, dueAt - Date.now()));
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ id: cached.id })), { interval: 0 });
    expect(errors).toHaveLength(1);
    service.refresh = refresh; errors.length = 0;
    await vi.advanceTimersByTimeAsync(Math.max(0, coordinator!.nextWakeAt()! - Date.now()));
    await settled(); await quiet();
  });
  it("does not inspect stale cached work until a failed scope refresh succeeds", async () => {
    const row = await session({ updatedAt: new Date(Date.now() - 20_000) });
    const service = voiceSessionRecovery(db, { authorize, inspect, close }), original = service.refresh;
    await start(service); service.refresh = async () => { throw new Error("scope unavailable"); };
    await db.transaction(tx => notifyVoiceRecovery(tx, { kind: "session", id: row.id }));
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(errors).toHaveLength(1); });
    await quiet(15_000); expect(inspect).not.toHaveBeenCalled();
    service.refresh = original; await settled(); expect(inspect).toHaveBeenCalledOnce(); errors.length = 0; await quiet();
  });
  it("does not expire a provider identity bound after the grace-period read", async () => {
    const row = await session({ state: "creation_unknown", providerSessionId: null,
      createdAt: new Date(Date.now() - 240_000), expiresAt: new Date(Date.now() - 180_000) });
    const service = voiceSessionRecovery(db, { authorize, inspect, close });
    const providerSessionId = randomUUID(), transact = db.transaction.bind(db);
    const transaction = vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, options) => {
      await transact(async tx => {
        await notifyVoiceRecovery(tx, { kind: "session", id: row.id });
        await tx.update(chatVoiceSessions).set({ providerSessionId, state: "connecting", updatedAt: new Date() }).where(eq(chatVoiceSessions.id, row.id));
      });
      return transact(callback, options);
    });
    try { await service.check(row.id); } finally { transaction.mockRestore(); }
    const [bound] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, row.id));
    expect(bound).toMatchObject({ state: "connecting", providerSessionId });
    await service.check(row.id);
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ id: row.id, providerSessionId }));
    expect((await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, row.id)))[0].state).toBe("ended");
  });
  it("joins admitted provider inspection at shutdown", async () => {
    await start(); await settled();
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    inspect.mockImplementationOnce(async () => { await gate; return { endedAt: true }; });
    await session(); await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(inspect).toHaveBeenCalledOnce(); });
    let stopped = false; const stopping = coordinator!.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(5000); expect(stopped).toBe(false);
    finish(); await stopping; expect(stopped).toBe(true);
  });
});
