import { readFile } from "node:fs/promises";
import { chatCompanyDeletion } from "../services/chat-channels/company-deletion.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { applyPendingMigrations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, agents, chatConversations, chatEndpoints, chatVoiceInboundCalls, chatVoiceSessions, companies, createDb, issues, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { assertVoiceInboundCleanupSettled, voiceInboundCleanup } from "../services/voice/voice-inbound-cleanup.js";
import { notifyVoiceInbound } from "../services/voice/voice-inbound-notifications.js";
import { notifyVoiceChange } from "../services/voice/voice-recovery-notifications.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_VOICE_INBOUND_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("inbound voice cleanup lifecycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, companyId: string, endpointId: string, agentId: string, issueId: string, conversationId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let enabled = true;
  const errors: unknown[] = [], fixtureCompanies: string[] = [];
  const terminate = vi.fn(async (_call: typeof chatVoiceInboundCalls.$inferSelect) => true);
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("voice-inbound-cleanup-");
    if (external) await applyPendingMigrations(external);
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  async function fixture() {
    const companyId = randomUUID(), endpointId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), conversationId = randomUUID();
    fixtureCompanies.push(companyId);
    const applicationId = randomUUID(), connectionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Inbound cleanup", issuePrefix: `V${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Voice", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Voice", assigneeAgentId: agentId, status: "in_progress" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Voice", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Voice", uid: connectionId, transport: "voice", connectionPurpose: "channel", enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId, publicId: endpointId, provider: "speko", status: "active", setup: { step: "complete", runtimeGeneration: 1 } });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: conversationId, externalThreadId: conversationId, externalLabel: "Voice", isDirectMessage: true });
    return { companyId, endpointId, agentId, issueId, conversationId };
  }
  beforeEach(async () => {
    enabled = true; errors.length = 0; terminate.mockReset().mockResolvedValue(true);
    ({ companyId, endpointId, agentId, issueId, conversationId } = await fixture());
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; vi.useRealTimers(); vi.restoreAllMocks();
    for (const companyId of fixtureCompanies.splice(0)) {
      await db.delete(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.companyId, companyId));
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
  async function admission(patch: Partial<typeof chatVoiceInboundCalls.$inferInsert> = {}, writer = db) {
    const id = randomUUID();
    return writer.transaction(async tx => {
      await notifyVoiceInbound(tx, { kind: "admission", id });
      return (await tx.insert(chatVoiceInboundCalls).values({ id, companyId, endpointId, providerSessionId: randomUUID(), state: "awaiting_approval", approvalCode: "123456", generation: 1, credentialFingerprint: "test", toolTokenHash: "a".repeat(64), requestFingerprint: id, expiresAt: new Date(Date.now() - 1), ...patch }).returning())[0];
    });
  }
  async function owner(call: typeof chatVoiceInboundCalls.$inferSelect, patch: Partial<typeof chatVoiceSessions.$inferInsert> = {}) {
    return (await db.insert(chatVoiceSessions).values({ companyId, endpointId, conversationId, issueId, assignedAgentId: agentId, callerId: call.approvedByUserId ?? `guest:${call.id}`, callerAuthority: call.callerAuthority === "member" ? "member" : "guest_intake", approvedByUserId: call.approvedByUserId,
      mode: "inbound_phone", state: "active", generation: call.generation, credentialFingerprint: call.credentialFingerprint, providerSessionId: call.providerSessionId, toolTokenHash: call.toolTokenHash, idempotencyKey: `inbound:${call.id}`, requestFingerprint: call.requestFingerprint, expiresAt: new Date(Date.now() + 600_000), ...patch }).returning())[0];
  }
  async function start(service = voiceInboundCleanup(db, terminate)) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, canReconcile: () => true, onError: error => errors.push(error) });
    await service.register(coordinator, () => enabled).ready;
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
  it("bounds pending inventory pages and restores every deadline when the same owner restarts mid-scan", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: false });
    const expiry = Date.now() + 60_000;
    for (let index = 0; index < 105; index++) await admission({ expiresAt: new Date(expiry) });
    const counts: number[] = [], select = db.select.bind(db);
    const reads = vi.spyOn(db, "select").mockImplementation((...args) => {
      const selection = select(...args), from = selection.from.bind(selection);
      vi.spyOn(selection, "from").mockImplementation(table => {
        const query = from(table);
        if (table === chatVoiceInboundCalls) {
          const execute = query.execute.bind(query);
          vi.spyOn(query, "execute").mockImplementation(async () => {
            const rows = await execute(); counts.push(rows.length); return rows;
          });
        }
        return query;
      });
      return selection;
    });
    try {
      const service = await start();
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(100);
      await coordinator!.stop(); coordinator = undefined;
      const beforeRestart = counts.length;
      await start(service);
      expect(counts.slice(beforeRestart).reduce((sum, count) => sum + count, 0)).toBe(100);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(expiry), { interval: 0 });
      expect(Math.max(...counts)).toBeLessThanOrEqual(100); reads.mockRestore();
      await quiet(1000); expect(terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(expiry - Date.now()); await settled();
      expect(terminate).toHaveBeenCalledTimes(105);
      expect((await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.companyId, companyId)))
        .every(call => call.cleanupConfirmedAt !== null)).toBe(true);
      await quiet();
    } finally { reads.mockRestore(); }
  });
  it("leaves configured idle and confirmed history quiet", async () => {
    await admission({ state: "ended", cleanupConfirmedAt: new Date() });
    await start(); await settled(); await quiet(); expect(terminate).not.toHaveBeenCalled();
  });
  it("prevents company deletion from erasing an unfinished provider cleanup", async () => {
    const call = await admission();
    await expect(db.transaction(tx => chatCompanyDeletion.deleteCompanyData(tx, companyId))).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, call.id))).toHaveLength(1);
    await start(); await settled();
    await db.transaction(tx => chatCompanyDeletion.deleteCompanyData(tx, companyId));
    expect(await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, call.id))).toHaveLength(0);
  });
  it("backfills only provable legacy termination and preserves rejected cleanup debt", async () => {
    const confirmed = await admission({ state: "ended" });
    const uncertain = await admission({ state: "ended", approvedByUserId: randomUUID(), callerAuthority: "member" });
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0396_tan_paladin.sql", import.meta.url), "utf8");
    const backfill = migration.split("--> statement-breakpoint").at(-1)!;
    await db.$client.unsafe(backfill); await db.$client.unsafe(backfill);
    expect((await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, confirmed.id)))[0].cleanupConfirmedAt).not.toBeNull();
    expect((await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, uncertain.id)))[0].cleanupConfirmedAt).toBeNull();
    await start(); await settled(); expect(terminate).toHaveBeenCalledOnce();
    expect(terminate.mock.calls[0][0].id).toBe(uncertain.id); await quiet();
  });
  it("joins provider cleanup at shutdown and saves a restart deadline for uncertainty", async () => {
    const call = await admission(); let release!: (confirmed: boolean) => void;
    terminate.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
    const service = voiceInboundCleanup(db, terminate);
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = service.register(coordinator, () => true);
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = coordinator.stop().then(() => { stopped = true; });
    try {
      await vi.advanceTimersByTimeAsync(1000); expect(stopped).toBe(false);
      release(false); await stopping; await worker.ready;
      expect((await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, call.id)))[0].cleanupNextAttemptAt).not.toBeNull();
      await start(); await settled(); expect(terminate).toHaveBeenCalledTimes(2);
    } finally { release(false); await stopping; }
  });
  it("waits for the original expiry and reconstructs it on restart", async () => {
    const due = Date.now() + 60_000; await admission({ expiresAt: new Date(due) });
    await start(); expect(coordinator!.nextWakeAt()).toBe(due); await quiet(10_000);
    await coordinator!.stop(); await start(); expect(coordinator!.nextWakeAt()).toBe(due);
    await vi.advanceTimersByTimeAsync(due - Date.now()); await settled(); expect(terminate).toHaveBeenCalledOnce(); await quiet();
  });
  it("waits for outer commit and ignores a rolled-back nested producer", async () => {
    await start(); await settled();
    await expect(db.transaction(async tx => { await admission({}, tx as unknown as typeof db); await vi.advanceTimersByTimeAsync(2000); expect(terminate).not.toHaveBeenCalled(); throw new Error("rollback"); })).rejects.toThrow("rollback");
    await settled(); await quiet();
    await db.transaction(async tx => { await admission({}, tx as unknown as typeof db); await vi.advanceTimersByTimeAsync(2000); expect(terminate).not.toHaveBeenCalled(); });
    await settled(); expect(terminate).toHaveBeenCalledOnce(); await quiet();
  });
  it("retains unconfirmed termination across restart without early requests", async () => {
    terminate.mockResolvedValueOnce(false);
    const call = await admission(); await start();
    const [pending] = await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, call.id));
    expect(pending.cleanupConfirmedAt).toBeNull(); expect(pending.cleanupNextAttemptAt).not.toBeNull();
    await coordinator!.stop(); await start(); await quiet(10_000); expect(terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(pending.cleanupNextAttemptAt!.getTime() - Date.now()); await settled();
    expect(terminate).toHaveBeenCalledTimes(2); await quiet();
  });
  it("rechecks ownership after discovery rather than ending a newly bound call", async () => {
    const call = await admission({ state: "approving", approvedByUserId: randomUUID(), callerAuthority: "member", requestedIssueId: issueId });
    const service = voiceInboundCleanup(db, terminate), [candidate] = await service.load();
    const session = await owner(call);
    await db.update(chatVoiceInboundCalls).set({ state: "approved", sessionId: session.id }).where(eq(chatVoiceInboundCalls.id, call.id));
    expect(await service.check(candidate.id)).toBeNull(); expect(terminate).not.toHaveBeenCalled();
  });
  it.each([false, true])("repairs older interrupted handoffs (existing guest binding=%s)", async bound => {
    const call = await admission({ state: "approving", approvedByUserId: randomUUID(), callerAuthority: "member", requestedIssueId: issueId });
    const session = await owner(call);
    if (bound) await db.update(chatVoiceInboundCalls).set({ sessionId: session.id }).where(eq(chatVoiceInboundCalls.id, call.id));
    await start(); await settled(); expect(terminate).not.toHaveBeenCalled();
    expect((await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, call.id)))[0]).toMatchObject({ state: "approved", sessionId: session.id });
    await quiet();
  });
  it("hands rejected bound calls to live recovery and settles from its confirmation", async () => {
    const call = await admission({ state: "denied" }), session = await owner(call);
    await db.update(chatVoiceInboundCalls).set({ sessionId: session.id }).where(eq(chatVoiceInboundCalls.id, call.id));
    await start(); await settled(); expect(terminate).not.toHaveBeenCalled();
    expect((await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, session.id)))[0].state).toBe("ending");
    await quiet();
    await db.transaction(async tx => {
      await notifyVoiceChange(tx, { kind: "session", id: session.id });
      await tx.update(chatVoiceSessions).set({ state: "ended", endedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id));
    });
    await settled();
    expect((await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, call.id)))[0].cleanupConfirmedAt).not.toBeNull();
    await quiet(); expect(terminate).not.toHaveBeenCalled();
  });
  it.each(["ended", "expired"] as const)("settles terminal legacy %s admissions without a session binding", async state => {
    const call = await admission({ state, approvedByUserId: randomUUID(), callerAuthority: "member", requestedIssueId: issueId });
    const endedAt = new Date(Date.now() - 20_000);
    await owner(call, { state: "ended", endedAt });
    const service = voiceInboundCleanup(db, terminate);
    await expect(assertVoiceInboundCleanupSettled(db, companyId)).rejects.toMatchObject({ status: 409 });
    expect(await service.check(call.id)).toBeNull();
    expect((await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, call.id)))[0])
      .toMatchObject({ state, cleanupConfirmedAt: endedAt, cleanupNextAttemptAt: null });
    await start(service); await settled(); await quiet();
    expect(terminate).not.toHaveBeenCalled();
    await assertVoiceInboundCleanupSettled(db, companyId);
  });
  it.each(["denied", "expired", "ended"] as const)("hands rejected legacy %s admissions without a binding to live recovery", async state => {
    const call = await admission({ state, approvedByUserId: randomUUID(), callerAuthority: "member", requestedIssueId: issueId });
    const session = await owner(call);
    const service = voiceInboundCleanup(db, terminate);
    expect(await service.check(call.id)).toBeNull();
    expect((await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, call.id)))[0])
      .toMatchObject({ state, sessionId: session.id, cleanupConfirmedAt: null });
    expect((await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, session.id)))[0].state).toBe("ending");
    await start(service); await settled(); await quiet();
    await db.transaction(async tx => {
      await notifyVoiceChange(tx, { kind: "session", id: session.id });
      await tx.update(chatVoiceSessions).set({ state: "ended", endedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id));
    });
    await settled();
    expect((await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, call.id)))[0].cleanupConfirmedAt).not.toBeNull();
    await quiet(); expect(terminate).not.toHaveBeenCalled();
  });
  it.each([
    { mode: "outbound_phone" as const },
    { idempotencyKey: "another-admission" },
    { generation: 2 },
    { credentialFingerprint: "another-credential" },
    { toolTokenHash: "b".repeat(64) },
  ])("retains rejected legacy cleanup debt when session evidence conflicts: %j", async patch => {
    const call = await admission({ state: "expired" });
    const session = await owner(call, patch);
    await expect(voiceInboundCleanup(db, terminate).check(call.id)).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, call.id)))[0])
      .toMatchObject({ state: "expired", sessionId: null, cleanupConfirmedAt: null });
    expect((await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, session.id)))[0].state).toBe("active");
    expect(terminate).not.toHaveBeenCalled();
  });
  it("retains first work committed during drain without passive SQL", async () => {
    await start(); await settled(); enabled = false;
    await admission(); await quiet(60_000); expect(terminate).not.toHaveBeenCalled();
    enabled = true; await settled(); expect(terminate).toHaveBeenCalledOnce(); await quiet();
  });
  it("pages backlog fairly while a failed provider retains its own retry", async () => {
    const broken = await admission();
    for (let i = 0; i < 104; i++) await admission();
    const other = await fixture(), last = await admission({ companyId: other.companyId, endpointId: other.endpointId });
    let failed = true;
    terminate.mockImplementation(async call => { if (call.id === broken.id && failed) throw new Error("provider unavailable"); return true; });
    await start();
    expect(terminate.mock.calls.slice(0, 25).some(([call]) => call.id === last.id)).toBe(true);
    // waitFor already advances fake time. Extra one-second jumps can reach
    // the failed provider's retry while ordinary database writes are pending.
    await vi.waitFor(() => {
      expect(terminate.mock.calls.filter(([call]) => call.id !== broken.id)).toHaveLength(105);
    }, { timeout: 5000 });
    expect(errors).toHaveLength(1); failed = false;
    await settled(); errors.length = 0; await quiet();
  });
});
