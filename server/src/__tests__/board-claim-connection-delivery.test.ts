import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, authUsers, companyMemberships, connectionIntentDeliveries, createDb,
  databaseWorkPending, instanceUserRoles, issueThreadInteractions, toolPolicies } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import * as principalAccess from "../services/principal-access-compatibility.js";
import { claimBoardOwnership, getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "../board-claim.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("board claim wakes connection delivery", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-claim-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "claim-owner", name: "Owner", email: "claim@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => {
    await db.execute(sql`set client_min_messages = warning`);
    await db.execute(sql`truncate table companies cascade`);
    await db.delete(instanceUserRoles);
    await initializeBoardClaimChallenge(db, { deploymentMode: "local_trusted" });
  });
  afterEach(async () => {
    db.$client.options.debug = false;
    vi.restoreAllMocks();
    await delivery?.stop();
    delivery = null;
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  async function arrange(prior: "new" | "suspended" = "suspended") {
    const fixture = await seedPendingAccessRequest(db, "claim-owner");
    await db.insert(toolPolicies).values({ companyId: fixture.companyId, name: "Allow", policyType: "allow", selectors: {} });
    if (prior === "new") await db.delete(companyMemberships);
    else await db.update(companyMemberships).set({ status: "suspended" });
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const url = new URL(getBoardClaimWarningUrl("127.0.0.1", 3197)!);
    const claim = { token: url.pathname.split("/").pop()!, code: url.searchParams.get("code")!, userId: "claim-owner" };
    return { ...fixture, claim };
  }
  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  async function retired(connectionId: string) {
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(1);
    expect(delivery!.wakeup).toHaveBeenCalledOnce();
  }
  async function pending() {
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  }

  it.each(["new", "suspended"] as const)("retires through the real claim with %s membership", async prior => {
    const f = await arrange(prior);
    delivery = await startConnectionDelivery(db);
    expect((await card()).status).toBe("pending");
    const baseline = delivery.sweeps;
    await claimBoardOwnership(db, f.claim);
    await delivery.settle(baseline + 1);
    await retired(f.connection.id);
  });

  it("needs a wake after an equivalent raw membership write", async () => {
    const f = await arrange();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.update(companyMemberships).set({ status: "active", membershipRole: "owner" });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(delivery.sweeps).toBe(baseline);
    await pending();
    delivery.wake();
    await delivery.settle(baseline + 1);
    await retired(f.connection.id);
  });

  it.each(["new", "suspended"] as const)("notifies before the %s write and waits for outer commit", async prior => {
    const f = await arrange(prior);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const registered: boolean[] = [];
    db.$client.options.debug = (_connection, query) => {
      if (/^(insert into|update) "company_memberships"/.test(query)) {
        registered.push(databaseWorkPending(db, DELIVERY_QUEUES.connection));
      }
    };
    await db.transaction(async tx => {
      await claimBoardOwnership(tx as unknown as typeof db, f.claim);
      expect(registered).toEqual([true]);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      expect(delivery!.sweeps).toBe(baseline);
      await pending();
    });
    await delivery.settle(baseline + 1);
    expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(false);
    await retired(f.connection.id);
  });

  it.each(["new", "suspended"] as const)("has no durable effect after outer rollback of %s membership", async prior => {
    const f = await arrange(prior);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await expect(db.transaction(async tx => {
      await claimBoardOwnership(tx as unknown as typeof db, f.claim);
      throw new Error("rollback claim");
    })).rejects.toThrow("rollback claim");
    await delivery.settle(baseline + 1);
    expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(false);
    expect((await db.select().from(companyMemberships)).map(row => row.status)).toEqual(prior === "new" ? [] : ["suspended"]);
    await pending();
  });

  it("ignores a repeated claim and an unchanged active membership", async () => {
    const f = await arrange();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await claimBoardOwnership(db, f.claim);
    await delivery.settle(baseline + 1);
    const settled = delivery.sweeps;
    expect(await claimBoardOwnership(db, f.claim)).toMatchObject({ status: "claimed" });
    await db.delete(instanceUserRoles);
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const url = new URL(getBoardClaimWarningUrl("127.0.0.1", 3197)!);
    await claimBoardOwnership(db, { ...f.claim, token: url.pathname.split("/").pop()!, code: url.searchParams.get("code")! });
    await delivery.settle();
    expect(delivery.sweeps).toBe(settled);
    await retired(f.connection.id);
    await db.update(companyMemberships).set({ status: "suspended" });
    await db.delete(instanceUserRoles);
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const next = new URL(getBoardClaimWarningUrl("127.0.0.1", 3197)!);
    await claimBoardOwnership(db, { ...f.claim, token: next.pathname.split("/").pop()!, code: next.searchParams.get("code")! });
    await delivery.settle(settled + 1);
    await retired(f.connection.id);
  });

  it("delivers from the claim transaction even if later default-grant repair fails", async () => {
    const f = await arrange();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    vi.spyOn(principalAccess, "ensureHumanRoleDefaultGrants").mockRejectedValueOnce(new Error("grant repair failed"));
    await expect(claimBoardOwnership(db, f.claim)).rejects.toThrow("grant repair failed");
    await delivery.settle(baseline + 1);
    await retired(f.connection.id);
  });

  it("coalesces back-to-back claim writes during an in-flight sweep", async () => {
    const f = await arrange();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    const observed: string[] = [];
    delivery = await startConnectionDelivery(db, { afterSweep: async () => {
      if (delivery) observed.push((await card()).status);
      if (hold) { entered.resolve(); await release.promise; }
    } });
    const baseline = delivery.sweeps;
    hold = true;
    delivery.wake();
    try {
      await entered.promise;
      await claimBoardOwnership(db, f.claim);
      await db.update(companyMemberships).set({ status: "suspended" });
      await db.delete(instanceUserRoles);
      await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
      await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
      const next = new URL(getBoardClaimWarningUrl("127.0.0.1", 3197)!);
      await claimBoardOwnership(db, { ...f.claim, token: next.pathname.split("/").pop()!, code: next.searchParams.get("code")! });
      expect(delivery.sweeps).toBe(baseline + 1);
      await pending();
    } finally {
      hold = false;
      release.resolve();
    }
    await delivery.settle(baseline + 3);
    await retired(f.connection.id);
    expect(delivery.sweeps).toBe(baseline + 3);
    expect(observed).toEqual(["pending", "expired", "expired"]);
  });

  it("keeps a committed claim pending during drain and retires after reopen", async () => {
    const f = await arrange();
    let admitted = true;
    delivery = await startConnectionDelivery(db, { canRun: () => admitted });
    const baseline = delivery.sweeps;
    admitted = false;
    await db.transaction(async tx => {
      await claimBoardOwnership(tx as unknown as typeof db, f.claim);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      await pending();
    });
    await delivery.settle();
    expect(delivery.sweeps).toBe(baseline);
    expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(false);
    await pending();
    admitted = true;
    delivery.wake();
    await delivery.settle(baseline + 1);
    await retired(f.connection.id);
  });
});
