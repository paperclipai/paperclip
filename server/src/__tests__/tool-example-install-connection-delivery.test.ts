import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, connectionIntentDeliveries, createDb, databaseWorkPending, issueThreadInteractions,
  toolCatalogEntries, toolConnectionInstalls, toolProfileBindings } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const EXAMPLE = "safe-read-only-todo-kv";
const both = ["first", "repeat"] as const;
const writes = [
  ["upsertExampleApplication", "tool_applications", "insert or update", "new.metadata->>'source' = 'paperclip_example'", both],
  ["upsertExampleConnection", "tool_connections", "insert or update", "new.config->>'exampleId' is not null", both],
  ["catalog activation", "tool_catalog_entries", "update", "new.reviewed_at is distinct from old.reviewed_at", both],
  ["upsertExampleProfile", "tool_profiles", "insert or update", "new.metadata->>'source' = 'paperclip_example'", both],
  ["syncExampleProfileEntries delete", "tool_profile_entries", "delete", "old.conditions->>'source' = 'paperclip_example'", ["repeat"] as const],
  ["syncExampleProfileEntries insert", "tool_profile_entries", "insert", "new.conditions->>'source' = 'paperclip_example'", both],
  ["upsertExampleProfileBinding", "tool_profile_bindings", "insert or update", "new.metadata->>'source' = 'paperclip_example'", both],
] as const;
const gateKey = (name: string) => 7_310_000 + writes.findIndex(write => write[0] === name);

describePostgres("installExample writes notify the connection delivery worker", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-tool-example-connection-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.execute(sql.raw(`create function test_gate() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock_shared(tg_argv[0]::bigint); return coalesce(new, old); end $$`));
    for (const [name, table, events, when] of writes) {
      await db.execute(sql.raw(`create trigger test_gate_${gateKey(name)} before ${events} on ${table} for each row
        when (${when}) execute function test_gate(${gateKey(name)})`));
    }
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  const tools = (client: typeof db = db) => toolAccessService(client);
  const install = (companyId: string, client: typeof db = db) => tools(client).installExample(companyId, EXAMPLE);
  async function expectRetired(connectionId: string) {
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery!.wakeup).toHaveBeenCalledOnce();
  }
  async function expectNoDurableEffect() {
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  }
  async function seedExampleRequest(risk = "read") {
    const f = await seedPendingAccessRequest(db, "owner");
    const first = await install(f.companyId);
    const [entry] = await db.select().from(toolCatalogEntries)
      .where(and(eq(toolCatalogEntries.connectionId, first.connection.id), eq(toolCatalogEntries.riskLevel, risk)));
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: first.connection.id, targetType: "agent", targetId: f.agentId });
    await db.delete(toolProfileBindings).where(eq(toolProfileBindings.companyId, f.companyId));
    await db.update(issueThreadInteractions).set({ payload: { ...f.intent.payload, serviceSlug: `connection:${first.connection.id}`,
      accessRequest: { connectionId: first.connection.id, connectionName: first.connection.name,
        tools: [{ catalogEntryId: entry!.id, toolName: entry!.toolName, versionHash: entry!.versionHash, permission: "allowed" }] } } });
    return { ...f, connectionId: first.connection.id };
  }
  async function holdLock(statement: ReturnType<typeof sql>) {
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => { await tx.execute(statement); locked(); await gate; });
    await Promise.race([held, holder]);
    return { holder, release: async () => { release(); await holder; } };
  }
  const waitingOn = (pattern: string) => expect.poll(async () => (await db.execute(sql`select 1 from pg_stat_activity
    where wait_event_type = 'Lock' and query ilike ${pattern}`)).length, { timeout: 10_000 }).toBe(1);

  const holdGate = (name: string) => holdLock(sql`select pg_advisory_xact_lock(${gateKey(name)})`);

  it.each(writes.flatMap(([name, table, , , runs]) => runs.map(run => [name, run, table] as const)))(
    "%s on a %s install notifies inside its own open transaction before it writes", async (name, run, table) => {
      const f = await seedPendingAccessRequest(db, "owner");
      if (run === "repeat") await install(f.companyId);
      delivery = await startConnectionDelivery(db);
      const gate = await holdGate(name);
      const installing = install(f.companyId);
      try {
        await waitingOn(`%"${table}"%`);
        await expect.poll(() => idleWorkSnapshot().active === 1 && databaseWorkPending(db, DELIVERY_QUEUES.connection), { timeout: 5_000 }).toBe(true);
        const blocked = delivery.sweeps;
        await gate.release();
        await installing;
        await delivery.settle(blocked + 1);
      } finally { await gate.release(); await Promise.allSettled([installing]); }
      await expectNoDurableEffect();
    }, 30_000);

  it("retires through the binding's own commit after earlier sweeps drained", async () => {
    const f = await seedExampleRequest();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const gate = await holdGate("upsertExampleProfileBinding");
    const installing = install(f.companyId);
    try {
      await waitingOn(`%insert into "tool_profile_bindings"%`);
      await expect.poll(() => delivery!.sweeps > baseline && idleWorkSnapshot().active === 1, { timeout: 5_000 }).toBe(true);
      const drained = delivery.sweeps;
      delivery.wake();
      await expect.poll(() => delivery!.sweeps > drained && idleWorkSnapshot().active === 1, { timeout: 5_000 }).toBe(true);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      expect((await card()).status).toBe("pending");
      expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
      const beforeBinding = delivery.sweeps;
      await gate.release();
      await installing;
      await delivery.settle(beforeBinding + 1);
    } finally { await gate.release(); await Promise.allSettled([installing]); }
    await expectRetired(f.connectionId);
  }, 30_000);

  it("keeps the card pending with no durable effect when an outer transaction rolls back", async () => {
    const f = await seedExampleRequest();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await expect(db.transaction(async tx => {
      await install(f.companyId, tx as unknown as typeof db);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await delivery.settle(baseline + 1);
    await expectNoDurableEffect();
    expect(await db.select().from(toolProfileBindings)).toHaveLength(0);
  }, 30_000);

  it("publishes savepoint notifications only when the outer transaction commits", async () => {
    const f = await seedExampleRequest();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.transaction(async tx => {
      await install(f.companyId, tx as unknown as typeof db);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      expect(delivery!.sweeps).toBe(baseline);
      expect((await card()).status).toBe("pending");
    });
    await delivery.settle(baseline + 1);
    await expectRetired(f.connectionId);
  }, 30_000);

  it("reruns and retires once when duplicate installs commit while a sweep that already read the card is running", async () => {
    const f = await seedExampleRequest();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const barrier = await holdLock(sql`lock table connection_intent_deliveries in access exclusive mode`);
    try {
      delivery.wake();
      await waitingOn(`%"connection_intent_deliveries"%`);
      expect(delivery.sweeps).toBe(baseline + 1);
      await install(f.companyId);
      await install(f.companyId);
    } finally { await barrier.release(); }
    await delivery.settle(baseline + 2);
    await expectRetired(f.connectionId);
  }, 30_000);

  it("keeps a card for a tool outside the example profile pending", async () => {
    const f = await seedExampleRequest("write");
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await install(f.companyId);
    await delivery.settle(baseline + 1);
    await expectNoDurableEffect();
  }, 30_000);

  it("retires after admission reopens when the install committed during a drain", async () => {
    const f = await seedExampleRequest();
    let open = true;
    delivery = await startConnectionDelivery(db, { canRun: () => open });
    const baseline = delivery.sweeps;
    open = false;
    await install(f.companyId);
    expect(delivery.sweeps).toBe(baseline);
    expect((await card()).status).toBe("pending");
    open = true;
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectRetired(f.connectionId);
  }, 30_000);
});
