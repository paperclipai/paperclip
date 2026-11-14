import { createSlackIdentityLinks } from "../services/chat-channels/slack/identity-links.js";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, companies, companyMemberships, companySecretProviderConfigs, companySecrets, companySecretVersions, createDb, decisionArchiveNotificationOutbox,
  decisionRetention, invites, joinRequests, principalPermissionGrants, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { joinRequestRetentionService, registerJoinRequestRetentionWork } from "../services/join-request-retention.js";
import { decisionRetentionService, DEFAULT_DECISION_ARCHIVE_DAYS } from "../services/decision-retention.js";
import { attentionService } from "../services/attention.js";
import { companyService } from "../services/companies.js";
import { writeJoinRequestChange } from "../services/retention-work-notifications.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_JOIN_RETENTION_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const delay = DEFAULT_DECISION_ARCHIVE_DAYS * 86_400_000;
(support.supported ? describe : describe.skip)("join request retention worker", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, companyId: string, userId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let draining: boolean;
  let accessRoutes: typeof import("../routes/access.js").accessRoutes;
  const errors: unknown[] = [];
  beforeAll(async () => {
    ({ accessRoutes } = await import("../routes/access.js"));
    if (!externalUrl) temporary = await startEmbeddedPostgresTestDatabase("join-retention-");
    db = createDb(externalUrl ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "0123456789abcdef0123456789abcdef");
    companyId = randomUUID(); userId = randomUUID(); draining = false; errors.length = 0;
    await db.insert(companies).values({ id: companyId, name: "Join retention", issuePrefix: `J${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    await db.execute(sql`drop trigger if exists join_retention_fail on decision_retention`);
    await db.execute(sql`drop function if exists join_retention_fail()`);
    await db.delete(decisionArchiveNotificationOutbox); await db.delete(decisionRetention); await db.delete(activityLog);
    await db.delete(chatIdentityLinks); await db.delete(chatExternalPrincipals); await db.delete(chatEndpoints);
    await db.delete(toolConnections); await db.delete(toolApplications); await db.delete(agents);
    await db.delete(joinRequests); await db.delete(invites); await db.delete(principalPermissionGrants);
    await db.delete(companySecretVersions); await db.delete(companySecrets); await db.delete(companySecretProviderConfigs);
    await db.delete(companyMemberships); await db.delete(authUsers); await db.delete(companies);
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  const old = () => new Date(Date.now() - delay - 60_000);
  const state = (id: string) => decisionRetentionService(db).getState(companyId, "join_request", id);
  async function exactDeadline(id: string) {
    const [row] = await db.select({ micros: sql<string>`(extract(epoch from ${joinRequests.updatedAt}) * 1000000)::bigint::text` })
      .from(joinRequests).where(eq(joinRequests.id, id));
    return Number((BigInt(row!.micros) + 999n) / 1000n) + delay;
  }
  const authActor = () => ({ type: "board" as const, source: "local_implicit" as const, userId, companyIds: [companyId], isInstanceAdmin: true,
    memberships: [{ companyId, membershipRole: "owner", status: "active" }] });
  const mutation = (id: string) => ({ companyId, sourceKind: "join_request" as const, sourceId: id, authActor: authActor(),
    actor: { actorType: "user" as const, actorId: userId, agentId: null, userId, runId: null, agentApiKeyId: null, responsibleUserId: userId } });
  async function invite(database: Db = db) {
    const token = randomUUID();
    const [row] = await database.insert(invites).values({ companyId, tokenHash: createHash("sha256").update(token).digest("hex"),
      allowedJoinTypes: "both", expiresAt: new Date(Date.now() + 86_400_000), invitedByUserId: userId }).returning();
    return { ...row, token };
  }
  async function create(at = new Date(), database: Db = db) {
    const invitation = await invite(database);
    const [row] = await writeJoinRequestChange(database, tx => tx.insert(joinRequests).values({ companyId, inviteId: invitation.id,
      requestType: "agent", requestIp: "127.0.0.1", agentName: "Pending agent", createdAt: at, updatedAt: at }).returning());
    return row;
  }
  function app(database: Db = db) {
    const server = express(); server.use(express.json());
    server.use((req, _res, next) => { req.actor = authActor(); next(); });
    server.use("/api", accessRoutes(database, { deploymentMode: "authenticated", deploymentExposure: "private",
      bindHost: "127.0.0.1", allowedHostnames: [] }));
    server.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message });
    });
    return server;
  }
  async function accept(token: string, database: Db = db) {
    const response = await request(app(database)).post(`/api/invites/${token}/accept`)
      .send({ requestType: "agent", agentName: "New agent", adapterType: "claude_local" });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const [row] = await database.select().from(joinRequests).where(eq(joinRequests.companyId, companyId));
    return row;
  }
  async function start(service = joinRequestRetentionService(db)) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true, onError: error => errors.push(error) });
    await registerJoinRequestRetentionWork(coordinator, service, () => !draining).ready;
    return service;
  }
  async function settle() {
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(30_000); expect(idleWorkSnapshot().active).toBe(0); }, { timeout: 5000 });
  }
  async function quiet() {
    await settle(); expect(coordinator!.nextWakeAt()).toBeNull();
    const reads = vi.spyOn(db, "select"), executes = vi.spyOn(db, "execute"), writes = vi.spyOn(db, "transaction");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(reads).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    reads.mockRestore(); executes.mockRestore(); writes.mockRestore();
  }
  async function archived(id: string) {
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(30_000); expect((await state(id))?.archivedAt).toBeInstanceOf(Date); }, { timeout: 5000 });
  }

  it("wakes from real invite acceptance, waits for the saved deadline, and disarms on rejection", async () => {
    await start(); await quiet();
    const invitation = await invite(); const row = await accept(invitation.token);
    await settle(); expect(coordinator!.nextWakeAt()).toBe(await exactDeadline(row.id));
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(300_000);
    expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    const response = await request(app()).post(`/api/companies/${companyId}/join-requests/${row.id}/reject`).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200); await quiet();
    expect(await state(row.id)).toBeNull();
  });

  it("archives unseen pending requests at the actual deadline without changing approval status", async () => {
    await start(); await quiet(); const deadline = Date.now() + 600_000;
    const row = await create(new Date(deadline - delay)); await settle();
    expect(coordinator!.nextWakeAt()).toBe(deadline); expect(await state(row.id)).toBeNull();
    const window = deadline - Date.now() - 30_000; expect(window).toBeGreaterThan(0);
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(window);
    expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    await vi.advanceTimersByTimeAsync(60_000); await archived(row.id); await quiet();
    expect((await db.select().from(joinRequests))[0].status).toBe("pending_approval");
    expect(await db.select().from(decisionArchiveNotificationOutbox)).toHaveLength(0);
  });

  it("rounds a submillisecond join deadline up to the next scheduler millisecond", async () => {
    const row = await create(), floor = Date.now() + 120_000;
    const activity = new Date(floor - delay).toISOString();
    await db.execute(sql`update join_requests set updated_at = ${activity}::timestamptz + interval '456 microseconds' where id = ${row.id}`);
    const service = joinRequestRetentionService(db);
    expect(await service.next()).toBe(floor + 1);
    expect(await service.sweep(new Date(floor))).toEqual({ archived: 0 });
    expect(await state(row.id)).toBeNull();
    expect(await service.sweep(new Date(floor + 1))).toEqual({ archived: 1 });
  });

  it.each(["keep", "archive", "revive"] as const)("applies %s to an unseen young request without reading the feed", async action => {
    const row = await create(); expect(await state(row.id)).toBeNull();
    const retention = decisionRetentionService(db);
    const result = action === "keep" ? await retention.setKeep({ ...mutation(row.id), keep: true })
      : action === "archive" ? await retention.archive(mutation(row.id)) : await retention.revive(mutation(row.id));
    expect(result).toMatchObject({ sourceKind: "join_request", sourceId: row.id, sourceActivityAt: row.updatedAt, keep: action === "keep" });
    expect(result.archivedAt).toEqual(action === "archive" ? expect.any(Date) : null);
    expect(await state(row.id)).toMatchObject({ id: result.id });
  });

  it("reconstructs pending requests at startup and ignores resolved history", async () => {
    const due = await create(old()), resolved = await create(old());
    await db.update(joinRequests).set({ status: "approved" }).where(eq(joinRequests.id, resolved.id));
    await start(); await archived(due.id); await quiet(); expect(await state(resolved.id)).toBeNull();
  });

  it("keeps revoked and expired invite requests visible under the existing retention policy", async () => {
    const row = await create(old()); await db.update(invites).set({ expiresAt: old(), revokedAt: old() });
    const feed = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
    expect(feed.items.some(item => item.subject.id === row.id)).toBe(true);
    await start(); await archived(row.id); await quiet();
  });

  it("waits for company activation and disarms when the company pauses", async () => {
    const row = await create(old()); await companyService(db).update(companyId, { status: "paused" });
    await start(); await quiet(); expect(await state(row.id)).toBeNull();
    await companyService(db).update(companyId, { status: "active" }); await archived(row.id); await quiet();
    await create(); await settle(); expect(coordinator!.nextWakeAt()).not.toBeNull();
    await companyService(db).update(companyId, { status: "paused" }); await quiet();
  });

  it("honors keep and schedules an old request again when unkept", async () => {
    const row = await create(old()); await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
    await decisionRetentionService(db).setKeep({ ...mutation(row.id), keep: true });
    await start(); await quiet();
    await decisionRetentionService(db).setKeep({ ...mutation(row.id), keep: false }); await archived(row.id); await quiet();
  });

  it("honors manual archival and reactivates on revive", async () => {
    const row = await create(old()); await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
    await decisionRetentionService(db).archive(mutation(row.id)); await start(); await quiet();
    await decisionRetentionService(db).revive(mutation(row.id)); await archived(row.id); await quiet();
  });

  it("preserves normal attention reads but omits join requests from maintenance", async () => {
    const row = await create(old());
    const excluded = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true, excludeSources: ["join_request"] });
    expect(excluded.items.some(item => item.sourceKind === "join_request")).toBe(false); expect(await state(row.id)).toBeNull();
    const feed = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
    expect(feed.items.some(item => item.subject.id === row.id)).toBe(true);
  });

  it("defers nested request writes until outer commit and releases rolled-back writes", async () => {
    await start(); await quiet();
    await expect(db.transaction(async tx => {
      await create(new Date(), tx as unknown as Db);
      await vi.advanceTimersByTimeAsync(120_000); expect(coordinator!.nextWakeAt()).toBeNull(); throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await quiet(); expect(await db.select().from(joinRequests)).toHaveLength(0);
    let row: typeof joinRequests.$inferSelect;
    await db.transaction(async tx => {
      row = await create(new Date(), tx as unknown as Db);
      await vi.advanceTimersByTimeAsync(120_000); expect(coordinator!.nextWakeAt()).toBeNull();
    });
    await settle(); expect(coordinator!.nextWakeAt()).toBe(row!.updatedAt.getTime() + delay);
  });

  it("retains a first write during drain without passive SQL", async () => {
    await start(); await quiet(); draining = true; const row = await create(old());
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(120_000);
    expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    draining = false; await archived(row.id); await quiet();
  });

  it("retains a failed archival through drain until the database recovers", async () => {
    const row = await create(old());
    await db.execute(sql`create function join_retention_fail() returns trigger language plpgsql as $$ begin
      raise exception 'retention unavailable'; end $$`);
    await db.execute(sql`create trigger join_retention_fail before insert or update on decision_retention for each row execute function join_retention_fail()`);
    const service = joinRequestRetentionService(db); const sweep = vi.spyOn(service, "sweep");
    await start(service); await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0)); draining = true;
    await Promise.allSettled(sweep.mock.results.map(result => result.value));
    await vi.advanceTimersByTimeAsync(30_000);
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(120_000);
    expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    await db.execute(sql`drop trigger join_retention_fail on decision_retention`); draining = false;
    await archived(row.id); await quiet();
    for (const error of errors) expect(error).toMatchObject({ cause: { message: "retention unavailable" } }); errors.length = 0;
  });

  it("wakes from the Slack access-request producer and deduplicates repeated requests", async () => {
    await start(); await quiet(); const token = randomUUID(), endpointId = randomUUID();
    const [agent] = await db.insert(agents).values({ companyId, name: "Chat agent", role: "engineer", status: "active", adapterType: "codex_local" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Slack", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "Slack", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId: connection.id, provider: "slack", publicId: randomUUID(), assignedAgentId: agent.id, status: "active" });
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId, provider: "slack", providerAccountId: "team", externalId: randomUUID() }).returning();
    await db.insert(chatIdentityLinks).values({ companyId, endpointId, principalId: principal.id,
      confirmationTokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 600_000) });
    const links = createSlackIdentityLinks(db, {
      previewIdentityLink: async () => ({ selfService: true, canConfirm: false, companyId, endpointId }),
      stageProviderEffect: vi.fn(async () => null),
    });
    expect(await links.requestIdentityAccess(token, userId, "127.0.0.1")).toEqual({ status: "pending_approval" });
    await settle(); const [row] = await db.select().from(joinRequests);
    expect(coordinator!.nextWakeAt()).toBe(await exactDeadline(row.id));
    await links.requestIdentityAccess(token, userId, "127.0.0.1"); await settle();
    expect(await db.select().from(joinRequests)).toHaveLength(1);
  });

  it("disarms after the real approval route resolves a human request", async () => {
    const requester = randomUUID();
    await db.insert(authUsers).values({ id: requester, name: "Joiner", email: `${requester}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const row = await create();
    await db.update(joinRequests).set({ requestType: "human", requestingUserId: requester }).where(eq(joinRequests.id, row.id));
    await start(); await settle(); expect(coordinator!.nextWakeAt()).not.toBeNull();
    const response = await request(app()).post(`/api/companies/${companyId}/join-requests/${row.id}/approve`).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200); await quiet();
    expect((await db.select().from(joinRequests))[0].status).toBe("approved");
  });

  it("rechecks activity after waiting for a concurrent request writer", async () => {
    const row = await create(old()); let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const admitted = new Promise<void>(resolve => { locked = resolve; });
    const write = db.transaction(async tx => {
      await tx.execute(sql`select id from join_requests where id = ${row.id} for update`); locked(); await gate;
      await writeJoinRequestChange(tx as unknown as Db, owner => owner.update(joinRequests).set({ updatedAt: new Date() }).where(eq(joinRequests.id, row.id)));
    });
    await admitted; const sweep = joinRequestRetentionService(db).sweep();
    try {
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
            and query like 'select%' and query like '%from "join_requests"%'`);
        expect(row.waiting).toBe(1);
      });
    } finally { release(); await write; await sweep; }
    expect(await state(row.id)).toBeNull();
  });

  it("keeps an archived request archived when activity commits after the sweep until explicitly revived", async () => {
    const row = await create(old()), service = joinRequestRetentionService(db);
    expect(await service.sweep()).toEqual({ archived: 1 });
    const archivedAt = (await state(row.id))!.archivedAt;
    await writeJoinRequestChange(db, tx => tx.update(joinRequests).set({ updatedAt: new Date() }).where(eq(joinRequests.id, row.id)));
    expect(await state(row.id)).toMatchObject({ archivedAt });
    expect(await service.next()).toBeNull();
    expect((await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true })).items
      .some(item => item.subject.id === row.id)).toBe(false);
    await decisionRetentionService(db).revive(mutation(row.id));
    expect((await state(row.id))!.archivedAt).toBeNull();
    expect(await service.next()).toBe(await exactDeadline(row.id));
    expect(await service.sweep()).toEqual({ archived: 0 });
  });

  it("pages past failed requests with database timestamp precision and retries them later", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) ids.push((await create(old())).id);
    ids.sort(); const last = ids.at(-1)!;
    await db.execute(sql`update join_requests set updated_at = date_trunc('milliseconds', now() - interval '91 days') + interval '456 microseconds'`);
    await db.execute(sql`create function join_retention_fail() returns trigger language plpgsql as $$ begin
      if new.archived_at is not null and new.source_id <> TG_ARGV[0] then raise exception 'retention unavailable'; end if;
      return new; end $$`);
    await db.execute(sql`create trigger join_retention_fail before update on decision_retention for each row execute function join_retention_fail(${sql.raw("'" + last + "'")})`);
    const service = joinRequestRetentionService(db);
    await expect(service.sweep()).rejects.toThrow("Join request retention failed");
    expect(await service.sweep()).toEqual({ archived: 1 }); expect((await state(last))?.archivedAt).toBeInstanceOf(Date);
    await db.execute(sql`drop trigger join_retention_fail on decision_retention`);
    expect(await service.sweep()).toEqual({ archived: 100 }); expect(await service.sweep()).toEqual({ archived: 0 });
    expect(await service.next()).toBeNull();
  });

  it("retries a failed request while newer overdue pages keep arriving", async () => {
    const at = old(); const failed = await create(at);
    const append = async (offset: number) => {
      for (let i = 0; i < 100; i++) await create(new Date(at.getTime() + offset + i));
    };
    await append(1);
    await db.execute(sql`create function join_retention_fail() returns trigger language plpgsql as $$ begin
      if new.archived_at is not null and new.source_id = TG_ARGV[0] then raise exception 'retention unavailable'; end if;
      return new; end $$`);
    await db.execute(sql`create trigger join_retention_fail before update on decision_retention for each row execute function join_retention_fail(${sql.raw("'" + failed.id + "'")})`);
    const service = joinRequestRetentionService(db);
    await expect(service.sweep()).rejects.toThrow("Failed query");
    await append(1000); await service.sweep();
    await append(2000);
    await db.execute(sql`drop trigger join_retention_fail on decision_retention`);
    await service.sweep();
    expect((await state(failed.id))?.archivedAt).toBeInstanceOf(Date);
    while (await service.next() !== null) await service.sweep();
    expect(await service.next()).toBeNull();
  });

  it("joins an admitted archive on shutdown and leaves later candidates for restart", async () => {
    const first = await create(new Date(old().getTime() - 1000)), second = await create(old());
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const transaction = db.transaction.bind(db);
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementationOnce((write, options) => transaction(async tx => {
      locked(); await gate; return write(tx);
    }, options));
    const starting = start(); await acquired;
    let stopped = false; const stopping = coordinator!.stop().then(() => { stopped = true; });
    try { await vi.advanceTimersByTimeAsync(500); expect(stopped).toBe(false); } finally { release(); }
    await starting; await stopping; coordinator = undefined; transactionSpy.mockRestore();
    expect((await state(first.id))?.archivedAt).toBeInstanceOf(Date); expect(await state(second.id)).toBeNull();
    await start(); await archived(second.id); await quiet();
  });


  it("moves the saved deadline after a supported gateway invite replay", async () => {
    const invitation = await invite(); await start(); await quiet();
    const body = { requestType: "agent", agentName: "Gateway", adapterType: "openclaw_gateway",
      agentDefaultsPayload: { url: "ws://127.0.0.1:18789", disableDeviceAuth: true, headers: { "x-openclaw-token": "fixture-gateway-token-1234567890" } } };
    const first = await request(app()).post(`/api/invites/${invitation.token}/accept`).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(202); await settle();
    const initial = coordinator!.nextWakeAt();
    await vi.advanceTimersByTimeAsync(60_000);
    const replay = await request(app()).post(`/api/invites/${invitation.token}/accept`).send({ ...body, agentName: "Renamed gateway" });
    expect(replay.status, JSON.stringify(replay.body)).toBe(202); await settle();
    const rows = await db.select().from(joinRequests); expect(rows).toHaveLength(1);
    expect(coordinator!.nextWakeAt()).toBe(rows[0].updatedAt.getTime() + delay);
    expect(coordinator!.nextWakeAt()).toBeGreaterThan(initial!);
  });

});
