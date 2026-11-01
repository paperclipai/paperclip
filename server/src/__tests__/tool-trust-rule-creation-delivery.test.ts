import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, authUsers, connectionIntentDeliveries, createDb, databaseWorkPending, issueThreadInteractions,
  toolAccessAuditEvents, toolActionRequests, toolCallEvents, toolInvocations, toolPolicies } from "@paperclipai/db";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("trust rule creation notifies connection delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-trust-rule-connection-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  const pause = () => new Promise(resolve => setTimeout(resolve, 200));
  async function seedApprovedAction() {
    const f = await seedPendingAccessRequest(db, "owner");
    const [invocation] = await db.insert(toolInvocations).values({ companyId: f.companyId, actorType: "agent", actorId: f.agentId,
      agentId: f.agentId, issueId: f.issueId, applicationId: f.connection.applicationId, connectionId: f.connection.id,
      catalogEntryId: f.tool.id, catalogVersionHash: "v1", toolName: f.tool.toolName, argumentsHash: "args",
      policyDecision: "require_approval", approvalState: "approved", status: "succeeded" }).returning();
    const [request] = await db.insert(toolActionRequests).values({ companyId: f.companyId, invocationId: invocation!.id,
      status: "executed", canonicalArgumentsHash: "args", canonicalArgumentsSummary: { summary: "{}", sha256: "args", sizeBytes: 2 } }).returning();
    return { ...f, invocation: invocation!, request: request! };
  }
  let rules = 0;
  const create = (f: Awaited<ReturnType<typeof seedApprovedAction>>, client: typeof db = db) => toolAccessPolicyService(client)
    .createTrustRuleFromActionRequest({ companyId: f.companyId, actionRequestId: f.request.id,
      body: { name: `Trust ${++rules}`, argumentMode: "action", approvalThreshold: 1 }, actor: { userId: "owner" } });
  async function expectPending() {
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  }
  async function expectRetired(connectionId: string) {
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery!.wakeup).toHaveBeenCalledOnce();
  }

  it("retires an exact request covered by the new trust rule before any maintenance tick", async () => {
    const f = await seedApprovedAction();
    delivery = await startConnectionDelivery(db);
    await expectPending();
    const baseline = delivery.sweeps;
    const rule = await create(f);
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id);
    expect(rule).toMatchObject({ policyType: "trust_rule", enabled: true });
    expect(await db.select().from(toolAccessAuditEvents)).toHaveLength(1);
    expect(await db.select().from(toolCallEvents)).toHaveLength(1);
  });

  it("leaves a raw trust rule insert quiet until something wakes the worker", async () => {
    const f = await seedApprovedAction();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Raw trust", policyType: "trust_rule", priority: 40,
      selectors: { agentId: f.agentId, connectionId: f.connection.id, toolName: f.tool.toolName },
      config: { trustRule: { catalogVersionHash: "v1", argumentFilters: { allowAny: true } } } });
    await pause();
    expect(delivery.sweeps).toBe(baseline);
    await expectPending();
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id);
  });

  it.each(["tool_access_audit_events", "tool_call_events"])("rolls back the rule and both audits when %s rejects", async (table) => {
    const f = await seedApprovedAction();
    await db.execute(sql.raw(`CREATE FUNCTION reject_trust_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit rejected'; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER reject_trust BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_trust_audit()`));
    try {
      delivery = await startConnectionDelivery(db);
      const baseline = delivery.sweeps;
      await expect(create(f)).rejects.toMatchObject({ cause: expect.objectContaining({ message: "audit rejected" }) });
      await delivery.settle(baseline);
      await expectPending();
      expect(await db.select().from(toolPolicies)).toHaveLength(0);
      expect(await db.select().from(toolAccessAuditEvents)).toHaveLength(0);
      expect(await db.select().from(toolCallEvents)).toHaveLength(0);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER reject_trust ON ${table}`));
      await db.execute(sql`DROP FUNCTION reject_trust_audit()`);
    }
  });

  it("registers before the rule insert and publishes only when the outer transaction commits", async () => {
    const f = await seedApprovedAction();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    let checked = false;
    await db.transaction(async (tx) => {
      const savepoint = tx.transaction.bind(tx);
      vi.spyOn(tx, "transaction").mockImplementation(((run: (nested: typeof tx) => Promise<unknown>) => savepoint(async (nested) => {
        const insert = nested.insert.bind(nested);
        vi.spyOn(nested, "insert").mockImplementation(((table: Parameters<typeof insert>[0]) => {
          if (table === toolPolicies) checked = databaseWorkPending(db, DELIVERY_QUEUES.connection);
          return insert(table);
        }) as typeof insert);
        return run(nested);
      })) as typeof tx.transaction);
      await create(f, tx as unknown as typeof db);
      expect(checked).toBe(true);
      await pause();
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      expect(delivery!.sweeps).toBe(baseline);
      await expectPending();
    });
    await delivery.settle(baseline + 1);
    expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(false);
    await expectRetired(f.connection.id);
  });

  it("retires once through duplicate back-to-back creations", async () => {
    const f = await seedApprovedAction();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await Promise.all([create(f), create(f)]);
    await create(f);
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id);
    expect(await db.select().from(toolPolicies)).toHaveLength(3);
  });

  it("waits for admission to reopen before retiring", async () => {
    const f = await seedApprovedAction();
    let open = true;
    delivery = await startConnectionDelivery(db, { canRun: () => open });
    const baseline = delivery.sweeps;
    open = false;
    await create(f);
    await pause();
    expect(delivery.sweeps).toBe(baseline);
    await expectPending();
    open = true;
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id);
  });
});
