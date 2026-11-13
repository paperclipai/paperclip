import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, budgetPolicies, companies, createDb } from "@paperclipai/db";
import { AccountingContentionError, accountingRetryDelayMs } from "../services/accounting-transaction.js";
import { budgetService } from "../services/budgets.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("accounting contention message", () => {
  it("describes the conflicting write without blaming a run", () => {
    const error = new AccountingContentionError(Object.assign(new Error("could not serialize"), { code: "40001" }), 8);
    expect(error.status).toBe(503);
    expect(error.message).not.toMatch(/\brun\b/i);
    expect(error.message).toMatch(/budget/i);
  });
});

describe("accounting retry delay", () => {
  it("doubles from 20 ms, randomizes between half and the full ceiling, and caps at 400 ms", () => {
    const low = () => 0;
    const high = () => 1;
    expect([0, 1, 2, 3, 4, 5, 6].map((attempt) => accountingRetryDelayMs(attempt, high)))
      .toEqual([20, 40, 80, 160, 320, 400, 400]);
    expect([0, 1, 2, 3, 4, 5, 6].map((attempt) => accountingRetryDelayMs(attempt, low)))
      .toEqual([10, 20, 40, 80, 160, 200, 200]);
    expect(accountingRetryDelayMs(2, () => 0.5)).toBe(60);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("concurrent budget policy writes", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-budget-policy-contention-");
    db = createDb(temp.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temp?.cleanup();
  });

  it("saves every policy when several are written for one company at once", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Budget writes", issuePrefix: `B${companyId.slice(0, 6)}` });
    const agentIds = Array.from({ length: 8 }, () => randomUUID());
    await db.insert(agents).values(agentIds.map((id, index) => ({
      id, companyId, name: `Worker ${index}`, role: "engineer", status: "active" as const, adapterType: "process",
    })));
    const budgets = budgetService(db);
    await budgets.upsertPolicy(companyId, { scopeType: "company", scopeId: companyId, amount: 1000 }, null);

    const results = await Promise.allSettled([
      ...agentIds.map((agentId, index) => budgets.upsertPolicy(companyId,
        { scopeType: "agent", scopeId: agentId, amount: 100 + index }, null)),
      budgets.upsertPolicy(companyId, { scopeType: "company", scopeId: companyId, amount: 2000 }, null),
    ]);

    expect(results.filter(result => result.status === "rejected")).toEqual([]);
    const saved = await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId));
    expect(saved).toHaveLength(agentIds.length + 1);
    expect(saved.find(policy => policy.scopeType === "company")?.amount).toBe(2000);
  }, 60_000);
});
