import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, budgetEvaluationWork, budgetIncidents, budgetPolicies, companies, costEvents, createDb, projects } from "@paperclipai/db";
import { budgetService, budgetServiceInTransaction, flushBudgetEvaluationWork } from "../services/budgets.js";
import { costService, createCostEventInTransaction } from "../services/costs.js";
import { withAccountingTransaction, withOperationAccountingTransaction } from "../services/accounting-transaction.js";
import { computeObservedSpends, type SpendPolicy } from "../services/budget-exposure.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerBudgetEnforcementWork } from "../services/budget-enforcement-worker.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const postgres = support.supported ? describe : describe.skip;

postgres("independent accounting and deferred budget decisions", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-budget-work-");
    db = createDb(temp.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temp?.cleanup();
  });
  async function fixture(limit = 100) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Independent accounting", issuePrefix: `X${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "active", adapterType: "process" });
    await budgetService(db).upsertPolicy(companyId, { scopeType: "company", scopeId: companyId, amount: limit }, null);
    await flushBudgetEvaluationWork(db, { companyId });
    return { companyId, agentId };
  }
  function charge(agentId: string, idempotencyKey = randomUUID(), costCents = 60) {
    return { agentId, provider: "openai", biller: "openai", model: "gpt-4", billingType: "metered_api",
      costCents, occurredAt: new Date(), idempotencyKey };
  }
  async function pending(companyId: string) {
    return db.select().from(budgetEvaluationWork).where(eq(budgetEvaluationWork.companyId, companyId));
  }

  it("records every concurrent charge, then coalesces one recoverable hard-stop transition", async () => {
    const f = await fixture();
    await Promise.all([costService(db).createEvent(f.companyId, charge(f.agentId)), costService(db).createEvent(f.companyId, charge(f.agentId))]);
    expect((await pending(f.companyId))).toHaveLength(2);
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0].pauseReason).toBeNull();
    await Promise.all([flushBudgetEvaluationWork(db, f), flushBudgetEvaluationWork(db, f)]);
    expect(await pending(f.companyId)).toHaveLength(0);
    expect((await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId)))).toHaveLength(2);
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0].pauseReason).toBe("budget");
    const incidents = await db.select().from(budgetIncidents).where(and(eq(budgetIncidents.companyId, f.companyId), eq(budgetIncidents.thresholdType, "hard")));
    expect(incidents).toHaveLength(1);
    expect((await budgetService(db).evaluateAdmission(f.companyId, f.agentId)).block).not.toBeNull();
  });

  it("keeps a lower allocated input that commits after a consumed batch", async () => {
    const f = await fixture(1000);
    let release!: () => void, inserted!: () => void;
    const ready = new Promise<void>(resolve => { inserted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const earlier = withOperationAccountingTransaction(db, f.companyId, async (tx, publications) => {
      await createCostEventInTransaction(tx, f.companyId, charge(f.agentId), publications);
      inserted();
      await gate;
    });
    try {
      await ready;
      await costService(db).createEvent(f.companyId, charge(f.agentId));
      expect(await flushBudgetEvaluationWork(db, f)).toBe(1);
      release();
      await earlier;
      expect(await pending(f.companyId)).toHaveLength(1);
      expect(await flushBudgetEvaluationWork(db, f)).toBe(1);
      expect(await pending(f.companyId)).toHaveLength(0);
    } finally { release(); await earlier; }
  });

  it("does not create more work or audit charges on identical receipt replay", async () => {
    const f = await fixture();
    const receipt = charge(f.agentId, randomUUID(), 1);
    const events = await Promise.all([costService(db).createEvent(f.companyId, receipt), costService(db).createEvent(f.companyId, receipt)]);
    expect(events[0].id).toBe(events[1].id);
    expect(await pending(f.companyId)).toHaveLength(1);
    await expect(costService(db).createEvent(f.companyId, { ...receipt, costCents: 2 })).rejects.toMatchObject({ status: 409 });
    expect(await pending(f.companyId)).toHaveLength(1);
  });

  // Invariant 3: unevaluated inputs are not a gate. Admission reads the ledger
  // and live exposure itself, so a reached hard stop refuses at once while the
  // evaluator is still behind, and an old input under the limit never refuses.
  it("admits limited work while inputs await evaluation, and refuses a reached hard stop inline", async () => {
    const f = await fixture(1000);
    await costService(db).createEvent(f.companyId, charge(f.agentId, randomUUID(), 1));
    await db.update(budgetEvaluationWork).set({ createdAt: new Date(Date.now() - 16_000) }).where(eq(budgetEvaluationWork.companyId, f.companyId));
    expect((await budgetService(db).evaluateAdmission(f.companyId, f.agentId)).block).toBeNull();
    await costService(db).createEvent(f.companyId, charge(f.agentId, randomUUID(), 1000));
    expect(await pending(f.companyId)).not.toHaveLength(0);
    expect((await budgetService(db).evaluateAdmission(f.companyId, f.agentId)).block?.reason).toMatch(/hard-stop/);
    await flushBudgetEvaluationWork(db, f);
    expect((await budgetService(db).evaluateAdmission(f.companyId, f.agentId)).block?.reason).toMatch(/hard-stop/);
  });

  it("retains policy raise and manual pause when evaluation races them", async () => {
    const f = await fixture();
    await costService(db).createEvent(f.companyId, charge(f.agentId, randomUUID(), 120));
    await Promise.all([flushBudgetEvaluationWork(db, f), budgetService(db).upsertPolicy(f.companyId,
      { scopeType: "company", scopeId: f.companyId, amount: 1000 }, null)]);
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0].pauseReason).toBeNull();
    await db.update(companies).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(companies.id, f.companyId));
    await costService(db).createEvent(f.companyId, charge(f.agentId, randomUUID(), 1));
    await flushBudgetEvaluationWork(db, f);
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0].pauseReason).toBe("manual");
  });

  it("does not apply another agent's unevaluated hard stop to a separately limited agent", async () => {
    const f = await fixture(0);
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId: f.companyId, name: "Other worker", role: "engineer", status: "active", adapterType: "process" });
    const service = budgetService(db);
    for (const agentId of [f.agentId, otherAgentId]) await service.upsertPolicy(f.companyId,
      { scopeType: "agent", scopeId: agentId, amount: 1000 }, null);
    await flushBudgetEvaluationWork(db, f);
    await costService(db).createEvent(f.companyId, charge(f.agentId, randomUUID(), 1000));
    await db.update(budgetEvaluationWork).set({ createdAt: new Date(Date.now() - 16_000) }).where(eq(budgetEvaluationWork.companyId, f.companyId));
    // The unevaluated charge reaches this agent's hard stop and refuses it
    // inline; the other agent's separate limit is untouched.
    expect((await service.evaluateAdmission(f.companyId, f.agentId)).block?.reason).toMatch(/hard-stop/);
    expect((await service.evaluateAdmission(f.companyId, otherAgentId)).block).toBeNull();
  });

  it("evaluates many distinct scopes without exceeding PostgreSQL's aggregate column limit", async () => {
    const f = await fixture(1000);
    await costService(db).createEvent(f.companyId, charge(f.agentId, randomUUID(), 1));
    const policies: SpendPolicy[] = [{ companyId: f.companyId, scopeType: "company", scopeId: f.companyId,
      windowKind: "lifetime", metric: "billed_cents" }, ...Array.from({ length: 450 }, () => ({
      companyId: f.companyId, scopeType: "project", scopeId: randomUUID(), windowKind: "lifetime", metric: "billed_cents",
    }))];
    const observed = await withOperationAccountingTransaction(db, f.companyId, tx => computeObservedSpends(tx, policies));
    expect(observed).toHaveLength(451);
    expect(observed[0].ledgerCents).toBe("1.0000000");
    expect(observed.slice(1).every(row => row.totalExact === "0.0000000")).toBe(true);
  });

  it("proves the legacy mutex waits while the independent ledger transaction commits", async () => {
    const f = await fixture(1000);
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = db.transaction(async tx => {
      await tx.select().from(companies).where(eq(companies.id, f.companyId)).for("no key update");
      locked(); await gate;
    });
    let legacyFinished = false;
    let legacy: Promise<unknown> | undefined;
    try {
      await ready;
      legacy = withAccountingTransaction(db, f.companyId, async () => { legacyFinished = true; });
      await costService(db).createEvent(f.companyId, charge(f.agentId));
      expect(legacyFinished).toBe(false);
      expect(await pending(f.companyId)).toHaveLength(1);
    } finally { release(); await holding; await legacy; }
    expect(legacyFinished).toBe(true);
  });

  it("reevaluates a new policy committed after a no-policy batch consumed its charge", async () => {
    const f = await fixture(1000);
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "New policy scope" });
    let release!: () => void, created!: () => void;
    const ready = new Promise<void>(resolve => { created = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const policy = withOperationAccountingTransaction(db, f.companyId, async (tx, publications) => {
      await budgetServiceInTransaction(tx, publications, { evaluate: true }).upsertPolicy(f.companyId,
        { scopeType: "project", scopeId: projectId, amount: 80 }, null);
      created(); await gate;
    });
    async function bounded<T>(work: Promise<T>, phase: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout>;
      try { return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Policy race blocked at ${phase}`)), 2000);
      })]); } finally { clearTimeout(timer!); }
    }
    try {
      await bounded(Promise.race([ready, policy]), "policy prepared");
      await bounded(costService(db).createEvent(f.companyId, { ...charge(f.agentId, randomUUID(), 120), projectId }), "charge commit");
      expect(await bounded(flushBudgetEvaluationWork(db, f), "first evaluation")).toBe(1);
      release(); await policy;
      expect(await pending(f.companyId)).toHaveLength(1);
      await flushBudgetEvaluationWork(db, f);
      expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0].pauseReason).toBe("budget");
    } finally { release(); await policy; }
  });

  it("delivers another company's Stop when a busy company has more than a page of old inputs", async () => {
    const busy = await fixture(), healthy = await fixture();
    await costService(db).createEvent(busy.companyId, charge(busy.agentId, randomUUID(), 120));
    await costService(db).createEvent(healthy.companyId, charge(healthy.agentId, randomUUID(), 120));
    await db.insert(budgetEvaluationWork).values(Array.from({ length: 150 }, () => ({
      companyId: busy.companyId, agentId: busy.agentId, createdAt: new Date(Date.now() - 20_000),
    })));
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = db.transaction(async tx => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, busy.companyId)).for("no key update");
      locked(); await gate;
    });
    const errors: unknown[] = [], delivered: string[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    try {
      await ready;
      await registerBudgetEnforcementWork(db, coordinator, { cancelWorkForScope: async scope => { delivered.push(scope.companyId); } }).ready;
      expect(errors).toHaveLength(0);
      expect(delivered).toContain(healthy.companyId);
      expect((await db.select().from(companies).where(eq(companies.id, healthy.companyId)))[0].pauseReason).toBe("budget");
      expect(await pending(healthy.companyId)).toHaveLength(0);
      expect((await pending(busy.companyId)).length).toBeGreaterThan(100);
    } finally { release(); await holding; await coordinator.stop(); }
  });
});
