import { randomUUID } from "node:crypto";
import { databaseWorkPending, reconcileDatabaseWork } from "@paperclipai/db/work-signals";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChildProcess } from "../adapters/utils.js";
import { currentControllerProcessStamp, currentProcessStartedAtMs, type ControllerProcess } from "./controller-process-identity.js";
import { currentProcessProbe } from "./owner-proof.js";
import { proveRunProcessGone } from "./run-process-owner.js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, applyPendingMigrations, closeRegisteredClients, environmentLeases, budgetReservations, budgetEvaluationWork, budgetPolicies, companies, costEvents, costAdjustments, createDb, heartbeatRuns, projects, promptInjectionInvocations, runUsageReceipts, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { accountRunCost, createCostAccountingReconciler, readCostAccountingWork } from "./run-cost-accounting.js";
import { createRunUsageRecorder, persistUsageReceipt, type UsageReceiptEnvelope } from "./usage-receipts.js";
import * as usageReceipts from "./usage-receipts.js";
import * as budgetTracing from "./budget-tracing.js";
import { billingReconciliationService } from "./billing-reconciliation.js";
import { accountingIntegrityService } from "./accounting-integrity.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { recordLegacyProcessSettlement } from "./heartbeat/legacy-process-settlement.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ACCOUNTING_TEST_DATABASE_URL");
if (external && process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL?.trim()) await getEmbeddedPostgresTestSupport();
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("run cost accounting work", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let directory: string;
  let fixtureCompanySequence = 0;
  beforeAll(async () => {
    if (external) {
      await applyPendingMigrations(external);
      database = { connectionString: external, cleanup: () => closeRegisteredClients(external, { scope: "database" }) };
    } else {
      database = await startEmbeddedPostgresTestDatabase("run-cost-work-");
    }
    db = createDb(database.connectionString, external ? { maxConnections: 2 } : undefined);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "run-cost-work-"));
  }, 60_000);
  afterEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE companies CASCADE`);
  }); });
  afterAll(async () => { if (directory) await fs.rm(directory, { force: true, recursive: true }); await database?.cleanup(); });

  async function seed(change: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Accounting", issuePrefix: `ACCT${++fixtureCompanySequence}` });
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

  async function stoppedLegacy() {
    const sourceId = randomUUID(), processStartedAt = new Date(Date.now() - 1000), finishedAt = new Date();
    const owner = await seed({ runtimeMode: "legacy", status: "failed", errorCode: "codex_harness_crash",
      controllerBootId: legacyControllerBootId, controllerLeaseExpiresAt: null,
      processPid: 42, processGroupId: 42, processStartedAt, finishedAt,
      usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 1, accountingReceiptReady: false,
        provider: "openai", model: "test", billingType: "metered_api", costStatus: "unpriced" } });
    await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, owner.agentId));
    await db.insert(budgetReservations).values({ companyId: owner.companyId, agentId: owner.agentId,
      runId: owner.runId, amountCents: "0", state: "held", providerStartedAt: processStartedAt });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    const proof = { schema: "paperclip.legacy-process-settlement.v1", runId: run.id,
      companyId: run.companyId, agentId: run.agentId, runtimeMode: "legacy", targetKind: "local",
      controllerBootId: run.controllerBootId, processPid: run.processPid, processGroupId: run.processGroupId,
      processStartedAt: processStartedAt.toISOString(), finishedAt: finishedAt.toISOString(), status: "failed" };
    return { ...owner, sourceId, run, proof };
  }

  it("normal legacy accounting joins the host-owned process receipt before settling unknown crash usage", async () => {
    const owner = await stoppedLegacy();
    expect(await accountRunCost(db, owner.runId)).toBe(false);
    expect(await readCostAccountingWork(db, Date.now(), directory)).toEqual({ pending: false, nextRunAt: null });
    const wake = vi.fn(), unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.accounting, wake);
    try {
      expect(await recordLegacyProcessSettlement(db, owner.run, () => true)).toBe(true);
      expect(wake).toHaveBeenCalledOnce();
      const [pending] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
      expect(pending.costAccountingPending).toBe(true);
      expect(pending.usageJson).toMatchObject({ accountingReceiptReady: false });
      expect(pending.legacyProcessSettlement).toEqual(owner.proof);
    } finally { unsubscribe(); }
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(true);
    await createCostAccountingReconciler(db)();
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(settled).toMatchObject({ status: "failed", errorCode: "codex_harness_crash", costAccountingPending: false,
      costAccountedAt: expect.any(Date), usageJson: { accountingReceiptReady: false, accountingReceiptUnavailable: true } });
    expect(settled.usageJson?.accountingProviderWorkStarted).toBeUndefined();
    expect(settled.usageJson?.accountingClosureTimedOut).toBeUndefined();
    const [hold] = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, owner.runId));
    expect(hold).toMatchObject({ state: "settled", settledAt: expect.any(Date) });
    const charges = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    expect(charges).toHaveLength(1); expect(charges[0].costStatus).toBe("unpriced");
    const late = { ...receipt(owner, owner.sourceId, 2, 0.02),
      receipt: { ...receipt(owner, owner.sourceId, 2, 0.02).receipt, provider: "openai", biller: "openai" } };
    await persistUsageReceipt(db, late); await persistUsageReceipt(db, late);
    await createCostAccountingReconciler(db)();
    expect(await accountRunCost(db, owner.runId)).toBe(false);
    const final = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    expect(final).toHaveLength(2);
    expect(final.reduce((sum, row) => sum + row.costCents, 0)).toBeCloseTo(2);
    expect(final.filter(row => row.idempotencyKey === `heartbeat:${owner.runId}:late:${late.id}`)).toHaveLength(1);
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(after.costAccountingPending).toBe(false);

    const rollbackOwner = await stoppedLegacy();
    const rollbackWake = vi.fn(), stopWatching = subscribeDeliveryWork(db, DELIVERY_QUEUES.accounting, rollbackWake);
    try {
      await expect(db.transaction(async tx => {
        expect(await recordLegacyProcessSettlement(tx as unknown as Db, rollbackOwner.run, () => true)).toBe(true);
        expect(rollbackWake).not.toHaveBeenCalled();
        throw new Error("controlled producer rollback");
      })).rejects.toThrow("controlled producer rollback");
      expect(rollbackWake).toHaveBeenCalledTimes(1);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.accounting)).toBe(true);
      const [unpublished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, rollbackOwner.runId));
      expect(unpublished.legacyProcessSettlement).toBeNull();
      expect(unpublished.costAccountingPending).toBe(true);
      expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(false);
      expect(rollbackWake).toHaveBeenCalledTimes(1);
      await reconcileDatabaseWork(db, DELIVERY_QUEUES.accounting);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.accounting)).toBe(false);
      expect(rollbackWake).toHaveBeenCalledTimes(2);
      const beforeCommitWakeCount = rollbackWake.mock.calls.length;
      expect(await recordLegacyProcessSettlement(db, rollbackOwner.run, () => true)).toBe(true);
      expect(rollbackWake).toHaveBeenCalledTimes(beforeCommitWakeCount + 1);
    } finally { stopWatching(); }
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(true);
    await createCostAccountingReconciler(db)();
    const [recovered] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, rollbackOwner.runId));
    expect(recovered.costAccountingPending).toBe(false);
  });

  it.skipIf(process.platform === "win32")("normal accounting Retry reconstructs an uncommitted legacy receipt after its real controller and child exited", async () => {
    const identityModule = new URL('./controller-process-identity.ts', import.meta.url).href;
    const loader = fileURLToPath(import.meta.resolve('tsx/esm'));
    async function joinedIdentity() {
      const command = `console.error("accounting-identity:program-entered"); const identity = await import(${JSON.stringify(identityModule)}); console.error("accounting-identity:module-imported"); await identity.currentProcessStartedAtMs(); console.error("accounting-identity:birth-read"); console.log(JSON.stringify(identity.currentControllerProcessStamp()));`;
      let groupId: number | null = null;
      let observedStderrChars = 0;
      const result = await runChildProcess(randomUUID(), process.execPath,
        ['--import', loader, '--input-type=module', '-e', command], {
          cwd: process.cwd(), env: { NODE_OPTIONS: process.env.NODE_OPTIONS ?? '', PATH: process.env.PATH ?? '' },
          timeoutSec: 5, graceSec: 1, onLog: async (stream, chunk) => {
            if (stream === "stderr" && observedStderrChars < 8192) {
              const observed = chunk.slice(0, 8192 - observedStderrChars);
              observedStderrChars += observed.length;
              process.stderr.write(observed);
            }
          },
          onSpawn: async meta => { groupId = meta.processGroupId ?? null; },
        });
      expect(result.exitCode, JSON.stringify({ exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, pid: result.pid, startedAt: result.startedAt, stdoutTail: result.stdout.slice(-8192), stderrTail: result.stderr.slice(-8192) })).toBe(0);
      const identity = JSON.parse(result.stdout.trim()) as ControllerProcess;
      expect(identity.processStartedAt).not.toBeNull();
      expect(Number.isSafeInteger(groupId) && groupId! > 1).toBe(true);
      return { ...identity, groupId };
    }
    const controller = await joinedIdentity(), child = await joinedIdentity();
    const owner = await stoppedLegacy();
    await db.update(heartbeatRuns).set({ controllerBootId: controller.bootId, controllerProcess: controller,
      processPid: child.pid, processGroupId: child.groupId, processStartedAt: new Date(child.processStartedAt!),
      processHostHash: child.hostHash, legacyProcessSettlement: null })
      .where(eq(heartbeatRuns.id, owner.runId));
    await db.insert(environmentLeases).values({ companyId: owner.companyId, heartbeatRunId: owner.runId,
      provider: 'local', providerLeaseId: null, status: 'failed', leasePolicy: 'ephemeral',
      releasedAt: new Date(), metadata: { driver: 'local' } });
    const [base] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    await currentProcessStartedAtMs();
    const liveController = currentControllerProcessStamp();
    const reused = await proveRunProcessGone(base, 'legacy-accounting-reuse-component', {
      ...currentProcessProbe(), controllerInstance: undefined,
      pidExists: () => true, processGroupExists: () => false,
      readStartedAt: async () => new Date(Date.parse(child.processStartedAt!) + 2000),
    });
    expect(reused).toEqual({ verdict: 'gone', reason: 'pid_reused' });
    for (const change of [
      { processHostHash: 'unknown-foreign-process-space' },
      { status: 'cancelled' },
      { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) },
      { executionControlDeadlineAt: new Date() },
      { resultJson: { executionCancellation: { state: 'requested' } } },
      { controllerBootId: liveController.bootId, controllerProcess: liveController },
    ]) {
      await db.update(heartbeatRuns).set({ ...base, ...change }).where(eq(heartbeatRuns.id, owner.runId));
      expect(await accountingIntegrityService(db).retry(owner.companyId, owner.runId, 'board')).toEqual({ accounted: false });
      const [held] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
      expect(held.legacyProcessSettlement).toBeNull(); expect(held.costAccountingPending).toBe(true);
    }
    await db.update(heartbeatRuns).set(base).where(eq(heartbeatRuns.id, owner.runId));
    await db.update(environmentLeases).set({ status: 'active', releasedAt: null })
      .where(eq(environmentLeases.heartbeatRunId, owner.runId));
    expect(await accountingIntegrityService(db).retry(owner.companyId, owner.runId, 'board')).toEqual({ accounted: false });
    await db.update(environmentLeases).set({ status: 'failed', releasedAt: new Date() })
      .where(eq(environmentLeases.heartbeatRunId, owner.runId));
    await db.update(environmentLeases).set({ cleanupStatus: 'failed' })
      .where(eq(environmentLeases.heartbeatRunId, owner.runId));
    expect(await accountingIntegrityService(db).retry(owner.companyId, owner.runId, 'board')).toEqual({ accounted: false });
    await db.update(environmentLeases).set({ cleanupStatus: null })
      .where(eq(environmentLeases.heartbeatRunId, owner.runId));
    let leaseLocked!: () => void, releaseLease!: () => void;
    const locked = new Promise<void>(resolve => { leaseLocked = resolve; });
    const release = new Promise<void>(resolve => { releaseLease = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, owner.runId)).for('update');
      leaseLocked(); await release;
    });
    await locked;
    try {
      expect(await accountingIntegrityService(db).retry(owner.companyId, owner.runId, 'board')).toEqual({ accounted: false });
    } finally { releaseLease(); await holder; }
    const precommitLost = new Proxy(db, { get(target, property) {
      if (property === 'transaction') return async (callback: Parameters<Db['transaction']>[0], options?: Parameters<Db['transaction']>[1]) =>
        target.transaction(async tx => {
          await callback(tx);
          throw new Error('controlled closure publication rollback');
        }, options);
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Db;
    await expect(accountingIntegrityService(precommitLost).retry(owner.companyId, owner.runId, 'board'))
      .rejects.toThrow('controlled closure publication rollback');
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId))).toEqual([]);
    const [uncommitted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(uncommitted.legacyProcessSettlement).toBeNull();
    expect(uncommitted.costAccountingPending).toBe(true);
    let lostReply = false;
    const replyLost = new Proxy(db, { get(target, property) {
      if (property === 'transaction') return async (...args: Parameters<Db['transaction']>) => {
        const result = await target.transaction(...args);
        if (!lostReply) { lostReply = true; throw new Error('controlled committed reply loss'); }
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Db;
    await expect(accountingIntegrityService(replyLost).retry(owner.companyId, owner.runId, 'board'))
      .rejects.toThrow('controlled committed reply loss');
    const result = await accountingIntegrityService(db).retry(owner.companyId, owner.runId, 'board');
    expect(result.accounted).toBe(true);
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(settled.legacyProcessSettlement).toMatchObject({ controllerBootId: controller.bootId,
      processPid: child.pid, processGroupId: child.groupId, schema: 'paperclip.legacy-process-settlement.v1' });
    expect(settled.usageJson).toMatchObject({ accountingReceiptReady: false, accountingReceiptUnavailable: true });
    expect(await accountingIntegrityService(db).retry(owner.companyId, owner.runId, 'board')).toEqual({ accounted: false });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId))).toHaveLength(1);
  });

  it("keeps missing malformed foreign live and controlled legacy closure evidence pending", async () => {
    const owner = await stoppedLegacy();
    for (const bad of [null, {}, [], { ...owner.proof, extra: true }, { ...owner.proof, processPid: "42" },
      ...Object.keys(owner.proof).map(key => ({ ...owner.proof, [key]: "foreign" }))]) {
      await db.update(heartbeatRuns).set({ legacyProcessSettlement: sql`${JSON.stringify(bad)}::jsonb` }).where(eq(heartbeatRuns.id, owner.runId));
      expect(await accountRunCost(db, owner.runId)).toBe(false);
      expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(false);
    }
    for (const changed of [{ status: "running" }, { controllerLeaseExpiresAt: new Date(Date.now() + 1000) },
      { controllerBootId: randomUUID() }, { processPid: 43 }, { processGroupId: 43 },
      { processStartedAt: new Date(0) }, { processPid: null, processGroupId: null, processStartedAt: null },
      { runtimeMode: "native" }, { executionControlDeadlineAt: new Date() },
      { resultJson: { executionCancellation: { state: "requested" } } }]) {
      await db.update(heartbeatRuns).set({ ...owner.run, legacyProcessSettlement: owner.proof, ...changed })
        .where(eq(heartbeatRuns.id, owner.runId));
      expect(await accountRunCost(db, owner.runId)).toBe(false);
    }
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId))).toEqual([]);
  });

  it("preserves observed spend as a lower bound when the stopped legacy provider lost its final receipt", async () => {
    const owner = await stoppedLegacy();
    await db.update(heartbeatRuns).set({ legacyProcessSettlement: owner.proof,
      usageJson: { ...owner.run.usageJson, costUsd: 0.01, inputTokens: 5, outputTokens: 2,
        budgetExposure: { sourceId: owner.sourceId, sequence: 1, costCents: "2.0000000" } } })
      .where(eq(heartbeatRuns.id, owner.runId));
    expect(await accountRunCost(db, owner.runId)).toBe(true);
    const [charge] = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    expect(charge).toMatchObject({ costCents: 2, inputTokens: 5, outputTokens: 2, costStatus: "estimated" });
    expect(charge.pricingProvenance?.evidence).toContain("lower bound");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.usageJson).toMatchObject({ accountingReceiptReady: false, accountingReceiptUnavailable: true });
  });

  it("preserves included subscription cost policy while legacy usage remains explicitly incomplete", async () => {
    const owner = await stoppedLegacy();
    await db.update(heartbeatRuns).set({ legacyProcessSettlement: owner.proof,
      usageJson: { ...owner.run.usageJson, billingType: 'subscription_included', costUsd: null } })
      .where(eq(heartbeatRuns.id, owner.runId));
    expect(await accountRunCost(db, owner.runId)).toBe(true);
    const [charge] = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    expect(charge).toMatchObject({ billingType: 'subscription_included', costStatus: 'reported', costCents: 0 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.usageJson).toMatchObject({ accountingReceiptReady: false, accountingReceiptUnavailable: true });
  });

  it("revalidates exact legacy process receipt and claim after the accounting spool pre-read", async () => {
    const owner = await stoppedLegacy();
    await db.update(heartbeatRuns).set({ legacyProcessSettlement: owner.proof }).where(eq(heartbeatRuns.id, owner.runId));
    let changed = false;
    const replacementClaim = randomUUID();
    const observed = new Proxy(db, { get(target, property) {
      if (property === "transaction") return async (...args: Parameters<Db["transaction"]>) => {
        if (!changed) { changed = true; await db.update(heartbeatRuns).set({
          controllerBootId: replacementClaim, legacyProcessSettlement: { ...owner.proof, controllerBootId: replacementClaim },
        }).where(eq(heartbeatRuns.id, owner.runId)); }
        return target.transaction(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as Db;
    const race = await Promise.allSettled([accountRunCost(observed, owner.runId)]);
    if (race[0].status === 'fulfilled') expect(race[0].value).toBe(false);
    else expect(race[0].reason.message).toContain('closure changed');
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId))).toEqual([]);
    const [pending] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(pending.costAccountingPending).toBe(true);
  });

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
    const began = performance.now();
    const observations: Record<string, unknown>[] = [];
    let droppedObservations = 0;
    const observe = (event: string, detail: Record<string, unknown> = {}) => {
      if (observations.length < 128) observations.push({ event, elapsedMs: performance.now() - began, ...detail });
      else droppedObservations++;
    };
    const previousDebug = db.$client.options.debug;
    db.$client.options.debug = (connection, query, parameters, types) => {
      const verb = query.trim().split(/\s+/, 1)[0]?.toLowerCase();
      observe("driver-query-built", { connection, operation: verb && ["select", "insert", "update", "delete", "begin", "commit", "rollback", "savepoint", "release"].includes(verb) ? verb : "other" });
      if (typeof previousDebug === "function") previousDebug(connection, query, parameters, types);
    };
    const originalBudgetSpan = budgetTracing.withBudgetSpan;
    const spanObserver = vi.spyOn(budgetTracing, "withBudgetSpan").mockImplementation(
      <T>(name: Parameters<typeof originalBudgetSpan>[0], work: () => Promise<T>, attributes?: Parameters<typeof originalBudgetSpan>[2]) => {
        observe("operation-entered", { name });
        const result = originalBudgetSpan(name, work, attributes);
        void result.then(() => { observe("operation-fulfilled", { name }); }, () => { observe("operation-rejected", { name }); });
        return result;
      });
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let holder: Promise<unknown> | undefined;
    let settle: Promise<unknown> | undefined;
    try {
      observe("holder-requested");
      holder = db.transaction(async tx => {
        observe("holder-transaction-entered");
        await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, owner.companyId)).for("no key update");
        observe("holder-company-lock-acquired");
        await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, owner.agentId)).for("no key update");
        observe("holder-agent-lock-acquired");
        await tx.select({ id: budgetPolicies.id }).from(budgetPolicies).where(eq(budgetPolicies.id, policy.id)).for("update");
        observe("holder-policy-lock-acquired");
        locked();
        await gate;
        observe("holder-gate-released");
      });
      await acquired;
      observe("settlement-requested");
      settle = accountRunCost(db, owner.runId);
      const raceResult = await Promise.race([settle, new Promise(resolve => { timer = setTimeout(() => resolve("blocked"), 1500); })]);
      observe("original-race-result", { result: raceResult });
      expect(raceResult).toBe(true);
      observe("original-race-assertion-passed");
    } finally {
      if (timer) clearTimeout(timer);
      release();
      try {
        if (holder) { await holder; observe("holder-transaction-fulfilled"); }
        if (settle) { await settle; observe("settlement-promise-fulfilled"); }
      } finally {
        db.$client.options.debug = previousDebug;
        spanObserver.mockRestore();
        console.error("accounting-held-writer-observation " + JSON.stringify({ observations, droppedObservations,
          scope: "query-build-and-operation-completion; no query-result/SQL-wait proof; no SQL or parameters logged" }));
      }
    }
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

  it("commits conflicting native late evidence and keeps its debt quiet", async () => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 0.01));
    await accountRunCost(db, owner.runId);
    const late = { ...receipt(owner, sourceId, 2, 0.02, 5), producerEvent: { sourceEventId: "late", eventType: "usage.reported" } };
    await persistUsageReceipt(db, late);
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.id, late.id))).toHaveLength(1);
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(true);
    expect(await accountRunCost(db, owner.runId)).toBe(false);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.costAccountingPending).toBe(true);
    expect(run.usageJson).toMatchObject({ accountingLateReceiptPending: true, accountingLateReceiptAttemptedId: late.id });
    expect((await readCostAccountingWork(db, Date.now(), directory)).pending).toBe(false);
    expect((await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId)))[0].costCents).toBe(1);
  });

  it("never counts money twice when late growth and a price correction combine", async () => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 1, 100));
    await accountRunCost(db, owner.runId);
    const total = async () => {
      const charges = await db.select({ cents: sql<string>`${costEvents.costCents}::text` }).from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
      return charges.reduce((sum, charge) => sum + Number(charge.cents), 0);
    };
    await persistUsageReceipt(db, receipt(owner, sourceId, 2, 1.2, 120));
    expect(await accountRunCost(db, owner.runId)).toBe(true);
    expect(await total()).toBeCloseTo(120);
    // The same tokens at a corrected whole-run price.
    await persistUsageReceipt(db, receipt(owner, sourceId, 3, 1.3, 120));
    expect(await accountRunCost(db, owner.runId)).toBe(true);
    expect(await total()).toBeCloseTo(130);
    // More tokens after that correction charge only the new difference.
    await persistUsageReceipt(db, receipt(owner, sourceId, 4, 1.5, 140));
    expect(await accountRunCost(db, owner.runId)).toBe(true);
    expect(await total()).toBeCloseTo(150);
    // Run totals follow provider-reported amounts, and corrections stay separate.
    expect((await accountingIntegrityService(db).inspect(owner.companyId)).findings.filter(finding => finding.entityId === owner.runId)).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId)))[0].costAccountingPending).toBe(false);
  });

  it.each(["cumulative first", "delta first"])("adds a later run's increment to a queued source total: %s", async order => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 1, 100));
    await accountRunCost(db, owner.runId);
    const cumulative = receipt(owner, sourceId, 2, 1.2, 120);
    const delta: UsageReceiptEnvelope = { ...receipt(owner, randomUUID(), 1, 0.1, 10), lateDelta: { attribution: "exact", reportedByRunId: randomUUID() } };
    for (const item of order === "cumulative first" ? [cumulative, delta] : [delta, cumulative]) await persistUsageReceipt(db, item);
    for (let attempt = 0; attempt < 3; attempt++) await accountRunCost(db, owner.runId);
    const charges = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    expect(charges.reduce((sum, charge) => sum + charge.inputTokens, 0)).toBe(130);
    expect(charges.reduce((sum, charge) => sum + charge.costCents, 0)).toBeCloseTo(130);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.usageJson).toMatchObject({ inputTokens: 130, accountingLateReceiptPending: false });
    expect((await accountingIntegrityService(db).inspect(owner.companyId)).findings.filter(finding => finding.entityId === owner.runId)).toEqual([]);
  });

  it("keeps late increment totals through a heartbeat metadata write", async () => {
    const owner = await seed({ usageJson: { accountingReceiptOwner: "native_producer", accountingLateDeltas: { inputTokens: 10, units: "100000000" } } });
    await db.update(heartbeatRuns).set({ usageJson: usageReceipts.preserveAcceptedRunUsageProjectionSql({ accountingLateDeltas: null, note: "completion" }) })
      .where(eq(heartbeatRuns.id, owner.runId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.usageJson).toMatchObject({ note: "completion", accountingLateDeltas: { inputTokens: 10, units: "100000000" } });
  });

  it("clears an older growth receipt that a newer cumulative receipt already covers", async () => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 1, 100));
    await accountRunCost(db, owner.runId);
    await persistUsageReceipt(db, receipt(owner, sourceId, 2, 1.2, 120));
    await persistUsageReceipt(db, receipt(owner, sourceId, 3, 1.4, 140));
    await accountRunCost(db, owner.runId);
    // Clearing the remaining debt must wake budgets that the debt was holding.
    await db.delete(budgetEvaluationWork).where(eq(budgetEvaluationWork.companyId, owner.companyId));
    await accountRunCost(db, owner.runId);
    expect((await db.select().from(budgetEvaluationWork).where(eq(budgetEvaluationWork.companyId, owner.companyId))).length).toBeGreaterThan(0);
    const charges = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    expect(charges.reduce((sum, charge) => sum + charge.inputTokens, 0)).toBe(140);
    expect(charges.reduce((sum, charge) => sum + charge.costCents, 0)).toBeCloseTo(140);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.usageJson).toMatchObject({ accountingLateReceiptPending: false });
    expect(run.costAccountingPending).toBe(false);
    expect(run.accountingLastError).toBeNull();
  });

  it("keeps an older receipt with conflicting billing as debt even when its tokens are covered", async () => {
    const sourceId = randomUUID();
    const owner = await seed({ usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 } });
    await persistUsageReceipt(db, receipt(owner, sourceId, 1, 1, 100));
    await accountRunCost(db, owner.runId);
    const conflicting = receipt(owner, sourceId, 2, 1.2, 120);
    conflicting.receipt.biller = "another-biller";
    await persistUsageReceipt(db, conflicting);
    await persistUsageReceipt(db, receipt(owner, sourceId, 3, 1.4, 140));
    for (let attempt = 0; attempt < 3; attempt++) await accountRunCost(db, owner.runId);
    const charges = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, owner.runId));
    expect(charges.reduce((sum, charge) => sum + charge.inputTokens, 0)).toBe(140);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(run.usageJson).toMatchObject({ accountingLateReceiptPending: true, accountingLateReceiptId: conflicting.id });
    expect(run.accountingLastError).toBe("late_usage_requires_reconciliation");
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
