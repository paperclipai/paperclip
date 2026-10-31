import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, connectionIntentDeliveries, createDb, issueThreadInteractions, toolPolicies } from "@paperclipai/db";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("tool policy writes notify the connection delivery worker", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-policy-connection-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  const policy = (companyId: string, policyType: "allow" | "block", values: Partial<typeof toolPolicies.$inferInsert> = {}) =>
    db.insert(toolPolicies).values({ companyId, name: `${policyType} ${values.priority ?? 100}`, policyType, selectors: {}, ...values }).returning().then(rows => rows[0]!);
  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;

  const service = () => toolAccessPolicyService(db);
  it.each([
    ["createPolicy", async (companyId: string) => () => service().createPolicy(companyId, { name: "Allow", policyType: "allow", selectors: {} })],
    ["updatePolicy", async (companyId: string) => {
      const allow = await policy(companyId, "allow", { enabled: false });
      return () => service().updatePolicy({ companyId, policyId: allow.id, body: { enabled: true } });
    }],
    ["deletePolicy", async (companyId: string) => {
      const block = await policy(companyId, "block", { priority: 10 });
      await policy(companyId, "allow", { priority: 20 });
      return () => service().deletePolicy({ companyId, policyId: block.id });
    }],
    ["reorderPolicies", async (companyId: string) => {
      const block = await policy(companyId, "block", { priority: 10 });
      const allow = await policy(companyId, "allow", { priority: 20 });
      return () => service().reorderPolicies(companyId, { policyIds: [allow.id, block.id] });
    }],
  ] as const)("retires an exact access request through %s before any maintenance tick", async (_name, arrange) => {
    const f = await seedPendingAccessRequest(db, "owner");
    const produce = await arrange(f.companyId);
    delivery = await startConnectionDelivery(db);
    expect((await card()).status).toBe("pending");
    const baseline = delivery.sweeps;
    await produce();
    await delivery.settle(baseline + 1);
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId: f.connection.id }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery.wakeup).toHaveBeenCalledOnce();
  });

  it("notifies on a narrowing write without retiring the card", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    const allow = await policy(f.companyId, "allow", { enabled: false });
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await service().duplicatePolicy({ companyId: f.companyId, policyId: allow.id, body: {} });
    await delivery.settle(baseline + 1);
    expect((await card()).status).toBe("pending");
    expect(delivery.wakeup).not.toHaveBeenCalled();
  });

  it("leaves a raw policy write without a notification to the worker until something wakes it", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await policy(f.companyId, "allow");
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(delivery.sweeps).toBe(baseline);
    expect((await card()).status).toBe("pending");
    delivery.wake();
    await delivery.settle(baseline + 1);
    expect((await card()).status).toBe("expired");
  });

  it("keeps the card pending with no durable effect when the policy write rolls back", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    delivery = await startConnectionDelivery(db);
    await expect(db.transaction(async (tx) => {
      await toolAccessPolicyService(tx as unknown as typeof db).createPolicy(f.companyId, { name: "Allow", policyType: "allow", selectors: {} });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await delivery.settle();
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(toolPolicies)).toHaveLength(0);
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery.wakeup).not.toHaveBeenCalled();
  });
});
