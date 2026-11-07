import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, budgetEvaluationWork, budgetIncidents, budgetPolicies, companies, createDb } from "@paperclipai/db";
import { budgetService, budgetServiceInTransaction, flushBudgetEvaluationWork } from "../services/budgets.js";
import { costService } from "../services/costs.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("budget publication versus resource controls", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-budget-controls-");
    db = createDb(temp.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temp?.cleanup();
  });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Budget controls", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "active", adapterType: "process" });
    const policy = await budgetService(db).upsertPolicy(companyId, { scopeType: "company", scopeId: companyId, amount: 100 }, null);
    await flushBudgetEvaluationWork(db, { companyId });
    return { companyId, agentId, policyId: policy.policyId };
  }
  async function charge(f: { companyId: string; agentId: string }, costCents: number, occurredAt = new Date()) {
    return costService(db).createEvent(f.companyId, { agentId: f.agentId, provider: "openai", model: "fixture", costCents,
      occurredAt, idempotencyKey: randomUUID() });
  }
  const pending = (companyId: string) => db.select().from(budgetEvaluationWork).where(eq(budgetEvaluationWork.companyId, companyId));
  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Budget evaluator waited for a resource while holding its policy")), 2000);
      })]);
    } finally { clearTimeout(timer); }
  }

  it("relinquishes its policy fence so a company-first control edit cannot deadlock or lose", async () => {
    const f = await fixture();
    await charge(f, 120);
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    // Retain the existing company/configuration writer's company -> policy
    // order, while the evaluator starts from the opposite end of the race.
    const control = db.transaction(async tx => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, f.companyId)).for("no key update");
      locked(); await gate;
      await budgetServiceInTransaction(tx as unknown as Parameters<typeof budgetServiceInTransaction>[0]).upsertPolicy(f.companyId,
        { scopeType: "company", scopeId: f.companyId, amount: 1000 }, "operator");
      await tx.update(companies).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(companies.id, f.companyId));
    });
    await ready;
    const evaluation = flushBudgetEvaluationWork(db, f).then(value => ({ value }), error => ({ error }));
    try {
      expect(await bounded(evaluation)).toMatchObject({ value: 0 });
      expect((await pending(f.companyId)).length).toBeGreaterThan(0);
    } finally { release(); await control; await evaluation; }
    await flushBudgetEvaluationWork(db, f);
    expect((await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, f.policyId)))[0].amount).toBe(1000);
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0])
      .toMatchObject({ status: "paused", pauseReason: "manual" });
    expect(await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, f.companyId))).toHaveLength(0);
    expect(await pending(f.companyId)).toHaveLength(0);
  });

  it("rolls back old-window publication and retains its inputs when UTC rollover interrupts every attempt", async () => {
    const before = new Date("2026-11-30T23:59:59.900Z"), after = new Date("2026-12-01T00:00:00.100Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(before);
    const f = await fixture();
    await charge(f, 120);
    const inputIds = (await pending(f.companyId)).map(row => row.id);
    const [original] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, f.policyId));
    const transaction = db.transaction.bind(db);
    let crossed = 0;
    const boundary = vi.spyOn(db, "transaction").mockImplementation((callback, options) => {
      vi.setSystemTime(before);
      return transaction(async tx => {
        const execute = tx.execute.bind(tx);
        // The exposure statement executes against real PostgreSQL; advance only
        // the application clock after reading that old-window snapshot.
        tx.execute = (async (...args: Parameters<typeof tx.execute>) => {
          const result = await execute(...args);
          if (Date.now() === before.getTime()) { crossed++; vi.setSystemTime(after); }
          return result;
        }) as typeof tx.execute;
        return callback(tx);
      }, options);
    });
    try {
      expect(await flushBudgetEvaluationWork(db, f)).toBe(0);
    } finally { boundary.mockRestore(); }
    expect(crossed).toBeGreaterThan(0);
    expect((await pending(f.companyId)).map(row => row.id)).toEqual(inputIds);
    expect((await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, f.policyId)))[0].evaluationVersion).toBe(original.evaluationVersion);
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0].pauseReason).toBeNull();
    expect(await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, f.companyId))).toHaveLength(0);
    vi.setSystemTime(after);
    await flushBudgetEvaluationWork(db, f);
    expect(await pending(f.companyId)).toHaveLength(0);
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0].pauseReason).toBeNull();
  });

  it("reads the new UTC month through a budget service retained across rollover", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-30T12:00:00Z"));
    const f = await fixture();
    const service = budgetService(db);
    await charge(f, 20, new Date("2026-11-15T12:00:00Z"));
    await charge(f, 30, new Date("2026-12-15T12:00:00Z"));
    const november = (await service.overview(f.companyId)).policies[0];
    expect(november).toMatchObject({ observedAmountExact: "20.0000000" });
    expect(november.windowStart.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    vi.setSystemTime(new Date("2026-12-20T12:00:00Z"));
    const december = (await service.overview(f.companyId)).policies[0];
    expect(december).toMatchObject({ observedAmountExact: "30.0000000" });
    expect(december.windowStart.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });
});
