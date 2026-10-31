import { eq, sql } from "drizzle-orm";
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
/** Each write's own rows pass a trigger that waits on that write's advisory key. */
const writes = [
  ["upsertExampleApplication", "tool_applications", "insert or update", "new.metadata->>'source' = 'paperclip_example'"],
  ["upsertExampleConnection", "tool_connections", "insert or update", "new.config->>'exampleId' is not null"],
  ["catalog activation", "tool_catalog_entries", "update", "new.reviewed_at is distinct from old.reviewed_at"],
  ["upsertExampleProfile", "tool_profiles", "insert or update", "new.metadata->>'source' = 'paperclip_example'"],
  ["syncExampleProfileEntries", "tool_profile_entries", "insert", "new.conditions->>'source' = 'paperclip_example'"],
  ["upsertExampleProfileBinding", "tool_profile_bindings", "insert or update", "new.metadata->>'source' = 'paperclip_example'"],
] as const;
const gateKey = (table: string) => 7_310_000 + writes.findIndex(write => write[1] === table);

describePostgres("installExample writes notify the connection delivery worker", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-tool-example-connection-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.execute(sql.raw(`create function test_gate() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock_shared(tg_argv[0]::bigint); return new; end $$`));
    for (const [, table, events, when] of writes) {
      await db.execute(sql.raw(`create trigger test_gate before ${events} on ${table} for each row
        when (${when}) execute function test_gate(${gateKey(table)})`));
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
  /** Install once, then point the card at the example's read tool so only a new company binding satisfies it. */
  async function seedExampleRequest() {
    const f = await seedPendingAccessRequest(db, "owner");
    const first = await install(f.companyId);
    const [entry] = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.id, first.profileEntries[0]!.catalogEntryId!));
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: first.connection.id, targetType: "agent", targetId: f.agentId });
    await db.delete(toolProfileBindings).where(eq(toolProfileBindings.companyId, f.companyId));
    await db.update(issueThreadInteractions).set({ payload: { ...f.intent.payload, serviceSlug: `connection:${first.connection.id}`,
      accessRequest: { connectionId: first.connection.id, connectionName: first.connection.name,
        tools: [{ catalogEntryId: entry!.id, toolName: entry!.toolName, versionHash: entry!.versionHash, permission: "allowed" }] } } });
    return { ...f, connectionId: first.connection.id };
  }
  /** Hold a lock in another session; always release it and await the holder. */
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

  const holdGate = (table: string) => holdLock(sql`select pg_advisory_xact_lock(${gateKey(table)})`);

  it.each(writes.flatMap(([name, table]) => (["first", "repeat"] as const).map(install => [name, install, table] as const)))(
    "%s on a %s install notifies inside its own open transaction before it writes", async (_name, path, table) => {
      const f = await seedPendingAccessRequest(db, "owner");
      if (path === "repeat") await install(f.companyId);
      delivery = await startConnectionDelivery(db);
      const gate = await holdGate(table);
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
    const gate = await holdGate("tool_profile_bindings");
    const installing = install(f.companyId);
    try {
      await waitingOn(`%insert into "tool_profile_bindings"%`);
      await expect.poll(() => delivery!.sweeps > baseline && idleWorkSnapshot().active === 1, { timeout: 5_000 }).toBe(true);
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
    });
    await delivery.settle(baseline + 1);
    await expectRetired(f.connectionId);
  }, 30_000);

  it("retires once through duplicate installs", async () => {
    const f = await seedExampleRequest();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await install(f.companyId);
    await install(f.companyId);
    await delivery.settle(baseline + 1);
    await expectRetired(f.connectionId);
  }, 30_000);
});
