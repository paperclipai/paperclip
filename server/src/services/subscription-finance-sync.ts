import { and, eq, gte, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { financeEvents, subscriptionPlans } from "@paperclipai/db";
import { financeService } from "./finance.js";

/**
 * Creates monthly finance_events for active subscription plans that have not
 * yet been recorded for the current UTC calendar month.
 *
 * Designed to be called periodically (e.g., from the heartbeat timer tick).
 * It is idempotent: existing finance events for a plan+month are detected and
 * skipped via a `subscription_plan_id` key in `metadata_json`.
 */
export async function syncSubscriptionFinanceEvents(db: Db): Promise<{ created: number }> {
  const finance = financeService(db);
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const monthEnd = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));

  const activePlans = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.isActive, true));

  let created = 0;

  for (const plan of activePlans) {
    if (plan.effectiveFrom > monthEnd) continue;
    if (plan.effectiveUntil && plan.effectiveUntil < monthStart) continue;

    const existing = await db
      .select({ id: financeEvents.id })
      .from(financeEvents)
      .where(
        and(
          eq(financeEvents.companyId, plan.companyId),
          eq(financeEvents.eventKind, "subscription_fee"),
          gte(financeEvents.occurredAt, monthStart),
          lt(financeEvents.occurredAt, monthEnd),
        ),
      )
      .then((rows) =>
        rows.length > 0
          ? db
              .select({ id: financeEvents.id, metadataJson: financeEvents.metadataJson })
              .from(financeEvents)
              .where(
                and(
                  eq(financeEvents.companyId, plan.companyId),
                  eq(financeEvents.eventKind, "subscription_fee"),
                  gte(financeEvents.occurredAt, monthStart),
                  lt(financeEvents.occurredAt, monthEnd),
                ),
              )
          : [],
      );

    const alreadySynced = existing.some((row) => {
      const meta = row.metadataJson as Record<string, unknown> | null;
      return meta?.subscriptionPlanId === plan.id;
    });

    if (alreadySynced) continue;

    const daysInMonth = (monthEnd.getTime() - monthStart.getTime()) / (24 * 60 * 60 * 1000);
    const planStart = plan.effectiveFrom > monthStart ? plan.effectiveFrom : monthStart;
    const planEnd = plan.effectiveUntil && plan.effectiveUntil < monthEnd ? plan.effectiveUntil : monthEnd;
    const activeDays = Math.max(0, (planEnd.getTime() - planStart.getTime()) / (24 * 60 * 60 * 1000));
    const proratedCents = Math.round((plan.monthlyCostCents * activeDays) / daysInMonth);

    if (proratedCents <= 0) continue;

    await finance.createEvent(plan.companyId, {
      agentId: plan.agentId,
      eventKind: "subscription_fee",
      direction: "debit",
      biller: plan.biller,
      provider: plan.provider,
      amountCents: proratedCents,
      estimated: true,
      description: `Auto-recorded subscription fee for ${plan.provider} (${plan.biller})`,
      occurredAt: monthStart,
      metadataJson: {
        subscriptionPlanId: plan.id,
        monthlyCostCents: plan.monthlyCostCents,
        activeDays,
        daysInMonth,
        proratedCents,
      },
    });

    created++;
  }

  return { created };
}
