import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, companies, authUsers, companyMemberships, mcpOauthClients, mcpOauthGrants, issues, agents, dotAgentBindings, dotMailboxItems, dotRunnerAssignments, heartbeatRuns, mcpEventDeliveries, mcpEventSubscriptions } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createPublicMcpEvents } from "./events.js";
import { createPublicMcpOAuth } from "./oauth.js";
import { instanceSettingsService } from "../instance-settings.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { logActivity } from "../activity-log.js";
import { insertIssueComment } from "../issue-comment-writes.js";
import { dotRunnerBroker } from "../dot-runner-broker.js";
import { idleWorkSnapshot } from "../task-admission.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_MCP_SLEEP_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("MCP event committed work", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  let service: ReturnType<typeof createPublicMcpEvents>;
  let companyId: string, userId: string, taskId: string;
  let draining: boolean, standby: boolean;
  let calls: string[], received: Array<{ eventId: string; data: Record<string, unknown> }>;
  let errors: unknown[], status: number;
  let failRead: boolean;
  let duringDelivery: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    if (externalUrl) await applyPendingMigrations(externalUrl);
    else temporary = await startEmbeddedPostgresTestDatabase("mcp-sleep-");
    db = createDb(externalUrl ?? temporary.connectionString, { maxConnections: 6 });
  }, 90000);
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    draining = false; standby = false; calls = []; received = []; errors = []; status = 204; failRead = false; duringDelivery = undefined;
    companyId = randomUUID(); userId = randomUUID(); taskId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "MCP idle", issuePrefix: "MCP" });
    await db.insert(authUsers).values({ id: userId, name: "MCP test", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", membershipRole: "owner", status: "active" });
    await db.insert(issues).values({ id: taskId, companyId, title: "Events" });
    await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true, enableOpenAiDot: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await service?.stop(); await coordinator?.stop();
    vi.useRealTimers();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.delete(authUsers).where(eq(authUsers.id, userId));
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); vi.unstubAllEnvs(); });

  async function fixture(dot = false, scope = { companyId, taskId }) {
    const { companyId, taskId } = scope;
    const config = { origin: "https://paperclip.example", resource: `https://paperclip.example/mcp/${dot ? "runner" : "paperclip"}` };
    const clientId = randomUUID();
    await db.insert(mcpOauthClients).values({ id: clientId, name: "Sleep fixture", redirectUris: ["https://receiver.example/oauth"] });
    const agentId = dot ? randomUUID() : null;
    if (agentId) await db.insert(agents).values({ id: agentId, companyId, name: "Dot", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "openai_dot" } });
    const [grant] = await db.insert(mcpOauthGrants).values({ companyId, userId, clientId, resource: config.resource, purpose: dot ? "agent" : "personal", agentId, scopes: [dot ? "paperclip:agent" : "paperclip:read"] }).returning();
    const bindingId = dot ? randomUUID() : null;
    if (bindingId && agentId) {
      await db.insert(dotAgentBindings).values({ id: bindingId, companyId, agentId, operatorId: userId, grantId: grant.id, status: "connected" });
      await db.update(agents).set({ adapterConfig: { provider: "openai_dot", dotBindingId: bindingId } }).where(eq(agents.id, agentId));
    }
    const observed = new Proxy(db, { get(target, key) {
      if (!["select", "update", "insert", "delete", "execute", "transaction"].includes(String(key))) return Reflect.get(target, key);
      return (...args: unknown[]) => {
        calls.push(String(key));
        if (failRead && key === "select") { failRead = false; throw new Error("injected read failure"); }
        return Reflect.apply(Reflect.get(target, key), target, args);
      };
    } });
    const oauth = createPublicMcpOAuth(observed, config);
    const principal = await oauth.authorizeGrant(grant.id);
    const input = { name: dot ? "paperclip.dot.mailbox_updated" : "paperclip.task.status_changed", arguments: { companyId, ...(dot ? { bindingId } : { taskId }) },
      delivery: { mode: "webhook", url: "https://receiver.example/events", secret: "whsec_" + randomBytes(32).toString("base64") } };
    const makeService = () => createPublicMcpEvents(observed, oauth, async () => ({ id: taskId, companyId }), { enableDotRunner: dot,
      isBackgroundWorkEnabled: () => !draining && !standby,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (body.type === "verification") return Response.json({ challenge: body.challenge });
        received.push(body);
        const callback = duringDelivery; duringDelivery = undefined; await callback?.();
        return new Response(null, { status });
      },
    });
    service = makeService();
    const start = async () => {
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining && !standby, canReconcile: () => !standby, onError: error => errors.push(error) });
      await service.start(coordinator).ready;
      await settle();
    };
    const restart = async () => { await service.stop(); await coordinator.stop(); service = makeService(); await start(); };
    return { input, principal, start, restart, bindingId: bindingId!, agentId: agentId!, subscribe: () => service.subscribe(principal, input) };
  }
  async function settle() {
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
  }
  async function quiet(ms = 60_000) {
    await settle(); const baseline = [...calls], deliveries = received.length;
    await vi.advanceTimersByTimeAsync(ms);
    expect(calls).toEqual(baseline); expect(received).toHaveLength(deliveries);
  }
  async function activity(database = db, matching = true) {
    return logActivity(database, { companyId, actorType: "user", actorId: userId, entityType: "issue", entityId: taskId, action: matching ? "issue.updated" : "issue.unrelated", details: { status: "done", _previous: { status: "todo" } } });
  }
  async function delivered(count: number) { await vi.waitFor(() => expect(received).toHaveLength(count), { timeout: 8_000 }); await settle(); }

  it("is quiet empty, subscribed without events, and with delivered history", async () => {
    const f = await fixture(); await f.start(); await quiet();
    vi.setSystemTime(vi.getRealSystemTime());
    await f.subscribe(); await settle(); await quiet();
    await activity();
    await delivered(1); await quiet(600_000);
    expect(coordinator.nextWakeAt()).toBeNull(); expect(errors).toEqual([]);
  });

  it("waits for outer commit and rolls back nested producer notifications", async () => {
    const f = await fixture(); await f.subscribe(); await f.start();
    let release!: () => void, written!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { written = resolve; });
    const transaction = db.transaction(async tx => { await activity(tx as unknown as typeof db); written(); await gate; });
    await ready; await vi.advanceTimersByTimeAsync(500);
    expect(received).toEqual([]); expect(idleWorkSnapshot().active).toBeGreaterThan(0);
    release(); await transaction; await delivered(1);
    await expect(db.transaction(async tx => { await activity(tx as unknown as typeof db); throw new Error("rollback"); })).rejects.toThrow("rollback");
    await settle(); await quiet(); expect(received).toHaveLength(1);
  });

  it("retains first writes and failed sweeps through drain without passive SQL", async () => {
    const f = await fixture(); await f.subscribe(); await f.start();
    draining = true; await activity(); await settle(); await quiet(10_000); expect(received).toEqual([]);
    draining = false; await vi.advanceTimersByTimeAsync(2_000); await delivered(1);
    failRead = true; await activity(); await vi.waitFor(() => expect(errors).toHaveLength(1));
    draining = true; await vi.advanceTimersByTimeAsync(2_000); await settle(); await quiet(10_000);
    draining = false; await vi.advanceTimersByTimeAsync(2_000); await delivered(2); await quiet();
  });

  it("recovers startup during warm standby and drain", async () => {
    const f = await fixture(); await f.subscribe(); await activity();
    standby = true; const before = [...calls]; await f.start(); await vi.advanceTimersByTimeAsync(10_000); expect(calls).toEqual(before);
    standby = false; draining = true; await vi.advanceTimersByTimeAsync(2_000); await settle(); await quiet(10_000);
    draining = false; await vi.advanceTimersByTimeAsync(2_000); await delivered(1); await quiet();
  });

  it("restores retry and abandoned claim deadlines on restart", async () => {
    const f = await fixture(); await f.subscribe(); await f.start(); status = 503;
    await activity(); await delivered(1);
    const [pending] = await db.select().from(mcpEventDeliveries);
    expect(pending.finishedAt).toBeNull(); expect(pending.attempts).toBe(1);
    const claimAt = Date.now() + 30_000;
    await db.update(mcpEventDeliveries).set({ nextAttemptAt: new Date(claimAt) }).where(eq(mcpEventDeliveries.id, pending.id));
    await f.restart(); expect(coordinator.nextWakeAt()).toBe(claimAt);
    await quiet(20_000); status = 204; await vi.advanceTimersByTimeAsync(10_000); await delivered(2);
    expect((await db.select().from(mcpEventDeliveries))[0].outcome).toBe("delivered"); await quiet();
  });

  it("wakes on reenable and cancels retries when unsubscribed", async () => {
    const f = await fixture(); await f.subscribe(); await f.start();
    await instanceSettingsService(db).updateExperimental({ enablePublicMcp: false }); await settle();
    await activity(); await settle(); await quiet(); expect(received).toEqual([]);
    status = 503; await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true }); await delivered(1);
    await service.unsubscribe(f.principal, f.input); await settle(); await quiet(); expect(coordinator.nextWakeAt()).toBeNull();
  });

  it("drains more than 100 source rows and 20 deliveries without a new write", async () => {
    const f = await fixture(); await f.subscribe(); await f.start();
    await db.transaction(async tx => { for (let i = 0; i < 105; i++) await activity(tx as unknown as typeof db, i >= 80); });
    await delivered(25); expect(new Set(received.map(event => event.eventId)).size).toBe(25);
    expect(await db.select().from(mcpEventDeliveries)).toHaveLength(105); await quiet();
  });

  it("scans more than 20 subscriptions after a single committed event", async () => {
    const f = await fixture();
    for (let i = 0; i < 20; i++) await service.subscribe(f.principal, { ...f.input, delivery: { ...f.input.delivery, url: `https://receiver.example/${i}` } });
    const second = await fixture();
    for (let i = 0; i < 5; i++) await service.subscribe(second.principal, { ...second.input, delivery: { ...second.input.delivery, url: `https://receiver.example/second/${i}` } });
    await second.start(); await activity(); await delivered(25); await quiet();
  });

  it("scopes subscription refreshes and does not rescan sources on delivery retries", async () => {
    const first = await fixture(); const firstSubscription = await first.subscribe();
    const second = await fixture(); const secondSubscription = await second.subscribe(); await second.start();
    const untouched = new Date(0);
    await db.update(mcpEventSubscriptions).set({ scannedAt: untouched });
    await second.subscribe(); await settle();
    const subscriptions = await db.select().from(mcpEventSubscriptions);
    expect(subscriptions.find(s => s.id === firstSubscription.id)?.scannedAt).toEqual(untouched);
    expect(subscriptions.find(s => s.id === secondSubscription.id)?.scannedAt.getTime()).toBeGreaterThan(0);
    status = 503; await activity(); await delivered(2);
    await db.update(mcpEventSubscriptions).set({ scannedAt: untouched });
    status = 204; await vi.advanceTimersByTimeAsync(4_000); await delivered(4);
    expect((await db.select().from(mcpEventSubscriptions)).every(s => s.scannedAt.getTime() === 0)).toBe(true);
    await quiet();
  });

  it.each([false, true])("keeps tenant content wakes scoped with Dot=%s", async dot => {
    const first = await fixture(dot); const firstSubscription = await first.subscribe();
    const other = { companyId: randomUUID(), taskId: randomUUID() };
    await db.insert(companies).values({ id: other.companyId, name: "Other tenant", issuePrefix: "OTHER" });
    await db.insert(companyMemberships).values({ companyId: other.companyId, principalId: userId, principalType: "user", membershipRole: "owner", status: "active" });
    await db.insert(issues).values({ id: other.taskId, companyId: other.companyId, title: "Other task" });
    const second = await fixture(dot, other); const secondSubscription = await second.subscribe(); await second.start();
    if (dot) await delivered(2);
    await db.update(mcpEventSubscriptions).set({ scannedAt: new Date(0) });
    if (dot) await insertIssueComment(db, { companyId, issueId: taskId, authorUserId: userId, body: "Tenant-local comment" });
    else await activity();
    await vi.waitFor(async () => {
      const subscriptions = await db.select().from(mcpEventSubscriptions);
      expect(subscriptions.find(s => s.id === firstSubscription.id)?.scannedAt.getTime()).toBeGreaterThan(0);
      expect(subscriptions.find(s => s.id === secondSubscription.id)?.scannedAt.getTime()).toBe(0);
    });
    if (!dot) await delivered(1);
    await quiet();
  });

  it("keeps changes arriving during delivery and waits for in-flight shutdown", async () => {
    const f = await fixture(); await f.subscribe(); await f.start();
    duringDelivery = async () => { await activity(); };
    await activity(); await delivered(2);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    duringDelivery = async () => { entered(); await gate; };
    await activity(); await ready;
    let stopped = false; const stop = service.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); release(); await stop; await coordinator.stop();
    await quiet(); await f.restart(); await quiet(); expect(received).toHaveLength(3);
  });

  it("delivers automatic and explicit Dot challenges and becomes quiet after expiry", async () => {
    const f = await fixture(true); await f.start(); await f.subscribe(); await delivered(1);
    expect(received[0].data.kind).toBe("readiness_challenge");
    const [challenge] = await db.select().from(dotMailboxItems);
    await dotRunnerBroker(db).confirmChallenge(f.principal, String(challenge.references.challenge));
    await quiet(11 * 60_000);
    await dotRunnerBroker(db).challenge(companyId, f.agentId); await delivered(2); await quiet();
    expect(coordinator.nextWakeAt()).toBeNull();
  });

  it("scopes Dot reconnect scans to the binding and delivers to all its subscriptions", async () => {
    const f = await fixture(true); await f.subscribe(); await f.start(); await delivered(1);
    const [challenge] = await db.select().from(dotMailboxItems);
    await dotRunnerBroker(db).confirmChallenge(f.principal, String(challenge.references.challenge));
    await service.subscribe(f.principal, { ...f.input, delivery: { ...f.input.delivery, url: "https://receiver.example/second" } });
    await settle();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: f.agentId, invocationSource: "assignment", status: "queued" }).returning();
    await db.insert(dotRunnerAssignments).values({ companyId, agentId: f.agentId, bindingId: f.bindingId, bindingGeneration: 1,
      runId: run.id, normalizedSessionId: randomUUID(), turnId: randomUUID(), controllerGeneration: 1, catalogDigest: "test", status: "offered", projection: {},
      acceptBy: new Date(Date.now() + 600_000), expiresAt: new Date(Date.now() + 3600_000) });
    await quiet();
    await f.subscribe(); await delivered(3);
    expect(received.slice(1).map(event => event.data.kind)).toEqual(["assignment", "assignment"]);
    await quiet();
  });

  it("wakes for a native broker authority fence without another comment or subscription write", async () => {
    const f = await fixture(true); await f.subscribe(); await f.start(); await delivered(1);
    const broker = dotRunnerBroker(db);
    const [challenge] = await db.select().from(dotMailboxItems);
    await broker.confirmChallenge(f.principal, String(challenge.references.challenge));
    const snapshot = await broker.snapshot(companyId, f.agentId, f.bindingId);
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: f.agentId, invocationSource: "assignment", status: "queued", nativeIssueId: taskId }).returning();
    const [assignment] = await db.insert(dotRunnerAssignments).values({ companyId, agentId: f.agentId, bindingId: f.bindingId, bindingGeneration: 1,
      runId: run.id, normalizedSessionId: randomUUID(), turnId: randomUUID(), controllerGeneration: 1, catalogDigest: "test", status: "offered", projection: {},
      acceptBy: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 3600_000) }).returning();
    await quiet();
    const port = broker.port({ binding: { companyId, agentId: f.agentId, runId: run.id }, provider: { binding: snapshot } });
    await port.dispatch({ sourceEventId: randomUUID(), payload: { kind: "authority_revoked", binding: { ...snapshot, runId: run.id,
      normalizedSessionId: assignment.normalizedSessionId, turnId: assignment.turnId, assignmentRevision: assignment.revision } } });
    await delivered(2); expect(received[1].data.kind).toBe("authority_revoked"); await quiet();
  });

  it("discovers Dot follow-up comments through their committed insert", async () => {
    const f = await fixture(true); await f.subscribe(); await f.start(); await delivered(1);
    const [challenge] = await db.select().from(dotMailboxItems);
    await dotRunnerBroker(db).confirmChallenge(f.principal, String(challenge.references.challenge));
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: f.agentId, invocationSource: "on_demand", status: "running", nativeIssueId: taskId }).returning();
    await db.insert(dotRunnerAssignments).values({ companyId, agentId: f.agentId, bindingId: f.bindingId, bindingGeneration: 1, runId: run.id, normalizedSessionId: randomUUID(), turnId: randomUUID(), controllerGeneration: 1, catalogDigest: "test", status: "accepted", projection: {}, acceptBy: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 3600_000) });
    await quiet();
    await insertIssueComment(db, { companyId, issueId: taskId, authorUserId: userId, body: "Follow up" });
    await delivered(2); expect(received[1].data.kind).toBe("follow_up"); await quiet();
  });
});
