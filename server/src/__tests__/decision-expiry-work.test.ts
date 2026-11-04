import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, subscribeDatabaseWork, decisionBundles, decisionEffectExecutions, decisions,
  decisionTargetIssues, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { decisionService } from "../services/decisions.js";
import { registerDecisionExpiryWork } from "../services/decision-expiry-work.js";
import { registerDecisionContinuationWork } from "../services/decision-continuation-work.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_DECISION_EXPIRY_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("decision expiry worker", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let companyId: string, agentId: string, issueId: string, runId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let draining: boolean;
  const errors: unknown[] = [];
  const wake = vi.fn(async () => {});
  const service = () => decisionService(db, { wakeOriginAgent: wake });

  beforeAll(async () => {
    if (!externalUrl) temporary = await startEmbeddedPostgresTestDatabase("decision-expiry-");
    db = createDb(externalUrl ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);
  beforeEach(async () => {
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
    companyId = randomUUID(); agentId = randomUUID(); issueId = randomUUID(); runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Expiry", issuePrefix: `E${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Proposer", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Origin", status: "in_progress", priority: "medium", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    draining = false; errors.length = 0; wake.mockReset();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    await db.execute(sql`drop trigger if exists decision_expiry_fail on decisions`);
    await db.execute(sql`drop function if exists decision_expiry_fail()`);
    await db.execute(sql`drop trigger if exists decision_expiry_audit_fail on activity_log`);
    await db.execute(sql`drop function if exists decision_expiry_audit_fail()`);
    await db.delete(decisionEffectExecutions); await db.delete(decisionTargetIssues); await db.delete(decisions);
    await db.delete(decisionBundles); await db.delete(activityLog); await db.delete(heartbeatRuns);
    await db.delete(issues); await db.delete(agents); await db.delete(companies);
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  const actor = () => ({ type: "agent" as const, companyId, agentId, runId, source: "agent_jwt" as const });
  function input(expiresAt: Date) {
    return { companyId, agentId, runId, actor: actor(), title: "Decision", body: "Body", expiresAt,
      continuationPolicy: "wake_origin_agent" as const, options: [{ id: "yes", label: "Yes", effects: [] }] };
  }
  const create = (at = new Date(Date.now() + 120_000)) => service().create(input(at));
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining,
      canReconcile: () => true, onError: error => errors.push(error) });
    const continuation = service(), expiry = service();
    await registerDecisionContinuationWork(coordinator, continuation, () => !draining).ready;
    await registerDecisionExpiryWork(coordinator, expiry, () => !draining).ready;
    return { continuation, expiry };
  }
  async function quiet() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 5000 });
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "update"), executes = vi.spyOn(db, "execute");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); executes.mockRestore();
  }
  async function expired(id: string) {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await service().get(id)).toMatchObject({ status: "expired", metadata: { expiredReason: "ttl", continuationPending: false } });
    }, { timeout: 5000 });
  }

  it("is quiet when empty, arms the real producer deadline, and leaves expired history quiet", async () => {
    await start(); await quiet();
    const deadline = new Date(Date.now() + 120_000);
    const row = await create(deadline);
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(coordinator!.nextWakeAt()).toBe(deadline.getTime());
    });
    const reads = vi.spyOn(db, "select");
    await vi.advanceTimersByTimeAsync(Math.max(0, deadline.getTime() - Date.now() - 1000));
    expect(reads).not.toHaveBeenCalled(); reads.mockRestore(); expect(wake).not.toHaveBeenCalled();
    await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.expired"))).toHaveLength(1);
  });

  it.each(["single", "bundle"] as const)("arms expiry without waking continuation recovery for %s creation", async mode => {
    await start(); await quiet();
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.decisionContinuation, event => { events.push(event); });
    try {
      const deadline = new Date(Date.now() + 120_000);
      const row = mode === "single" ? await create(deadline) : (await service().createBundle({
        companyId, actor: actor(), agentId, runId, title: "Bundle", summary: "Summary", decisions: [input(deadline)],
      })).decisions[0];
      expect(events).toEqual([]);
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1);
        expect(coordinator!.nextWakeAt()).toBe(deadline.getTime());
      });
      expect(wake).not.toHaveBeenCalled();
      await service().cancel(row.id, { actorType: "agent", actorId: agentId });
      await quiet();
      expect(events).toEqual(["intent", "settled"]);
      expect(wake).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it("honors the configured expiry batch size", async () => {
    vi.stubEnv("PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE", "2");
    const seed = await create(); await db.delete(decisions).where(eq(decisions.id, seed.id));
    await db.insert(decisions).values(Array.from({ length: 5 }, () => ({ ...seed, id: randomUUID(), expiresAt: new Date(Date.now() - 1000) })));
    const recovery = service();
    expect(await recovery.sweepTtlExpiry()).toEqual({ expired: 2 });
    expect(await recovery.sweepTtlExpiry()).toEqual({ expired: 2 });
    expect(await recovery.sweepTtlExpiry()).toEqual({ expired: 1 });
    expect(wake).toHaveBeenCalledTimes(5);
  });

  it("continues a successful overdue backlog within one second instead of waiting for error retry", async () => {
    const seed = await create(); await db.delete(decisions).where(eq(decisions.id, seed.id));
    await db.insert(decisions).values(Array.from({ length: 101 }, () => ({ ...seed, id: randomUUID(), expiresAt: new Date(Date.now() - 1000) })));
    await start();
    expect(wake).toHaveBeenCalledTimes(100);
    const next = coordinator!.nextWakeAt();
    expect(next).not.toBeNull();
    expect(next! - Date.now()).toBeLessThanOrEqual(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(101));
    await quiet();
  });

  it("rolls expiry back if its durable activity cannot be recorded", async () => {
    const row = await create();
    await db.update(decisions).set({ expiresAt: new Date(Date.now() - 1000), metadata: { ...row.metadata, retained: "unchanged" } }).where(eq(decisions.id, row.id));
    await db.execute(sql`create function decision_expiry_audit_fail() returns trigger language plpgsql as $$ begin
      raise exception 'expiry audit unavailable'; end $$`);
    await db.execute(sql`create trigger decision_expiry_audit_fail before insert on activity_log
      for each row when (NEW.action = 'decision.expired') execute function decision_expiry_audit_fail()`);
    await expect(service().sweepTtlExpiry()).rejects.toMatchObject({ cause: { message: "expiry audit unavailable" } });
    expect(await service().get(row.id)).toMatchObject({ status: "open", metadata: { retained: "unchanged" } });
    expect(wake).not.toHaveBeenCalled();
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.expired"))).toEqual([]);
    await db.execute(sql`drop trigger decision_expiry_audit_fail on activity_log`);
    expect(await service().sweepTtlExpiry()).toEqual({ expired: 1 });
    expect(await service().get(row.id)).toMatchObject({ status: "expired", metadata: { retained: "unchanged" } });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.expired"))).toHaveLength(1);
  });

  it("reconstructs a future expiry on restart and does not expire it early", async () => {
    const row = await create(); const { expiry } = await start();
    await vi.waitFor(async () => {
      expect(await expiry.nextExpiryAt()).toBe(row.expiresAt.getTime());
      // Another queue may reconcile sooner than this decision's expiry.
      const next = coordinator!.nextWakeAt();
      expect(next).not.toBeNull();
      expect(next!).toBeGreaterThan(Date.now());
      expect(next!).toBeLessThanOrEqual(row.expiresAt.getTime());
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await service().get(row.id))?.status).toBe("open");
    await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("expires at the exact saved timestamp", async () => {
    const row = await create();
    expect(await service().sweepTtlExpiry(new Date(row.expiresAt.getTime() - 1))).toEqual({ expired: 0 });
    expect(await service().sweepTtlExpiry(row.expiresAt)).toEqual({ expired: 1 });
    expect((await service().get(row.id))?.status).toBe("expired"); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("replaces a later deadline when another decision is created and removes it after cancellation", async () => {
    const later = await create(new Date(Date.now() + 600_000)); await start();
    const earlier = await create();
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(30_000); expect(coordinator!.nextWakeAt()).toBe(earlier.expiresAt.getTime()); });
    await service().cancel(earlier.id, { actorType: "agent", actorId: agentId });
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(30_000); expect(coordinator!.nextWakeAt()).toBe(later.expiresAt.getTime()); });
    await service().cancel(later.id, { actorType: "agent", actorId: agentId });
    await quiet(); expect(wake).toHaveBeenCalledTimes(2);
  });

  it("registers bundle creation inside its existing transaction", async () => {
    await start(); await quiet(); const at = new Date(Date.now() + 120_000);
    const bundle = await service().createBundle({ companyId, actor: actor(), agentId, runId, title: "Bundle", summary: "Summary",
      decisions: [input(at), input(at)] });
    await expired(bundle.decisions[0].id); await expired(bundle.decisions[1].id); await quiet();
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("does not publish an outer rollback and learns an outer commit", async () => {
    await start(); await quiet();
    await expect(db.transaction(async tx => {
      await service().create(input(new Date(Date.now() + 30_000)), tx as unknown as typeof db);
      await vi.advanceTimersByTimeAsync(60_000); expect(wake).not.toHaveBeenCalled(); throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await quiet(); expect(await db.select().from(decisions)).toHaveLength(0);
    let id = "";
    await db.transaction(async tx => {
      id = (await service().create(input(new Date(Date.now() + 30_000)), tx as unknown as typeof db)).id;
      await vi.advanceTimersByTimeAsync(60_000); expect(wake).not.toHaveBeenCalled();
    });
    await expired(id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("retains first creation during drain without SQL until resume", async () => {
    await start(); await quiet(); draining = true;
    const row = await create(new Date(Date.now() + 30_000));
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).not.toHaveBeenCalled(); reads.mockRestore(); expect(wake).not.toHaveBeenCalled();
    draining = false; await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed expiry retry through drain and preserves pending state", async () => {
    const row = await create(new Date(Date.now() + 30_000)); const workers = await start();
    const sweeps = [vi.spyOn(workers.expiry, "sweepTtlExpiry"), vi.spyOn(workers.continuation, "sweepContinuations")];
    await db.execute(sql`create function decision_expiry_fail() returns trigger language plpgsql as $$ begin
      if NEW.status = 'expired' then raise exception 'expiry unavailable'; end if; return NEW; end $$`);
    await db.execute(sql`create trigger decision_expiry_fail before update on decisions for each row execute function decision_expiry_fail()`);
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(30_000); expect(errors.length).toBeGreaterThan(0); });
    draining = true; expect((await service().get(row.id))?.status).toBe("open");
    await Promise.allSettled(sweeps.flatMap(sweep => sweep.mock.results.filter(result => result.type === "return").map(result => result.value)));
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    await db.execute(sql`drop trigger decision_expiry_fail on decisions`);
    draining = false; await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
    for (const error of errors) expect(error).toMatchObject({ cause: { message: "expiry unavailable" } }); errors.length = 0;
  });

  it("leaves failed continuation delivery to its separate retry owner", async () => {
    const row = await create(new Date(Date.now() + 30_000)); await start();
    wake.mockRejectedValueOnce(new Error("wake unavailable"));
    await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(2);
    expect(errors.every(error => String(error).includes("wake unavailable"))).toBe(true); errors.length = 0;
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.expired"))).toHaveLength(1);
  });

  it("does not deliver terminal continuation debt from the TTL-only pass", async () => {
    const row = await create();
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issueId));
    await db.update(decisions).set({ status: "cancelled", metadata: { continuationPending: true } }).where(eq(decisions.id, row.id));
    expect(await service().sweepTtlExpiry()).toEqual({ expired: 0 });
    expect(wake).not.toHaveBeenCalled(); expect(await service().nextExpiryAt()).toBeNull();
  });

  it("does not recover stale running effects during TTL expiry", async () => {
    const row = await create();
    await db.update(decisions).set({ status: "decided", executionStatus: "running", chosenOptionId: "yes",
      decidedByUserId: null, updatedAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 1000) })
      .where(eq(decisions.id, row.id));
    expect(await service().sweepTtlExpiry()).toEqual({ expired: 0 });
    expect(await service().get(row.id)).toMatchObject({ status: "decided", executionStatus: "running" });
    expect(wake).not.toHaveBeenCalled();
    expect(await service().nextExpiryAt()).toBeNull();
  });

  it("pages past a failed candidate and retries it without repeating completed expirations", async () => {
    const seed = await create(); await db.delete(decisions).where(eq(decisions.id, seed.id));
    const ids = Array.from({ length: 101 }, (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await db.insert(decisions).values(ids.map(id => ({ ...seed, id, expiresAt: new Date(Date.now() - 1000) })));
    await db.execute(sql`create function decision_expiry_fail() returns trigger language plpgsql as $$ begin
      if NEW.id = '10000000-0000-4000-8000-000000000000' and NEW.status = 'expired' then raise exception 'expiry unavailable'; end if;
      return NEW; end $$`);
    await db.execute(sql`create trigger decision_expiry_fail before update on decisions for each row execute function decision_expiry_fail()`);
    const recovery = service();
    await expect(recovery.sweepTtlExpiry()).rejects.toMatchObject({ cause: { message: "expiry unavailable" } });
    expect(wake).toHaveBeenCalledTimes(99);
    expect((await service().get(ids.at(-1)!))?.status).toBe("open");
    expect(await recovery.sweepTtlExpiry()).toEqual({ expired: 1 });
    expect((await service().get(ids.at(-1)!))?.status).toBe("expired");
    expect((await service().get(ids[0]))?.status).toBe("open"); expect(wake).toHaveBeenCalledTimes(100);
    await db.execute(sql`drop trigger decision_expiry_fail on decisions`);
    await start(); await quiet(); expect((await service().get(ids[0]))?.status).toBe("expired");
    expect(wake).toHaveBeenCalledTimes(101);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.expired"))).toHaveLength(101);
  });

  it("learns another expiry created during delivery", async () => {
    const first = await create(new Date(Date.now() + 30_000));
    let secondId = "";
    wake.mockImplementationOnce(async () => { secondId = (await create(new Date(Date.now() + 90_000))).id; });
    await start(); await expired(first.id);
    await vi.waitFor(() => expect(secondId).not.toBe(""));
    await expired(secondId); await quiet(); expect(wake).toHaveBeenCalledTimes(2);
  });


  it("finishes an admitted expiry but leaves the next candidate for restart during shutdown", async () => {
    const first = await create(), second = await create();
    await db.update(decisions).set({ expiresAt: new Date(Date.now() - 1000) });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    wake.mockImplementationOnce(async () => gate);
    const starting = start();
    let stopped = false;
    let stopping: Promise<void>;
    try {
      await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
      stopping = coordinator!.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(60_000); expect(stopped).toBe(false);
    } finally { release(); }
    await starting; await stopping!; coordinator = undefined;
    expect(wake).toHaveBeenCalledTimes(1); expect(stopped).toBe(true);
    const states = await Promise.all([service().get(first.id), service().get(second.id)]);
    expect(states.map(row => row!.status).sort()).toEqual(["expired", "open"]);
    await start(); await quiet(); expect(wake).toHaveBeenCalledTimes(2);
  });


  it("pages past a full failed batch using database timestamp precision", async () => {
    const seed = await create(); await db.delete(decisions).where(eq(decisions.id, seed.id));
    const ids = Array.from({ length: 101 }, (_, i) => `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await db.insert(decisions).values(ids.map(id => ({ ...seed, id })));
    await db.execute(sql`update decisions set expires_at = date_trunc('milliseconds', now() - interval '1 minute') + interval '456 microseconds'`);
    await db.execute(sql`create function decision_expiry_fail() returns trigger language plpgsql as $$ begin
      if NEW.id <> '20000000-0000-4000-8000-000000000100' and NEW.status = 'expired' then raise exception 'expiry unavailable'; end if;
      return NEW; end $$`);
    await db.execute(sql`create trigger decision_expiry_fail before update on decisions for each row execute function decision_expiry_fail()`);
    const recovery = service();
    await expect(recovery.sweepTtlExpiry()).rejects.toThrow("Decision expiry failed");
    expect(await recovery.sweepTtlExpiry()).toEqual({ expired: 1 });
    expect((await service().get(ids.at(-1)!))?.status).toBe("expired");
    await db.execute(sql`drop trigger decision_expiry_fail on decisions`);
    expect(await recovery.sweepTtlExpiry()).toEqual({ expired: 100 });
    expect(await recovery.sweepTtlExpiry()).toEqual({ expired: 0 });
    expect(wake).toHaveBeenCalledTimes(101);
  });

});
