import { usdToUnits, unitsToCents } from "@paperclipai/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { accountingRuntimeBaselines, budgetReservations, agentRuntimeState, agents, costEvents, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { createCostEventInTransaction } from "./costs.js";
import { budgetService, deliverBudgetEnforcement, type BudgetServiceHooks } from "./budgets.js";
import { logger } from "../middleware/logger.js";

const terminalStatuses = ["succeeded", "failed", "timed_out", "cancelled", "interrupted"];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;
const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** The run's persisted usage is a durable receipt. Ledger, runtime totals, and
 * acknowledgement commit together, including after a restart or failed run. */
export async function accountRunCost(db: Db, runId: string, hooks: BudgetServiceHooks = {}) {
  const [identity] = await db.select({ companyId: heartbeatRuns.companyId }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  if (!identity) return false;
  const accounted = await withAccountingTransaction(db, identity.companyId, async (tx, publications) => {
    const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
    if (!run?.costAccountingPending || !terminalStatuses.includes(run.status)) return false;
    if (run.costAccountedAt) {
      await tx.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, run.id));
      return false;
    }
    const preProviderFailure = object(object(run.resultJson).executionRecovery).providerWorkStarted === false
      || object(run.usageJson).accountingProviderWorkStarted === false;
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
    const receipt = {
      idempotencyKey: `heartbeat:${run.id}:final`,
      agentId: run.agentId, heartbeatRunId: run.id,
      issueId: text(scope.issueId), projectId: text(scope.projectId), billingCode: text(scope.billingCode),
      provider: text(usage.provider) ?? "unknown", biller: text(usage.biller) ?? text(usage.provider) ?? "unknown",
      providerRequestId: text(usage.providerRequestId),
      pricingProvenance: object(usage.pricingProvenance),
      model: text(usage.model) ?? "unknown", billingType,
      costStatus: costUsd === null && billingType !== "subscription_included" ? "unpriced" : usage.costStatus === "estimated" ? "estimated" : "reported",
      inputTokens: amount(usage.inputTokens) ?? 0, cachedInputTokens: amount(usage.cachedInputTokens) ?? 0, outputTokens: amount(usage.outputTokens) ?? 0,
      costCents, occurredAt: run.finishedAt ?? run.createdAt,
    };
    const parts = Array.isArray(usage.usageByModel) ? usage.usageByModel.map(object) : [];
    const tokensMatch = ["inputTokens", "cachedInputTokens", "outputTokens"].every((key) =>
      parts.reduce((sum, part) => sum + (amount(object(part.usage)[key]) ?? 0), 0) === (amount(usage[key]) ?? 0));
    const costMatches = costUsd !== null && parts.reduce((sum, part) => sum + usdToUnits(amount(part.costUsd) ?? 0), 0n) === usdToUnits(costUsd);
    const validParts = parts.length > 0 && tokensMatch && costMatches
      && parts.every((part) => text(part.model) && amount(part.costUsd) !== null)
      && new Set(parts.map((part) => part.model)).size === parts.length;
    if (validParts) {
      let allocated = 0n;
      for (const [index, part] of parts.entries()) {
        const partUsage = object(part.usage);
        const remainder = costUnits - allocated;
        const reported = usdToUnits(amount(part.costUsd) ?? 0);
        const partUnits = billingType === "subscription_included" ? 0n : index === parts.length - 1 ? remainder : reported < remainder ? reported : remainder;
        allocated += partUnits;
        const partCents = unitsToCents(partUnits);
        await createCostEventInTransaction(tx, run.companyId, {
          ...receipt, idempotencyKey: `heartbeat:${run.id}:model:${index}`, model: text(part.model)!,
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
    const [agent] = await tx.select({ adapterType: agents.adapterType }).from(agents).where(eq(agents.id, run.agentId));
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
  await deliverBudgetEnforcement(db, hooks, identity.companyId);
  return accounted;
}

export async function reconcileRunCosts(db: Db, hooks: BudgetServiceHooks = {}) {
  const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.costAccountingPending, true), inArray(heartbeatRuns.status, terminalStatuses),
    sql`(${heartbeatRuns.usageJson}->>'accountingReceiptReady' is distinct from 'false' or ${heartbeatRuns.resultJson}->'executionRecovery'->>'providerWorkStarted' = 'false' or ${heartbeatRuns.usageJson}->>'accountingProviderWorkStarted' = 'false')`,
  )).orderBy(asc(heartbeatRuns.updatedAt), asc(heartbeatRuns.id)).limit(100);
  let accounted = 0;
  for (const run of pending) {
    try { if (await accountRunCost(db, run.id, hooks)) accounted++; }
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
