import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { accountingRuntimeBaselines, agents, agentRuntimeState, billingInvoiceLines, budgetPolicies, budgetReservations, companies, costEvents, createDb, heartbeatRuns, nativeRunFinalizations, issues, projects, runUsageReceipts } from "@paperclipai/db";
import { accountingIntegrityService } from "../services/accounting-integrity.js";
import { billingReconciliationService } from "../services/billing-reconciliation.js";
import { budgetService, type BudgetEnforcementScope } from "../services/budgets.js";
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
  it.each(["retryable_failure", "observed"])("keeps native %s receipts open through same-run recovery", async (phase) => {
    const f = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Recoverable native work" }).returning();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.run.id));
    await reserveRunBudget(db, f.company.id, f.run.id, null);
    await db.insert(nativeRunFinalizations).values({ companyId: f.company.id, runId: f.run.id, issueId: issue.id, phase });
    const input = { companyId: f.company.id, runId: f.run.id, adapterType: "paperclip_runner" };
    const spool = path.join(directory, randomUUID());
    const recorder = await createRunUsageRecorder(db, input, spool);
    await recorder.capture({ complete: true, usageBasis: "per_run", usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0.1 });
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await accountRunCost(db, f.run.id)).toBe(false);
    await reconcileRunCosts(db);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].costAccountedAt).toBeNull();
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id)))[0].state).toBe("held");
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.run.id));
    const resumed = await createRunUsageRecorder(db, input, spool);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].usageJson?.accountingReceiptReady).toBe(false);
    const empty = await resumed.complete({ exitCode: 0, signal: null, timedOut: false });
    expect(empty).toMatchObject({ complete: false, usage: { inputTokens: 100, outputTokens: 10 } });
    // The provider's native delta is cumulative for this run across recovery.
    await resumed.capture({ complete: true, usageBasis: "per_run", usage: { inputTokens: 150, outputTokens: 15 }, costUsd: 0.15 });
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure" }).where(eq(nativeRunFinalizations.runId, f.run.id));
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await accountRunCost(db, f.run.id)).toBe(true);
    expect(await accountRunCost(db, f.run.id)).toBe(false);
    expect((await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id)))[0]).toMatchObject({ inputTokens: 150, outputTokens: 15, costCents: 15 });
  });

  it.each([false, true])("recovers pending native receipts beyond the startup batch before replacement (save failure: %s)", async (failSave) => {
    const f = await fixture(), other = await fixture();
    await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, f.run.id));
    await reserveRunBudget(db, f.company.id, f.run.id, null);
    const input = { companyId: f.company.id, runId: f.run.id, adapterType: "paperclip_runner" };
    const spool = path.join(directory, randomUUID());
    const recorder = await createRunUsageRecorder(db, input, spool);
    await recorder.capture({ complete: true, usageBasis: "per_run", usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0.1 });
    const before = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0];
    const unavailable = vi.spyOn(db, "transaction").mockRejectedValue(new Error("Database unavailable"));
    try {
      await recorder.capture({ complete: true, usageBasis: "per_run", usage: { inputTokens: 150, outputTokens: 15 }, costUsd: 0.15 });
      await recorder.capture({ complete: true, usageBasis: "per_run", usage: { inputTokens: 200, outputTokens: 20 }, costUsd: 0.2 });
    } finally { unavailable.mockRestore(); }
    const pending = (await fs.readdir(spool)).filter(name => name.endsWith(".json"));
    expect(pending).toHaveLength(2);
    for (const name of pending) await fs.rename(path.join(spool, name), path.join(spool, `zzz-${name}`));
    const unrelated: UsageReceiptEnvelope = { schema: "paperclip/accounting-receipt/v1", id: randomUUID(),
      companyId: other.company.id, runId: other.run.id, sourceId: randomUUID(), sequence: 1,
      receivedAt: new Date().toISOString(), adapterType: "process", receipt: { complete: false } };
    await Promise.all(Array.from({ length: 101 }, async (_, index) => {
      await fs.writeFile(path.join(spool, `000-${index}.json`), JSON.stringify({ ...unrelated, id: randomUUID(), sequence: index + 1 }));
    }));
    expect(await replayUsageReceipts(db, spool)).toEqual({ replayed: 100, failed: 0 });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].usageJson?.inputTokens).toBe(100);
    if (failSave) {
      await db.execute(sql`create function reject_recovered_receipt() returns trigger language plpgsql as $$ begin raise exception 'receipt save failed'; end $$`);
      await db.execute(sql`create trigger reject_recovered_receipt before insert on run_usage_receipts for each row execute function reject_recovered_receipt()`);
      try {
        await expect(createRunUsageRecorder(db, input, spool)).rejects.toThrow();
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].usageJson?.accountingReceiptSourceId)
          .toBe(before.usageJson?.accountingReceiptSourceId);
        expect((await fs.readdir(spool)).filter(name => name.startsWith("zzz-"))).toHaveLength(2);
      } finally {
        await db.execute(sql`drop trigger reject_recovered_receipt on run_usage_receipts`);
        await db.execute(sql`drop function reject_recovered_receipt()`);
      }
    }
    const resumed = await createRunUsageRecorder(db, input, spool);
    expect((await fs.readdir(spool)).filter(name => name.startsWith("zzz-"))).toHaveLength(0);
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.run.id))).toHaveLength(3);
    expect(await resumed.complete({ exitCode: 0, signal: null, timedOut: false }))
      .toMatchObject({ complete: false, usage: { inputTokens: 200, outputTokens: 20 } });
    await resumed.capture({ complete: true, usageBasis: "per_run", usage: { inputTokens: 220, outputTokens: 22 }, costUsd: 0.22 });
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await accountRunCost(db, f.run.id)).toBe(true);
    expect(await accountRunCost(db, f.run.id)).toBe(false);
    expect((await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id)))[0])
      .toMatchObject({ inputTokens: 220, outputTokens: 22, costCents: 22 });
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id)))[0].state).toBe("settled");
    expect(await replayUsageReceipts(db, spool)).toEqual({ replayed: 1, failed: 0 });
    expect((await costService(db).summary(f.company.id)).spendCents).toBe(22);
  });

  it.each(["company", "agent", "project"] as const)("blocks fresh %s work without pausing native recovery", async (scopeType) => {
    const f = await fixture(), cancelWorkForScope = vi.fn(async (_scope: BudgetEnforcementScope) => {});
    const budgets = budgetService(db, { cancelWorkForScope });
    const scopeId = f[scopeType].id;
    await budgets.upsertPolicy(f.company.id, { scopeType, scopeId, amount: 100, reservationCents: "20" }, "board");
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Recover under budget" }).returning();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.run.id));
    const original = await reserveRunBudget(db, f.company.id, f.run.id, f.project.id);
    await db.insert(nativeRunFinalizations).values({ companyId: f.company.id, runId: f.run.id, issueId: issue.id, phase: "retryable_failure" });
    const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: f.run.id, adapterType: "paperclip_runner" }, path.join(directory, randomUUID()));
    await recorder.capture({ complete: true, usageBasis: "per_run", usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0.1 });
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    // Also recover a budget-owned pause left by the previous implementation.
    const table = { company: companies, agent: agents, project: projects }[scopeType];
    await db.update(table).set({ pauseReason: "budget", ...(scopeType === "project" ? {} : { status: "paused" }) }).where(eq(table.id, scopeId));
    await reconcileRunCosts(db, { cancelWorkForScope });
    expect((await db.select().from(table).where(eq(table.id, scopeId)))[0].pauseReason).toBeNull();
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].status).toBe("idle");
    expect(cancelWorkForScope.mock.calls.filter(([scope]) => scope.companyId === f.company.id)).toEqual([]);
    expect((await budgets.getInvocationBlock(f.company.id, f.agent.id, { projectId: f.project.id }))?.reason).toContain("native run recovers");
    const [fresh] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running" }).returning();
    await expect(reserveRunBudget(db, f.company.id, fresh.id, f.project.id)).rejects.toThrow("native run recovers");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].costAccountedAt).toBeNull();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(nativeRunFinalizations).set({ leaseOwner: "recovery", leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.run.id));
    expect(await reserveRunBudget(db, f.company.id, f.run.id, f.project.id, {}, "recovery"))
      .toMatchObject({ id: original.id, reused: true, amountCents: "20.0000000", state: "held" });
    expect(await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id))).toHaveLength(1);
    await recorder.capture({ complete: true, usageBasis: "per_run", usage: { inputTokens: 150, outputTokens: 15 }, costUsd: 0.15 });
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure" }).where(eq(nativeRunFinalizations.runId, f.run.id));
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await accountRunCost(db, f.run.id)).toBe(true);
    expect(await accountRunCost(db, f.run.id)).toBe(false);
    expect((await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id)))[0]).toMatchObject({ inputTokens: 150, costCents: 15 });
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id)))[0].state).toBe("settled");
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id, { projectId: f.project.id })).toBeNull();
  });

  it.each(["company", "agent", "project"] as const)("rechecks %s stops before native reservation reuse", async scopeType => {
    const f = await fixture(), budgets = budgetService(db), scopeId = f[scopeType].id;
    await budgets.upsertPolicy(f.company.id, { scopeType, scopeId, amount: 100, reservationCents: "20" }, "board");
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Retry after budget edit" }).returning();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.run.id));
    const original = await reserveRunBudget(db, f.company.id, f.run.id, f.project.id);
    await db.insert(nativeRunFinalizations).values({ companyId: f.company.id, runId: f.run.id, issueId: issue.id, phase: "retryable_failure", leaseOwner: "retry", leaseExpiresAt: new Date(Date.now() + 60_000) });
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    await event(f, { costCents: 50, projectId: f.project.id });
    await budgets.upsertPolicy(f.company.id, { scopeType, scopeId, amount: 40 }, "board");
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(reserveRunBudget(db, f.company.id, f.run.id, f.project.id, {}, "retry")).rejects.toThrow(/budget/);
    await budgets.upsertPolicy(f.company.id, { scopeType, scopeId, amount: 100 }, "board");
    expect(await reserveRunBudget(db, f.company.id, f.run.id, f.project.id, {}, "retry")).toMatchObject({ id: original.id, reused: true });
    const table = { company: companies, agent: agents, project: projects }[scopeType];
    await db.update(table).set({ pauseReason: "manual", ...(scopeType === "project" ? { pausedAt: new Date() } : { status: "paused" }) }).where(eq(table.id, scopeId));
    await expect(reserveRunBudget(db, f.company.id, f.run.id, f.project.id, {}, "retry")).rejects.toThrow(/paused/);
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id)))[0]).toMatchObject({ id: original.id, state: "held", amountCents: "20.0000000" });
  });

  it.each(["closed", "over_budget", "unpriced", "manual"])("preserves %s stops while native accounting is unfinished", async (stop) => {
    const f = await fixture(), budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100 }, "board");
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Pending native run" }).returning();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.run.id));
    await reserveRunBudget(db, f.company.id, f.run.id, null);
    await db.insert(nativeRunFinalizations).values({ companyId: f.company.id, runId: f.run.id, issueId: issue.id, phase: stop === "closed" ? "terminal_failure" : "retryable_failure" });
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    if (stop === "over_budget") await event(f, { costCents: 100 });
    if (stop === "unpriced") await event(f, { costCents: 0, costStatus: "unpriced" });
    if (stop === "manual") await db.update(agents).set({ status: "paused", pauseReason: "manual" }).where(eq(agents.id, f.agent.id));
    await budgets.reconcilePolicies();
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0])
      .toMatchObject({ status: "paused", pauseReason: stop === "manual" ? "manual" : "budget" });
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id)))[0].state).toBe("held");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].costAccountedAt).toBeNull();
  });

  it.each(["complete", "partial", "receipt_failure", "ledger_failure", "cleanup_failure", "moved", "unstable_spool"])("settles the newest run receipt beyond a full replay batch (%s)", async (scenario) => {
    const f = await fixture(), other = await fixture(), spool = usageReceiptSpoolPath();
    const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: f.run.id, adapterType: "process" });
    await reserveRunBudget(db, f.company.id, f.run.id, null);
    await recorder.capture({ complete: true, usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0.1 });
    const unavailable = vi.spyOn(db, "transaction").mockRejectedValue(new Error("Database unavailable"));
    try { await recorder.capture({ complete: scenario !== "partial", usage: { inputTokens: 200, outputTokens: 20 }, costUsd: 0.2 }); }
    finally { unavailable.mockRestore(); }
    const [pending] = (await fs.readdir(spool)).filter(name => name.endsWith(".json"));
    const file = path.join(spool, `zzz-${pending}`);
    await fs.rename(path.join(spool, pending), file);
    const unrelated: UsageReceiptEnvelope = { schema: "paperclip/accounting-receipt/v1", id: randomUUID(), companyId: other.company.id,
      runId: other.run.id, sourceId: randomUUID(), sequence: 1, receivedAt: new Date().toISOString(), adapterType: "process", receipt: { complete: false } };
    for (let index = 0; index < 101; index++) await fs.writeFile(path.join(spool, `000-${index}.json`), JSON.stringify({ ...unrelated, id: randomUUID(), sequence: index + 1 }));
    expect(await replayUsageReceipts(db)).toEqual({ replayed: 100, failed: 0 });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].usageJson?.inputTokens).toBe(100);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    if (scenario === "unstable_spool") {
      const stat = fs.lstat.bind(fs);
      const unstable = vi.spyOn(fs, "lstat").mockImplementation(async (target, ...args) => {
        if (target === file) throw Object.assign(new Error("Concurrent rename"), { code: "ENOENT" });
        return stat(target, ...args);
      });
      try { await expect(accountRunCost(db, f.run.id)).rejects.toThrow("retry required"); }
      finally { unstable.mockRestore(); }
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].costAccountedAt).toBeNull();
      expect(JSON.parse(await fs.readFile(file, "utf8")).receipt.usage.inputTokens).toBe(200);
    }
    if (scenario.endsWith("_failure") && scenario !== "cleanup_failure") {
      const table = scenario === "receipt_failure" ? "run_usage_receipts" : "cost_events";
      await db.execute(sql`create function reject_settlement() returns trigger language plpgsql as $$ begin raise exception 'settlement save failed'; end $$`);
      await db.execute(sql.raw(`create trigger reject_settlement before insert on ${table} for each row execute function reject_settlement()`));
      try {
        await expect(accountRunCost(db, f.run.id)).rejects.toThrow();
        expect(JSON.parse(await fs.readFile(file, "utf8")).receipt.usage.inputTokens).toBe(200);
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0])
          .toMatchObject({ costAccountedAt: null, usageJson: { inputTokens: 100 } });
        expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toEqual([]);
        expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.run.id))).toHaveLength(1);
        expect((await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id)))[0].state).toBe("held");
      } finally {
        await db.execute(sql.raw(`drop trigger reject_settlement on ${table}`));
        await db.execute(sql`drop function reject_settlement()`);
      }
    }
    const remove = fs.rm.bind(fs), stat = fs.lstat.bind(fs);
    let moved = false;
    const rm = scenario === "cleanup_failure" ? vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === file) throw new Error("Temporary cleanup failure");
      return remove(target, options);
    }) : null;
    const lstat = scenario === "moved" ? vi.spyOn(fs, "lstat").mockImplementation(async (target, ...args) => {
      if (target === file && !moved) { moved = true; await fs.rename(file, `${file.slice(0, -5)}-moved.json`); }
      return stat(target, ...args);
    }) : null;
    try { await reconcileRunCosts(db); } finally { rm?.mockRestore(); lstat?.mockRestore(); }
    if (scenario === "partial") {
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0])
        .toMatchObject({ costAccountedAt: null, usageJson: { inputTokens: 200, accountingReceiptReady: false } });
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toEqual([]);
      await recorder.capture({ complete: true, usage: { inputTokens: 300, outputTokens: 30 }, costUsd: 0.3 });
      expect(await accountRunCost(db, f.run.id)).toBe(true);
    }
    expect(await accountRunCost(db, f.run.id)).toBe(false);
    const expected = scenario === "partial" ? 300 : 200;
    const charges = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id));
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ inputTokens: expected, outputTokens: expected / 10, costCents: expected / 10 });
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id)))[0].state).toBe("settled");
    expect(await replayUsageReceipts(db)).toEqual({ replayed: scenario === "cleanup_failure" ? 2 : 1, failed: 0 });
    expect((await costService(db).summary(f.company.id)).spendCents).toBe(expected / 10);
    expect(await fs.readdir(spool)).toEqual([]);
  });

  it("leaves unrelated corrupt spool evidence alone and aborts handoff on unreadable or invalid matching receipts", async () => {
    const f = await fixture(), spool = path.join(directory, randomUUID());
    const input = { companyId: f.company.id, runId: f.run.id, adapterType: "paperclip_runner" };
    await createRunUsageRecorder(db, input, spool);
    const source = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].usageJson?.accountingReceiptSourceId;
    const matching = path.join(spool, "matching.json");
    await fs.writeFile(matching, JSON.stringify({ ...input, receipt: "invalid" }));
    await expect(createRunUsageRecorder(db, input, spool)).rejects.toThrow();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].usageJson?.accountingReceiptSourceId).toBe(source);
    const read = vi.spyOn(fs, "readFile").mockRejectedValueOnce(Object.assign(new Error("Unreadable receipt"), { code: "EACCES" }));
    try { await expect(createRunUsageRecorder(db, input, spool)).rejects.toThrow("Unreadable receipt"); } finally { read.mockRestore(); }
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].usageJson?.accountingReceiptSourceId).toBe(source);
    await fs.rm(matching);
    const unrelated = ["invalid", "null", "{}", JSON.stringify({ companyId: f.company.id }),
      JSON.stringify({ companyId: f.company.id, runId: randomUUID() }), "x".repeat(1024 * 1024 + 1)];
    for (const [index, value] of unrelated.entries()) await fs.writeFile(path.join(spool, `${index}.json`), value);
    await fs.mkdir(path.join(spool, "directory.json"));
    const stat = vi.spyOn(fs, "lstat").mockRejectedValueOnce(Object.assign(new Error("Concurrent replay removed file"), { code: "ENOENT" }));
    try { await createRunUsageRecorder(db, input, spool); } finally { stat.mockRestore(); }
    await createRunUsageRecorder(db, input, spool);
    expect(await fs.readdir(spool)).toHaveLength(unrelated.length + 1);
  });

  it("indexes a recovery backlog once outside company locks and still sees newly published receipts", async () => {
    const f = await fixture(), other = await fixture(), spool = usageReceiptSpoolPath();
    const runs = [f.run];
    for (let i = 0; i < 7; i++) {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running" }).returning();
      runs.push(run);
    }
    for (const run of runs) {
      const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: run.id, adapterType: "process" });
      await recorder.capture({ complete: true, usage: { inputTokens: 50, outputTokens: 5 }, costUsd: 0.05 });
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    }
    const [first] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    const envelope: UsageReceiptEnvelope = { schema: "paperclip/accounting-receipt/v1", id: randomUUID(), companyId: other.company.id,
      runId: other.run.id, sourceId: randomUUID(), sequence: 1, receivedAt: new Date().toISOString(), adapterType: "process", receipt: { complete: false } };
    const foreignFiles = new Set<string>();
    for (let i = 0; i < 256; i++) foreignFiles.add(await spoolUsageReceipt({ ...envelope, id: randomUUID(), sequence: i + 1 }));
    const reads = new Map<string, number>(), read = fs.readFile.bind(fs);
    let checkedLock = false, lockWasAvailable = false;
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      if (typeof file === "string" && foreignFiles.has(file)) {
        reads.set(file, (reads.get(file) ?? 0) + 1);
        if (!checkedLock) {
          checkedLock = true;
          await db.transaction(async tx => {
            await tx.execute(sql`set local lock_timeout = '100ms'`);
            await tx.select().from(companies).where(eq(companies.id, f.company.id)).for("no key update");
          });
          lockWasAvailable = true;
          // Published after the index's directory snapshot: the locked drain
          // must discover it instead of trusting a stale batch inventory.
          await spoolUsageReceipt({ ...envelope, id: randomUUID(), companyId: f.company.id, runId: f.run.id,
            sourceId: String(first.usageJson?.accountingReceiptSourceId), sequence: 2,
            receipt: { complete: true, usage: { inputTokens: 200, outputTokens: 20 }, costUsd: 0.2 } });
        }
      }
      return read(file, options);
    });
    try { await reconcileRunCosts(db); } finally { spy.mockRestore(); }
    expect(lockWasAvailable).toBe(true);
    expect(reads.size).toBe(256);
    expect([...reads.values()]).toEqual(Array(256).fill(1));
    const charges = await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id));
    expect(charges).toHaveLength(8);
    expect(charges.find(charge => charge.heartbeatRunId === f.run.id)).toMatchObject({ inputTokens: 200, costCents: 20 });
    expect((await costService(db).summary(f.company.id)).spendCents).toBe(55);
    const listing = vi.spyOn(fs, "readdir");
    try {
      for (const run of runs) expect(await accountRunCost(db, run.id)).toBe(false);
      // An acknowledged run with a stale pending flag still needs its locked
      // cleanup, but neither form of duplicate finalization needs spool I/O.
      await db.update(heartbeatRuns).set({ costAccountingPending: true }).where(eq(heartbeatRuns.id, f.run.id));
      expect(await accountRunCost(db, f.run.id)).toBe(false);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].costAccountingPending).toBe(false);
      expect(listing).not.toHaveBeenCalled();
    } finally { listing.mockRestore(); }
    await Promise.all([...foreignFiles].map(file => fs.rm(file)));
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
    expect(uncertain).toMatchObject({costUsd:0.040000001,costUsdExact:"0.040000001",costStatus:"unpriced",billingType:"unknown"});
    const partial = await recorder.complete({exitCode:1,signal:null,timedOut:false});
    expect(partial.complete).toBe(false);
    expect(partial.usage?.inputTokens).toBe(21);
  });
  it.each(["block", "allow"] as const)("keeps known attempted-run spend when unknown prices %s new work", async (unpricedUsagePolicy) => {
    const f = await fixture(), budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "company", scopeId: f.company.id, amount: 100, unpricedUsagePolicy }, "board");
    await reserveRunBudget(db, f.company.id, f.run.id, null);
    const recorder = await createRunUsageRecorder(db, { companyId: f.company.id, runId: f.run.id, adapterType: "process" }, path.join(directory, randomUUID()));
    await recorder.capture({ attemptId: randomUUID(), complete: true, billingType: "metered_api", usage, costUsdExact: "0.010000001" });
    const aggregate = await recorder.capture({ attemptId: randomUUID(), complete: true, billingType: "metered_api", usage, costUsd: null, costStatus: "unpriced" });
    expect(aggregate).toMatchObject({ costUsdExact: "0.010000001", costStatus: "unpriced", complete: true });
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await accountRunCost(db, f.run.id)).toBe(true);
    expect(await accountRunCost(db, f.run.id)).toBe(false);
    expect(await costService(db).summary(f.company.id)).toMatchObject({ spendCentsExact: "1.0000001", unpricedEventCount: 1, pricingComplete: false, pendingRunCount: 0 });
    const [runtime] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agent.id));
    expect(runtime.totalCostCents).toBe(1.0000001);
    const [reservation] = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id));
    expect(reservation.state).toBe("settled");
    expect((await budgets.getInvocationBlock(f.company.id, f.agent.id)) !== null).toBe(unpricedUsagePolicy === "block");
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
