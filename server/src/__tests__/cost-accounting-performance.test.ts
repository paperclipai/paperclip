import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { agents, budgetPolicies, companies, costEvents, createDb, heartbeatRuns, issues, nativeRunFinalizations, projects, type Db } from "@paperclipai/db";
import { billingReconciliationService } from "../services/billing-reconciliation.js";
import { accountingIntegrityService } from "../services/accounting-integrity.js";
import { budgetService, budgetServiceInTransaction } from "../services/budgets.js";
import { withAccountingTransaction } from "../services/accounting-transaction.js";
import { costService } from "../services/costs.js";
import { createCostAccountingReconciler } from "../services/run-cost-accounting.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("accounting performance invariants (PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("accounting-performance-"); db = createDb(database.connectionString); }, 30_000);
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  afterAll(async () => { await database?.cleanup(); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Performance", issuePrefix: `P${randomUUID().slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", adapterType: "process" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Work" }).returning();
    return { company, agent, project };
  }
  function trace() {
    const queries: string[] = [];
    const traced = drizzle(db.$client, { logger: { logQuery(query) { queries.push(query); } } }) as unknown as Db;
    return { traced, ledgerReads: () => queries.filter(query => query.startsWith("select") && query.includes('from "cost_events"')) };
  }

  it("reads health while a writer holds the company lock and keeps counts/items in one snapshot", async () => {
    const f = await fixture();
    const writer = await db.$client.reserve();
    await writer`begin`;
    try {
      await writer`select id from companies where id = ${f.company.id} for no key update`;
      const original = db.transaction.bind(db);
      const transaction = vi.spyOn(db, "transaction").mockImplementation((callback, config) => original(async tx => {
        // A lock attempt fails promptly. There is no elapsed-time pass/fail assertion.
        await tx.execute(sql`set local lock_timeout = '200ms'`);
        const execute = tx.execute.bind(tx);
        let counted = false;
        vi.spyOn(tx, "execute").mockImplementation(query => {
          const result = execute(query);
          const executeRaw = result.execute.bind(result);
          vi.spyOn(result, "execute").mockImplementation(async () => {
            const rows = await executeRaw();
            if (!counted) {
              counted = true;
              // Commit a pending row between health's counts and item list.
              await writer`insert into heartbeat_runs (company_id,agent_id,status,cost_accounting_pending)
                values (${f.company.id},${f.agent.id},'failed',true)`;
              await writer`commit`;
            }
            return rows;
          });
          return result;
        });
        return callback(tx);
      }, config));
      expect(await accountingIntegrityService(db).health(f.company.id)).toMatchObject({ pendingRunCount: 0, items: [] });
      expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "repeatable read", accessMode: "read only" });
      transaction.mockRestore();
      expect(await accountingIntegrityService(db).health(f.company.id)).toMatchObject({ pendingRunCount: 1, items: [expect.objectContaining({ state: "retryable" })] });
    } finally { await writer`rollback`; writer.release(); }
    // Remove the fixture's pending debt before the global recovery tests.
    await db.execute(sql`delete from heartbeat_runs where company_id = ${f.company.id}`);
    await expect(accountingIntegrityService(db).health(randomUUID())).rejects.toThrow("Company not found");
  });

  it("keeps summary incompleteness consistent when an unpriced run settles between reads", async () => {
    const f = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "failed", costAccountingPending: true, finishedAt: new Date() }).returning();
    const writer = await db.$client.reserve();
    await writer`begin`;
    try {
      await writer`select id from companies where id = ${f.company.id} for no key update`;
      const original = db.transaction.bind(db);
      const transaction = vi.spyOn(db, "transaction").mockImplementation((callback, config) => original(async tx => {
        await tx.execute(sql`set local lock_timeout = '200ms'`);
        const select = tx.select.bind(tx);
        vi.spyOn(tx, "select").mockImplementation((...args: Parameters<typeof tx.select>) => {
          const query = select(...args);
          const from = query.from.bind(query);
          vi.spyOn(query, "from").mockImplementation(table => {
            const result = from(table);
            if (table === costEvents) {
              const execute = result.execute.bind(result);
              vi.spyOn(result, "execute").mockImplementation(async () => {
                const rows = await execute();
                await writer`insert into cost_events (company_id,agent_id,provider,model,cost_cents,cost_status,billing_type,occurred_at)
                  values (${f.company.id},${f.agent.id},'fixture','fixture',0,'unpriced','metered_api',now())`;
                await writer`update heartbeat_runs set cost_accounting_pending=false where id=${run.id}`;
                await writer`commit`;
                return rows;
              });
            }
            return result;
          });
          return query;
        });
        return callback(tx);
      }, config));
      expect(await costService(db).summary(f.company.id)).toMatchObject({ pendingRunCount: 1, unpricedEventCount: 0, pricingComplete: false });
      transaction.mockRestore();
      expect(await costService(db).summary(f.company.id)).toMatchObject({ pendingRunCount: 0, unpricedEventCount: 1, pricingComplete: false });
    } finally { await writer`rollback`; writer.release(); }
  });

  it("shares receipt replay across overlapping ticks and releases the guard after replay failure", async () => {
    const reconcile = createCostAccountingReconciler(db);
    const gate = deferred();
    const read = vi.spyOn(fs, "readdir").mockImplementationOnce(async () => { await gate.promise; throw new Error("Spool unavailable"); });
    const first = reconcile(), second = reconcile();
    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    const settled = Promise.allSettled([first, second]);
    gate.resolve();
    expect(await settled).toEqual([expect.objectContaining({ status: "rejected" }), expect.objectContaining({ status: "rejected" })]);
    read.mockRestore();
    expect(await reconcile()).toMatchObject({ scanned: 0, accounted: 0 });
  });

  it("keeps the guard through budget delivery and retries after reconciliation failure", async () => {
    const f = await fixture();
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "company", scopeId: f.company.id, amount: 1 }, "board");
    await costService(db).createEvent(f.company.id, { agentId: f.agent.id, provider: "fixture", model: "fixture", costCents: 1, occurredAt: new Date() });
    const entered = deferred(), gate = deferred();
    const cancelWorkForScope = vi.fn(async () => { entered.resolve(); await gate.promise; });
    const reconcile = createCostAccountingReconciler(db, { cancelWorkForScope });
    const first = reconcile();
    try {
      await entered.promise;
      expect(reconcile()).toBe(first);
      expect(cancelWorkForScope).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(); }
    await first;
    const select = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("Database unavailable"); });
    await expect(reconcile()).rejects.toThrow("Database unavailable");
    select.mockRestore();
    const next = reconcile(); expect(next).not.toBe(first);
    await next;
  });

  it("uses one ledger observation per overview policy and per admission policy", async () => {
    const f = await fixture();
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "company", scopeId: f.company.id, amount: 100 }, "board");
    const { traced, ledgerReads } = trace();
    expect((await budgetService(traced).overview(f.company.id)).policies[0]).toMatchObject({ observedAmountExact: "0.0000000", status: "ok" });
    expect(ledgerReads()).toHaveLength(1);
    await budgetService(traced).getInvocationBlock(f.company.id, f.agent.id);
    expect(ledgerReads()).toHaveLength(2);
  });

  it("shares a scan across mixed policy scopes/windows without trusting monthly projections", async () => {
    const f = await fixture(), foreign = await fixture();
    const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Other", role: "engineer", adapterType: "process" }).returning();
    const values = [
      { scopeType: "company", scopeId: f.company.id, windowKind: "calendar_month_utc", amount: 4 },
      { scopeType: "agent", scopeId: f.agent.id, windowKind: "lifetime", amount: 10 },
      { scopeType: "project", scopeId: f.project.id, windowKind: "lifetime", amount: 9 },
      { scopeType: "agent", scopeId: other.id, windowKind: "calendar_month_utc", amount: 1 },
    ];
    await db.insert(budgetPolicies).values(values.map(value => ({ ...value, companyId: f.company.id })));
    const base = { provider: "fixture", model: "fixture", costCents: 3, occurredAt: new Date() };
    const [event] = await db.insert(costEvents).values([
      { ...base, companyId: f.company.id, agentId: f.agent.id, projectId: f.project.id, costCents: 7, occurredAt: new Date("2000-01-01") },
      { ...base, companyId: f.company.id, agentId: f.agent.id, projectId: f.project.id },
      { ...base, companyId: f.company.id, agentId: other.id },
      { ...base, companyId: foreign.company.id, agentId: foreign.agent.id, costCents: 999 },
    ]).returning();
    await db.update(companies).set({ spentMonthlyCents: 0 }).where(eq(companies.id, f.company.id));
    const { traced, ledgerReads } = trace();
    await withAccountingTransaction(traced, f.company.id, tx => budgetServiceInTransaction(tx).evaluateCostEvent(event));
    expect(ledgerReads()).toHaveLength(1);
    const incidents = await db.execute<{ scope_type: string; amount_observed: string }>(sql`select scope_type,amount_observed::text from budget_incidents where company_id = ${f.company.id} order by scope_type`);
    expect(incidents).toEqual([
      { scope_type: "agent", amount_observed: "10.0000000" },
      { scope_type: "company", amount_observed: "6.0000000" },
      { scope_type: "project", amount_observed: "10.0000000" },
    ]);
  });

  it("keeps unpriced and pending-run guards scoped when batching native recovery observations", async () => {
    const f = await fixture();
    const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Other", role: "engineer", adapterType: "process" }).returning();
    await db.insert(budgetPolicies).values([
      { companyId: f.company.id, scopeType: "company", scopeId: f.company.id, windowKind: "calendar_month_utc", amount: 100 },
      { companyId: f.company.id, scopeType: "agent", scopeId: f.agent.id, windowKind: "lifetime", amount: 100 },
      { companyId: f.company.id, scopeType: "project", scopeId: f.project.id, windowKind: "lifetime", amount: 100 },
    ]);
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Recover" }).returning();
    const [native] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "failed", runtimeMode: "native", nativeIssueId: issue.id, costAccountingPending: true, finishedAt: new Date() }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: f.company.id, runId: native.id, issueId: issue.id, phase: "retryable_failure" });
    const base = { companyId: f.company.id, provider: "fixture", model: "fixture", costCents: 0, occurredAt: new Date() };
    const [event] = await db.insert(costEvents).values([
      { ...base, agentId: f.agent.id, projectId: f.project.id },
      { ...base, agentId: other.id, projectId: f.project.id, occurredAt: new Date("2000-01-01"), costStatus: "unpriced" },
    ]).returning();
    await withAccountingTransaction(db, f.company.id, tx => budgetServiceInTransaction(tx).evaluateCostEvent(event));
    const overview = await budgetService(db).overview(f.company.id);
    expect(overview.activeIncidents.map(row => row.scopeType)).toEqual(["project"]);
    expect(overview.policies).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeType: "company", status: "ok", pendingRunCount: 1, unpricedEventCount: 0 }),
      expect.objectContaining({ scopeType: "agent", status: "ok", pendingRunCount: 1, unpricedEventCount: 0 }),
      expect.objectContaining({ scopeType: "project", status: "hard_stop", pendingRunCount: 0, unpricedEventCount: 1 }),
    ]));
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "failed",
      costAccountingPending: true, finishedAt: new Date(), usageJson: { ledgerScope: { projectId: f.project.id } } });
    await withAccountingTransaction(db, f.company.id, tx => budgetServiceInTransaction(tx).evaluateCostEvent(event));
    expect((await budgetService(db).overview(f.company.id)).activeIncidents.map(row => row.scopeType).sort()).toEqual(["agent", "company", "project"]);
  });


  it("keeps incident amounts and overview windows tied to the observed UTC month across midnight", async () => {
    const f = await fixture();
    await db.insert(budgetPolicies).values({ companyId: f.company.id, scopeType: "company", scopeId: f.company.id,
      windowKind: "calendar_month_utc", amount: 1 });
    const [event] = await db.insert(costEvents).values({ companyId: f.company.id, agentId: f.agent.id,
      provider: "fixture", model: "fixture", costCents: 1, occurredAt: new Date("2026-01-31T12:00:00Z") }).returning();
    const traced = drizzle(db.$client, { logger: { logQuery(query) {
      if (query.startsWith("select") && query.includes('from "cost_events"')) vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    } } }) as unknown as Db;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-31T23:59:59.999Z"));
    await withAccountingTransaction(traced, f.company.id, tx => budgetServiceInTransaction(tx).evaluateCostEvent(event));
    const incident = (await budgetService(db).overview(f.company.id)).activeIncidents[0];
    expect(incident).toMatchObject({ amountObserved: 1, windowStart: new Date("2026-01-01T00:00:00Z"), windowEnd: new Date("2026-02-01T00:00:00Z") });
    vi.setSystemTime(new Date("2026-01-31T23:59:59.999Z"));
    expect((await budgetService(traced).overview(f.company.id)).policies[0]).toMatchObject({
      observedAmountExact: "1.0000000", windowStart: new Date("2026-01-01T00:00:00Z"), windowEnd: new Date("2026-02-01T00:00:00Z"),
    });
    // The next operation uses February and releases the prior month's pause.
    expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
  });


  it.each(["inspection", "invoice comparison"])("does not take the company write lock during %s", async kind => {
    const f = await fixture();
    const invoice = await billingReconciliationService(db).importInvoice(f.company.id, { biller: "fixture", externalId: "invoice", currency: "USD",
      lines: [{ externalId: "line", amountCents: "1", occurredAt: new Date().toISOString() }] }, "board");
    const writer = await db.$client.reserve();
    await writer`begin`;
    try {
      await writer`select id from companies where id = ${f.company.id} for no key update`;
      const original = db.transaction.bind(db);
      const transaction = vi.spyOn(db, "transaction").mockImplementation((callback, config) => original(async tx => {
        await tx.execute(sql`set local lock_timeout = '200ms'`);
        return callback(tx);
      }, config));
      if (kind === "inspection") expect((await accountingIntegrityService(db).inspect(f.company.id)).findings).toEqual([]);
      else expect((await billingReconciliationService(db).reconcile(f.company.id, invoice.id)).lines).toHaveLength(1);
      expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "repeatable read", accessMode: "read only" });
    } finally { await writer`rollback`; writer.release(); }
  });

});
