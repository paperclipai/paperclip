import { randomUUID } from "node:crypto";
import { agents, companies, createDb, applyPendingMigrations, closeRegisteredClients, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../../../services/agent-lifecycle.js";
import { createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { requestAgentLifecycleRecheckInTransaction, startAgentLifecycle } from "../index.js";
import { createLifecycleStore } from "../adapters/postgres.js";
import { createLifecycleWorker } from "../application/worker.js";
import type { LifecycleAgent } from "../application/ports.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../../services/delivery-work-notifications.js";
import { resolveExternalTestDatabaseUrl } from "../../../__tests__/helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_LIFECYCLE_VERIFICATION_RETRY_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("failed lifecycle verification retries", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  const workers: Array<{ stop(): Promise<void> }> = [];
  beforeAll(async () => {
    if (external) { await applyPendingMigrations(external); db = createDb(external, { maxConnections: 4 }); }
    else { database = await startEmbeddedPostgresTestDatabase("paperclip-verification-retry-"); db = createDb(database.connectionString, { maxConnections: 4 }); }
  }, 90_000);
  afterAll(async () => { if (external) await closeRegisteredClients(external); else await database?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Verification retry", issuePrefix: `V${companyId.slice(0, 7)}` });
  });
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop();
    // Retire only this test's synthetic records so later coordinator reads stay isolated.
    await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.companyId, companyId));
  });
  const current = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  async function failed(code = "harness_test_failed") {
    const runHost = vi.fn(async (agent: LifecycleAgent) => {
      if (agent.lifecycleState === "verifying") throw Object.assign(new Error("private provider detail"), { code });
      return "complete" as const;
    });
    const driver = { requiredPluginIds: async () => [], runHost, runPlugin: async () => "complete" as const };
    const work = configureAgentLifecycle(db, driver); workers.push(work);
    const agent = await createAgentLifecycle(db).requestHire(companyId, { name: "Retry fixture", adapterType: "process", adapterConfig: { command: "missing-command" } });
    await work.process(agent.id);
    if (code === "harness_test_failed") {
      for (let retry = 0; retry < 2; retry++) {
        expect((await current(agent.id)).lifecycleOperation?.retryRequired).toBeUndefined();
        await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` }).where(eq(agents.id, agent.id));
        await work.process(agent.id);
      }
    }
    return { agent: await current(agent.id), work, driver, runHost };
  }

  it("persists a failed test across worker restarts without scanning, claiming, or probing it again", async () => {
    const { agent, work, driver, runHost } = await failed();
    expect(agent).toMatchObject({ lifecycleState: "verifying", status: "paused", lifecycleOperation: { retryRequired: true } });
    expect(agent.lifecycleOperation).not.toHaveProperty("retryAt");
    expect(agent.lifecycleOperation).not.toHaveProperty("leaseOwner");
    expect(agent.lifecycleError).toContain("Automatic verification is paused");
    expect(agent.lifecycleError).not.toContain("private provider detail");
    await work.stop();
    const restarted = startAgentLifecycle(db, createAgentLifecycleEffects(), driver, () => true); workers.push(restarted);
    const calls = runHost.mock.calls.length;
    expect(await restarted.hasPending()).toBe(false);
    expect(restarted.nextRunAt()).toBeNull();
    await restarted.sweep();
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(await store.pending(100, tomorrow)).not.toContain(agent.id);
    expect(await store.claim(agent.id, "new-owner", tomorrow)).toBeNull();
    await work.process(agent.id);
    expect(runHost).toHaveBeenCalledTimes(calls);
    expect((await current(agent.id)).lifecycleOperation).toEqual(agent.lifecycleOperation);
  });

  it("permits an explicit retry of the same operation and completes verification before readiness", async () => {
    const { agent, work, runHost } = await failed();
    let release!: () => void;
    const verification = new Promise<void>(resolve => { release = resolve; });
    runHost.mockImplementation(async () => { await verification; return "complete"; });
    let processing: Promise<void> | undefined;
    try {
      await createAgentLifecycle(db).retry(agent.id);
      processing = work.process(agent.id);
      const retried = await current(agent.id);
      expect(retried).toMatchObject({ lifecycleState: "verifying", status: "paused" });
      expect(retried.lifecycleOperation).not.toHaveProperty("retryRequired");
      expect(retried.lifecycleOperation).not.toHaveProperty("verificationFailures");
      expect(retried.lifecycleOperation!.id).toBe(agent.lifecycleOperation!.id);
    } finally {
      release();
      await processing;
    }
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "ready", status: "idle", lifecycleError: null });
  });

  it("does not spend verification retries on claims deferred before the host test", async () => {
    const [agent] = await db.insert(agents).values({ companyId, name: "Deferred verification", status: "paused",
      lifecycleState: "verifying", lifecycleRequiredPluginIds: [],
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0 } }).returning();
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    let allowed = true;
    let deferBeforeHost = true;
    const runHost = vi.fn(async () => { throw Object.assign(new Error("test failed"), { code: "harness_test_failed" }); });
    const work = createLifecycleWorker({ ...store, async claim(...args) {
      const claimed = await store.claim(...args);
      if (claimed && deferBeforeHost) allowed = false;
      return claimed;
    } }, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost }, () => {}, () => allowed);
    workers.push(work);
    const due = async () => {
      allowed = true;
      await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` }).where(eq(agents.id, agent.id));
      await work.process(agent.id);
    };
    await due(); await due();
    expect(runHost).not.toHaveBeenCalled();
    expect((await current(agent.id)).lifecycleOperation).toMatchObject({ attempts: 2 });
    expect((await current(agent.id)).lifecycleOperation).not.toHaveProperty("verificationFailures");
    deferBeforeHost = false;
    await due();
    expect((await current(agent.id)).lifecycleOperation).toMatchObject({ attempts: 3, verificationFailures: 1 });
    expect((await current(agent.id)).lifecycleOperation?.retryRequired).toBeUndefined();
    // Another deferred claim preserves the already recorded failed test.
    deferBeforeHost = true; await due();
    expect((await current(agent.id)).lifecycleOperation?.verificationFailures).toBe(1);
    deferBeforeHost = false;
    await due();
    expect((await current(agent.id)).lifecycleOperation?.retryRequired).toBeUndefined();
    await due();
    expect(runHost).toHaveBeenCalledTimes(3);
    expect((await current(agent.id)).lifecycleOperation).toMatchObject({ verificationFailures: 3, retryRequired: true });
  });

  it("keeps checking an outdated remote Runner past the failure budget and becomes ready once it matches", async () => {
    const { agent, work, runHost } = await failed("runner_revision_mismatch");
    for (let check = 0; check < 5; check++) {
      const waiting = await current(agent.id);
      expect(waiting).toMatchObject({ lifecycleState: "verifying", status: "paused" });
      expect(waiting.lifecycleOperation?.retryRequired).toBeUndefined();
      expect(waiting.lifecycleOperation?.verificationFailures).toBeUndefined();
      expect(waiting.lifecycleOperation?.retryAt).toEqual(expect.any(String));
      expect(waiting.lifecycleError).toContain("Runner is being updated");
      expect(waiting.lifecycleError).not.toContain("Automatic verification is paused");
      await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` }).where(eq(agents.id, agent.id));
      await work.process(agent.id);
    }
    runHost.mockImplementation(async () => "complete");
    await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` }).where(eq(agents.id, agent.id));
    await work.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "ready", status: "idle", lifecycleError: null });
  });

  it("recovers from a generic failed test before the automatic retry budget is exhausted", async () => {
    const { agent, work, runHost } = await failed("harness_probe_timed_out");
    runHost.mockRejectedValueOnce(Object.assign(new Error("temporary test failure"), { code: "harness_test_failed" }));
    await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` }).where(eq(agents.id, agent.id));
    await work.process(agent.id);
    expect((await current(agent.id)).lifecycleOperation?.retryRequired).toBeUndefined();
    runHost.mockResolvedValue("complete");
    await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` }).where(eq(agents.id, agent.id));
    await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("ready");
  });

  it("rechecks changed execution configuration but leaves a name edit waiting", async () => {
    const { agent, work, runHost } = await failed();
    const lifecycle = createAgentLifecycle(db);
    await lifecycle.updateConfiguration(agent.id, { name: "Renamed fixture" });
    expect((await current(agent.id)).lifecycleOperation!.retryRequired).toBe(true);
    runHost.mockResolvedValue("complete");
    await lifecycle.updateConfiguration(agent.id, { adapterConfig: { command: process.execPath } });
    const changed = await current(agent.id);
    expect(changed.lifecycleOperation).not.toHaveProperty("retryRequired");
    expect(changed.lifecycleOperation).not.toHaveProperty("verificationFailures");
    expect(changed.lifecycleOperation!.id).not.toBe(agent.lifecycleOperation!.id);
    await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("ready");
  });

  it("does not let a stale verification failure park newly saved configuration", async () => {
    const { agent, work } = await failed("harness_auth_failed");
    await work.stop();
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    await store.change(agent.id, "retry");
    const claimed = await store.claim(agent.id, "old-verification", new Date());
    expect(claimed).not.toBeNull();
    await createAgentLifecycle(db).updateConfiguration(agent.id, { adapterConfig: { command: process.execPath } });
    expect(await store.defer(claimed!, "old-verification", "Old failure", new Date(), { retryRequired: true })).toBe(false);
    expect((await current(agent.id)).lifecycleOperation?.retryRequired).toBeUndefined();
  });

  it.each(["harness_probe_timed_out", "test_environment_unavailable", "ECONNRESET", "unclassified"])("keeps automatic recovery for %s", async code => {
    const { agent } = await failed(code);
    expect(agent.lifecycleOperation).not.toHaveProperty("retryRequired");
    expect(Date.parse(agent.lifecycleOperation!.retryAt!)).toBeGreaterThan(Date.now());
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    expect(await store.pending(100, new Date(Date.now() + 120_000))).toContain(agent.id);
    expect(await store.claim(agent.id, "automatic-retry", new Date(Date.now() + 120_000))).not.toBeNull();
  });

  it("still completes termination and cleanup when verification needs repair", async () => {
    const { agent, work, runHost } = await failed();
    runHost.mockResolvedValue("complete");
    await createAgentLifecycle(db).terminateAgent(agent.id);
    await work.process(agent.id);
    expect((await current(agent.id)).lifecycleState).toBe("terminated");
    expect(runHost.mock.calls.map(([a]) => a.lifecycleState)).toContain("cleaning_up");
  });

  async function eventWaitFixture() {
    let complete = false;
    const runHost = vi.fn(async (agent: LifecycleAgent) => agent.lifecycleState !== "verifying" || complete
      ? "complete" as const : "waiting" as const);
    const driver = { requiredPluginIds: async () => [], runPlugin: async () => "complete" as const, runHost };
    const work = configureAgentLifecycle(db, driver); workers.push(work);
    const agent = await createAgentLifecycle(db).requestHire(companyId, { name: "External reply wait", adapterType: "process" });
    await work.process(agent.id);
    return { agent: await current(agent.id), work, driver, runHost, complete: () => { complete = true; } };
  }
  function recheck(tx: Pick<Db, "select" | "update">, id: string, scopeCompanyId = companyId, version?: number) {
    return requestAgentLifecycleRecheckInTransaction(tx,
      { companyId: scopeCompanyId, agentId: id, expectedVersion: version },
      () => notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle));
  }

  it("parks healthy external verification without a retry deadline, claim or readiness bypass", async () => {
    const { agent, work, runHost } = await eventWaitFixture();
    expect(agent).toMatchObject({ lifecycleState: "verifying", status: "paused", lifecycleError: null,
      lifecycleOperation: { waitingForSignal: true, hostComplete: false } });
    expect(agent.lifecycleOperation).not.toHaveProperty("retryAt");
    expect(agent.lifecycleOperation).not.toHaveProperty("retryRequired");
    expect(agent.lifecycleOperation).not.toHaveProperty("leaseOwner");
    const store = createLifecycleStore(db, createAgentLifecycleEffects()), calls = runHost.mock.calls.length;
    const later = new Date(Date.now() + 86_400_000);
    expect(await store.pending(100, later)).not.toContain(agent.id);
    expect(await store.claim(agent.id, "unnotified", later)).toBeNull();
    await work.process(agent.id);
    expect(runHost).toHaveBeenCalledTimes(calls);
    expect((await current(agent.id)).lifecycleState).toBe("verifying");
  });

  it.each(["during", "after"] as const)("retains a committed recheck %s the active attempt parks", async ordering => {
    let entered!: () => void, release!: () => void, ready = false;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const runHost = vi.fn(async (agent: LifecycleAgent) => {
      if (agent.lifecycleState !== "verifying" || ready) return "complete" as const;
      entered(); await hold; return "waiting" as const;
    });
    const work = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost });
    workers.push(work);
    const agent = await createAgentLifecycle(db).requestHire(companyId, { name: "Commit race", adapterType: "process" });
    const processing = work.process(agent.id);
    await inside;
    try {
      if (ordering === "after") { release(); await processing; }
      await db.transaction(async tx => {
        expect(await recheck(tx, agent.id)).toBe(true);
      });
      ready = true;
    } finally { release(); await processing; }
    const signalled = await current(agent.id);
    expect(signalled.lifecycleOperation?.waitingForSignal).not.toBe(true);
    expect(signalled.lifecycleOperation).not.toHaveProperty("retryAt");
    await work.process(agent.id);
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "ready", status: "idle" });
    expect(runHost.mock.calls.filter(([a]) => a.lifecycleState === "verifying")).toHaveLength(2);
  });

  it("rolls back the recheck with its producer and coalesces redundant committed signals", async () => {
    const { agent, work, complete, runHost } = await eventWaitFixture();
    await expect(db.transaction(async tx => {
      expect(await recheck(tx, agent.id)).toBe(true);
      throw new Error("Rollback this producer");
    })).rejects.toThrow("Rollback this producer");
    expect((await current(agent.id)).lifecycleOperation?.waitingForSignal).toBe(true);
    await db.transaction(async tx => {
      expect(await recheck(tx, agent.id)).toBe(true);
      expect(await recheck(tx, agent.id)).toBe(true);
    });
    complete(); await work.process(agent.id);
    const calls = runHost.mock.calls.length;
    await work.process(agent.id);
    expect(runHost).toHaveBeenCalledTimes(calls);
    expect((await current(agent.id)).lifecycleState).toBe("ready");
  });

  it("finishes a committed recheck on a new owner without a post-commit scheduling call", async () => {
    const { agent, work, driver, complete } = await eventWaitFixture();
    await work.stop();
    await db.transaction(async tx => { expect(await recheck(tx, agent.id)).toBe(true); });
    complete();
    // No process/Retry/wake callback follows the committed producer here.
    const restarted = startAgentLifecycle(db, createAgentLifecycleEffects(), driver, () => true); workers.push(restarted);
    await restarted.sweep();
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "ready", status: "idle" });
    expect(await restarted.hasPending()).toBe(false);
  });

  it("rechecks a saved wait once at startup and remains parked without recurring startup scans", async () => {
    const { agent, work, driver, runHost } = await eventWaitFixture();
    await work.stop();
    const restarted = startAgentLifecycle(db, createAgentLifecycleEffects(), driver, () => true); workers.push(restarted);
    const calls = runHost.mock.calls.length;
    expect(await restarted.hasPending()).toBe(true);
    await restarted.sweep();
    expect(runHost).toHaveBeenCalledTimes(calls + 1);
    expect((await current(agent.id)).lifecycleOperation?.waitingForSignal).toBe(true);
    expect(await restarted.hasPending()).toBe(false);
    expect(restarted.nextRunAt()).toBeNull();
    await restarted.sweep();
    expect(runHost).toHaveBeenCalledTimes(calls + 1);
  });

  it("does not rearm a parked wait after a company or version mismatch, pause or required manual repair", async () => {
    const { agent, work } = await eventWaitFixture();
    await db.transaction(async tx => {
      expect(await recheck(tx, agent.id, randomUUID())).toBe(false);
      expect(await recheck(tx, agent.id, companyId, agent.lifecycleVersion - 1)).toBe(false);
    });
    expect((await current(agent.id)).lifecycleOperation).toEqual(agent.lifecycleOperation);
    await createAgentLifecycle(db).pauseAgent(agent.id);
    await work.process(agent.id);
    await db.transaction(async tx => { expect(await recheck(tx, agent.id)).toBe(false); });
    expect(await current(agent.id)).toMatchObject({ lifecycleState: "paused", status: "paused" });
    const manual = await failed();
    await db.transaction(async tx => { expect(await recheck(tx, manual.agent.id)).toBe(false); });
    expect((await current(manual.agent.id)).lifecycleOperation?.retryRequired).toBe(true);
  });
});
