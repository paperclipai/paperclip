import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, agentRuntimeState, budgetReservations, companies, costEvents, costAdjustments, createDb, heartbeatRuns, runUsageReceipts, issues, nativeRunFinalizations } from "@paperclipai/db";
import { accountingIntegrityService } from "../services/accounting-integrity.js";
import { billingReconciliationService } from "../services/billing-reconciliation.js";
import { budgetService } from "../services/budgets.js";
import { reserveRunBudget } from "../services/budget-reservations.js";
import { costService } from "../services/costs.js";
import { accountRunCost, reconcileRunCosts } from "../services/run-cost-accounting.js";
import { createRunUsageRecorder, persistUsageReceipt, replayUsageReceipts, spoolUsageReceipt, type UsageReceiptEnvelope } from "../services/usage-receipts.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createUsageCheckpointLog } from "@paperclipai/adapter-utils/usage-checkpoint";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { createClaudeStreamParser, parseClaudeStreamJson } from "../../../packages/adapters/claude-local/src/server/parse.js";

import { parseCodexJsonl } from "../../../packages/adapters/codex-local/src/server/parse.js";
import { parseOpenCodeJsonl } from "../../../packages/adapters/opencode-local/src/server/parse.js";
import { parseCursorJsonl } from "../../../packages/adapters/cursor-local/src/server/parse.js";

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

  it("reuses a held native reservation only for its current recovery lease", async () => {
    const f = await fixture(); const run = await runFor(f);
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Recover" }).returning();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ companyId: f.company.id, runId: run.id, issueId: issue.id,
      phase: "running", leaseOwner: "successor", leaseExpiresAt: new Date(Date.now() + 60_000) });
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "company", scopeId: f.company.id, amount: 10, reservationCents: "6" }, "board");
    const original = await reserveRunBudget(db, f.company.id, run.id, null);
    await expect(reserveRunBudget(db, f.company.id, run.id, null)).rejects.toThrow("already reserved");
    await expect(reserveRunBudget(db, f.company.id, run.id, null, {}, "stale-owner")).rejects.toThrow("already reserved");
    expect(await reserveRunBudget(db, f.company.id, run.id, null, {}, "successor")).toEqual({ ...original, reused: true });
    expect((await accountingIntegrityService(db).health(f.company.id)).heldReservationCents).toBe("6.0000000");
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, run.id));
    await expect(reserveRunBudget(db, f.company.id, run.id, null, {}, "successor")).rejects.toThrow("already reserved");
  });

  it.each([false, true])("settles absent usage without hiding explicit unknown pricing (%s)", async (unpriced) => {
    const f = await fixture(); const run = await runFor(f);
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100, reservationCents: "10" }, "board");
    await reserveRunBudget(db, f.company.id, run.id, null);
    const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType: "process" }, directory);
    await recorder.complete({ exitCode: 0, signal: null, timedOut: false, ...(unpriced ? { provider: "moonshot", costStatus: "unpriced" as const, costUsd: null } : {}) });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    expect(await accountRunCost(db, run.id)).toBe(true);
    expect((await accountingIntegrityService(db).health(f.company.id)).heldReservationCents).toBe("0.0000000");
    const summary = await costService(db).summary(f.company.id);
    expect(summary.unpricedEventCount).toBe(unpriced ? 1 : 0);
    const block = await budgetService(db).getInvocationBlock(f.company.id, f.agent.id);
    if (unpriced) expect(block).not.toBeNull(); else expect(block).toBeNull();
  });

  it.each([
    ...["turn.failed", "error", "turn.completed"].map(type => ({
      label: `Codex ${type}`, adapterType: "codex_local", parse: () => parseCodexJsonl(JSON.stringify({ type })),
    })),
    ...["result", "step_finish"].map(type => ({
      label: `Cursor ${type}`, adapterType: "cursor", parse: () => parseCursorJsonl(JSON.stringify({ type })),
    })),
    { label: "OpenCode step_finish", adapterType: "opencode_local", parse: () => parseOpenCodeJsonl(JSON.stringify({ type: "step_finish" })) },
  ])("keeps $label without usage unpriced and its reservation held", async ({ adapterType, parse }) => {
    const f = await fixture(); const run = await runFor(f);
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100, reservationCents: "10" }, "board");
    await reserveRunBudget(db, f.company.id, run.id, null);
    const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType }, directory);
    const parsed = parse();
    const accounting = { provider: "openai", biller: "openai", billingType: "api" as const, model: "gpt-6-astra", usageBasis: "per_run" as const,
      usage: parsed.usageReported ? parsed.usage : undefined, costUsd: null, costStatus: "unpriced" as const };
    await recorder.capture({ ...accounting, complete: parsed.usageComplete });
    await recorder.complete({ ...accounting, exitCode: 1, signal: null, timedOut: false, usageComplete: parsed.usageComplete });
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(stored.usageJson).toMatchObject({ costUsd: null, costUsdExact: null, costStatus: "unpriced", accountingReceiptReady: false });
    expect(await accountRunCost(db, run.id)).toBe(false);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toEqual([]);
    expect((await accountingIntegrityService(db).health(f.company.id)).heldReservationCents).toBe("10.0000000");
    expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).not.toBeNull();
  });

  it("recovers a flushed zero-usage OpenCode receipt after stopping before the adapter result is saved", async () => {
    const f = await fixture(); const run = await runFor(f);
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100, reservationCents: "10" }, "board");
    await reserveRunBudget(db, f.company.id, run.id, null);
    const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType: "opencode_local" }, directory);
    const log = createUsageCheckpointLog(async () => {}, async receipt => { await recorder.capture(receipt); }, records => ({
      provider: "openai", biller: "openai", billingType: "unknown", model: "openai/test", usageBasis: "per_run",
      usage: parseOpenCodeJsonl(records).usage, costUsd: null, complete: false,
    }));
    await log("stdout", JSON.stringify({ type: "step_finish", part: { tokens: { input: 0, output: 0 } } }));
    await log.flush({ complete: true });
    // No recorder.complete(adapterResult): the process stopped during cleanup.
    await db.update(heartbeatRuns).set({ status: "interrupted", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    expect(await accountRunCost(db, run.id)).toBe(true);
    const events = await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, costCents: 0, costStatus: "unpriced" });
    expect((await accountingIntegrityService(db).health(f.company.id))).toMatchObject({ heldReservationCents: "0.0000000", pendingRunCount: 0 });
    expect(await accountRunCost(db, run.id)).toBe(false);
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

  it.each(["zero", "paid", "tokens"] as const)("preserves model attribution after a retry with %s earlier usage", async kind => {
    const f = await fixture(); const run = await runFor(f);
    const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType: "claude_local" }, directory);
    await recorder.capture({ attemptId: randomUUID(), provider: "anthropic", billingType: "metered_api",
      usage: { inputTokens: kind === "tokens" ? 1 : 0, outputTokens: 0, cacheWriteTokens: undefined },
      costUsd: kind === "paid" ? 0.001 : 0, complete: true });
    const success = { attemptId: randomUUID(), provider: "anthropic", biller: "anthropic", billingType: "metered_api" as const, model: "mixed",
      usage: { inputTokens: 30, outputTokens: 4, cachedInputTokens: 100 }, costUsd: 0.007, complete: true,
      usageByModel: [
        { model: "large", costUsd: 0.005, usage: { inputTokens: 20, outputTokens: 3, cachedInputTokens: 100 } },
        { model: "small", costUsd: 0.002, usage: { inputTokens: 10, outputTokens: 1 } },
      ] };
    await recorder.capture(success);
    const final = await recorder.complete({ ...success, exitCode: 0, signal: null, timedOut: false, usageComplete: true });
    expect(final.usageByModel).toEqual(kind === "zero" ? success.usageByModel : undefined);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    expect(await accountRunCost(db, run.id)).toBe(true);
    const rows = await costService(db).byProvider(f.company.id);
    expect(rows.map(row => row.model).sort()).toEqual(kind === "zero" ? ["large", "small"] : ["mixed"]);
    expect((await costService(db).summary(f.company.id)).spendCentsExact).toBe(kind === "paid" ? "0.8000000" : "0.7000000");
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

  it("settles a complete streamed Claude receipt when the final stdout tail clips its result", async () => {
    const f = await fixture(); const run = await runFor(f);
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "company", scopeId: f.company.id, amount: 100, reservationCents: 10 }, "board");
    await reserveRunBudget(db, f.company.id, run.id, null);
    const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType: "claude_local" }, directory);
    const consume = createClaudeStreamParser();
    const log = createUsageCheckpointLog(async () => {}, async receipt => { await recorder.capture(receipt); }, records => {
      const parsed = consume(records);
      return { provider: "anthropic", biller: "anthropic", model: "claude-fable-5-1", billingType: "metered_api",
        usage: parsed.usage ?? undefined, costUsd: parsed.costUsd, complete: parsed.resultJson !== null };
    });
    const proc = await runChildProcess(run.id, process.execPath, ["-e", `console.log(JSON.stringify({
      type: "result", subtype: "success", result: "x".repeat(5 * 1024 * 1024),
      total_cost_usd: 0.012345678, usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 2 }
    }))`], { cwd: directory, env: {}, timeoutSec: 10, graceSec: 1, onLog: log });
    await log.flush();
    const tail = parseClaudeStreamJson(proc.stdout);
    expect(tail.resultJson).toBeNull();
    const final = await recorder.complete({ exitCode: proc.exitCode, signal: proc.signal, timedOut: proc.timedOut,
      provider: "anthropic", billingType: "metered_api", usage: tail.usage ?? undefined, costUsd: tail.costUsd,
      usageComplete: tail.resultJson !== null });
    expect(final).toMatchObject({ complete: true, costUsd: 0.012345678, usage: { inputTokens: 7, cachedInputTokens: 3, outputTokens: 2 } });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    expect(await accountRunCost(db, run.id)).toBe(true);
    expect((await costService(db).summary(f.company.id)).spendCentsExact).toBe("1.2345678");
    expect((await accountingIntegrityService(db).health(f.company.id)).heldReservationCents).toBe("0.0000000");
  });

  it("holds failed retry accounting when flush throws before final completion", async () => {
    const f = await fixture(); const run = await runFor(f); const spool = path.join(directory, randomUUID());
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "company", scopeId: f.company.id, amount: 100, reservationCents: 10 }, "board");
    await reserveRunBudget(db, f.company.id, run.id, null);
    const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType: "claude_local" }, spool);
    const attempt = () => {
      const consume = createClaudeStreamParser();
      return createUsageCheckpointLog(async () => {}, async receipt => { await recorder.capture(receipt); }, records => {
        const parsed = consume(records);
        return { provider: "anthropic", billingType: "metered_api", usage: parsed.usage ?? undefined,
          costUsd: parsed.costUsd, complete: parsed.resultJson !== null };
      });
    };
    const rejectedResume = attempt();
    await rejectedResume("stdout", JSON.stringify({ type: "result", subtype: "error_during_execution", total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 } }) + "\n");
    await rejectedResume.flush();
    const [prior] = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, run.id));
    expect((prior.receiptJson as UsageReceiptEnvelope).receipt.complete).toBe(true);
    const paidRetry = attempt();
    const write = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("Receipt disk full"));
    try {
      await paidRetry("stdout", JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.25,
        usage: { input_tokens: 10, output_tokens: 2 } }) + "\n");
      await expect(paidRetry.flush()).rejects.toThrow("Receipt disk full");
    } finally { write.mockRestore(); }
    // This is the adapter's throw path: complete() is never called.
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    const read = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0];
    expect(await read()).toMatchObject({ costAccountingPending: true, costAccountedAt: null,
      accountingLastError: "usage_capture_failed", usageJson: { accountingReceiptReady: false, accountingCaptureFailed: true } });
    expect(await accountRunCost(db, run.id)).toBe(false);
    // Old and later complete envelopes must not clear lost-capture evidence.
    await spoolUsageReceipt(prior.receiptJson as UsageReceiptEnvelope, spool);
    await spoolUsageReceipt({ ...prior.receiptJson as UsageReceiptEnvelope, id: randomUUID(), sequence: 100 }, spool);
    expect(await replayUsageReceipts(db, spool)).toEqual({ replayed: 2, failed: 0 });
    expect((await read()).usageJson?.accountingReceiptReady).toBe(false);
    const replacement = await createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType: "claude_local" }, spool);
    expect((await replacement.complete({ exitCode: 0, signal: null, timedOut: false, costUsd: 0.25 })).complete).toBe(false);
    // Even a finalizer overwriting readiness or claiming pre-provider failure cannot erase the fence.
    await db.update(heartbeatRuns).set({ usageJson: { ...(await read()).usageJson, accountingReceiptReady: true },
      resultJson: { executionRecovery: { providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, run.id));
    expect(await accountRunCost(db, run.id)).toBe(false);
    expect((await read()).costAccountedAt).toBeNull();
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, run.id))).toEqual([]);
    expect(await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agent.id))).toEqual([]);
    expect((await accountingIntegrityService(db).health(f.company.id)).heldReservationCents).toBe("10.0000000");
  });

  it.each(["capture", "complete", "invalid"] as const)("persists the failure fence before %s rejects", async kind => {
    const f = await fixture(); const run = await runFor(f);
    const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType: "process" }, directory);
    await recorder.persistFailure(); // Healthy failure finalization has no fence to save.
    await recorder.capture({ costUsd: 0, complete: true });
    const rename = vi.spyOn(fs, "rename");
    if (kind !== "invalid") rename.mockRejectedValueOnce(new Error("Receipt disk full"));
    try {
      const result = kind === "complete"
        ? recorder.complete({ exitCode: 0, signal: null, timedOut: false, costUsd: 1 })
        : recorder.capture({ costUsd: kind === "invalid" ? -1 : 1, complete: true });
      await expect(result).rejects.toThrow();
      const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(stored.usageJson).toMatchObject({ accountingCaptureFailed: true, accountingReceiptReady: false });
    } finally { rename.mockRestore(); }
  });

  it("retries a failed durable fence before allowing failure finalization", async () => {
    const f = await fixture(); const run = await runFor(f);
    const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType: "process" }, directory);
    await recorder.capture({ costUsd: 0, complete: true });
    const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("Database unavailable"));
    try {
      await expect(recorder.capture({ costUsd: -1, complete: true })).rejects.toThrow();
      expect(transaction).toHaveBeenCalledTimes(1);
      transaction.mockRejectedValueOnce(new Error("Database still unavailable"));
      await expect(recorder.persistFailure()).rejects.toThrow("Database still unavailable");
      await recorder.persistFailure();
    } finally { transaction.mockRestore(); }
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, run.id));
    expect(await accountRunCost(db, run.id)).toBe(false);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toMatchObject({
      costAccountedAt: null, accountingLastError: "usage_capture_failed",
      usageJson: { accountingCaptureFailed: true, accountingReceiptReady: false },
    });
  });

  it("does not let a replaced recorder's failed capture poison its successor", async () => {
    const f = await fixture(); const run = await runFor(f);
    const input = { companyId: f.company.id, runId: run.id, adapterType: "process" };
    const old = await createRunUsageRecorder(db, input, directory);
    const current = await createRunUsageRecorder(db, input, directory);
    await current.capture({ costUsd: 0.25, complete: true });
    await expect(old.capture({ costUsd: -1, complete: true })).rejects.toThrow();
    await old.persistFailure();
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, run.id));
    expect(await accountRunCost(db, run.id)).toBe(true);
    expect((await costService(db).summary(f.company.id)).spendCentsExact).toBe("25.0000000");
  });

  it.each(["more_tokens", "more_cost", "new_attempt"])("keeps additional incomplete provider work pending (%s)", async (kind) => {
    const f = await fixture(); const run = await runFor(f);
    const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType: "claude_local" }, directory);
    await recorder.capture({ provider: "anthropic", usage: { inputTokens: 7, outputTokens: 2 }, costUsd: 0.01, complete: true });
    if (kind === "new_attempt") await recorder.capture({ attemptId: randomUUID(), provider: "anthropic", usage: { inputTokens: 1, outputTokens: 0 }, complete: false });
    const final = await recorder.complete({ exitCode: 1, signal: null, timedOut: false, usageComplete: false,
      usage: { inputTokens: kind === "more_tokens" ? 8 : 7, outputTokens: 2 }, costUsd: kind === "more_cost" ? 0.02 : 0.01 });
    expect(final.complete).toBe(false);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    expect(await accountRunCost(db, run.id)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rejects recorder setup before dispatch when its new directory parent cannot be flushed", async () => {
    const f = await fixture(); const run = await runFor(f);
    const spool = path.join(directory, randomUUID(), "receipts");
    const realParent = await fs.realpath(directory);
    const open = fs.open.bind(fs);
    const probe = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === realParent) throw Object.assign(new Error("unflushed parent"), { code: "EACCES" });
      return open(...args);
    });
    try {
      await expect(createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType: "claude_local" }, spool)).rejects.toMatchObject({ code: "EACCES" });
      expect(probe.mock.calls.some(([file]) => String(file).endsWith(".probe"))).toBe(false);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].usageJson?.accountingReceiptSourceId).toBeUndefined();
    } finally { probe.mockRestore(); }
    await expect(createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType: "claude_local" }, spool)).resolves.toBeDefined();
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
