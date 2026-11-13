import { agents, companies, createDb, type Db } from "@paperclipai/db";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startAgentLifecycle } from "../index.js";
import { applyAgentPolicyHoldsInTransaction } from "../adapters/postgres.js";
import { createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { createDeliveryWorkCoordinator } from "../../../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../../services/delivery-work-notifications.js";
import { withAccountingTransaction } from "../../../services/accounting-transaction.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("scoped lifecycle policy projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-lifecycle-policy-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  it("projects only company mismatches in pages of 100 using one transaction per page", async () => {
    const [company] = await db.insert(companies).values({ name: "Policy pages", issuePrefix: "POL" }).returning();
    const eligible = await db.insert(agents).values(Array.from({ length: 101 }, (_, index) => ({
      companyId: company.id, name: `Agent ${index}`, status: "idle", lifecycleState: "ready" as const,
      lifecycleHolds: ["company_paused"], pauseReason: "company_paused",
    }))).returning();
    const excluded = await db.insert(agents).values((["pending_approval", "terminating", "cleaning_up", "terminated", "rejected"] as const).map(lifecycleState => ({
      companyId: company.id, name: lifecycleState, status: "terminated", lifecycleState,
      lifecycleHolds: ["company_paused"], pauseReason: "company_paused",
      // Ineligible lifecycle work is not due while this test projects policy.
      lifecycleOperation: { id: "saved", hostComplete: false, completedPluginIds: [], attempts: 1, retryAt: new Date(Date.now() + 60_000).toISOString() },
    }))).returning();
    const effects = createAgentLifecycleEffects();
    const transaction = vi.spyOn(effects, "transaction");
    const policy = vi.spyOn(effects, "policyBlocks").mockRejectedValue(new Error("Projection must not scan budgets"));
    const work = startAgentLifecycle(db, effects, {
      requiredPluginIds: async () => [], runHost: async () => "pending", runPlugin: async () => "pending",
    }, () => true);
    const rows = () => db.select().from(agents).where(eq(agents.companyId, company.id)).orderBy(asc(agents.id));
    try {
      expect(await work.hasPending()).toBe(true);
      await work.sweep();
      expect(transaction).toHaveBeenCalledTimes(1);
      expect((await rows()).filter(row => row.lifecycleHolds.length === 0)).toHaveLength(100);
      expect(await work.hasPending()).toBe(true);
      await work.sweep();
      expect(transaction).toHaveBeenCalledTimes(2);
      expect((await rows()).filter(row => row.lifecycleHolds.length > 0).map(row => row.id).sort())
        .toEqual(excluded.map(row => row.id).sort());
      expect(policy).not.toHaveBeenCalled();
      expect((await rows()).filter(row => eligible.some(agent => agent.id === row.id))).toHaveLength(101);
      expect(await work.hasPending()).toBe(false);
      expect(work.nextRunAt()).toBeGreaterThan(Date.now());
    } finally { await work.stop(); transaction.mockRestore(); policy.mockRestore(); }
  });

  it("repairs an inherited hold whose lifecycle phase was not projected before restart", async () => {
    const [company] = await db.insert(companies).values({ name: "Interrupted projection", issuePrefix: "INT", status: "paused" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Interrupted agent",
      status: "paused", lifecycleState: "preparing", lifecycleHolds: ["company_paused"], pauseReason: "company_paused" }).returning();
    const host = vi.fn(async () => "complete" as const);
    const work = startAgentLifecycle(db, createAgentLifecycleEffects(), {
      requiredPluginIds: async () => [], runHost: host, runPlugin: host,
    }, () => true);
    try {
      expect(await work.hasPending()).toBe(true);
      await work.sweep();
      expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0]).toMatchObject({
        lifecycleState: "paused", lifecycleHolds: ["company_paused"],
      });
      expect(host).toHaveBeenCalledWith(expect.objectContaining({ id: agent.id, lifecycleState: "pausing" }));
      expect(await work.hasPending()).toBe(false);
    } finally { await work.stop(); }
  });

  it("does not install an idle policy polling timer", async () => {
    const isolatedDatabase = { select: vi.fn() } as unknown as Db;
    const timer = vi.spyOn(globalThis, "setInterval");
    const work = startAgentLifecycle(isolatedDatabase, createAgentLifecycleEffects(), {
      requiredPluginIds: async () => [], runHost: async () => "complete", runPlugin: async () => "complete",
    }, () => true);
    try {
      expect(timer).not.toHaveBeenCalled();
      expect(isolatedDatabase.select).not.toHaveBeenCalled();
    } finally { await work.stop(); timer.mockRestore(); }
  });

  it("applies a supplied agent budget hold inside the caller transaction without reading policies", async () => {
    const [company] = await db.insert(companies).values({ name: "Scoped hold", issuePrefix: "SCP" }).returning();
    const [target, other] = await db.insert(agents).values(["Target", "Other"].map(name => ({
      companyId: company.id, name, status: "paused", lifecycleState: "paused" as const,
      lifecycleHolds: ["manual"], pauseReason: "manual",
    }))).returning();
    const effects = createAgentLifecycleEffects();
    const transaction = vi.spyOn(effects, "transaction");
    const policy = vi.spyOn(effects, "policyBlocks").mockRejectedValue(new Error("No policy lookup allowed"));
    try {
      await withAccountingTransaction(db, company.id, tx =>
        applyAgentPolicyHoldsInTransaction(tx, effects, company.id, target.id, { budget: true }));
      expect(transaction).not.toHaveBeenCalled();
      expect(policy).not.toHaveBeenCalled();
      const current = await db.select().from(agents).where(eq(agents.companyId, company.id));
      expect(current.find(row => row.id === target.id)?.lifecycleHolds).toEqual(["manual", "budget"]);
      expect(current.find(row => row.id === other.id)?.lifecycleHolds).toEqual(["manual"]);
      await expect(withAccountingTransaction(db, company.id, async tx => {
        await applyAgentPolicyHoldsInTransaction(tx, effects, company.id, target.id, { budget: false });
        throw new Error("Rollback accounting");
      })).rejects.toThrow("Rollback accounting");
      expect((await db.select().from(agents).where(eq(agents.id, target.id)))[0].lifecycleHolds).toEqual(["manual", "budget"]);
      await withAccountingTransaction(db, company.id, tx =>
        applyAgentPolicyHoldsInTransaction(tx, effects, company.id, target.id, { budget: false }));
      expect((await db.select().from(agents).where(eq(agents.id, target.id)))[0]).toMatchObject({
        lifecycleState: "paused", lifecycleHolds: ["manual"], pauseReason: "manual",
      });
    } finally { transaction.mockRestore(); policy.mockRestore(); }
  });

  it("recovers committed holds on startup and wakes after new commits without idle polling", async () => {
    const [company] = await db.insert(companies).values({ name: "Durable lifecycle", issuePrefix: "DUR" }).returning();
    const [recover, later] = await db.insert(agents).values(["Recover", "Later"].map(name => ({
      companyId: company.id, name, status: "idle", lifecycleState: "ready" as const,
    }))).returning();
    const effects = createAgentLifecycleEffects();
    await withAccountingTransaction(db, company.id, tx =>
      applyAgentPolicyHoldsInTransaction(tx, effects, company.id, recover.id, { budget: true }));
    const host = vi.fn(async () => "complete" as const);
    const work = startAgentLifecycle(db, effects, { requiredPluginIds: async () => [], runHost: host, runPlugin: host }, () => true);
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    const registered = coordinator.register(DELIVERY_QUEUES.agentLifecycle, {
      retryMs: 10, run: () => work.sweep(), hasPending: () => work.hasPending(), nextRunAt: () => work.nextRunAt(),
    });
    work.setWake(registered.wake);
    const current = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0];
    try {
      await registered.ready;
      expect(await current(recover.id)).toMatchObject({ lifecycleState: "paused", lifecycleHolds: ["budget"] });
      await expect(withAccountingTransaction(db, company.id, async tx => {
        await applyAgentPolicyHoldsInTransaction(tx, effects, company.id, later.id, { budget: true });
        throw new Error("Rollback producer");
      })).rejects.toThrow("Rollback producer");
      expect(await current(later.id)).toMatchObject({ lifecycleState: "ready", lifecycleHolds: [] });
      await withAccountingTransaction(db, company.id, tx =>
        applyAgentPolicyHoldsInTransaction(tx, effects, company.id, later.id, { budget: true }));
      await vi.waitFor(async () => expect(await current(later.id)).toMatchObject({ lifecycleState: "paused", lifecycleHolds: ["budget"] }));
      await new Promise(resolve => setTimeout(resolve, 50));
      const reads = vi.spyOn(db, "select");
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(reads).not.toHaveBeenCalled();
      } finally { reads.mockRestore(); }
      expect(host).toHaveBeenCalledTimes(2);
    } finally { await coordinator.stop(); await work.stop(); }
  });

});
