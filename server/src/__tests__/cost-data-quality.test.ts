import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { appearanceForPalette } from "@paperclipai/shared";
import { agents, companies, costEvents, createDb, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { costDataQualityReport, RECEIPT_WAIT_MS } from "../services/cost-data-quality.js";
import { accountingIntegrityService } from "../services/accounting-integrity.js";
import { costService } from "../services/costs.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const now = new Date("2026-10-09T13:00:00Z");
describe("actionable cost data quality", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-cost-quality-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function company() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Costs", issuePrefix: `Q${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", role: "engineer", adapterType: "codex_local" });
    return { companyId, agentId };
  }
  async function event(owner: Awaited<ReturnType<typeof company>>, overrides: Partial<typeof costEvents.$inferInsert> = {}) {
    const [row] = await db.insert(costEvents).values({ ...owner, provider: "openai", model: "gpt-6-astra", billingType: "metered_api", costStatus: "unpriced", costCents: 0, occurredAt: now, ...overrides }).returning();
    return row;
  }
  async function run(owner: Awaited<ReturnType<typeof company>>, overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [row] = await db.insert(heartbeatRuns).values({ ...owner, status: "failed", costAccountingPending: true, createdAt: now, finishedAt: now, usageJson: { accountingReceiptReady: false }, ...overrides }).returning();
    return row;
  }

  it("distinguishes billing, model and price gaps, excluding normal subscription/credit/fixed usage", async () => {
    const owner = await company();
    const unknown = await event(owner, { billingType: "unknown", costStatus: "reported", costCents: 21 });
    const missingModel = await event(owner, { model: "unknown" });
    const missingPrice = await event(owner);
    await event(owner, { billingType: "subscription_included" });
    await event(owner, { billingType: "credits", costStatus: "reported" });
    await event(owner, { billingType: "fixed", costStatus: "reported" });
    await event(owner, { costStatus: "estimated", costCents: 3 });
    const report = await costDataQualityReport(db, owner.companyId, true, undefined, now);
    expect(report.events).toHaveLength(3);
    expect(report.events.every(row => row.occurredAt === now.toISOString())).toBe(true);
    expect(report.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: unknown.id, reason: "unknown_billing", agentName: "Codie" }),
      expect.objectContaining({ id: missingModel.id, reason: "missing_model" }),
      expect.objectContaining({ id: missingPrice.id, reason: "missing_price" }),
    ]));
    const summary = await costService(db).summary(owner.companyId, { allTime: true });
    expect(summary.unknownBillingEventCount).toBe(1);
    expect(summary.spendCents).toBe(24); // Unknown billing retains its reported dollars.
    expect(summary.unpricedEventCount).toBe(2); // Included subscription usage is not a price gap.
    const providerRows = await costService(db).byProvider(owner.companyId, { allTime: true });
    expect(providerRows.reduce((count, row) => count + row.eventCount!, 0)).toBe(7);
    expect(providerRows.reduce((count, row) => count + row.estimatedEventCount!, 0)).toBe(1);
    expect(providerRows.reduce((count, row) => count + row.unpricedEventCount!, 0)).toBe(2);
    expect(await costService(db).byBiller(owner.companyId, { allTime: true })).toEqual([
      expect.objectContaining({ eventCount: 7, estimatedEventCount: 1, unpricedEventCount: 2, costCents: 24 }),
    ]);
  });

  it("uses sparse ordered indexes for old gaps behind thousands of healthy records", async () => {
    const owner = await company();
    await db.execute(sql`insert into cost_events (company_id,agent_id,provider,model,billing_type,cost_status,cost_cents,occurred_at)
      select ${owner.companyId}::uuid,${owner.agentId}::uuid,'openai','gpt-6-astra','metered_api','reported',1,
        ${now.toISOString()}::timestamptz - n * interval '1 second' from generate_series(1,5000) n`);
    await db.execute(sql`insert into heartbeat_runs (company_id,agent_id,status,created_at,finished_at,cost_accounting_pending)
      select ${owner.companyId}::uuid,${owner.agentId}::uuid,'succeeded',${now.toISOString()}::timestamptz,
        ${now.toISOString()}::timestamptz - n * interval '1 second',false from generate_series(1,5000) n`);
    const old = new Date(now.getTime() - 10_000_000);
    await event(owner, { occurredAt: old });
    await event(owner, { occurredAt: old, billingType: "unknown", costStatus: "reported" });
    await run(owner, { finishedAt: old });
    await db.execute(sql`analyze cost_events`);
    await db.execute(sql`analyze heartbeat_runs`);
    const plans: string[] = [];
    // Explain the actual production statements, with the normal planner enabled.
    const explainingDb = new Proxy(db, {
      get(target, key) {
        if (key === "transaction") return (work: (tx: typeof db) => Promise<unknown>, options: Parameters<typeof db.transaction>[1]) =>
          target.transaction(tx => work(new Proxy(tx, {
            get(transaction, property) {
              if (property === "execute") return async (query: Parameters<typeof tx.execute>[0]) => {
                plans.push(JSON.stringify(await transaction.execute(sql`explain (analyze, buffers, format json) ${query}`)));
                return transaction.execute(query);
              };
              const value = Reflect.get(transaction, property);
              return typeof value === "function" ? value.bind(transaction) : value;
            },
          }) as unknown as typeof db), options);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const report = await costDataQualityReport(explainingDb, owner.companyId, false, { allTime: true }, now);
    expect(report.events).toHaveLength(2);
    expect(report.runs).toHaveLength(1);
    expect(plans).toHaveLength(2);
    expect(plans[0]).toContain("cost_events_data_quality_idx");
    expect(plans[1]).toContain("heartbeat_runs_cost_data_quality_idx");
    expect(plans.join(" ")).not.toContain("Rows Removed by Filter\":5000");
  });

  it("enforces company and period boundaries, including month-to-date and inclusive endpoints", async () => {
    const owner = await company(), other = await company();
    const start = new Date("2026-10-01T00:00:00Z");
    const first = await event(owner, { occurredAt: start });
    const last = await event(owner);
    const past = await event(owner, { occurredAt: new Date(start.getTime() - 1) });
    await event(owner, { occurredAt: new Date(now.getTime() + 1) });
    await event(other);
    await run(other);
    expect((await costDataQualityReport(db, owner.companyId, false, undefined, now)).events.map(row => row.id)).toEqual([last.id, first.id]);
    expect((await costDataQualityReport(db, owner.companyId, true, { from: start, to: now }, now)).events).toHaveLength(2);
    expect((await costDataQualityReport(db, owner.companyId, true, { from: new Date(past.occurredAt), to: new Date(past.occurredAt) }, now)).events.map(row => row.id)).toEqual([past.id]);
    const all = await costDataQualityReport(db, owner.companyId, false, { allTime: true }, now);
    expect(all.events).toHaveLength(4);
    expect(all.runs).toEqual([]);
    expect(all.canRetry).toBe(false);
    await expect(costDataQualityReport(db, randomUUID(), true)).rejects.toThrow("Company not found");
  });

  it("includes the agent's saved appearance for both pricing and receipt gaps", async () => {
    const owner = await company();
    const appearance = appearanceForPalette("deep-tide");
    await db.update(agents).set({ appearance }).where(eq(agents.id, owner.agentId));
    await event(owner);
    await run(owner);
    const report = await costDataQualityReport(db, owner.companyId, true, undefined, now);
    expect(report.events[0].agentAppearance).toEqual(appearance);
    expect(report.runs[0].agentAppearance).toEqual(appearance);
  });

  it("changes waiting copy at fifteen minutes without settling or mutating the run", async () => {
    const owner = await company();
    const pending = await run(owner, { accountingLastError: "SECRET provider command", resultJson: { credential: "SECRET" } });
    expect((await costDataQualityReport(db, owner.companyId, true, undefined, now)).runs[0].reason).toBe("waiting_for_receipt");
    const report = await costDataQualityReport(db, owner.companyId, true, undefined, new Date(now.getTime() + RECEIPT_WAIT_MS));
    expect(report.runs[0].reason).toBe("receipt_unavailable");
    expect(Object.keys(report.runs[0]).sort()).toEqual(["agentId", "agentName", "agentAppearance", "id", "model", "occurredAt", "provider", "reason", "runId"].sort());
    expect(JSON.stringify(report)).not.toContain("SECRET");
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, pending.id));
    expect(saved.costAccountingPending).toBe(true);
    expect(saved.costAccountedAt).toBeNull();
    expect(saved.accountingAttemptCount).toBe(0);
  });

  it("offers retry only at the writer's proven receipt boundary", async () => {
    const owner = await company();
    const ready = await run(owner, { usageJson: { accountingReceiptReady: true } });
    const noWork = await run(owner, { usageJson: { accountingReceiptReady: false, accountingProviderWorkStarted: false } });
    const resultProof = await run(owner, { resultJson: { executionRecovery: { providerWorkStarted: false } } });
    const captureFailed = await run(owner, { usageJson: { accountingReceiptReady: true, accountingCaptureFailed: true, accountingProviderWorkStarted: false } });
    const invalidProof = await run(owner, { usageJson: { accountingReceiptReady: false, accountingProviderWorkStarted: "false" } });
    const acknowledged = await run(owner, { costAccountedAt: now });
    await run(owner, { status: "running" });
    await run(owner, { status: "queued" });
    await run(owner, { costAccountingPending: false });
    const report = await costDataQualityReport(db, owner.companyId, true, undefined, now);
    expect(report.runs).toHaveLength(6);
    for (const row of [ready, noWork, resultProof, acknowledged]) expect(report.runs.find(item => item.id === row.id)?.reason).toBe("retryable");
    expect(report.runs.find(item => item.id === captureFailed.id)?.reason).toBe("waiting_for_receipt");
    expect(report.runs.find(item => item.id === invalidProof.id)?.reason).toBe("waiting_for_receipt");
    const integrity = accountingIntegrityService(db);
    expect(await integrity.retry(owner.companyId, captureFailed.id, "board")).toEqual({ accounted: false });
    expect(await integrity.retry(owner.companyId, noWork.id, "board")).toEqual({ accounted: true });
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, owner.companyId))).toEqual([]);
  });

  it("does not offer retry while a native coordinator can still resume provider work", async () => {
    const owner = await company();
    const [issue] = await db.insert(issues).values({ companyId: owner.companyId, title: "Native task" }).returning();
    const pending = await run(owner, { nativeIssueId: issue.id, runtimeMode: "native", usageJson: { accountingReceiptReady: true } });
    await db.insert(nativeRunFinalizations).values({ companyId: owner.companyId, runId: pending.id, issueId: issue.id, phase: "recovering" });
    expect((await costDataQualityReport(db, owner.companyId, true, undefined, now)).runs[0].reason).toBe("waiting_for_receipt");
    expect(await accountingIntegrityService(db).retry(owner.companyId, pending.id, "board")).toEqual({ accounted: false });
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure" }).where(eq(nativeRunFinalizations.runId, pending.id));
    expect((await costDataQualityReport(db, owner.companyId, true, undefined, now)).runs[0].reason).toBe("retryable");
  });

  it("bounds each category independently and reports truncation", async () => {
    const owner = await company();
    for (let i = 0; i < 26; i++) {
      await event(owner, { occurredAt: new Date(now.getTime() - i * 1000) });
      await run(owner, { finishedAt: new Date(now.getTime() - i * 1000) });
    }
    const report = await costDataQualityReport(db, owner.companyId, true, undefined, now);
    expect(report.events).toHaveLength(25);
    expect(report.runs).toHaveLength(25);
    expect(report.hasMoreEvents).toBe(true);
    expect(report.hasMoreRuns).toBe(true);
    expect(new Date(report.events[24].occurredAt).getTime()).toBe(now.getTime() - 24_000);
  });

  it("retry cannot invent a missing receipt; a late receipt is recorded exactly once", async () => {
    const owner = await company();
    const pending = await run(owner);
    const integrity = accountingIntegrityService(db);
    expect(await integrity.retry(owner.companyId, pending.id, "board")).toEqual({ accounted: false });
    expect((await db.select().from(costEvents).where(eq(costEvents.companyId, owner.companyId)))).toEqual([]);
    await db.update(heartbeatRuns).set({ usageJson: { accountingReceiptReady: true, provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-6-astra", costUsd: 0.21, inputTokens: 10, outputTokens: 2 } }).where(eq(heartbeatRuns.id, pending.id));
    expect((await costDataQualityReport(db, owner.companyId, true, { allTime: true }, now)).runs[0].reason).toBe("retryable");
    expect(await integrity.retry(owner.companyId, pending.id, "board")).toEqual({ accounted: true });
    expect(await integrity.retry(owner.companyId, pending.id, "board")).toEqual({ accounted: false });
    const charges = await db.select().from(costEvents).where(eq(costEvents.companyId, owner.companyId));
    expect(charges).toHaveLength(1);
    expect(charges[0].costCents).toBe(21);
    expect((await costDataQualityReport(db, owner.companyId, true, { allTime: true }, now)).runs).toEqual([]);
    const other = await company();
    await expect(integrity.retry(other.companyId, pending.id, "board")).rejects.toThrow("Accounting run not found");
  });
});
