import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, budgetEvaluationWork, budgetIncidents, budgetPolicies, companies, costEvents, createDb, projects } from "@paperclipai/db";
import { budgetService, budgetServiceInTransaction, flushBudgetEvaluationWork } from "../services/budgets.js";
import { costService, createCostEventInTransaction } from "../services/costs.js";
import { withAccountingTransaction, withOperationAccountingTransaction } from "../services/accounting-transaction.js";
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

  it("blocks stale limited admissions until committed work is evaluated, then stays fresh while idle", async () => {
    const f = await fixture(1000);
    await costService(db).createEvent(f.companyId, charge(f.agentId, randomUUID(), 1));
    await db.update(budgetEvaluationWork).set({ createdAt: new Date(Date.now() - 16_000) }).where(eq(budgetEvaluationWork.companyId, f.companyId));
    expect((await budgetService(db).evaluateAdmission(f.companyId, f.agentId)).block?.reason).toContain("awaiting reconciliation");
    await flushBudgetEvaluationWork(db, f);
    expect((await budgetService(db).evaluateAdmission(f.companyId, f.agentId)).block).toBeNull();
    expect(await flushBudgetEvaluationWork(db, f)).toBe(0);
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

  it("does not apply another agent's stale backlog to a separately limited agent", async () => {
    const f = await fixture(0);
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId: f.companyId, name: "Other worker", role: "engineer", status: "active", adapterType: "process" });
    const service = budgetService(db);
    for (const agentId of [f.agentId, otherAgentId]) await service.upsertPolicy(f.companyId,
      { scopeType: "agent", scopeId: agentId, amount: 1000 }, null);
    await flushBudgetEvaluationWork(db, f);
    await costService(db).createEvent(f.companyId, charge(f.agentId, randomUUID(), 1));
    await db.update(budgetEvaluationWork).set({ createdAt: new Date(Date.now() - 16_000) }).where(eq(budgetEvaluationWork.companyId, f.companyId));
    expect((await service.evaluateAdmission(f.companyId, f.agentId)).block).not.toBeNull();
    expect((await service.evaluateAdmission(f.companyId, otherAgentId)).block).toBeNull();
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
});
