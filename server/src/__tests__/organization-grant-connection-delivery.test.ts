import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, connectionGrants, connectionIntentDeliveries, createDb, databaseWorkPending, issueThreadInteractions,
  toolConnections, toolPolicies } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { createOrganizationGrantStore } from "../services/tool-access/connections/organization-grant.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("default organization grant writes notify the connection delivery worker", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-org-grant-connection-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  const pause = () => new Promise(resolve => setTimeout(resolve, 200));
  async function seed(revokedGrant = false) {
    const f = await seedPendingAccessRequest(db, "owner");
    await db.delete(connectionGrants).where(eq(connectionGrants.connectionId, f.connection.id));
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Allow", policyType: "allow", selectors: {} });
    if (revokedGrant) {
      await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: f.connection.id, kind: "organization",
        isDefault: true, status: "revoked", revokedAt: new Date() });
    }
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
    return { ...f, connection: connection! };
  }
  const orgGrants = (connectionId: string) => db.select().from(connectionGrants)
    .where(and(eq(connectionGrants.connectionId, connectionId), eq(connectionGrants.kind, "organization")));
  async function expectRetired(connectionId: string) {
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery!.wakeup).toHaveBeenCalledOnce();
  }

  it.each([["insert", false], ["update", true]] as const)(
    "retires an exact access request through the %s branch on a bare client before any maintenance tick",
    async (_branch, revokedGrant) => {
      const f = await seed(revokedGrant);
      delivery = await startConnectionDelivery(db);
      expect((await card()).status).toBe("pending");
      const baseline = delivery.sweeps;
      await createOrganizationGrantStore(db)(f.connection);
      await delivery.settle(baseline + 1);
      await expectRetired(f.connection.id);
      expect(await orgGrants(f.connection.id)).toEqual([expect.objectContaining({ status: "active", isDefault: true })]);
    },
  );

  it("leaves a raw organization grant write without a notification to the worker until something wakes it", async () => {
    const f = await seed();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: f.connection.id, kind: "organization", isDefault: true, status: "active" });
    await pause();
    expect(delivery.sweeps).toBe(baseline);
    expect((await card()).status).toBe("pending");
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id);
  });

  it.each([["insert", false], ["update", true]] as const)(
    "notifies from the %s branch savepoint but publishes only when the caller transaction commits",
    async (_branch, revokedGrant) => {
      const f = await seed(revokedGrant);
      delivery = await startConnectionDelivery(db);
      const baseline = delivery.sweeps;
      await db.transaction(async (tx) => {
        await createOrganizationGrantStore(db)(f.connection, tx);
        expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
        await pause();
        expect(delivery!.sweeps).toBe(baseline);
        expect((await card()).status).toBe("pending");
      });
      await delivery.settle(baseline + 1);
      await expectRetired(f.connection.id);
    },
  );

  it("notifies before the write even when the write fails inside the savepoint", async () => {
    const f = await seed();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.transaction(async (tx) => {
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(false);
      await expect(createOrganizationGrantStore(db)({ ...f.connection, id: randomUUID() }, tx)).rejects.toThrow();
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
    });
    await delivery.settle(baseline + 1);
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.kind, "organization"))).toHaveLength(0);
  });

  it.each([["insert", false], ["update", true]] as const)(
    "keeps the card pending with no durable effect when the caller transaction rolls back the %s branch",
    async (_branch, revokedGrant) => {
      const f = await seed(revokedGrant);
      delivery = await startConnectionDelivery(db);
      const baseline = delivery.sweeps;
      const before = await orgGrants(f.connection.id);
      await expect(db.transaction(async (tx) => {
        await createOrganizationGrantStore(db)(f.connection, tx);
        expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
        throw new Error("rollback");
      })).rejects.toThrow("rollback");
      await delivery.settle(baseline + 1);
      expect((await card()).status).toBe("pending");
      expect(await orgGrants(f.connection.id)).toEqual(before);
      expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
      expect(delivery.wakeup).not.toHaveBeenCalled();
    },
  );

  it("retires once when the grant commits while a sweep is held before its read", async () => {
    const f = await seed();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const locker = createDb(temp.connectionString);
    try {
      await locker.transaction(async (lock) => {
        await lock.execute(sql`lock table issue_thread_interactions in access exclusive mode`);
        delivery!.wake();
        while (delivery!.sweeps === baseline) await new Promise(resolve => setTimeout(resolve, 10));
        await createOrganizationGrantStore(db)(f.connection);
      });
    } finally { await locker.$client.end({ timeout: 1 }); }
    await delivery.settle(baseline + 2);
    await expectRetired(f.connection.id);
  });

  it("retires once when the insert and the active update branch commit back to back", async () => {
    const f = await seed();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const ensure = createOrganizationGrantStore(db);
    await ensure(f.connection);
    await ensure(f.connection);
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id);
    expect(await orgGrants(f.connection.id)).toHaveLength(1);
  });

  it("does not retire while the worker is drained and retires after it reopens", async () => {
    const f = await seed();
    let open = true;
    delivery = await startConnectionDelivery(db, { canRun: () => open });
    const baseline = delivery.sweeps;
    open = false;
    await createOrganizationGrantStore(db)(f.connection);
    await pause();
    expect(delivery.sweeps).toBe(baseline);
    expect((await card()).status).toBe("pending");
    open = true;
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id);
  });
});
