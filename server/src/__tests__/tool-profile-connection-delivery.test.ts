import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, connectionIntentDeliveries, createDb, databaseWorkPending, issueThreadInteractions, toolCatalogEntries, toolProfileBindings,
  toolProfileEntries, toolProfiles } from "@paperclipai/db";
import { grantConnectionAgentTools } from "../services/connection-agent-access.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { toolAccessService } from "../services/tool-access.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Fixture = Awaited<ReturnType<typeof seedPendingAccessRequest>>;

describePostgres("tool profile writes notify the connection delivery worker", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-profile-connection-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  const svc = () => toolAccessService(db);
  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  const reads = async () => (await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, "reads")))[0]!;
  const setReads = (values: Partial<typeof toolProfiles.$inferInsert>) => db.update(toolProfiles).set(values).where(eq(toolProfiles.profileKey, "reads"));
  const entry = (f: Fixture, profileId: string, effect: "include" | "exclude") => db.insert(toolProfileEntries)
    .values({ companyId: f.companyId, profileId, selectorType: "catalog_entry", effect, catalogEntryId: f.tool.id, connectionId: f.connection.id }).returning().then(rows => rows[0]!);
  const include = (f: Fixture) => ({ selectorType: "catalog_entry" as const, catalogEntryId: f.tool.id, connectionId: f.connection.id });
  const expectRetired = async (f: Fixture) => {
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId: f.connection.id }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery!.wakeup).toHaveBeenCalledOnce();
  };

  it.each([
    ["addProfileEntry", async (f: Fixture) => { const p = await reads(); return () => svc().addProfileEntry(p.id, include(f)); }],
    ["updateProfile", async () => { const p = await reads(); return () => svc().updateProfile(p.id, { defaultAction: "allow" }); }],
    ["updateProfileEntry", async (f: Fixture) => { const e = await entry(f, (await reads()).id, "exclude"); return () => svc().updateProfileEntry(e.id, { effect: "include" }); }],
    ["deleteProfileEntry", async (f: Fixture) => {
      await setReads({ defaultAction: "allow" });
      const e = await entry(f, (await reads()).id, "exclude");
      return () => svc().deleteProfileEntry(e.id);
    }],
    ["bindProfile", async (f: Fixture) => {
      await db.delete(toolProfileBindings);
      await setReads({ defaultAction: "allow" });
      const p = await reads();
      return () => svc().bindProfile(p.id, { targetType: "agent", targetId: f.agentId });
    }],
    ["deleteProfile", async (f: Fixture) => {
      const [allow] = await db.insert(toolProfiles).values({ companyId: f.companyId, profileKey: "allow", name: "Allow", defaultAction: "allow" }).returning();
      const p = await reads();
      return () => svc().deleteProfile(p.id, { force: false, reassignToProfileId: allow!.id });
    }],
  ] as const)("retires an exact access request through %s before any maintenance tick", async (_name, arrange) => {
    const f = await seedPendingAccessRequest(db, "owner");
    const produce = await arrange(f);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await produce();
    await delivery.settle(baseline + 1);
    await expectRetired(f);
  });

  it("notifies on a narrowing unbind without retiring the card", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    const p = await reads();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await svc().unbindProfile(p.id, { targetType: "agent", targetId: f.agentId });
    await delivery.settle(baseline + 1);
    expect(await db.select().from(toolProfileBindings)).toHaveLength(0);
    expect((await card()).status).toBe("pending");
    expect(delivery.wakeup).not.toHaveBeenCalled();
  });

  it("registers the agent tool grant on the caller transaction before its first write and retires only after it commits", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    await db.update(toolCatalogEntries).set({ riskLevel: "read" });
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    let pendingAtFirstProfileWrite: boolean | undefined;
    await db.transaction(async (tx) => {
      const insert = tx.insert.bind(tx);
      tx.insert = ((table: Parameters<typeof insert>[0]) => {
        if (table === toolProfiles) pendingAtFirstProfileWrite ??= databaseWorkPending(db, DELIVERY_QUEUES.connection);
        return insert(table);
      }) as typeof tx.insert;
      await grantConnectionAgentTools(tx as unknown as typeof db, { connection: f.connection, agentId: f.agentId, userId: "owner",
        tools: [{ catalogEntryId: f.tool.id, toolName: f.tool.toolName, versionHash: "v1", permission: "allowed" }] });
      expect(pendingAtFirstProfileWrite).toBe(true);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(delivery!.sweeps).toBe(baseline);
      expect((await card()).status).toBe("pending");
    });
    await delivery.settle(baseline + 1);
    await expectRetired(f);
  });

  it("leaves a raw profile entry write without a notification to the worker until something wakes it", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await entry(f, (await reads()).id, "include");
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(delivery.sweeps).toBe(baseline);
    expect((await card()).status).toBe("pending");
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectRetired(f);
  });

  it("keeps the card pending with no durable effect when the profile write rolls back", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    const p = await reads();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await expect(db.transaction(async (tx) => {
      await toolAccessService(tx as unknown as typeof db).addProfileEntry(p.id, include(f));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await delivery.settle(baseline + 1);
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(toolProfileEntries)).toHaveLength(0);
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery.wakeup).not.toHaveBeenCalled();
  });

  it("retires the card once when two widening writes commit back to back", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    const p = await reads();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await svc().addProfileEntry(p.id, include(f));
    await svc().updateProfile(p.id, { defaultAction: "allow" });
    await delivery.settle(baseline + 1);
    await expectRetired(f);
  });

  it.each([["grant", "expired"], ["grant then revoke", "pending"]] as const)("reruns a sweep that read before a %s committed", async (name, status) => {
    const f = await seedPendingAccessRequest(db, "owner");
    const p = await reads();
    let gate: Promise<void> | null = null, entered!: () => void, release!: () => void;
    delivery = await startConnectionDelivery(db, { beforeSweep: async () => { if (gate) { entered(); await gate; } } });
    const baseline = delivery.sweeps;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    gate = new Promise<void>(resolve => { release = resolve; });
    delivery.wake();
    await reached;
    const added = await svc().addProfileEntry(p.id, include(f));
    if (name === "grant then revoke") await svc().deleteProfileEntry(added.id);
    gate = null;
    release();
    await delivery.settle(baseline + 2);
    expect((await card()).status).toBe(status);
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(status === "expired" ? 1 : 0);
  });

  it("does not retire during admission drain and retires after reopening", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    const p = await reads();
    let open = true;
    delivery = await startConnectionDelivery(db, { canRun: () => open });
    open = false;
    const baseline = delivery.sweeps;
    await svc().addProfileEntry(p.id, include(f));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(delivery.sweeps).toBe(baseline);
    expect((await card()).status).toBe("pending");
    open = true;
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectRetired(f);
  });
});
