import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, databaseWorkPending, connectionIntentDeliveries, createDb, issueThreadInteractions,
  principalPermissionGrants, toolPolicies, type Db } from "@paperclipai/db";
import * as notifications from "../services/delivery-work-notifications.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { completeAgentHireApproval } from "../services/agent-hiring.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("hire approval notifies connection delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-hire-connection-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`set client_min_messages to warning`); await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  async function arrange() {
    const fixture = await seedPendingAccessRequest(db, "owner");
    const [agent] = await db.select().from(agents).where(eq(agents.id, fixture.agentId));
    return { ...fixture, agent: agent! };
  }
  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;

  it("retires an exact request through its own grant transaction", async () => {
    const f = await arrange();
    delivery = await startConnectionDelivery(db);
    expect((await card()).status).toBe("pending");
    const baseline = delivery.sweeps;
    await db.transaction(tx => completeAgentHireApproval(tx as unknown as Db, f.agent, f.agent));
    await delivery.settle(baseline + 1);
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId: f.connection.id }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery.wakeup).toHaveBeenCalledOnce();
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.permissionKey, "tools:use"))).toHaveLength(1);
  });

  const approve = (f: Awaited<ReturnType<typeof arrange>>, client: Db = db) =>
    client.transaction(tx => completeAgentHireApproval(tx as unknown as Db, f.agent, f.agent));
  const pause = () => new Promise(resolve => setTimeout(resolve, 150));
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    async function wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([promise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Barrier did not open")), 5_000);
        })]);
      } finally { clearTimeout(timer); }
    }
    return { wait, release };
  }
  async function pendingWithoutEffects() {
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  }

  it("keeps a raw grant invisible until an explicit wake", async () => {
    const f = await arrange();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent",
      principalId: f.agentId, permissionKey: "tools:use" });
    await pause();
    expect(delivery.sweeps).toBe(baseline);
    await pendingWithoutEffects();
    delivery.wake();
    await delivery.settle(baseline + 1);
    expect((await card()).status).toBe("expired");
    expect(delivery.wakeup).toHaveBeenCalledOnce();
  });

  it("registers before the grant insert and waits for the outer commit", async () => {
    const f = await arrange();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const inserted = gate(), commit = gate();
    const outer = db.transaction(async tx => {
      await tx.transaction(async nested => {
        const insert = nested.insert.bind(nested);
        const spy = vi.spyOn(nested, "insert").mockImplementation((...args) => {
          if (args[0] === principalPermissionGrants) expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
          return insert(...args);
        });
        try { await completeAgentHireApproval(nested as unknown as Db, f.agent, f.agent); }
        finally { spy.mockRestore(); }
      });
      inserted.release();
      await commit.wait();
    });
    try {
      await Promise.race([inserted.wait(), outer.then(() => { throw new Error("outer ended before barrier"); })]);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      await pause();
      expect(delivery.sweeps).toBe(baseline);
      await pendingWithoutEffects();
    } finally { commit.release(); await outer; }
    await delivery.settle(baseline + 1);
    expect((await card()).status).toBe("expired");
    expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(false);
    expect(delivery.wakeup).toHaveBeenCalledOnce();
  });

  it.each(["outer", "savepoint"] as const)("leaves no durable effect after %s rollback", async scope => {
    const f = await arrange();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const produceThenFail = async (client: Db) => {
      await approve(f, client);
      await client.execute(sql`select 1 / 0`);
    };
    if (scope === "outer") {
      await expect(db.transaction(tx => produceThenFail(tx as unknown as Db))).rejects.toThrow();
    } else {
      await db.transaction(async tx => {
        await expect(tx.transaction(nested => produceThenFail(nested as unknown as Db))).rejects.toThrow();
      });
    }
    await delivery.settle(baseline + 1);
    expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(false);
    expect(await db.select().from(principalPermissionGrants)).toHaveLength(0);
    await pendingWithoutEffects();
  });

  it("does not write grants if notification registration fails", async () => {
    const f = await arrange();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const failure = vi.spyOn(notifications, "notifyDeliveryWork").mockRejectedValueOnce(new Error("registration failed"));
    try { await expect(approve(f)).rejects.toThrow("registration failed"); }
    finally { failure.mockRestore(); }
    await pause();
    expect(delivery.sweeps).toBe(baseline);
    expect(await db.select().from(principalPermissionGrants)).toHaveLength(0);
    await pendingWithoutEffects();
  });

  it("delivers once for back-to-back approvals", async () => {
    const f = await arrange();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await approve(f);
    await approve(f);
    await delivery.settle(baseline + 1);
    expect((await card()).status).toBe("expired");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(1);
    expect(delivery.wakeup).toHaveBeenCalledOnce();
  });

  it.each([false, true])("preserves a write during an in-flight sweep (revoked=%s)", async revoked => {
    const f = await arrange();
    let beforeSweep: (() => Promise<void>) | undefined;
    delivery = await startConnectionDelivery(db, { beforeSweep: async () => { await beforeSweep?.(); } });
    const baseline = delivery.sweeps;
    const entered = gate(), read = gate();
    beforeSweep = async () => { beforeSweep = undefined; entered.release(); await read.wait(); };
    delivery.wake();
    try {
      await entered.wait();
      await approve(f);
      if (revoked) await db.transaction(async tx => {
        await notifications.notifyDeliveryWork(tx, DELIVERY_QUEUES.connection);
        await tx.delete(principalPermissionGrants);
      });
    } finally { read.release(); }
    await delivery.settle(baseline + 2);
    if (revoked) await pendingWithoutEffects();
    else {
      expect((await card()).status).toBe("expired");
      expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
      expect(delivery.wakeup).toHaveBeenCalledOnce();
    }
  });

  it.each([
    { permissions: { trustPreset: LOW_TRUST_REVIEW_PRESET } },
    { metadata: { paperclipBuiltInAgent: { key: "test", featureKeys: [] } } },
  ])("does not grant or notify for an excluded hire (%j)", async patch => {
    const f = await arrange();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.transaction(tx => completeAgentHireApproval(tx as unknown as Db, { ...f.agent, ...patch }, f.agent));
    await pause();
    expect(delivery.sweeps).toBe(baseline);
    expect(await db.select().from(principalPermissionGrants)).toHaveLength(0);
    await pendingWithoutEffects();
  });

  it("does not retire an exact request blocked by a narrowing policy", async () => {
    const f = await arrange();
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Block", policyType: "block", selectors: {} });
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await approve(f);
    await delivery.settle(baseline + 1);
    await pendingWithoutEffects();
  });

  it("retains a committed grant through drain until dispatch reopens", async () => {
    const f = await arrange();
    let canRun = true;
    delivery = await startConnectionDelivery(db, { canRun: () => canRun });
    const baseline = delivery.sweeps;
    canRun = false;
    await approve(f);
    await pause();
    expect(delivery.sweeps).toBe(baseline);
    await pendingWithoutEffects();
    canRun = true;
    delivery.wake();
    await delivery.settle(baseline + 1);
    expect((await card()).status).toBe("expired");
    expect(delivery.wakeup).toHaveBeenCalledOnce();
  });
});
