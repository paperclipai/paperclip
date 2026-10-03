import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, agentRuntimeState, budgetReservations, companies, costEvents, costAdjustments, createDb, heartbeatRuns, runUsageReceipts } from "@paperclipai/db";
import { accountingIntegrityService } from "../services/accounting-integrity.js";
import { billingReconciliationService } from "../services/billing-reconciliation.js";
import { budgetService } from "../services/budgets.js";
import { reserveRunBudget } from "../services/budget-reservations.js";
import { costService } from "../services/costs.js";
import { accountRunCost, reconcileRunCosts } from "../services/run-cost-accounting.js";
import { createRunUsageRecorder, persistUsageReceipt, replayUsageReceipts, spoolUsageReceipt, type UsageReceiptEnvelope } from "../services/usage-receipts.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("accounting operations and durable receipts (PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let directory: string;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-accounting-operators-"); db = createDb(database.connectionString); directory = await fs.mkdtemp(path.join(os.tmpdir(), "accounting-spool-test-")); }, 30_000);
  afterAll(async () => { await database?.cleanup(); await fs.rm(directory, { recursive: true, force: true }); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Accounting", issuePrefix: `A${randomUUID().slice(0,7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", adapterType: "process", status: "idle" }).returning();
    return { company, agent };
  }
  async function runFor(f: Awaited<ReturnType<typeof fixture>>, status = "running") {
    return (await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, invocationSource: "on_demand", status }).returning())[0];
  }
  async function receipt(f: Awaited<ReturnType<typeof fixture>>, costCents: number | string = "1.1234567") {
    return costService(db).createEvent(f.company.id, { agentId: f.agent.id, provider: "test", model: "test-model", costCents, occurredAt: new Date(), idempotencyKey: randomUUID() });
  }

  it("keeps the last nanocent exact in storage, reports, projections and admission", async () => {
    const f = await fixture();
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 2_000_000_000 }, "board");
    await receipt(f, "1999999999.9999999");
    expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    expect((await costService(db).summary(f.company.id)).spendCentsExact).toBe("1999999999.9999999");
    await receipt(f, "0.0000001");
    expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).not.toBeNull();
    const huge = await fixture();
    await receipt(huge, "99999999999999999.0000001");
    expect((await accountingIntegrityService(db).inspect(huge.company.id)).findings).toEqual([]);
  });

  it("admits only affordable concurrent reservations and settles atomically with the receipt", async () => {
    const f = await fixture(); const runs = await Promise.all(Array.from({ length: 4 }, () => runFor(f)));
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "company", scopeId: f.company.id, amount: 10, reservationCents: "6" }, "board");
    const results = await Promise.allSettled(runs.map(run => reserveRunBudget(db, f.company.id, run.id, null)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const index = results.findIndex(r => r.status === "fulfilled"); const run = runs[index];
    expect((await accountingIntegrityService(db).health(f.company.id)).heldReservationCents).toBe("6.0000000");
    await expect(reserveRunBudget(db, f.company.id, run.id, null)).rejects.toThrow("already reserved");
    // Reservations never disappear merely because wall-clock time passed.
    await db.update(budgetReservations).set({ createdAt: new Date("2000-01-01") }).where(eq(budgetReservations.runId, run.id));
    const denied = runs[(index + 1) % runs.length];
    await expect(reserveRunBudget(db, f.company.id, denied.id, null)).rejects.toThrow("reserved");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), usageJson: { costUsdExact: "0.04", billingType: "metered_api", accountingReceiptReady: true } }).where(eq(heartbeatRuns.id, run.id));
    expect(await accountRunCost(db, run.id)).toBe(true);
    expect((await accountingIntegrityService(db).health(f.company.id)).heldReservationCents).toBe("0.0000000");
    await reserveRunBudget(db, f.company.id, denied.id, null);
    expect((await accountingIntegrityService(db).inspect(f.company.id)).findings).toEqual([]);
  });

  it("keeps an interrupted partial receipt pending and settles its reservation when evidence becomes complete", async () => {
    const f = await fixture(); const run = await runFor(f);
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100, reservationCents: "10" }, "board");
    await reserveRunBudget(db, f.company.id, run.id, null);
    const usage = { accountingReceiptReady: false, costUsdExact: "0.01", inputTokens: 5, provider: "test", billingType: "metered_api" };
    await db.update(heartbeatRuns).set({ status: "interrupted", usageJson: usage }).where(eq(heartbeatRuns.id, run.id));
    const integrity = accountingIntegrityService(db);
    expect((await integrity.health(f.company.id)).pendingRunCount).toBe(1);
    expect((await integrity.health(f.company.id)).items[0]).toMatchObject({ runId: run.id, state: "waiting_for_receipt" });
    expect((await costService(db).summary(f.company.id)).pendingRunCount).toBe(1);
    expect((await integrity.inspect(f.company.id)).findings.some(f => f.kind === "missing_acknowledgement")).toBe(true);
    expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).not.toBeNull();
    expect(await accountRunCost(db, run.id)).toBe(false);
    expect((await integrity.health(f.company.id)).heldReservationCents).toBe("10.0000000");
    await db.update(heartbeatRuns).set({ usageJson: { ...usage, accountingReceiptReady: true } }).where(eq(heartbeatRuns.id, run.id));
    await reconcileRunCosts(db);
    expect((await costService(db).summary(f.company.id))).toMatchObject({ pendingRunCount: 0, spendCents: 1 });
    expect((await integrity.health(f.company.id)).heldReservationCents).toBe("0.0000000");
    expect((await integrity.inspect(f.company.id)).findings).toEqual([]);
    expect(await accountRunCost(db, run.id)).toBe(false);
  });

  it("independently detects and repairs corrupted projections with a stale-review guard and audit", async () => {
    const f = await fixture(); const run = await runFor(f, "succeeded");
    await db.update(heartbeatRuns).set({ costAccountingPending: true, usageJson: { accountingReceiptReady: true, costUsdExact: "0.012345678", inputTokens: 7, cachedInputTokens: 3, outputTokens: 11 } }).where(eq(heartbeatRuns.id, run.id));
    await accountRunCost(db, run.id);
    const service = accountingIntegrityService(db);
    expect((await service.inspect(f.company.id)).findings).toEqual([]);
    await db.update(companies).set({ spentMonthlyCents: 999 }).where(eq(companies.id, f.company.id));
    await db.update(agents).set({ spentMonthlyCents: 888 }).where(eq(agents.id, f.agent.id));
    await db.update(agentRuntimeState).set({ totalCostCents: 777, totalInputTokens: 600 }).where(eq(agentRuntimeState.agentId, f.agent.id));
    const review = await service.inspect(f.company.id);
    expect(review.findings.map(f => f.kind)).toEqual(["agent_projection", "company_projection", "runtime_projection"]);
    await db.update(companies).set({ spentMonthlyCents: 998 }).where(eq(companies.id, f.company.id));
    await expect(service.repair(f.company.id, review.fingerprint, "Fix drift", "board")).rejects.toThrow("changed since inspection");
    const fresh = await service.inspect(f.company.id);
    expect((await service.repair(f.company.id, fresh.fingerprint, "Fix drift", "board")).findings).toEqual([]);
    const audit = await db.execute(sql`select details from activity_log where company_id = ${f.company.id} and action = 'accounting.projections_repaired'`);
    expect(audit).toHaveLength(1);
    expect(await accountRunCost(db, run.id)).toBe(false);
    expect((await service.inspect(f.company.id)).findings).toEqual([]);
  });

  it.each(["before", "after", "concurrent"])("accounts separate run charges %s the provider receipt without false integrity findings", async (timing) => {
    const f = await fixture(); const run = await runFor(f, "succeeded");
    await db.update(heartbeatRuns).set({ costAccountingPending: true, usageJson: { costUsdExact: "0.01", inputTokens: 7, cachedInputTokens: 3, outputTokens: 11 } }).where(eq(heartbeatRuns.id, run.id));
    const extra = { agentId: f.agent.id, heartbeatRunId: run.id, provider: "test", model: "tool", costCents: "0.1234567", inputTokens: 2, cachedInputTokens: 4, outputTokens: 6, occurredAt: new Date(), idempotencyKey: "extra-charge" };
    const costs = costService(db);
    if (timing === "before") await costs.createEvent(f.company.id, extra);
    if (timing === "concurrent") await Promise.all([costs.createEvent(f.company.id, extra), accountRunCost(db, run.id)]);
    else await accountRunCost(db, run.id);
    const event = await costs.createEvent(f.company.id, extra);
    // Replaying either source cannot count it twice.
    await costs.createEvent(f.company.id, extra);
    expect(await accountRunCost(db, run.id)).toBe(false);
    const [runtime] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agent.id));
    expect(runtime).toMatchObject({ totalCostCents: 1.1234567, totalInputTokens: 9, totalCachedInputTokens: 7, totalOutputTokens: 17 });
    const integrity = accountingIntegrityService(db);
    expect((await integrity.inspect(f.company.id)).findings).toEqual([]);
    await billingReconciliationService(db).adjust(f.company.id, event.id, { idempotencyKey: "extra-correction", expectedCents: "0.1234567", correctedCents: "0.2234567", reason: "Provider correction", pricing: { source: "provider_invoice", evidence: "external charge" } }, "board");
    expect((await costs.summary(f.company.id)).spendCentsExact).toBe("1.2234567");
    expect((await integrity.inspect(f.company.id)).findings).toEqual([]);
    await db.update(agentRuntimeState).set({ totalCostCents: 999 }).where(eq(agentRuntimeState.agentId, f.agent.id));
    const review = await integrity.inspect(f.company.id);
    expect(review.findings.map(f => f.kind)).toEqual(["runtime_projection"]);
    expect((await integrity.repair(f.company.id, review.fingerprint, "Fix drift", "board")).findings).toEqual([]);
    // An extra charge cannot conceal a missing original provider receipt.
    await db.delete(costEvents).where(and(eq(costEvents.heartbeatRunId, run.id), eq(costEvents.idempotencyKey, `heartbeat:${run.id}:final`)));
    expect((await integrity.inspect(f.company.id)).findings.some(f => f.kind === "missing_receipt")).toBe(true);
  });

  it("rejects public charges that impersonate the provider receipt namespace", async () => {
    const f = await fixture();
    await expect(costService(db).createEvent(f.company.id, { agentId: f.agent.id, provider: "test", model: "test", costCents: 1, occurredAt: new Date(), idempotencyKey: "heartbeat:fake:final" })).rejects.toThrow("reserved");
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toEqual([]);
  });

  it("imports invoices idempotently and appends reviewed corrections without losing the provider receipt", async () => {
    const f = await fixture();
    const originalPricing = { source: "rate_card" as const, version: "2026-09-01", inputCentsPerMillion: "12.3456789" };
    const event = await costService(db).createEvent(f.company.id, { agentId: f.agent.id, provider: "test", model: "test-model",
      costCents: "1.1234567", occurredAt: new Date(), pricingProvenance: originalPricing });
    const service = billingReconciliationService(db);
    const invoice = { biller: "test", externalId: "invoice-1", currency: "usd", lines: [{ externalId: "request-1", amountCents: "2.0000001", occurredAt: new Date().toISOString(), costEventId: event.id }] };
    const imported = await service.importInvoice(f.company.id, invoice, "board");
    expect((await service.importInvoice(f.company.id, invoice, "board")).id).toBe(imported.id);
    await expect(service.importInvoice(f.company.id, { ...invoice, currency: "EUR" }, "board")).rejects.toThrow("different contents");
    const review = await service.reconcile(f.company.id, imported.id);
    expect(review.lines[0]).toMatchObject({ status: "difference", recordedCents: "1.1234567", differenceCents: "0.8765434" });
    const input = { idempotencyKey: "fix-1", expectedCents: "1.1234567", correctedCents: "2.0000001", invoiceLineId: review.lines[0].id, reason: "Provider invoice", pricing: { source: "provider_invoice" as const, evidence: "invoice-1" } };
    const corrected = await service.adjust(f.company.id, event.id, input, "board");
    expect(corrected.previousPricing).toEqual(originalPricing);
    expect(corrected.pricing).toEqual(input.pricing);
    expect((await service.adjust(f.company.id, event.id, input, "board")).id).toBe(corrected.id);
    expect((await service.reconcile(f.company.id, imported.id)).lines[0].status).toBe("matched");
    const [row] = await db.select().from(costEvents).where(eq(costEvents.id, event.id));
    expect(row.reportedCostCents).toBe("1.1234567"); expect(row.receiptHash).toBe(event.receiptHash);
    expect((await service.adjustments(f.company.id, event.id))).toHaveLength(1);
    expect((await accountingIntegrityService(db).inspect(f.company.id)).findings).toEqual([]);
    await expect(service.adjust(f.company.id, event.id, { ...input, idempotencyKey: "stale" }, "board")).rejects.toThrow("changed since review");
    const second = await service.adjust(f.company.id, event.id, { ...input, invoiceLineId: undefined, idempotencyKey: "fix-2",
      expectedCents: "2.0000001", correctedCents: "3", pricing: { source: "operator" }, reason: "Reviewed updated evidence" }, "board");
    expect(second.previousPricing).toEqual(input.pricing);
    expect((await service.adjustments(f.company.id, event.id))).toHaveLength(2);
  });

  it("refuses cross-company references, guesses, duplicate invoice matches, and currency conversion", async () => {
    const f = await fixture(), foreign = await fixture(); const event = await receipt(f);
    const service = billingReconciliationService(db);
    const base = { biller: "test", externalId: "invoice", currency: "USD", lines: [{ externalId: "line", amountCents: "1", occurredAt: new Date().toISOString(), costEventId: event.id }] };
    await expect(service.importInvoice(foreign.company.id, base, "board")).rejects.toThrow("not found");
    await expect(service.adjust(foreign.company.id, event.id, { idempotencyKey: "bad", expectedCents: 0, correctedCents: 1, reason: "test", pricing: { source: "operator" } }, "board")).rejects.toThrow("not found");
    const duplicate = await service.importInvoice(f.company.id, { ...base, lines: [...base.lines, { ...base.lines[0], externalId: "second" }] }, "board");
    expect((await service.reconcile(f.company.id, duplicate.id)).lines.map(l => l.status)).toEqual(["ambiguous", "ambiguous"]);
    const eur = await service.importInvoice(f.company.id, { ...base, externalId: "eur", currency: "EUR" }, "board");
    expect((await service.reconcile(f.company.id, eur.id)).lines[0].status).toBe("unsupported_currency");
    await expect(service.reconcile(foreign.company.id, eur.id)).rejects.toThrow("not found");
    expect(await db.select().from(costAdjustments).where(eq(costAdjustments.companyId, f.company.id))).toEqual([]);
  });

  it.each(["provider_invoice", "rate_card"] as const)("prices unknown usage from %s and preserves its estimate status", async (source) => {
    const f = await fixture(); const run = await runFor(f, "failed");
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 10 }, "board");
    await db.update(heartbeatRuns).set({ costAccountingPending: true, usageJson: { accountingReceiptReady: true, inputTokens: 9, provider: "test" } }).where(eq(heartbeatRuns.id, run.id));
    await accountRunCost(db, run.id);
    expect((await accountingIntegrityService(db).health(f.company.id)).unpricedEventCount).toBe(1);
    expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).not.toBeNull();
    const [event] = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, run.id));
    await billingReconciliationService(db).adjust(f.company.id, event.id, { idempotencyKey: "pricing", expectedCents: 0, correctedCents: "1.0000001", reason: "Verified provider invoice", pricing: { source, evidence: "billing-export" } }, "board");
    expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    expect((await accountingIntegrityService(db).health(f.company.id)).unpricedEventCount).toBe(0);
    expect((await costService(db).summary(f.company.id)).estimatedEventCount).toBe(source === "rate_card" ? 1 : 0);
    expect((await accountingIntegrityService(db).inspect(f.company.id)).findings).toEqual([]);
  });

  it("spools a receipt during database failure, replays once, fences old sources, and preserves partial uncertainty", async () => {
    const f = await fixture(); const run = await runFor(f); const spool = path.join(directory, randomUUID());
    const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType: "process" }, spool);
    const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("Database unavailable"));
    await recorder.capture({ costUsdExact: "0.010000001", usage: { inputTokens: 7, outputTokens: 2 }, complete: false });
    transaction.mockRestore();
    expect((await fs.readdir(spool)).filter(n => n.endsWith(".json"))).toHaveLength(1);
    expect(await replayUsageReceipts(db, spool)).toEqual({ replayed: 1, failed: 0 });
    expect(await replayUsageReceipts(db, spool)).toEqual({ replayed: 0, failed: 0 });
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, run.id));
    expect(await accountRunCost(db, run.id)).toBe(false);
    expect((await accountingIntegrityService(db).health(f.company.id)).items[0].state).toBe("waiting_for_receipt");
    await recorder.complete({ exitCode: 0, signal: null, timedOut: false, costUsdExact: "0.010000001", usage: { inputTokens: 7, outputTokens: 2 } });
    expect(await accountRunCost(db, run.id)).toBe(true);
    const receipts = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, run.id));
    expect(receipts).toHaveLength(2);
    await persistUsageReceipt(db, receipts[0].receiptJson as UsageReceiptEnvelope);
    expect((await costService(db).summary(f.company.id)).spendCentsExact).toBe("1.0000001");
    const tampered = { ...(receipts[0].receiptJson as UsageReceiptEnvelope), receipt: { complete: true, costUsd: 123 } };
    await expect(persistUsageReceipt(db, tampered)).rejects.toThrow("Conflicting usage");
  });

  it("retains invalid spool evidence and bounds recovery work", async () => {
    const spool = path.join(directory, randomUUID()); await fs.mkdir(spool);
    await fs.writeFile(path.join(spool, "bad.json"), "not json");
    expect(await replayUsageReceipts(db, spool, 1)).toEqual({ replayed: 0, failed: 1 });
    expect((await fs.readdir(spool))[0]).toMatch(/^retry-/);
    expect(await replayUsageReceipts(db, path.join(spool, "missing"))).toEqual({ replayed: 0, failed: 0 });
    const f = await fixture(); const run = await runFor(f);
    const unknown: UsageReceiptEnvelope = { schema: "paperclip/accounting-receipt/v1", id: randomUUID(), companyId: f.company.id, runId: run.id,
      sourceId: randomUUID(), sequence: 1, receivedAt: new Date().toISOString(), adapterType: "process", receipt: { complete: true, costUsd: 10 } };
    await spoolUsageReceipt(unknown, spool);
    expect((await replayUsageReceipts(db, spool, 1)).replayed).toBe(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].costAccountingPending).toBe(false);
  });
});
