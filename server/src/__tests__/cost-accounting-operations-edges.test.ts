import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { accountingRuntimeBaselines, agents, agentRuntimeState, billingInvoiceLines, budgetPolicies, budgetReservations, companies, costEvents, createDb, heartbeatRuns, projects, runUsageReceipts } from "@paperclipai/db";
import { accountingIntegrityService } from "../services/accounting-integrity.js";
import { billingReconciliationService } from "../services/billing-reconciliation.js";
import { budgetService } from "../services/budgets.js";
import { reserveRunBudget } from "../services/budget-reservations.js";
import { costService } from "../services/costs.js";
import { financeService } from "../services/finance.js";
import { accountRunCost, reconcileRunCosts } from "../services/run-cost-accounting.js";
import { createRunUsageRecorder, persistUsageReceipt, replayUsageReceipts, spoolUsageReceipt, usageReceiptSpoolPath, type UsageReceiptEnvelope } from "../services/usage-receipts.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("accounting operational edge cases", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, directory: string;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("accounting-operational-edges-"); db = createDb(database.connectionString); directory = await fs.mkdtemp(path.join(os.tmpdir(), "accounting-edges-")); },30_000);
  afterAll(async () => { vi.restoreAllMocks(); await database?.cleanup(); await fs.rm(directory, { recursive: true, force: true }); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Edges", issuePrefix: `E${randomUUID().slice(0,7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", adapterType: "process", status: "idle" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Work" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running", usageJson: {} }).returning();
    return { company, agent, project, run };
  }
  const usage = { inputTokens: 7, cachedInputTokens: 11, outputTokens: 3 };
  async function event(f: Awaited<ReturnType<typeof fixture>>, extras: Record<string, unknown> = {}) {
    return costService(db).createEvent(f.company.id, { agentId: f.agent.id, provider: "fixture", model: "model", costCents: "0.1234567", occurredAt: new Date(), ...extras });
  }
  it("initializes an old month once, excludes backdated events, and repairs current-month drift", async () => {
    const f = await fixture();
    await db.update(companies).set({ spendMonthUtc: "2000-01-01", spentMonthlyCents: 999 }).where(eq(companies.id,f.company.id));
    await event(f); await event(f, { occurredAt: new Date("2000-01-01") }); await event(f);
    const [row] = await db.select().from(companies).where(eq(companies.id,f.company.id));
    expect(row.spentMonthlyCents).toBe(0.2469134);
    expect((await accountingIntegrityService(db).inspect(f.company.id)).findings).toEqual([]);
    await db.update(agents).set({ spentMonthlyCents: 4 }).where(eq(agents.id,f.agent.id));
    const review = await accountingIntegrityService(db).inspect(f.company.id);
    await accountingIntegrityService(db).repair(f.company.id,review.fingerprint,"Repair drift","board");
    await event(f);
    expect((await accountingIntegrityService(db).inspect(f.company.id)).findings).toEqual([]);
  });
  it("keeps fractional finance credits and net totals exact beyond number precision", async () => {
    const f = await fixture(), finance = financeService(db);
    const base = { biller: "fixture", eventKind: "inference_charge", occurredAt: new Date() };
    await finance.createEvent(f.company.id,{ ...base, amountCents: "9007199254740992.0000001" });
    await finance.createEvent(f.company.id,{ ...base, direction: "credit", amountCents: "9007199254740992" });
    expect((await finance.summary(f.company.id)).netCentsExact).toBe("0.0000001");
    expect((await finance.byBiller(f.company.id))[0].netCentsExact).toBe("0.0000001");
    expect((await finance.byKind(f.company.id))[0].netCentsExact).toBe("0.0000001");
  });
  it("checks agent and project capacity, preserves reservations through policy edits, and releases proven bootstrap failures", async () => {
    const f = await fixture(), budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id,{ scopeType:"agent",scopeId:f.agent.id,amount:20,reservationCents:"3" },"board");
    await budgets.upsertPolicy(f.company.id,{ scopeType:"project",scopeId:f.project.id,windowKind:"lifetime",amount:10,reservationCents:"6" },"board");
    await budgets.upsertPolicy(f.company.id,{ scopeType:"company",scopeId:f.company.id,amount:20,reservationCents:"1" },"board");
    const reserved = await reserveRunBudget(db,f.company.id,f.run.id,f.project.id);
    expect(reserved.amountCents).toBe("6.0000000");
    await budgets.upsertPolicy(f.company.id,{ scopeType:"project",scopeId:f.project.id,windowKind:"lifetime",amount:10,reservationCents:"0" },"board");
    await budgets.upsertPolicy(f.company.id,{ scopeType:"agent",scopeId:f.agent.id,amount:20,reservationCents:"0" },"board");
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.runId,f.run.id)))[0].amountCents).toBe("6.0000000");
    await db.update(heartbeatRuns).set({ status:"failed",resultJson:{executionRecovery:{providerWorkStarted:false}} }).where(eq(heartbeatRuns.id,f.run.id));
    await accountRunCost(db,f.run.id);
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.runId,f.run.id)))[0].state).toBe("released");
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId,f.company.id))).toEqual([]);
  });
  it("reports over-limit advisory budgets without blocking, and tolerates legacy active zero limits", async () => {
    const f = await fixture(), budgets = budgetService(db);
    const policy = await budgets.upsertPolicy(f.company.id, { scopeType: "company", scopeId: f.company.id, amount: 1, hardStopEnabled: false }, "board");
    await event(f, { costCents: "2.0000001" });
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    expect((await budgets.overview(f.company.id)).policies[0]).toMatchObject({ status: "hard_stop", observedAmountExact: "2.0000001", paused: false });
    // Older databases can contain an active zero policy; it must never become
    // an accidental hard stop during an upgrade or a projection inspection.
    await db.update(budgetPolicies).set({ amount: 0, isActive: true }).where(eq(budgetPolicies.id, policy.policyId));
    expect((await budgets.overview(f.company.id)).policies[0]).toMatchObject({ status: "ok", amount: 0 });
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
  });
  it("recovers late bootstrap proof without replacing the stop owner's terminal metadata", async () => {
    const f = await fixture();
    await reserveRunBudget(db, f.company.id, f.run.id, null);
    const stopped = { executionCancellation: { state: "acknowledged" } };
    await db.update(heartbeatRuns).set({ status: "cancelled", resultJson: stopped,
      usageJson: { accountingReceiptReady: false, accountingProviderWorkStarted: false },
    }).where(eq(heartbeatRuns.id, f.run.id));
    const integrity = accountingIntegrityService(db);
    expect((await integrity.health(f.company.id)).items[0].state).toBe("retryable");
    expect((await integrity.inspect(f.company.id)).findings).toEqual([]);
    await reconcileRunCosts(db);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run).toMatchObject({ status: "cancelled", resultJson: stopped, costAccountingPending: false });
    expect(run.costAccountedAt).not.toBeNull();
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id)))[0].state).toBe("released");
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toEqual([]);
  });
  it("rejects absent, foreign, finished and blocked dispatch without changing the ledger", async () => {
    const f = await fixture(), other = await fixture();
    await expect(reserveRunBudget(db,f.company.id,randomUUID(),null)).rejects.toThrow("not found");
    await expect(reserveRunBudget(db,other.company.id,f.run.id,null)).rejects.toThrow("not found");
    await expect(reserveRunBudget(db,f.company.id,f.run.id,other.project.id)).rejects.toThrow("not found");
    await db.update(heartbeatRuns).set({status:"failed"}).where(eq(heartbeatRuns.id,f.run.id));
    await expect(reserveRunBudget(db,f.company.id,f.run.id,null)).rejects.toThrow("no longer");
    await db.update(heartbeatRuns).set({status:"running",costAccountedAt:new Date()}).where(eq(heartbeatRuns.id,f.run.id));
    await expect(reserveRunBudget(db,f.company.id,f.run.id,null)).rejects.toThrow("no longer");
    await db.update(heartbeatRuns).set({costAccountedAt:null}).where(eq(heartbeatRuns.id,f.run.id));
    await budgetService(db).upsertPolicy(f.company.id,{scopeType:"agent",scopeId:f.agent.id,amount:1},"board");
    await event(f,{costCents:1});
    await expect(reserveRunBudget(db,f.company.id,f.run.id,null)).rejects.toThrow("paused");
    await expect(budgetService(db).upsertPolicy(f.company.id,{scopeType:"agent",scopeId:f.agent.id,amount:1,reservationCents:-1},"board")).rejects.toThrow("negative");
  });
  it("distinguishes legacy totals, missing acknowledgements, missing receipts, and corrupted receipt amounts", async () => {
    const f = await fixture(); const integrity = accountingIntegrityService(db);
    await db.insert(agentRuntimeState).values({companyId:f.company.id,agentId:f.agent.id,adapterType:"process",totalCostCents:4});
    expect((await integrity.inspect(f.company.id)).findings[0].kind).toBe("legacy_runtime");
    await db.update(heartbeatRuns).set({status:"failed",costAccountingPending:true,usageJson:{...usage,costUsdExact:"0.01",accountingReceiptReady:true}}).where(eq(heartbeatRuns.id,f.run.id));
    expect((await integrity.inspect(f.company.id)).findings.some(f => f.kind === "missing_acknowledgement")).toBe(true);
    expect(await integrity.retry(f.company.id,f.run.id,"board")).toEqual({accounted:true});
    await db.update(heartbeatRuns).set({usageJson:{...usage,costUsdExact:"0.02"}}).where(eq(heartbeatRuns.id,f.run.id));
    expect((await integrity.inspect(f.company.id)).findings.map(f=>f.kind)).toContain("receipt_mismatch");
    await db.update(heartbeatRuns).set({usageJson:{...usage,costUsdExact:"invalid"}}).where(eq(heartbeatRuns.id,f.run.id));
    expect((await integrity.inspect(f.company.id)).findings.find(f=>f.kind==="receipt_mismatch")?.expected.cents).toBe("invalid receipt");
    await db.delete(costEvents).where(eq(costEvents.heartbeatRunId,f.run.id));
    expect((await integrity.inspect(f.company.id)).findings.map(f=>f.kind)).toContain("missing_receipt");
    await expect(integrity.repair(f.company.id,"a".repeat(64)," ","board")).rejects.toThrow("reason");
    await expect(integrity.retry(f.company.id,randomUUID(),"board")).rejects.toThrow("not found");
  });
  it("records a failed operator retry and keeps it actionable", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({status:"failed",costAccountingPending:true,usageJson:{inputTokens:0.1,accountingReceiptReady:true}}).where(eq(heartbeatRuns.id,f.run.id));
    const integrity = accountingIntegrityService(db);
    await expect(integrity.retry(f.company.id,f.run.id,"board")).rejects.toThrow("Invalid cost");
    const health = await integrity.health(f.company.id);
    expect(health.items[0]).toMatchObject({state:"retryable",attempts:1,lastError:"Invalid cost receipt"});
    expect(health.items[0].lastAttemptAt).not.toBeNull();
  });
  it("matches provider request IDs and run/model pairs, leaves ambiguous and non-inference lines unresolved", async () => {
    const f = await fixture(), service = billingReconciliationService(db);
    await event(f,{heartbeatRunId:f.run.id,providerRequestId:"request"}); await event(f,{heartbeatRunId:f.run.id,model:"second"});
    const line = {amountCents:"1",occurredAt:new Date().toISOString()};
    const invoice = await service.importInvoice(f.company.id,{biller:"fixture",externalId:"requests",currency:"USD",lines:[
      {...line,externalId:"provider",providerRequestId:"request"}, {...line,externalId:"model",runId:f.run.id,model:"second"},
      {...line,externalId:"ambiguous",runId:f.run.id}, {...line,externalId:"unknown",providerRequestId:"absent"},
      {...line,externalId:"unlinked"}, {...line,externalId:"fee",kind:"fee"}, {...line,externalId:"credit",kind:"credit"},
    ]},"board");
    expect((await service.list(f.company.id))[0].id).toBe(invoice.id);
    const report = await service.reconcile(f.company.id,invoice.id);
    expect(Object.fromEntries(report.lines.map(l=>[l.externalId,l.status]))).toEqual({provider:"difference",model:"difference",ambiguous:"ambiguous",unknown:"unmatched",unlinked:"unmatched",fee:"non_inference",credit:"non_inference"});
    await expect(service.importInvoice(f.company.id,{biller:"fixture",externalId:"missing-run",currency:"USD",lines:[{...line,externalId:"run",runId:randomUUID()}]},"board")).rejects.toThrow("run not found");
  });
  it("rejects contradictory invoice evidence and reused correction keys, and preserves legacy originals", async () => {
    const f = await fixture(), service = billingReconciliationService(db); const charge = await event(f);
    await db.update(costEvents).set({reportedCostCents:null}).where(eq(costEvents.id,charge.id));
    const input = {idempotencyKey:"correction",expectedCents:"0.1234567",correctedCents:"1",reason:"Reviewed",pricing:{source:"operator" as const}};
    await expect(service.adjust(f.company.id,charge.id,{...input,invoiceLineId:randomUUID()},"board")).rejects.toThrow("not found");
    const invoice = await service.importInvoice(f.company.id,{biller:"fixture",externalId:"bad-evidence",currency:"USD",lines:[{externalId:"line",amountCents:"2",occurredAt:new Date().toISOString(),costEventId:charge.id}]},"board");
    const [line] = (await service.reconcile(f.company.id,invoice.id)).lines;
    await expect(service.adjust(f.company.id,charge.id,{...input,invoiceLineId:line.id},"board")).rejects.toThrow("does not support");
    const noMatch = await service.importInvoice(f.company.id,{biller:"fixture",externalId:"unverified",currency:"USD",lines:[{externalId:"line",amountCents:"1",occurredAt:new Date().toISOString()}]},"board");
    await expect(service.adjust(f.company.id,charge.id,{...input,invoiceLineId:(await service.reconcile(f.company.id,noMatch.id)).lines[0].id},"board")).rejects.toThrow("unverified");
    await service.adjust(f.company.id,charge.id,input,"board");
    await expect(service.adjust(f.company.id,charge.id,{...input,correctedCents:"2"},"board")).rejects.toThrow("different contents");
    expect((await db.select().from(costEvents).where(eq(costEvents.id,charge.id)))[0].reportedCostCents).toBe("0.1234567");
  });
  it("aggregates attempts exactly, rejects incomplete attempts, and never lets a late old attempt replace the current attempt", async () => {
    const f = await fixture(), spool = path.join(directory,randomUUID());
    const recorder = await createRunUsageRecorder(db,{companyId:f.company.id,runId:f.run.id,adapterType:"process"},spool);
    const first=randomUUID(), second=randomUUID();
    await recorder.capture({attemptId:first,usage,costUsdExact:"0.010000001",complete:true,billingType:"api"});
    await recorder.capture({attemptId:second,usage,costUsd:0.02,complete:false,billingType:"api"});
    await recorder.capture({attemptId:first,usage,costUsdExact:"0.010000001",complete:true,billingType:"api"});
    const result = await recorder.complete({exitCode:0,signal:null,timedOut:false,usage,costUsd:0.03,billingType:"api"});
    expect(result).toMatchObject({costUsdExact:"0.040000001",complete:true,usage:{inputTokens:14,cachedInputTokens:22,outputTokens:6}});
    await recorder.capture({attemptId:randomUUID(),usage,complete:false,billingType:"subscription"});
    const uncertain = await recorder.complete({exitCode:1,signal:null,timedOut:false,usage});
    expect(uncertain).toMatchObject({costUsd:null,costUsdExact:null,billingType:"unknown"});
    const partial = await recorder.complete({exitCode:1,signal:null,timedOut:false});
    expect(partial.complete).toBe(false);
    expect(partial.usage?.inputTokens).toBe(21);
  });
  it("refuses invalid checkpoints and does not certify a run after capture failure", async () => {
    const f = await fixture();
    const recorder = await createRunUsageRecorder(db,{companyId:f.company.id,runId:f.run.id,adapterType:"process"},path.join(directory,randomUUID()));
    await expect(recorder.capture({complete:true,costUsdExact:"NaN"})).rejects.toThrow();
    const result = await recorder.complete({exitCode:0,signal:null,timedOut:false,usage,costUsd:0.01});
    expect(result.complete).toBe(false);
    await expect(createRunUsageRecorder(db,{companyId:f.company.id,runId:randomUUID(),adapterType:"process"},path.join(directory,randomUUID()))).rejects.toThrow("cannot accept");
  });
  it("preserves disk errors, rejects missing runs, and handles invalid spool entries without deleting evidence", async () => {
    const f=await fixture(), spool=path.join(directory,randomUUID());
    const envelope:UsageReceiptEnvelope={schema:"paperclip/accounting-receipt/v1",id:randomUUID(),companyId:f.company.id,runId:randomUUID(),sourceId:randomUUID(),sequence:1,receivedAt:new Date().toISOString(),adapterType:"process",receipt:{complete:true,costUsd:1}};
    await expect(persistUsageReceipt(db,envelope)).rejects.toThrow("not found");
    const rename=vi.spyOn(fs,"rename").mockRejectedValueOnce(new Error("Disk rename unavailable"));
    try { await expect(spoolUsageReceipt(envelope,spool)).rejects.toThrow("Disk rename"); } finally { rename.mockRestore(); }
    expect(await fs.readdir(spool)).toEqual([]);
    await fs.writeFile(path.join(spool,"large.json"),"x".repeat(1024*1024+1));
    expect((await replayUsageReceipts(db,spool)).failed).toBe(1);
    const read=vi.spyOn(fs,"readdir").mockRejectedValueOnce(Object.assign(new Error("denied"),{code:"EACCES"}));
    try { await expect(replayUsageReceipts(db,spool)).rejects.toThrow("denied"); } finally { read.mockRestore(); }
  });
  it("uses the isolated instance spool and retains evidence when retry rotation itself fails", async () => {
    const f = await fixture();
    const envelope: UsageReceiptEnvelope = { schema: "paperclip/accounting-receipt/v1", id: randomUUID(), companyId: f.company.id, runId: f.run.id,
      sourceId: randomUUID(), sequence: 1, receivedAt: new Date().toISOString(), adapterType: "process", receipt: { complete: true, costUsd: 0 } };
    const file = await spoolUsageReceipt(envelope);
    expect(path.dirname(file)).toBe(usageReceiptSpoolPath());
    expect((await replayUsageReceipts(db)).replayed).toBe(1);
    const spool = path.join(directory, randomUUID()); await fs.mkdir(spool);
    const bad = path.join(spool, "bad.json"); await fs.writeFile(bad, "invalid");
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("read-only directory"));
    try { expect(await replayUsageReceipts(db, spool)).toEqual({ replayed: 0, failed: 1 }); } finally { rename.mockRestore(); }
    expect(await fs.readFile(bad, "utf8")).toBe("invalid");
  });

});
