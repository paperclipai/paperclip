import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { applyPendingMigrations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, agents, chatConversations, chatEndpoints, chatVoiceSessions, chatVoiceReports, companies, createDb, issues, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { voiceCallReports } from "../services/voice/voice-call-reports.js";
import type { SpekoCallReport } from "../services/voice/speko-call-report.js";
import { notifyVoiceReports } from "../services/voice/voice-report-notifications.js";
import { withVoiceSessionChange } from "../services/voice/voice-recovery-notifications.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_VOICE_REPORT_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("voice call-report lifecycle", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, companyId: string, endpointId: string, agentId: string, issueId: string, conversationId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let enabled = true;
  const errors: unknown[] = [];
  const fixtureCompanies: string[] = [];
  const day = 86_400_000;
  const result = (): SpekoCallReport => ({ complete: true, transcript: [], costMicroUsd: "100", durationSeconds: 10, providerUpdatedAt: new Date() });
  const fetchReport = vi.fn(async (_session: typeof chatVoiceSessions.$inferSelect) => result());
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("voice-call-reports-");
    if (external) await applyPendingMigrations(external);
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  async function fixture() {
    const companyId = randomUUID(), endpointId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), conversationId = randomUUID();
    fixtureCompanies.push(companyId);
    const applicationId = randomUUID(), connectionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Voice recovery", issuePrefix: `V${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Voice", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Voice", assigneeAgentId: agentId, status: "in_progress" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Voice", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Voice", uid: connectionId, transport: "voice", connectionPurpose: "channel", enabled: true, status: "active" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId, publicId: endpointId, provider: "speko", status: "active", setup: { step: "complete", runtimeGeneration: 1 } });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: conversationId, externalThreadId: conversationId, externalLabel: "Voice", isDirectMessage: true });
    return { companyId, endpointId, assignedAgentId: agentId, issueId, conversationId };
  }
  beforeEach(async () => {
    enabled = true; errors.length = 0; fetchReport.mockReset().mockImplementation(async () => result());
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
      callerId: randomUUID(), callerAuthority: "member", mode: "browser", state: "ended", endedAt: new Date(), generation: 1, credentialFingerprint: "test", providerSessionId: randomUUID(),
      toolTokenHash: "a".repeat(64), idempotencyKey: id, requestFingerprint: id, createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 600_000), ...patch }).returning()).then(rows => rows[0]);
  }
  async function start(service = voiceCallReports(db, fetchReport)) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, canReconcile: () => true, onError: error => errors.push(error) });
    await service.register(coordinator, () => enabled).ready;
    return service;
  }
  async function flush() {
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); }, { timeout: 5000 });
  }
  async function quiet(ms = 10_000) {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    const requests = fetchReport.mock.calls.length;
    try { await vi.advanceTimersByTimeAsync(ms); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(fetchReport).toHaveBeenCalledTimes(requests); }
    finally { reads.mockRestore(); writes.mockRestore(); }
  }
  async function report(id: string) { return (await db.select().from(chatVoiceReports).where(eq(chatVoiceReports.sessionId, id)))[0]; }
  async function due(id: string) {
    await db.transaction(async tx => {
      await notifyVoiceReports(tx, { kind: "session", id });
      await tx.update(chatVoiceReports).set({ nextCheckAt: new Date(0) }).where(eq(chatVoiceReports.sessionId, id));
    });
  }
  it("bounds report reconstruction and resets a partial scan when the same owner restarts", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: false });
    const deadline = Date.now() + 120_000;
    const ids: string[] = [];
    for (let index = 0; index < 105; index++) {
      const call = await session({ endedAt: new Date(Date.now() - 60_000) }); ids.push(call.id);
      await db.insert(chatVoiceReports).values({ sessionId: call.id, companyId, nextCheckAt: new Date(deadline) });
    }
    const counts: number[] = [], select = db.select.bind(db);
    const reads = vi.spyOn(db, "select").mockImplementation((...args) => {
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
    try {
      const service = await start();
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(100);
      await coordinator!.stop(); coordinator = undefined;
      const beforeRestart = counts.length;
      await start(service);
      expect(counts.slice(beforeRestart).reduce((sum, count) => sum + count, 0)).toBe(100);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(deadline), { interval: 0 });
      expect(Math.max(...counts)).toBeLessThanOrEqual(100); reads.mockRestore();
      await quiet(); expect(fetchReport).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(deadline - Date.now());
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(idleWorkSnapshot().active).toBe(0);
        expect(fetchReport).toHaveBeenCalledTimes(105);
      }, { timeout: 5000 });
      expect(fetchReport.mock.calls.map(([call]) => call.id).sort()).toEqual(ids.sort());
      expect((await db.select().from(chatVoiceReports).where(eq(chatVoiceReports.companyId, companyId)))
        .every(row => row.attempts === 1)).toBe(true);
      await quiet();
    } finally { reads.mockRestore(); }
  });
  it("leaves configured idle, live calls, old history and unidentified calls quiet", async () => {
    await session({ state: "active", endedAt: null });
    await session({ endedAt: new Date(Date.now() - day - 1000) });
    await session({ providerSessionId: null });
    await start(); await flush(); expect(coordinator!.nextWakeAt()).toBeNull(); await quiet(120_000);
    expect(fetchReport).not.toHaveBeenCalled();
  });
  it("wakes on committed termination and preserves refresh of available reports", async () => {
    await start(); await flush(); await quiet();
    const call = await session(); await flush();
    expect(fetchReport).toHaveBeenCalledOnce(); expect((await report(call.id)).status).toBe("available");
    const next = (await report(call.id)).nextCheckAt.getTime();
    expect(coordinator!.nextWakeAt()).toBe(next); await quiet();
    await vi.advanceTimersByTimeAsync(next - Date.now() + 1000); await flush();
    expect(fetchReport).toHaveBeenCalledTimes(2); expect((await report(call.id)).attempts).toBe(2);
  });
  it("reconstructs persisted retries after restart without early provider reads", async () => {
    const call = await session(); fetchReport.mockRejectedValueOnce(new Error("provider unavailable"));
    await start(); await flush(); const saved = await report(call.id);
    expect(saved.attempts).toBe(1); expect(saved.status).toBe("pending");
    await coordinator!.stop(); await start(); await flush();
    expect(coordinator!.nextWakeAt()).toBe(saved.nextCheckAt.getTime()); await quiet();
    await vi.advanceTimersByTimeAsync(saved.nextCheckAt.getTime() - Date.now() + 1000); await flush();
    expect(fetchReport).toHaveBeenCalledTimes(2); expect((await report(call.id)).status).toBe("available");
  });
  it("disarms at the end of the finite window even when the next check is later", async () => {
    const endedAt = new Date(Date.now() - day + 25_000), call = await session({ endedAt });
    await start(); await flush();
    expect(coordinator!.nextWakeAt()).toBe(endedAt.getTime() + day + 1);
    expect((await report(call.id)).nextCheckAt.getTime()).toBeGreaterThan(coordinator!.nextWakeAt()!);
    await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(coordinator!.nextWakeAt()).toBeNull(); await quiet(120_000); expect(fetchReport).toHaveBeenCalledOnce();
    await coordinator!.stop(); await start(); await flush(); expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
  });
  it("rounds the inclusive PostgreSQL window end up without another provider fetch", async () => {
    const call = await session(), end = Math.trunc(Date.now()) + 60_000;
    await db.execute(sql`UPDATE chat_voice_sessions SET ended_at = to_timestamp(${end - day}::double precision / 1000) + interval '0.0005 seconds' WHERE id = ${call.id}`);
    await db.insert(chatVoiceReports).values({ companyId, sessionId: call.id, status: "available", nextCheckAt: new Date(end + 60_000) });
    const service = voiceCallReports(db, fetchReport);
    expect((await service.load())[0].dueAt).toBe(end + 1);
    vi.setSystemTime(end + 1);
    expect(await service.check(call.id)).toBeNull(); expect(fetchReport).not.toHaveBeenCalled();
  });
  it("marks repeated missing reports unavailable but never downgrades retained available data", async () => {
    const available = await session(), missing = await session(), service = voiceCallReports(db, fetchReport);
    await service.check(available.id);
    await db.update(chatVoiceReports).set({ attempts: 7, nextCheckAt: new Date(0) }).where(eq(chatVoiceReports.sessionId, available.id));
    await db.insert(chatVoiceReports).values({ companyId, sessionId: missing.id, attempts: 7, nextCheckAt: new Date(0) });
    fetchReport.mockRejectedValue(new Error("provider unavailable"));
    await service.check(available.id); await service.check(missing.id);
    expect(await report(available.id)).toMatchObject({ attempts: 8, status: "available", costMicroUsd: "100" });
    expect(await report(missing.id)).toMatchObject({ attempts: 8, status: "unavailable" });
    expect((await report(missing.id)).nextCheckAt.getTime()).toBeGreaterThan(Date.now());
  });
  it("retains committed work during drain and ignores rolled-back nested writes", async () => {
    await start(); await flush(); enabled = false;
    const call = await session(); await flush();
    const drained = idleWorkSnapshot();
    await quiet(60_000); expect(idleWorkSnapshot()).toEqual(drained); expect(await report(call.id)).toBeUndefined();
    const resumeAt = coordinator!.nextWakeAt(); expect(resumeAt).not.toBeNull();
    enabled = true; await vi.advanceTimersByTimeAsync(Math.max(0, resumeAt! - Date.now()));
    await vi.waitFor(async () => { await flush(); expect(fetchReport).toHaveBeenCalledOnce(); });
    expect(await report(call.id)).toMatchObject({ status: "available" });
    await expect(db.transaction(async tx => { await session({}, tx as unknown as typeof db); throw new Error("rollback"); })).rejects.toThrow("rollback");
    await flush(); expect(fetchReport).toHaveBeenCalledOnce(); await quiet();
  });
  it("does not fetch an uncommitted nested termination", async () => {
    await start(); await flush();
    await db.transaction(async tx => {
      await session({}, tx as unknown as typeof db);
      await vi.advanceTimersByTimeAsync(5000); expect(fetchReport).not.toHaveBeenCalled();
    });
    await flush(); expect(fetchReport).toHaveBeenCalledOnce();
  });
  it("keeps a callback's earlier deadline when an older provider response finishes", async () => {
    const call = await session(), service = voiceCallReports(db, fetchReport);
    let release!: (value: SpekoCallReport) => void;
    fetchReport.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const checking = service.check(call.id);
    await vi.waitFor(() => expect(fetchReport).toHaveBeenCalledOnce());
    await due(call.id);
    release({ ...result(), costMicroUsd: "1" }); await checking;
    expect((await report(call.id)).nextCheckAt.getTime()).toBe(0);
    expect((await report(call.id)).costMicroUsd).toBeNull();
    await service.check(call.id); expect((await report(call.id)).costMicroUsd).toBe("100");
  });
  it("does not regress an available report from incomplete or older responses", async () => {
    const call = await session(), service = voiceCallReports(db, fetchReport);
    const latest = new Date(Date.now() + 10000);
    fetchReport.mockResolvedValueOnce({ ...result(), providerUpdatedAt: latest, costMicroUsd: "200" });
    await service.check(call.id);
    for (const response of [{ ...result(), complete: false, providerUpdatedAt: new Date(latest.getTime() + 1), costMicroUsd: "1" },
      { ...result(), providerUpdatedAt: new Date(0), costMicroUsd: "2" }]) {
      await due(call.id); fetchReport.mockResolvedValueOnce(response); await service.check(call.id);
      expect(await report(call.id)).toMatchObject({ status: "available", costMicroUsd: "200" });
    }
  });
  it("allows only one concurrent due claim and saves its retry before provider contact", async () => {
    const call = await session(), first = voiceCallReports(db, fetchReport), second = voiceCallReports(db, fetchReport);
    let release!: (value: SpekoCallReport) => void;
    fetchReport.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const checking = first.check(call.id);
    await vi.waitFor(() => expect(fetchReport).toHaveBeenCalledOnce());
    const saved = await report(call.id); expect(saved.attempts).toBe(1); expect(saved.nextCheckAt.getTime()).toBeGreaterThan(Date.now());
    await second.check(call.id); expect(fetchReport).toHaveBeenCalledOnce();
    release(result()); await checking;
  });
  it("pages and fairly schedules a backlog with one failing provider", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: false });
    const broken = await session(); for (let i = 0; i < 103; i++) await session();
    const other = await fixture(); const last = await session({ ...other, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" });
    fetchReport.mockImplementation(async call => { if (call.id === broken.id) throw new Error("unavailable"); return result(); });
    await start(); expect(fetchReport).toHaveBeenCalledTimes(25);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(fetchReport).toHaveBeenCalledTimes(50), { interval: 0 });
    expect(fetchReport.mock.calls.slice(25, 50).some(([call]) => call.id === last.id)).toBe(true);
    for (let pass = 0; pass < 20; pass++) {
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(coordinator!.nextWakeAt() !== null || idleWorkSnapshot().active === 0).toBe(true), { interval: 0 });
    }
    expect(fetchReport).toHaveBeenCalledTimes(105);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0), { interval: 0 });
    expect((await report(broken.id)).attempts).toBe(1); await quiet();
  });
  it("reconstructs recent reports without scanning old history and preserves submillisecond page boundaries", async () => {
    const seed = await session({ endedAt: new Date(Date.now() - 2 * day) });
    await db.execute(sql`insert into chat_voice_sessions
      (company_id, endpoint_id, conversation_id, issue_id, assigned_agent_id, caller_id,
       caller_authority, mode, state, generation, credential_fingerprint, provider_session_id,
       tool_token_hash, idempotency_key, request_fingerprint, expires_at, ended_at, created_at)
      select company_id, endpoint_id, conversation_id, issue_id, assigned_agent_id, gen_random_uuid()::text,
        caller_authority, mode, state, generation, credential_fingerprint, gen_random_uuid()::text,
        tool_token_hash, gen_random_uuid()::text, request_fingerprint, expires_at, ended_at, created_at
      from chat_voice_sessions cross join generate_series(1, 20000) where id = ${seed.id}`);
    const stamp = new Date(Date.now() - 60_000).toISOString();
    const expected: string[] = [];
    for (let i = 0; i < 205; i++) {
      const row = await session(); expected.push(row.id);
      await db.execute(sql`update chat_voice_sessions set ended_at = ${stamp}::timestamptz + (${i % 3} * interval '0.0001 second') where id = ${row.id}`);
    }
    await db.execute(sql`analyze chat_voice_sessions`);
    const queries: Array<{ text: string; parameters: unknown[] }> = [];
    const original = db.$client.unsafe.bind(db.$client);
    const capture = vi.spyOn(db.$client, "unsafe").mockImplementation(((text: string, parameters: unknown[] = [], ...rest: unknown[]) => {
      if (text.includes('from "chat_voice_sessions"') && text.includes('left join "chat_voice_reports"')) queries.push({ text, parameters });
      return original(text, parameters as never, ...rest as []);
    }) as typeof db.$client.unsafe);
    let loaded: Awaited<ReturnType<ReturnType<typeof voiceCallReports>["load"]>>;
    try { loaded = await voiceCallReports(db, fetchReport).load(); }
    finally { capture.mockRestore(); }
    expect(loaded!.map(row => row.id).sort()).toEqual(expected.sort());
    expect(queries).toHaveLength(3);
    function removed(node: Record<string, unknown>): number {
      return Math.max(Number(node["Rows Removed by Filter"] ?? 0),
        ...(Array.isArray(node.Plans) ? node.Plans.map(child => removed(child)) : []));
    }
    for (const query of queries) {
      const [row] = await db.$client.unsafe(`explain (analyze, buffers, format json) ${query.text}`, query.parameters as never);
      expect(removed(row["QUERY PLAN"][0].Plan)).toBeLessThan(1000);
    }
    expect(fetchReport).not.toHaveBeenCalled();
  }, 30_000);
  it("joins an in-flight report at shutdown and resumes its saved retry", async () => {
    const call = await session(); let release!: (value: SpekoCallReport) => void;
    fetchReport.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = voiceCallReports(db, fetchReport).register(coordinator, () => true);
    await vi.waitFor(() => expect(fetchReport).toHaveBeenCalledOnce());
    let stopped = false; const stopping = coordinator.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1000); expect(stopped).toBe(false);
    release(result()); await stopping; await worker.ready;
    expect((await report(call.id)).status).toBe("available");
    await start(); await flush(); await quiet(); expect(fetchReport).toHaveBeenCalledOnce();
  });
});
