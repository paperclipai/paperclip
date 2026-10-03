import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentRuntimeState, approvals, budgetIncidents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns, projects } from "@paperclipai/db";
import { costService } from "../services/costs.js";
import { budgetService, type BudgetServiceHooks } from "../services/budgets.js";
import { accountRunCost, reconcileRunCosts } from "../services/run-cost-accounting.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

function random(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("seeded concurrent accounting invariants", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-accounting-interleavings-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  it.each([1, 7, 42, 97, 31337, 65537, 104729, 0xdeadbeef])("conserves the ledger, totals, incidents and delivery state for seed %s", async (seed) => {
    const rng = random(seed);
    const [company] = await db.insert(companies).values({ name: `Interleaving ${seed}`, issuePrefix: `R${randomUUID().slice(0,7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", status: "idle", adapterType: "process" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Project" }).returning();
    const oracle = new Map<string, { ticks: bigint; input: number; cached: number; output: number; run: boolean }>();
    const operations: Array<() => Promise<unknown>> = [];
    let cancellationAttempts = 0;
    let successfulDeliveries = 0;
    const hooks: BudgetServiceHooks = { cancelWorkForScope: async (scope) => {
      expect(scope.companyId).toBe(company.id);
      expect(scope.createdBefore).toBeInstanceOf(Date);
      cancellationAttempts++;
      if (cancellationAttempts % 4 === 1) throw new Error(`Injected delivery interruption (seed ${seed})`);
      successfulDeliveries++;
    } };
    const budgets = budgetService(db, hooks);
    const costs = costService(db, hooks);
    const now = new Date();
    for (let index = 0; index < 12; index++) {
      const ticks = Math.floor(rng() * 9_000_000) + 1;
      const input = Math.floor(rng() * 300), cached = Math.floor(rng() * 500), output = Math.floor(rng() * 80);
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
        status: ["succeeded", "failed", "cancelled", "timed_out"][index % 4], finishedAt: now, costAccountingPending: true,
        usageJson: { accountingReceiptReady: true, provider: "fixture", model: `model-${index % 3}`, billingType: "metered_api", inputTokens: input, cachedInputTokens: cached, outputTokens: output, costUsd: ticks / 1e9, ledgerScope: { projectId: project.id } },
      }).returning();
      oracle.set(`heartbeat:${run.id}:final`, { ticks: BigInt(ticks), input, cached, output, run: true });
      operations.push(() => accountRunCost(db, run.id, hooks), () => accountRunCost(db, run.id, hooks));
    }
    for (let index = 0; index < 10; index++) {
      const ticks = Math.floor(rng() * 3_000_000) + 1;
      const key = `manual-${index}`;
      const receipt = { idempotencyKey: key, agentId: agent.id, projectId: project.id, provider: "fixture", model: "manual", billingType: "metered_api", costCents: ticks / 1e7, occurredAt: now };
      oracle.set(key, { ticks: BigInt(ticks), input: 0, cached: 0, output: 0, run: false });
      operations.push(() => costs.createEvent(company.id, receipt), () => costs.createEvent(company.id, receipt));
    }
    for (let index = 0; index < 12; index++) {
      const amount = rng() < 0.5 ? 1 : 200;
      const scopeType = index % 2 ? "agent" as const : "project" as const;
      operations.push(() => budgets.upsertPolicy(company.id, { scopeType, scopeId: scopeType === "agent" ? agent.id : project.id, amount, notifyEnabled: false }, "board"));
      operations.push(() => budgets.getInvocationBlock(company.id, agent.id, { projectId: project.id }));
      operations.push(() => reconcileRunCosts(db, hooks));
    }
    // Reproducible submission order and jitter; the database is free to choose
    // the actual interleaving. The oracle is independent of execution order.
    for (let i = operations.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1)); [operations[i], operations[j]] = [operations[j], operations[i]];
    }
    for (let offset = 0; offset < operations.length; offset += 8) {
      await Promise.all(operations.slice(offset, offset + 8).map(async operation => {
        await new Promise(resolve => setTimeout(resolve, Math.floor(rng() * 5)));
        return operation();
      }));
      const incidents = await db.select().from(budgetIncidents).where(and(eq(budgetIncidents.companyId, company.id), eq(budgetIncidents.status, "open")));
      expect(new Set(incidents.map(row => `${row.policyId}:${row.windowStart.toISOString()}:${row.thresholdType}`)).size).toBe(incidents.length);
    }
    await reconcileRunCosts(db, hooks);
    const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, company.id));
    expect(rows).toHaveLength(oracle.size);
    for (const row of rows) {
      const expected = oracle.get(row.idempotencyKey!);
      expect(expected, `unexpected receipt ${row.idempotencyKey}; seed ${seed}`).toBeDefined();
      expect(BigInt(Math.round(row.costCents * 1e7))).toBe(expected!.ticks);
      expect([row.inputTokens, row.cachedInputTokens, row.outputTokens]).toEqual([expected!.input, expected!.cached, expected!.output]);
    }
    const total = [...oracle.values()].reduce((sum, row) => sum + row.ticks, 0n);
    expect(BigInt(Math.round((await costs.summary(company.id)).spendCents * 1e7))).toBe(total);
    expect(BigInt(Math.round((await costs.byProject(company.id))[0].costCents * 1e7))).toBe(total);
    const [companyProjection] = await db.select().from(companies).where(eq(companies.id, company.id));
    const [agentProjection] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(BigInt(Math.round(companyProjection.spentMonthlyCents * 1e7))).toBe(total);
    expect(BigInt(Math.round(agentProjection.spentMonthlyCents * 1e7))).toBe(total);
    const [runtime] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agent.id));
    const runs = [...oracle.values()].filter(row => row.run);
    expect(BigInt(Math.round(runtime.totalCostCents * 1e7))).toBe(runs.reduce((sum, row) => sum + row.ticks, 0n));
    expect([runtime.totalInputTokens,runtime.totalCachedInputTokens,runtime.totalOutputTokens])
      .toEqual(["input","cached","output"].map(key => runs.reduce((sum,row) => sum + Number(row[key as "input" | "cached" | "output"]),0)));
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).every(run => !run.costAccountingPending && run.costAccountedAt !== null)).toBe(true);
    // Finish in a known hard-stop state, deliver failed effects, then grant more
    // budget. This checks the final observable state, not only receipt counts.
    await budgets.upsertPolicy(company.id, { scopeType: "agent", scopeId: agent.id, amount: 1, notifyEnabled: false }, "board");
    expect(await budgets.getInvocationBlock(company.id, agent.id)).toMatchObject({ scopeType: "agent" });
    for (let pass = 0; pass < 4; pass++) await budgets.deliverPendingEnforcement(company.id);
    expect(successfulDeliveries).toBeGreaterThan(0);
    const policies = await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, company.id));
    expect(policies.every(row => row.enforcementVersion === row.enforcementDeliveredVersion)).toBe(true);
    const allIncidents = await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, company.id));
    const approvalRows = await db.select().from(approvals).where(eq(approvals.companyId, company.id));
    expect(new Set(allIncidents.map(row => row.approvalId).filter(Boolean)).size).toBe(approvalRows.length);
    await budgets.upsertPolicy(company.id, { scopeType: "agent", scopeId: agent.id, amount: 200 }, "board");
    await budgets.upsertPolicy(company.id, { scopeType: "project", scopeId: project.id, amount: 200 }, "board");
    expect(await budgets.getInvocationBlock(company.id, agent.id, { projectId: project.id })).toBeNull();
  }, 60_000);
});
