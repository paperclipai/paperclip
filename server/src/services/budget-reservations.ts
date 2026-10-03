import { and, eq, sql } from "drizzle-orm";
import { budgetPolicies, budgetReservations, heartbeatRuns, type Db } from "@paperclipai/db";
import { centsToUnits, unitsToCents } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { budgetServiceInTransaction, computeObservedSpend } from "./budgets.js";

/** Reserve before dispatch, under the same company lock as charges and policy
 * changes. Estimates constrain admission; they cannot cap a provider's bill.
 * A reservation survives timeouts and restarts until accounting proves closure. */
export async function reserveRunBudget(db: Db, companyId: string, runId: string, projectId: string | null, ledgerScope: Record<string, unknown> = {}) {
  return withAccountingTransaction(db, companyId, async (tx, publications) => {
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).for("update");
    if (!run) throw notFound("Run not found");
    if (run.costAccountedAt || !["queued", "running"].includes(run.status)) throw conflict("Run can no longer start provider work");
    const [existing] = await tx.select().from(budgetReservations).where(and(eq(budgetReservations.companyId, companyId), eq(budgetReservations.runId, runId)));
    if (existing) throw conflict("Provider dispatch has already reserved this run");
    const block = await budgetServiceInTransaction(tx, publications).getInvocationBlock(companyId, run.agentId, { projectId });
    if (block) throw conflict(block.reason);
    const candidates = await tx.select().from(budgetPolicies).where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.isActive, true), eq(budgetPolicies.hardStopEnabled, true)));
    const policies = candidates.filter(p => p.metric === "billed_cents" && p.amount > 0 && (
      p.scopeType === "company" && p.scopeId === companyId || p.scopeType === "agent" && p.scopeId === run.agentId || p.scopeType === "project" && p.scopeId === projectId));
    const amount = policies.reduce((max, policy) => { const next = centsToUnits(policy.reservationCents); return next > max ? next : max; }, 0n);
    for (const policy of policies) {
      const [held] = await tx.select({ amount: sql<string>`coalesce(sum(${budgetReservations.amountCents}), 0)::text` }).from(budgetReservations).where(and(
        eq(budgetReservations.companyId, companyId), eq(budgetReservations.state, "held"),
        policy.scopeType === "agent" ? eq(budgetReservations.agentId, run.agentId) : undefined,
        policy.scopeType === "project" ? eq(budgetReservations.projectId, projectId!) : undefined,
      ));
      const observed = await computeObservedSpend(tx, policy);
      // Even zero-estimate runs cannot enter a scope whose available capacity
      // is completely reserved. Outstanding reservations carry across months.
      const committed = centsToUnits(observed.totalExact) + centsToUnits(held.amount);
      const limit = centsToUnits(policy.amount);
      if (committed >= limit || committed + amount > limit) throw conflict("Available budget is reserved by unfinished runs");
    }
    // A zero-valued row also fences duplicate dispatch when estimates are off.
    const [reservation] = await tx.insert(budgetReservations).values({ companyId, runId, agentId: run.agentId, projectId,
      amountCents: unitsToCents(amount), providerStartedAt: new Date() }).returning();
    await tx.update(heartbeatRuns).set({ costAccountingPending: true,
      usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || ${JSON.stringify({ accountingReceiptReady: false, ledgerScope: { ...(run.usageJson?.ledgerScope as object ?? {}), ...ledgerScope, projectId } })}::jsonb`,
    }).where(eq(heartbeatRuns.id, runId));
    return reservation;
  });
}
