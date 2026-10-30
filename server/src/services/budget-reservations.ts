import { and, eq, sql } from "drizzle-orm";
import { agents, budgetReservations, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { centsToUnits, unitsToCents } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { budgetServiceInTransaction } from "./budgets.js";
import { withBudgetSpan } from "./budget-tracing.js";
import type { ActivityPublication } from "./activity-log.js";

/** Native finalization takes its coordinator before issue/run locks. Recovery
 * admission uses the same order after the company accounting lock, so its
 * later ownership checks never wait for a coordinator while holding a run. */
export async function lockRunBudgetRecoveryOwnerInTransaction(
  tx: Db, companyId: string, runId: string, recoveryLeaseOwner?: string,
) {
  if (!recoveryLeaseOwner) return;
  const [coordinator] = await tx.select({ leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt }).from(nativeRunFinalizations)
    .where(and(eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId))).for("update");
  if (!coordinator || coordinator.leaseOwner !== recoveryLeaseOwner || !coordinator.leaseExpiresAt || coordinator.leaseExpiresAt.getTime() <= Date.now())
    throw conflict("Native recovery no longer owns provider dispatch");
}

/** Called by the final dispatch gate with the company and run already locked.
 * Admission may have waited through preparation; that earlier reservation is
 * evidence of ownership, not permission to bypass a newer charge or pause.
 * Recovery callers prelock their coordinator before taking issue/run locks. */
export async function recheckRunBudgetReservationInTransaction(
  tx: Db,
  publications: ActivityPublication[],
  run: typeof heartbeatRuns.$inferSelect,
  reservationId: string,
  recoveryLeaseOwner?: string,
): Promise<string | null> {
  if (run.resultJson?.cancellation || run.resultJson?.startupCancellation)
    return "Run cancellation already requested";
  if (run.costAccountedAt || !["queued", "running"].includes(run.status))
    return "Run can no longer start provider work";
  const [reservation] = await tx.select().from(budgetReservations).where(and(
    eq(budgetReservations.id, reservationId), eq(budgetReservations.companyId, run.companyId),
    eq(budgetReservations.runId, run.id), eq(budgetReservations.agentId, run.agentId),
    eq(budgetReservations.state, "held"),
  )).for("update");
  if (!reservation) return "Provider dispatch no longer owns a held budget reservation";
  if (recoveryLeaseOwner) {
    const [owner] = run.runtimeMode === "native" ? await tx.select({ runId: nativeRunFinalizations.runId })
      .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, run.companyId),
        eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.leaseOwner, recoveryLeaseOwner),
        sql`${nativeRunFinalizations.leaseExpiresAt} > clock_timestamp()`)) : [];
    if (!owner) return "Native recovery no longer owns provider dispatch";
  }
  const { block, policies, observations } = await budgetServiceInTransaction(tx, publications)
    .evaluateAdmission(run.companyId, run.agentId, { projectId: reservation.projectId });
  if (block) return block.reason;
  const [agent] = await tx.select({ status: agents.status, lifecycleState: agents.lifecycleState }).from(agents)
    .where(and(eq(agents.companyId, run.companyId), eq(agents.id, run.agentId)));
  if (!agent || agent.lifecycleState !== "ready" || ["paused", "terminated", "pending_approval"].includes(agent.status))
    return "Agent is paused or its lifecycle is not ready for new work";
  for (const [index, policy] of policies.entries()) {
    const observed = observations[index];
    // This operation's hold is already included in exposure. Do not propose it
    // twice, or reject a nonzero reservation that exactly fills the budget.
    const committed = centsToUnits(observed.ledgerCents) + centsToUnits(observed.effectiveHeldCents);
    const limit = centsToUnits(policy.amount);
    if (committed > limit || (centsToUnits(reservation.amountCents) === 0n && committed >= limit))
      return "Available budget is reserved by unfinished runs";
  }
  return null;
}

/** Reserve before dispatch, under the same company lock as charges and policy
 * changes. Estimates constrain admission; they cannot cap a provider's bill.
 * A reservation survives timeouts and restarts until accounting proves closure. */
export async function reserveRunBudget(db: Db, companyId: string, runId: string, projectId: string | null, ledgerScope: Record<string, unknown> = {}, recoveryLeaseOwner?: string) {
  const result = await withBudgetSpan("budget.admission.reserve", () => withAccountingTransaction(db, companyId, async (tx, publications) => {
    await lockRunBudgetRecoveryOwnerInTransaction(tx, companyId, runId, recoveryLeaseOwner);
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
            sql`${nativeRunFinalizations.leaseExpiresAt} > clock_timestamp()`)) : [];
      if (owner) {
        // Recovery has already made this run queued/running, so its own pending
        // accounting is excluded. Current overruns, other unfinished runs and
        // scope pauses still apply before any more paid work starts.
        const block = await budgetServiceInTransaction(tx, publications).getInvocationBlock(companyId, run.agentId, { projectId });
        if (block) return { admissionBlockReason: block.reason };
        const [agent] = await tx.select({ status: agents.status, lifecycleState: agents.lifecycleState }).from(agents)
          .where(and(eq(agents.companyId, companyId), eq(agents.id, run.agentId)));
        if (!agent || agent.lifecycleState !== "ready" || ["paused", "terminated", "pending_approval"].includes(agent.status))
          return { admissionBlockReason: "Agent is paused and cannot start new work" };
        return { ...existing, reused: true };
      }
      throw conflict("Provider dispatch has already reserved this run");
    }
    const { block, policies, observations } = await budgetServiceInTransaction(tx, publications).evaluateAdmission(companyId, run.agentId, { projectId });
    if (block) return { admissionBlockReason: block.reason };
    // A budget release can start asynchronous resume hooks. Capacity alone
    // does not authorize dispatch before that lifecycle operation is ready.
    const [agent] = await tx.select({ status: agents.status, lifecycleState: agents.lifecycleState }).from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, run.agentId)));
    if (!agent || agent.lifecycleState !== "ready" || ["paused", "terminated", "pending_approval"].includes(agent.status))
      return { admissionBlockReason: "Agent is paused or its lifecycle is not ready for new work" };
    const amount = policies.reduce((max, policy) => { const next = centsToUnits(policy.reservationCents); return next > max ? next : max; }, 0n);
    for (const [index, policy] of policies.entries()) {
      const observed = observations[index];
      // Even zero-estimate runs cannot enter a scope whose available capacity
      // is completely reserved. Outstanding reservations carry across months.
      const committed = centsToUnits(observed.ledgerCents) + centsToUnits(observed.effectiveHeldCents);
      const limit = centsToUnits(policy.amount);
      if (committed >= limit || committed + amount > limit) return { admissionBlockReason: "Available budget is reserved by unfinished runs" };
    }
    // A zero-valued row also fences duplicate dispatch when estimates are off.
    const [reservation] = await tx.insert(budgetReservations).values({ companyId, runId, agentId: run.agentId, projectId,
      amountCents: unitsToCents(amount), providerStartedAt: new Date() }).returning();
    await tx.update(heartbeatRuns).set({ costAccountingPending: true,
      usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || ${JSON.stringify({ accountingReceiptReady: false, ledgerScope: { ...(run.usageJson?.ledgerScope as object ?? {}), ...ledgerScope, projectId } })}::jsonb`,
    }).where(eq(heartbeatRuns.id, runId));
    return { ...reservation, reused: false };
  }));
  // Commit required block/resume transitions even when dispatch is denied.
  // Throwing inside the transaction would discard those durable obligations.
  if ("admissionBlockReason" in result) throw conflict(result.admissionBlockReason ?? "Budget admission blocked");
  return result;
}
