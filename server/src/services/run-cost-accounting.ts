import { usdToUnits, unitsToCents } from "@paperclipai/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { accountingRuntimeBaselines, budgetReservations, agentRuntimeState, agents, costEvents, heartbeatRuns, nativeRunFinalizations, issues, projects, type Db } from "@paperclipai/db";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { conflict } from "../errors.js";
import { createCostEventInTransaction } from "./costs.js";
import { budgetService, deliverBudgetEnforcement, type BudgetServiceHooks } from "./budgets.js";
import { logger } from "../middleware/logger.js";
import { promises as fs } from "node:fs";
import { replayUsageReceipts, indexPendingUsageReceipts, recoverPendingRunUsageReceipts, type UsageReceiptIndex } from "./usage-receipts.js";

const terminalStatuses = ["succeeded", "failed", "timed_out", "cancelled", "interrupted"];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;
const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** The run's persisted usage is a durable receipt. Ledger, runtime totals, and
 * acknowledgement commit together, including after a restart or failed run. */
export async function accountRunCost(db: Db, runId: string, hooks: BudgetServiceHooks = {}, receiptIndex?: UsageReceiptIndex) {
  const [identity] = await db.select({ companyId: heartbeatRuns.companyId, status: heartbeatRuns.status,
    pending: heartbeatRuns.costAccountingPending, accountedAt: heartbeatRuns.costAccountedAt,
    issueId: sql<string | null>`${heartbeatRuns.usageJson}->'ledgerScope'->>'issueId'`,
  }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  if (!identity) return false;
  // Finalization can call twice. Avoid disk work for settled or active runs,
  // but retain the locked recheck, stale-marker cleanup, and stop delivery.
  const index = identity.pending && !identity.accountedAt && terminalStatuses.includes(identity.status)
    ? receiptIndex ?? await indexPendingUsageReceipts() : undefined;
  let recoveredFiles: string[] = [];
  const accounted = await withAccountingTransaction(db, identity.companyId, async (tx, publications) => {
    // Native recovery owns the issue before updating its run. Acquire the
    // charge's issue FK lock first so inserting it cannot reverse that order.
    const issueId = text(identity.issueId);
    if (issueId) await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, identity.companyId), eq(issues.id, issueId),
    )).for("key share");
    let [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
    if (!run?.costAccountingPending || !terminalStatuses.includes(run.status)) return false;
    if (run.costAccountedAt) {
      await tx.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, run.id));
      return false;
    }
    // The bounded global replay can leave a newer receipt behind an older
    // complete snapshot. Drain this run under the accounting lock before
    // deciding completeness, and retain disk evidence until the outer commit.
    recoveredFiles = await recoverPendingRunUsageReceipts(tx, { companyId: identity.companyId, runId }, undefined, { retainFiles: true, index });
    [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    if (text(object(object(run.usageJson).ledgerScope).issueId) !== issueId) {
      throw conflict("Run cost attribution changed. Retry accounting.");
    }
    // A failed capture may follow an older complete attempt. Neither replay
    // nor terminal status can certify that the missing work was free.
    if (object(run.usageJson).accountingCaptureFailed === true) return false;
    const preProviderFailure = object(object(run.resultJson).executionRecovery).providerWorkStarted === false
      || object(run.usageJson).accountingProviderWorkStarted === false;
    // A failed native turn is not necessarily the end of this heartbeat: the
    // coordinator can resume the same run. Only its closed provider boundary
    // authorizes acknowledgement; finalization may still run after a result.
    if (run.runtimeMode === "native" && !preProviderFailure) {
      const [coordinator] = await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
      if (coordinator && !coordinator.resultId && coordinator.phase !== "terminal_failure") return false;
    }
    // A stop can mark the run terminal before the provider's shutdown receipt
    // arrives. Keep the debt pending instead of acknowledging an invented zero
    // and permanently discarding that late receipt.
    if (!preProviderFailure && object(run.usageJson).accountingReceiptReady === false) return false;
    // Acknowledgement is part of the same transaction. Budget checks inside
    // this transaction must not mistake this receipt for missing accounting.
    await tx.update(heartbeatRuns).set({ costAccountingPending: false, costAccountedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    await tx.update(budgetReservations).set({ state: preProviderFailure ? "released" : "settled", settledAt: new Date() })
      .where(and(eq(budgetReservations.companyId, run.companyId), eq(budgetReservations.runId, run.id), eq(budgetReservations.state, "held")));
    if (preProviderFailure) return true;
    const usage = object(run.usageJson);
    const scope = object(usage.ledgerScope);
    // Deleted attribution targets become unallocated; a deletion must never
    // prevent recording provider spend. Foreign-company references still fail.
    for (const [table, key] of [[issues, "issueId"], [projects, "projectId"]] as const) {
      const id = text(scope[key]);
      if (id) {
        const [linked] = await tx.select({ id: table.id }).from(table).where(eq(table.id, id));
        if (!linked) scope[key] = null;
      }
    }
    const costUsd = amount(usage.cacheAdjustedCostUsd) ?? text(usage.costUsdExact) ?? amount(usage.costUsd);
    const billingType = text(usage.billingType) ?? "unknown";
    const costUnits = billingType === "subscription_included" ? 0n : usdToUnits(costUsd ?? 0);
    const costCents = unitsToCents(costUnits);
    const [agent] = await tx.select({ adapterType: agents.adapterType }).from(agents).where(eq(agents.id, run.agentId));
    const hasBillableEvidence = agent?.adapterType !== "process" || costUsd !== null || usage.costStatus === "unpriced"
      || ["inputTokens", "cachedInputTokens", "outputTokens"].some(key => (amount(usage[key]) ?? 0) > 0)
      || (text(usage.provider) !== null && usage.provider !== "unknown");
    const receipt = {
      idempotencyKey: `heartbeat:${run.id}:final`,
      agentId: run.agentId, heartbeatRunId: run.id,
      issueId: text(scope.issueId), projectId: text(scope.projectId), billingCode: text(scope.billingCode),
      provider: text(usage.provider) ?? "unknown", biller: text(usage.biller) ?? text(usage.provider) ?? "unknown",
      providerRequestId: text(usage.providerRequestId),
      pricingProvenance: object(usage.pricingProvenance),
      model: text(usage.model) ?? "unknown", billingType,
      costStatus: (costUsd === null || usage.costStatus === "unpriced") && billingType !== "subscription_included" && hasBillableEvidence ? "unpriced" : usage.costStatus === "estimated" ? "estimated" : "reported",
      inputTokens: amount(usage.inputTokens) ?? 0, cachedInputTokens: amount(usage.cachedInputTokens) ?? 0, outputTokens: amount(usage.outputTokens) ?? 0,
      costCents, occurredAt: run.finishedAt ?? run.createdAt,
    };
    const parts = Array.isArray(usage.usageByModel) ? usage.usageByModel.map(object) : [];
    const tokensMatch = ["inputTokens", "cachedInputTokens", "outputTokens"].every((key) =>
      parts.reduce((sum, part) => sum + (amount(object(part.usage)[key]) ?? 0), 0) === (amount(usage[key]) ?? 0));
    const costMatches = costUsd !== null && parts.reduce((sum, part) => sum + usdToUnits(amount(part.costUsd) ?? 0), 0n) === usdToUnits(costUsd);
    // Parts may name their own provider (an in-run fallback billed by another
    // provider); each provider/model pair is one distinct ledger row.
    const partKey = (part: Record<string, unknown>) => `${text(part.provider) ?? receipt.provider}\u0000${text(part.model)}`;
    const validParts = parts.length > 0 && tokensMatch && costMatches
      && parts.every((part) => text(part.model) && amount(part.costUsd) !== null)
      && new Set(parts.map(partKey)).size === parts.length;
    if (validParts) {
      let allocated = 0n;
      for (const [index, part] of parts.entries()) {
        const partUsage = object(part.usage);
        const remainder = costUnits - allocated;
        const reported = usdToUnits(amount(part.costUsd) ?? 0);
        const partUnits = billingType === "subscription_included" ? 0n : index === parts.length - 1 ? remainder : reported < remainder ? reported : remainder;
        allocated += partUnits;
        const partCents = unitsToCents(partUnits);
        const partProvider = text(part.provider);
        await createCostEventInTransaction(tx, run.companyId, {
          ...receipt, idempotencyKey: `heartbeat:${run.id}:model:${index}`, model: text(part.model)!,
          ...(partProvider ? { provider: partProvider, biller: text(part.biller) ?? partProvider } : {}),
          inputTokens: amount(partUsage.inputTokens) ?? 0, cachedInputTokens: amount(partUsage.cachedInputTokens) ?? 0,
          outputTokens: amount(partUsage.outputTokens) ?? 0, costCents: partCents,
        }, publications);
      }
    } else {
      await createCostEventInTransaction(tx, run.companyId, receipt, publications);
    }
    const [event] = await tx.select({
      inputTokens: sql<string>`coalesce(sum(${costEvents.inputTokens}),0)::text`,
      cachedInputTokens: sql<string>`coalesce(sum(${costEvents.cachedInputTokens}),0)::text`,
      outputTokens: sql<string>`coalesce(sum(${costEvents.outputTokens}),0)::text`,
      costCents: sql<string>`coalesce(sum(${costEvents.costCents}),0)::text`,
    }).from(costEvents).where(and(eq(costEvents.companyId, run.companyId), eq(costEvents.heartbeatRunId, run.id)));
    await tx.insert(agentRuntimeState).values({ agentId: run.agentId, companyId: run.companyId, adapterType: agent.adapterType }).onConflictDoNothing();
    await tx.execute(sql`insert into accounting_runtime_baselines (agent_id,company_id,cost_cents,input_tokens,cached_input_tokens,output_tokens)
      select agent_id,company_id,total_cost_cents,total_input_tokens,total_cached_input_tokens,total_output_tokens
      from agent_runtime_state where agent_id = ${run.agentId} on conflict do nothing`);
    await tx.update(agentRuntimeState).set({
      totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${event.inputTokens}`,
      totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${event.cachedInputTokens}`,
      totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${event.outputTokens}`,
      totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${event.costCents}::numeric`,
      updatedAt: new Date(),
    }).where(eq(agentRuntimeState.agentId, run.agentId));
    await tx.update(heartbeatRuns).set({ costAccountingPending: false, costAccountedAt: new Date(), accountingProjectionVersion: "v2", accountingLastError: null, accountingLastAttemptAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    return true;
  });
  for (const file of recoveredFiles) {
    try { await fs.rm(file, { force: true }); }
    catch (error) { logger.warn({ err: error, runId }, "Accounting committed; recovered receipt cleanup will retry"); }
  }
  await deliverBudgetEnforcement(db, hooks, identity.companyId);
  return accounted;
}

export async function reconcileRunCosts(db: Db, hooks: BudgetServiceHooks = {}) {
  const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.costAccountingPending, true), inArray(heartbeatRuns.status, terminalStatuses),
    sql`${heartbeatRuns.usageJson}->>'accountingCaptureFailed' is distinct from 'true'`,
    sql`(${heartbeatRuns.resultJson}->'executionRecovery'->>'providerWorkStarted' = 'false'
      or ${heartbeatRuns.usageJson}->>'accountingProviderWorkStarted' = 'false'
      or not exists (select 1 from ${nativeRunFinalizations} where ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
      and ${heartbeatRuns.runtimeMode} = 'native' and ${nativeRunFinalizations.resultId} is null
      and ${nativeRunFinalizations.phase} <> 'terminal_failure'))`,
    sql`(${heartbeatRuns.usageJson}->>'accountingReceiptReady' is distinct from 'false' or ${heartbeatRuns.resultJson}->'executionRecovery'->>'providerWorkStarted' = 'false' or ${heartbeatRuns.usageJson}->>'accountingProviderWorkStarted' = 'false')`,
  )).orderBy(asc(heartbeatRuns.updatedAt), asc(heartbeatRuns.id)).limit(100);
  let accounted = 0;
  const receiptIndex = pending.length > 0 ? await indexPendingUsageReceipts() : undefined;
  for (const run of pending) {
    try { if (await accountRunCost(db, run.id, hooks, receiptIndex)) accounted++; }
    catch (error) {
      // Move failed attempts behind other pending work so a poisoned receipt
      // cannot monopolize the bounded batch on every recovery tick.
      await db.update(heartbeatRuns).set({ updatedAt: new Date(), accountingLastAttemptAt: new Date(), accountingAttemptCount: sql`${heartbeatRuns.accountingAttemptCount} + 1`, accountingLastError: error instanceof Error ? error.message.slice(0, 1000) : "Accounting failed" }).where(eq(heartbeatRuns.id, run.id));
      logger.error({ err: error, runId: run.id }, "Run accounting remains pending for retry");
    }
  }
  await budgetService(db, hooks).reconcilePolicies();
  return { scanned: pending.length, accounted };
}

/** Share one full sweep across overlapping scheduler ticks. Do not enqueue
 * another sweep: the next tick retries after either success or failure. */
export function createCostAccountingReconciler(db: Db, hooks: BudgetServiceHooks = {}) {
  let inFlight: Promise<Awaited<ReturnType<typeof reconcileRunCosts>>> | undefined;
  return () => {
    if (!inFlight) {
      inFlight = (async () => {
        try {
          await replayUsageReceipts(db);
          return await reconcileRunCosts(db, hooks);
        } finally {
          inFlight = undefined;
        }
      })();
    }
    return inFlight;
  };
}
