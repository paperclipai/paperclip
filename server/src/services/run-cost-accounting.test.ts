import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, budgetEvaluationWork, budgetPolicies, companies, costEvents, costAdjustments, createDb, heartbeatRuns, projects, promptInjectionInvocations, runUsageReceipts, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { accountRunCost, createCostAccountingReconciler, readCostAccountingWork } from "./run-cost-accounting.js";
import { createRunUsageRecorder, persistUsageReceipt, type UsageReceiptEnvelope } from "./usage-receipts.js";
import * as usageReceipts from "./usage-receipts.js";
import { billingReconciliationService } from "./billing-reconciliation.js";
import { accountingIntegrityService } from "./accounting-integrity.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("run cost accounting work", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let directory: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("run-cost-work-");
    db = createDb(database.connectionString);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "run-cost-work-"));
  }, 60_000);
  afterEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE companies CASCADE`);
  }); });
  afterAll(async () => { if (directory) await fs.rm(directory, { force: true, recursive: true }); await database?.cleanup(); });

  async function seed(change: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Accounting", issuePrefix: "ACCT" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Accounting", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded",
      costAccountingPending: true, finishedAt: new Date(),
      usageJson: { accountingReceiptReady: true, provider: "test", model: "test", billingType: "metered_api", costUsd: 0.01 }, ...change });
    return { companyId, agentId, runId };
  }

  function receipt(owner: { companyId: string; runId: string }, sourceId: string, sequence: number, costUsd: number, inputTokens = 10): UsageReceiptEnvelope {
    return { schema: "paperclip/accounting-receipt/v1", ...owner, id: randomUUID(), sourceId, sequence,
      adapterType: "process", receivedAt: new Date().toISOString(),
      receipt: { complete: true, usageBasis: "per_run", usage: { inputTokens, cachedInputTokens: 0, outputTokens: 2 },
        provider: "test", biller: "test", model: "test", billingType: "metered_api", costUsd, costStatus: "reported",
        pricingProvenance: { source: "provider_reported", version: "test" } } };
  }

  it("returns from settled or running calls without opening an accounting transaction", async () => {
    const { runId } = await seed({ costAccountingPending: false });
    const transaction = vi.fn(db.transaction.bind(db));
    const observed = new Proxy(db, { get(target, property) {
      if (property === "transaction") return transaction;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Db;
    expect(await accountRunCost(observed, runId)).toBe(false);
    await db.update(heartbeatRuns).set({ status: "running", costAccountingPending: true }).where(eq(heartbeatRuns.id, runId));
    expect(await accountRunCost(observed, runId)).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("settles once without delivering cancellation in the caller", async () => {
    const { companyId, runId } = await seed();
    const cancelWorkForScope = vi.fn(async () => { throw new Error("Cancellation must be asynchronous"); });
    expect(await accountRunCost(db, runId, { cancelWorkForScope })).toBe(true);
    expect(await accountRunCost(db, runId, { cancelWorkForScope })).toBe(false);
    const events = await db.select().from(costEvents).where(and(eq(costEvents.companyId, companyId), eq(costEvents.heartbeatRunId, runId)));
    expect(events).toHaveLength(1);
    expect(events[0].costCents).toBe(1);
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    expect(await readCostAccountingWork(db, Date.now(), directory)).toEqual({ pending: false, nextRunAt: null });
  });

  it("settles while company and agent accounting rows are held by unrelated writers", async () => {
    const owner = await seed();
    const [policy] = await db.insert(budgetPolicies).values({ companyId: owner.companyId, scopeType: "company",
      scopeId: owner.companyId, windowKind: "calendar_month_utc", amount: 100 }).returning();
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, owner.companyId)).for("no key update");
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, owner.agentId)).for("no key update");
      await tx.select({ id: budgetPolicies.id }).from(budgetPolicies).where(eq(budgetPolicies.id, policy.id)).for("update");
      locked();
      await gate;
    });
    await acquired;
    const settle = accountRunCost(db, owner.runId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([settle, new Promise(resolve => { timer = setTimeout(() => resolve("blocked"), 1500); })])).toBe(true);
    } finally { if (timer) clearTimeout(timer); release(); await holder; await settle; }
  });

  it("settles another run of the same company and agent while one run is locked", async () => {
    const owner = await seed();
    const [other] = await db.insert(heartbeatRuns).values({ companyId: owner.companyId, agentId: owner.agentId,
      status: "succeeded", costAccountingPending: true, finishedAt: new Date(),
      usageJson: { accountingReceiptReady: true, provider: "test", model: "test", billingType: "metered_api", costUsd: 0.02 } }).returning();
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId)).for("update");
      locked(); await gate;
    });
    await acquired;
    const settle = accountRunCost(db, other.id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([settle, new Promise(resolve => { timer = setTimeout(() => resolve("blocked"), 1500); })])).toBe(true);
    } finally { if (timer) clearTimeout(timer); release(); await holder; await settle; }
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId)))[0].costAccountedAt).toBeNull();
    expect((await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, other.id)))[0].costCents).toBe(2);
  });

  it("rejects a changed final receipt identity after the spool pre-read and retries from the new closure", async () => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 1,
      accountingReceiptReady: true, costUsd: 0.01, provider: "test", model: "test", billingType: "metered_api" } });
    let changed = false;
    const observed = new Proxy(db, { get(target, property) {
      if (property === "transaction") return async (...args: Parameters<Db["transaction"]>) => {
        if (!changed) { changed = true; await persistUsageReceipt(db, receipt(owner, sourceId, 2, 0.02)); }
        return target.transaction(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Db;
    await expect(accountRunCost(observed, owner.runId)).rejects.toThrow("closure changed");
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId))).toEqual([]);
    expect(await accountRunCost(db, owner.runId)).toBe(true);
    expect((await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId)))[0].costCents).toBe(2);
  });

  it("retains spool evidence imported only by a transaction that rolled back before a retry skipped settlement", async () => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    const envelope = receipt(owner, sourceId, 1, 0.02);
    const file = await usageReceipts.spoolUsageReceipt(envelope, directory);
    const read = usageReceipts.readPendingRunUsageReceipts;
    const spool = vi.spyOn(usageReceipts, "readPendingRunUsageReceipts").mockImplementation(input => read(input, directory));
    let attempt = 0;
    const observed = new Proxy(db, { get(target, property) {
      if (property === "transaction") return async (callback: Parameters<Db["transaction"]>[0], options?: Parameters<Db["transaction"]>[1]) => {
        attempt++;
        if (attempt === 2) await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, owner.runId));
        return target.transaction(async tx => {
          const result = await callback(tx);
          if (attempt === 1) throw Object.assign(new Error("forced serialization rollback"), { code: "40001" });
          return result;
        }, options);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Db;
    try {
      expect(await accountRunCost(observed, owner.runId)).toBe(false);
      expect(await fs.readFile(file, "utf8")).toContain(envelope.id);
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId))).toEqual([]);
      expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, owner.runId))).toEqual([]);
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, owner.runId));
      expect(await accountRunCost(db, owner.runId)).toBe(true);
      await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { spool.mockRestore(); }
  });

  it("races receipt acceptance and finalization without dropping or duplicating authoritative spend", async () => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 0.01));
    const results = await Promise.allSettled([accountRunCost(db, owner.runId), persistUsageReceipt(db, receipt(owner, sourceId, 2, 0.02))]);
    for (const result of results) if (result.status === "rejected") expect(result.reason.message).toContain("closure changed");
    await accountRunCost(db, owner.runId);
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    expect(events).toHaveLength(1);
    expect(events[0].costCents).toBe(2);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId)))[0].costAccountingPending).toBe(false);
  });

  it("commits native late evidence before reporting reconciliation and keeps ambiguous debt quiet", async () => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 0.01));
    await accountRunCost(db, owner.runId);
    const late = { ...receipt(owner, sourceId, 2, 0.02, 20), producerEvent: { sourceEventId: "late", eventType: "usage.reported" } };
    await expect(persistUsageReceipt(db, late)).rejects.toThrow("requires_reconciliation");
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.id, late.id))).toHaveLength(1);
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(true);
    expect(await accountRunCost(db, owner.runId)).toBe(false);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.costAccountingPending).toBe(true);
    expect(run.usageJson).toMatchObject({ accountingLateReceiptPending: true, accountingLateReceiptAttemptedId: late.id });
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(false);
    expect((await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId)))[0].costCents).toBe(1);
  });

  it("corrects authoritative same-token late money on the original charge", async () => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 0.01));
    await accountRunCost(db, owner.runId);
    const [before] = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    const late = receipt(owner, sourceId, 2, 0.025);
    await persistUsageReceipt(db, late);
    expect(await accountRunCost(db, owner.runId)).toBe(true);
    expect(await accountRunCost(db, owner.runId)).toBe(false);
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: before.id, receiptHash: before.receiptHash, costCents: 2.5, reportedCostCents: "1.0000000" });
    expect(await db.select().from(costAdjustments).where(eq(costAdjustments.costEventId, before.id))).toHaveLength(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId)))[0].usageJson)
      .toMatchObject({ accountingLateReceiptPending: false, accountingReconciledReceiptId: late.id });
  });

  it.each(["direct", "spool"])("does not revalue a corrected sequence3 from a late sequence2 via %s", async delivery => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 0.01));
    await accountRunCost(db, owner.runId);
    const latest = receipt(owner, sourceId, 3, 0.03);
    await persistUsageReceipt(db, latest);
    expect(await accountRunCost(db, owner.runId)).toBe(true);
    const older = receipt(owner, sourceId, 2, 0.02);
    if (delivery === "spool") {
      // Also exercise upgrade compatibility: the reconciled immutable receipt
      // supplies the fence if explicit sequence metadata has not been written.
      await db.update(heartbeatRuns).set({ usageJson: sql`${heartbeatRuns.usageJson}
        - 'accountingReconciledReceiptSourceId' - 'accountingReconciledReceiptSequence'` }).where(eq(heartbeatRuns.id, owner.runId));
      await usageReceipts.spoolUsageReceipt(older, directory);
      expect(await usageReceipts.replayUsageReceipts(db, directory)).toEqual({ replayed: 1, failed: 0 });
    } else await persistUsageReceipt(db, older);
    expect(await accountRunCost(db, owner.runId)).toBe(false);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.costAccountingPending).toBe(false);
    expect(run.usageJson).toMatchObject({ accountingLateReceiptPending: false, accountingReconciledReceiptId: latest.id });
    const [event] = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    expect(event.costCents).toBe(3);
    expect(await db.select().from(costAdjustments).where(eq(costAdjustments.costEventId, event.id))).toHaveLength(1);
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, owner.runId))).toHaveLength(3);
  });

  it("resolves an already queued older money-only debt without rewinding a newer correction", async () => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 0.01));
    await accountRunCost(db, owner.runId);
    await persistUsageReceipt(db, receipt(owner, sourceId, 2, 0.02));
    const newest = receipt(owner, sourceId, 3, 0.03);
    await persistUsageReceipt(db, newest);
    expect(await accountRunCost(db, owner.runId)).toBe(true);
    expect(await accountRunCost(db, owner.runId)).toBe(true);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.costAccountingPending).toBe(false);
    expect(run.usageJson).toMatchObject({ accountingReconciledReceiptId: newest.id,
      accountingReconciledReceiptSequence: 3, accountingLateReceiptDebts: {} });
    const [event] = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    expect(event.costCents).toBe(3);
    expect(await db.select().from(costAdjustments).where(eq(costAdjustments.costEventId, event.id))).toHaveLength(1);
  });

  it("does not hide older ambiguous debt when a different late receipt is corrected", async () => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 0.01));
    await accountRunCost(db, owner.runId);
    const ambiguous = receipt(owner, randomUUID(), 1, 0.09, 90);
    await persistUsageReceipt(db, ambiguous);
    const canonical = receipt(owner, sourceId, 2, 0.02);
    await persistUsageReceipt(db, canonical);
    expect(await accountRunCost(db, owner.runId)).toBe(true);
    expect(await accountRunCost(db, owner.runId)).toBe(false);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.costAccountingPending).toBe(true);
    expect(run.usageJson).toMatchObject({ accountingLateReceiptPending: true,
      accountingLateReceiptDebts: { [ambiguous.id]: true }, accountingLateReceiptAttemptedId: ambiguous.id });
    expect((run.usageJson!.accountingLateReceiptDebts as Record<string, boolean>)[canonical.id]).toBeUndefined();
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(false);
    expect((await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId)))[0].costCents).toBe(2);
  });

  it.each(["billingType", "biller"])("keeps a late %s classification change as debt instead of a money-only correction", async field => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 0.01));
    await accountRunCost(db, owner.runId);
    const late = receipt(owner, sourceId, 2, 0.02);
    late.receipt = { ...late.receipt, ...(field === "billingType" ? { billingType: "subscription_included" } : { biller: "different-biller" }) };
    await persistUsageReceipt(db, late);
    expect(await accountRunCost(db, owner.runId)).toBe(false);
    const [event] = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    expect(event).toMatchObject({ costCents: 1, billingType: "metered_api", biller: "test" });
    expect(await db.select().from(costAdjustments).where(eq(costAdjustments.costEventId, event.id))).toEqual([]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.costAccountingPending).toBe(true);
    expect(run.usageJson).toMatchObject({ accountingLateReceiptPending: true, accountingLateReceiptDebts: { [late.id]: true } });
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(false);
  });

  it("retains reviewed operator valuation and resolves matching late debt through an explicit retry", async () => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 0.01));
    await accountRunCost(db, owner.runId);
    const [event] = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    await billingReconciliationService(db).adjust(owner.companyId, event.id, {
      idempotencyKey: `operator:${owner.runId}`, expectedCents: "1", correctedCents: "4",
      reason: "Reviewed authoritative invoice", pricing: { source: "operator", evidence: "Invoice review" },
    }, "board");
    const late = receipt(owner, sourceId, 2, 0.02);
    await persistUsageReceipt(db, late);
    expect(await accountRunCost(db, owner.runId)).toBe(false);
    const [valued] = await db.select().from(costEvents).where(eq(costEvents.id, event.id));
    expect(valued).toMatchObject({ costCents: 4, pricingProvenance: { source: "operator" } });
    expect(await db.select().from(costAdjustments).where(eq(costAdjustments.costEventId, event.id))).toHaveLength(1);
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.id, late.id))).toHaveLength(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId)))[0].usageJson)
      .toMatchObject({ accountingLateReceiptPending: true, accountingLateReceiptDebts: { [late.id]: true } });
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(false);
    await billingReconciliationService(db).adjust(owner.companyId, event.id, {
      idempotencyKey: `operator-reviewed-late:${owner.runId}`, expectedCents: "4", correctedCents: "2",
      reason: "Reviewed the retained late provider receipt", pricing: { source: "operator", evidence: "Reviewed late receipt" },
    }, "board");
    expect(await accountingIntegrityService(db).retry(owner.companyId, owner.runId, "board")).toEqual({ accounted: true });
    const [resolved] = await db.select().from(costEvents).where(eq(costEvents.id, event.id));
    expect(resolved).toMatchObject({ costCents: 2, pricingProvenance: { source: "operator", evidence: "Reviewed late receipt" } });
    const adjustments = await db.select().from(costAdjustments).where(eq(costAdjustments.costEventId, event.id));
    expect(adjustments).toHaveLength(2);
    expect(adjustments.every(adjustment => adjustment.actorId === "board")).toBe(true);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.costAccountingPending).toBe(false);
    expect(run.usageJson).toMatchObject({ accountingLateReceiptPending: false, accountingLateReceiptDebts: {},
      accountingReconciledReceiptId: late.id, accountingReconciledReceiptSequence: 2 });
  });

  it("fences a source handoff against a checkpoint committed during its spool pre-read", async () => {
    const sourceId = randomUUID();
    const owner = await seed({ status: "running", usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    const [project] = await db.insert(projects).values({ companyId: owner.companyId, name: "Archived accounting scope" }).returning();
    await db.update(heartbeatRuns).set({ usageJson: sql`${heartbeatRuns.usageJson} || ${JSON.stringify({ ledgerScope: { projectId: project.id } })}::jsonb` })
      .where(eq(heartbeatRuns.id, owner.runId));
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 0.01));
    let changed = false;
    const observed = new Proxy(db, { get(target, property) {
      if (property === "transaction") return async (...args: Parameters<Db["transaction"]>) => {
        if (!changed) { changed = true; await persistUsageReceipt(db, receipt(owner, sourceId, 2, 0.02)); }
        return target.transaction(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Db;
    await expect(createRunUsageRecorder(observed, { ...owner, adapterType: "process" }, directory)).rejects.toThrow("source changed");
    await createRunUsageRecorder(db, { ...owner, adapterType: "process" }, directory);
    await db.delete(budgetEvaluationWork).where(eq(budgetEvaluationWork.companyId, owner.companyId));
    await persistUsageReceipt(db, receipt(owner, sourceId, 3, 0.03));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.usageJson).toMatchObject({ accountingCaptureFailed: true, accountingReceiptReady: false,
      accountingReceiptSourceFences: { [sourceId]: 2 } });
    expect(run.accountingLastError).toBe("usage_after_source_handoff_requires_reconciliation");
    expect(await db.select({ projectId: budgetEvaluationWork.projectId }).from(budgetEvaluationWork)
      .where(eq(budgetEvaluationWork.companyId, owner.companyId))).toEqual([{ projectId: project.id }]);
  });

  it("repairs a stale pending marker without creating another charge", async () => {
    const { runId } = await seed({ costAccountedAt: new Date(), usageJson: { accountingReceiptReady: false } });
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(true);
    expect(await accountRunCost(db, runId)).toBe(false);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.costAccountingPending).toBe(false);
    expect(await db.select().from(costEvents)).toHaveLength(0);
  });

  it("waits for a missing final receipt without scheduling unchanged debt", async () => {
    const { runId } = await seed({ usageJson: { accountingReceiptReady: false, inputTokens: 5 } });
    expect(await readCostAccountingWork(db, Date.now(), directory)).toEqual({ pending: false, nextRunAt: null });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.costAccountingPending).toBe(true);
    await db.update(heartbeatRuns).set({ usageJson: { accountingReceiptReady: true, costUsd: 0.01 } }).where(eq(heartbeatRuns.id, runId));
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(true);
  });

  it("reconstructs the actual interrupted-service deadline and disarms after settlement", async () => {
    const { companyId } = await seed({ costAccountingPending: false });
    const startedAt = new Date();
    const [invocation] = await db.insert(promptInjectionInvocations).values({ companyId, source: "settings_test", actorType: "user", actorId: "test",
      connectionId: randomUUID(), grantId: randomUUID(), policyVersion: "tool-result-v1", model: "openai/gpt-oss-safeguard-20b", startedAt }).returning();
    const work = await readCostAccountingWork(db, startedAt.getTime(), directory);
    expect(work).toEqual({ pending: false, nextRunAt: startedAt.getTime() + 120_001 });
    expect((await readCostAccountingWork(db, startedAt.getTime() + 120_001, directory)).pending).toBe(true);
    await db.update(promptInjectionInvocations).set({ status: "unknown" }).where(eq(promptInjectionInvocations.id, invocation.id));
    expect(await readCostAccountingWork(db, startedAt.getTime() + 120_001, directory)).toEqual({ pending: false, nextRunAt: null });
  });

  it("shares service and run recovery across overlapping signals", async () => {
    let release!: () => void;
    const recover = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const reconcile = createCostAccountingReconciler(db, {}, recover);
    const first = reconcile(), second = reconcile();
    expect(first).toBe(second);
    expect(recover).toHaveBeenCalledOnce();
    release();
    await first;
    expect(recover).toHaveBeenCalledOnce();
  });

  it("recovers run receipts even when an unrelated service invocation cannot settle", async () => {
    const { runId } = await seed();
    const reconcile = createCostAccountingReconciler(db, {}, async () => { throw new Error("Unrelated service receipt failed"); });
    await expect(reconcile()).rejects.toThrow("Unrelated service receipt failed");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.costAccountedAt).not.toBeNull();
    expect(run.costAccountingPending).toBe(false);
    expect(await db.select().from(costEvents)).toHaveLength(1);
  });
});
