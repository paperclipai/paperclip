import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, authUsers, chatEndpoints, connectionGrants, connectionIntentDeliveries, createDb, databaseWorkPending,
  issueThreadInteractions, toolConnectionInstalls, toolConnections, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const branches = [
  ["grant revocation", connectionGrants, "update"],
  ["install deletion", toolConnectionInstalls, "delete"],
  ["profile entries", toolProfileEntries, "delete"],
  ["archive", toolConnections, "update"],
  ["endpoint archive", toolConnections, "update"],
] as const;

describePostgres("connection removal delivery notifications", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  let releaseRace = () => {};
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-removal-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { releaseRace(); vi.restoreAllMocks(); await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await temp?.cleanup(); });
  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  async function noEffect() {
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  }

  function stopAt(table: typeof branches[number][1], method: "update" | "delete", rollback = false, paused = false, race = false) {
    const transact = db.transaction.bind(db);
    const sampled = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const state = { reached: false };
    releaseRace = () => release.resolve();
    vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      const baseline = delivery!.sweeps;
      let target = false, owned = false;
      const result = await transact(async tx => {
        const observe = (candidate: unknown, operation: string) => {
          if (branches.some(([, producerTable]) => producerTable === candidate)) owned = true;
          if (candidate === table && operation === method) {
            target = state.reached = true;
            expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
          }
        };
        const update = tx.update.bind(tx), remove = tx.delete.bind(tx);
        const updateSpy = vi.spyOn(tx, "update").mockImplementation((...args) => { observe(args[0], "update"); return update(...args); });
        const deleteSpy = vi.spyOn(tx, "delete").mockImplementation((...args) => { observe(args[0], "delete"); return remove(...args); });
        try {
          const value = await callback(tx);
          if (race && !owned) { sampled.resolve(); await release.promise; }
          if (target && rollback) throw new Error("rollback");
          return value;
        } finally { updateSpy.mockRestore(); deleteSpy.mockRestore(); }
      }, config);
      if (race && owned) {
        if (target) release.resolve();
        else await sampled.promise;
      }
      if (owned && !paused && (!race || target)) await delivery!.settle(target ? baseline + 1 : 0);
      if (target) throw new Error("stop after target commit");
      return result;
    });
    return state;
  }

  describe.each([false, true])("rollback=%s", rollback => {
    it.each(branches)("registers before %s and reconciles its own transaction", async (name, table, method) => {
      const f = await seedPendingAccessRequest(db, "owner");
      const [profile] = await db.insert(toolProfiles).values({ companyId: f.companyId, profileKey: `app:${f.connection.id}`, name: "App", defaultAction: "deny" }).returning();
      await db.insert(toolProfileEntries).values({ companyId: f.companyId, profileId: profile!.id, selectorType: "catalog_entry", catalogEntryId: f.tool.id, effect: "exclude" });
      if (name === "endpoint archive") await db.insert(chatEndpoints).values({ companyId: f.companyId, connectionId: f.connection.id,
        provider: "slack", publicId: f.connection.id, assignedAgentId: f.agentId });
      const before = await db.select().from(table);
      delivery = await startConnectionDelivery(db);
      const observed = stopAt(table, method, rollback);
      await expect(toolAccessService(db).archiveConnection(f.connection.id, f.companyId)).rejects.toThrow(rollback ? "rollback" : "stop after target commit");
      expect(observed.reached).toBe(true);
      await delivery.settle();
      await noEffect();
      if (rollback) expect(await db.select().from(table)).toEqual(before);
    });
  });

  it.each(["commit", "rollback", "drain", "duplicate", "race"])("retires access widened by profile exclusion removal: %s", async mode => {
    const f = await seedPendingAccessRequest(db, "owner");
    const [other] = await db.insert(toolConnections).values({ ...f.connection, id: undefined, uid: "other", name: "Other" }).returning();
    const [profile] = await db.update(toolProfiles).set({ profileKey: `app:${other!.id}`, defaultAction: "allow" })
      .where(eq(toolProfiles.companyId, f.companyId)).returning();
    const exclusion = { companyId: f.companyId, profileId: profile!.id, selectorType: "catalog_entry" as const, catalogEntryId: f.tool.id, effect: "exclude" as const };
    await db.insert(toolProfileEntries).values(exclusion);
    let canRun = true;
    delivery = await startConnectionDelivery(db, { canRun: () => canRun });
    const baseline = delivery.sweeps;
    await db.delete(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile!.id));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(delivery.sweeps).toBe(baseline);
    await noEffect();
    await db.insert(toolProfileEntries).values(exclusion);
    canRun = mode !== "drain";
    const observed = stopAt(toolProfileEntries, "delete", mode === "rollback", !canRun, mode === "race");
    const produce = () => toolAccessService(db).archiveConnection(other!.id, f.companyId);
    const attempts = mode === "duplicate" ? [produce(), produce()] : [produce()];
    for (const result of await Promise.allSettled(attempts)) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.message).toBe(mode === "rollback" ? "rollback" : "stop after target commit");
    }
    expect(observed.reached).toBe(true);
    if (mode === "drain") {
      await noEffect();
      canRun = true;
      delivery.wake();
    }
    await delivery.settle();
    if (mode === "rollback") return noEffect();
    await delivery.settle(baseline + 1);
    expect((await card()).status).toBe("expired");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery.wakeup).toHaveBeenCalledOnce();
  });

});
