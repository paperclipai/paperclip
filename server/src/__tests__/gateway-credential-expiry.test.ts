import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, toolAccessAuditEvents, toolGatewaySessions,
  toolMcpGateways, toolMcpGatewayTokens, toolProfiles } from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerGatewayCredentialExpiryWork } from "../services/gateway-credential-expiry-work.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_GATEWAY_EXPIRY_TEST_DATABASE_URL");
const supported = external ? true : (await getEmbeddedPostgresTestSupport()).supported;

describe.skipIf(!supported)("gateway credential expiry", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let gateway: ReturnType<typeof createToolGatewayService>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let companyId: string, agentId: string, runId: string, namedId: string;
  let draining: boolean;
  const errors: unknown[] = [];

  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("gateway-expiry-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  beforeEach(async () => {
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    companyId = randomUUID(); agentId = randomUUID(); runId = randomUUID(); draining = false; errors.length = 0;
    await db.insert(companies).values({ id: companyId, name: "Credential expiry", issuePrefix: "EXP" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", status: "running" });
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: "expiry", name: "Expiry", defaultAction: "deny" }).returning();
    gateway = createToolGatewayService(db, { toolActionSigningSecret: "expiry-test-only" });
    namedId = (await gateway.createNamedGateway({ companyId, body: { name: "Expiry", profileId: profile.id } })).id;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolGatewaySessions);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(toolMcpGateways);
    await db.delete(toolProfiles);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    expect(errors).toEqual([]);
  });
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining,
      canReconcile: () => true, onError: error => errors.push(error) });
    await registerGatewayCredentialExpiryWork(coordinator, gateway, () => !draining).ready;
  }
  async function settle(ms = 60_000) {
    await vi.advanceTimersByTimeAsync(ms);
    if (!draining) await vi.waitFor(async () => {
      // Let real SQL settle before advancing only to an actually armed follow-up.
      // Repeated blind clock jumps can expire the future credential under test.
      if (idleWorkSnapshot().active > 0) {
        await db.execute(sql`select pg_sleep(0.01)`);
        const next = coordinator!.nextWakeAt();
        if (next !== null && next <= Date.now() + 30_000) {
          await vi.advanceTimersByTimeAsync(Math.max(0, next - Date.now()));
        }
      }
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5000 });
  }
  async function quiet() {
    await settle(); expect(coordinator!.nextWakeAt()).toBeNull();
    const reads = vi.spyOn(db, "execute"), selects = vi.spyOn(db, "select"), deletes = vi.spyOn(db, "delete");
    await settle(60 * 60_000);
    expect(reads).not.toHaveBeenCalled(); expect(selects).not.toHaveBeenCalled(); expect(deletes).not.toHaveBeenCalled();
    reads.mockRestore(); selects.mockRestore(); deletes.mockRestore();
  }
  const token = (expiresAt?: Date) => gateway.createNamedGatewayToken({ companyId, gatewayId: namedId, body: { name: "Expiry", expiresAt } });
  const session = (service = gateway) => service.createSession({ companyId, agentId, runId, ttlMs: 5 * 60_000 });

  it("stays quiet with configuration and a nonexpiring token, then expires real tokens and sessions by deadline", async () => {
    await start(); await quiet();
    const retained = await token(); await quiet();
    const active = await session();
    const due = new Date(Date.now() + 3 * 60_000);
    const expiring = await token(due);
    await settle();
    expect(coordinator!.nextWakeAt()).toBe(due.getTime());
    const reads = vi.spyOn(db, "execute"), selects = vi.spyOn(db, "select");
    await settle(30_000);
    expect(reads).not.toHaveBeenCalled(); expect(selects).not.toHaveBeenCalled();
    reads.mockRestore(); selects.mockRestore();
    await gateway.revokeNamedGatewayToken({ companyId, tokenId: expiring.id });
    await settle(2 * 60_000);
    expect((await db.select().from(toolMcpGatewayTokens)).map(row => row.id)).toEqual([retained.id]);
    expect(coordinator!.nextWakeAt()).toBe(active.expiresAt.getTime());
    await settle(2 * 60_000);
    expect(await db.select().from(toolGatewaySessions)).toEqual([]);
    await quiet();
  });

  it.each([
    { kind: "session", rollback: false }, { kind: "session", rollback: true },
    { kind: "token", rollback: false }, { kind: "token", rollback: true },
  ])("respects $kind outer transaction settlement (rollback $rollback)", async ({ kind, rollback }) => {
    await start(); await quiet();
    let release!: () => void, written!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const staged = new Promise<void>(resolve => { written = resolve; });
    const rollbackError = new Error("rollback fixture");
    const writing = db.transaction(async tx => {
      const scoped = createToolGatewayService(tx as unknown as typeof db, { toolActionSigningSecret: "expiry-test-only" });
      if (kind === "session") await session(scoped);
      else await scoped.createNamedGatewayToken({ companyId, gatewayId: namedId,
        body: { name: "Outer transaction", expiresAt: new Date(Date.now() + 5 * 60_000) } });
      written(); await gate; if (rollback) throw rollbackError;
    }).catch(error => { if (error !== rollbackError) throw error; });
    await Promise.race([staged, writing]);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await db.select().from(toolGatewaySessions)).toEqual([]);
      expect(await db.select().from(toolMcpGatewayTokens)).toEqual([]);
    } finally { release(); }
    await writing; await settle();
    if (rollback) await quiet();
    else {
      expect(coordinator!.nextWakeAt()).toBe(await gateway.nextCredentialExpiryAt());
      await settle(5 * 60_000); await quiet();
    }
  });

  it("coalesces sequential credential writes within the former cleanup cadence", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: false });
    const cleanup = vi.spyOn(gateway, "cleanupExpiredSessions");
    const next = vi.spyOn(gateway, "nextCredentialExpiryAt");
    await start();
    const firstPassAt = Date.now();
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) await session();
      else await token(new Date(Date.now() + 5 * 60_000));
      await vi.advanceTimersByTimeAsync(1);
      // Let each old scan finish so this measures sequential writes, not overlapping calls.
      await db.execute(sql`select pg_sleep(0.01)`);
    }
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(coordinator!.nextWakeAt()).toBe(firstPassAt + 30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(2));
    await db.execute(sql`select pg_sleep(0.01)`);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(coordinator!.nextWakeAt()).toBeGreaterThan(Date.now());
    await settle(5 * 60_000); await quiet();
  });

  it("keeps a loaded expiry deadline ahead of credential notification coalescing", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: false });
    const deadline = Date.now() + 500;
    await token(new Date(deadline));
    await start();
    expect(coordinator!.nextWakeAt()).toBe(deadline);
    await session();
    await vi.advanceTimersByTimeAsync(1);
    await db.execute(sql`select pg_sleep(0.01)`);
    expect(coordinator!.nextWakeAt()).toBe(deadline);
    await vi.advanceTimersByTimeAsync(499);
    await vi.waitFor(async () => expect(await db.select().from(toolMcpGatewayTokens)).toEqual([]));
    expect(await db.select().from(toolGatewaySessions)).toHaveLength(1);
    await settle(5 * 60_000); await quiet();
  });

  it("rejects a newly expired credential while physical cleanup is coalesced", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: false });
    const cleanup = vi.spyOn(gateway, "cleanupExpiredSessions");
    await start();
    const at = Date.now();
    const active = await gateway.createSession({ companyId, agentId, runId, ttlMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await db.execute(sql`select pg_sleep(0.01)`);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(await db.select().from(toolGatewaySessions)).toHaveLength(1);
    await expect(gateway.listToolsForSession(active.token)).rejects.toMatchObject({ status: 401, reasonCode: "session_expired" });
    expect(coordinator!.nextWakeAt()).toBe(at + 30_000);
    await vi.advanceTimersByTimeAsync(29_000);
    await vi.waitFor(async () => expect(await db.select().from(toolGatewaySessions)).toEqual([]));
    await quiet();
  });

  it.each(["sessions", "tokens", "both"] as const)("drains the full %s backlog without a registered scheduler", async kind => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: false });
    const now = new Date();
    const futureSession = await session();
    const futureToken = await token(new Date(now.getTime() + 60_000));
    const nonexpiringToken = await token();
    if (kind !== "tokens") await db.insert(toolGatewaySessions).values(Array.from({ length: 1001 }, () => ({
      companyId, agentId, runId, tokenHash: randomUUID(), expiresAt: new Date(now.getTime() - 1),
    })));
    if (kind !== "sessions") await db.insert(toolMcpGatewayTokens).values(Array.from({ length: 1001 }, () => ({
      companyId, gatewayId: namedId, name: "Expired", tokenHash: randomUUID(), expiresAt: new Date(now.getTime() - 1),
    })));
    await expect(gateway.cleanupExpiredSessions({ now })).resolves.toEqual({ deletedCount: kind === "tokens" ? 0 : 1001 });
    expect((await db.select().from(toolGatewaySessions)).map(row => row.id)).toEqual([futureSession.id]);
    expect((await db.select().from(toolMcpGatewayTokens)).map(row => row.id).sort()).toEqual([futureToken.id, nonexpiringToken.id].sort());
    expect(coordinator).toBeUndefined();
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it("bounds session cleanup and schedules the remaining overdue batch", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: false });
    await db.insert(toolGatewaySessions).values(Array.from({ length: 501 }, () => ({
      companyId, agentId, runId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() - 1),
    })));
    const future = await session();
    const cleanup = vi.spyOn(gateway, "cleanupExpiredSessions");
    await start();
    expect(cleanup).toHaveResolvedWith({ deletedCount: 500 });
    expect(await db.select().from(toolGatewaySessions)).toHaveLength(2);
    expect(coordinator!.nextWakeAt()).toBe(Date.now() + 30_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(async () => expect((await db.select().from(toolGatewaySessions)).map(row => row.id)).toEqual([future.id]));
    await settle(5 * 60_000); await quiet();
  });

  it("reconstructs saved token expiry on startup", async () => {
    const due = new Date(Date.now() + 5 * 60_000);
    await token(due);
    await start(); await settle();
    expect(coordinator!.nextWakeAt()).toBe(due.getTime());
    await settle(5 * 60_000);
    expect(await db.select().from(toolMcpGatewayTokens)).toEqual([]);
    await quiet();
  });

  it("drains an overdue persisted backlog across bounded batches", async () => {
    await db.insert(toolMcpGatewayTokens).values(Array.from({ length: 501 }, (_, index) => ({
      companyId, gatewayId: namedId, name: `Expired ${index}`, tokenHash: randomUUID(),
      tokenPrefix: "expired", expiresAt: new Date(Date.now() - 1),
    })));
    await start();
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    await quiet();
    expect(await db.select().from(toolMcpGatewayTokens)).toEqual([]);
  });

  it("retains cleanup through drain without permitting expired authentication", async () => {
    await start(); await quiet(); draining = true;
    const active = await session();
    const expiredToken = await token(new Date(Date.now() + 3 * 60_000));
    await settle();
    const reads = vi.spyOn(db, "execute"), selects = vi.spyOn(db, "select");
    await settle(10 * 60_000);
    expect(reads).not.toHaveBeenCalled(); expect(selects).not.toHaveBeenCalled();
    reads.mockRestore(); selects.mockRestore();
    expect(await db.select().from(toolGatewaySessions)).toHaveLength(1);
    await expect(gateway.listToolsForSession(active.token)).rejects.toMatchObject({ status: 401, reasonCode: "session_expired" });
    await expect(gateway.initializeNamedGatewayProtocol({ gatewayId: namedId, bearerToken: expiredToken.token }))
      .rejects.toMatchObject({ status: 401 });
    draining = false; await settle();
    expect(await db.select().from(toolGatewaySessions)).toEqual([]);
    expect(await db.select().from(toolMcpGatewayTokens)).toEqual([]);
    await quiet();
  });
});
