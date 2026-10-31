import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, connectionIntentDeliveries, createDb, issueThreadInteractions, toolCatalogEntries, toolProfileBindings, toolProfileEntries,
  toolProfiles } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("bare tool profile writes notify the connection delivery worker", () => {
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

  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  const disabledAllowReads = async () => {
    await db.update(toolProfiles).set({ status: "disabled", defaultAction: "allow" }).where(eq(toolProfiles.profileKey, "reads"));
    return (await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, "reads")))[0]!;
  };
  const expectNoDurableEffect = async () => {
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  };

  it("retires an exact access request through duplicateProfile before any maintenance tick", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    const reads = await disabledAllowReads();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await toolAccessService(db).duplicateProfile(reads.id, { name: "Copy", includeAssignments: true });
    await delivery.settle(baseline + 1);
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId: f.connection.id }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery.wakeup).toHaveBeenCalledOnce();
  });

  it("notifies on createProfile and reviewProfileNewTools without retiring the card", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    const [scoped] = await db.insert(toolProfiles).values({ companyId: f.companyId, profileKey: "scoped", name: "Scoped", newToolsReviewedAt: new Date(0) }).returning();
    const [sibling] = await db.insert(toolCatalogEntries).values({ companyId: f.companyId, connectionId: f.connection.id, toolName: "sentry-list", name: "sentry-list", versionHash: "v1" }).returning();
    await db.insert(toolProfileEntries).values({ companyId: f.companyId, profileId: scoped!.id, selectorType: "catalog_entry", catalogEntryId: sibling!.id, connectionId: f.connection.id });
    delivery = await startConnectionDelivery(db);
    for (const produce of [
      () => toolAccessService(db).createProfile(f.companyId, { profileKey: "unbound", name: "Unbound", defaultAction: "allow",
        entries: [{ selectorType: "catalog_entry", catalogEntryId: f.tool.id, connectionId: f.connection.id }] }),
      () => toolAccessService(db).reviewProfileNewTools(scoped!.id, { decisions: [{ catalogEntryId: f.tool.id, decision: "allow" }] }),
    ]) {
      const baseline = delivery.sweeps;
      await produce();
      await delivery.settle(baseline + 1);
    }
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.catalogEntryId, f.tool.id))).toHaveLength(2);
    await expectNoDurableEffect();
  });

  it("leaves a raw profile copy without a notification to the worker until something wakes it", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const [copy] = await db.insert(toolProfiles).values({ companyId: f.companyId, profileKey: "copy", name: "Copy", defaultAction: "allow" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: f.companyId, profileId: copy!.id, targetType: "agent", targetId: f.agentId });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(delivery.sweeps).toBe(baseline);
    expect((await card()).status).toBe("pending");
    delivery.wake();
    await delivery.settle(baseline + 1);
    expect((await card()).status).toBe("expired");
  });

  it("keeps the card pending with no durable effect when the duplicate rolls back", async () => {
    await seedPendingAccessRequest(db, "owner");
    const reads = await disabledAllowReads();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await expect(db.transaction(async (tx) => {
      await toolAccessService(tx as unknown as typeof db).duplicateProfile(reads.id, { name: "Copy", includeAssignments: true });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await delivery.settle(baseline + 1);
    expect(await db.select().from(toolProfiles)).toHaveLength(1);
    await expectNoDurableEffect();
  });
});
