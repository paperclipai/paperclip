import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "../../packages/db/src/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../packages/db/src/test-embedded-postgres.js";
import { accountRunCost, reconcileRunCosts } from "../../server/src/services/run-cost-accounting.js";
import { accountingIntegrityService } from "../../server/src/services/accounting-integrity.js";
import { costDataQualityReport } from "../../server/src/services/cost-data-quality.js";
import { accountingFaultSql, armAccountingFault } from "./chat-accounting-fault.js";

it("refuses every execution except its own single selected case, and any binding it cannot validate", async () => {
  const binding = { companyId: randomUUID(), issueId: randomUUID() };
  const other = "chat-features.runner-opencode.local.budgets-costs.spend-breakdown", own = "chat-features.runner-opencode.local.budgets-costs.repair-cost-recording";
  await expect(armAccountingFault({ executionId: other, binding, env: { PAPERCLIP_RUNNER_E2E_EXECUTION_IDS: JSON.stringify([other]) } })).rejects.toThrow("single selected");
  await expect(armAccountingFault({ executionId: own, binding, env: { PAPERCLIP_RUNNER_E2E_EXECUTION_IDS: JSON.stringify([own, other]) } })).rejects.toThrow("single selected");
  await expect(armAccountingFault({ executionId: own, binding, env: { PAPERCLIP_RUNNER_E2E_EXECUTION_IDS: JSON.stringify([own]) } })).rejects.toThrow("owned runner instance");
  expect(() => accountingFaultSql("abcdefabcdef", { ...binding, issueId: "x'; drop table issues; --" })).toThrow("exact owned binding");
  expect(() => accountingFaultSql("abcdef", binding)).toThrow("exact owned binding");
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("accounting fault against the product's own run accounting", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-accounting-fault-"); db = createDb(database.connectionString); }, 120_000);
  afterAll(async () => { await database?.cleanup(); });

  it("keeps only the faulted task's saved usage ready to record until the trigger is released", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), faultedIssue = randomUUID(), otherIssue = randomUUID(), faultedRun = randomUUID(), otherRun = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Accounting fault", issuePrefix: "ACF" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Morgan", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(issues).values([faultedIssue, otherIssue].map((id, index) => ({ id, companyId, title: `Task ${index}`, status: "done", priority: "medium" })));
    const usage = (issueId: string) => ({ accountingReceiptReady: true, provider: "test", model: "test", billingType: "metered_api", costUsd: 0.01, ledgerScope: { issueId } });
    await db.insert(heartbeatRuns).values([[faultedRun, faultedIssue], [otherRun, otherIssue]].map(([id, issueId]) => ({ id: id!, companyId, agentId, invocationSource: "on_demand" as const,
      status: "succeeded" as const, costAccountingPending: true, finishedAt: new Date(), usageJson: usage(issueId!) })));
    const statements = accountingFaultSql(randomUUID().replaceAll("-", "").slice(0, 12), { companyId, issueId: faultedIssue });
    await db.$client.begin(async tx => { for (const statement of statements.install) await tx.unsafe(statement); });
    const events = (runId: string) => db.$client.unsafe("select id from cost_events where heartbeat_run_id = $1", [runId]);
    const failures = async () => Number((await db.$client.unsafe(statements.failures))[0]?.hits ?? 0);
    try {
      await expect(accountRunCost(db, faultedRun)).rejects.toThrow();
      // The product's own retry keeps failing for the faulted task; other debt in the same company settles.
      expect(await reconcileRunCosts(db)).toEqual({ scanned: 2, accounted: 1 });
      expect(await failures()).toBe(2);
      const [run] = await db.$client.unsafe("select cost_accounting_pending, cost_accounted_at from heartbeat_runs where id = $1", [faultedRun]);
      expect(run!.cost_accounting_pending).toBe(true);
      expect(run!.cost_accounted_at).toBeNull();
      expect(await events(faultedRun)).toHaveLength(0);
      expect(await events(otherRun)).toHaveLength(1);
      expect((await costDataQualityReport(db, companyId, true, { allTime: true })).runs.map(row => [row.runId, row.reason])).toEqual([[faultedRun, "retryable"]]);
      await expect(accountingIntegrityService(db).retry(companyId, faultedRun, "board")).rejects.toThrow();
      for (const statement of statements.release) await db.$client.unsafe(statement);
      expect(await accountingIntegrityService(db).retry(companyId, faultedRun, "board")).toEqual({ accounted: true });
      expect(await events(faultedRun)).toHaveLength(1);
      expect((await costDataQualityReport(db, companyId, true, { allTime: true })).runs).toEqual([]);
      expect(await failures()).toBe(3);
    } finally { for (const statement of statements.remove) await db.$client.unsafe(statement); }
  }, 60_000);
});
