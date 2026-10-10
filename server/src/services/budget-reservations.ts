import { and, eq, sql } from "drizzle-orm";
import { agents, budgetPolicies, budgetReservations, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { centsToUnits, unitsToCents } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { budgetServiceInTransaction, budgetPoliciesForRun, computeObservedSpend } from "./budgets.js";

/** Reserve before dispatch, under the same company lock as charges and policy
 * changes. Estimates constrain admission; they cannot cap a provider's bill.
 * A reservation survives timeouts and restarts until accounting proves closure. */
export async function reserveRunBudget(db: Db, companyId: string, runId: string, projectId: string | null, ledgerScope: Record<string, unknown> = {}, recoveryLeaseOwner?: string) {
  return withAccountingTransaction(db, companyId, async (tx, publications) => {
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).for("update");
    if (!run) throw notFound("Run not found");
    if (run.resultJson?.cancellation || run.resultJson?.startupCancellation) throw conflict("Run cancellation already requested");
    if (run.costAccountedAt || !["queued", "running"].includes(run.status)) throw conflict("Run can no longer start provider work");
    const [existing] = await tx.select().from(budgetReservations).where(and(eq(budgetReservations.companyId, companyId), eq(budgetReservations.runId, runId)));
    if (existing) {
      // The native coordinator fences recovery ownership. Reuse the original
      // hold only for that live owner, never for an ordinary duplicate dispatch.
      const [owner] = recoveryLeaseOwner && run.runtimeMode === "native" && existing.state === "held"
        && existing.projectId === projectId ? await tx.select({ runId: nativeRunFinalizations.runId })
          .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, companyId),
            eq(nativeRunFinalizations.runId, runId), eq(nativeRunFinalizations.leaseOwner, recoveryLeaseOwner),
            sql`${nativeRunFinalizations.leaseExpiresAt} > now()`)).for("update") : [];
      if (owner) {
        // Recovery has already made this run queued/running, so its own pending
        // accounting is excluded. Current overruns, other unfinished runs and
        // scope pauses still apply before any more paid work starts.
        const block = await budgetServiceInTransaction(tx, publications).getInvocationBlock(companyId, run.agentId, { projectId });
        if (block) throw conflict(block.reason);
        const [agent] = await tx.select({ status: agents.status }).from(agents)
          .where(and(eq(agents.companyId, companyId), eq(agents.id, run.agentId)));
        if (agent?.status === "paused") throw conflict("Agent is paused and cannot start new work");
        return { ...existing, reused: true };
      }
      throw conflict("Provider dispatch has already reserved this run");
    }
    const block = await budgetServiceInTransaction(tx, publications).getInvocationBlock(companyId, run.agentId, { projectId });
    if (block) throw conflict(block.reason);
    const policies = await tx.select().from(budgetPolicies).where(and(
      eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.isActive, true), eq(budgetPolicies.hardStopEnabled, true),
      eq(budgetPolicies.metric, "billed_cents"), sql`${budgetPolicies.amount} > 0`,
      budgetPoliciesForRun(companyId, run.agentId, projectId),
    ));
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
    return { ...reservation, reused: false };
  });
}
